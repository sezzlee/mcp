using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Errors;
using Sezzlee.AspNetCore.RateLimiting;
using Sezzlee.AspNetCore.Spec;
using Sezzlee.AspNetCore.Visibility;

namespace Sezzlee.Tests;

internal sealed class RateGate
{
    public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
}

internal sealed class MapperSwitch
{
    public volatile bool Throw;
}

internal sealed class SwitchableMapper(MapperSwitch toggle, IInvokeResultMapper inner) : IInvokeResultMapper
{
    public InvokeOutcome Map(BackendResponse response, IReadOnlySet<string> knownFields) =>
        toggle.Throw ? throw new InvalidOperationException("mapper failed") : inner.Map(response, knownFields);

    public InvokeOutcome Map(BackendResponse response, FieldVocabulary vocabulary) =>
        toggle.Throw ? throw new InvalidOperationException("mapper failed") : inner.Map(response, vocabulary);
}

internal sealed class RateLimitApp : IAsyncDisposable
{
    private readonly List<McpClient> _clients = [];

    public required WebApplication App { get; init; }

    public required RateGate Gate { get; init; }

    public required MapperSwitch Mapper { get; init; }

    public async Task<McpClient> ConnectAsync(string? caller = null)
    {
        HttpClientTransportOptions options = new()
        {
            Endpoint = new Uri("http://localhost/mcp"),
            Name = "sezzlee-rate-limit-tests",
        };
        if (caller is not null)
        {
            options.AdditionalHeaders = new Dictionary<string, string> { ["Authorization"] = $"Bearer {caller}" };
        }
        HttpClientTransport transport = new(options, App.GetTestClient(), loggerFactory: null, ownsHttpClient: false);
        McpClient client = await McpClient.CreateAsync(
            transport, new McpClientOptions { ProtocolVersion = ProtocolRevision.V20251125 },
            cancellationToken: CancellationToken.None);
        _clients.Add(client);
        return client;
    }

    public async ValueTask DisposeAsync()
    {
        foreach (McpClient client in _clients)
        {
            await client.DisposeAsync();
        }
        await App.StopAsync();
        await App.DisposeAsync();
    }
}

internal static class RateLimitHost
{
    public const string HourLong = "01:00:00";

    public static async Task<RateLimitApp> StartAsync(
        Action<SezzleeOptions>? configure = null,
        IConfiguration? configuration = null)
    {
        RateGate gate = new();
        MapperSwitch mapper = new();
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Services.AddSingleton(gate);
        builder.Services.AddSingleton<IToolAuthorizer>(new RecordingAuthorizer(
            (_, tool) => tool.Name == "hidden_tool" ? VisibilityDecision.Deny : VisibilityDecision.Allow));
        builder.Services.AddSingleton<IInvokeResultMapper>(provider => new SwitchableMapper(
            mapper, new InvokeResultMapper(provider.GetRequiredService<IOptions<SezzleeOptions>>())));
        if (configuration is null)
        {
            builder.Services.AddSezzlee(configure);
        }
        else
        {
            builder.Services.AddSezzlee(configuration, configure);
        }

        WebApplication app = builder.Build();
        app.UseSezzleeCapture();
        app.UseRouting();
        app.MapGet("/ping", () => "pong").WithMetadata(new McpToolAttribute { Name = "ping" });
        app.MapGet("/echo", () => "echo").WithMetadata(new McpToolAttribute { Name = "echo" });
        app.MapGet("/hidden", () => "secret").WithMetadata(new McpToolAttribute { Name = "hidden_tool" });
        app.MapGet("/block", async (RateGate held, CancellationToken cancellationToken) =>
            {
                held.Entered.TrySetResult();
                await held.Release.Task.WaitAsync(cancellationToken);
                return "released";
            })
            .WithMetadata(new McpToolAttribute { Name = "block_tool" });
        app.MapSezzlee("/mcp");
        await app.StartAsync();
        return new RateLimitApp { App = app, Gate = gate, Mapper = mapper };
    }

    public static async Task<(bool IsError, JsonElement Body)> CallAsync(
        McpClient client, string tool, Dictionary<string, object?> arguments)
    {
        CallToolResult result = await client.CallToolAsync(tool, arguments, cancellationToken: CancellationToken.None);
        string text = ((TextContentBlock)result.Content.Single()).Text;
        return (result.IsError == true, JsonDocument.Parse(text).RootElement.Clone());
    }

    public static Task<(bool IsError, JsonElement Body)> InvokeAsync(McpClient client, string name) =>
        CallAsync(client, "invoke_tool", new() { ["name"] = name, ["arguments"] = new Dictionary<string, object?>() });

    public static Task<(bool IsError, JsonElement Body)> LoadAsync(McpClient client, string name) =>
        CallAsync(client, "load_tool", new() { ["name"] = name });

    public static Task<(bool IsError, JsonElement Body)> SearchAsync(McpClient client) =>
        CallAsync(client, "search_tools", new() { ["query"] = "" });

    public static bool IsRateLimited(JsonElement body) =>
        body.TryGetProperty("error", out JsonElement code) && code.GetString() == "rate_limit_exceeded";

    public static RateLimitSettings Window(int permits) => new()
    {
        Kind = RateLimitKind.FixedWindow,
        PermitLimit = permits,
        Window = TimeSpan.FromHours(1),
    };
}
