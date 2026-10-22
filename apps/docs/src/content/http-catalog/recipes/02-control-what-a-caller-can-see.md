# Control what a caller can see

Make an endpoint appear, or not appear, in `search_tools` for a given caller. There is no sezzlee switch for this. You change the endpoint's own authorization, and visibility follows.

## Hide an endpoint from callers without a claim

Guard it with a guard that declares what it enforces:

```ts
@Get("orders/:id")
@UseGuards(JwtGuard, OrdersReadGuard)
@McpTool({ description: "Fetches one order by id." })
getOrder(@Param("id", ParseIntPipe) id: number): Order { ... }
```

`OrdersReadGuard` declares the policy it applies with `describeVisibility()`. Callers who fail it get a `deny` decision and never see the tool. Callers who pass see it normally. How a guard declares itself, and what happens when it cannot, is on [Declare visibility for a NestJS guard](/docs/http-catalog/declare-visibility-for-a-nestjs-guard).

## Show an endpoint to everyone

Have a guard on it declare `anonymous: "yes"`. An endpoint with no guard at all is `unknown`, not public, because authentication can sit in middleware that sezzlee cannot read.

## Watch the filter work

Start the NestJS sample in one terminal. It listens on `http://127.0.0.1:3000`, resolves its undeclared guards with the probe tier, and guards `GET /orders/:id` with `OrdersReadGuard`, which needs an `orders.read` claim.

```sh
pnpm turbo run build --filter=@sezzlee/demo-nestjs --filter=@sezzlee/agent-client
node sdks/nestjs/samples/demo-api/dist/main.js
```

In another terminal, search as `alice`, who carries the claim:

```sh
SEZZLEE_BASE_URL=http://127.0.0.1:3000 SEZZLEE_AUTH=token SEZZLEE_USER=alice \
  node sdks/nestjs/samples/agent-client/dist/main.js --scenario smoke --query orders
```

```text
step                      ok    detail
tools/list                ok    search_tools, load_tool, invoke_tool
search_tools "orders"     ok    11/13 results
```

Search again as `bob`, who has a valid token but no claim:

```sh
SEZZLEE_BASE_URL=http://127.0.0.1:3000 SEZZLEE_AUTH=token SEZZLEE_USER=bob \
  node sdks/nestjs/samples/agent-client/dist/main.js --scenario smoke --query orders
```

```text
search_tools "orders"           ok    6/13 results
```

`bob` gets six results where `alice` gets eleven. The demo users differ only in their claims: `alice` carries `orders.read`, `carol` the `admin` role, and `bob` nothing.

Now point `bob` straight at a tool he cannot see:

```sh
SEZZLEE_BASE_URL=http://127.0.0.1:3000 SEZZLEE_AUTH=token SEZZLEE_USER=bob \
  node sdks/nestjs/samples/agent-client/dist/main.js --scenario smoke --query orders --tool get_order
```

```text
load_tool get_order    fail  {"error":"unknown_tool","message":"No operation named 'get_order'. Use search_tools to find the exact name.","retryable":false}
```

The answer is `unknown_tool`, word for word what a name he invented would get. The filter hid the tool but did not lock it. Call it anyway:

```sh
SEZZLEE_BASE_URL=http://127.0.0.1:3000 SEZZLEE_AUTH=token SEZZLEE_USER=bob \
  node sdks/nestjs/samples/agent-client/dist/main.js --scenario error-envelope --tool get_order \
  --arguments '{"id":1}'
```

```json
{
  "error": "forbidden",
  "message": "Forbidden",
  "status": 403,
  "retryable": false
}
```

That is a 403 from your backend's own authorization, as an HTTP client would get. `invoke_tool` never consults the visibility filter. Hiding a tool does not protect it.

:::details[A tool shows up with authUncertain]

`authUncertain: true` means sezzlee could not decide, and it shows the tool rather than guess either way.

| Cause                                                                   | Fix                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| The endpoint checks authorization inside the handler, not declaratively | Move the resource-independent part of the check to a declared guard |
| Your backend has no authentication scheme sezzlee can run               | Nothing to fix; the decision is honestly unknown                    |
| A policy did not report a result                                        | Make the policy evaluable without a resource                        |

Resource-dependent checks, such as "can this user see _this_ order", stay in the handler. Visibility evaluates only the resource-independent gate and defers the rest to invoke time. Do not restructure your handler to satisfy the filter. The rules are on [Visibility decision](/docs/http-catalog/visibility-decision).

:::

:::details[Why visibility is not enforcement]

`invoke_tool` runs your real pipeline on every call and never reads the visibility cache. Visibility is best effort, and it exists for the agent's experience and so that it does not leak what exists.

The filter cannot be exact. It runs at list time, when there is no resource and no arguments, so it can check a scope, claim or role but not "does alice own order 7". An optimistic filter is the useful one. A pessimistic one would hide every endpoint that shows callers their own records.

Hidden and nonexistent look the same on purpose: "a tool called `refund_order` exists but you may not use it" tells an attacker your product has refunds. For the same reason, policy names never reach the agent. An undecidable endpoint reaches the agent as `authUncertain`, because collapsing to `deny` destroys a capability and collapsing to `allow` hides the doubt.

If your reasoning contains "it's fine, the agent can't see it", stop. That is never a security argument here.

:::
