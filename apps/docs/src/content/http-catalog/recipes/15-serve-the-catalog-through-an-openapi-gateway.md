# Serve the catalog through an OpenAPI gateway

Publish the tools your decorators declare as `x-sezzlee` extensions in your OpenAPI document, and
`@sezzlee/openapi-mcp` rebuilds the same catalog from it: the same names, hints, hidden arguments,
variants and family members. A backend whose document you cannot change gets the same result from
the gateway's configuration.

## Write the extensions into the document

`SezzleeCatalog` describes its current catalog as one `x-sezzlee` value per operation, keyed by
`METHOD /path`, and `annotateOpenApiDocument` writes those values into the document
`@nestjs/swagger` builds:

```ts
import { Logger } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { annotateOpenApiDocument, SezzleeCatalog } from "@sezzlee/sdk-nestjs";

const catalog = app.get(SezzleeCatalog);
const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
SwaggerModule.setup("openapi", app, document, {
  patchDocumentOnRequest: (_req, _res, built) => {
    const annotated = structuredClone(built);
    annotateOpenApiDocument(annotated, catalog.openApiExtensions());
    return annotated;
  },
});
await app.listen(3000);

const { undocumented } = annotateOpenApiDocument(structuredClone(document), catalog.openApiExtensions());
if (undocumented.length > 0) {
  Logger.warn(`Not in the OpenAPI document, so not on the gateway: ${undocumented.join(", ")}`);
}
```

`@nestjs/swagger` builds the document once and serves that copy, so the extensions are written in
`patchDocumentOnRequest`, on a fresh copy for every read. Call `setup` before `listen`: a route added
after the application initialized sits behind its 404 handler.

In the NestJS sample, `GET /orders/:id` is published with this extension, its schemas shortened:

```json
{
  "tool": true,
  "toolName": "get_order",
  "description": "Fetches one order by id.",
  "tags": ["Orders"],
  "publishedSchemas": true,
  "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { … } }],
  "responses": { "200": { "schema": { … } }, "404": {} }
}
```

The description, tags and schemas are the ones the SDK published. They replace the operation's own
`summary`, `description`, `tags` and schemas for the tool only, so the page `SwaggerModule.setup`
serves keeps what was written for its readers. The schemas are the SDK's because the two readers
differ even when both are right: class-validator's `@IsInt()` is an `integer` where
`@nestjs/swagger` writes `number`, and `@nestjs/swagger` marks a named `@Query()` required. The wire
form, how each parameter and the body are written, still comes from the document.
`publishedSchemas` tells the gateway to take those schemas as written instead of normalizing them as
the document's own, so a schema you declared keeps its `default` and its `allOf`.

An operation the SDK publishes but the document leaves out, such as a handler marked
`@ApiExcludeEndpoint()`, cannot reach the gateway; `report.undocumented` names it.

A curated operation also carries its renamed, re-described and hidden arguments, from
[Curate the arguments an agent sees](/docs/http-catalog/curate-the-arguments-an-agent-sees). A family
is published with its members, each carrying its dispatch key:

```json
{
  "tool": true,
  "family": {
    "parameter": "methodId",
    "members": [
      {
        "key": "3f2c9a1e-8b4d-4c6a-9e21-7d5b0c4a1f10",
        "name": "list_customer_balances",
        "description": "Lists customer balances, optionally above a minimum.",
        "requestBody": {
          "schema": {
            "type": "object",
            "properties": {
              "minBalance": {
                "type": "number",
                "description": "Lowest balance to include."
              }
            }
          }
        },
        "annotations": {
          "readOnlyHint": true
        }
      },
      {
        "key": "b27e5d04-61a3-4f8e-a0c9-2e8d7f13b5a6",
        "name": "list_delayed_orders",
        "description": "Lists orders delivered later than promised.",
        "requestBody": {
          "schema": {
            "type": "object",
            "properties": {
              "days": {
                "type": "integer",
                "minimum": 1
              }
            },
            "required": [
              "days"
            ]
          }
        },
        "annotations": {
          "readOnlyHint": true
        }
      },
      {
        "key": "e91b3c7f-0d2a-48e5-b6f4-5a1c9d8e2b07",
        "name": "assign_courier",
        "description": "Assigns a courier to an order.",
        "requestBody": {
          "schema": {
            "type": "object",
            "properties": {
              "orderNumber": {
                "type": "string"
              },
              "courierCode": {
                "type": "string"
              }
            },
            "required": [
              "orderNumber",
              "courierCode"
            ]
          }
        },
        "annotations": {
          "destructiveHint": true
        }
      }
    ]
  }
}
```

The mapping from each declaration to its field is in the
[OpenAPI ingestion spec](https://github.com/sezzlee/mcp/blob/main/packages/http/spec/openapi-ingestion.md#the-x-sezzlee-extension).

:::details[Why every published operation names its tool]

A generator writes no `operationId` for most handlers. Left to derive a name, the gateway would read
the route where the SDK read the handler, and `alpha_one` would become `get_host_alpha_one`. The
extension therefore carries the name the SDK published, prefix included, and the gateway uses it as
is.

:::

## Point the gateway at the document

```json
{
  "source": "http://127.0.0.1:3000/openapi-json",
  "reload": { "intervalSeconds": 30 },
  "selection": { "default": "exclude" }
}
```

Every operation of the document carries `tool: true` or `tool: false`: one the SDK did not publish,
such as its own MCP route, a handler it dropped or a refused family, is written `false`
(`report.excluded` lists the ones the catalog did not name). A second route of one handler, such as
`@Get([":id", "by-id/:id"])`, is written `tool: false` with `foldedInto` naming the route the tool
invokes, so the gateway indexes it as that tool's alternate route, as the SDK does. The gateway therefore publishes exactly
what the SDK publishes, whatever its `selection.default`. Because each read is annotated again, it
reflects the latest catalog, so members from `families.provide` reach the gateway on its next
reload.

:::details[What does not travel]

A gateway registers no value providers, so an argument hidden with `hidden.from(...)` arrives as a
`deferred` fill that the gateway refuses with `unknown_fill_source`. Only constants and omitted
values travel. Of visibility, only `anonymous: true` travels, written on an operation any caller may
make: a guard that declares `anonymous: "yes"` with no policy. A document says which credential a
call needs, never which caller may make it, so the gateway shows every other tool with
`authUncertain`. The marker changes no credential the gateway sends.

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

Both extensions are the NestJS sample's own catalog, printed with `openApiExtensions()`.
`sdks/nestjs/test/openapi-extension.spec.ts` annotates a `@nestjs/swagger` document the same way and
checks that the gateway rebuilds every tool from it. The `operations` block is the conformance
fixture `config-operations-overlay-document.json`.

:::
