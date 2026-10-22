# Tell the agent what a tool returns

`load_tool` publishes an `outputSchema` when the endpoint declares a success body. With it, an agent can plan "fetch the order, take its `customerId`, fetch the customer" before it makes the first call.

## Declare the response type

TypeScript erases generics before the type reaches runtime, so the response type has to be declared.

```ts
@Get("orders/:id")
@McpTool({
  description: "Fetches one order by id.",
  responses: { 200: OrderResponse, 404: {} },
})
getOrder(@Param("id", ParseIntPipe) id: number): OrderResponse { ... }
```

Four forms are accepted per status code:

| Form                | Meaning                                                       |
| ------------------- | ------------------------------------------------------------- |
| `OrderResponse`     | a DTO class, read the same way a request body's class is read |
| `[OrderResponse]`   | a collection of it                                            |
| `{ schema: { … } }` | a JSON Schema used verbatim, for a shape no class can express |
| `{}`                | the status carries no body                                    |

A DTO class needs class-validator decorators, as a request DTO does. If you already annotate with `@nestjs/swagger`, `@ApiOkResponse({ type: OrderResponse })` is read as a fallback, and a sync handler with a plain class return type is the last resort. The `responses` declaration wins.

## What the agent gets

```json
{
  "name": "get_order",
  "inputSchema": {
    "type": "object",
    "properties": { "id": { "type": "integer" } },
    "...": "..."
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "integer" },
      "item": { "type": "string" },
      "quantity": { "type": "integer" },
      "owner": { "type": "string" }
    },
    "required": ["id", "item", "quantity", "owner"]
  }
}
```

- **One status wins.** `200`, `201`, `202` and `204` are tried in that order, then the lowest remaining `2xx`. Error statuses do not change `outputSchema`.
- **A non-object root is wrapped.** MCP requires an object root, so a list is published under a `result` property.
- **Read-only members survive.** A property your request schema drops because the caller cannot set it is exactly what a response is made of.

An endpoint that returns `204`, or declares no `2xx`, publishes no `outputSchema`. The key is absent, not empty.

:::details[Why outputSchema is not enforced]

`outputSchema` is published on `load_tool` only. It is not checked against what `invoke_tool` returns. `invoke_tool` is one fixed tool whose result shape changes per call, so a client cannot validate it against a static schema. Treat it as what the backend says it returns, the same status a Swagger document has.

Argument curation does not reach it either. Response fields are not arguments, so every variant of one operation publishes the same `outputSchema`.

:::
