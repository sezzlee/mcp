# Rate Limiting

> Status: **normative** — implemented by the NestJS SDK's built-in limiters; no fixture corpus, the behaviour is pinned by the SDK's tests.

Defines how an embedded SDK limits the meta-tool calls one caller makes. The shape of a refusal is owned by [error-mapping.md](error-mapping.md); the machine-readable counterpart is [schemas/invoke-result.schema.json](schemas/invoke-result.schema.json).

## Why this document exists

`search_tools`, `load_tool`, `invoke_tool` and `read_result` arrive as the same `POST` to the MCP endpoint. Only the JSON-RPC body says which tool is called and, for `load_tool` and `invoke_tool`, which operation it names. A host's HTTP rate limiter runs before that body is read, so it can only count requests: it cannot give a search a different budget from a write, and it cannot answer in a form the agent reads. It answers with HTTP 429, and some MCP clients drop the streamable HTTP session on a 429 in the middle of one. The SDK already parses the call, so the limit belongs there.

## Scope

Rate limiting applies to `tools/call` requests. Each call is classified by the tool it names:

| meta-tool | tool                                             | target                                     |
| --------- | ------------------------------------------------ | ------------------------------------------ |
| `search`  | `search_tools`                                   | none                                       |
| `load`    | `load_tool`                                      | the catalog tool its `name` argument names |
| `invoke`  | `invoke_tool`                                    | the catalog tool its `name` argument names |
| `read`    | `read_result`                                    | none                                       |
| `other`   | any other tool registered on the same MCP server | none                                       |

Other JSON-RPC methods (`initialize`, `tools/list`, `ping`, notifications) are not limited by the SDK. They carry no operation to tell apart, so the host's HTTP limiter covers them as well as the SDK could.

The target is looked up by name in the catalog **without** consulting visibility. It is absent when `name` is missing, is not a string, or names no catalog tool. The target reaches only host code, never the agent.

## Configuration

With no rate limit configured nothing is limited, and the SDK behaves exactly as without this document.

A host configures limits in one of two forms, and an SDK implements the first as a prebuilt instance of the second, so there is one code path:

1. **Declared limits**: a default limit, optional per-meta-tool limits for `search`, `load`, `invoke` and `read` that replace the default for that meta-tool, and an optional concurrency limit on `invoke`. Declared limits are partitioned by a key. The default key is the caller scope key ([caching.md](caching.md)); the host MAY supply its own key function.
2. **A partition function**: called once per call with the call context, it returns zero or more partitions. Each partition is a key and a factory for the limiter that key uses. Partitions with equal keys share one limiter for the life of the process, until the limiter idles out. Zero partitions means the call is not limited.

The call context carries the host's request (from which the host reads its own identity), the meta-tool, the target, and the caller scope key.

The key is the host's choice. The caller scope key is only a convenience default, and it fits only when it stays the same for one caller. A scope key that carries a permission or version stamp starts a fresh bucket on every change, so a caller whose permissions change often gets extra permits. A host whose scope resolver does that SHOULD supply a stable key of its own, such as a user or grant identifier.

A key MUST NOT be a value the caller can change without authenticating again. The default caller scope key is derived from the identity carrier headers. It meets this rule only when the MCP endpoint rejects a request whose carriers it has not verified. On an endpoint that admits unauthenticated calls, a caller can send a different carrier value on every call. Each value is a new key, so each call starts with a fresh bucket and the limit does nothing. Every key also holds a limiter until it idles out, so memory grows with the number of keys. A host that admits unauthenticated calls MUST supply a key derived from something the caller cannot vary at will, such as a verified identity or the client's network address as its own proxy configuration reports it.

A limiter is evicted only when it is idle: it holds no state a later call would read, such as a full bucket, an empty window or no held leases. Evicting a limiter that is not idle would reset its count and hand the caller fresh permits.

Limits are per process unless the host's limiter is itself distributed.

## Order

The limit is taken **first**: before argument validation, before the catalog lookup used to answer the agent, before the version check, before visibility, and before dispatch.

- A `load_tool` or `invoke_tool` call naming a hidden or unknown tool consumes a permit exactly like one naming a visible tool. Without this, `unknown_tool` answers would let a caller enumerate names without limit.
- A call refused by the limit runs nothing else: no visibility decision, no probe, no dispatch.
- A call the MCP framework rejects before any SDK code runs, such as a `search_tools` call whose `limit` fails the framework's own schema validation, MAY consume no permit. Such a call reaches neither the catalog nor the backend, so it reveals nothing a permit would protect.

## Chaining

When a call has several partitions, the SDK acquires one permit from each, in the order returned. If any is refused, every permit already acquired for that call is released and the call is refused. The retry hint is taken from the partition that refused.

## Lease lifetime

A permit is held until the meta-tool call ends. For `invoke_tool` that is after the backend pipeline has answered and the result has been mapped. The permit is released on every exit: a normal result, a refusal produced later in the call, an exception, and cancellation. For a rate-based limiter the release is a no-op; for a concurrency limiter it is what frees the slot.

A limiter configured to queue makes the call wait for a permit. Cancelling the MCP call abandons the wait.

## Refusal

A refused call is a normal `tools/call` result, never an HTTP 429 and never a JSON-RPC error: `isError: true` with an `SdkError`:

```json
{
  "error": "rate_limit_exceeded",
  "message": "The call was refused by this server's rate limit before it ran. Retry after 3 seconds.",
  "retryable": true,
  "retryAfterSeconds": 3
}
```

- `retryAfterSeconds` is the refusing limiter's retry-after metadata rounded **up** to whole seconds. It is omitted when the limiter gives none, as a concurrency limiter does.
- The message is pinned. With a retry hint: `The call was refused by this server's rate limit before it ran. Retry after {retryAfterSeconds} seconds.` Without one: `The call was refused by this server's rate limit before it ran. Retry later.`
- `rate_limit_exceeded` is distinct from the backend's `rate_limited` ([error-mapping.md](error-mapping.md)): the call did not reach the backend.

## What rate limiting is not

It is not access control. A permit never makes a tool visible or invocable, and a refusal says nothing about the caller's permissions. Enforcement stays in the backend pipeline ([visibility.md](visibility.md)).
