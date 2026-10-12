using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Discovery;
using Sezzlee.AspNetCore.Spec;

namespace Sezzlee.Tests;

[ApiController]
[Route("/revised")]
[McpTool(Revision = 4)]
public sealed class RevisedOrdersController : ControllerBase
{
    [HttpGet("list")]
    [McpTool(Name = "list_revised")]
    public IActionResult List() => Ok();

    [HttpGet("cancel")]
    [McpTool(Name = "cancel_revised", Revision = 2)]
    public IActionResult Cancel() => Ok();
}

/// <remarks>
/// The twin of "revision declaration" in sdks/nestjs/test/revision.spec.ts. The invalid
/// declaration is a minimal API for the reason <see cref="TagDeclarationHostTests"/> gives.
/// </remarks>
public sealed class RevisionHostTests : IAsyncLifetime
{
    private WebApplication _app = null!;
    private SezzleeCatalogProvider _catalog = null!;

    public async Task InitializeAsync()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Services.AddControllers().AddApplicationPart(typeof(RevisionHostTests).Assembly);
        builder.Services.AddSezzlee(options =>
        {
            options.Revision = 7;
            options.ContainerRevision = container =>
                container.EndsWith(nameof(TagsUndeclaredController), StringComparison.Ordinal)
                || container.EndsWith(nameof(RevisedOrdersController), StringComparison.Ordinal)
                    ? 9
                    : null;
        });

        _app = builder.Build();
        _app.UseSezzleeCapture();
        _app.UseRouting();
        _app.MapControllers();
        _app.MapGet("/revision/invalid", () => "ok")
            .WithMetadata(new McpToolAttribute { Name = "invalid_revision_rows", Revision = -1 });
        _app.MapSezzlee("/mcp");
        await _app.StartAsync();

        _catalog = _app.Services.GetRequiredService<SezzleeCatalogProvider>();
    }

    public async Task DisposeAsync() => await _app.DisposeAsync();

    private Revision? RevisionOf(string name) => _catalog.Find(name)?.Tool.Revision;

    [Fact]
    public void R1_LevelsAreCarriedApartInsteadOfTheMethodReplacingTheController()
    {
        Assert.Equal(new Revision { Catalog = 7, Container = 4, Operation = 2 }, RevisionOf("cancel_revised"));
        Assert.Equal(new Revision { Catalog = 7, Container = 4 }, RevisionOf("list_revised"));
    }

    [Fact]
    public void R2_HostRuleAppliesToAContainerWithoutADeclaration()
    {
        Assert.Equal(new Revision { Catalog = 7, Container = 9 }, RevisionOf("undeclared_tags"));
    }

    [Fact]
    public void R3_HostRuleHiddenByAControllerDeclarationIsReported()
    {
        Assert.Equal(
            2,
            _catalog.Result.Diagnostics.Count(d =>
                d.Code == DiagnosticCodes.RevisionOverridden
                && d.Message.Contains(nameof(RevisedOrdersController), StringComparison.Ordinal)));
    }

    [Fact]
    public void R4_RevisionBelowOneIsIgnoredAndReported()
    {
        Assert.Equal(new Revision { Catalog = 7 }, RevisionOf("invalid_revision_rows"));
        Assert.Contains(_catalog.Result.Diagnostics, d => d.Code == DiagnosticCodes.InvalidRevision);
    }
}
