using Microsoft.Extensions.DependencyInjection;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Discovery;
using static Sezzlee.Tests.VisibilityHost;

namespace Sezzlee.Tests;

public sealed class CatalogReloaderHostTests
{
    [Fact]
    public async Task RL1_TheReloaderIsRegistered_AndAReloadPublishesMembersAddedSinceTheLastLoad()
    {
        IReadOnlyList<McpFamilyMember> published = ShopHost.DefaultMembers();
        await using Harness host = await ShopHost.StartAsync(members: () => published);
        (HashSet<string> before, _, _, _) = await SearchAsync(host.ToolsFor("clerk"));
        Assert.DoesNotContain("list_payslips", before);

        published =
        [
            .. ShopHost.DefaultMembers(),
            new McpFamilyMember(
                "k-payslips",
                "list_payslips",
                "Lists payslips.",
                new System.Text.Json.Nodes.JsonObject
                {
                    ["type"] = "object",
                    ["properties"] = new System.Text.Json.Nodes.JsonObject
                    {
                        ["month"] = new System.Text.Json.Nodes.JsonObject { ["type"] = "string" },
                    },
                }),
        ];
        await host.App.Services.GetRequiredService<ISezzleeCatalogChangeSource>().ReloadAsync();

        (HashSet<string> after, _, _, _) = await SearchAsync(host.ToolsFor("clerk"));
        Assert.Contains("list_payslips", after);
    }
}
