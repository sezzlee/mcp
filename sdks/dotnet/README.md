# Sezzlee.AspNetCore

An MCP layer that embeds into your existing ASP.NET Core backend. It exposes your endpoints to
agents as a search-first tool catalog and replays each call through **your own** pipeline, so your
authentication and authorization keep working exactly as they do today. Not a gateway, not
duplicated business logic.

> Status: `0.2.0`, alpha; breaking changes are possible.

## Requirements

- An ASP.NET Core Web API project targeting `net8.0` or `net10.0`
- Controller or minimal-API endpoints (discovery goes through ApiExplorer)

## 1. Install

```bash
dotnet add package Sezzlee.AspNetCore
```

Do not wire it with a `ProjectReference`. Sezzlee multi-targets (`net8.0;net10.0`) and a
`ProjectReference` evaluates every target during restore, which produces `NETSDK1045` on a host
that pins an older SDK through `global.json`. The package path does not have this problem: the
host's SDK picks whichever target it can build.

## 2. Wiring — three calls

```csharp
using Sezzlee.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddSezzlee();

var app = builder.Build();

app.UseSezzleeCapture();

app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();
app.MapSezzlee("/mcp");

app.Run();
```

Leave your existing `AddAuthentication`/`AddAuthorization` setup alone — Sezzlee installs no identity
scheme of its own and uses yours.

> **Order is critical.** `UseSezzleeCapture()` captures the pipeline **from that point onward** and
> injects agent calls into it. Put it **before** `UseRouting`/`UseAuthentication`/`UseAuthorization`,
> as early as you can. Placed after them, agent requests never see your authentication layer. Omit
> it entirely and `MapSezzlee()` throws at startup.

## 3. Which endpoints become visible?

The default is **opt-in**: nothing is exposed, and what you mark with `[McpTool]` is.

```csharp
using Sezzlee.AspNetCore.Discovery;

[ApiController]
[Route("orders")]
[McpTool]
public sealed class OrdersController : ControllerBase { }
```

On a backend with hundreds of endpoints the attribute path is impractical; switch to opt-out and
close individual exceptions with `[McpIgnore]`:

```csharp
builder.Services.AddSezzlee(options =>
{
    options.Selection.Default = SelectionDefault.Include;
});
```

For a subtree that is categorically off limits — or one you cannot decorate, such as a generated
or third-party controller — put the decision in configuration instead:

```csharp
builder.Services.AddSezzlee(options =>
{
    options.Selection.Default = SelectionDefault.Include;
    options.Selection.Rules.Add(new SelectionRule(SelectionDefault.Exclude, Route: "/admin/**"));
    options.Selection.Rules.Add(new SelectionRule(SelectionDefault.Exclude, Method: "POST"));
});
```

`*` stays inside one path segment and `**` crosses them, so `**` is the catch-all and `*` is not.
Route matching is case-sensitive and a path parameter is matched as the literal `{id}` the template
carries; `Method` ignores case. Rules rank by how many fields they name, never by declaration
order, and two equally specific rules that disagree fail the catalog with `ambiguous_selection`
rather than one quietly winning. An attribute always outranks a rule, so a carve-out inside an
excluded subtree goes on the endpoint.

Visibility is **not** a security mechanism. A tool hidden from the catalog still runs only if your
backend permits it; enforcement is always in your pipeline at invoke time.

## 3b. Curating what the agent sees

Your DTO was written for HTTP clients. `[McpArgument]` declares a different agent-facing surface
over the same endpoint, without touching the DTO.

```csharp
[HttpGet("orders")]
[McpTool(Description = "Search your orders by keyword.")]
[McpArgument("customerId", Hidden = true, ValueFrom = "tenant")]
[McpArgument("status", Description = "active | closed")]
[McpArgument("page", Name = "page_number")]
public IActionResult List([FromQuery] ListOrdersQuery query) => ...;
```

The agent sends `page_number`; the request still goes out as `?page=`. It never sees `customerId`,
and sending it is an `unknown_argument` error. The value comes from a provider you register once:

```csharp
options.Arguments.Provide("tenant", (caller, _) =>
    ValueTask.FromResult<JsonNode?>(JsonValue.Create(caller.Claim("tenant_id"))));
```

`Value` writes a scalar constant, `ValueJson` an object or array one (attribute arguments must be
compile-time constants, and a string is one), and `Hidden = true` alone sends nothing so your
backend's own default stands. Rules can also live in `options.Arguments` for controllers you cannot
decorate, with `Seal` for a rule no attribute may override.

**Curation is not enforcement.** Filling `customerId` from a token does not isolate tenants; your
pipeline still decides. It changes what the agent has to think about, not what it may do.

`[McpToolVariant(name, description)]` produces several tools from one action. Both are constructor
arguments, because one description cannot honestly describe two differently curated tools.

`[McpToolFamily("methodId", Source = "...")]` publishes an action that dispatches on a parameter
as one tool per method. `options.Families.Provide(name, source)` supplies the members — key, name,
description, body schema — loaded at startup and on every `ReloadAsync`; the key is written into the
route and never reaches the agent. Full guide: the docs site's _How to expose a dispatching endpoint
as one tool per method_.

Full guide: the docs site's _How to curate the arguments an agent sees_.

## 3c. Telling the agent what a tool returns

`load_tool` publishes an `outputSchema` alongside `inputSchema`, so an agent can plan a chain of
calls without making the first one. Response types come from ApiExplorer, so an action that already
documents itself needs nothing new:

```csharp
[HttpGet("/orders/{id:int}")]
[ProducesResponseType(typeof(OrderResponse), StatusCodes.Status200OK)]
[ProducesResponseType(StatusCodes.Status404NotFound)]
public IActionResult GetOrder(int id) => ...;
```

`Produces<T>()` on a minimal API and a return type MVC can infer work the same way; there is no
`[McpTool]` field for this.

Only one status becomes the schema — `200`, `201`, `202`, `204` in that order, then the lowest
remaining `2xx`. A `204`, or an action with no `2xx` at all, publishes no `outputSchema`. A
non-object root is wrapped under `result`, because MCP requires an object. Unlike the input side,
read-only members are kept: a get-only property is exactly what a response reports.

Full guide: the docs site's _How to tell the agent what a tool returns_.

## 4. Connecting an MCP client

The endpoint speaks Streamable HTTP. `tools/list` returns only three meta-tools:

| Tool           | Job                                             |
| -------------- | ----------------------------------------------- |
| `search_tools` | Searches endpoints with a natural-language query |
| `load_tool`    | Returns one tool's full schema                   |
| `invoke_tool`  | Calls the tool                                   |

The catalog is not dumped into `tools/list`: on a 700-endpoint backend that drowns the agent's
context. The agent searches first, then loads, then calls.

`search_tools` takes `query`, `limit`, `detail` and `tags`. `tags` narrows the answer to endpoints
carrying every tag listed, matched whole and insensitive to case and accents; every answer carries
the vocabulary the caller may see, so the agent reads a tag rather than guessing one. Each endpoint
is tagged with its controller name unless you say otherwise:

```csharp
[McpTool(Name = "find_orders", Tags = new[] { "billing", "read" })]
```

A declaration replaces the controller-derived tag rather than adding to it, and `options.Tags` sets
the same thing centrally for controllers you cannot decorate. Tags are search text too, so changing
them changes ranking — see the how-to on grouping operations.

Words an agent may type that your operation's text does not contain go in `SearchTerms`
(`[McpTool(SearchTerms = new[] { "sipariş" })]`, or `options.SearchTerms` centrally): indexed like
the description, never a filter key, never shown to the agent. To rank with your own retriever
instead of BM25, register an `IToolRanker`; `options.Search.RankerTimeout` (10 s by default) and
`options.Search.OnRankerFailure` (`Fallback` or `Error`) govern it. Visibility, the tag filter and
the payload budget still apply to its answer — see the how-to on plugging in your own search.

To protect `/mcp`, attach your own authorization:

```csharp
app.MapSezzlee("/mcp").RequireAuthorization();
```

This repository's `sdks/nestjs/samples/agent-client` is a ready-made client:

```bash
node sdks/nestjs/samples/agent-client/dist/main.js --scenario smoke --query "get order"
```

Pass `--query`; the scenario's built-in default query is a non-ASCII term used to exercise
tokenization.

## 5. Troubleshooting

| Symptom                                                       | Cause                                                                       | Fix                                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `MapSezzlee() requires app.UseSezzleeCapture()...` at startup     | Capture was never called                                                     | Add `app.UseSezzleeCapture()`, before routing                                             |
| `sezzlee pipeline is not captured` on the first tool call      | Capture is registered but the host has not served a request yet              | Start the host; if it persists, check where capture sits                                 |
| Tools work but authorization never runs                       | Capture is **after** `UseAuthentication`/`UseAuthorization`                  | Move capture to the top of the pipeline                                                  |
| `search_tools` always empty                                   | `Selection.Default` defaults to `Exclude` and no `[McpTool]` was applied     | Add `[McpTool]`, or set `Selection.Default = Include`                                    |
| Every request to `/mcp` returns 401                           | `.RequireAuthorization()` is on and the client sends no token                | Send a bearer token, or drop `.RequireAuthorization()` during development                |
| Host will not start, fatal diagnostic                         | A catalog error such as `name_collision` / `invalid_name`                   | Read the code list in the log; downgrade a single code with `options.Diagnostics.Downgrade` |

## 6. What's next

- The docs site: `pnpm --filter @sezzlee/docs dev` → `http://localhost:5180`
- Sample: [samples/DemoApi](samples/DemoApi) — policy, role, imperative ownership checks and
  anonymous endpoints in a single controller
