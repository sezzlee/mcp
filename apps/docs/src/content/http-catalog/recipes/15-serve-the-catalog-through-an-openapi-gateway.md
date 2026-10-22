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
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { annotateOpenApiDocument, SezzleeCatalog } from "@sezzlee/sdk-nestjs";

const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
annotateOpenApiDocument(document, app.get(SezzleeCatalog).openApiExtensions());
SwaggerModule.setup("openapi", app, document);
```

In the NestJS sample, `GET /orders/:id` is published with this extension:

```json
{"tool": true, "toolName": "get_order"}
```

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

Every operation the SDK knows of carries `tool: true` or `tool: false`, so the gateway publishes
exactly what the SDK publishes, a refused family included. Keep `selection.default` at `exclude`: an
operation outside the SDK's discovery carries no marker, and the default decides it. Each read of
the document reflects the latest catalog, so members from `families.provide` reach the gateway on
its next reload.

:::details[What does not travel]

A gateway registers no value providers, so an argument hidden with `hidden.from(...)` arrives as a
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

Both extensions are the NestJS sample's own catalog, printed with `openApiExtensions()`.
`sdks/nestjs/test/openapi-extension.spec.ts` annotates a `@nestjs/swagger` document the same way and
checks that the gateway rebuilds every tool from it. The `operations` block is the conformance
fixture `config-operations-overlay-document.json`.

:::
