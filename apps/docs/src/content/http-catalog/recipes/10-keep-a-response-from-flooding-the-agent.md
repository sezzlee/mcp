# Keep a response from flooding the agent

A list endpoint with no pagination is harmless to your backend and fatal to an agent. One `GET /orders` that returns 40 000 rows fills the agent's context, and the agent cannot undo that. sezzlee puts a budget and a deadline on every invocation, with defaults that work.

## When the response is too large

The response is refused, not truncated. No prefix, no preview:

```json
{
  "error": "response_too_large",
  "message": "The response is 1843200 bytes; the limit is 262144 bytes. It is refused, not truncated: no part of the body was returned. The body is an array of 8412 items. Narrow it and call again: limit, status.",
  "retryable": false,
  "payload": {
    "bytes": 1843200,
    "limit": 262144,
    "shape": { "kind": "array", "count": 8412 }
  },
  "fields": [
    { "name": "limit", "message": "Maximum number of rows to return." },
    { "name": "status", "message": "Filters by order status." }
  ]
}
```

`shape` tells the agent how big the answer was, often enough to answer "how many refunds are there?" without calling again. `fields` names your endpoint's narrowing arguments, read from its published input schema, so the retry is a specific one.

## When the backend is slow

```json
{
  "error": "invoke_timeout",
  "message": "The backend did not answer within 30000 ms and the call was abandoned. The operation may already have been applied; re-read before retrying.",
  "retryable": true
}
```

A timeout frees the agent. It does not cancel your handler. sezzlee delivers a cancellation signal, but Node does not preempt running code. A handler that ignores its signal runs to completion and its result is discarded, and a write it already committed stays committed. To make a timeout stop work, the handler has to cooperate:

```ts
@Get("reports/heavy")
heavy(@Req() request: Request) {
  const controller = new AbortController();
  request.on("close", () => controller.abort());
  return this.reports.load({ signal: controller.signal });
}
```

This rarely comes for free, because `AbortSignal` is not conventional in Nest handler signatures.

## Change the numbers

```ts
SezzleeModule.forRoot((options) => {
  options.invoke.maxResponseBytes = 512 * 1024;
  options.invoke.timeoutMs = 10_000;
});
```

The defaults are 262 144 bytes and 30 000 ms. Do not raise the timeout above one minute. A stock MCP client cancels at 60 seconds first, so a larger number is unreachable.

A report endpoint that legitimately returns megabytes should not raise the budget for everything else. Override it per endpoint with a delegate. Returning `null` or `undefined` falls back to the global value:

```ts
options.invoke.maxResponseBytesFor = (target) =>
  target.route.startsWith("/reports/") ? 4 * 1024 * 1024 : undefined;
```

Every meta-tool answer passes the budget, not just `invoke_tool`. A DTO deep enough has an input schema large enough to flood the agent on its own, and `load_tool` is guarded too. If you hit that, the fix is the schema depth budget, not a larger response budget. The normative rules are in [invoke-semantics.md](https://github.com/sezzlee/mcp/blob/main/packages/http/spec/invoke-semantics.md).

:::details[Why a response is refused, not truncated]

A preview would be worse on every axis. It spends the whole budget the guard exists to protect. It still forces a second call, because a truncated array cannot be reasoned over. And it tempts the agent into answering from a fragment.

Nothing from the body is forwarded. `count` is a fact about the value, not a string taken from it, so the leak-prevention rules hold by construction.

:::
