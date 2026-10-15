using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Discovery;

namespace Sezzlee.Tests;

public sealed class VocabularyControllers
{
    [ApiController]
    [Route("/v")]
    public sealed class Items : ControllerBase
    {
        [HttpGet("declared")]
        [McpTool(Name = "declared_item", Description = "Declares its own.", Tags = new[] { "declared" }, SearchTerms = new[] { "alpha" })]
        public IActionResult Declared() => Ok();

        [HttpGet("hooked")]
        [McpTool(Name = "hooked_item", Description = "Takes the endpoint hook.")]
        public IActionResult Hooked() => Ok();

        [HttpGet("deferred")]
        [McpTool(Name = "deferred_item", Description = "Falls to the container rule.")]
        public IActionResult Deferred() => Ok();

        [HttpGet("duplicated")]
        [McpTool(Name = "duplicated_item", Description = "Hook returns tags that fold alike.")]
        public IActionResult Duplicated() => Ok();
    }

    [ApiController]
    [Route("/plain")]
    public sealed class Plain : ControllerBase
    {
        [HttpGet("one")]
        [McpTool(Name = "plain_item", Description = "Nothing decides for it.")]
        public IActionResult One() => Ok();
    }
}

public sealed class EndpointVocabularyHostTests
{
    private static async Task<(Harness Host, SezzleeCatalogProvider Catalog, List<McpEndpointInfo> Seen)> StartAsync()
    {
        List<McpEndpointInfo> seen = [];
        Harness host = await ShopHost.StartAsync(
            controllers: [typeof(VocabularyControllers.Items), typeof(VocabularyControllers.Plain)],
            configure: options =>
            {
                options.EndpointTags = info =>
                {
                    lock (seen)
                    {
                        seen.Add(info);
                    }
                    return info.Route switch
                    {
                        "/v/declared" or "/v/hooked" => ["hook-tag"],
                        "/v/duplicated" => ["Dup", "dup"],
                        _ => null,
                    };
                };
                options.EndpointSearchTerms = info => info.Route switch
                {
                    "/v/declared" => ["ignored"],
                    "/v/hooked" => ["zebra"],
                    _ => null,
                };
                options.Tags = container => container.EndsWith(nameof(VocabularyControllers.Items), StringComparison.Ordinal)
                    ? ["container-tag"]
                    : null;
                options.SearchTerms = container => container.EndsWith(nameof(VocabularyControllers.Items), StringComparison.Ordinal)
                    ? ["giraffe"]
                    : null;
            });
        return (host, host.App.Services.GetRequiredService<SezzleeCatalogProvider>(), seen);
    }

    [Fact]
    public async Task EV1_TagsAreTakenFromTheDeclaration_ThenTheEndpointHook_ThenTheContainerRule_ThenTheContainerName()
    {
        (Harness host, SezzleeCatalogProvider catalog, _) = await StartAsync();
        await using Harness running = host;

        Assert.Equal(["declared"], catalog.Find("declared_item")!.Descriptor.Tags);
        Assert.Equal(["hook-tag"], catalog.Find("hooked_item")!.Descriptor.Tags);
        Assert.Equal(["container-tag"], catalog.Find("deferred_item")!.Descriptor.Tags);
        Assert.Equal(["Plain"], catalog.Find("plain_item")!.Descriptor.Tags);
    }

    [Fact]
    public async Task EV2_SearchTermsAreTakenFromTheDeclaration_ThenTheEndpointHook_ThenTheContainerRule()
    {
        (Harness host, SezzleeCatalogProvider catalog, _) = await StartAsync();
        await using Harness running = host;

        Assert.Equal(["alpha"], catalog.Find("declared_item")!.Descriptor.SearchTerms);
        Assert.Equal(["zebra"], catalog.Find("hooked_item")!.Descriptor.SearchTerms);
        Assert.Equal(["giraffe"], catalog.Find("deferred_item")!.Descriptor.SearchTerms);
        Assert.Null(catalog.Find("plain_item")!.Descriptor.SearchTerms);
        Assert.Equal("hooked_item", catalog.Search("zebra", 5).Single().Tool.Name);
    }

    [Fact]
    public async Task EV3_HookResultsAreCleanedAndReportedLikeADeclaration()
    {
        (Harness host, SezzleeCatalogProvider catalog, _) = await StartAsync();
        await using Harness running = host;

        Assert.Equal(["Dup"], catalog.Find("duplicated_item")!.Descriptor.Tags);
        Assert.Contains(catalog.Result.Diagnostics, d => d.Code == DiagnosticCodes.DuplicateTag);
    }

    [Fact]
    public async Task EV4_TheHookSeesTheEndpointItDecidesFor()
    {
        (Harness host, _, List<McpEndpointInfo> seen) = await StartAsync();
        await using Harness running = host;

        McpEndpointInfo hooked = seen.Single(info => info.Route == "/v/hooked");

        Assert.Equal("GET", hooked.Method);
        Assert.Equal(typeof(VocabularyControllers.Items).FullName, hooked.Container);
        Assert.Equal(nameof(VocabularyControllers.Items.Hooked), hooked.Action?.Name);
    }
}
