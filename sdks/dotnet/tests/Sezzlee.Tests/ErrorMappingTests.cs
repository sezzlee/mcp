using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ModelContextProtocol.Protocol;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Errors;
using Sezzlee.AspNetCore.Requests;
using Sezzlee.AspNetCore.Spec;
using Sezzlee.AspNetCore.Tools;
using static Sezzlee.Tests.VisibilityHost;

namespace Sezzlee.Tests;

public sealed record ErrorMappingOrderRequest(
    [Required, MinLength(1)] string Item,
    [Range(1, 100)] int Quantity);

[ApiController]
[Route("/mapping")]
public sealed class ErrorMappingController : ControllerBase
{
    [HttpPost("orders")]
    public IActionResult CreateOrder([FromBody] ErrorMappingOrderRequest request) =>
        Ok(new { request.Item, request.Quantity });
}

internal sealed class SentinelInvokeResultMapper : IInvokeResultMapper
{
    public InvokeOutcome Map(BackendResponse response, IReadOnlySet<string> knownFields) =>
        new InvokeSucceeded(new InvokeSuccess { Status = 999 });
}

internal static class ErrorMappingHost
{
    public static async Task<TestApp> StartAsync()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Services.AddControllers().AddApplicationPart(typeof(ErrorMappingHost).Assembly);
        builder.Services.AddSezzlee();

        WebApplication app = builder.Build();
        app.UseSezzleeCapture();
        app.UseRouting();
        app.MapControllers();

        app.MapGet("/mapping/no-content", () => Results.StatusCode(StatusCodes.Status204NoContent));

        app.MapGet("/mapping/unauthorized", () => Results.Json(
            new { error = "Unauthorized", message = "Portal resolution failed: signature mismatch." },
            statusCode: StatusCodes.Status401Unauthorized));

        app.MapGet("/mapping/forbidden-empty", () => Results.StatusCode(StatusCodes.Status403Forbidden));

        app.MapGet("/mapping/forbidden-detail", () => Results.Json(
            new { type = "about:blank", title = "Forbidden", status = 403, detail = "This order belongs to a different caller." },
            statusCode: StatusCodes.Status403Forbidden,
            contentType: "application/problem+json"));

        app.MapGet("/mapping/server-error", (HttpContext context) =>
        {
            context.Response.Headers["X-Correlation-Id"] = "corr-500-abc123";
            return Results.Json(
                new { message = "System.NullReferenceException: Object reference not set. at Foo.Bar(Baz x) in /src/Foo.cs:line 12" },
                statusCode: StatusCodes.Status500InternalServerError);
        });

        app.MapGet("/mapping/leak-stack-400", () => Results.Json(
            new { message = "Unhandled: NullReferenceException at DemoApi.Services.OrderService.Validate(Order order) in /src/OrderService.cs:line 88" },
            statusCode: StatusCodes.Status400BadRequest));

        app.MapGet("/mapping/rate-limited", (HttpContext context) =>
        {
            context.Response.Headers["Retry-After"] = "7";
            return Results.StatusCode(StatusCodes.Status429TooManyRequests);
        });

        app.MapGet("/mapping/json-success", () => Results.Json(new { id = 1, item = "widget" }));

        app.MapGet("/mapping/text-success", () => Results.Text("plain body text", "text/plain"));

        app.MapGet("/mapping/html-404", () => Results.Text(
            "<!doctype html><html><body>Not Found</body></html>",
            "text/html",
            statusCode: StatusCodes.Status404NotFound));

        app.MapGet("/mapping/custom-headers", (HttpContext context) =>
        {
            context.Response.Headers["X-Widget"] = "abc";
            return Results.Text("hi", "text/plain; charset=utf-8");
        });

        await app.StartAsync();
        return new TestApp(app, app.GetTestClient(), app.Services.GetRequiredService<SezzleeDispatcher>());
    }
}

public sealed class ErrorMappingTests
{
    private static readonly IReadOnlySet<string> NoKnownFields = new HashSet<string>();
    private static readonly IReadOnlyDictionary<string, string> EmptyHeaders = new Dictionary<string, string>();

    /// <remarks>
    /// Guard: the C# generator emits nothing for the root <c>InvokeResult</c> union, so an
    /// <see cref="InvokeOutcome"/> case missing here passes gen, build and type-check. Globbing the
    /// whole <c>error-mapping</c> directory is the only check that catches it; moving those fixtures
    /// elsewhere removes it.
    /// </remarks>
    [Fact]
    public void E1_ConformanceFixtures_AllPass()
    {
        string dir = Path.Combine(AppContext.BaseDirectory, "Fixtures", "error-mapping");
        string[] files = Directory.GetFiles(dir, "*.json");
        Assert.NotEmpty(files);

        InvokeResultMapper mapper = new(Options.Create(new SezzleeOptions()));

        foreach (string file in files)
        {
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(file));
            JsonElement root = document.RootElement;
            Assert.Equal("error-mapping", root.GetProperty("kind").GetString());
            JsonElement input = root.GetProperty("input");

            if (input.TryGetProperty("sdkError", out JsonElement sdkCode))
            {
                AssertSdkFixture(file, sdkCode, input, root.GetProperty("expected"));
                continue;
            }

            BackendResponse response = BuildBackendResponse(input);
            HashSet<string> knownFields = input.TryGetProperty("knownFields", out JsonElement knownFieldsElement)
                ? knownFieldsElement.EnumerateArray().Select(f => f.GetString()!).ToHashSet(StringComparer.Ordinal)
                : [];

            Dictionary<string, string> aliases = new(StringComparer.Ordinal);
            if (input.TryGetProperty("fieldAliases", out JsonElement aliasSpec))
            {
                foreach (JsonProperty entry in aliasSpec.EnumerateObject())
                {
                    aliases[entry.Name] = entry.Value.GetString()!;
                }
            }
            HashSet<string> hidden = input.TryGetProperty("hiddenFields", out JsonElement hiddenSpec)
                ? [.. hiddenSpec.EnumerateArray().Select(f => f.GetString()!)]
                : new HashSet<string>(StringComparer.Ordinal);
            InvokeOutcome outcome = mapper.Map(
                response, new FieldVocabulary(knownFields, aliases, hidden));
            object produced = outcome switch
            {
                InvokeSucceeded succeeded => succeeded.Success,
                InvokeFailed failed => failed.Error,
                _ => throw new InvalidOperationException($"Unhandled invoke outcome: {outcome.GetType()}"),
            };

            JsonNode producedNode = JsonSerializer.SerializeToNode(produced, SezzleeJson.Wire)!;
            JsonNode expectedNode = JsonNode.Parse(root.GetProperty("expected").GetRawText())!;

            Assert.True(
                JsonNode.DeepEquals(expectedNode, producedNode),
                $"{Path.GetFileName(file)}\nexpected: {expectedNode.ToJsonString()}\nproduced: {producedNode.ToJsonString()}");
        }
    }

    private static void AssertSdkFixture(string file, JsonElement sdkCode, JsonElement input, JsonElement expected)
    {
        string code = sdkCode.GetString()!;
        SdkError produced = code switch
        {
            "response_too_large" => SdkErrors.RefuseOversize(new OversizeResponse(
                input.TryGetProperty("bytes", out JsonElement bytes) ? bytes.GetInt32() : 0,
                input.TryGetProperty("limit", out JsonElement limit) ? limit.GetInt32() : 1,
                SdkErrors.Describe(input.TryGetProperty("payload", out JsonElement payload)
                    ? JsonNode.Parse(payload.GetRawText())
                    : null),
                input.TryGetProperty("narrowing", out JsonElement narrowing)
                    ? [.. narrowing.EnumerateArray().Select(entry => new FieldError
                    {
                        Name = entry.GetProperty("name").GetString(),
                        Message = entry.GetProperty("message").GetString()!,
                    })]
                    : null)),
            "invoke_timeout" => SdkErrors.RefuseTimedOut(
                input.TryGetProperty("limitMs", out JsonElement limitMs) ? limitMs.GetInt32() : 0),
            "search_ranker_unavailable" => SdkErrors.RefuseRankerUnavailable(),
            "tool_changed" => SdkErrors.RefuseChangedTool(
                input.TryGetProperty("tool", out JsonElement tool) ? tool.GetString()! : string.Empty),
            _ when input.TryGetProperty("reason", out JsonElement reason) => SdkErrors.RefuseUnresolvedFile(
                input.TryGetProperty("field", out JsonElement field) ? field.GetString()! : string.Empty,
                reason.GetString()!,
                input.TryGetProperty("limit", out JsonElement fileLimit) ? fileLimit.GetInt32() : 1),
            _ => SdkErrors.Create(
                JsonSerializer.Deserialize<SdkErrorCode>($"\"{code}\"", SezzleeJson.Wire),
                input.TryGetProperty("message", out JsonElement message) ? message.GetString()! : string.Empty),
        };

        JsonNode producedNode = JsonSerializer.SerializeToNode(produced, SezzleeJson.Wire)!;
        JsonNode expectedNode = JsonNode.Parse(expected.GetRawText())!;
        Assert.True(
            JsonNode.DeepEquals(expectedNode, producedNode),
            $"{Path.GetFileName(file)}\nexpected: {expectedNode.ToJsonString()}\nproduced: {producedNode.ToJsonString()}");
    }

    [Fact]
    public async Task E2_RealValidationProblemDetails_FieldNamesMatchSchema()
    {
        await using TestApp app = await ErrorMappingHost.StartAsync();
        RequestTemplate template = RequestTemplate.Create(
            HttpMethod.Post, "/mapping/orders", [], bodyProperties: ["item", "quantity"]);
        DispatchResult result = await app.Dispatcher.DispatchAsync(
            template, JsonSerializer.SerializeToElement(new { item = "", quantity = 500 }), null, CancellationToken.None);

        IInvokeResultMapper mapper = app.App.Services.GetRequiredService<IInvokeResultMapper>();
        InvokeOutcome outcome = mapper.Map(
            result.ToBackendResponse(), new HashSet<string>(StringComparer.Ordinal) { "item", "quantity" });

        InvokeFailed failed = Assert.IsType<InvokeFailed>(outcome);
        Assert.Equal(BackendErrorCode.ValidationFailed, failed.Error.Error);
        Assert.Contains(failed.Error.Fields!, f => f.Name == "item");
        Assert.Contains(failed.Error.Fields!, f => f.Name == "quantity");
    }

    [Fact]
    public async Task E3_SuccessBody_JsonParsedOrTextWithContentType()
    {
        await using TestApp app = await ErrorMappingHost.StartAsync();
        IInvokeResultMapper mapper = app.App.Services.GetRequiredService<IInvokeResultMapper>();

        DispatchResult jsonResult = await app.Dispatcher.DispatchAsync(
            HttpMethod.Get, "/mapping/json-success", null, CancellationToken.None);
        InvokeSucceeded jsonOutcome = Assert.IsType<InvokeSucceeded>(mapper.Map(jsonResult.ToBackendResponse(), NoKnownFields));
        Assert.True(JsonNode.DeepEquals(jsonOutcome.Success.Body, JsonNode.Parse("""{"id":1,"item":"widget"}""")));

        DispatchResult textResult = await app.Dispatcher.DispatchAsync(
            HttpMethod.Get, "/mapping/text-success", null, CancellationToken.None);
        InvokeSucceeded textOutcome = Assert.IsType<InvokeSucceeded>(mapper.Map(textResult.ToBackendResponse(), NoKnownFields));
        Assert.Equal("plain body text", textOutcome.Success.Body!.GetValue<string>());
        Assert.StartsWith("text/plain", textOutcome.Success.ContentType);
    }

    [Fact]
    public async Task E4_NoContent_HasNoBody()
    {
        await using TestApp app = await ErrorMappingHost.StartAsync();
        IInvokeResultMapper mapper = app.App.Services.GetRequiredService<IInvokeResultMapper>();
        DispatchResult result = await app.Dispatcher.DispatchAsync(
            HttpMethod.Get, "/mapping/no-content", null, CancellationToken.None);

        InvokeSucceeded outcome = Assert.IsType<InvokeSucceeded>(mapper.Map(result.ToBackendResponse(), NoKnownFields));
        Assert.Null(outcome.Success.Body);
        Assert.Equal(204, outcome.Success.Status);
    }

    [Fact]
    public async Task E5_Unauthorized_BodyNeverForwarded()
    {
        await using TestApp app = await ErrorMappingHost.StartAsync();
        IInvokeResultMapper mapper = app.App.Services.GetRequiredService<IInvokeResultMapper>();
        DispatchResult result = await app.Dispatcher.DispatchAsync(
            HttpMethod.Get, "/mapping/unauthorized", null, CancellationToken.None);

        InvokeFailed outcome = Assert.IsType<InvokeFailed>(mapper.Map(result.ToBackendResponse(), NoKnownFields));
        Assert.Equal(BackendErrorCode.Unauthenticated, outcome.Error.Error);
        Assert.DoesNotContain("Portal resolution", outcome.Error.Message);
        Assert.DoesNotContain("signature", outcome.Error.Message);
    }

    [Fact]
    public async Task E6_Forbidden_EmptyStandard_DetailForwarded()
    {
        await using TestApp app = await ErrorMappingHost.StartAsync();
        IInvokeResultMapper mapper = app.App.Services.GetRequiredService<IInvokeResultMapper>();

        DispatchResult empty = await app.Dispatcher.DispatchAsync(
            HttpMethod.Get, "/mapping/forbidden-empty", null, CancellationToken.None);
        InvokeFailed emptyOutcome = Assert.IsType<InvokeFailed>(mapper.Map(empty.ToBackendResponse(), NoKnownFields));
        Assert.Equal(
            "The caller is authenticated but not permitted to perform this operation (403).",
            emptyOutcome.Error.Message);

        DispatchResult detail = await app.Dispatcher.DispatchAsync(
            HttpMethod.Get, "/mapping/forbidden-detail", null, CancellationToken.None);
        InvokeFailed detailOutcome = Assert.IsType<InvokeFailed>(mapper.Map(detail.ToBackendResponse(), NoKnownFields));
        Assert.Equal("This order belongs to a different caller.", detailOutcome.Error.Message);
    }

    [Fact]
    public async Task E7_ServerError_BodyWithheld_CorrelationHeaderBecomesReference()
    {
        await using TestApp app = await ErrorMappingHost.StartAsync();
        IInvokeResultMapper mapper = app.App.Services.GetRequiredService<IInvokeResultMapper>();
        DispatchResult result = await app.Dispatcher.DispatchAsync(
            HttpMethod.Get, "/mapping/server-error", null, CancellationToken.None);

        InvokeFailed outcome = Assert.IsType<InvokeFailed>(mapper.Map(result.ToBackendResponse(), NoKnownFields));
        Assert.Equal(BackendErrorCode.BackendError, outcome.Error.Error);
        Assert.Equal("corr-500-abc123", outcome.Error.Reference);
        Assert.DoesNotContain("NullReferenceException", outcome.Error.Message);
        Assert.DoesNotContain("Foo.Bar", outcome.Error.Message);
    }

    [Fact]
    public async Task E8_StackFrameIn400Message_ReplacedWithStandardMessage()
    {
        await using TestApp app = await ErrorMappingHost.StartAsync();
        IInvokeResultMapper mapper = app.App.Services.GetRequiredService<IInvokeResultMapper>();
        DispatchResult result = await app.Dispatcher.DispatchAsync(
            HttpMethod.Get, "/mapping/leak-stack-400", null, CancellationToken.None);

        InvokeFailed outcome = Assert.IsType<InvokeFailed>(mapper.Map(result.ToBackendResponse(), NoKnownFields));
        Assert.Equal(BackendErrorCode.BadRequest, outcome.Error.Error);
        Assert.Equal(
            "The backend rejected the request (400) without usable details. Check the arguments against the input schema.",
            outcome.Error.Message);
    }

    [Fact]
    public async Task E9_RateLimited_RetryAfterSecondsParsed()
    {
        await using TestApp app = await ErrorMappingHost.StartAsync();
        IInvokeResultMapper mapper = app.App.Services.GetRequiredService<IInvokeResultMapper>();
        DispatchResult result = await app.Dispatcher.DispatchAsync(
            HttpMethod.Get, "/mapping/rate-limited", null, CancellationToken.None);

        InvokeFailed outcome = Assert.IsType<InvokeFailed>(mapper.Map(result.ToBackendResponse(), NoKnownFields));
        Assert.Equal(BackendErrorCode.RateLimited, outcome.Error.Error);
        Assert.True(outcome.Error.Retryable);
        Assert.Equal(7, outcome.Error.RetryAfterSeconds);
        Assert.Contains("7 seconds", outcome.Error.Message);
    }

    [Fact]
    public void E10_HostRecognizer_RunsFirst_OutputStillLeakFiltered()
    {
        SezzleeOptions options = new();
        options.Errors.Recognize((_, _) => new RecognizedError("leaked at Foo.Bar(Baz x)"));
        InvokeResultMapper mapper = new(Options.Create(options));

        BackendResponse response = new(200, "application/json", EmptyHeaders, """{"ok":true}""");
        InvokeFailed outcome = Assert.IsType<InvokeFailed>(mapper.Map(response, NoKnownFields));

        Assert.Equal(BackendErrorCode.BadRequest, outcome.Error.Error);
        Assert.Equal(
            "The backend rejected the request (200) without usable details. Check the arguments against the input schema.",
            outcome.Error.Message);
    }

    [Fact]
    public async Task E11_CustomInvokeResultMapper_OverridesDefault()
    {
        await using Harness host = await HostAsync(beforeSezzlee: services =>
            services.AddSingleton<IInvokeResultMapper, SentinelInvokeResultMapper>());
        SezzleeMetaTools alice = host.ToolsFor(Mint("alice"));

        CallToolResult result = await alice.InvokeTool("vis_anon", JsonSerializer.SerializeToElement(new { }), CancellationToken.None);

        Assert.False(result.IsError);
        Assert.Contains("\"status\":999", TextOf(result));
    }

    [Fact]
    public async Task E12_ArgumentMappingError_UsesEnvelopeWithIsError()
    {
        await using Harness host = await HostAsync();
        SezzleeMetaTools alice = host.ToolsFor(Mint("alice"));

        CallToolResult result = await alice.InvokeTool(
            "vis_mine", JsonSerializer.SerializeToElement(new { id = "not-a-number" }), CancellationToken.None);

        Assert.True(result.IsError);
        using JsonDocument document = JsonDocument.Parse(TextOf(result));
        Assert.Equal("invalid_path_type", document.RootElement.GetProperty("error").GetString());
        Assert.False(document.RootElement.TryGetProperty("status", out _));
        Assert.False(document.RootElement.GetProperty("retryable").GetBoolean());
    }

    [Fact]
    public async Task E12a_ArgumentsAsJsonText_AreUnwrapped()
    {
        await using Harness host = await HostAsync();
        SezzleeMetaTools alice = host.ToolsFor(Mint("alice"));

        CallToolResult result = await alice.InvokeTool(
            "vis_mine", JsonSerializer.SerializeToElement("""{"id": 1}"""), CancellationToken.None);

        Assert.False(result.IsError);
    }

    [Fact]
    public async Task E12b_NullArguments_ReadAsNone()
    {
        await using Harness host = await HostAsync();
        SezzleeMetaTools alice = host.ToolsFor(Mint("alice"));

        CallToolResult result = await alice.InvokeTool(
            "vis_anon", JsonSerializer.SerializeToElement((object?)null), CancellationToken.None);

        Assert.False(result.IsError);
    }

    [Fact]
    public async Task E12c_NonObjectArguments_NameTheKindThatArrived()
    {
        await using Harness host = await HostAsync();
        SezzleeMetaTools alice = host.ToolsFor(Mint("alice"));

        CallToolResult result = await alice.InvokeTool(
            "vis_mine", JsonSerializer.SerializeToElement("id=1"), CancellationToken.None);

        Assert.True(result.IsError);
        using JsonDocument document = JsonDocument.Parse(TextOf(result));
        Assert.Equal("invalid_type", document.RootElement.GetProperty("error").GetString());
        Assert.Contains("received a string", document.RootElement.GetProperty("message").GetString());
        Assert.False(document.RootElement.GetProperty("retryable").GetBoolean());
    }

    [Fact]
    public async Task E13_LoadTool_Unknown_UsesEnvelopeWithIsError()
    {
        await using Harness host = await HostAsync();
        SezzleeMetaTools alice = host.ToolsFor(Mint("alice"));

        CallToolResult result = await alice.LoadTool("does_not_exist");

        Assert.True(result.IsError);
        using JsonDocument document = JsonDocument.Parse(TextOf(result));
        Assert.Equal("unknown_tool", document.RootElement.GetProperty("error").GetString());
    }

    [Fact]
    public async Task E14_DispatchResult_CapturesContentTypeAndHeaders()
    {
        await using TestApp app = await ErrorMappingHost.StartAsync();
        DispatchResult result = await app.Dispatcher.DispatchAsync(
            HttpMethod.Get, "/mapping/custom-headers", null, CancellationToken.None);

        Assert.StartsWith("text/plain", result.ContentType);
        Assert.Equal("abc", result.Headers["X-Widget"]);
    }

    [Fact]
    public async Task E15_HtmlBody_NeverForwarded()
    {
        await using TestApp app = await ErrorMappingHost.StartAsync();
        IInvokeResultMapper mapper = app.App.Services.GetRequiredService<IInvokeResultMapper>();
        DispatchResult result = await app.Dispatcher.DispatchAsync(
            HttpMethod.Get, "/mapping/html-404", null, CancellationToken.None);

        InvokeFailed outcome = Assert.IsType<InvokeFailed>(mapper.Map(result.ToBackendResponse(), NoKnownFields));
        Assert.Equal(BackendErrorCode.NotFound, outcome.Error.Error);
        Assert.DoesNotContain("<html", outcome.Error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(
            "No resource matched these arguments (404). The operation exists; check identifier arguments.",
            outcome.Error.Message);
    }

    private static BackendResponse BuildBackendResponse(JsonElement input)
    {
        int status = input.GetProperty("status").GetInt32();
        string? contentType = input.TryGetProperty("contentType", out JsonElement contentTypeElement)
            ? contentTypeElement.GetString()
            : null;

        Dictionary<string, string> headers = new(StringComparer.OrdinalIgnoreCase);
        if (input.TryGetProperty("headers", out JsonElement headersElement))
        {
            foreach (JsonProperty header in headersElement.EnumerateObject())
            {
                headers[header.Name] = header.Value.GetString()!;
            }
        }

        string? body = null;
        if (input.TryGetProperty("body", out JsonElement bodyElement))
        {
            body = bodyElement.ValueKind == JsonValueKind.String
                ? bodyElement.GetString()
                : bodyElement.GetRawText();
        }

        return new BackendResponse(status, contentType, headers, body);
    }
}
