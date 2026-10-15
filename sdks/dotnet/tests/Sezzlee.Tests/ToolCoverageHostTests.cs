using Microsoft.Extensions.DependencyInjection;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Visibility;
using static Sezzlee.Tests.VisibilityHost;

namespace Sezzlee.Tests;

public sealed class ToolCoverageHostTests
{
    private const string Code = "visibility_uncovered";

    private static RecordingAuthorizer CoversOrdersInvoicesAndMembers() => new(
        ShopHost.ManagerSeesAllClerkSeesTheirOwn,
        covers: tool => tool.Member is not null || tool.Name is "list_orders" or "list_invoices");

    private static CatalogDiagnostic[] Uncovered(Harness host) =>
    [
        .. host.App.Services.GetRequiredService<SezzleeCatalogProvider>().Result.Diagnostics
            .Where(diagnostic => diagnostic.Code == Code),
    ];

    [Fact]
    public async Task CV1_ToolsNoTierCanDecide_AreReportedOnceWithTheirNames()
    {
        await using Harness host = await ShopHost.StartAsync(CoversOrdersInvoicesAndMembers());

        CatalogDiagnostic report = Assert.Single(Uncovered(host));

        Assert.Contains("2 tool(s)", report.Message, StringComparison.Ordinal);
        Assert.Contains("admin_close_books", report.Message, StringComparison.Ordinal);
        Assert.Contains("list_gated", report.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("list_public", report.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("list_orders", report.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("list_balances", report.Message, StringComparison.Ordinal);
        (HashSet<string> names, _, _, _) = await SearchAsync(host.ToolsFor("manager"));
        Assert.NotEmpty(names);
    }

    [Fact]
    public async Task CV2_OnlyTheFirstTwentyNamesAreListed_AndTheRestCounted()
    {
        await using Harness host = await ShopHost.StartAsync(
            new RecordingAuthorizer(ShopHost.ManagerSeesAllClerkSeesTheirOwn, covers: _ => false),
            members: () =>
            [
                .. Enumerable.Range(0, 25).Select(index => new McpFamilyMember(
                    $"key-{index}",
                    $"member_{index:00}",
                    "A member.",
                    new System.Text.Json.Nodes.JsonObject
                    {
                        ["type"] = "object",
                        ["properties"] = new System.Text.Json.Nodes.JsonObject
                        {
                            ["q"] = new System.Text.Json.Nodes.JsonObject { ["type"] = "string" },
                        },
                    })),
            ]);

        CatalogDiagnostic report = Assert.Single(Uncovered(host));

        Assert.Contains("29 tool(s)", report.Message, StringComparison.Ordinal);
        Assert.Contains("member_15", report.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("member_16", report.Message, StringComparison.Ordinal);
        Assert.Contains("and 9 more", report.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CV3_FatalFailsTheCatalogWithTheCoverageCode()
    {
        await using Harness host = await ShopHost.StartAsync(
            CoversOrdersInvoicesAndMembers(),
            configure: options => options.Visibility.OnUncovered = UncoveredVisibility.Fatal);

        SezzleeCatalogException failure = await Assert.ThrowsAsync<SezzleeCatalogException>(
            async () => await SearchAsync(host.ToolsFor("manager")));

        Assert.Equal(Code, failure.Code);
    }

    [Fact]
    public async Task CV4_AProbeThatReachesEveryEndpoint_LeavesNothingUncovered()
    {
        await using Harness host = await ShopHost.StartAsync(
            CoversOrdersInvoicesAndMembers(),
            configure: options => options.Visibility.Tier = VisibilityTier.Probe);

        Assert.Empty(Uncovered(host));
    }

    [Fact]
    public async Task CV5_AHostWithNoAuthorizerIsNotReported_UnlessItAsksForFatal()
    {
        await using Harness quiet = await ShopHost.StartAsync();
        Assert.Empty(Uncovered(quiet));

        await using Harness strict = await ShopHost.StartAsync(
            configure: options => options.Visibility.OnUncovered = UncoveredVisibility.Fatal);
        Assert.Contains("6 tool(s)", Assert.Single(Uncovered(strict)).Message, StringComparison.Ordinal);
    }
}
