# @sezzlee/sdk-nestjs

An MCP layer that embeds into your existing NestJS backend. It exposes your endpoints to agents as
a search-first tool catalog and replays each call through **your own** pipeline, so your guards,
pipes and interceptors keep running unchanged. Not a gateway, not duplicated business logic.

> Status: `0.1.0`, alpha; breaking changes are possible. [samples/demo-api](samples/demo-api) is
> the reference wiring.

## Requirements

- NestJS 10 or later (`@nestjs/common`, `@nestjs/core`), dev-tested against 11.x
- `@modelcontextprotocol/server`, `@modelcontextprotocol/node` and `@modelcontextprotocol/express`
  2.0 or later, `rxjs` 7 and `zod` 4
- `class-validator` and `class-transformer` are optional; when installed, their decorators shape
  the argument schemas
- Node 22 or later, Express as the HTTP adapter

Peers are peers on purpose: sezzlee uses your Nest and your MCP SDK, not its own copies.

## 1. Install

```bash
pnpm add @sezzlee/sdk-nestjs
```

## 2. Wiring — three pieces

The .NET SDK is three method calls. This one is three _pieces_, because a Nest controller is your
code and a module cannot add a route to it.

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

**The MCP controller.** Copy this; the seven injections are not guessable.

```ts
@Controller()
export class McpController {
  constructor(
    private readonly streamableHttp: SezzleeStreamableHttp,
    private readonly catalog: SezzleeCatalog,
    private readonly dispatcher: SezzleeDispatcher,
    private readonly visibility: CallerVisibilityProvider,
    @Inject(extensionTokens.invokeResultMapper)
    private readonly mapper: InvokeResultMapper,
    @Inject(extensionTokens.callerScopeResolver)
    private readonly scopes: CallerScopeResolver,
    @Inject(SEZZLEE_OPTIONS) private readonly options: SezzleeOptions,
  ) {}

  @All("mcp")
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.streamableHttp.handle(req, res, () => {
      const server = new McpServer({ name: "your-api", version: "0.0.0" });
      registerSezzleeTools(server, {
        catalog: this.catalog,
        dispatcher: this.dispatcher,
        mapper: this.mapper,
        visibility: this.visibility,
        scopes: this.scopes,
        options: this.options,
      });
      return server;
    });
  }
}
```

`@All` rather than `@Post`: the default session mode is `stateless`, and the transport wants to
answer `GET`/`DELETE` with `405` itself instead of letting Nest return `404`.

**The bootstrap.**

```ts
import "reflect-metadata"; // must be the first import in the process

const app = await NestFactory.create(AppModule);
app.useGlobalPipes(new ValidationPipe({ transform: true }));

await app.init(); // before any app.get(...) / app.use(...)
await app.listen(3000);
```

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

NestJS has no equivalent of ASP.NET's description metadata, so `@McpTool({ description })` is how
an agent gets something to search against. Input schemas come from your `class-validator` DTOs and
your pipes: `ParseIntPipe` yields an integer, `@Min`/`@Max` become `minimum`/`maximum`.

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
can be read (`@Query() q: Record<string, unknown>`, or a DTO with no `class-validator` decorators)
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
  version header, so dispatch lands on the default version. URI versioning has no such gap.

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
key, name, description, body schema — loaded in `onApplicationBootstrap` and on every `reload()`,
which now returns a promise; the key is written into the route and never reaches the agent. Full
guide: the docs site's _How to expose a dispatching endpoint as one tool per method_.

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
class can express, or `{}` for a status with no body. A DTO needs class-validator decorators, the
same as a request DTO.

If you already write `@ApiOkResponse({ type: OrderResponse })`, it is read as a fallback, and a sync
handler's plain class return type is read as a last resort. The declaration wins over both.

Only one status becomes the schema — `200`, `201`, `202`, `204` in that order, then the lowest
remaining `2xx`. A non-object root is wrapped under `result`, because MCP requires an object. Unlike
the input side, read-only members are kept: they are what a response is made of.

Full guide: the docs site's _How to tell the agent what a tool returns_.

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

`unknown` is not a denial: with the default `visibility.onUnknown: "show"` the tool still appears,
flagged `authUncertain`. When the guards cannot declare themselves, `visibility.tier = "probe"`
resolves them by really running them — at a cost. The full recipe, including
`visibility.probeValues`, is in the docs site's
_How to declare visibility for a NestJS guard_.

## 5. Connecting an MCP client

The endpoint speaks Streamable HTTP. `tools/list` returns only three meta-tools:

| Tool           | Job                                        |
| -------------- | ------------------------------------------ |
| `search_tools` | Finds operations by keyword, returns cards |
| `load_tool`    | Returns one operation's full input schema  |
| `invoke_tool`  | Calls it                                   |

The catalog is not dumped into `tools/list`: on a 700-endpoint backend that drowns the agent's
context. The agent searches, then loads, then calls.

`search_tools` takes `query`, `limit`, `detail` and `tags`. `tags` narrows the answer to operations
carrying every tag listed, matched whole and insensitive to case and accents; every answer carries
the vocabulary the caller may see, so the agent reads a tag rather than guessing one. Each operation
is tagged with its controller name unless you say otherwise:

```ts
@McpTool({ name: "find_orders", tags: ["billing", "read"] })
```

A declaration replaces the controller-derived tag rather than adding to it, and `options.tags` sets
the same thing centrally for controllers you cannot decorate. Tags are search text too, so changing
them changes ranking — see the how-to on grouping operations.

Words an agent may type that your operation's text does not contain go in `searchTerms`
(`@McpTool({ searchTerms: ["sipariş"] })`, or `options.searchTerms` centrally): indexed like the
description, never a filter key, never shown to the agent. To rank with your own retriever instead
of BM25, bind a `ToolRanker` through `forRoot`'s overrides (`{ toolRanker: { useClass: MyRanker } }`);
`options.search.rankerTimeoutMs` (10000 by default) and `options.search.onRankerFailure`
(`"fallback"` or `"error"`) govern it. Visibility, the tag filter and the payload budget still apply
to its answer — see the how-to on plugging in your own search.

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
| `GET /mcp` returns 405                                      | `transport.sessionMode` is `stateless` (the default)                | Expected. Use `POST`, or switch to `stateful`                                   |
| Host will not boot, fatal diagnostic                        | `name_collision` / `ambiguous_selection` / `invalid_name`           | Read the codes in the log, then `options.diagnostics.downgrade`                 |
| A tool is missing and `unresolved_query_shape` was reported | Its `@Query()` type carries no readable members                     | Decorate the DTO, declare `options.schema.typeShape`, or downgrade the code     |
| PRM 404s under a global prefix                              | `prm_path_prefixed` — Nest prefixed the `.well-known` path          | Add the metadata path to `setGlobalPrefix`'s `exclude` list                     |

## 7. What's next

- The docs site: `pnpm --filter @sezzlee/docs dev` → `http://localhost:5180`
- [samples/demo-api](samples/demo-api) — the same endpoint matrix as the .NET sample: anonymous,
  identity-only, policy, role, imperative ownership, and a POST with path, query and body
