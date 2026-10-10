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
using Sezzlee.AspNetCore.Tools;
using Sezzlee.AspNetCore.Visibility;

namespace Sezzlee.Tests;

/// <remarks>
/// Each host stands for one replica of a rolling deploy. The twin of these tests is
/// sdks/nestjs/test/tool-version.spec.ts.
/// </remarks>
public sealed class ToolVersionTests
{
    private sealed record Replica(WebApplication App, SezzleeMetaTools Tools, List<string> Dispatched) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await App.StopAsync();
            await App.DisposeAsync();
        }
    }

    private static async Task<Replica> StartAsync(Action<WebApplication, List<string>> map)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Services.AddSezzlee();

        WebApplication app = builder.Build();
        app.UseSezzleeCapture();
        app.UseRouting();
        List<string> dispatched = [];
        map(app, dispatched);
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
        return new Replica(app, tools, dispatched);
    }

    private static void MapPing(WebApplication app) =>
        app.MapGet("/ping", () => "pong").WithMetadata(new McpToolAttribute { Name = "ping" });

    private static void MapOrders(WebApplication app, List<string> dispatched) =>
        app.MapGet("/orders/{id}", (int id) =>
            {
                dispatched.Add("orders");
                return new { id };
            })
            .WithMetadata(new McpToolAttribute { Name = "get_order" });

    private static void MapOrdersWithExpand(WebApplication app, List<string> dispatched) =>
        app.MapGet("/orders/{id}", (int id, string? expand) =>
            {
                dispatched.Add("orders-with-expand");
                return new { id };
            })
            .WithMetadata(new McpToolAttribute { Name = "get_order" });

    private static JsonElement Parse(CallToolResult result) =>
        JsonDocument.Parse(((TextContentBlock)result.Content[0]).Text).RootElement.Clone();

    private static async Task<string> VersionOnAsync(Replica replica)
    {
        JsonElement loaded = Parse(await replica.Tools.LoadTool("get_order", CancellationToken.None));
        Assert.Equal(JsonValueKind.String, loaded.GetProperty("version").ValueKind);
        return loaded.GetProperty("version").GetString()!;
    }

    private static Task<CallToolResult> InvokeAsync(Replica replica, string name, string version) =>
        replica.Tools.InvokeTool(
            name, JsonSerializer.SerializeToElement(new { id = 7 }), CancellationToken.None, version);

    [Fact]
    public async Task V1_EndpointsMappedInAnotherOrder_GiveOneToolOneVersion()
    {
        await using Replica loadedFrom = await StartAsync((app, seen) => { MapOrders(app, seen); MapPing(app); });
        await using Replica sameBuild = await StartAsync((app, seen) => { MapPing(app); MapOrders(app, seen); });

        Assert.Equal(await VersionOnAsync(loadedFrom), await VersionOnAsync(sameBuild));
    }

    [Fact]
    public async Task V2_CallPinnedOnOneReplica_RunsOnAnotherReplicaOfTheSameBuild()
    {
        await using Replica loadedFrom = await StartAsync((app, seen) => { MapOrders(app, seen); MapPing(app); });
        await using Replica sameBuild = await StartAsync((app, seen) => { MapPing(app); MapOrders(app, seen); });

        CallToolResult result = await InvokeAsync(sameBuild, "get_order", await VersionOnAsync(loadedFrom));

        Assert.NotEqual(true, result.IsError);
        Assert.Equal(7, Parse(result).GetProperty("body").GetProperty("id").GetInt32());
    }

    [Fact]
    public async Task V3_CallPinnedToAVersionTheReplicaDoesNotHold_IsRefusedBeforeDispatch()
    {
        await using Replica loadedFrom = await StartAsync((app, seen) => MapOrders(app, seen));
        await using Replica nextBuild = await StartAsync((app, seen) => MapOrdersWithExpand(app, seen));

        CallToolResult result = await InvokeAsync(nextBuild, "get_order", await VersionOnAsync(loadedFrom));

        Assert.True(result.IsError);
        JsonElement envelope = Parse(result);
        Assert.Equal("tool_changed", envelope.GetProperty("error").GetString());
        Assert.Equal(
            "The tool 'get_order' changed after it was loaded, so the call was refused before reaching the backend. Load it again with load_tool and retry with the new version.",
            envelope.GetProperty("message").GetString());
        Assert.False(envelope.GetProperty("retryable").GetBoolean());
        Assert.Empty(nextBuild.Dispatched);
    }

    [Fact]
    public async Task V4_UnknownName_IsUnknownToolWhateverVersionItPins()
    {
        await using Replica replica = await StartAsync((app, seen) => MapOrders(app, seen));

        CallToolResult result = await InvokeAsync(replica, "nope", "stale");

        Assert.True(result.IsError);
        Assert.Equal("unknown_tool", Parse(result).GetProperty("error").GetString());
    }
}
