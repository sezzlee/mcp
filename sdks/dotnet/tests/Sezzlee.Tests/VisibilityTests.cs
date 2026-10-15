using System.Text.Json;
using Microsoft.AspNetCore.TestHost;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Tools;
using static Sezzlee.Tests.VisibilityHost;

namespace Sezzlee.Tests;

public sealed class VisibilityTests
{
    [Fact]
    public async Task V1_AnonymousEndpoint_VisibleWithoutIdentity()
    {
        await using Harness host = await HostAsync();
        (HashSet<string> names, HashSet<string> uncertain, _, _) = await SearchAsync(host.ToolsFor(null));
        Assert.Contains("vis_anon", names);
        Assert.DoesNotContain("vis_anon", uncertain);
    }

    [Fact]
    public async Task V2_IdentityRequired_HiddenWithoutIdentity()
    {
        await using Harness host = await HostAsync();
        (HashSet<string> names, _, _, _) = await SearchAsync(host.ToolsFor(null));
        Assert.DoesNotContain("vis_bare", names);
        Assert.DoesNotContain("vis_claim", names);
        Assert.DoesNotContain("get_vis_minimal", names);
    }

    [Fact]
    public async Task V3_SameQuery_TwoIdentities_TwoLists()
    {
        await using Harness host = await HostAsync();
        (HashSet<string> alice, _, int aliceTotal, _) = await SearchAsync(host.ToolsFor(Mint("alice", ordersRead: true)));
        (HashSet<string> bob, _, int bobTotal, _) = await SearchAsync(host.ToolsFor(Mint("bob")));

        Assert.Contains("vis_claim", alice);
        Assert.Contains("get_vis_minimal", alice);
        Assert.DoesNotContain("vis_claim", bob);
        Assert.DoesNotContain("get_vis_minimal", bob);
        Assert.Contains("vis_bare", alice);
        Assert.Contains("vis_bare", bob);
        Assert.True(aliceTotal > bobTotal);
    }

    [Fact]
    public async Task V4_RoleRequirement_EvaluatedDeclaratively()
    {
        await using Harness host = await HostAsync();
        (HashSet<string> carol, HashSet<string> carolUncertain, _, _) = await SearchAsync(host.ToolsFor(Mint("carol", role: "admin")));
        (HashSet<string> alice, _, _, _) = await SearchAsync(host.ToolsFor(Mint("alice", ordersRead: true)));

        Assert.Contains("vis_role", carol);
        Assert.DoesNotContain("vis_role", carolUncertain);
        Assert.DoesNotContain("vis_role", alice);
    }

    [Fact]
    public async Task V5_ResourceOwnershipInsideHandler_VisibleButRejectedOnInvoke()
    {
        await using Harness host = await HostAsync();
        SezzleeMetaTools tools = host.ToolsFor(Mint("alice"));
        (HashSet<string> names, HashSet<string> uncertain, _, _) = await SearchAsync(tools);

        Assert.Contains("vis_mine", names);
        Assert.DoesNotContain("vis_mine", uncertain);
        Assert.Equal(200, await InvokeStatusAsync(tools, "vis_mine", new { id = 1 }));
        Assert.Equal(403, await InvokeStatusAsync(tools, "vis_mine", new { id = 2 }));
    }

    [Fact]
    public async Task V6_UndecidableRequirements_VisibleAndUncertain()
    {
        await using Harness host = await HostAsync();
        (HashSet<string> names, HashSet<string> uncertain, _, _) = await SearchAsync(host.ToolsFor(Mint("alice")));

        Assert.Contains("vis_assert", uncertain);
        Assert.Contains("vis_owner", uncertain);
        Assert.Contains("vis_filter", uncertain);
        Assert.DoesNotContain("vis_bare", uncertain);
        Assert.Subset(names, uncertain);
    }

    [Fact]
    public async Task V7_HiddenToolGuessedByName_PipelineRejects()
    {
        await using Harness host = await HostAsync();
        SezzleeMetaTools bob = host.ToolsFor(Mint("bob"));
        (HashSet<string> names, _, _, _) = await SearchAsync(bob);

        Assert.DoesNotContain("vis_claim", names);
        Assert.Equal(403, await InvokeStatusAsync(bob, "vis_claim", new { }));
        Assert.Equal(403, await InvokeStatusAsync(bob, "vis_filter", new { }));
    }

    [Fact]
    public async Task V8_VisibilityAndInvoke_ShareIdentityComposition()
    {
        await using Harness host = await HostAsync(configure: o => o.Identity.Clear());
        SezzleeMetaTools alice = host.ToolsFor(Mint("alice", ordersRead: true));
        (HashSet<string> names, _, _, _) = await SearchAsync(alice);

        Assert.DoesNotContain("vis_claim", names);
        Assert.Equal(401, await InvokeStatusAsync(alice, "vis_claim", new { }));
    }

    [Fact]
    public async Task V9_OnUnknownHide_DropsUncertainTools()
    {
        await using Harness host = await HostAsync(configure: o => o.Visibility.OnUnknown = UnknownVisibility.Hide);
        SezzleeMetaTools alice = host.ToolsFor(Mint("alice"));
        (HashSet<string> names, HashSet<string> uncertain, _, _) = await SearchAsync(alice);

        Assert.DoesNotContain("vis_assert", names);
        Assert.Empty(uncertain);
        Assert.Contains("unknown_tool", TextOf(await alice.LoadTool("vis_assert")));
    }

    [Fact]
    public async Task V10_PolicyNamesNeverReachTheAgent()
    {
        await using Harness host = await HostAsync();
        SezzleeMetaTools alice = host.ToolsFor(Mint("alice", ordersRead: true, role: "admin"));
        (_, _, _, string search) = await SearchAsync(alice);
        string loaded = TextOf(await alice.LoadTool("vis_claim"));

        foreach (string leak in (string[])["OrdersRead", "roles:", "policies", "imperative", "Assertion"])
        {
            Assert.DoesNotContain(leak, search);
            Assert.DoesNotContain(leak, loaded);
        }
    }

    [Fact]
    public async Task V11_LoadTool_HiddenIsIndistinguishableFromMissing()
    {
        await using Harness host = await HostAsync();
        SezzleeMetaTools bob = host.ToolsFor(Mint("bob"));

        CallToolResult hidden = await bob.LoadTool("vis_claim");
        CallToolResult missing = await bob.LoadTool("does_not_exist");
        Assert.Equal(TextOf(missing).Replace("does_not_exist", "x"), TextOf(hidden).Replace("vis_claim", "x"));
        Assert.True(hidden.IsError);
        Assert.True(missing.IsError);

        CallToolResult visible = await bob.LoadTool("vis_bare");
        Assert.Contains("\"name\":\"vis_bare\"", TextOf(visible));
        Assert.False(visible.IsError ?? false);
    }

    [Fact]
    public async Task V13_Probe_ResolvesImperativeFilterThroughMvcBackstop()
    {
        await using Harness host = await ProbeHostAsync();
        (HashSet<string> alice, HashSet<string> aliceUncertain, _, _) = await SearchAsync(host.ToolsFor(Mint("alice")));
        (HashSet<string> bob, _, _, _) = await SearchAsync(host.ToolsFor(Mint("bob")));

        Assert.Contains("vis_filter", alice);
        Assert.DoesNotContain("vis_filter", aliceUncertain);
        Assert.DoesNotContain("vis_filter", bob);
    }

    [Fact]
    public async Task V14_Probe_ResolvesUndecidableRequirementsThroughResultHandler()
    {
        await using Harness host = await ProbeHostAsync();
        (HashSet<string> names, HashSet<string> uncertain, _, _) = await SearchAsync(host.ToolsFor(Mint("alice")));

        Assert.Contains("vis_assert", names);
        Assert.DoesNotContain("vis_assert", uncertain);
        Assert.Contains("vis_owner", names);
        Assert.DoesNotContain("vis_owner", uncertain);
    }

    [Fact]
    public async Task V15_Probe_HasNoSideEffects()
    {
        await using Harness host = await ProbeHostAsync();
        SezzleeMetaTools alice = host.ToolsFor(Mint("alice"));
        int before = VisibilityController.SideEffects;

        (HashSet<string> names, HashSet<string> uncertain, _, _) = await SearchAsync(alice, "effect");
        Assert.Contains("vis_effect", names);
        Assert.DoesNotContain("vis_effect", uncertain);
        Assert.Equal(before, VisibilityController.SideEffects);

        Assert.Equal(200, await InvokeStatusAsync(alice, "vis_effect", new { }));
        Assert.Equal(before + 1, VisibilityController.SideEffects);
    }

    [Fact]
    public async Task V16_Probe_SkipsUnsafeNonMvcEndpoints()
    {
        await using Harness host = await ProbeHostAsync();
        (HashSet<string> names, HashSet<string> uncertain, _, _) = await SearchAsync(host.ToolsFor(Mint("alice")));

        Assert.Contains("post_vis_minimal_post", names);
        Assert.Contains("post_vis_minimal_post", uncertain);
    }

    [Fact]
    public async Task V17_ProbeFlag_CannotBeSetByRealRequests()
    {
        await using Harness host = await ProbeHostAsync();
        using HttpClient client = host.App.GetTestClient();
        using HttpRequestMessage request = new(System.Net.Http.HttpMethod.Get, "/vis/probeflag");
        request.Headers.TryAddWithoutValidation("sezzlee.probe", "true");
        request.Headers.TryAddWithoutValidation("X-Sezzlee-Probe", "1");
        request.Headers.TryAddWithoutValidation("sezzlee.synthetic", "true");
        request.Headers.TryAddWithoutValidation("User-Agent", "sezzlee/9.9.9");

        HttpResponseMessage response = await client.SendAsync(request);
        string body = await response.Content.ReadAsStringAsync();
        Assert.Contains("\"probe\":false", body);
        Assert.Contains("\"synthetic\":false", body);
    }

    [Fact]
    public async Task V22_UndeclaredEndpoint_IsUnknownNotAnonymous()
    {
        await using Harness host = await HostAsync();
        (HashSet<string> names, HashSet<string> uncertain, _, _) = await SearchAsync(host.ToolsFor(Mint("alice")));
        (HashSet<string> anonymous, HashSet<string> anonymousUncertain, _, _) = await SearchAsync(host.ToolsFor(null));

        Assert.Contains("vis_undeclared", names);
        Assert.Contains("vis_undeclared", uncertain);
        Assert.Contains("vis_undeclared", anonymous);
        Assert.Contains("vis_undeclared", anonymousUncertain);
        Assert.Contains("vis_anon", names);
        Assert.DoesNotContain("vis_anon", uncertain);
    }

    [Fact]
    public async Task V23_Probe_ResolvesUndeclaredEndpointFromMiddlewareVerdict()
    {
        await using Harness host = await ProbeHostAsync();
        (HashSet<string> identified, HashSet<string> identifiedUncertain, _, _) =
            await SearchAsync(host.ToolsFor(Mint("alice")));
        (HashSet<string> anonymous, _, _, _) = await SearchAsync(host.ToolsFor(null));

        Assert.Contains("vis_undeclared", identified);
        Assert.DoesNotContain("vis_undeclared", identifiedUncertain);
        Assert.DoesNotContain("vis_undeclared", anonymous);
    }

    [Fact]
    public async Task V21_Transport_ForwardsBearerOfEachSession()
    {
        await using Harness host = await HostAsync();
        string aliceToken = Mint("alice", ordersRead: true);
        string bobToken = Mint("bob");
        (HashSet<string> aliceExpected, _, _, _) = await SearchAsync(host.ToolsFor(aliceToken));
        (HashSet<string> bobExpected, _, _, _) = await SearchAsync(host.ToolsFor(bobToken));

        HashSet<string> alice = await SearchOverTransportAsync(host, aliceToken);
        HashSet<string> bob = await SearchOverTransportAsync(host, bobToken);

        Assert.Equal(aliceExpected, alice);
        Assert.Equal(bobExpected, bob);
        Assert.NotEqual(alice, bob);
    }

    private static async Task<HashSet<string>> SearchOverTransportAsync(Harness host, string token)
    {
        using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(30));
        using HttpClient http = host.App.GetTestClient();
        await using HttpClientTransport transport = new(
            new HttpClientTransportOptions
            {
                Endpoint = new Uri(http.BaseAddress!, "/mcp"),
                TransportMode = HttpTransportMode.StreamableHttp,
                EnableStandaloneGetStream = false,
                AdditionalHeaders = new Dictionary<string, string> { ["Authorization"] = $"Bearer {token}" },
            },
            http);
        await using McpClient client = await McpClient.CreateAsync(transport, cancellationToken: timeout.Token);

        CallToolResult result = await client.CallToolAsync(
            "search_tools",
            new Dictionary<string, object?> { ["query"] = "", ["limit"] = SezzleeMetaTools.MaxLimit },
            cancellationToken: timeout.Token);

        string raw = Assert.IsType<TextContentBlock>(Assert.Single(result.Content)).Text;
        using JsonDocument document = JsonDocument.Parse(raw);
        return document.RootElement.GetProperty("results").EnumerateArray()
            .Select(card => card.GetProperty("name").GetString()!)
            .ToHashSet(StringComparer.Ordinal);
    }

    [Fact]
    public async Task V18_Probe_ReadsCustomMiddlewareVerdictWithoutMarker()
    {
        await using Harness host = await ProbeHostAsync();
        (HashSet<string> closed, _, _, _) = await SearchAsync(host.ToolsFor(Mint("bob")));
        (HashSet<string> open, HashSet<string> openUncertain, _, _) =
            await SearchAsync(host.ToolsFor(Mint("bob"), ("X-Gate", "open")));

        Assert.DoesNotContain("vis_gated", closed);
        Assert.Contains("vis_gated", open);
        Assert.DoesNotContain("vis_gated", openUncertain);
    }

    [Fact]
    public async Task V19_MaxProbesPerSearchZero_LeavesEverythingUncertain()
    {
        await using Harness host = await ProbeHostAsync(o => o.Visibility.MaxProbesPerSearch = 0);
        (HashSet<string> names, HashSet<string> uncertain, _, _) = await SearchAsync(host.ToolsFor(Mint("alice")));

        Assert.Contains("vis_assert", names);
        Assert.Contains("vis_assert", uncertain);
        Assert.Contains("vis_filter", uncertain);
    }

    [Fact]
    public async Task V12_NoAuthenticationScheme_IdentityUnknown_EverythingUncertainNotHidden()
    {
        await using Harness host = await HostAsync(authentication: false);
        (HashSet<string> names, HashSet<string> uncertain, _, _) = await SearchAsync(host.ToolsFor(Mint("alice", ordersRead: true)));

        Assert.Contains("vis_bare", uncertain);
        Assert.Contains("vis_claim", uncertain);
        Assert.Contains("vis_anon", names);
        Assert.DoesNotContain("vis_anon", uncertain);
    }
}
