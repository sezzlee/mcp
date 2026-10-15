# Sezzlee.AspNetCore

An MCP layer that embeds into your existing ASP.NET Core backend. It exposes your endpoints to
agents as a search-first tool catalog and replays each call through **your own** pipeline, so your
authentication and authorization keep working exactly as they do today. Not a gateway, not
duplicated business logic.

> Status: `1.0.0`, stable; a breaking change is a major version.

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

Settings that differ per environment can come from configuration. Code given to the same call runs
after the binding, so it wins; a key that names no option fails startup instead of being ignored.
Delegates (`Description`, `Tags`, `Schema.TypeSchema`, …) and family sources stay in code.

```csharp
builder.Services.AddSezzlee(builder.Configuration.GetSection("Sezzlee"), options =>
    options.Families.Provide("dynamic-methods", DynamicMethods.LoadAsync));
```

```json
{
  "Sezzlee": {
    "Selection": { "Default": "Include" },
    "Invoke": { "Timeout": "00:00:45", "MaxResponseBytes": 200000 },
    "Visibility": { "OnUnknown": "Hide" },
    "Families": { "LoadMode": "Background", "RefreshInterval": "00:05:00" }
  }
}
```

A backend that binds JSON with `AddNewtonsoftJson()` adds the `Sezzlee.AspNetCore.NewtonsoftJson`
package and calls `builder.Services.AddSezzleeNewtonsoftJson()`, so published schemas use the
property names and enum forms its `SerializerSettings` produce. Without it Sezzlee reports
`naming_policy_unresolved` and `enum_format_unresolved` and publishes CLR names.

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

When the list of exposed endpoints lives in data, such as a table an operator edits, supply it as a
selection source. It loads like a family source and sits between the attributes and the rules:
`operation > container > provided > rules > default`. An `[McpIgnore]` is never overruled by a row,
and a row naming one endpoint outranks a rule's glob.

```csharp
builder.Services.AddSezzlee(options =>
{
    options.Selection.Provide(async (services, ct) =>
    {
        var rows = await services.GetRequiredService<ExposureStore>().LoadAsync(ct);
        return [.. rows.Select(r => new McpSelectionEntry(r.Method, r.Route, r.Exposed
            ? SelectionDefault.Include
            : SelectionDefault.Exclude)
        {
            Name = r.ToolName,
            Description = r.Description,
            Tags = r.Tags,
            SearchTerms = r.SearchTerms,
        })];
    });
    options.Selection.Source.LoadMode = FamilyLoadMode.Background;
    options.Selection.Source.RefreshInterval = TimeSpan.FromMinutes(1);
});
```

A row targets one endpoint: the upper-case `Method` and the exact normalized route template, with
no globs. `Name`, `Description`, `Tags` and `SearchTerms` are optional and sit below the matching
`[McpTool(...)]` declaration and above the options hooks. A row naming no endpoint is reported as
`selection_target_unknown` and ignored. Two rows for one target that disagree exclude it and report
`selection_entry_conflict`; identical rows collapse. A row with a blank method or route or an
undefined decision is rejected whole (`selection_entry_rejected`), and an invalid override, such as
a name that fails the tool-name pattern, loses only itself and the decision stays.

Until the source first returns, an endpoint without an attribute marker is not exposed, because the
source may be the only thing excluding it; the catalog reports `selection_not_loaded` (logged at
information in `Background` mode, otherwise at warning) and is rebuilt when the source returns.
`options.Selection.Source` takes the same `LoadTimeout`, `LoadMode`, `RefreshInterval` and
`OnFailure` as `options.Families`, binds from `Selection:Source:*`, and one hosted service loads
both. With `OnFailure = Fatal` a first load that fails stops startup with `selection_source_failed`.
The `x-sezzlee` markers published for an OpenAPI gateway carry the provided decisions, tool names
and search terms.

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
description and body — loaded at startup and on every `ReloadAsync`; the key is written into the
route and never reaches the agent. A member's body is a JSON Schema, a type
(`new McpFamilyMember(key, name, description, typeof(AssignCourier))`) or a method's parameters
(`..., method.GetParameters())`); a type or parameters are mapped like an action's body, through
`options.Schema`. Parameters become properties named as declared, required unless they have a
default value or a nullable type (`int?`, `string?`); without nullable annotations a `string` is
optional and any other object or collection is required.

| `options.Families` | Default    | Meaning                                                                                                                        |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `LoadTimeout`      | 10 s       | How long one source may take; a source that runs past it fails with a `timeout` naming this option                             |
| `LoadMode`         | `Blocking` | `Blocking` holds startup until the first load; `Background` starts without it, and family tools join when their source returns |
| `RefreshInterval`  | zero       | How often sources load again; a refresh whose members are unchanged rebuilds nothing                                           |
| `OnFailure`        | `Drop`     | `Drop` publishes the rest of the catalog without a failed source's tools; `Fatal` stops startup (`Blocking` only)              |

Every load logs each source's member count or its failure. Full guide: the docs site's _How to
expose a dispatching endpoint as one tool per method_.

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

## 3d. Serving the same catalog through the OpenAPI gateway

The attributes above can also reach an agent through `@sezzlee/openapi-mcp`, the gateway that
builds its catalog from an OpenAPI document. `SezzleeOpenApiExtensions.Current` describes the
catalog as `x-sezzlee` extensions: one per operation, keyed by `METHOD /path`, with the published
tool name, selection, hints, argument curation, variants and family members. With
`Microsoft.AspNetCore.OpenApi` (.NET 10), a document transformer writes them into the document:

```csharp
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

Swashbuckle 6 builds on Microsoft.OpenApi 1, whose extension values are `IOpenApiAny` trees rather
than JSON, so its document filter converts each extension first:

```csharp
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

Point the gateway's `source` at `/openapi/sezzlee.json` (or the Swashbuckle document). Every read reflects the latest catalog, so
family members from `Families.Provide` follow a gateway reload. The same `Operations` map is a valid
`operations` block of the gateway's own configuration, for a document that cannot be changed.

A gateway has no value providers, so a `ValueFrom` argument reaches it as a `deferred` fill it
refuses (`unknown_fill_source`); only constants and omitted values travel. Visibility does not
travel either: a document cannot say which caller may make a call.

## 3e. Per-tool visibility from your own authorization

When access is decided by your own code, such as custom MVC filters or permission keys loaded from
a database, neither the declarative facts nor the probe can say what a caller may use. Register an
`IToolAuthorizer` and the answer comes from you:

```csharp
builder.Services.AddSingleton<IToolAuthorizer, PermissionAuthorizer>();

public sealed class PermissionAuthorizer(IPermissions permissions) : IToolAuthorizer
{
    public bool Covers(McpToolInfo tool) => true;

    public async ValueTask<IToolAccess> ResolveAsync(HttpRequest? outerRequest, CancellationToken ct) =>
        new Access(await permissions.KeysOfAsync(outerRequest, ct));

    private sealed class Access(IReadOnlySet<string> keys) : IToolAccess
    {
        public VisibilityDecision Decide(McpToolInfo tool) =>
            tool.Member is { } member
                ? keys.Contains(member.Key.ToString()) ? VisibilityDecision.Allow : VisibilityDecision.Deny
                : VisibilityDecision.Unknown;
    }
}
```

`ResolveAsync` runs once per caller scope (see `ICallerScopeResolver`) for `Cache.Lifetime`, so
`Decide` must be synchronous and cheap, and the access it returns must not hold the request or a
service scope. `ISezzleeCacheInvalidator` drops a caller's access along with the rest of its cache.
`McpToolInfo` carries the method, route, controller, action and endpoint metadata, and for a tool
lowered from a family the source name and member key, so one dispatcher action can be decided per
dynamic method. An exception from either method fails the call and nothing is cached.

`Allow` and `Deny` are final. `Unknown` falls through to the declarative facts, then the probe.
`Visibility.OnUnknown` decides what is still unknown: left unset it is `Hide` when an authorizer is
registered and `Show` otherwise, and a value you set wins. A denied tool is absent from
`search_tools`, never fills a page, contributes no tag to the vocabulary, and answers `load_tool`
exactly like a name that does not exist. `invoke_tool` never consults visibility: a call for a tool the
authorizer denies is still dispatched, and your backend pipeline decides. This is not enforcement.

**Coverage check.** With an authorizer registered, each catalog build reports one
`visibility_uncovered` warning naming (the first 20 of) the tools that no tier can decide before a
call: `Covers` is false, the declarative facts are imperative or undeclared, and the probe does not
reach them. Set `options.Visibility.OnUncovered = UncoveredVisibility.Fatal` (`Visibility:OnUncovered`
in configuration) to fail the catalog instead; it also runs for a host that has no authorizer.

**Hooks.** `options.EndpointTags` and `options.EndpointSearchTerms` take a `McpEndpointInfo` and
return labels or search vocabulary per endpoint. Tags rank `[McpTool(Tags)]`, then `EndpointTags`,
then `options.Tags`, then the controller name; search terms rank `[McpTool(SearchTerms)]`, then
`EndpointSearchTerms`, then `options.SearchTerms`. A family member whose body is a method's parameters
can set `ParameterDescriptions` (by parameter name) to override the parameters' `[Description]`.

**Reloading.** Inject `ISezzleeCatalogChangeSource` and call `ReloadAsync()` when your endpoints or family
members change outside the refresh interval.

## 3f. Probing the real pipeline

Without an authorizer, set `options.Visibility.Tier = VisibilityTier.Probe` and Sezzlee asks your own
pipeline: it sends a synthetic request with the caller's identity to the tool's route, and your
authorization policy, MVC filter or middleware answers before the handler runs. A `401` or `403` hides
the tool; a request that reaches the end of authorization without being refused shows it.

`search_tools` probes on demand. It walks the ranked candidates in order, decides each one (authorizer,
then declarative facts, then probe) and keeps going until `limit` visible tools are collected, so tools a
caller may not use never shrink a page. Up to `Visibility.ProbeConcurrency` probes run at once, and no
new probe starts once the page is full. `Visibility.MaxProbesPerSearch` (default 50, `0` = never probe
from a search) caps the probes one search spends; verdicts served from the cache cost nothing. At the cap
the page is returned as it stands, one warning is logged, and the candidates still unprobed follow
`Visibility.OnUnknown`. `load_tool` probes only the
one tool it is asked about; `invoke_tool` never probes. `total` and the `tags` vocabulary are computed without probing, so a tool
that only a probe can decide counts as `Visibility.OnUnknown` says.

A caller's verdicts are cached for `Cache.Lifetime`, per caller scope, like the rest of the visibility facts.

Only `401` and `403` deny. A `429`, any `5xx` or another refusal that your pipeline did not mark as a
short circuit leaves the tool unknown and is asked again on the next search. A probe disables itself for
a tool, until the catalog reloads, only when it cannot be trusted: the path did not route (`404`; declare
route parameter values in `Visibility.ProbeValues`) or a `2xx`/`3xx` came back without the short-circuit
marker, which means the handler may have run.

**Skip side effects for probes.** A probe is not a user action. Check `HttpContext.IsSezzleeProbe()` in
rate limiting, audit logging, last-seen updates and anything else that writes, and return early:

```csharp
app.Use(async (context, next) =>
{
    if (!context.IsSezzleeProbe())
    {
        await auditLog.RecordAsync(context);
    }
    await next();
});
```

## 3g. Rate limiting

`search_tools`, `load_tool` and `invoke_tool` all arrive as the same `POST` to `/mcp`, so a limiter in
front of the endpoint can count requests but cannot give a search a different budget from a write, and
it answers with a `429` that some MCP clients answer by dropping the session. Sezzlee limits the
meta-tool call itself. Nothing is limited until you configure it:

```csharp
builder.Services.AddSezzlee(options =>
{
    options.RateLimiting.Default = new RateLimitSettings
    {
        Kind = RateLimitKind.TokenBucket,
        TokenLimit = 120,
        TokensPerPeriod = 2,
        Period = TimeSpan.FromSeconds(1),
    };
    options.RateLimiting.Invoke = new RateLimitSettings
    {
        Kind = RateLimitKind.FixedWindow,
        PermitLimit = 30,
        Window = TimeSpan.FromMinutes(1),
    };
    options.RateLimiting.InvokeConcurrency = 4;
});
```

The same limits bind from configuration through `AddSezzlee(configuration)`:

```json
"Sezzlee": {
  "RateLimiting": {
    "Default": { "Kind": "TokenBucket", "TokenLimit": 120, "TokensPerPeriod": 2, "Period": "00:00:01" },
    "Invoke": { "Kind": "FixedWindow", "PermitLimit": 30, "Window": "00:01:00" },
    "InvokeConcurrency": 4
  }
}
```

The limiters are the ones in `System.Threading.RateLimiting`. `Kind` is `TokenBucket`
(`TokenLimit`, `TokensPerPeriod`, `Period`), `FixedWindow` (`PermitLimit`, `Window`), `SlidingWindow`
(`PermitLimit`, `Window`, `SegmentsPerWindow`) or `Concurrency` (`PermitLimit`); `QueueLimit` lets that
many calls wait for a permit, and cancelling the MCP call ends the wait. `Search`, `Load` and `Invoke`
each replace `Default` for that meta-tool and get a bucket of their own; a meta-tool without a section
shares the `Default` bucket, and so does any other tool registered on the same MCP server.
`InvokeConcurrency` is held from the start of an `invoke_tool` call until its result is mapped.
Limits are per process.

The limit is taken first: before argument binding, the catalog lookup, the version check and
visibility. A `load_tool` or `invoke_tool` call that names a hidden or unknown tool takes a permit like
any other, so an agent cannot enumerate names for free. A refused call is a normal result, never a
`429`:

```json
{
  "error": "rate_limit_exceeded",
  "message": "The call was refused by this server's rate limit before it ran. Retry after 3 seconds.",
  "retryable": true,
  "retryAfterSeconds": 3
}
```

`retryAfterSeconds` is the limiter's retry-after rounded up, and is absent for a concurrency limit. It
is distinct from the backend's `rate_limited`: this call never reached the backend. Other JSON-RPC
methods (`initialize`, `tools/list`, `ping`) are not limited here; your host's HTTP limiter covers them.

**The key.** Declared limits are partitioned per caller scope key (`ICallerScopeResolver`). That fits only
while the key stays the same for one caller: a scope key that carries a permission version starts a new
bucket on every change. The scope key is also derived from the identity carrier headers, so it is safe
only when the MCP endpoint rejects unauthenticated requests: on an endpoint that admits anonymous calls,
a caller can send a different header on every call and start each one with a full bucket. In both cases
supply a key the caller cannot change at will:

```csharp
options.RateLimiting.Key(call => call.HttpContext?.User.FindFirst("sub")?.Value ?? call.CallerScope);
```

**A partition function.** For anything the declared form cannot say, return the partitions yourself.
`McpCallContext` carries the `HttpContext`, the `MetaTool`, the `Target` (the catalog tool a `load_tool` or
`invoke_tool` call names, found without visibility, or null), the `ToolName` and the `CallerScope`. A call
takes one permit from each returned partition in order and is refused when any refuses, releasing the
ones it already holds; partitions with equal keys share one limiter, and an empty list leaves the call
unlimited:

```csharp
options.RateLimiting.Partitions(call =>
[
    RateLimitPartition.GetConcurrencyLimiter(
        $"user:{call.CallerScope}", _ => new ConcurrencyLimiterOptions { PermitLimit = 2 }),
    RateLimitPartition.GetTokenBucketLimiter(
        "everyone", _ => new TokenBucketRateLimiterOptions
        {
            TokenLimit = 600, TokensPerPeriod = 10, ReplenishmentPeriod = TimeSpan.FromSeconds(1),
        }),
]);
```

`Partition` takes a single partition. A partition function replaces the declared limits, so setting
both, or setting `Key` without declared limits, fails startup, as does a value its `Kind` needs that is
not positive.

## 4. Connecting an MCP client

The endpoint speaks Streamable HTTP. `tools/list` returns only three meta-tools:

| Tool           | Job                                              |
| -------------- | ------------------------------------------------ |
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

A description kept outside the code, such as generated code documentation, comes in through
`options.Description`. It is asked per endpoint, below `[McpTool(Description = ...)]` and above the
endpoint's `[EndpointDescription]`, which it receives as `Declared`; returning null keeps that:

```csharp
options.Description = endpoint => endpoint.Action is { } action ? codeDocs.Find(action) : null;
```

Words an agent may type that your operation's text does not contain go in `SearchTerms`
(`[McpTool(SearchTerms = new[] { "sipariş" })]`, or `options.SearchTerms` centrally): indexed like
the description, never a filter key, never shown to the agent. To rank with your own retriever
instead of BM25, register an `IToolRanker`; `options.Search.RankerTimeout` (10 s by default) and
`options.Search.OnRankerFailure` (`Fallback` or `Error`) govern it. Visibility, the tag filter and
the payload budget still apply to its answer — see the how-to on plugging in your own search.

When an operation's behaviour changes behind an unchanged schema, raise its revision
(`[McpTool(Revision = 2)]` on the action, on the controller for every action in it, or
`options.Revision` for the whole catalog). The revision enters the tool version, so during a rolling
deploy a call pinned to the old version is refused with `tool_changed` instead of running against
the new behaviour. The levels add up rather than replacing one another — see the how-to on shipping
a behaviour change mid-deploy.

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

| Symptom                                                       | Cause                                                                    | Fix                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `MapSezzlee() requires app.UseSezzleeCapture()...` at startup | Capture was never called                                                 | Add `app.UseSezzleeCapture()`, before routing                                               |
| `sezzlee pipeline is not captured` on the first tool call     | Capture is registered but the host has not served a request yet          | Start the host; if it persists, check where capture sits                                    |
| Tools work but authorization never runs                       | Capture is **after** `UseAuthentication`/`UseAuthorization`              | Move capture to the top of the pipeline                                                     |
| `search_tools` always empty                                   | `Selection.Default` defaults to `Exclude` and no `[McpTool]` was applied | Add `[McpTool]`, or set `Selection.Default = Include`                                       |
| Every request to `/mcp` returns 401                           | `.RequireAuthorization()` is on and the client sends no token            | Send a bearer token, or drop `.RequireAuthorization()` during development                   |
| Host will not start, fatal diagnostic                         | A catalog error such as `name_collision` / `invalid_name`                | Read the code list in the log; downgrade a single code with `options.Diagnostics.Downgrade` |
| Family tools missing, `family_source_failed` with `timeout`   | The source ran past `Families.LoadTimeout`                               | Raise `Families.LoadTimeout`, or set `Families.LoadMode = Background`                       |
| Endpoints missing, `selection_not_loaded` with `timeout`      | The selection source ran past `Selection.Source.LoadTimeout`             | Raise `Selection.Source.LoadTimeout`, or set `Selection.Source.LoadMode = Background`       |
| `unreadable_shape` naming a type that "contains its own kind" | A collection whose items are its own kind, such as Newtonsoft's `JToken` | Publish a schema for it with `options.Schema.TypeSchema`                                    |

## 6. What's next

- The docs site: `pnpm --filter @sezzlee/docs dev` → `http://localhost:5180`
- Sample: [samples/DemoApi](samples/DemoApi) — policy, role, imperative ownership checks and
  anonymous endpoints in a single controller
