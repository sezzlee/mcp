using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Discovery;

namespace Sezzlee.Tests;

public sealed class DescriptionRuleHostTests : InvokeHost
{
    [ApiController]
    [Route("/described")]
    public sealed class DescribedController : ControllerBase
    {
        [HttpGet("declared")]
        [McpTool(Name = "declared_tool", Description = "Declared on the tool.")]
        public IActionResult Declared() => Ok();

        [HttpGet("metadata")]
        [McpTool(Name = "metadata_tool")]
        [EndpointDescription("From metadata.")]
        public IActionResult WithMetadata() => Ok();

        [HttpGet("kept")]
        [McpTool(Name = "kept_tool")]
        [EndpointDescription("Kept as declared.")]
        public IActionResult Kept() => Ok();

        [HttpGet("bare")]
        [McpTool(Name = "bare_tool")]
        public IActionResult Bare() => Ok();
    }

    protected override Type[] Controllers => [typeof(DescribedController)];

    protected override void Configure(IMvcBuilder mvc) =>
        mvc.Services.Configure<SezzleeOptions>(options => options.Description = endpoint => endpoint.Action?.Name switch
        {
            nameof(DescribedController.Kept) => null,
            nameof(DescribedController.Bare) => $"Documented {endpoint.Method} {endpoint.Route}.",
            _ => $"{endpoint.Declared} Documented.",
        });

    [Theory]
    [InlineData("declared_tool", "Declared on the tool.")]
    [InlineData("metadata_tool", "From metadata. Documented.")]
    [InlineData("kept_tool", "Kept as declared.")]
    [InlineData("bare_tool", "Documented GET /described/bare.")]
    public void DR1_TheRuleSitsBelowTheToolDeclaration_AndSeesTheMetadataDescription(string tool, string expected)
    {
        SezzleeCatalogProvider catalog = Services.GetRequiredService<SezzleeCatalogProvider>();

        Assert.Equal(expected, catalog.Find(tool)!.Tool.Description);
    }
}
