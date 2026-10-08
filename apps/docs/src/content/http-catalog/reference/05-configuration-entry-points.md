# Configuration entry points

Signatures only: what you call, what it returns, and where the options themselves are defined.
There are no output examples on this page by design — nothing here produces output.

Verified against `Sezzlee.AspNetCore` `0.1.0-alpha.1` and `@sezzlee/sdk-nestjs` at the current
workspace version. This surface has no generator, so it is hand-maintained and may lag a release.

## ASP.NET Core

Three calls, in this order.

```csharp
IServiceCollection AddSezzlee(this IServiceCollection services, Action<SezzleeOptions>? configure = null)
IApplicationBuilder UseSezzleeCapture(this IApplicationBuilder app)
IEndpointConventionBuilder MapSezzlee(this IEndpointRouteBuilder endpoints, string pattern = "/mcp")
```

`AddSezzlee` also registers `AddEndpointsApiExplorer()`, decorates the authorization result handler
so probes can short-circuit, and calls `AddMcpServer().WithHttpTransport()`. Options are validated
at startup.

`MapSezzlee` returns `IEndpointConventionBuilder`, which is why endpoint conventions compose:

```csharp
app.MapSezzlee("/mcp").RequireAuthorization();
```

It throws at startup if `UseSezzleeCapture()` was never registered.

Selection markers:

```csharp
[McpTool]      // Name, Prefix, ReadOnly, Destructive, Idempotent
[McpIgnore]
interface IMcpSelectionMetadata { bool Include { get; } }
```

`IMcpSelectionMetadata` is public, so a host can attach selection through its own metadata type.
`[McpTool(Consumes = "...")]` names a body media type discovery would not choose.

File resolution is a service, not an option: register an `ISezzleeFileResolver` and file arguments
offer `ref`. The budgets are `Invoke.MaxInlineFileBytes` and `Invoke.MaxFileBytes`; see
[how to accept form bodies and file uploads](/docs/http-catalog/accept-form-and-file-uploads).

Response types are read from ApiExplorer — `[ProducesResponseType(typeof(T), 200)]`, `Produces<T>()`
or an action return type MVC can infer — so there is no `[McpTool]` field for them. NestJS has no
ApiExplorer equivalent and needs the `responses` option above; see
[telling the agent what a tool returns](/docs/http-catalog/tell-the-agent-what-a-tool-returns).

Curation markers:

```csharp
[McpArgument("q", Name = "keyword", Description = "...")]   // rename, re-describe
[McpArgument("tenantId", Hidden = true, ValueFrom = "...")] // hide: provider, Value, or ValueJson
[McpToolVariant("name", "description")]                     // one of several tools per operation
[McpToolFamily("methodId", Source = "...")]                 // one tool per method behind a dispatcher
```

`options.Families.Provide(name, source)` registers a family's member source, and
`Families.LoadTimeout` bounds each load; see
[how to expose a dispatching endpoint as one tool per method](/docs/http-catalog/expose-a-dispatching-endpoint-as-one-tool-per-method).

`McpArgumentAttribute` also targets a parameter or a DTO property, where the member names the
argument. At most one of `Value`, `ValueJson` and `ValueFrom` may be set, and none without
`Hidden = true`.

Option groups are thirteen properties on `SezzleeOptions` — `Identity`, `Synthetic`, `Selection`,
`Query`, `Schema`, `Naming`, `Visibility`, `Cache`, `Errors`, `ResourceServer`, `Diagnostics`, `Arguments`, `Families`. Their fields
and defaults are in
[`SezzleeOptions.cs`](https://github.com/sezzlee/mcp/blob/main/sdks/dotnet/src/Sezzlee.AspNetCore/SezzleeOptions.cs);
this page does not copy them.

## NestJS

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

Curation on the NestJS side:

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
`options.families` carries `provide` and `loadTimeoutMs`; the member shape is `McpFamilyMember`.

`options.query.grouping` (`"flatten"` by default, `"group"` to opt in) and its ASP.NET twin
`options.Query.Grouping` decide whether a whole-object query binding stays one argument or is
flattened into its members; see
[curating the arguments an agent sees](/docs/http-catalog/curate-the-arguments-an-agent-sees).

There is no `MapSezzlee` equivalent. You write the MCP route:

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
})
@McpIgnore()
```

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
[`options.ts`](https://github.com/sezzlee/mcp/blob/main/sdks/nestjs/src/options.ts).
The two option trees are not the same shape — the NestJS tree has a `transport` group the .NET one
does not — so read each SDK's own file rather than assuming parity.

## Extension points

Six internals are replaceable, addressed by `extensionTokens` and overridden through `forRoot`'s
second argument (`useClass`, `useFactory` or `useValue`):

```text
cache · callerScopeResolver · invokeResultMapper · visibilityEvaluator · probeEvaluator · toolRanker
```

`toolRanker` defaults to none, which keeps BM25. Bound, it replaces the ranking of a non-empty
`search_tools` query; `options.search.rankerTimeoutMs` and `options.search.onRankerFailure` govern
it. The ASP.NET Core equivalent is an `IToolRanker` registered in DI, with `options.Search`. See
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

```csharp
ISezzleeCatalogChangeSource.ReloadAsync(CancellationToken cancellationToken = default): ValueTask
```

Rebuilds the catalog, bumps the generation counter, and fires the change listeners that re-stamp
`_meta` and send `notifications/tools/list_changed`. See
[meta-tool contract](/docs/http-catalog/meta-tool-contract). With no family source registered the
NestJS rebuild has happened by the time the call returns. With one, members are loaded first,
reloads run one at a time, and a rebuild that would turn a valid catalog fatal is refused — the
promise rejects, or the task throws, with `SezzleeCatalogError` / `SezzleeCatalogException` — and the
current catalog is kept.
