using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using ModelContextProtocol;
using ModelContextProtocol.AspNetCore;
using ModelContextProtocol.AspNetCore.Authentication;
using ModelContextProtocol.Authentication;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Spec;
using Sezzlee.Samples.DemoAuthServer;

namespace Sezzlee.Tests;

internal sealed record TransportApp(WebApplication App, DemoAuthServer AuthServer, string Pattern) : IAsyncDisposable
{
    public HttpClient Client => App.GetTestClient();

    public async ValueTask DisposeAsync()
    {
        await App.StopAsync();
        await App.DisposeAsync();
    }
}

public sealed class TransportTests
{
    private const string LegacyProtocolVersion = ProtocolRevision.V20251125;

    private const string GenerationMetaKey = "sezzlee/catalogGeneration";

    private static async Task<TransportApp> HostAsync(
        Action<SezzleeOptions>? configureSezzlee = null,
        Action<IServiceCollection>? configureServices = null,
        bool requireAuthorization = true,
        bool configureResourceServer = true,
        string pattern = "/mcp")
    {
        string resource = "http://localhost" + pattern;

        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();

        DemoAuthServer authServer = new(new DemoAuthServerOptions
        {
            Issuer = new Uri("http://localhost/oauth"),
            DefaultAudience = new Uri(resource),
        });

        builder.Services
            .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
            .AddJwtBearer(o =>
            {
                o.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuer = true,
                    ValidIssuer = authServer.Issuer.ToString(),
                    ValidateAudience = true,
                    ValidAudience = resource,
                    IssuerSigningKey = authServer.PublicKey,
                };
            });
        builder.Services.AddAuthorization();

        configureServices?.Invoke(builder.Services);

        builder.Services.AddSezzlee(o =>
        {
            if (configureResourceServer)
            {
                o.ResourceServer.Metadata = new ProtectedResourceMetadata
                {
                    Resource = resource,
                    AuthorizationServers = { authServer.Issuer.ToString() },
                    BearerMethodsSupported = ["header"],
                };
            }
            configureSezzlee?.Invoke(o);
        });

        WebApplication app = builder.Build();
        app.UseSezzleeCapture();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapDemoAuthorizationServer(authServer);

        IEndpointConventionBuilder mapped = app.MapSezzlee(pattern);
        if (requireAuthorization)
        {
            mapped.RequireAuthorization();
        }

        await app.StartAsync();
        return new TransportApp(app, authServer, pattern);
    }

    private static async Task<McpClient> ConnectAsync(
        TransportApp app, string? bearerToken, Action<HttpClientTransportOptions>? configureTransport = null)
    {
        HttpClientTransportOptions options = new()
        {
            Endpoint = new Uri("http://localhost" + app.Pattern),
            Name = "sezzlee-transport-tests",
        };
        if (bearerToken is not null)
        {
            options.AdditionalHeaders = new Dictionary<string, string> { ["Authorization"] = $"Bearer {bearerToken}" };
        }
        configureTransport?.Invoke(options);

        HttpClientTransport transport = new(options, app.Client, loggerFactory: null, ownsHttpClient: false);
        McpClientOptions clientOptions = new() { ProtocolVersion = LegacyProtocolVersion };
        return await McpClient.CreateAsync(transport, clientOptions, cancellationToken: CancellationToken.None);
    }

    private static int CountOccurrences(IEnumerable<string> values, string needle) =>
        values.Sum(value => (value.Length - value.Replace(needle, string.Empty).Length) / needle.Length);

    [Fact]
    public async Task T1_ProtectedResourceMetadata_ServedAnonymously_WithRfc9728Shape()
    {
        await using TransportApp app = await HostAsync();

        HttpResponseMessage response = await app.Client.GetAsync("/.well-known/oauth-protected-resource/mcp");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.StartsWith("application/json", response.Content.Headers.ContentType?.MediaType ?? string.Empty, StringComparison.Ordinal);
        Assert.Equal("public, max-age=300", response.Headers.CacheControl?.ToString());

        using JsonDocument document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("http://localhost/mcp", document.RootElement.GetProperty("resource").GetString());
        JsonElement servers = document.RootElement.GetProperty("authorization_servers");
        Assert.Equal("http://localhost/oauth", servers[0].GetString());
    }

    [Fact]
    public async Task T2_MissingBearer_401_ChallengeCarriesResourceMetadata()
    {
        await using TransportApp app = await HostAsync();

        HttpResponseMessage response = await app.Client.PostAsync("/mcp", content: null);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        string[] values = [.. response.Headers.WwwAuthenticate.Select(h => h.ToString())];
        Assert.Single(values);
        Assert.Contains("resource_metadata=\"http://localhost/.well-known/oauth-protected-resource/mcp\"", values[0], StringComparison.Ordinal);
    }

    [Fact]
    public async Task T3_InvalidToken_401_ResourceMetadataMergedIntoJwtBearerChallenge()
    {
        await using TransportApp app = await HostAsync();

        using HttpRequestMessage request = new(HttpMethod.Post, "/mcp");
        request.Headers.TryAddWithoutValidation("Authorization", "Bearer not-a-real-jwt");
        HttpResponseMessage response = await app.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        string[] values = [.. response.Headers.WwwAuthenticate.Select(h => h.ToString())];
        Assert.Single(values);
        Assert.Contains("error=\"invalid_token\"", values[0], StringComparison.Ordinal);
        Assert.Contains("resource_metadata=", values[0], StringComparison.Ordinal);
    }

    [Fact]
    public async Task T4_WrongAudienceToken_Rejected()
    {
        await using TransportApp app = await HostAsync();
        string token = app.AuthServer.IssueAccessToken("alice", new Uri("http://localhost/other-resource"), scope: null);

        using HttpRequestMessage request = new(HttpMethod.Post, "/mcp");
        request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
        HttpResponseMessage response = await app.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task T5_OAuthFlow_Dcr_Pkce_Authorize_Token_ThenSearchTools()
    {
        await using TransportApp app = await HostAsync();

        Func<AuthorizationCallbackContext, CancellationToken, Task<AuthorizationResult?>> callbackHandler =
            async (context, cancellationToken) =>
            {
                HttpResponseMessage authorizeResponse = await app.Client.GetAsync(context.AuthorizationUri, cancellationToken);
                if (authorizeResponse.StatusCode is not (HttpStatusCode.Redirect or HttpStatusCode.Found))
                {
                    string body = await authorizeResponse.Content.ReadAsStringAsync(cancellationToken);
                    throw new InvalidOperationException(
                        $"authorize endpoint returned {(int)authorizeResponse.StatusCode}: {body}");
                }
                Uri location = authorizeResponse.Headers.Location
                    ?? throw new InvalidOperationException("authorize endpoint did not return a Location header.");
                Dictionary<string, StringValues> query = QueryHelpers.ParseQuery(location.Query);
                return new AuthorizationResult
                {
                    Code = query.TryGetValue("code", out StringValues code) ? code.ToString() : null,
                    State = query.TryGetValue("state", out StringValues state) ? state.ToString() : null,
                };
            };

        McpClient client = await ConnectAsync(app, bearerToken: null, options =>
        {
            options.OAuth = new ClientOAuthOptions
            {
                RedirectUri = new Uri("http://localhost/callback"),
                DynamicClientRegistration = new DynamicClientRegistrationOptions { ClientName = "sezzlee-tests" },
                AuthorizationCallbackHandler = callbackHandler,
            };
        });
        await using (client)
        {
            CallToolResult result = await client.CallToolAsync("search_tools", cancellationToken: CancellationToken.None);
            Assert.NotEqual(true, result.IsError);
        }
    }

    [Fact]
    public void T6_IssuedToken_AudienceEqualsMcpResource()
    {
        DemoAuthServer authServer = new(new DemoAuthServerOptions
        {
            Issuer = new Uri("http://localhost/oauth"),
            DefaultAudience = new Uri("http://localhost/mcp"),
        });

        string token = authServer.IssueAccessToken("alice", new Uri("http://localhost/mcp"), scope: null);
        JsonWebToken parsed = new JsonWebTokenHandler().ReadJsonWebToken(token);

        Assert.Contains("http://localhost/mcp", parsed.Audiences);
    }

    [Fact]
    public async Task T7_CustomMiddlewareHost_401BodyPreserved_ChallengeAdded_PrmServedBeforeAuth()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Services.AddSezzlee(o => o.ResourceServer.Metadata = new ProtectedResourceMetadata
        {
            Resource = "http://localhost/mcp",
            AuthorizationServers = { "http://localhost/oauth" },
        });

        WebApplication app = builder.Build();
        app.UseSezzleeCapture();
        app.UseRouting();
        app.Use(async (context, next) =>
        {
            if (!context.Request.Headers.ContainsKey("Authorization"))
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                context.Response.ContentType = "application/json";
                await context.Response.WriteAsync("""{"error":"Unauthorized"}""");
                return;
            }
            await next();
        });
        app.MapSezzlee("/mcp");
        await app.StartAsync();
        await using WebApplication _ = app;

        HttpClient client = app.GetTestClient();

        HttpResponseMessage prm = await client.GetAsync("/.well-known/oauth-protected-resource/mcp");
        Assert.Equal(HttpStatusCode.OK, prm.StatusCode);

        HttpResponseMessage denied = await client.PostAsync("/mcp", content: null);
        Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);
        Assert.Equal("""{"error":"Unauthorized"}""", await denied.Content.ReadAsStringAsync());
        string[] values = [.. denied.Headers.WwwAuthenticate.Select(h => h.ToString())];
        Assert.Single(values);
        Assert.Contains("resource_metadata=", values[0], StringComparison.Ordinal);
    }

    [Fact]
    public async Task T8_ResourceServerNotConfigured_NoPrm_NoDecoration()
    {
        await using TransportApp app = await HostAsync(configureResourceServer: false);

        HttpResponseMessage prm = await app.Client.GetAsync("/.well-known/oauth-protected-resource/mcp");
        Assert.Equal(HttpStatusCode.NotFound, prm.StatusCode);

        HttpResponseMessage denied = await app.Client.PostAsync("/mcp", content: null);
        Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);
        string[] values = [.. denied.Headers.WwwAuthenticate.Select(h => h.ToString())];
        Assert.DoesNotContain(values, v => v.Contains("resource_metadata", StringComparison.Ordinal));
    }

    [Fact]
    public async Task T9_ListChanged_StatefulSession_NotifiedAfterCatalogChange()
    {
        await using TransportApp app = await HostAsync(configureServices: services =>
            services.Configure<HttpServerTransportOptions>(o => o.SessionMode = HttpServerSessionMode.Stateful));
        string token = app.AuthServer.IssueAccessToken("alice", new Uri("http://localhost/mcp"), scope: null);

        McpClient client = await ConnectAsync(app, token);
        await using (client)
        {
            TaskCompletionSource<bool> notified = new(TaskCreationOptions.RunContinuationsAsynchronously);
            await using IAsyncDisposable subscription = client.RegisterNotificationHandler(
                NotificationMethods.ToolListChangedNotification,
                (_, _) =>
                {
                    notified.TrySetResult(true);
                    return ValueTask.CompletedTask;
                });

            // Guard: the client opens its standalone GET stream after initialize, asynchronously, and
            // the MCP server drops a notification sent before that stream exists
            // (StreamableHttpServerTransport.SendMessageAsync). One reload right after connect races
            // it, so the catalog keeps changing until the notification lands or the deadline passes.
            SezzleeCatalogProvider catalog = app.App.Services.GetRequiredService<SezzleeCatalogProvider>();
            Task deadline = Task.Delay(TimeSpan.FromSeconds(10));
            while (!notified.Task.IsCompleted && !deadline.IsCompleted)
            {
                await catalog.ReloadAsync();
                await Task.WhenAny(notified.Task, deadline, Task.Delay(TimeSpan.FromMilliseconds(250)));
            }
            Assert.True(notified.Task.IsCompleted);
        }
    }

    [Fact]
    public async Task T10_ListChanged_Stateless_NoNotification_NoError()
    {
        await using TransportApp app = await HostAsync();
        string token = app.AuthServer.IssueAccessToken("alice", new Uri("http://localhost/mcp"), scope: null);

        McpClient client = await ConnectAsync(app, token);
        await using (client)
        {
            TaskCompletionSource<bool> notified = new(TaskCreationOptions.RunContinuationsAsynchronously);
            await using IAsyncDisposable subscription = client.RegisterNotificationHandler(
                NotificationMethods.ToolListChangedNotification,
                (_, _) =>
                {
                    notified.TrySetResult(true);
                    return ValueTask.CompletedTask;
                });

            await app.App.Services.GetRequiredService<SezzleeCatalogProvider>().ReloadAsync();
            await Task.WhenAny(notified.Task, Task.Delay(TimeSpan.FromMilliseconds(500)));
            Assert.False(notified.Task.IsCompleted);

            CallToolResult result = await client.CallToolAsync("search_tools", cancellationToken: CancellationToken.None);
            Assert.NotEqual(true, result.IsError);
        }
    }

    [Fact]
    public async Task T11_Initialize_AdvertisesToolsListChanged()
    {
        await using TransportApp app = await HostAsync(configureServices: services =>
            services.Configure<HttpServerTransportOptions>(o => o.SessionMode = HttpServerSessionMode.Stateful));
        string token = app.AuthServer.IssueAccessToken("alice", new Uri("http://localhost/mcp"), scope: null);

        McpClient client = await ConnectAsync(app, token);
        await using (client)
        {
            Assert.True(client.ServerCapabilities.Tools?.ListChanged);
        }
    }

    [Fact]
    public async Task T12_ToolsList_MetaCarriesCatalogGeneration_AfterChange()
    {
        await using TransportApp app = await HostAsync();
        string token = app.AuthServer.IssueAccessToken("alice", new Uri("http://localhost/mcp"), scope: null);

        McpClient client = await ConnectAsync(app, token);
        await using (client)
        {
            IList<McpClientTool> before = await client.ListToolsAsync(cancellationToken: CancellationToken.None);
            long generationBefore = before[0].ProtocolTool.Meta?[GenerationMetaKey]?.GetValue<long>()
                ?? throw new InvalidOperationException("Missing sezzlee/catalogGeneration meta.");

            await app.App.Services.GetRequiredService<SezzleeCatalogProvider>().ReloadAsync();

            IList<McpClientTool> after = await client.ListToolsAsync(cancellationToken: CancellationToken.None);
            long generationAfter = after[0].ProtocolTool.Meta?[GenerationMetaKey]?.GetValue<long>()
                ?? throw new InvalidOperationException("Missing sezzlee/catalogGeneration meta.");

            Assert.True(generationAfter > generationBefore);
        }
    }

    [Fact]
    public async Task T13_HostUsingSdkAddMcpHandler_NoDuplicateResourceMetadata()
    {
        string resource = "http://localhost/mcp";

        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();

        DemoAuthServer authServer = new(new DemoAuthServerOptions
        {
            Issuer = new Uri("http://localhost/oauth"),
            DefaultAudience = new Uri(resource),
        });

        builder.Services.AddAuthentication(options =>
            {
                options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
                options.DefaultChallengeScheme = McpAuthenticationDefaults.AuthenticationScheme;
            })
            .AddJwtBearer(o =>
            {
                o.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuer = true,
                    ValidIssuer = authServer.Issuer.ToString(),
                    ValidateAudience = true,
                    ValidAudience = resource,
                    IssuerSigningKey = authServer.PublicKey,
                };
            })
            .AddMcp(o => o.ResourceMetadata = new ProtectedResourceMetadata
            {
                Resource = resource,
                AuthorizationServers = { authServer.Issuer.ToString() },
            });
        builder.Services.AddAuthorization();

        builder.Services.AddSezzlee(o => o.ResourceServer.Metadata = new ProtectedResourceMetadata
        {
            Resource = resource,
            AuthorizationServers = { authServer.Issuer.ToString() },
        });

        WebApplication app = builder.Build();
        app.UseSezzleeCapture();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapSezzlee("/mcp").RequireAuthorization();
        await app.StartAsync();
        await using WebApplication _ = app;

        HttpResponseMessage response = await app.GetTestClient().PostAsync("/mcp", content: null);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        IEnumerable<string> values = response.Headers.TryGetValues("WWW-Authenticate", out IEnumerable<string>? raw)
            ? raw
            : [];
        Assert.Equal(1, CountOccurrences(values, "resource_metadata"));
    }

    [Fact]
    public async Task T14_MapSezzlee_RequireAuthorization_BlocksAnonymousInitialize()
    {
        await using TransportApp app = await HostAsync();

        string initialize = JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 1,
            method = "initialize",
            @params = new
            {
                protocolVersion = LegacyProtocolVersion,
                capabilities = new { },
                clientInfo = new { name = "anon", version = "1.0" },
            },
        });

        using HttpRequestMessage request = new(HttpMethod.Post, "/mcp")
        {
            Content = new StringContent(initialize, System.Text.Encoding.UTF8, "application/json"),
        };
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));

        HttpResponseMessage response = await app.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task T15_ResourceServerOptions_WithoutResource_FailsValidation()
    {
        await Assert.ThrowsAsync<OptionsValidationException>(() => HostAsync(
            configureResourceServer: false,
            configureSezzlee: o => o.ResourceServer.Metadata = new ProtectedResourceMetadata
            {
                AuthorizationServers = { "http://localhost/oauth" },
            }));
    }

    /// <remarks>
    /// The published argument set is contract ([search-semantics.md]); before this test nothing checked
    /// it on either side. It asserts values, not key order or dialect decoration, which the spec leaves
    /// to each framework.
    /// </remarks>
    [Fact]
    public async Task T16_ToolsList_SearchToolsPublishesDetailArgument()
    {
        await using TransportApp app = await HostAsync();
        string token = app.AuthServer.IssueAccessToken("alice", new Uri("http://localhost/mcp"), scope: null);

        McpClient client = await ConnectAsync(app, token);
        await using (client)
        {
            IList<McpClientTool> tools = await client.ListToolsAsync(cancellationToken: CancellationToken.None);
            McpClientTool search = tools.Single(tool => tool.ProtocolTool.Name == "search_tools");
            JsonElement detail = search.ProtocolTool.InputSchema
                .GetProperty("properties")
                .GetProperty("detail");

            Assert.Equal("string", detail.GetProperty("type").GetString());
            Assert.Equal("card", detail.GetProperty("default").GetString());
            Assert.Equal(
                ["card", "schema"],
                detail.GetProperty("enum").EnumerateArray().Select(value => value.GetString()!).ToArray());
            Assert.False(string.IsNullOrWhiteSpace(detail.GetProperty("description").GetString()));
        }
    }

    /// <remarks>
    /// The twin of this test is "search_tools publishes tags as an optional string array" in
    /// sdks/nestjs/test/meta-tools.spec.ts, and the description is asserted verbatim in both
    /// because nothing else can compare two SDKs running in two processes. The <c>default</c> is
    /// null rather than an empty array because a C# array parameter's default must be a
    /// compile-time constant; the NestJS shape publishes the same null through zod's `meta`.
    /// </remarks>
    [Fact]
    public async Task T17_ToolsList_SearchToolsPublishesTagsArgument()
    {
        await using TransportApp app = await HostAsync();
        string token = app.AuthServer.IssueAccessToken("alice", new Uri("http://localhost/mcp"), scope: null);

        McpClient client = await ConnectAsync(app, token);
        await using (client)
        {
            IList<McpClientTool> tools = await client.ListToolsAsync(cancellationToken: CancellationToken.None);
            McpClientTool search = tools.Single(tool => tool.ProtocolTool.Name == "search_tools");
            JsonElement schema = search.ProtocolTool.InputSchema;
            JsonElement tags = schema.GetProperty("properties").GetProperty("tags");

            Assert.Equal("array", tags.GetProperty("type").GetString());
            Assert.Equal("string", tags.GetProperty("items").GetProperty("type").GetString());
            Assert.Equal(JsonValueKind.Null, tags.GetProperty("default").ValueKind);
            Assert.Equal(
                "Tags every result must carry, matched against the whole tag and insensitive to case and accents. Empty applies no filter; the answer's tags field lists what is available.",
                tags.GetProperty("description").GetString());
            Assert.False(
                schema.TryGetProperty("required", out JsonElement required)
                    && required.EnumerateArray().Any(name => name.GetString() == "tags"));
        }
    }

    /// <remarks>
    /// Guard: a misnamed meta-tool argument is rejected by the framework's binder before the handler
    /// runs, so only <c>SezzleeBudgetTool</c> can turn it into an envelope. Measured: a model called
    /// <c>load_tool</c> with <c>operation</c> instead of <c>name</c> and the turn died on a bare
    /// "An error occurred invoking 'load_tool'".
    /// </remarks>
    [Fact]
    public async Task T19_MisnamedArgument_BecomesEnvelopeNamingTheRealOne()
    {
        await using TransportApp app = await HostAsync();
        string token = app.AuthServer.IssueAccessToken("alice", new Uri("http://localhost/mcp"), scope: null);

        McpClient client = await ConnectAsync(app, token);
        await using (client)
        {
            CallToolResult result = await client.CallToolAsync(
                "load_tool",
                new Dictionary<string, object?> { ["operation"] = "get_order" },
                cancellationToken: CancellationToken.None);

            Assert.True(result.IsError);
            string text = ((TextContentBlock)result.Content.Single()).Text;
            using JsonDocument document = JsonDocument.Parse(text);
            Assert.Equal("unknown_argument", document.RootElement.GetProperty("error").GetString());
            string message = document.RootElement.GetProperty("message").GetString()!;
            Assert.Contains("'operation'", message);
            Assert.Contains("'name'", message);
        }
    }

    /// <remarks>
    /// The twin of "invoke_tool publishes name and arguments as required" in
    /// sdks/nestjs/test/meta-tools.spec.ts. <c>arguments</c> publishes a description and no
    /// <c>type</c> on purpose: the parameter binds as raw JSON so a non-object value reaches the
    /// handler and leaves as an sezzlee envelope rather than a raw MCP validation error.
    /// </remarks>
    [Fact]
    public async Task T18_ToolsList_InvokeToolPublishesItsArguments()
    {
        await using TransportApp app = await HostAsync();
        string token = app.AuthServer.IssueAccessToken("alice", new Uri("http://localhost/mcp"), scope: null);

        McpClient client = await ConnectAsync(app, token);
        await using (client)
        {
            IList<McpClientTool> tools = await client.ListToolsAsync(cancellationToken: CancellationToken.None);
            JsonElement schema = tools.Single(tool => tool.ProtocolTool.Name == "invoke_tool").ProtocolTool.InputSchema;
            JsonElement properties = schema.GetProperty("properties");

            Assert.Equal("string", properties.GetProperty("name").GetProperty("type").GetString());
            Assert.Equal("Operation name exactly as returned by search_tools.", properties.GetProperty("name").GetProperty("description").GetString());

            JsonElement arguments = properties.GetProperty("arguments");
            Assert.Equal("Arguments as a JSON object whose keys are the input schema's properties. Send the object itself, not a string containing JSON.", arguments.GetProperty("description").GetString());
            Assert.False(arguments.TryGetProperty("type", out _));

            Assert.Equal(
                ["arguments", "name"],
                schema.GetProperty("required").EnumerateArray()
                    .Select(value => value.GetString()!)
                    .Order(StringComparer.Ordinal)
                    .ToArray());
        }
    }
}
