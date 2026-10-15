using System.IO.Pipelines;
using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.RateLimiting;
using static Sezzlee.Tests.RateLimitHost;

namespace Sezzlee.Tests;

public sealed class RateLimitToolTests
{
    private static readonly Lazy<McpServer> Server = new(() =>
    {
        Pipe input = new();
        Pipe output = new();
        return McpServer.Create(
            new StreamServerTransport(input.Reader.AsStream(), output.Writer.AsStream(), "rate-limit-tests"),
            new McpServerOptions());
    });

    private static ConcurrencyLimiterOptions One() => new() { PermitLimit = 1, QueueLimit = 0 };

    private static McpServerTool Fake(string name, Func<CancellationToken, Task> body) =>
        McpServerTool.Create(
            async (CancellationToken cancellationToken) =>
            {
                await body(cancellationToken);
                return "ok";
            },
            new McpServerToolCreateOptions { Name = name });

    private static RequestContext<CallToolRequestParams> Call(string tool, string? name = null)
    {
        Dictionary<string, JsonElement> arguments = [];
        if (name is not null)
        {
            arguments["name"] = JsonSerializer.SerializeToElement(name);
        }
        return new RequestContext<CallToolRequestParams>(
            Server.Value,
            new JsonRpcRequest { Method = "tools/call" },
            new CallToolRequestParams { Name = tool, Arguments = arguments });
    }

    private static async Task<(WebApplication App, MetaToolRateLimiter Limiter)> StartAsync(
        Action<RateLimitingOptions> configure)
    {
        RateLimitApp host = await RateLimitHost.StartAsync(o => configure(o.RateLimiting));
        return (host.App, host.App.Services.GetRequiredService<MetaToolRateLimiter>());
    }

    private static bool Refused(CallToolResult result) =>
        result.IsError == true && ((TextContentBlock)result.Content.Single()).Text.Contains("rate_limit_exceeded", StringComparison.Ordinal);

    [Fact]
    public async Task RLT1_TheSlotIsFreed_WhenTheInnerCallThrows()
    {
        (WebApplication app, MetaToolRateLimiter limiter) = await StartAsync(o => o.InvokeConcurrency = 1);
        await using (app)
        {
            RateLimitingTool throwing = new(
                Fake("invoke_tool", _ => throw new InvalidOperationException("boom")), limiter);
            RateLimitingTool fine = new(Fake("invoke_tool", _ => Task.CompletedTask), limiter);

            await Assert.ThrowsAsync<InvalidOperationException>(
                async () => await throwing.InvokeAsync(Call("invoke_tool", "ping")));

            Assert.False(Refused(await fine.InvokeAsync(Call("invoke_tool", "ping"))));
        }
    }

    [Fact]
    public async Task RLT2_TheSlotIsFreed_WhenTheCallIsCancelled()
    {
        (WebApplication app, MetaToolRateLimiter limiter) = await StartAsync(o => o.InvokeConcurrency = 1);
        await using (app)
        {
            TaskCompletionSource entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
            RateLimitingTool waiting = new(
                Fake("invoke_tool", async cancellationToken =>
                {
                    entered.SetResult();
                    await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                }),
                limiter);
            RateLimitingTool fine = new(Fake("invoke_tool", _ => Task.CompletedTask), limiter);
            using CancellationTokenSource cancel = new();

            Task<CallToolResult> running = waiting.InvokeAsync(Call("invoke_tool", "ping"), cancel.Token).AsTask();
            await entered.Task;
            Assert.True(Refused(await fine.InvokeAsync(Call("invoke_tool", "ping"))));
            await cancel.CancelAsync();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await running);

            Assert.False(Refused(await fine.InvokeAsync(Call("invoke_tool", "ping"))));
        }
    }

    [Fact]
    public async Task RLT3_AChainedCeilingThatRefuses_ReleasesThePermitAlreadyTaken()
    {
        (WebApplication app, MetaToolRateLimiter limiter) = await StartAsync(o => o.Partitions(call =>
        [
            RateLimitPartition.GetConcurrencyLimiter($"caller:{call.Target?.Name}", _ => One()),
            RateLimitPartition.GetConcurrencyLimiter("ceiling", _ => One()),
        ]));
        await using (app)
        {
            TaskCompletionSource entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
            TaskCompletionSource release = new(TaskCreationOptions.RunContinuationsAsynchronously);
            RateLimitingTool holding = new(
                Fake("invoke_tool", async _ =>
                {
                    entered.SetResult();
                    await release.Task;
                }),
                limiter);
            RateLimitingTool fine = new(Fake("invoke_tool", _ => Task.CompletedTask), limiter);

            Task<CallToolResult> running = holding.InvokeAsync(Call("invoke_tool", "ping")).AsTask();
            await entered.Task;
            Assert.True(Refused(await fine.InvokeAsync(Call("invoke_tool", "echo"))));
            release.SetResult();
            await running;

            Assert.False(Refused(await fine.InvokeAsync(Call("invoke_tool", "echo"))));
        }
    }

    [Fact]
    public async Task RLT4_AnotherToolOnTheServer_IsLimitedAsOther()
    {
        List<McpCallContext> seen = [];
        (WebApplication app, MetaToolRateLimiter limiter) = await StartAsync(o => o.Partitions(call =>
        {
            seen.Add(call);
            return [RateLimitPartition.GetConcurrencyLimiter("all", _ => One())];
        }));
        await using (app)
        {
            RateLimitingTool custom = new(Fake("custom_tool", _ => Task.CompletedTask), limiter);

            await custom.InvokeAsync(Call("custom_tool", "ping"));

            McpCallContext context = Assert.Single(seen);
            Assert.Equal(McpMetaTool.Other, context.MetaTool);
            Assert.Equal("custom_tool", context.ToolName);
            Assert.Null(context.Target);
        }
    }

    [Fact]
    public async Task RLT5_AnEmptyPartitionList_LeavesTheCallUnlimited()
    {
        (WebApplication app, MetaToolRateLimiter limiter) = await StartAsync(o => o.Partitions(_ => []));
        await using (app)
        {
            RateLimitingTool tool = new(Fake("invoke_tool", _ => Task.CompletedTask), limiter);

            for (int call = 0; call < 5; call += 1)
            {
                Assert.False(Refused(await tool.InvokeAsync(Call("invoke_tool", "ping"))));
            }
        }
    }
}
