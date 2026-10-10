using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ModelContextProtocol.Protocol;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Caching;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Errors;
using Sezzlee.AspNetCore.Spec;
using Sezzlee.AspNetCore.Tools;
using Sezzlee.AspNetCore.Visibility;

namespace Sezzlee.Tests;

public sealed class ResponseBudgetTests
{
    private const int Budget = 4_096;
    private static readonly TimeSpan ShortDeadline = TimeSpan.FromMilliseconds(150);

    private sealed record BudgetHarness(WebApplication App, SezzleeMetaTools Tools, SezzleeOptions Options) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await App.StopAsync();
            await App.DisposeAsync();
        }
    }

    private static async Task<BudgetHarness> HostAsync(Action<SezzleeOptions>? configure = null)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Services.AddSezzlee(o =>
        {
            o.Invoke.MaxResponseBytes = Budget;
            configure?.Invoke(o);
        });

        WebApplication app = builder.Build();
        app.UseSezzleeCapture();
        app.UseRouting();
        app.MapGet("/rows", (int limit) =>
                Enumerable.Range(0, limit).Select(index => new { id = index, note = new string('x', 64) }))
            .WithMetadata(new McpToolAttribute { Name = "list_rows" });
        app.MapGet("/exact", (int pad) => new { pad = new string('y', pad) })
            .WithMetadata(new McpToolAttribute { Name = "exact_size" });
        app.MapGet("/slow", async (CancellationToken token) =>
            {
                await Task.Delay(TimeSpan.FromSeconds(5), token);
                return new { eventually = true };
            })
            .WithMetadata(new McpToolAttribute { Name = "slow_call" });
        app.MapGet("/stubborn", async () =>
            {
                await Task.Delay(TimeSpan.FromMilliseconds(400), CancellationToken.None);
                return new { ignored = true };
            })
            .WithMetadata(new McpToolAttribute { Name = "stubborn_call" });
        app.MapGet("/swallowing", (HttpContext http) =>
            {
                SpinWait.SpinUntil(() => http.RequestAborted.IsCancellationRequested, TimeSpan.FromSeconds(5));
                http.Response.Body.Write("{\"rows\":[{\"id\":0},"u8);
                return Results.Empty;
            })
            .WithMetadata(new McpToolAttribute { Name = "swallowing_call" });
        app.MapSezzlee("/mcp");
        await app.StartAsync();

        SezzleeMetaTools tools = new(
            app.Services.GetRequiredService<SezzleeCatalogProvider>(),
            app.Services.GetRequiredService<SezzleeDispatcher>(),
            app.Services.GetRequiredService<IInvokeResultMapper>(),
            app.Services.GetRequiredService<CallerVisibilityProvider>(),
            app.Services.GetRequiredService<ICallerScopeResolver>(),
            app.Services.GetRequiredService<IOptions<SezzleeOptions>>(),
            new FixedContext(new DefaultHttpContext()),
            app.Services.GetRequiredService<ILogger<SezzleeMetaTools>>());
        return new BudgetHarness(app, tools, app.Services.GetRequiredService<IOptions<SezzleeOptions>>().Value);
    }

    private static async Task<(SdkError? Error, JsonElement Raw, bool IsError)> InvokeAsync(
        SezzleeMetaTools tools, string name, object arguments)
    {
        CallToolResult result = await tools.InvokeTool(
            name, JsonSerializer.SerializeToElement(arguments), CancellationToken.None);
        string text = ((TextContentBlock)result.Content[0]).Text;
        JsonElement raw = JsonDocument.Parse(text).RootElement.Clone();
        SdkError? error = raw.TryGetProperty("error", out _) && !raw.TryGetProperty("status", out _)
            ? JsonSerializer.Deserialize<SdkError>(text, SezzleeJson.Wire)
            : null;
        return (error, raw, result.IsError == true);
    }

    [Fact]
    public async Task R1_OversizeResponse_IsRefusedAndNamesNarrowingArguments()
    {
        await using BudgetHarness harness = await HostAsync();
        (SdkError? error, _, bool isError) = await InvokeAsync(harness.Tools, "list_rows", new { limit = 200 });

        Assert.True(isError);
        Assert.NotNull(error);
        Assert.Equal(SdkErrorCode.ResponseTooLarge, error!.Error);
        Assert.False(error.Retryable);
        Assert.Equal(Budget, error.Payload!.Limit);
        Assert.True(error.Payload.Bytes > Budget);
        Assert.Equal(PayloadShapeKind.Array, error.Payload.Shape.Kind);
        Assert.Equal(200, error.Payload.Shape.Count);
        Assert.Contains(error.Fields!, field => field.Name == "limit");
        Assert.DoesNotContain("xxxx", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task R2_ResponseThatFits_IsAdmitted()
    {
        await using BudgetHarness harness = await HostAsync();

        (_, _, bool fitsIsError) = await InvokeAsync(harness.Tools, "exact_size", new { pad = 1_000 });
        Assert.False(fitsIsError);

        (SdkError? over, _, bool overIsError) = await InvokeAsync(harness.Tools, "exact_size", new { pad = 8_000 });
        Assert.True(overIsError);
        Assert.Equal(SdkErrorCode.ResponseTooLarge, over!.Error);
    }

    [Fact]
    public async Task R3_PerEndpointOverride_LowersTheBudgetForOneToolAlone()
    {
        await using BudgetHarness harness = await HostAsync(o =>
            o.Invoke.MaxResponseBytesFor = target => target.Tool == "exact_size" ? 32 : null);

        (SdkError? overridden, _, bool overriddenIsError) =
            await InvokeAsync(harness.Tools, "exact_size", new { pad = 100 });
        Assert.True(overriddenIsError);
        Assert.Equal(32, overridden!.Payload!.Limit);

        (_, _, bool untouchedIsError) = await InvokeAsync(harness.Tools, "list_rows", new { limit = 2 });
        Assert.False(untouchedIsError);
    }

    [Fact]
    public async Task R4_DeadlineExpiry_AnswersWithInvokeTimeout()
    {
        await using BudgetHarness harness = await HostAsync(o => o.Invoke.Timeout = ShortDeadline);
        (SdkError? error, _, bool isError) = await InvokeAsync(harness.Tools, "slow_call", new { });

        Assert.True(isError);
        Assert.Equal(SdkErrorCode.InvokeTimeout, error!.Error);
        Assert.True(error.Retryable);
        Assert.Contains("150 ms", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task R5_AbandonedHandler_LeavesNoUnobservedTaskException()
    {
        List<Exception> unobserved = [];
        void OnUnobserved(object? sender, UnobservedTaskExceptionEventArgs args)
        {
            unobserved.Add(args.Exception);
            args.SetObserved();
        }

        TaskScheduler.UnobservedTaskException += OnUnobserved;
        try
        {
            await using (BudgetHarness harness = await HostAsync(o => o.Invoke.Timeout = ShortDeadline))
            {
                (SdkError? error, _, _) = await InvokeAsync(harness.Tools, "stubborn_call", new { });
                Assert.Equal(SdkErrorCode.InvokeTimeout, error!.Error);
                await Task.Delay(TimeSpan.FromMilliseconds(600));
            }

            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
            Assert.Empty(unobserved);
        }
        finally
        {
            TaskScheduler.UnobservedTaskException -= OnUnobserved;
        }
    }

    [Fact]
    public async Task R6_HandlerThatSwallowsTheDeadline_AnswersWithInvokeTimeoutNotAPartialBody()
    {
        await using BudgetHarness harness = await HostAsync(o => o.Invoke.Timeout = ShortDeadline);
        (SdkError? error, JsonElement raw, bool isError) = await InvokeAsync(harness.Tools, "swallowing_call", new { });

        Assert.True(isError, raw.GetRawText());
        Assert.Equal(SdkErrorCode.InvokeTimeout, error!.Error);
        Assert.DoesNotContain("rows", raw.GetRawText(), StringComparison.Ordinal);
    }
}
