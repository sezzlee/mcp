# Choose which endpoints become tools

Selection decides which endpoints enter the catalog at all. It is not visibility and not authorization: an unselected endpoint does not exist for any agent, for every caller.

The default is opt-in. With no annotations anywhere, `search_tools` returns nothing.

## Opt in a controller or a method

Mark the class and every endpoint on it comes through:

:::tabs

```csharp title="ASP.NET Core"
[ApiController]
[McpTool]
public sealed class OrdersController : ControllerBase { }
```

```ts title="NestJS"
@Controller()
@McpTool()
export class OrdersController {}
```

:::

Mark a method to bring in one endpoint from an unmarked class:

:::tabs

```csharp title="ASP.NET Core"
[HttpGet("/orders/{id:int}")]
[McpTool]
[Description("Fetches one order by id.")]
public IActionResult GetOrder(int id) => ...;
```

```ts title="NestJS"
@Get("orders/:id")
@McpTool({ description: "Fetches one order by id." })
getOrder(@Param("id", ParseIntPipe) id: number): Order { ... }
```

:::

On ASP.NET Core the description comes from the framework's own metadata: `[Description]`, XML doc comments or `EndpointDescriptionAttribute`. NestJS has no equivalent, which is why `@McpTool({ description })` exists.

## Opt out instead, for a large backend

Above a few dozen endpoints, flip the default and exclude the exceptions. Anything new is then published by default.

:::tabs

```csharp title="ASP.NET Core"
builder.Services.AddSezzlee(options =>
{
    options.Selection.Default = SelectionDefault.Include;
});
```

```ts title="NestJS"
SezzleeModule.forRoot((options) => {
  options.selection.default = "include";
});
```

:::

Then remove an endpoint or a whole controller:

:::tabs

```csharp title="ASP.NET Core"
[HttpPost("/internal/reindex")]
[McpIgnore]
public IActionResult Reindex() => ...;
```

```ts title="NestJS"
@Post("internal/reindex")
@McpIgnore()
reindex(): void {}
```

:::

## Withhold a route subtree from configuration

For a subtree that is categorically off limits, put the decision in configuration instead of an attribute:

:::tabs

```csharp title="ASP.NET Core"
builder.Services.AddSezzlee(options =>
{
    options.Selection.Default = SelectionDefault.Include;
    options.Selection.Rules.Add(new SelectionRule(SelectionDefault.Exclude, Route: "/admin/**"));
    options.Selection.Rules.Add(new SelectionRule(SelectionDefault.Exclude, Method: "POST"));
});
```

```ts title="NestJS"
SezzleeModule.forRoot((options) => {
  options.selection.default = "include";
  options.selection.rules = [
    { route: "/admin/**", decision: "exclude" },
    { method: "POST", decision: "exclude" },
  ];
});
```

:::

A rule matches the route template. `*` stays inside one path segment and `**` crosses them. Matching is case-sensitive, except for `method`. Leave a field out to match everything. A blank string is rejected at startup.

## Opt in a minimal API

A minimal-API endpoint has no class to decorate, so the marker goes on as metadata:

```csharp
app.MapGet("/health", () => Results.Ok(new { status = "healthy" }))
    .AllowAnonymous()
    .WithMetadata(
        new McpToolAttribute(),
        new EndpointDescriptionAttribute("Service health status; requires no identity."));
```

## Verify the result

Selection is reported at startup, before any agent connects:

```text
info: Sezzlee.AspNetCore.SezzleeCatalogProvider[0]
      sezzlee catalog: 16 discovered, 9 selected, 9 tools, 0 diagnostic(s)
```

`discovered` is what the framework knows about, `selected` is what survived selection, and `tools` is what became callable. A `selected` of `0` means no marker was found. A `tools` count below `selected` means endpoints were dropped afterwards: [Find out why a tool is missing](/docs/http-catalog/find-out-why-a-tool-is-missing).

Selection is global, not per caller. What differs per caller is [visibility](/docs/http-catalog/control-what-a-caller-can-see). Neither is a security boundary: an unselected endpoint is still reachable over plain HTTP by anyone your backend allows.

:::details[Which marker wins]

Decisions apply at four levels: the global default, the configured rules, the controller and the method. The most specific wins. A method marker beats a controller marker, which beats a rule, which beats the default. So `Selection.Default = Include` plus `[McpIgnore]` on a controller plus `[McpTool]` on one of its methods publishes exactly that one method.

Attributes outrank rules because an attribute sits on the endpoint and a rule sits in your startup file. Among rules, the one naming more fields is sharper.

Two conflicting markers at the same level are an error, not a resolution. The catalog fails with `ambiguous_selection`. That is why `/admin/**` excluded alongside `/admin/health` included is an error: both name one field, so neither is sharper. Carve the exception out with `[McpTool]` on the endpoint instead. The normative rules are in [`packages/http/spec/selection-hierarchy.md`](https://github.com/sezzlee/mcp/blob/main/packages/http/spec/selection-hierarchy.md).

`McpToolAttribute` implements the public `IMcpSelectionMetadata` interface. A host with its own convention can implement that interface on its own type.

:::
