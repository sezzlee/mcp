# Curate the arguments an agent sees

Your DTO was written for HTTP clients, so handed to an agent unchanged it exposes arguments the agent cannot know or should not touch. Curation declares a different agent-facing surface over the same endpoint. You can rename an argument, re-describe it, or hide it and supply the value yourself.

## Rename and re-describe

:::tabs

```csharp title="ASP.NET Core"
[HttpGet("orders")]
[McpTool(Description = "Search orders by keyword.")]
[McpArgument("q", Name = "keyword", Description = "Free-text search over item names.")]
[McpArgument("lim", Name = "max_results")]
public IActionResult List([FromQuery] ListOrdersQuery query) => ...;
```

```ts title="NestJS"
@Get("orders")
@McpTool({
  description: "Search orders by keyword.",
  arguments: curate<ListOrdersQuery>({
    q: { as: "keyword", description: "Free-text search over item names." },
    lim: { as: "max_results" },
  }),
})
list(@Query() query: ListOrdersQuery) { ... }
```

:::

The agent now sends `keyword` and `max_results`. The request still goes out as `?q=…&lim=…`. Curation changes what the agent sends, never what reaches your backend. Sending the old name is an `unknown_argument` error, so the agent cannot route around the rename.

On NestJS, `curate<T>()` is optional. With it, a name that is not a key of your DTO fails to compile.

## Hide an argument

There are three ways, and the difference matters.

| You want                           | Use              |
| ---------------------------------- | ---------------- |
| A fixed value on every call        | a constant       |
| A value from the caller's token    | a named provider |
| The backend's own default to stand | omit it          |

:::tabs

```csharp title="ASP.NET Core"
[McpArgument("tenantId", Hidden = true, ValueFrom = "tenant")]
[McpArgument("fq", Hidden = true, Value = "status:active")]
[McpArgument("includeDeleted", Hidden = true)]
```

```ts title="NestJS"
arguments: curate<ListOrdersQuery>({
  tenantId: hidden.from("tenant"),
  fq: hidden.value("status:active"),
  includeDeleted: hidden.omit(),
});
```

:::

A constant overrides whatever default your backend would apply. Omitting sends nothing at all. A required argument cannot be omitted, because the backend would reject every call. That is a startup error.

Register a provider once, and every endpoint that names the source uses it:

:::tabs

```csharp title="ASP.NET Core"
builder.Services.AddSezzlee(options =>
{
    options.Arguments.Provide("tenant", (caller, _) =>
        ValueTask.FromResult<JsonNode?>(JsonValue.Create(caller.Claim("tenant_id"))));
});
```

```ts title="NestJS"
SezzleeModule.forRoot((options) => {
  options.arguments.provide("tenant", (caller) => caller.claim("tenant_id"));
});
```

:::

A source with no registered provider is a startup error. This is not a security boundary. Filling `tenantId` from a verified token does not isolate tenants, and your backend's own authorization still decides.

Endpoints you cannot decorate can be curated from options. The normative rules are in `packages/http/spec/argument-curation.md`.

## Keep the description honest

Hiding `tenantId` makes a description that says "filter by tenant and status" a lie. When a tool's name or description still contains the wire name of a hidden or renamed argument, the SDK reports `curation_leaks_name`. A description you write on a curated argument is checked too, as `curation_leaks_name_in_argument`. The check is heuristic, so it is a warning: read it, then fix the sentence or ignore that one.

## Produce several tools from one endpoint

When one endpoint serves two jobs, declare a variant per job. Each variant names and describes itself.

:::tabs

```csharp title="ASP.NET Core"
[McpToolVariant("list_open_orders", "Lists orders that are still open.")]
[McpArgument("status", Hidden = true, Value = "open", Variant = "list_open_orders")]
[McpToolVariant("list_archived_orders", "Lists archived orders.")]
[McpArgument("status", Hidden = true, Value = "archived", Variant = "list_archived_orders")]
public IActionResult Search([FromQuery] SearchQuery query) => ...;
```

```ts title="NestJS"
@McpVariant({
  name: "list_open_orders",
  description: "Lists orders that are still open.",
  arguments: { status: hidden.value("open") },
})
@McpVariant({
  name: "list_archived_orders",
  description: "Lists archived orders.",
  arguments: { status: hidden.value("archived") },
})
search(@Query() query: SearchQuery) { ... }
```

:::

A method that declares variants produces only its variants. Variant names are absolute, so a collision is fatal at startup. Variants share the endpoint's authorization, so a narrow variant is not a narrower permission. Make the first clause of each description different, because the search card truncates at 160 characters. When the variants come from data, declare a family: [Expose a dispatching endpoint as one tool per method](/docs/http-catalog/expose-a-dispatching-endpoint-as-one-tool-per-method).

## Keep a query DTO grouped

By default a whole-object query binding is flattened, so `ListOrdersQuery { Status, Min }` reaches the agent as two top-level arguments. To keep the DTO as one argument:

:::tabs

```csharp title="ASP.NET Core"
builder.Services.AddSezzlee(options =>
{
    options.Query.Grouping = QueryObjectGrouping.Group;
});
```

```ts title="NestJS"
SezzleeModule.forRoot((options) => {
  options.query.grouping = "group";
});
```

:::

The agent then sends `{"filter": {"status": "open", "min": 3}}`. Three things to know first:

- It rewrites `inputSchema`, so an agent's saved plan breaks. It also renames the namespace curation is keyed by, and an `[McpArgument]` that pointed at a flattened leaf reports `curation_unresolved`.
- NestJS needs Express's extended query parser. Call `app.set('query parser', 'extended')`, or the first `search_tools` call fails with `query_parser_not_extended`.
- On NestJS only a named binding groups. `@Query('filter') dto: FilterDto` groups and `@Query() dto: FilterDto` does not.

:::details[Why a deep DTO is not cut off]

The SDK used to cut object graphs at three levels. The fourth level became `{ "type": "object", "additionalProperties": true }`, so a leaf field never reached the agent and the tool still looked complete. Cycles collapsed the same way, and a type used twice was written out twice, so the schema grew with uses, not types.

The limit existed for termination. It is replaced by `$defs` and `$ref`: each named type is written at most once, so a finite type graph always finishes at any depth.

A weak model might not resolve a `$ref`, but an SDK cannot lower its output on an assumption about someone else's agent, and `$defs` is standard JSON Schema. One hazard stays: a `description` beside a `$ref` is ignored in draft-07, so an older validator loses descriptions on hoisted types. `MaxDepth` remains as an off-by-default host budget, because hoisting bounds recursion and not breadth.

:::
