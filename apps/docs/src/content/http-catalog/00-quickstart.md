# Expose your backend's endpoints to an agent

The NestJS SDK turns the endpoints you already wrote into a searchable tool catalog. An agent finds an endpoint, reads its schema and calls it through your own authorization pipeline, with no second service to keep in sync.

You work inside this repository's sample backend, so the SDK is already referenced. To add the package to your own NestJS project instead, the install steps are in [`sdks/nestjs/README.md`](https://github.com/sezzlee/mcp/blob/main/sdks/nestjs/README.md).

## 1. Register the SDK

```ts
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

This is the `demo-api` sample's `app.module.ts`. `forRoot` takes a callback that mutates an options object, not an options literal.

## 2. Mount `/mcp`

The SDK does not map the endpoint for you. You write the controller, because a module cannot add a route to a class you own:

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

Nothing is exposed by default. `@McpTool()` on a class opts the controller in. A description on the method is what an agent searches against.

```ts
@Controller()
@McpTool()
export class OrdersController {
  @Post("orders")
  @UseGuards(JwtGuard)
  @McpTool({ description: "Creates a new order." })
  create(@Body() dto: CreateOrderDto): Order { ... }
}
```

The `class-validator` decorators on `CreateOrderDto` become the input schema. The authorization line is untouched and runs when the agent calls.

## 4. Run it

```sh
pnpm turbo run build --filter=@sezzlee/demo-nestjs
node sdks/nestjs/samples/demo-api/dist/main.js
```

```text
[Nest] LOG [RouterExplorer] Mapped {/orders, POST} route
[Nest] LOG [RoutesResolver] McpController {/}:
[Nest] LOG [RouterExplorer] Mapped {/mcp, ALL} route
demo-api: http://localhost:3000 (MCP endpoint: POST /mcp)
```

Leave the backend running.

## 5. Call it as an agent

In a second terminal, run the repository's example client:

```sh
SEZZLEE_BASE_URL=http://127.0.0.1:3000 SEZZLEE_AUTH=token SEZZLEE_USER=alice \
  node sdks/nestjs/samples/agent-client/dist/main.js \
  --scenario smoke --query "create order" \
  --tool create_order --arguments '{"item":"usb-c dock","quantity":1}'
```

```text
step                         ok    detail
tools/list                   ok    search_tools, load_tool, invoke_tool
search_tools "create order"  ok    7/8 results
load_tool create_order       ok    {"type":"object","properties":{"item":{"type":"string","minLength":1},"quantity":{"type":"integer","minimum":1,"maximum":100}},"required":["item","quantity"],"additionalProperties":false}
invoke_tool create_order     ok    {"status":201,"body":{"id":1,"item":"usb-c dock","quantity":1,"owner":"alice","notes":[]}}
```

That is the whole product in four lines. `tools/list` returned three tools, not the whole catalog. `search_tools` matched your description and returned a compact card. `load_tool` built the input schema from your code. `invoke_tool` reached the handler through your own authorization and returned its answer. The client authenticated as `alice`.

`SEZZLEE_AUTH=token` uses the sample's `POST /auth/token` shortcut, and the order id increments on each run. The search shows `7/8` rather than `8/8` because the sample's guards are imperative code, so sezzlee falls back to probing; [Declare visibility for a NestJS guard](/docs/http-catalog/declare-visibility-for-a-nestjs-guard) is the fix. The schema also carries no property descriptions, because NestJS has no description metadata for a property. You supply them with `@McpTool({ description })` per method.

## Where to go next

- Expose a whole backend without decorating each endpoint: [Choose which endpoints become tools](/docs/http-catalog/choose-which-endpoints-become-tools).
- Make `bob` see less than `alice`: [Control what a caller can see](/docs/http-catalog/control-what-a-caller-can-see).
- Fix the `7/8`: [Declare visibility for a NestJS guard](/docs/http-catalog/declare-visibility-for-a-nestjs-guard).
- The exact wire shape: [Meta-tool contract](/docs/http-catalog/meta-tool-contract).

For the normative rules, read the spec in [`packages/http/spec`](https://github.com/sezzlee/mcp/tree/main/packages/http/spec). These pages describe; the spec binds.

:::details[If something does not work]

An empty `search_tools` for every caller almost always means no endpoint was selected. Selection is opt-in, so with no `@McpTool()` anywhere the catalog is empty. [Find out why a tool is missing](/docs/http-catalog/find-out-why-a-tool-is-missing) gives the order to check things in.

`reflect-metadata` must be the first import in the process, or the decorators store nothing and the catalog comes up empty. `await app.init()` must run before `app.use(...)`, because `app.get(...)` cannot resolve a provider until the container is initialized. Passing an options literal such as `{ visibility: { tier: "probe" } }` to `forRoot` configures nothing.

:::

:::details[Why only three tools]

A real backend measured during this project had 698 tools. Listing them all is a reasoning problem, not a size problem: an agent choosing among 698 similar options chooses badly and spends the context it needed for the task.

Search returns compact cards, so the agent pays for one schema, not 698. The tool list stays the same three tools, so a client can cache it, and search runs per caller, so results can follow what that caller may see. The cost is three round trips instead of one, which only pays off when the catalog is large. Switching to a plain list below some size was rejected, because the protocol would then depend on a backend's size. The exact shape is in the [meta-tool contract](/docs/http-catalog/meta-tool-contract).

:::

:::details[Why a guard has to declare itself]

Enforcement needs nothing from you: a tool call is replayed into your pipeline, so it cannot do more than an HTTP call by the same caller.

Visibility does. Filtering search needs an endpoint's effective authorization before any request exists. NestJS exposes which guards apply but not what they mean, because `canActivate` is code that can read a database or the clock. So a NestJS guard has to declare itself, and a probe tier exists for guards that cannot. The hand-written controller has a smaller cause: a module cannot add a route to a class you own.

:::

:::details[Why this is not an OpenAPI adapter]

An adapter sits outside the backend and calls it over the network, so it cannot know who the caller is or what that caller may use. sezzlee sits inside it. The SDK reads the framework's own metadata and replays each call through the backend's own pipeline. It also turns resolutions an adapter makes quietly into errors: a colliding name fails with `name_collision`, an unrecognized argument answers `unknown_argument`, and an oversized response is refused instead of truncated.

A backend on another stack can still be reached through its OpenAPI document. Then every tool is shown with `authUncertain`, because a document says which credential an operation needs, not who may use it. The rules are in the [OpenAPI ingestion spec](https://github.com/sezzlee/mcp/blob/main/packages/http/spec/openapi-ingestion.md).

:::
