# Serve the catalog through an OpenAPI gateway

Publish the tools your attributes or decorators declare as `x-sezzlee` extensions in your OpenAPI
document, and `@sezzlee/openapi-mcp` rebuilds the same catalog from it: the same names, hints,
hidden arguments, variants and family members. A backend whose document you cannot change gets the
same result from the gateway's configuration.

## Write the extensions into the document

Each SDK describes its current catalog as one `x-sezzlee` value per operation, keyed by
`METHOD /path`, and you write those values into the document your framework generates:

:::tabs

```csharp title="ASP.NET Core (.NET 10 OpenAPI)"
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
```

```csharp title="ASP.NET Core (Swashbuckle 6)"
builder.Services.AddSwaggerGen(options => options.DocumentFilter<SezzleeDocumentFilter>());

public sealed class SezzleeDocumentFilter(SezzleeOpenApiExtensions sezzlee) : IDocumentFilter
{
    public void Apply(OpenApiDocument document, DocumentFilterContext context)
    {
        SezzleeOpenApiSnapshot current = sezzlee.Current;
        foreach ((string path, OpenApiPathItem item) in document.Paths)
        {
            foreach ((OperationType type, OpenApiOperation operation) in item.Operations)
            {
                if (current.Operations.TryGetValue($"{type.ToString().ToUpperInvariant()} {path}", out JsonObject? extension))
                {
                    operation.Extensions[SezzleeOpenApiSnapshot.Key] = SezzleeOpenApiAny.From(extension);
                }
            }
        }
    }
}

public static class SezzleeOpenApiAny
{
    public static IOpenApiAny From(JsonNode? node) => node switch
    {
        JsonObject json => json.Aggregate(new OpenApiObject(), (target, member) =>
        {
            target[member.Key] = From(member.Value);
            return target;
        }),
        JsonArray json => json.Aggregate(new OpenApiArray(), (target, item) =>
        {
            target.Add(From(item));
            return target;
        }),
        JsonValue value when value.TryGetValue(out bool flag) => new OpenApiBoolean(flag),
        JsonValue value when value.TryGetValue(out long number) => new OpenApiLong(number),
        JsonValue value when value.TryGetValue(out double number) => new OpenApiDouble(number),
        JsonValue value => new OpenApiString(value.GetValue<string>()),
        null => new OpenApiNull(),
    };
}
```

```ts title="NestJS"
const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
annotateOpenApiDocument(document, app.get(SezzleeCatalog).openApiExtensions());
```

:::

Swashbuckle 6 builds on Microsoft.OpenApi 1, whose extension values are `IOpenApiAny` trees rather
than JSON, so its filter converts each value first.

This action, curated with the attributes from
[Curate the arguments an agent sees](/docs/http-catalog/curate-the-arguments-an-agent-sees):

```csharp
[HttpGet("orders/{orderId}")]
[McpTool(Name = "read_parity_order", ReadOnly = true)]
[McpArgument("orderId", Name = "id", Description = "The order number.")]
[McpArgument("tenant", Hidden = true, Value = "acme")]
public IActionResult Read(int orderId, [FromQuery] string? tenant, [FromQuery] bool? verbose) => Ok();
```

is published with this extension:

```json
{
  "tool": true,
  "toolName": "read_parity_order",
  "annotations": { "readOnlyHint": true },
  "arguments": [
    { "name": "orderId", "as": "id", "description": "The order number." },
    { "name": "tenant", "hidden": { "kind": "constant", "value": "acme" } }
  ]
}
```

A family is published with its members, each carrying its dispatch key:

```json
{
  "tool": true,
  "family": {
    "parameter": "methodId",
    "members": [
      { "key": "alpha", "name": "parity_run_alpha", "description": "Runs the alpha method." },
      { "key": "beta", "name": "parity_run_beta", "description": "Runs the beta method." }
    ]
  }
}
```

The mapping from each attribute to its field is in the
[OpenAPI ingestion spec](https://github.com/sezzlee/mcp/blob/main/packages/http/spec/openapi-ingestion.md#the-x-sezzlee-extension).

:::details[Why every published operation names its tool]

A generator writes no `operationId` for most actions. Left to derive a name, the gateway would read
the route where the SDK read the action, and `alpha_one` would become `get_host_alpha_one`. The
extension therefore carries the name the SDK published, prefix included, and the gateway uses it as
is.

:::

## Point the gateway at the document

```json
{
  "source": "http://127.0.0.1:5178/openapi/sezzlee.json",
  "reload": { "intervalSeconds": 30 },
  "selection": { "default": "exclude" }
}
```

Every operation the SDK knows of carries `tool: true` or `tool: false`, so the gateway publishes
exactly what the SDK publishes, a refused family included. Keep `selection.default` at `exclude`: an
operation outside the SDK's discovery carries no marker, and the default decides it. Each read of
the document reflects the latest catalog, so members from `Families.Provide` reach the gateway on
its next reload.

:::details[What does not travel]

A gateway registers no value providers, so an argument hidden with `ValueFrom` arrives as a
`deferred` fill that the gateway refuses with `unknown_fill_source`. Only constants and omitted
values travel. Visibility does not travel either: a document says which credential a call needs,
never which caller may make it, so the gateway shows every tool with `authUncertain`.

:::

## Curate a document you cannot change

Declare the same fields under `operations` in the gateway configuration, keyed by method and path
as the document writes them. Each field replaces the document's own:

```json
{
  "operations": {
    "POST /api/orders": {
      "toolName": "place_order",
      "searchTerms": ["order"],
      "variants": [
        {
          "name": "place_order_for_item",
          "description": "Places an order for one item.",
          "requestBody": {
            "schema": { "$ref": "#/components/schemas/NewOrder" },
            "required": true
          }
        }
      ]
    },
    "GET /api/health": { "tool": false }
  }
}
```

A body schema here may reference the document's components. Every value it replaces is reported as
`extension_overridden`, and a key that names no operation stops the gateway with
`extension_target_unknown`, so a misspelled path cannot leave an operation published that you meant
to hide.

:::details[Where these examples come from]

The .NET 10 transformer and both extensions are the .NET SDK's parity test
(`sdks/dotnet/tests/Sezzlee.Tests/OpenApiParityDump.cs`), whose output
`packages/servers/openapi-mcp/test/parity.spec.ts` rebuilds through the gateway. The NestJS lines are
`sdks/nestjs/test/openapi-extension.spec.ts`, which runs the same rebuild. The Swashbuckle filter was
run on .NET 8 with Swashbuckle.AspNetCore 6.5.0 against a family and a curated action, and the
gateway published the same tools from its document; that run is not part of the repository's tests.
The `operations` block is the conformance fixture `config-operations-overlay-document.json`.

:::
