using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using ModelContextProtocol.Client;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.RateLimiting;
using static Sezzlee.Tests.RateLimitHost;

namespace Sezzlee.Tests;

public sealed class RateLimitHostTests
{
    [Fact]
    public async Task RL1_ExhaustingTheInvokeLimit_LeavesSearchAllowed()
    {
        await using RateLimitApp host = await StartAsync(o =>
        {
            o.RateLimiting.Search = Window(5);
            o.RateLimiting.Invoke = Window(1);
        });
        McpClient client = await host.ConnectAsync();

        Assert.False((await InvokeAsync(client, "ping")).IsError);
        (bool refused, JsonElement body) = await InvokeAsync(client, "ping");

        Assert.True(refused);
        Assert.True(IsRateLimited(body));
        (bool searchFailed, JsonElement search) = await SearchAsync(client);
        Assert.False(searchFailed);
        Assert.True(search.TryGetProperty("total", out _));
    }

    [Fact]
    public async Task RL2_ARefusedCall_IsANormalResultWithTheRetryHintAndThePinnedMessage()
    {
        await using RateLimitApp host = await StartAsync(o => o.RateLimiting.Invoke = Window(1));
        McpClient client = await host.ConnectAsync();
        await InvokeAsync(client, "ping");

        (bool isError, JsonElement body) = await InvokeAsync(client, "ping");

        Assert.True(isError);
        Assert.Equal("rate_limit_exceeded", body.GetProperty("error").GetString());
        Assert.True(body.GetProperty("retryable").GetBoolean());
        int seconds = body.GetProperty("retryAfterSeconds").GetInt32();
        Assert.InRange(seconds, 3_590, 3_600);
        Assert.Equal(
            $"The call was refused by this server's rate limit before it ran. Retry after {seconds} seconds.",
            body.GetProperty("message").GetString());
        Assert.False(body.TryGetProperty("status", out _));
    }

    [Theory]
    [InlineData("load_tool", "hidden_tool")]
    [InlineData("load_tool", "no_such_tool")]
    [InlineData("invoke_tool", "hidden_tool")]
    [InlineData("invoke_tool", "no_such_tool")]
    public async Task RL3_AHiddenOrUnknownName_TakesAPermitLikeAVisibleOne(string metaTool, string name)
    {
        await using RateLimitApp host = await StartAsync(o =>
        {
            RateLimitSettings limit = Window(2);
            if (metaTool == "load_tool")
            {
                o.RateLimiting.Load = limit;
            }
            else
            {
                o.RateLimiting.Invoke = limit;
            }
        });
        McpClient client = await host.ConnectAsync();
        Func<string, Task<(bool IsError, JsonElement Body)>> call =
            target => metaTool == "load_tool" ? LoadAsync(client, target) : InvokeAsync(client, target);

        (bool firstError, JsonElement first) = await call(name);
        (bool secondError, JsonElement second) = await call(name);
        (bool thirdError, JsonElement third) = await call("ping");

        Assert.False(IsRateLimited(first));
        Assert.False(IsRateLimited(second));
        if (name == "no_such_tool" || metaTool == "load_tool")
        {
            Assert.True(firstError && secondError);
            Assert.Equal("unknown_tool", first.GetProperty("error").GetString());
            Assert.Equal("unknown_tool", second.GetProperty("error").GetString());
        }
        Assert.True(thirdError);
        Assert.True(IsRateLimited(third));
    }

    [Theory]
    [InlineData("load_tool")]
    [InlineData("invoke_tool")]
    public async Task RL3b_ACallWhoseNameIsNotAString_TakesAPermitAndReachesNoTarget(string metaTool)
    {
        List<McpCallContext> seen = [];
        await using RateLimitApp host = await StartAsync(o => o.RateLimiting.Partitions(call =>
        {
            seen.Add(call);
            return [RateLimitPartition.GetFixedWindowLimiter("shared", _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 1,
                Window = TimeSpan.FromHours(1),
            })];
        }));
        McpClient client = await host.ConnectAsync();

        (bool firstError, JsonElement first) = await CallAsync(client, metaTool, new() { ["name"] = 5 });
        (bool secondError, JsonElement second) = await CallAsync(client, metaTool, new() { ["name"] = 5 });

        Assert.True(firstError);
        Assert.Equal("unknown_argument", first.GetProperty("error").GetString());
        Assert.True(secondError);
        Assert.True(IsRateLimited(second));
        Assert.All(seen, call => Assert.Null(call.Target));
    }

    [Fact]
    public async Task RL4_TheCallContextCarriesTheMetaToolTheTargetAndTheCallerScope()
    {
        List<McpCallContext> seen = [];
        await using RateLimitApp host = await StartAsync(o => o.RateLimiting.Partitions(call =>
        {
            seen.Add(call);
            return [];
        }));
        McpClient client = await host.ConnectAsync("alice");

        await SearchAsync(client);
        await LoadAsync(client, "hidden_tool");
        await InvokeAsync(client, "ping");
        await InvokeAsync(client, "no_such_tool");

        Assert.Equal(
            [McpMetaTool.Search, McpMetaTool.Load, McpMetaTool.Invoke, McpMetaTool.Invoke],
            seen.Select(call => call.MetaTool));
        Assert.Equal(
            ["search_tools", "load_tool", "invoke_tool", "invoke_tool"],
            seen.Select(call => call.ToolName));
        Assert.Equal([null, "hidden_tool", "ping", null], seen.Select(call => call.Target?.Name));
        Assert.All(seen, call =>
        {
            Assert.NotNull(call.HttpContext);
            Assert.NotEmpty(call.CallerScope);
        });
        Assert.Equal("GET", seen[2].Target!.Method);
    }

    [Fact]
    public async Task RL5_AToolThatIsNotAMetaTool_IsLimitedAsOtherUnderTheDefaultBucket()
    {
        await using RateLimitApp host = await StartAsync(o => o.RateLimiting.Default = Window(1));
        McpClient client = await host.ConnectAsync();

        (bool firstError, _) = await SearchAsync(client);
        (_, JsonElement second) = await LoadAsync(client, "ping");

        Assert.False(firstError);
        Assert.True(IsRateLimited(second));
    }

    [Fact]
    public async Task RL6_AMetaToolWithItsOwnSection_KeepsABucketSeparateFromTheDefault()
    {
        await using RateLimitApp host = await StartAsync(o =>
        {
            o.RateLimiting.Default = Window(1);
            o.RateLimiting.Search = Window(1);
        });
        McpClient client = await host.ConnectAsync();

        Assert.False((await SearchAsync(client)).IsError);
        Assert.False((await LoadAsync(client, "ping")).IsError);
        Assert.True(IsRateLimited((await SearchAsync(client)).Body));
        Assert.True(IsRateLimited((await LoadAsync(client, "ping")).Body));
    }

    [Fact]
    public async Task RL7_CallersAreLimitedApart_UntilTheHostSuppliesOneKey()
    {
        await using RateLimitApp apart = await StartAsync(o => o.RateLimiting.Invoke = Window(1));
        McpClient first = await apart.ConnectAsync("alice");
        McpClient second = await apart.ConnectAsync("bob");
        Assert.False((await InvokeAsync(first, "ping")).IsError);
        Assert.False((await InvokeAsync(second, "ping")).IsError);
        Assert.True(IsRateLimited((await InvokeAsync(first, "ping")).Body));

        await using RateLimitApp together = await StartAsync(o =>
        {
            o.RateLimiting.Invoke = Window(1);
            o.RateLimiting.Key(_ => "one-user");
        });
        McpClient alice = await together.ConnectAsync("alice");
        McpClient bob = await together.ConnectAsync("bob");
        Assert.False((await InvokeAsync(alice, "ping")).IsError);
        Assert.True(IsRateLimited((await InvokeAsync(bob, "ping")).Body));
    }

    [Fact]
    public async Task RL8_InvokeConcurrency_RefusesWithoutAHintWhileACallRuns_AndFreesTheSlotAfterwards()
    {
        await using RateLimitApp host = await StartAsync(o => o.RateLimiting.InvokeConcurrency = 1);
        McpClient client = await host.ConnectAsync();

        Task<(bool IsError, JsonElement Body)> running = InvokeAsync(client, "block_tool");
        await host.Gate.Entered.Task;
        (bool refusedError, JsonElement refused) = await InvokeAsync(client, "ping");

        Assert.True(refusedError);
        Assert.Equal("rate_limit_exceeded", refused.GetProperty("error").GetString());
        Assert.False(refused.TryGetProperty("retryAfterSeconds", out _));
        Assert.Equal(
            "The call was refused by this server's rate limit before it ran. Retry later.",
            refused.GetProperty("message").GetString());
        Assert.False((await SearchAsync(client)).IsError);

        host.Gate.Release.SetResult();
        Assert.False((await running).IsError);
        Assert.False((await InvokeAsync(client, "ping")).IsError);
    }

    [Fact]
    public async Task RL9_TheConcurrencySlotIsFreed_WhenTheResultCannotBeMapped()
    {
        await using RateLimitApp host = await StartAsync(o => o.RateLimiting.InvokeConcurrency = 1);
        McpClient client = await host.ConnectAsync();

        host.Mapper.Throw = true;
        (bool failed, JsonElement body) = await InvokeAsync(client, "ping");
        host.Mapper.Throw = false;

        Assert.True(failed);
        Assert.Equal("internal_error", body.GetProperty("error").GetString());
        Assert.False((await InvokeAsync(client, "ping")).IsError);
    }

    [Fact]
    public async Task RL10_WithNothingConfigured_NoCallIsLimited()
    {
        await using RateLimitApp host = await StartAsync();
        McpClient client = await host.ConnectAsync();

        Assert.False(host.App.Services.GetRequiredService<IOptions<SezzleeOptions>>()
            .Value.RateLimiting.IsConfigured);
        for (int call = 0; call < 20; call += 1)
        {
            Assert.False((await InvokeAsync(client, "ping")).IsError);
        }
    }

    [Fact]
    public async Task RL11_ACeilingInTheHostsPartitions_AppliesBeforeAnyDeclaredBehaviour()
    {
        await using RateLimitApp host = await StartAsync(o => o.RateLimiting.Partition(call =>
            RateLimitPartition.GetConcurrencyLimiter(
                call.MetaTool.ToString(),
                _ => new ConcurrencyLimiterOptions { PermitLimit = 1, QueueLimit = 0 })));
        McpClient client = await host.ConnectAsync();

        Task<(bool IsError, JsonElement Body)> running = InvokeAsync(client, "block_tool");
        await host.Gate.Entered.Task;

        Assert.True(IsRateLimited((await InvokeAsync(client, "ping")).Body));
        Assert.False((await SearchAsync(client)).IsError);
        host.Gate.Release.SetResult();
        await running;
    }
}
