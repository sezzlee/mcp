# Control what a caller can see

Make an endpoint appear, or not appear, in `search_tools` for a given caller. There is no sezzlee switch for this. You change the endpoint's own authorization, and visibility follows.

## Hide an endpoint from callers without a claim

Guard it with a policy your framework can evaluate before the handler runs:

```csharp
[HttpGet("/orders/{id:int}")]
[Authorize(Policy = "OrdersRead")]
public IActionResult GetOrder(int id) => ...;
```

Callers who fail `OrdersRead` get a `deny` decision and never see the tool. Callers who pass see it normally.

## Show an endpoint to everyone

Mark it anonymous. sezzlee reads the framework's own anonymous marker:

```csharp
[HttpGet("/ping")]
[AllowAnonymous]
public IActionResult Ping() => Ok(new { pong = true });
```

This page assumes the framework can read your authorization declaratively, which is the ASP.NET Core case. On NestJS a guard has to declare itself first: [Declare visibility for a NestJS guard](/docs/http-catalog/declare-visibility-for-a-nestjs-guard).

## Watch the filter work

Start the demo backend in one terminal. It listens on `http://127.0.0.1:5178`. One endpoint, `GET /orders/{id}`, is guarded by `OrdersRead`, which needs an `orders.read` claim.

```sh
cd sdks/dotnet/samples/DemoApi
dotnet run
```

In another terminal, build the client once with `pnpm install` and `pnpm turbo run build --filter=@sezzlee/agent-client`. Then search as `alice`, who carries the claim:

```sh
SEZZLEE_AUTH=token SEZZLEE_USER=alice \
  node sdks/nestjs/samples/agent-client/dist/main.js --scenario smoke --query orders
```

```text
step                      ok    detail
tools/list                ok    load_tool, search_tools, invoke_tool
search_tools "orders"     ok    7/8 results
```

Eight tools exist for her, and seven match the query. Search again as `bob`, who has a valid token but no claim:

```sh
SEZZLEE_AUTH=token SEZZLEE_USER=bob \
  node sdks/nestjs/samples/agent-client/dist/main.js --scenario smoke --query orders
```

```text
search_tools "orders"  ok    4/5 results
```

Five tools exist for `bob`, not eight. `get_order`, `create_order` and `add_order_note` are gone, the three that `OrdersRead` guards. The demo users differ only in their claims:

| Caller  | Claims        | Tools visible | Extra over `bob`                              |
| ------- | ------------- | ------------- | --------------------------------------------- |
| `alice` | `orders.read` | 8             | `get_order`, `create_order`, `add_order_note` |
| `carol` | `admin` role  | 6             | `orders_audit`                                |
| `bob`   | none          | 5             | —                                             |

Now point `bob` straight at a tool he cannot see:

```sh
SEZZLEE_AUTH=token SEZZLEE_USER=bob \
  node sdks/nestjs/samples/agent-client/dist/main.js --scenario smoke --query orders --tool get_order
```

```text
load_tool get_order    fail  {"error":"unknown_tool","message":"No operation named 'get_order'. Use search_tools to find the exact name.","retryable":false}
```

The answer is `unknown_tool`, word for word what a name he invented would get. The filter hid the tool but did not lock it. Call it anyway:

```sh
SEZZLEE_AUTH=token SEZZLEE_USER=bob \
  node sdks/nestjs/samples/agent-client/dist/main.js --scenario error-envelope --tool get_order \
  --arguments '{"id":1}'
```

```json
{
  "error": "forbidden",
  "message": "The caller is authenticated but not permitted to perform this operation (403).",
  "status": 403,
  "retryable": false
}
```

That is a 403 from your backend's own authorization, as an HTTP client would get. `invoke_tool` never consults the visibility filter. Hiding a tool does not protect it.

:::details[A tool shows up with authUncertain]

`authUncertain: true` means sezzlee could not decide, and it shows the tool rather than guess either way.

| Cause                                                                   | Fix                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| The endpoint checks authorization inside the handler, not declaratively | Move the resource-independent part of the check to an attribute or guard |
| Your backend has no authentication scheme sezzlee can run               | Nothing to fix; the decision is honestly unknown                         |
| A policy did not report a result                                        | Make the policy evaluable without a resource                             |

Resource-dependent checks, such as "can this user see _this_ order", stay in the handler. Visibility evaluates only the resource-independent gate and defers the rest to invoke time. Do not restructure your handler to satisfy the filter. The rules are on [Visibility decision](/docs/http-catalog/visibility-decision).

:::

:::details[Why visibility is not enforcement]

`invoke_tool` runs your real pipeline on every call and never reads the visibility cache. Visibility is best effort, and it exists for the agent's experience and so that it does not leak what exists.

The filter cannot be exact. It runs at list time, when there is no resource and no arguments, so it can check a scope, claim or role but not "does alice own order 7". An optimistic filter is the useful one. A pessimistic one would hide every endpoint that shows callers their own records.

Hidden and nonexistent look the same on purpose: "a tool called `refund_order` exists but you may not use it" tells an attacker your product has refunds. For the same reason, policy names never reach the agent. An undecidable endpoint reaches the agent as `authUncertain`, because collapsing to `deny` destroys a capability and collapsing to `allow` hides the doubt.

If your reasoning contains "it's fine, the agent can't see it", stop. That is never a security argument here.

:::
