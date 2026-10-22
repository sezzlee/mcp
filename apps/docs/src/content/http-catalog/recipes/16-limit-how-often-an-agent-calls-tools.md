# Limit how often an agent calls tools

An agent in a loop can call `invoke_tool` hundreds of times a minute. A rate limiter in front of `/mcp` cannot tell that apart from a few searches: `search_tools`, `load_tool` and `invoke_tool` all arrive as the same `POST`, and only the body says which is which. Its only answer is a `429`, and some MCP clients drop the session when they get one. sezzlee limits the call itself, after it has read the body, and refuses with an answer the agent can act on.

Nothing is limited until you configure it.

## Declare the limits

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

`default` covers every call. `search`, `load` and `invoke` each replace it for one meta-tool, with a bucket of their own. `invokeConcurrency` caps how many `invoke_tool` calls one caller has running at once. Its slot is held until the backend has answered, however the call ends.

The four kinds are a token bucket, a fixed window, a sliding window and a concurrency limit.

Limits are counted per process. Behind a load balancer each replica counts on its own.

## What the agent sees

A refused call is a normal tool result, never an HTTP `429`:

```json
{
  "error": "rate_limit_exceeded",
  "message": "The call was refused by this server's rate limit before it ran. Retry after 3 seconds.",
  "retryable": true,
  "retryAfterSeconds": 3
}
```

A concurrency limit has no retry time, so it answers `Retry later.` instead. `rate_limit_exceeded` is a different code from `rate_limited`: that one is your backend answering `429` to a call that reached it.

## Count per user, not per permission set

Declared limits are counted per caller scope key, the one the visibility cache uses. That works only while the key stays the same for one caller. If your scope resolver adds a permission version to the key, every permission change starts the caller with a fresh bucket.

The caller scope key is also derived from the identity headers, by default `Authorization`. It is safe only when your MCP endpoint rejects a request it has not authenticated. If the endpoint lets anonymous calls through, a caller can send a different header on every call, and each call starts with a full bucket. In both cases, give the limiter a key the caller cannot change at will:

```ts
options.rateLimiting = {
  default: { kind: "tokenBucket", tokenLimit: 120, tokensPerPeriod: 2, periodMs: 1_000 },
  key: (call) => call.request?.auth?.clientId ?? call.callerScope,
};
```

## Write your own rule

When one limit per meta-tool is not enough, return the partitions yourself. The function runs once per call. It receives the request, the meta-tool, and for `load_tool` and `invoke_tool` the catalog tool the call names. Here writes get a tighter budget than reads, and every user also has an overall ceiling:

```ts
options.rateLimiting = {
  partition: (call) => {
    const user = call.request?.auth?.clientId ?? call.callerScope;
    const write = call.metaTool === "invoke" && call.target?.method !== "GET";
    return [
      {
        key: `${write ? "write" : "read"}:${user}`,
        create: () =>
          createTokenBucketLimiter({
            tokenLimit: write ? 10 : 60,
            tokensPerPeriod: write ? 1 : 2,
            periodMs: 1_000,
          }),
      },
      {
        key: `ceiling:${user}`,
        create: () => createFixedWindowLimiter({ permitLimit: 1_000, windowMs: 3_600_000 }),
      },
    ];
  },
};
```

A call needs a permit from every partition. If one refuses, the permits already taken are given back, and the refusal carries that partition's retry time. Partitions with the same key share one limiter. The partition function replaces the declared limits, and setting both fails at startup. To share limits across replicas, back a partition with a distributed limiter: anything that implements `RateLimiter`.

## What is counted

Only `tools/call` is limited. `initialize`, `tools/list` and `ping` carry no operation to tell apart, so keep your HTTP limiter for those.

The permit is taken before anything else runs. A `load_tool` or `invoke_tool` call that names a hidden tool, or one that does not exist, costs a permit like any other, so an agent cannot discover tool names for free.

The rules are in [rate-limiting.md](https://github.com/sezzlee/mcp/blob/main/packages/http/spec/rate-limiting.md).

:::details[Why the limit is taken before visibility]

Without it, `load_tool` would be free to call with guessed names, and an `unknown_tool` answer would tell the caller each guess was wrong at no cost. Counting first means a refused call runs no visibility decision, no probe and no dispatch. A limit is not access control, though: a permit never makes a tool visible, and your backend still decides every invoke.

:::
