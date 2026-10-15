using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Protocol;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Caching;
using Sezzlee.AspNetCore.Tools;
using Sezzlee.AspNetCore.Visibility;
using static Sezzlee.Tests.VisibilityHost;

namespace Sezzlee.Tests;

public sealed class ToolAuthorizerHostTests
{
    private static RecordingAuthorizer Shop() => new(ShopHost.ManagerSeesAllClerkSeesTheirOwn);

    private static string[] TagsOf(string raw)
    {
        using JsonDocument document = JsonDocument.Parse(raw);
        return document.RootElement.GetProperty("tags").ValueKind == JsonValueKind.Null
            ? []
            : [.. document.RootElement.GetProperty("tags").EnumerateArray().Select(tag => tag.GetString()!)];
    }

    private static async Task<(bool IsError, string Text)> LoadAsync(SezzleeMetaTools tools, string name)
    {
        CallToolResult result = await tools.LoadTool(name, CancellationToken.None);
        return (result.IsError == true, TextOf(result));
    }

    private static async Task<(bool IsError, string Text)> InvokeAsync(
        SezzleeMetaTools tools, string name, string? version = null)
    {
        CallToolResult result = await tools.InvokeTool(
            name, JsonSerializer.SerializeToElement(new { }), CancellationToken.None, version!);
        return (result.IsError == true, TextOf(result));
    }

    [Fact]
    public async Task AU1_TwoCallersSeeDifferentTools_AndTheLimitStillFillsFromAllowedOnes()
    {
        await using Harness host = await ShopHost.StartAsync(Shop());

        (HashSet<string> manager, _, int managerTotal, _) = await SearchAsync(host.ToolsFor("manager"));
        (HashSet<string> clerk, _, int clerkTotal, _) = await SearchAsync(host.ToolsFor("clerk"));

        Assert.Equal(
            ["admin_close_books", "admin_list_salaries", "list_balances", "list_gated", "list_invoices", "list_orders", "list_public"],
            manager.Order(StringComparer.Ordinal));
        Assert.Equal(7, managerTotal);
        Assert.Equal(
            ["list_balances", "list_gated", "list_invoices", "list_orders", "list_public"],
            clerk.Order(StringComparer.Ordinal));
        Assert.Equal(5, clerkTotal);

        string page = TextOf(await host.ToolsFor("clerk").SearchTools("", 2));
        using JsonDocument document = JsonDocument.Parse(page);
        Assert.Equal(
            ["list_balances", "list_gated"],
            document.RootElement.GetProperty("results").EnumerateArray().Select(card => card.GetProperty("name").GetString()));
    }

    [Fact]
    public async Task AU2_AFamilyMemberIsDecidedByItsKey_AndTheAuthorizerSeesWhereItCameFrom()
    {
        RecordingAuthorizer authorizer = Shop();
        await using Harness host = await ShopHost.StartAsync(authorizer);

        (HashSet<string> clerk, _, _, _) = await SearchAsync(host.ToolsFor("clerk"));

        Assert.Contains("list_balances", clerk);
        Assert.DoesNotContain("admin_list_salaries", clerk);

        McpToolInfo member = authorizer.Inspected.Single(tool => tool.Name == "admin_list_salaries");
        Assert.Equal(new McpFamilyMemberInfo("methods", ShopHost.SalariesKey), member.Member);
        Assert.Equal("POST", member.Method);
        Assert.Equal("/shop/dispatch/{methodId}", member.Route);
        Assert.Equal(typeof(ShopControllers.Shop).FullName, member.Container);
        Assert.Equal(nameof(ShopControllers.Shop.Dispatch), member.Action?.Name);

        McpToolInfo plain = authorizer.Inspected.Single(tool => tool.Name == "list_orders");
        Assert.Null(plain.Member);
        Assert.Equal(nameof(ShopControllers.Shop.ListOrders), plain.Action?.Name);
    }

    [Fact]
    public async Task AU3_TheTagVocabularyOmitsTagsOnlyDeniedToolsCarry()
    {
        await using Harness host = await ShopHost.StartAsync(Shop());

        string[] clerk = TagsOf((await SearchAsync(host.ToolsFor("clerk"))).Raw);
        string[] manager = TagsOf((await SearchAsync(host.ToolsFor("manager"))).Raw);

        Assert.DoesNotContain("admin", clerk);
        Assert.Contains("admin", manager);
        Assert.Contains("dynamic", clerk);
        Assert.Contains("sales", clerk);
    }

    [Fact]
    public async Task AU4_LoadOnADeniedTool_AnswersExactlyLikeAToolThatDoesNotExist()
    {
        await using Harness host = await ShopHost.StartAsync(Shop());
        SezzleeMetaTools clerk = host.ToolsFor("clerk");

        (bool deniedError, string denied) = await LoadAsync(clerk, "admin_close_books");
        (bool missingError, string missing) = await LoadAsync(clerk, "no_such_tool");

        Assert.True(deniedError && missingError);
        Assert.Equal(missing.Replace("no_such_tool", "x", StringComparison.Ordinal), denied.Replace("admin_close_books", "x", StringComparison.Ordinal));
        Assert.Contains("unknown_tool", denied, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AU4b_InvokeDoesNotConsultTheAuthorizer_TheBackendPipelineDecides()
    {
        RecordingAuthorizer authorizer = Shop();
        await using Harness host = await ShopHost.StartAsync(authorizer);
        int closedBefore = ShopControllers.Closed;

        Assert.Equal(200, await InvokeStatusAsync(host.ToolsFor("clerk"), "admin_close_books", new { }));

        Assert.Equal(closedBefore + 1, ShopControllers.Closed);
        Assert.Equal(0, authorizer.Resolutions);
    }

    [Fact]
    public async Task AU5_TheAuthorizerIsResolvedOncePerCallerScope_AcrossSearchAndLoad()
    {
        RecordingAuthorizer authorizer = Shop();
        await using Harness host = await ShopHost.StartAsync(authorizer);
        SezzleeMetaTools clerk = host.ToolsFor("clerk");

        await SearchAsync(clerk);
        await SearchAsync(clerk);
        await LoadAsync(clerk, "list_orders");
        Assert.Equal(1, authorizer.Resolutions);

        await SearchAsync(host.ToolsFor("manager"));
        Assert.Equal(2, authorizer.Resolutions);
    }

    [Fact]
    public async Task AU6_ConcurrentFirstCallsOfOneCaller_ResolveTheAuthorizerOnce()
    {
        TaskCompletionSource release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        RecordingAuthorizer authorizer = new(ShopHost.ManagerSeesAllClerkSeesTheirOwn, gate: () => release.Task);
        await using Harness host = await ShopHost.StartAsync(authorizer);
        SezzleeMetaTools clerk = host.ToolsFor("clerk");

        Task[] calls = [.. Enumerable.Range(0, 8).Select(_ => SearchAsync(clerk))];
        release.SetResult();
        await Task.WhenAll(calls);

        Assert.Equal(1, authorizer.Resolutions);
    }

    [Fact]
    public async Task AU7_AResolvedAccessIsResolvedAgainOnceItsLifetimeEnds_OrItsCallerIsInvalidated()
    {
        ManualTime time = new();
        RecordingAuthorizer authorizer = Shop();
        await using Harness host = await ShopHost.StartAsync(
            authorizer,
            configure: options => options.Cache.Lifetime = TimeSpan.FromSeconds(30),
            services: services => services.AddSingleton<TimeProvider>(time));
        SezzleeMetaTools clerk = host.ToolsFor("clerk");

        await SearchAsync(clerk);
        time.Advance(TimeSpan.FromSeconds(29));
        await SearchAsync(clerk);
        Assert.Equal(1, authorizer.Resolutions);

        time.Advance(TimeSpan.FromSeconds(2));
        await SearchAsync(clerk);
        Assert.Equal(2, authorizer.Resolutions);

        CallerScope scope = host.App.Services.GetRequiredService<ICallerScopeResolver>()
            .Resolve(new Microsoft.AspNetCore.Http.DefaultHttpContext
            {
                Request = { Headers = { Authorization = "Bearer clerk" } },
            }.Request);
        await host.App.Services.GetRequiredService<ISezzleeCacheInvalidator>().InvalidateCallerAsync(scope);
        await SearchAsync(clerk);
        Assert.Equal(3, authorizer.Resolutions);
    }

    [Fact]
    public async Task AU8_UnknownFromTheAuthorizerFallsToTheDeclarativeTier_ThenToOnUnknown()
    {
        RecordingAuthorizer authorizer = new((user, tool) => user switch
        {
            "outsider" when tool.Name == "list_public" => VisibilityDecision.Deny,
            _ => tool.Name is "list_public" or "list_orders" ? VisibilityDecision.Unknown : VisibilityDecision.Allow,
        });
        await using Harness host = await ShopHost.StartAsync(authorizer);

        (HashSet<string> insider, _, _, _) = await SearchAsync(host.ToolsFor("clerk"));
        (HashSet<string> outsider, _, _, _) = await SearchAsync(host.ToolsFor("outsider"));

        Assert.Contains("list_public", insider);
        Assert.DoesNotContain("list_orders", insider);
        Assert.DoesNotContain("list_public", outsider);
    }

    [Theory]
    [InlineData(true, null, false)]
    [InlineData(true, UnknownVisibility.Hide, false)]
    [InlineData(true, UnknownVisibility.Show, true)]
    [InlineData(false, null, true)]
    [InlineData(false, UnknownVisibility.Hide, false)]
    public async Task AU9_OnUnknownDefaultsToHideWithAnAuthorizerAndShowWithout_AndAnExplicitChoiceWins(
        bool registered, UnknownVisibility? onUnknown, bool listed)
    {
        RecordingAuthorizer? authorizer = registered
            ? new RecordingAuthorizer((_, tool) => tool.Name == "list_orders" ? VisibilityDecision.Unknown : VisibilityDecision.Allow)
            : null;
        await using Harness host = await ShopHost.StartAsync(
            authorizer, configure: options => options.Visibility.OnUnknown = onUnknown);

        (HashSet<string> names, HashSet<string> uncertain, _, _) = await SearchAsync(host.ToolsFor("clerk"));

        Assert.Equal(listed, names.Contains("list_orders"));
        Assert.Equal(listed, uncertain.Contains("list_orders"));
        (bool loadFailed, _) = await LoadAsync(host.ToolsFor("clerk"), "list_orders");
        Assert.Equal(listed, !loadFailed);
    }

    [Fact]
    public async Task AU10_WithoutAnAuthorizerNothingIsRefused()
    {
        await using Harness host = await ShopHost.StartAsync();
        SezzleeMetaTools anyone = host.ToolsFor("clerk");

        (HashSet<string> names, _, int total, _) = await SearchAsync(anyone);

        Assert.Equal(7, total);
        Assert.Contains("admin_close_books", names);
        Assert.Equal(200, await InvokeStatusAsync(anyone, "admin_close_books", new { }));
    }

    [Fact]
    public async Task AU11_TheAuthorizerDecidesEachToolOncePerCall()
    {
        RecordingAuthorizer authorizer = Shop();
        await using Harness host = await ShopHost.StartAsync(authorizer);

        await SearchAsync(host.ToolsFor("clerk"));

        Assert.All(
            ["admin_close_books", "list_orders", "list_balances", "list_public"],
            tool => Assert.Equal(1, authorizer.DecisionsFor(tool)));
    }

    [Fact]
    public async Task AU12_AFailingResolutionFailsTheCall_AndIsNotCached()
    {
        RecordingAuthorizer authorizer = new(ShopHost.ManagerSeesAllClerkSeesTheirOwn) { FailFirstResolutions = 1 };
        await using Harness host = await ShopHost.StartAsync(authorizer);
        SezzleeMetaTools clerk = host.ToolsFor("clerk");

        await Assert.ThrowsAsync<InvalidOperationException>(async () => await SearchAsync(clerk));

        (HashSet<string> names, _, _, _) = await SearchAsync(clerk);

        Assert.Contains("list_orders", names);
        Assert.Equal(2, authorizer.Resolutions);
    }
}
