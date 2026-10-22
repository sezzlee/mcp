# Configuration entry points

Signatures only: what you call, what it returns, and where the options themselves are defined.
There are no output examples on this page by design — nothing here produces output.

Verified against `@sezzlee/sdk-nestjs` `1.0.0`. This surface has no generator, so it is hand-maintained and may lag a release.

## Module

```ts
SezzleeModule.forRoot(
  configure?: (options: SezzleeOptions) => void,
  overrides?: ExtensionOverrides,
): DynamicModule

SezzleeModule.forRootAsync(asyncOptions: {
  imports?: DynamicModule["imports"];
  inject?: InjectionToken[];
  useFactory: (...args: never[]) => SezzleeOptions | Promise<SezzleeOptions>;
  overrides?: ExtensionOverrides;
}): DynamicModule
```

`forRoot` takes a **callback that mutates an options instance**, not an options literal. This is
the most common miswiring in the SDK: passing an object configures nothing.

The module is `@Global()`. When `resourceServer` is set it also installs the PRM handler and bearer
verification on the MCP path itself.

Curation:

```ts
McpVariant(options: McpVariantOptions): MethodDecorator
McpToolFamily(options: McpToolFamilyOptions): MethodDecorator

const hidden: {
  value(value: JsonValue): ArgumentRule;
  from(source: string): ArgumentRule;
  omit(): ArgumentRule;
};

function curate<T>(rules: ArgumentRules<T>): ArgumentRules<T>;
```

`curate<T>()` key-checks the record against a DTO's own keys at compile time; `arguments` accepts a
plain record without it. `options.arguments` carries `provide`, `curate`, `everywhere` and `seal`.
`options.families` carries `provide`, `loadTimeoutMs`, `loadMode`, `refreshIntervalMs` and
`onFailure`; the member shape is `McpFamilyMember`. `options.description` describes an endpoint
below `@McpTool({ description })`.

`options.query.grouping` (`"flatten"` by default, `"group"` to opt in) decides whether a whole-object query binding stays one argument or is
flattened into its members; see
[curating the arguments an agent sees](/docs/http-catalog/curate-the-arguments-an-agent-sees).

The module maps no route. You write the MCP route:

```ts
SezzleeStreamableHttp.handle(
  req: Request,
  res: Response,
  createServer: () => McpServer,
): Promise<void>

registerSezzleeTools(server: McpServer, deps: MetaToolDependencies): () => void
```

`MetaToolDependencies` is `{ catalog, dispatcher, mapper, visibility, scopes, options }` —
injectable as `SezzleeCatalog`, `SezzleeDispatcher`, `extensionTokens.invokeResultMapper`,
`CallerVisibilityProvider`, `extensionTokens.callerScopeResolver` and `SEZZLEE_OPTIONS`. The
quickstart has the whole controller:
[Expose your backend's endpoints to an agent](/docs/http-catalog/quickstart).

Selection markers:

```ts
@McpTool(options?: {
  name?: string; prefix?: string; description?: string;
  body?: JsonSchemaObject;
  responses?: Record<string, NewableFunction | [NewableFunction] | { schema } | {}>;
  consumes?: string;
  files?: Record<string, { multiple?; required?; description?; mediaType? }>;
  readOnly?: boolean; destructive?: boolean; idempotent?: boolean;
  revision?: number;
})
@McpIgnore()
```

`options.revision` and `options.containerRevision` declare the catalog and container revisions
that `@McpTool({ revision })` declares on a class or a method.

Guard declaration, read once at catalog build time:

```ts
interface VisibilityDeclaration {
  readonly anonymous?: "yes" | "no" | "unknown";
  readonly policies?: readonly string[];
}
```

`options.files.resolver` binds the file resolver, and `options.invoke.maxInlineFileBytes` and
`options.invoke.maxFileBytes` are the budgets.

Option fields and defaults are in
[`options.ts`](https://github.com/sezzlee/mcp/blob/main/sdks/nestjs/src/options.ts);
this page does not copy them.

## Extension points

Six internals are replaceable, addressed by `extensionTokens` and overridden through `forRoot`'s
second argument (`useClass`, `useFactory` or `useValue`):

```text
cache · callerScopeResolver · invokeResultMapper · visibilityEvaluator · probeEvaluator · toolRanker
```

`toolRanker` defaults to none, which keeps BM25. Bound, it replaces the ranking of a non-empty
`search_tools` query; `options.search.rankerTimeoutMs` and `options.search.onRankerFailure` govern
it. See
[replacing the ranking](/docs/http-catalog/help-an-agent-find-the-right-tool#replace-the-ranking).

Cache invalidation is a service, not an option:

```ts
SezzleeCacheInvalidator.invalidateCaller(...) | invalidateTag(...) | invalidateAll()
```

Each token names an internal the host may replace; the shapes they expect are in the SDK's own
source, next to the token definitions.

## Catalog reload

```ts
SezzleeCatalog.reload(): Promise<void>
```

Rebuilds the catalog, bumps the generation counter, and fires the change listeners that re-stamp
`_meta` and send `notifications/tools/list_changed`. See
[meta-tool contract](/docs/http-catalog/meta-tool-contract). With no family source registered the
rebuild has happened by the time the call returns. With one, members are loaded first,
reloads run one at a time, and a rebuild that would turn a valid catalog fatal is refused — the
promise rejects with `SezzleeCatalogError` — and the current catalog is kept.
