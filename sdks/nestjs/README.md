# @sezzlee/sdk-nestjs

An MCP layer that embeds into your existing NestJS backend. It exposes your endpoints to agents as
a search-first tool catalog and replays each call through **your own** pipeline, so your guards,
pipes and interceptors keep running unchanged. Not a gateway, not duplicated business logic.

> Status: `1.0.0`, stable; a breaking change is a major version. [samples/demo-api](samples/demo-api) is
> the reference wiring.

## Requirements

- NestJS 10 or later (`@nestjs/common`, `@nestjs/core`), dev-tested against 11.x
- `@modelcontextprotocol/server`, `@modelcontextprotocol/node` and `@modelcontextprotocol/express`
  2.0 or later, `rxjs` 7 and `zod` 4
- `class-validator`, `class-transformer` and `@nestjs/swagger` are optional; their decorators shape
  the argument and output schemas, and `@nestjs/swagger` is read without being loaded
- Node 22 or later, Express as the HTTP adapter; on any other adapter the module refuses to start
  with `unsupported_http_adapter`

Peers are peers on purpose: sezzlee uses your Nest and your MCP SDK, not its own copies.

## 1. Install

```bash
pnpm add @sezzlee/sdk-nestjs
```

## 2. Wiring — three pieces

Wiring is three _pieces_, because a Nest controller is your code and a module cannot add a route
to it.

**The module.** `forRoot` takes a callback that **mutates** an options instance — not an options
literal. Passing `{ visibility: { tier: "probe" } }` configures nothing.

```ts
@Module({
  imports: [
    SezzleeModule.forRoot((options) => {
      options.visibility.tier = "probe";
    }),
  ],
  controllers: [OrdersController, McpController],
})
export class AppModule {}
```

`forRootAsync({ imports, inject, useFactory })` is the async form. The module is `@Global()`, so
its providers are available without importing it again.

**The MCP controller.** It stays yours, so the path, guards, interceptors and global prefix are
decided the way they are for every other route. `SezzleeMcpEndpoint` builds the handler:

```ts
@Controller()
export class McpController {
  private readonly serve: SezzleeRequestHandler;

  constructor(endpoint: SezzleeMcpEndpoint) {
    this.serve = endpoint.serve({ name: "your-api", version: "1.0.0" });
  }

  @All("mcp")
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.serve(req, res);
  }
}
```

Call `serve` once, in the constructor, and keep the handler it returns. That handler owns the bus
`listChanged` notifications travel on; a handler built per request is one nobody publishes to, so
a catalog change never reaches a connected client.

`@All` rather than `@Post`: the transport answers a 2025-era `GET`/`DELETE` with `405` itself
instead of letting Nest return `404`.

**The bootstrap.**

```ts
import "reflect-metadata"; // must be the first import in the process

const app = await NestFactory.create(AppModule);
app.getHttpAdapter().getInstance().set("query parser", "extended");
app.useGlobalPipes(new ValidationPipe({ transform: true }));

await app.init(); // before any app.get(...) / app.use(...)
await app.listen(3000);
```

Express 5 parses queries with `simple` by default, which delivers `?filter[owner]=x` as one literal
key. A tool that writes a bracketed query object needs the `extended` parser, and the catalog
refuses to start with `query_parser_not_extended` without it.

> **Order is critical.** `reflect-metadata` must be imported first, or the decorators in §3 store
> nothing and your catalog comes up empty. And `await app.init()` must precede `app.use(...)` that
> resolves a provider — `app.get(...)` throws before the container is initialized.

## 3. Which endpoints become tools

The default is **opt-in**: nothing is exposed until you mark it.

```ts
@Controller()
@McpTool()
export class OrdersController {
  @Get("orders/:id")
  @McpTool({ description: "Fetches one order by id." })
  getOrder(@Param("id", ParseIntPipe) id: number): Order { ... }
}
```

`@McpTool({ description })` is how an agent gets something to search against; an endpoint without
one falls back to its `@ApiOperation` description or summary. `options.description` supplies the
text for an endpoint the host documents elsewhere. It receives `{ method, route, container, handler,
declared }`, sits below `@McpTool({ description })` and above `declared`, and returning `undefined`
or a blank keeps `declared`. Input schemas come from your DTOs and your pipes: `ParseIntPipe` yields
an integer, `@Min`/`@Max` become `minimum`/`maximum`.

A DTO is read from `class-validator` and from `@nestjs/swagger`'s `@ApiProperty`, including the
metadata the Swagger CLI plugin generates and the mapped types (`PartialType`, `PickType`, …) it
builds, so a DTO only `@ApiProperty` describes works as it is. Where both describe a member,
`class-validator` decides its type and whether it is required, because that is what the validation
pipe enforces, and `@ApiProperty` adds the description. `@ApiQuery`, `@ApiParam` and `@ApiHeader`
type, require and describe the parameter they name; a pipe and an `@McpTool({ parameters })` hint
still win. `@ApiBody({ type })` is used only when the `@Body()` parameter's own type is erased.
`@ApiProperty({ nullable: true })` lets the member be `null`.

On Nest 12, a schema given to the binding — `@Body({ schema })`, `@Query({ schema })`,
`@Query("q", { schema })`, `@Param("id", { schema })` — is what the pipe validates against, so it
outranks every other source. It is read through Standard JSON Schema, which zod 4.2 and later
implement; whether a named query is required is asked of the schema itself. A schema that cannot be
converted is reported as `unreadable_shape` and the declared type is read instead.

A whole-object query binding is expanded into one argument per member, so the agent sees the
filters:

```ts
class ListOrdersQuery {
  @IsString() customerId!: string;
  @IsString() @IsOptional() status?: string;
  @IsInt() @Min(1) @IsOptional() page?: number;
}

@Get("orders")
list(@Query() query: ListOrdersQuery) { ... }
// arguments: customerId (required), status, page
```

The expansion needs a readable type. A member that cannot be expressed as a query parameter — a
nested object, a dictionary — is omitted with an `unbound_query_object` warning. If **no** member
can be read (`@Query() q: Record<string, unknown>`, or a DTO with neither `class-validator` nor
`@ApiProperty` decorators)
the endpoint is dropped with `unresolved_query_shape` rather than published as a tool that claims
to take no filters. Decorate the type, declare `options.schema.typeShape`, or add the code to
`options.diagnostics.downgrade` to publish it filterless anyway.

A member whose name is already claimed by a path parameter or a named `@Query('x')`/`@Headers('x')`
binding is omitted too, with a `query_member_shadowed` warning: the flat argument object has one
slot per name and the explicit binding owns it. Rename the member, or bind it by name.

### Routes

Routes are composed by Nest's own route factory, so the descriptor's route is the path Nest
actually serves: `setGlobalPrefix` (with its `exclude` list), `RouterModule.register({ path })`,
URI versioning, controller path and method path. Two consequences worth knowing:

- **A global prefix moves the protected-resource metadata.** Nest applies the prefix to middleware
  paths too, so `/.well-known/oauth-protected-resource/mcp` becomes `/api/.well-known/...` and RFC
  9728 discovery breaks. When `resourceServer` is set, sezzlee raises a fatal `prm_path_prefixed`
  diagnostic naming the fix: `setGlobalPrefix("api", { exclude: ["/.well-known/oauth-protected-resource/mcp"] })`.
- **Non-URI versioning is not carried into invocation.** With `HEADER`, `MEDIA_TYPE` or `CUSTOM`
  versioning the version never enters the path, and the synthetic request sezzlee replays carries no
  version header, so dispatch lands on the default version. A handler bound to any other version is
  dropped with `version_not_carried` rather than published as a tool that would call its neighbour;
  `options.diagnostics.downgrade` keeps it. URI versioning has no such gap, and `defaultVersion` is
  applied the way Nest applies it.
- **The replayed request cannot choose a host or stream.** A controller routed on a host pattern
  (`@Controller({ host: ":account.example.com" })`) and an `@Sse()` handler are dropped with
  `unsupported_binding`: the first would reach whatever host the MCP request came in on, the second
  never ends.
- **Express path syntax is written as a template.** `:id.json` becomes `{id}.json` and
  `:from-:to` becomes `{from}-{to}`. An optional part — Express 5's `files{/:name}` or Express 4's
  `:name?` — is written present, so the agent can send its parameter.

One operation bound to several routes — `@Controller(["orders", "purchases"])`, a legacy path kept
alongside a new one, or one handler under two URI versions — stays **one tool**: the same code at
two URLs is one operation, and two identical tools only dilute search. The invoked route is chosen
deterministically (shortest, then ordinal), the folded routes are reported as `route_folded`, and
they stay searchable so a query naming the compatibility path still finds the tool.

At scale, invert it and exclude the exceptions:

```ts
SezzleeModule.forRoot((options) => {
  options.selection.default = "include";
});
```

Then `@McpIgnore()` on the endpoints or controllers you withhold.

For a subtree that is categorically off limits — or one you cannot decorate, such as a generated
or third-party controller — put the decision in configuration instead:

```ts
SezzleeModule.forRoot((options) => {
  options.selection.default = "include";
  options.selection.rules = [
    { route: "/admin/**", decision: "exclude" },
    { method: "POST", decision: "exclude" },
  ];
});
```

`*` stays inside one path segment and `**` crosses them, so `**` is the catch-all and `*` is not.
Route matching is case-sensitive and a path parameter is matched as the literal `{id}` the template
carries; `method` ignores case. Rules rank by how many fields they name, never by declaration
order, and two equally specific rules that disagree fail the catalog with `ambiguous_selection`
rather than one quietly winning. An attribute always outranks a rule, so a carve-out inside an
excluded subtree goes on the endpoint.

### A selection source

When the list of exposed endpoints lives in data — a database table an operator edits — supply it
as a source instead of code. It becomes a level between the attributes and the rules:
`operation` > `container` > provided > `rules` > `default`. A row never overrules a
`@McpIgnore()`, and it outranks a glob in configuration.

```ts
SezzleeModule.forRoot((options) => {
  options.selection.provide(async ({ signal }) =>
    (await db.exposedEndpoints({ signal })).map((row) => ({
      method: row.method,
      route: row.route,
      decision: row.exposed ? "include" : "exclude",
      description: row.description,
      tags: row.tags,
    })),
  );
  options.selection.source.refreshIntervalMs = 60_000;
});
```

A row names one endpoint by upper-case `method` and composed `route`, compared exactly; there are no
globs. `name`, `description`, `tags` and `searchTerms` are optional overrides that sit below the
decorator's own declaration and above the endpoint hooks and the derived name. The source loads like
a family source: `selection.source` takes the same `loadTimeoutMs`, `loadMode`, `refreshIntervalMs`
and `onFailure`, a refresh that returns the same rows rebuilds nothing, and a failed refresh keeps
the rows it last returned.

Until the source has returned once, every endpoint without a decorator is **not selected**, because
the source may be the only thing excluding it; decorated endpoints are decided as usual, and
`selection_not_loaded` says so. A defect in one row is that row's alone and a warning:
`selection_target_unknown` for a row naming no endpoint, `selection_entry_conflict` when two rows
for one endpoint disagree (both are ignored and the endpoint is excluded), and `selection_entry_rejected` for a blank method or
route, an unknown decision, or an invalid override, which loses only that override.

Visibility is **not** a security mechanism. A tool hidden from the catalog still runs only if your
backend permits it; enforcement is always in your pipeline at invoke time.

## 3b. Curating what the agent sees

Your DTO was written for HTTP clients. `arguments` declares a different agent-facing surface over
the same endpoint, without touching the DTO.

```ts
@Get("orders")
@McpTool({
  description: "Search your orders by keyword.",
  arguments: curate<ListOrdersQuery>({
    customerId: hidden.from("tenant"),
    status: { description: "active | closed" },
    page: { as: "page_number" },
  }),
})
list(@Query() query: ListOrdersQuery) { ... }
```

The agent sends `page_number`; the request still goes out as `?page=`. It never sees `customerId`,
and sending it is an `unknown_argument` error. The value comes from a provider you register once:

```ts
options.arguments.provide("tenant", (caller) => caller.claim("tid"));
```

`hidden.value(x)` writes a constant instead, and `hidden.omit()` sends nothing so your backend's own
default stands. Rules can also live centrally — `options.arguments.curate(target, rules)` for
controllers you cannot decorate, `seal` for a rule no decorator may override.

**Curation is not enforcement.** Filling `customerId` from a token does not isolate tenants; your
pipeline still decides. It changes what the agent has to think about, not what it may do.

`@McpVariant({ name, description, arguments })` produces several tools from one handler. Both fields
are required, because one description cannot honestly describe two differently curated tools.

`@McpToolFamily({ parameter: "methodId", source: "..." })` publishes a handler that dispatches on a
parameter as one tool per method. `options.families.provide(name, source)` supplies the members —
key, name, description and a body — loaded in `onApplicationBootstrap` and on every `reload()`,
which now returns a promise; the key is written into the route and never reaches the agent. A
member's body is either a JSON Schema (`body`) or a DTO class (`bodyType`), never both. A class is
mapped the way an `@Body()` parameter is, through `options.schema`, and what the mapping reports
reaches the catalog's diagnostics prefixed with `<Controller.handler> member '<name>': `.

```ts
options.families.provide("methods", async () => [
  {
    key: "3f2c9a1e",
    name: "list_delayed_orders",
    description: "Lists delayed orders.",
    bodyType: DelayedOrdersFilter,
    readOnly: true,
  },
]);
```

How and when sources load is configured on `options.families`:

| Option              | Default      | Meaning                                                                                                                                                                               |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadTimeoutMs`     | `10000`      | How long one source may take. The stored error names this setting and `loadMode`.                                                                                                     |
| `loadMode`          | `"blocking"` | `"blocking"` makes startup wait for the first load. `"background"` starts it and lets family operations join the catalog, with a `listChanged` notification, when the source returns. |
| `onFailure`         | `"drop"`     | `"drop"` drops the families of a source that never returned and goes on. `"fatal"` stops startup with `SezzleeCatalogError` (`family_source_failed`); it requires `"blocking"`.       |
| `refreshIntervalMs` | `0`          | Loads the sources again on this interval after the first load; `0` loads once. A refresh rebuilds the catalog only when a source's published members changed.                         |

A source that fails after it returned keeps the members it last returned, and each load logs one
line per source under the `Sezzlee` logger. A refresh whose rebuild would turn a valid catalog
fatal is refused and the current catalog kept, as `reload()` does; the timer logs it as a warning.
`catalog.refreshFamilies()` runs one refresh on demand, and `catalog.reload()` rebuilds the catalog
whenever your own data changed; both are public API on `SezzleeCatalog`. Full guide: the docs site's _How to expose
a dispatching endpoint as one tool per method_.

Full guide: the docs site's _How to curate the arguments an agent sees_.

## 3c. Telling the agent what a tool returns

`load_tool` publishes an `outputSchema` alongside `inputSchema`, so an agent can plan a chain of
calls without making the first one. Nest has to be told what a handler returns: TypeScript erases
generics, so an `async` handler reports `Promise` at runtime and a collection reports `Array`.

```ts
@Get("orders/:id")
@McpTool({
  description: "Fetches one order by id.",
  responses: { 200: OrderResponse, 404: {} },
})
getOrder(@Param("id", ParseIntPipe) id: number): OrderResponse { ... }
```

Per status code: a DTO class, `[OrderResponse]` for a collection of it, `{ schema }` for a shape no
class can express, a zod (or other Standard JSON Schema) schema of the response, or `{}` for a
status with no body. A DTO is read the same way as a request DTO.

If you already write `@ApiOkResponse({ type: OrderResponse })`, it is read as a fallback, and a sync
handler's plain class return type is read as a last resort. The declaration wins over both. The
Swagger CLI plugin writes that `@ApiResponse` from the handler's return type, `Promise` unwrapped, so
with the plugin an `async` handler needs no declaration.

A schema read from `@ApiOkResponse` or the return type is what the handler returns, so it is passed
through the interceptors that change it. `ClassSerializerInterceptor` is understood: the schema
lists what `classToPlain` writes, without `@Exclude()` members, under `@Expose({ name })` names,
with `@Expose()` accessors, following the strategy, `excludeExtraneousValues` and `type` of its
options and `@SerializeOptions()`. An interceptor of your own that reshapes the body describes the
result by implementing `McpResponseDescriber`:

```ts
@Injectable()
export class EnvelopeInterceptor
  implements NestInterceptor, McpResponseDescriber
{
  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(map((data) => ({ data })));
  }

  describeResponse(schema: JsonSchemaObject): JsonSchemaObject {
    return { type: "object", properties: { data: schema }, required: ["data"] };
  }
}
```

Hooks run innermost first, as the response leaves the handler, on the instance Nest built, so they
can read the interceptor's fields and injected dependencies; returning `undefined` publishes the
status without a schema. A request-scoped or transient interceptor has no single instance, so its
hook is not run: the status is published without a schema and `unreadable_shape` is reported. An `@McpTool({ responses })` declaration is the published shape as written
and is not passed through either.

A body that is not text in the charset its content type names — a PDF, an image — is returned as
base64 with `bodyEncoding: "base64"` beside its `contentType`, never decoded into replacement
characters.

Only one status becomes the schema — `200`, `201`, `202`, `204` in that order, then the lowest
remaining `2xx`. A non-object root is wrapped under `result`, because MCP requires an object, and
`invoke_tool` returns that body as `body.result` to match. Unlike
the input side, read-only members are kept: they are what a response is made of.

Full guide: the docs site's _How to tell the agent what a tool returns_.

## 3d. Serving the same catalog through the OpenAPI gateway

The decorators above can also reach an agent through `@sezzlee/openapi-mcp`, the gateway that
builds its catalog from an OpenAPI document. `SezzleeCatalog.openApiExtensions()` describes the
catalog as `x-sezzlee` extensions: one per operation, keyed by `METHOD /path`, with the published
tool name, description, tags, schemas, selection, hints, argument curation, variants and family members.
`annotateOpenApiDocument` writes them into the document `@nestjs/swagger` builds, and marks every
operation the catalog did not publish, its own MCP route included, `tool: false`:

```ts
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { annotateOpenApiDocument, SezzleeCatalog } from "@sezzlee/sdk-nestjs";

const catalog = app.get(SezzleeCatalog);
SwaggerModule.setup(
  "openapi",
  app,
  SwaggerModule.createDocument(app, new DocumentBuilder().build()),
  {
    patchDocumentOnRequest: (_req, _res, document) => {
      const annotated = structuredClone(document);
      annotateOpenApiDocument(annotated, catalog.openApiExtensions());
      return annotated;
    },
  },
);
await app.listen(3000);
```

`@nestjs/swagger` builds the document once and serves that copy, so annotate it in
`patchDocumentOnRequest`: each read then describes the current catalog, family members loaded after
startup included. Call `setup` before `listen`; a route added after the application initialized
sits behind its 404 handler.

`annotateOpenApiDocument` returns `undocumented`, the operations the SDK publishes that the document
leaves out, such as a handler marked `@ApiExcludeEndpoint()`; the gateway cannot publish those.

Point the gateway's `source` at the served JSON. The same `operations` map is a valid `operations`
block of the gateway's own configuration, for a document that cannot be changed.

A gateway has no value providers, so an argument hidden with `hidden.from(...)` reaches it as a
`deferred` fill it refuses (`unknown_fill_source`); only constants and omitted values travel.
Of visibility, only `anonymous: true` travels, for an operation any caller may make (a guard
declaring `anonymous: "yes"` with no policy); the gateway shows every other tool as uncertain, since
a document cannot say which caller may make a call.

## 3e. Provider tools without HTTP routes

Use `defineProviderTool` from `@sezzlee/sdk-nestjs` to register an MCP-only operation. Bind a
singleton provider, a unique name and description, a strict object input validator, an optional
output validator, an explicit `access` policy, and an `execute` callback. Schemas implement both
Standard Schema validation and Standard JSON Schema conversion; `z.strictObject` from zod 4.2+
works. Add the provider to your Nest module and push the registration into `options.tools`.
The complete, runnable example is [note-summary.ts](samples/demo-api/src/note-summary.ts), wired in
[app.module.ts](samples/demo-api/src/app.module.ts).

Provider and HTTP tools share `search_tools`, `load_tool`, `invoke_tool`, schema versions and
`read_result`. A duplicate name fails catalog activation. A provider registration creates no
HTTP route and does not require a synthetic HTTP request. `catalog.current` / `find` and OpenAPI
extensions remain HTTP-only; `catalog.callable` / `findCallable` expose both kinds. OpenAPI export
reports omitted providers. Custom rankers must handle a missing `route` on provider documents.

The access policy is either `"public"` or a callback receiving `{ tool, caller, signal }`. A public
policy still sits behind configured MCP transport authentication. Private policies must check the
host's current permissions. Each invocation and stored-result read evaluates the policy again;
HTTP visibility caches and probes do not authorize provider work. A handler receives its own
context, so a singleton service need not store caller identity between requests. HTTP middleware,
guards, pipes and interceptors do not run; required checks belong in the policy and service.
Request/transient-scoped providers and request-scoped dependency trees are refused at startup.

A successful provider call returns `{ body: value }`, without HTTP status or content type.
A declared output schema is published as that envelope and validates the body at runtime. JSON
compatibility, output byte limits, result storage, redaction and meta-tool rate limits still apply.
Set identity carriers or a caller scope resolver that separates users before storing private
results. Global timeout/byte limits apply; the HTTP-only per-target override hooks are unchanged.
Custom rate-limit partitions receive `providerTarget` for provider calls and the existing `target`
for HTTP calls. Deadlines include policy and validation work; the signal cancels cooperative work
but cannot undo a write or preempt synchronous code. The buffered-result ceiling is checked after
the provider has materialized its output.

Unexpected exceptions and validation details are redacted. Throw `ProviderToolError` only for an
intentional public business message; it still passes through the shared leak filter and response
budget. See [the provider contract](../../packages/http/spec/provider-tools.md) and run the demo
agent-client's `--scenario provider` acceptance scenario.

## 4. Visibility and guards

This is the SDK's defining behaviour, and the thing most likely to surprise you.

sezzlee asks every guard on an endpoint — global, controller and method — for a declaration, by
looking for a `describeVisibility()` method. **If any guard lacks it, the endpoint is marked
imperative and its visibility is `unknown` forever.**

```ts
@Injectable()
export class OrdersReadGuard implements CanActivate {
  canActivate(): boolean {
    /* your real check, unchanged */ return true;
  }

  describeVisibility(): { anonymous: "no"; policies: string[] } {
    return { anonymous: "no", policies: ["OrdersRead"] };
  }
}
```

`unknown` is not a denial: with the default `visibility.onUnknown` (`"show"` unless a
`toolAuthorizer` is bound) the tool still appears, flagged `authUncertain`. When the guards cannot
declare themselves, `visibility.tier = "probe"` resolves them by really running them — at a cost.
The full recipe, including `visibility.probeValues`, is in the docs site's
_How to declare visibility for a NestJS guard_.

### A host authorizer

When authorization is your own code — permission keys read from a database, a dispatching handler
that checks the target method inside — neither guards nor probes can say what a caller may use.
Bind a `ToolAuthorizer` and its answer outranks every other tier:

```ts
SezzleeModule.forRoot(configure, {
  toolAuthorizer: {
    useFactory: (permissions: PermissionService) => ({
      covers: () => true,
      async resolve(request) {
        const granted = await permissions.forRequest(request);
        return {
          decide: (tool) =>
            granted.has(
              tool.member?.key ?? `${tool.container}.${tool.handler.name}`,
            )
              ? "allow"
              : "deny",
        };
      },
    }),
    inject: [PermissionService],
  },
});
```

`resolve` runs once per caller scope and the resulting `ToolAccess` is held in process memory for
`cache.lifetimeMs`, concurrent callers of a scope sharing one resolution; `decide` is then asked per
tool and has to be cheap and synchronous. `SezzleeCacheInvalidator.invalidateCaller(scope)` drops a
scope's access early, so a scope that carries the caller's permission version needs no other signal.
`McpToolInfo` carries `name`, `method`, `route`, `container` and `handler`, and `member: { source,
key }` for a tool lowered from a family source. `"allow"` and `"deny"` are final; `"unknown"` falls
through to the declarative tier, then the probe tier.

With an authorizer bound, `visibility.onUnknown` defaults to `"hide"`, a tool it denies is answered
by `load_tool` exactly like a tool that does not exist, and the tags vocabulary and the
`search_tools` limit are computed from the tools the caller may use. `invoke_tool` never consults
visibility: the authorizer and the probe shape what `search_tools` and `load_tool` show, and your
pipeline alone decides every call. Visibility is not enforcement.

`covers(tool)` is caller-independent. After each catalog build, when an authorizer is bound, the
SDK reports a `visibility_uncovered` warning naming the first twenty selected tools that no tier can
decide: not covered, guards imperative or anonymity unknown, and no probe tier to reach them. Set
`visibility.onUncovered = "fatal"` to make that fail the catalog; it also turns the check on for a
host without an authorizer. Debug logs on the `CallerVisibilityProvider` and `Sezzlee` loggers time
the authorizer's resolution (hit or miss) and each `search_tools` and `load_tool` answer.

### Probing until the page fills

With `visibility.tier = "probe"`, `search_tools` walks the ranked candidates in order and decides
each one: the authorizer, then the guards' declarations, then — for a tool still unknown — a probe
request through the real pipeline. A tool that is denied is skipped and the walk goes on, so the page
fills from the tools the caller may use however far down the ranking they sit, and a hidden tool
never shortens a page. Probes run `visibility.probeConcurrency` at a time (default 4) for the
candidates just ahead; once the page is full no more are sent, and the few still in flight finish
into the cache. `total` and the `tags` vocabulary come from the tools the cheaper tiers can decide
and never probe, so a tag reachable only through tools that need a probe follows `onUnknown`.
`load_tool` probes just the tool it names; `invoke_tool` never probes.

| Option                          | Default | Meaning                                                                                                                                                                                                                                                                         |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visibility.maxProbesPerSearch` | `50`    | The most probe requests one search sends; a non-negative integer, `0` stops search from probing. At the cap the page is returned as it stands, the tools left unprobed follow `onUnknown`, and one warning names the cap. A cached verdict does not count. Replaces `probeTopK` |

An `allow` or `deny` verdict is kept in the shared cache for `cache.lifetimeMs`, as before, and
`SezzleeCacheInvalidator` drops it with the rest of the scope.

Only a 401 or 403 is a `deny`. A 429, a 5xx, a probe that timed out or was cancelled, and any other
answer that is not the interceptor's short-circuit are `unknown` and transient: nothing is cached
and the next search probes the tool again. A probe disables a tool for the rest of the catalog
generation only when it says the probe cannot work for it — the route did not match (declare a
value in `visibility.probeValues`), or a 2xx came back without the short-circuit marker, which means
the handler may have run. A probe's deadline is `invoke.timeoutMs`.

A probe is a real request through your guards, middleware and filters, with the handler skipped. Skip
the side effects that should not count a probe — rate limiting, audit logs, last-seen updates — by
asking `isSezzleeProbe(request)`, exported from the package, which is `true` on the synthetic request
of a probe and `false` on any other, including a real `invoke_tool` dispatch (`isSezzleeRequest` is
`true` for both):

```ts
import { isSezzleeProbe } from "@sezzlee/sdk-nestjs";

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (isSezzleeProbe(context.switchToHttp().getRequest())) {
      return next.handle();
    }
    /* record the call */
  }
}
```

A rate limiter that counts probes will answer 429 for them, which keeps those tools unknown.

### Auditing visibility in your tests

`search_tools` and `load_tool` decide from your authorizer and your guards' declarations; the
pipeline decides every real call. `auditVisibility` from `@sezzlee/sdk-nestjs/testing` checks the
two against each other, for each caller you name and each tool in the catalog, so a permission
change that only one side learns about fails a test instead of surfacing in production.

```ts
import { auditVisibility } from "@sezzlee/sdk-nestjs/testing";

it("shows each caller exactly what the pipeline lets through", async () => {
  const report = await auditVisibility(
    app,
    [
      { name: "clerk", headers: { authorization: `Bearer ${clerkToken}` } },
      { name: "auditor", headers: { authorization: `Bearer ${auditorToken}` } },
    ],
    {
      exclude: (tool) => tool.container === "MethodDispatcher",
    },
  );
  report.ensureConsistent();
});
```

The listing side runs the cheap tiers only, through the same code the tools use: the authorizer,
then the guards' declarations, then `visibility.onUnknown`, with no probe. The other side sends one
probe per tool and caller, a request through your middleware, guards, pipes and interceptors that
stops before the handler, uncached and not limited by `maxProbesPerSearch`. It never reads or writes
the shared verdict cache. Each pair ends as one of:

| Finding            | Meaning                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `listedButDenied`  | Listed, but the probe got a 401 or 403                                                                                      |
| `hiddenButAllowed` | Hidden, but the probe got through                                                                                           |
| `notComparable`    | The probe could not judge it (no request template, probing disabled for the tool, a 429, a 5xx, a timeout), with a `reason` |
| `excluded`         | Skipped by `exclude`                                                                                                        |

`report.findings` lists every pair that is not consistent, `report.counts` totals each kind, and
`report.consistent` and `report.compared` count the rest. `ensureConsistent()` throws a
`VisibilityAuditError` that groups the findings by kind, and it fails on `notComparable` too: a pair
the probe could not judge was not checked. Declare a `visibility.probeValues` entry for a route the
probe could not reach, or `exclude` the tool. `concurrency` (default 4) bounds the probes in flight.

The probe stops before the handler, so a check inside a handler, such as a dispatcher that validates
its target method, is invisible to it. A tool your authorizer hides for that reason shows as
`hiddenButAllowed`; skip it with `exclude`, which reports it as `excluded` rather than dropping it. A
probe that does not route, or that returns a 2xx without the short-circuit marker, disables probing
for that tool until the catalog changes, as it would during a search.

A probe that throws instead of answering, such as an application whose pipeline is not set up for probing, fails the audit with that error rather than being reported once per tool.

## 4b. Rate limiting

A host's HTTP limiter runs before the MCP body is read, so it can only count requests, and the only
answer it has is a 429, which some MCP clients answer by dropping the session. The SDK limits
`tools/call` after it has parsed the call, per caller, and refuses with a normal tool result the
agent can read. With nothing configured no wrapper runs and nothing changes.

```ts
SezzleeModule.forRoot((options) => {
  options.rateLimiting = {
    default: {
      kind: "tokenBucket",
      tokenLimit: 120,
      tokensPerPeriod: 2,
      periodMs: 1_000,
    },
    invoke: { kind: "fixedWindow", permitLimit: 30, windowMs: 60_000 },
    invokeConcurrency: 4,
  };
});
```

`default` covers every meta-tool without a section of its own, and a host tool registered beside
them (below). `search`, `load`, `invoke` and `read` each replace it for that meta-tool and get a bucket of
their own; the rest share one. `invokeConcurrency` also holds an `invoke_tool` call's lease until
its answer is mapped, whatever way the call ends. The limiters are in-memory and per process: a
token bucket, a fixed window, a sliding window (`segmentsPerWindow`) and a concurrency limit. They
never queue and run no timer, and a limiter idles out of memory once it has refilled to full, so
the state follows the callers active now. The settings are plain data, so they can be read from
configuration.

The key is the caller scope key by default. That fits only while the key stays the same for one
caller: a scope key that carries a permission version starts a fresh bucket on every change, which
hands a caller whose permissions change often extra permits. The scope key is also derived from the
identity carrier headers, so it is safe only when the MCP endpoint rejects unauthenticated requests:
on an endpoint that admits anonymous calls, a caller can send a different header on every call and
start each one with a full bucket. In both cases give a key the caller cannot change at will and keep
the declared limits:

```ts
options.rateLimiting = {
  default: { kind: "concurrency", permitLimit: 8 },
  key: (call) => call.request?.auth?.clientId ?? call.callerScope,
};
```

For anything else, a partition function replaces the declared limits, and setting both is a startup
error. It is called once per call and returns zero or more partitions, each a key and the factory of
its limiter. A call is admitted only when every partition grants a permit, taken in order; the ones
already taken are released at the first refusal, and the refusal carries that partition's retry-after.
Implement `RateLimiter` to back a partition with a distributed limiter such as Redis. `isIdle` is
required, because the registry keeps one limiter per key and evicts it once it reports idle, at a
sweep every ten seconds at most; a limiter whose state lives elsewhere returns `true`. `dispose` is
optional.

```ts
options.rateLimiting = {
  partition: (call) => [
    {
      key: `tenant:${tenantOf(call.request)}`,
      create: () =>
        createSlidingWindowLimiter({
          permitLimit: 600,
          windowMs: 60_000,
          segmentsPerWindow: 6,
        }),
    },
    {
      key: `caller:${call.callerScope}`,
      create: () => createConcurrencyLimiter({ permitLimit: 4 }),
    },
  ],
};
```

`McpCallContext` carries the outer `request`, the `metaTool` (`search`, `load`, `invoke`, `read`
for `read_result`, or `other`), the `target` a `load_tool` or `invoke_tool` call names as `McpToolInfo`, and the
`callerScope`. The target comes from the catalog **without** visibility and is `undefined` when
`name` is missing, not a string or unknown. The limit is taken first: a call naming a hidden or
unknown tool consumes a permit, so names cannot be enumerated for free.

A refused call answers `isError: true` with `rate_limit_exceeded`, `retryable: true` and, when the
limiter gives one, `retryAfterSeconds` rounded up to whole seconds. It is distinct from the backend's
`rate_limited`: the call never reached the backend. A host tool registered on the same server, in
`serve`'s `extend` hook, is limited by wrapping its handler:

```ts
endpoint.serve({
  name: "your-api",
  version: "1.0.0",
  extend: (server, deps) => {
    server.registerTool(
      "health",
      { description },
      rateLimitHostTool(deps, "health", handler),
    );
  },
});
```

One gap: a `search_tools` call whose arguments the MCP framework itself rejects, such as a `limit`
that is not an integer, is answered before the SDK sees it and consumes no permit. It runs nothing.
The rules are in [rate-limiting.md](../../packages/http/spec/rate-limiting.md).

## 5. Connecting an MCP client

The endpoint speaks Streamable HTTP. `tools/list` returns only four meta-tools:

| Tool           | Job                                                        |
| -------------- | ---------------------------------------------------------- |
| `search_tools` | Finds operations by keyword, returns cards                 |
| `load_tool`    | Returns one operation's full input schema                  |
| `invoke_tool`  | Calls it                                                   |
| `read_result`  | Reads part of an answer that was too large to return whole |

`invoke_tool` answers at most `options.invoke.maxResponseBytes` (256 KiB). A success over that is
kept by the result store and answered with a handle and an outline of the body; the agent reads the
parts it needs with `read_result`, by JSON Pointer, selected members and a window. A handle is
readable only by the caller scope it was issued to, and only while that caller can still see the
tool. The caller scope is a digest of the identity carriers (`authorization` by default), so callers
told apart by something else, such as a session cookie, share one scope: forward that header with
`identity.forward()` or bind a `callerScopeResolver`. The SDK warns once when it stores a result for
a call that carries none of them. The default store keeps each result in memory for `options.results.lifetimeMs` (ten minutes),
at most `options.results.maxCallerBytes` (16 MiB) per caller and `options.results.maxBytes`
(64 MiB) in all, dropping the oldest first. Bind your own `ResultStore` for several replicas, or
`null` to refuse over-budget answers as before and drop `read_result`:

```ts
SezzleeModule.forRoot(configure, { resultStore: { useValue: null } });
```

A body larger than `options.invoke.maxBufferedBytes` (16 MiB) is refused while your handler writes
it, so a runaway endpoint cannot fill the process's memory. The rules are in
[result-reading.md](../../packages/http/spec/result-reading.md).

The catalog is not dumped into `tools/list`: on a 700-endpoint backend that drowns the agent's
context. The agent searches, then loads, then calls.

`search_tools` takes `query`, `limit`, `detail` and `tags`. `tags` narrows the answer to operations
carrying every tag listed, matched whole and insensitive to case and accents; every answer carries
the vocabulary the caller may see, so the agent reads a tag rather than guessing one. Each operation
is tagged as `@nestjs/swagger` tags it — the controller's `@ApiTags`, or its name when it has none,
followed by the handler's `@ApiTags` — unless you say otherwise:

```ts
@McpTool({ name: "find_orders", tags: ["billing", "read"] })
```

A declaration replaces the controller-derived tag rather than adding to it, and `options.tags` sets
the same thing centrally for controllers you cannot decorate. Tags are search text too, so changing
them changes ranking — see the how-to on grouping operations. `options.endpointTags` decides per
endpoint instead: it receives `{ method, route, container, handler, declared }` (here `declared` is
the description the tool is published with), sits below a declaration and above `options.tags`, and
returning `undefined` keeps the next level. `options.endpointSearchTerms` does the same for search
terms.

Words an agent may type that your operation's text does not contain go in `searchTerms`
(`@McpTool({ searchTerms: ["sipariş"] })`, or `options.searchTerms` centrally): indexed like the
description, never a filter key, never shown to the agent. To rank with your own retriever instead
of BM25, bind a `ToolRanker` through `forRoot`'s overrides (`{ toolRanker: { useClass: MyRanker } }`);
`options.search.rankerTimeoutMs` (10000 by default) and `options.search.onRankerFailure`
(`"fallback"` or `"error"`) govern it. Visibility, the tag filter and the payload budget still apply
to its answer — see the how-to on plugging in your own search.

When an operation's behaviour changes behind an unchanged schema, raise its revision
(`@McpTool({ revision: 2 })` on the method, on the controller for every method in it, or
`options.revision` for the whole catalog). The revision enters the tool version, so during a rolling
deploy a call pinned to the old version is refused with `tool_changed` instead of running against
the new behaviour. The levels add up rather than replacing one another — see the how-to on shipping
a behaviour change mid-deploy.

This repository ships a client:

```bash
SEZZLEE_BASE_URL=http://127.0.0.1:3000 SEZZLEE_AUTH=token SEZZLEE_USER=alice \
  node sdks/nestjs/samples/agent-client/dist/main.js --scenario smoke --query "create order"
```

To protect `/mcp`, set `options.resourceServer` and the module installs bearer verification plus
the RFC 9728 metadata handler for you.

## 6. Troubleshooting

| Symptom                                                     | Cause                                                               | Fix                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `search_tools` always empty                                 | `selection.default` is `exclude` and nothing is decorated           | Add `@McpTool()`, or set `selection.default = "include"`                        |
| Everything comes back `authUncertain`                       | A guard without `describeVisibility()`, or `tier` still declarative | Declare the guards, or set `visibility.tier = "probe"`                          |
| Catalog empty, decorators appear to do nothing              | `reflect-metadata` not imported first                               | Make it the first import in `main.ts`                                           |
| Startup throws resolving a provider                         | `app.use(...)` before `app.init()`                                  | `await app.init()` first                                                        |
| No PRM document, 401 carries no pointer                     | `resourceServer` unset                                              | Set `options.resourceServer`; check `/.well-known/oauth-protected-resource/mcp` |
| `GET /mcp` returns 405                                      | The transport has no sessions to stream                             | Expected. Use `POST`                                                            |
| Host will not boot, `query_parser_not_extended`             | A tool writes `?filter[x]=` and Express parses queries as `simple`  | `app.set('query parser', 'extended')`, or declare `objectNotation`              |
| Clients never hear that the catalog changed                 | `streamableHttp.serve(...)` called per request                      | Call it once in the controller's constructor and keep the handler               |
| Host will not boot, fatal diagnostic                        | `name_collision` / `ambiguous_selection` / `invalid_name`           | Read the codes in the log, then `options.diagnostics.downgrade`                 |
| A tool is missing and `unresolved_query_shape` was reported | Its `@Query()` type carries no readable members                     | Decorate the DTO, declare `options.schema.typeShape`, or downgrade the code     |
| PRM 404s under a global prefix                              | `prm_path_prefixed` — Nest prefixed the `.well-known` path          | Add the metadata path to `setGlobalPrefix`'s `exclude` list                     |

## 7. What's next

- The docs site: `pnpm --filter @sezzlee/docs dev` → `http://localhost:5180`
- [samples/demo-api](samples/demo-api) — an endpoint matrix: anonymous,
  identity-only, policy, role, imperative ownership, and a POST with path, query and body
