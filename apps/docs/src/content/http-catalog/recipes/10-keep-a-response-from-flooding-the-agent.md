# Keep a response from flooding the agent

A list endpoint with no pagination is harmless to your backend and fatal to an agent. One `GET /orders` that returns 40 000 rows fills the agent's context, and the agent cannot undo that. sezzlee puts a budget and a deadline on every invocation, with defaults that work.

## When the response is too large

The response is kept, not truncated. The agent gets a handle and an outline of the body, and reads
the parts it needs with `read_result`:

```json
{
  "status": 200,
  "stored": {
    "handle": "q7Vd2Zc0xTn4bQ1kLw9sYA",
    "bytes": 1843200,
    "limit": 262144,
    "expiresInSeconds": 600,
    "outline": [
      { "path": "", "kind": "object", "count": 1, "fields": ["result"] },
      {
        "path": "/result",
        "kind": "array",
        "count": 8412,
        "fields": ["id", "status", "total"]
      }
    ]
  },
  "message": "The response is 1843200 bytes; the limit is 262144 bytes. It was stored, not returned: read it with read_result and the handle, choosing a path from the outline, the properties to select and a window with offset and limit. The stored result expires in 600 seconds."
}
```

```json
{
  "handle": "q7Vd2Zc0xTn4bQ1kLw9sYA",
  "path": "/result",
  "select": ["id", "status"],
  "offset": 0,
  "limit": 50
}
```

Each answer says the total and where the next window starts. A handle is readable only by the
caller it was issued to, and only while that caller can still see the tool that produced it. A
write's answer is kept too, so the agent reads it instead of applying the write a second time to
see it again. The read rules are on
[the meta-tool contract](/docs/http-catalog/meta-tool-contract#read-result).

The store is in memory and per process: ten minutes per result, 16 MiB per caller, 64 MiB in all.
Change those numbers, or bind a store that several replicas share:

```ts
SezzleeModule.forRoot(
  (options) => {
    options.results.lifetimeMs = 5 * 60_000;
    options.results.maxCallerBytes = 8 * 1024 * 1024;
  },
  { resultStore: { useValue: new MySharedResultStore() } },
);
```

`MySharedResultStore` implements `ResultStore` from `@sezzlee/core`: `put` and `get` over a string,
keyed by the caller's partition and the handle. Bind `{ useValue: null }` to turn storing off; the
gateway takes `results.enabled: false`.

## When the response is refused

With no store, or when an answer cannot be kept (an error, a binary body, a store failure, a
`search_tools` page), the response is refused, not truncated. No prefix, no preview:

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

A write is different: by the time its answer is measured, your backend has already applied it. For an operation that is not read-only, the refusal names no `fields` and its last sentence reads `The backend already applied the operation; calling it again applies it again.` Mark a search that happens to use `POST` as read-only (`@McpTool({ readOnly: true })`), so its refusal keeps the narrowing advice.

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

The defaults are 262 144 bytes and 30 000 ms. `options.invoke.maxBufferedBytes`, 16 MiB by default,
is the largest body sezzlee reads from your handler at all: a larger one is refused while it is
being written, before it is held in memory. Do not raise the timeout above one minute. A stock MCP client cancels at 60 seconds first, so a larger number is unreachable.

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
