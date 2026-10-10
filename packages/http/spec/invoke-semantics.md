# Invoke Semantics

> Status: **normative** — validated by two independent implementations (NestJS `emitGuarded` + ASP.NET `SezzleeMetaTools.Respond` produce the same envelopes from the same `error-mapping/` corpus).

Defines what happens between argument composition and the result the agent reads: the response budget, the invoke deadline and the cancellation ladder. [argument-mapping.md](argument-mapping.md) owns the step before this one, [error-mapping.md](error-mapping.md) owns the shape of the result. The machine-readable counterpart is [schemas/invoke-result.schema.json](schemas/invoke-result.schema.json); the corpus is [conformance/error-mapping/](../conformance/error-mapping/).

## Why this document exists

Nothing normatively described what an invocation costs. A tool response was unbounded in size and unbounded in time, so a single unpaginated list endpoint could exhaust an agent's context, and a handler that never answered could hang a session with no way out. Both are agent-facing failures with no agent-side remedy, which is what makes them a specification concern rather than a host policy.

## The pipeline

Every meta-tool answer passes five stages, in order:

1. **Compose** — flat agent arguments become an HTTP request ([argument-mapping.md](argument-mapping.md)).
2. **Dispatch under a deadline** — every `ref` file argument is resolved, then the request runs through the backend's own pipeline. Resolution is inside the deadline, so a resolver that hangs is bounded the way a backend that hangs is ([request-bodies.md](request-bodies.md)). An exception that escapes the backend's pipeline is answered the way the backend's own server answers it: a `500` with no body and no headers, logged by the SDK. It is therefore mapped as `backend_error`, never as `internal_error` — that code belongs to the layer's own failures, and an exception message reaching the agent would bypass the rule that no 5xx body is forwarded ([error-mapping.md](error-mapping.md)). A probe dispatch follows the same rule.
3. **Map** — the backend response becomes an `InvokeSuccess` or a `MappedError` ([error-mapping.md](error-mapping.md)).
4. **Gate** — the serialized answer is measured against the payload budget.
5. **Emit** — the answer becomes a `CallToolResult`.

The gate is the **last step before emission on every meta-tool path**, not only `invoke_tool`. `search_tools` and `load_tool` pass it too: an operation whose `inputSchema` is large enough is otherwise an unbounded response with no argument to narrow it. An implementation MUST have exactly one place where a `CallToolResult` is constructed, so no answer can bypass the gate. This is the sibling of the rule `packages/cores/file-core` states for file-backed servers; the two packages share the principle and never the code.

## The response budget

### What is measured

The **serialized text the implementation is about to emit**, in UTF-8 bytes. Not the backend's `Content-Length`, and not the in-memory object: what costs the agent is what enters its context.

Byte counts are **not identical across implementations**. `System.Text.Json` escapes non-ASCII characters to `\uXXXX` by default and `JSON.stringify` does not, so the same body can measure differently in the two SDKs. A payload within a few percent of the limit may therefore be refused by one and admitted by the other. This is a known limit, not a defect; making it exact would require a normative serialization, which is a separate decision.

### Refuse, never truncate

An over-budget answer is **refused in full**. No prefix, no preview, no partial body.

The reason is that a preview is not a cheaper failure. It spends the entire budget the gate exists to protect, it still forces the agent to call again because a truncated array cannot be reasoned over, and it adds the risk that the agent answers confidently from a fragment it believes is the whole. Refusal costs a few hundred bytes and leaves the agent with an accurate picture.

### The refusal

An over-budget answer becomes an `SdkError` with `error: "response_too_large"`, `retryable: false` and a `payload` block:

- `bytes` — what the answer measured.
- `limit` — the budget in force for this call.
- `shape` — `kind` (`array`, `object` or `text`) and, where one exists, `count`. For an array this is the number of **top-level** elements, for an object the number of own properties, for a string the number of UTF-16 code units. A scalar, a null or an absent value yields `kind: "text"` with no `count`.

`shape` is a fact **about** the discarded value. No string taken from the body may appear in the refusal, so the leak-prevention rules of [error-mapping.md](error-mapping.md) hold by construction rather than by filtering. Fixture: `oversize-payload-strings-never-forwarded`.

`fields` names the arguments of that call which narrow the response, each with its own published description. The implementation derives them from the tool's `inputSchema` using the tokenizer of [search-semantics.md](search-semantics.md), matching any token against two sets, in this order:

- **cardinality** — `limit`, `top`, `take`, `max`, `count`, `size`, `page`, `per`
- **selection** — `offset`, `skip`, `cursor`, `after`, `before`, `filter`, `query`, `search`, `field`, `select`, `since`, `from`, `until`, `status`

Cardinality arguments are listed first, each set in schema property order, and the list is capped at **8**. An argument the schema does not describe carries the constant `Constrains the result set.` The sets, the order and the cap are part of the pinned algorithm: an implementation MUST NOT extend them locally, because a name lexicon is exactly the kind of thing two implementations drift on.

When no argument narrows the call — `load_tool` is the standing case — `fields` is absent and the message says so. A `load_tool` refusal is not recoverable by the agent; the host-side remedy is the depth budget of [schema-conversion-rules.md](schema-conversion-rules.md).

### Standard messages

Fixture-pinned, identical in both implementations. Every interpolated number is an integer: a decimal would render differently under a culture such as `tr-TR`.

```
The response is {bytes} bytes; the limit is {limit} bytes. It is refused, not truncated: no part of the body was returned. {shape} {advice}
```

| slot     | value                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shape`  | `The body is an array of {count} items.` / `The body is an object with {count} properties.` / `The body is a text value of {count} characters.` / `The body is not a JSON array or object.` |
| `advice` | `Narrow it and call again: {names}.` / `No argument of this call narrows the response.`                                                                                                     |

## The invoke deadline

Only `invoke_tool` has one: `search_tools` and `load_tool` never wait on a backend. A host-bound search ranker runs under a deadline of its own, with its own failure rules ([search-semantics.md](search-semantics.md), Replaceable ranker).

The clock starts when the request enters the backend pipeline and stops when the pipeline produces a response. On expiry the implementation stops waiting and emits `invoke_timeout` with `retryable: true`:

```
The backend did not answer within {limitMs} ms and the call was abandoned. The operation may already have been applied; re-read before retrying.
```

`retryable` is `true` because a slow backend may answer next time — the same reading that puts 504 in `backend_unavailable`. The second sentence is load-bearing: the deadline does not roll anything back, so a retry can apply an operation twice. That hazard is published in the message rather than hidden behind a `false` flag.

A deadline at or above **60000 ms is unreachable** through a stock MCP client, whose own per-request timeout cancels first. A host that raises the deadline past that point gets the client's behaviour, not its own.

`invoke_timeout` is emitted **only on deadline expiry**, never on caller cancellation. When the caller cancels, the protocol discards whatever the server returns, so there is nobody left to read an envelope.

## The cancellation ladder

Three levels, and an implementation MUST NOT promise more than it delivers.

- **L0 — the agent is always freed.** When the deadline expires the result is emitted immediately; the agent never waits longer than the deadline. Unconditional.
- **L1 — the signal is always delivered.** The implementation MUST propagate cancellation into the handler it invoked, through whatever channel that platform gives a disconnecting client. Delivery is unconditional; observation is not.
- **L2 — the handler stops only if it cooperates.** sezzlee MUST NOT promise that backend work stops. A handler that does not observe its signal runs to completion and its result is discarded. Work already committed stays committed; no level of this ladder rolls anything back.

**A timeout frees the agent; it does not cancel a non-cooperating handler.** This is true on both platforms and for the same reason: `CancellationToken` and `AbortSignal` are both cooperative, and neither runtime preempts running code. The platforms differ only in how conventionally the signal is already threaded through library calls — in .NET a token usually is, in Node a signal usually is not.

Exactly one result is emitted per call. A result that arrives after the call was abandoned is discarded: never emitted, never cached.

## Configuration

| Setting                      | Default    | Meaning                                     |
| ---------------------------- | ---------- | ------------------------------------------- |
| `invoke.maxResponseBytes`    | `262144`   | The largest answer, in UTF-8 bytes          |
| `invoke.timeoutMs`           | `30000`    | The invoke deadline; zero means no deadline |
| `invoke.maxResponseBytesFor` | unset      | Per-endpoint override, consulted first      |
| `invoke.timeoutMsFor`        | unset      | Per-endpoint override, consulted first      |
| `invoke.maxInlineFileBytes`  | `1048576`  | Decoded `base64` file bytes per call        |
| `invoke.maxFileBytes`        | `16777216` | The bytes of one resolved `ref` file        |

A host lowers either; neither is negotiable by the agent. The overrides are delegates over the invoked endpoint, not fields on `EndpointDescriptor`: how many bytes a deployment's answer may occupy is a property of **that deployment**, not of the endpoint, and two hosts serving the same descriptor must be free to disagree.

Precedence is a single step — `maxResponseBytesFor(target) ?? maxResponseBytes` — deliberately simpler than the layered ladder of [argument-curation.md](argument-curation.md). That ladder needs `seal` because a method decorator can defeat a central rule; there is no decorator layer here, so there is nothing to seal against. Restoring the parity would be ceremony with no failure mode behind it.

## The tool version

Every request is served on its own ([transport.md](transport.md), Session mode), so during a rolling deploy one agent can load a tool from a new replica and have the call answered by an old one. Each replica is consistent with itself; what can disagree is the contract the agent read and the contract the answering replica holds. The tool version makes that disagreement visible instead of letting the arguments be composed against a schema the agent never saw.

- **What it is.** An opaque string derived from the tool's loaded shape ([search-semantics.md](search-semantics.md), "The loaded shape") with `authUncertain` removed, because that member describes one caller's decision and not the tool. Equal shapes MUST produce equal versions in every process running the same implementation, independent of discovery order, key order and process start; different shapes SHOULD produce different versions. The value is compared for equality only, so implementations need not agree with each other on how it is derived.
- **What it is not.** The route, the method and the request template are absent from it on purpose: each replica composes against its own, consistently. A change in behaviour that leaves the loaded shape untouched is invisible to it, exactly as it is to any other client of the backend.
- **Where it appears.** `load_tool`'s answer and every `search_tools` result under `detail: "schema"` carry it as `version`, next to the members of the loaded shape. The compact card does not: an agent invoking from a card has not read the schema the version would vouch for.
- **How it is checked.** `invoke_tool` takes an optional `version`. When it is present the implementation compares it with the version of the tool it resolved, after `name` is resolved and before composition; a mismatch is refused with `tool_changed` and the backend is never reached. When it is absent nothing is checked. An unknown `name` is `unknown_tool` whatever `version` says. The check MUST NOT consult the visibility filter, for the same reason `invoke_tool` never does ([search-semantics.md](search-semantics.md)).
- **The refusal.** `tool_changed`, `retryable: false`: the same call, carrying the same stale version, fails the same way. The message is pinned:

```
The tool '{name}' changed after it was loaded, so the call was refused before reaching the backend. Load it again with load_tool and retry with the new version.
```

`catalogGeneration` ([transport.md](transport.md)) is unrelated: it counts reloads inside one process to make `listChanged` honest, starts at the same value in every process, and is never compared across replicas.

## Fixture pattern

`error-mapping` fixtures take two input forms. The second one drives the guards:

```json
{
  "kind": "error-mapping",
  "description": "...",
  "input": {
    "sdkError": "response_too_large",
    "bytes": 812345,
    "limit": 262144,
    "payload": [],
    "narrowing": []
  },
  "expected": {
    "error": "response_too_large",
    "message": "...",
    "retryable": false,
    "payload": {}
  }
}
```

`bytes` is an input fact, because the two implementations measure differently. The **shape derivation** is not: a runner passes the raw `payload` through its own implementation, so `expected.payload.shape` is evidence about that derivation rather than a restatement of an input. An input carrying `sdkError` drives the SDK-side builders; one carrying `status` drives `mapInvokeResult`.

## Known limits

- Byte counts are not identical across implementations (above).
- Every interpolated number in a standard message is an integer, so culture-sensitive formatting cannot diverge.
- Both implementations buffer the whole backend body before anything is measured, so an endpoint returning gigabytes exhausts memory before the budget runs. This predates the budget and is not addressed here.
- A `retryable: true` timeout can produce a duplicate write. The message says so; the protocol offers nothing better.
- A replica built before the tool version existed drops `version` as an argument it does not know, so a pinned call answered by such a replica is not checked. The gap closes once every replica carries the check.
- `SdkErrorCode` and `BackendErrorCode` MUST stay disjoint. A shared member makes an envelope match two branches of the `InvokeResult` union, and the resulting validation error names the top-level fixture union rather than the real cause.
