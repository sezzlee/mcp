# Expose a dispatching endpoint as one tool per method

Some backends route many capabilities through one endpoint, such as `POST /Rest/InvokeDynamicMethod/{methodId}`, where each `methodId` names a different method with a different body. A tool family publishes it as one tool per method, each with its own name, description, body schema and hints. The SDK writes the id into the route, so the agent never sees it.

Use a family when the id selects a capability: a different id means a different body and a different action. When the id selects a record, as in `GET /orders/{orderId}`, it is an ordinary argument and one tool is right.

## Declare the family

Mark the dispatch parameter and name the source the members come from. The endpoint still needs its selection marker.

:::tabs

```csharp title="ASP.NET Core"
[HttpPost("/Rest/InvokeDynamicMethod/{methodId}")]
[Authorize]
[McpTool(Description = "Invokes a server method by its id.")]
[McpToolFamily("methodId", Source = DemoDynamicMethods.Source)]
public IActionResult Invoke(string methodId, [FromBody] JsonElement body) =>
    DemoDynamicMethods.Find(methodId) is { } method
        ? Ok(new { methodId, method = method.Name, received = body })
        : NotFound();
```

```ts title="NestJS"
@Post("InvokeDynamicMethod/:methodId")
@HttpCode(200)
@McpTool({ description: "Invokes a server method by its id." })
@McpToolFamily({ parameter: "methodId", source: dynamicMethodsSource })
@UseGuards(JwtGuard)
invoke(
  @Param("methodId") methodId: string,
  @Body() body: Record<string, unknown>,
): unknown { ... }
```

:::

The endpoint's own body can stay opaque. Each member declares its own.

## Provide the members

A source returns one entry per method: the key the route expects, a tool name, a description, the body as JSON Schema, and optionally whether the method only reads or destroys data.

:::tabs

```csharp title="ASP.NET Core"
builder.Services.AddSezzlee(options =>
{
    options.Families.Provide(DemoDynamicMethods.Source, DemoDynamicMethods.LoadAsync);
});
```

```ts title="NestJS"
SezzleeModule.forRoot((options) => {
  options.families.provide(dynamicMethodsSource, () => dynamicMethods);
});
```

:::

One member looks like this:

:::tabs

```csharp title="ASP.NET Core"
new McpFamilyMember(
    Guid.Parse("e91b3c7f-0d2a-48e5-b6f4-5a1c9d8e2b07"),
    "assign_courier",
    "Assigns a courier to an order.",
    new JsonObject
    {
        ["type"] = "object",
        ["properties"] = new JsonObject
        {
            ["orderNumber"] = new JsonObject { ["type"] = "string" },
            ["courierCode"] = new JsonObject { ["type"] = "string" },
        },
        ["required"] = new JsonArray("orderNumber", "courierCode"),
    })
{
    Destructive = true,
},
```

```ts title="NestJS"
{
  key: "e91b3c7f-0d2a-48e5-b6f4-5a1c9d8e2b07",
  name: "assign_courier",
  description: "Assigns a courier to an order.",
  body: {
    type: "object",
    properties: {
      orderNumber: { type: "string" },
      courierCode: { type: "string" },
    },
    required: ["orderNumber", "courierCode"],
  },
  destructive: true,
},
```

:::

A source is usually a query against the table your backend already dispatches from. It runs once at startup and again on every reload, never per request, and every caller sees the same members. On ASP.NET Core the delegate gets an `IServiceProvider` from its own scope, so it can resolve a `DbContext`, and there is no `HttpContext`. On NestJS it runs in `onApplicationBootstrap` and receives an `AbortSignal` that fires at `options.families.loadTimeoutMs`. Write the description for the agent, because search ranks the member by it.

## Reload when the methods change

:::tabs

```csharp title="ASP.NET Core"
await app.Services.GetRequiredService<ISezzleeCatalogChangeSource>().ReloadAsync();
```

```ts title="NestJS"
await app.get(SezzleeCatalog).reload();
```

:::

A reload advances the catalog generation and sends `tools/list_changed`. It is refused, and the current catalog kept, when the new members would make the catalog fatal. If the source fails, the members it last returned stay published and `family_source_stale` is reported.

## See it work

Both demos carry the same three members. Drive one with the [agent-client](https://github.com/sezzlee/mcp/tree/main/sdks/nestjs/samples/agent-client):

```sh
SEZZLEE_AUTH=token SEZZLEE_USER=alice node sdks/nestjs/samples/agent-client/dist/main.js --scenario family
```

```text
step                                   ok    detail
search_tools "courier"                 ok    assign_courier
load_tool assign_courier               ok    {"properties":["orderNumber","courierCode"],"annotations":{"destructiveHint":true}}
invoke_tool assign_courier             ok    {"status":200,"body":{"methodId":"e91b3c7f-0d2a-48e5-b6f4-5a1c9d8e2b07","method":"assign_courier","received":{"orderNumber":"ORD-1001","courierCode":"COURIER-7"}}}
invoke_tool assign_courier + methodId  ok    {"error":"unknown_argument","message":"Unknown argument(s): methodId. Allowed: courierCode, orderNumber.","retryable":false}
search_tools <member key>              ok    0 results
```

Search found the member by its own description. Its schema carries only its own fields. The backend received the member's key. Sending `methodId` anyway was refused rather than routed to another method, and the key is not a search term.

A family does not authorize per method. Every member shares the endpoint's authorization and visibility, and whether a caller may run a method is your dispatcher's decision. Every caller sees the same members. The route still contains `methodId`, so a search for "method" matches all of them. The normative rules are in [tool-families.md](https://github.com/sezzlee/mcp/blob/main/packages/http/spec/tool-families.md).

:::details[If a member is missing]

Look for these codes in the startup log, using [Find out why a tool is missing](/docs/http-catalog/find-out-why-a-tool-is-missing):

- `family_member_rejected`: one member was dropped. Its name does not match the tool-name pattern, its description is empty, its name or key repeats another's, or its body schema references outside its own `$defs`. The rest of the family is kept.
- `unknown_family_source` and `family_source_failed`: no member was published. The source is not registered, or it failed before it returned.
- `name_collision`: a member has the name of another tool. This one is fatal.

:::
