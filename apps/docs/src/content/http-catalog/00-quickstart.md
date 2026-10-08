# Expose your backend's endpoints to an agent

The ASP.NET Core and NestJS SDKs turn the endpoints you already wrote into a searchable tool catalog. An agent finds an endpoint, reads its schema and calls it through your own authorization pipeline, with no second service to keep in sync.

You work inside this repository's sample backend, so the SDK is already referenced. To add the package to your own ASP.NET Core project instead, the install steps are in [`sdks/dotnet/README.md`](https://github.com/sezzlee/mcp/blob/main/sdks/dotnet/README.md).

## 1. Register the SDK

:::tabs

```csharp title="ASP.NET Core"
builder.Services.AddSezzlee();

var app = builder.Build();

app.UseSezzleeCapture();

app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();
app.MapSezzlee("/mcp");
```

```ts title="NestJS"
@Module({
  imports: [
    SezzleeModule.forRoot((options) => {
      options.visibility.tier = "probe";
    }),
  ],
  controllers: [AuthController, OrdersController, McpController],
})
export class AppModule {}
```

:::

On ASP.NET Core this is `DemoApi`'s `Program.cs`, and it is the whole integration. `AddSezzlee()` registers discovery, `UseSezzleeCapture()` takes a handle on the pipeline, and `MapSezzlee("/mcp")` serves the MCP endpoint. Put `UseSezzleeCapture()` before `UseRouting`, `UseAuthentication` and `UseAuthorization`. Agent calls are replayed into the pipeline from that point on.

On NestJS this is the `demo-api` sample's `app.module.ts`. `forRoot` takes a callback that mutates an options object, not an options literal.

## 2. Mount `/mcp`

ASP.NET Core did this already with `MapSezzlee`. Skip to step 3.

NestJS does not map the endpoint for you. You write the controller, because a module cannot add a route to a class you own:

```ts
@Controller()
export class McpController {
  private readonly serve: SezzleeRequestHandler;

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
  ) {
    this.serve = this.streamableHttp.serve(() => {
      const server = new McpServer({ name: "demo-api", version: "0.0.0" });
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

  @All("mcp")
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.serve(req, res);
  }
}
```

`SezzleeModule` is global, so the providers need no extra import. Bind the handler once, in the constructor. Then bootstrap in this order in `src/main.ts`:

```ts
import "reflect-metadata";
// ...
const app = await NestFactory.create(AppModule);
app.useGlobalPipes(new ValidationPipe({ transform: true }));

await app.init();

app.use(mcpAuthRouter({ provider: app.get(DemoOAuthProvider), ... }));
await app.listen(3000);
```

## 3. Describe one endpoint

Nothing is exposed by default. `[McpTool]` or `@McpTool()` on a class opts the controller in. A description on the method is what an agent searches against.

:::tabs

```csharp title="ASP.NET Core"
[HttpGet("/orders/{id:int}")]
[Authorize(Policy = "OrdersRead")]
[Description("Fetches one order by id.")]
public IActionResult GetOrder([Description("Order id")] int id) =>
    Orders.TryGetValue(id, out var order) ? Ok(order) : NotFound();
```

```ts title="NestJS"
@Controller()
@McpTool()
export class OrdersController {
  @Post("orders")
  @UseGuards(JwtGuard)
  @McpTool({ description: "Creates a new order." })
  create(@Body() dto: CreateOrderDto): Order { ... }
}
```

:::

sezzlee reads ASP.NET's own `[Description]` metadata, so there is no second copy to write. On NestJS the `class-validator` decorators on `CreateOrderDto` become the input schema. In both, the authorization line is untouched and runs when the agent calls.

## 4. Run it

:::tabs

```sh title="ASP.NET Core"
dotnet run --project sdks/dotnet/samples/DemoApi
```

```sh title="NestJS"
pnpm turbo run build --filter=@sezzlee/demo-nestjs
node sdks/nestjs/samples/demo-api/dist/main.js
```

:::

The backend reports what it found:

:::tabs

```text title="ASP.NET Core"
info: Sezzlee.AspNetCore.SezzleeCatalogProvider[0]
      sezzlee catalog: 16 discovered, 9 selected, 9 tools, 0 diagnostic(s)
```

```text title="NestJS"
[Nest] LOG [RouterExplorer] Mapped {/orders, POST} route
[Nest] LOG [RoutesResolver] McpController {/}:
[Nest] LOG [RouterExplorer] Mapped {/mcp, ALL} route
demo-api: http://localhost:3000 (MCP endpoint: POST /mcp)
```

:::

On ASP.NET Core, sixteen endpoints exist and nine were selected, because only the decorated ones come through. Leave the backend running.

## 5. Call it as an agent

In a second terminal, run the repository's example client:

:::tabs

```sh title="ASP.NET Core"
node sdks/nestjs/samples/agent-client/dist/main.js --scenario smoke --query "get order"
```

```sh title="NestJS"
SEZZLEE_BASE_URL=http://127.0.0.1:3000 SEZZLEE_AUTH=token SEZZLEE_USER=alice \
  node sdks/nestjs/samples/agent-client/dist/main.js \
  --scenario smoke --query "create order" \
  --tool create_order --arguments '{"item":"usb-c dock","quantity":1}'
```

:::

:::tabs

```text title="ASP.NET Core"
step                      ok    detail
tools/list                ok    load_tool, search_tools, invoke_tool
search_tools "get order"  ok    8/8 results
load_tool get_order       ok    {"type":"object","properties":{"id":{"type":"integer","description":"Order id"}},"required":["id"],"additionalProperties":false}
invoke_tool get_order     ok    {"status":200,"body":{"id":1,"item":"mechanical keyboard","quantity":2,"owner":"alice"}}
```

```text title="NestJS"
step                         ok    detail
tools/list                   ok    search_tools, load_tool, invoke_tool
search_tools "create order"  ok    7/8 results
load_tool create_order       ok    {"type":"object","properties":{"item":{"type":"string","minLength":1},"quantity":{"type":"integer","minimum":1,"maximum":100}},"required":["item","quantity"],"additionalProperties":false}
invoke_tool create_order     ok    {"status":201,"body":{"id":1,"item":"usb-c dock","quantity":1,"owner":"alice","notes":[]}}
```

:::

That is the whole product in four lines. `tools/list` returned three tools, not the whole catalog. `search_tools` matched your description and returned a compact card. `load_tool` built the input schema from your code. `invoke_tool` reached the handler through your own authorization and returned its answer. The client authenticated as `alice`.

On NestJS, `SEZZLEE_AUTH=token` uses the sample's `POST /auth/token` shortcut, and the order id increments on each run. The NestJS sample shows `7/8` rather than `8/8` because its guards are imperative code, so sezzlee falls back to probing; [Declare visibility for a NestJS guard](/docs/http-catalog/declare-visibility-for-a-nestjs-guard) is the fix. Its schema also carries no property descriptions, because NestJS has no equivalent of ASP.NET's description metadata. You supply them with `@McpTool({ description })` per method.

## Where to go next

- Expose a whole backend without decorating each endpoint: [Choose which endpoints become tools](/docs/http-catalog/choose-which-endpoints-become-tools).
- Make `bob` see less than `alice`: [Control what a caller can see](/docs/http-catalog/control-what-a-caller-can-see).
- Fix the `7/8` on NestJS: [Declare visibility for a NestJS guard](/docs/http-catalog/declare-visibility-for-a-nestjs-guard).
- The exact wire shape: [Meta-tool contract](/docs/http-catalog/meta-tool-contract).

For the normative rules, read the spec in [`packages/http/spec`](https://github.com/sezzlee/mcp/tree/main/packages/http/spec). These pages describe; the spec binds.

:::details[If something does not work]

An empty `search_tools` for every caller almost always means no endpoint was selected. Selection is opt-in, so with no `[McpTool]` or `@McpTool()` anywhere the catalog is empty. [Find out why a tool is missing](/docs/http-catalog/find-out-why-a-tool-is-missing) gives the order to check things in.

On ASP.NET Core, a host without `app.UseSezzleeCapture()` refuses to start:

```text
MapSezzlee() requires app.UseSezzleeCapture() earlier in the pipeline, before UseRouting(),
UseAuthentication() and UseAuthorization(). Add app.UseSezzleeCapture() near the top of the pipeline.
```

If it sits after those calls instead, agent requests never reach your authentication layer.

On NestJS, `reflect-metadata` must be the first import in the process, or the decorators store nothing and the catalog comes up empty. `await app.init()` must run before `app.use(...)`, because `app.get(...)` cannot resolve a provider until the container is initialized. Passing an options literal such as `{ visibility: { tier: "probe" } }` to `forRoot` configures nothing.

:::

:::details[Why only three tools]

A real backend measured during this project had 698 tools. Listing them all is a reasoning problem, not a size problem: an agent choosing among 698 similar options chooses badly and spends the context it needed for the task.

Search returns compact cards, so the agent pays for one schema, not 698. The tool list stays the same three tools, so a client can cache it, and search runs per caller, so results can follow what that caller may see. The cost is three round trips instead of one, which only pays off when the catalog is large. Switching to a plain list below some size was rejected, because the protocol would then depend on a backend's size. The exact shape is in the [meta-tool contract](/docs/http-catalog/meta-tool-contract).

:::

:::details[Why the two SDKs do not feel the same]

Enforcement is the same in both: a tool call is replayed into your pipeline, so it cannot do more than an HTTP call by the same caller.

Visibility differs. Filtering search needs an endpoint's effective authorization before any request exists. ASP.NET Core has already merged the global, controller and endpoint levels into one metadata list, and the SDK reads it. NestJS exposes which guards apply but not what they mean, because `canActivate` is code that can read a database or the clock. So a NestJS guard has to declare itself, and a probe tier exists for guards that cannot. The hand-written controller has a smaller cause: a module cannot add a route to a class you own.

:::

:::details[Why this is not an OpenAPI adapter]

An adapter sits outside the backend and calls it over the network, so it cannot know who the caller is or what that caller may use. sezzlee sits inside it. The SDK reads the framework's own metadata and replays each call through the backend's own pipeline. It also turns resolutions an adapter makes quietly into errors: a colliding name fails with `name_collision`, an unrecognized argument answers `unknown_argument`, and an oversized response is refused instead of truncated.

A backend on another stack can still be reached through its OpenAPI document. Then every tool is shown with `authUncertain`, because a document says which credential an operation needs, not who may use it. The rules are in the [OpenAPI ingestion spec](https://github.com/sezzlee/mcp/blob/main/packages/http/spec/openapi-ingestion.md).

:::
