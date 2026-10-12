#if NET10_0_OR_GREATER
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using System.Reflection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.OpenApi;
using Sezzlee.AspNetCore;
using Sezzlee.AspNetCore.Discovery;

namespace Sezzlee.Tests;

/// <summary>
/// Writes the SDK's descriptors and tools, ASP.NET's own OpenAPI document for the same controllers,
/// and that document annotated with the SDK's x-sezzlee extensions, so the OpenAPI ingestion and
/// the gateway built from the annotated document can be compared with framework discovery on one
/// backend. Runs only when
/// SEZZLEE_PARITY_DIR names the output directory; the comparison itself is
/// packages/servers/openapi-mcp/test/parity.spec.ts.
/// </summary>
public sealed class OpenApiParityDump
{
    private sealed class CuratedControllers : IApplicationFeatureProvider<ControllerFeature>
    {
        public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature)
        {
            TypeInfo controller = typeof(CuratedController).GetTypeInfo();
            if (!feature.Controllers.Contains(controller))
            {
                feature.Controllers.Add(controller);
            }
        }
    }

    [ApiController]
    [Route("/parity")]
    public sealed class CuratedController : ControllerBase
    {
        [HttpGet("orders/{orderId}")]
        [McpTool(Name = "read_parity_order", ReadOnly = true)]
        [McpArgument("orderId", Name = "id", Description = "The order number.")]
        [McpArgument("tenant", Hidden = true, Value = "acme")]
        public IActionResult Read(int orderId, [FromQuery] string? tenant, [FromQuery] bool? verbose) => Ok();

        [HttpPost("reports")]
        [McpTool]
        [McpToolVariant("parity_sales_csv", "Runs the sales report as CSV.")]
        [McpToolVariant("parity_sales", "Runs the sales report in a chosen format.")]
        [McpArgument("format", Variant = "parity_sales_csv", Hidden = true, Value = "csv")]
        public IActionResult Report([FromQuery] string? format) => Ok();

        [HttpPost("methods/{methodId}")]
        [McpTool]
        [McpToolFamily("methodId")]
        [McpToolVariant("parity_run_alpha", "Runs the alpha method.")]
        [McpToolVariant("parity_run_beta", "Runs the beta method.")]
        [McpArgument("methodId", Variant = "parity_run_alpha", Hidden = true, Value = "alpha")]
        [McpArgument("methodId", Variant = "parity_run_beta", Hidden = true, Value = "beta")]
        public IActionResult Run(string methodId) => Ok();

        [HttpPost("dynamic/{methodId}")]
        [McpTool]
        [McpToolFamily("methodId", Source = "parity-methods")]
        public IActionResult Dynamic(long methodId, [FromBody] JsonElement body) => Ok();
    }

    private static readonly JsonSerializerOptions Neutral = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
        WriteIndented = true,
    };

    [Fact]
    public async Task Dump()
    {
        string? directory = Environment.GetEnvironmentVariable("SEZZLEE_PARITY_DIR");
        if (string.IsNullOrEmpty(directory))
        {
            return;
        }

        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Services.AddControllers()
            .AddApplicationPart(typeof(SchemaHost).Assembly)
            .ConfigureApplicationPartManager(manager => manager.FeatureProviders.Add(new CuratedControllers()));
        builder.Services.AddOpenApi();
        builder.Services.AddOpenApi("sezzlee", options => options.AddDocumentTransformer((document, context, _) =>
        {
            SezzleeOpenApiSnapshot sezzlee =
                context.ApplicationServices.GetRequiredService<SezzleeOpenApiExtensions>().Current;
            foreach ((string path, IOpenApiPathItem item) in document.Paths)
            {
                foreach ((HttpMethod method, OpenApiOperation operation) in item.Operations ?? [])
                {
                    if (sezzlee.Operations.TryGetValue($"{method.Method} {path}", out JsonObject? extension))
                    {
                        operation.Extensions ??= new Dictionary<string, IOpenApiExtension>();
                        operation.Extensions[SezzleeOpenApiSnapshot.Key] = new JsonNodeExtension(extension.DeepClone());
                    }
                }
            }
            return Task.CompletedTask;
        }));
        builder.Services.AddSezzlee(options =>
        {
            options.Selection.Default = SelectionDefault.Include;
            options.Families.Provide("parity-methods", (_, _) =>
                ValueTask.FromResult<IReadOnlyList<McpFamilyMember>>(
                [
                    new McpFamilyMember(
                        7L,
                        "parity_list_balances",
                        "Lists customer balances.",
                        new JsonObject
                        {
                            ["type"] = "object",
                            ["properties"] = new JsonObject { ["minBalance"] = new JsonObject { ["type"] = "number" } },
                        })
                    {
                        ReadOnly = true,
                    },
                ]));
        });

        await using WebApplication app = builder.Build();
        app.UseSezzleeCapture();
        app.UseRouting();
        app.MapControllers();
        app.MapOpenApi();
        app.MapSezzlee("/mcp");
        await app.StartAsync();
        await app.Services.GetRequiredService<SezzleeCatalogProvider>().ReloadAsync();

        string document = await app.GetTestClient().GetStringAsync("/openapi/v1.json");
        SezzleeCatalogProvider catalog = app.Services.GetRequiredService<SezzleeCatalogProvider>();
        var descriptors = catalog.Result.Entries
            .Select(entry => new { tool = entry.Tool.Name, descriptor = entry.Descriptor, definition = entry.Tool })
            .ToList();
        string annotated = await app.GetTestClient().GetStringAsync("/openapi/sezzlee.json");

        Directory.CreateDirectory(directory);
        await File.WriteAllTextAsync(Path.Combine(directory, "openapi.json"), document);
        await File.WriteAllTextAsync(
            Path.Combine(directory, "openapi.sezzlee.json"),
            annotated);
        await File.WriteAllTextAsync(
            Path.Combine(directory, "sdk-descriptors.json"),
            JsonSerializer.Serialize(descriptors, Neutral));
    }
}
#endif
