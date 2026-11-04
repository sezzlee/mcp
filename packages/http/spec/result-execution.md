# Result Execution

> Status: normative optional extension; implemented in the TypeScript core and NestJS SDK.

## Purpose

An optional `execute_result` meta-tool computes over a retained body without passing that body
through the model's context. It complements [result reading](result-reading.md): a read selects
a window; execution filters, transforms or calculates over the complete stored body. It does
not fetch another upstream page, change a source, or invoke its producing operation again.

The wire shapes are defined in [result-execution.schema.json](schemas/result-execution.schema.json).
The host executor port's serializable values are defined in
[result-program.schema.json](schemas/result-program.schema.json); AbortSignal remains a host-only capability.
The first implementation is the TypeScript core and NestJS SDK with `@sezzlee/compute-core`.
Other SDKs and the OpenAPI gateway do not yet expose this optional tool.

## Admission and arguments

Register `execute_result` only when both a result store and a data executor are bound. An
unconfigured host retains the existing tool set. The arguments are:

| Name     | Required | Meaning                                                                      |
| -------- | -------- | ---------------------------------------------------------------------------- |
| `handle` | yes      | A stored-result handle issued to this caller.                                |
| `code`   | yes      | A synchronous JavaScript function body, receiving the stored body as `data`. |

Missing or null arguments produce `unknown_argument`; a non-string produces `invalid_selection`.
The tool description MUST explain `data`, `return`, the lack of host capabilities, the effective
execution limits, and that the stored body may itself be a page or sample. The description gives
a projection example. A client needs no hook or additional system prompt to discover the tool.

The result store partition and producing-tool visibility checks are exactly those of
`read_result`. A malformed, expired, foreign, unavailable or no-longer-visible handle gives
`result_unavailable` without identifying the cause. Check visibility before execution and again
before publishing a success. A computation's derived result remains owned by the original
producing tool, so a later read is subject to that tool's visibility. Handle expiry, eviction,
identity-carrier scope and multi-process store limitations remain unchanged.

Execution is the `read` meta-tool class for rate limiting, with `toolName: "execute_result"` and
no target. The class's admission is taken before accessing the stored value. The data executor
also bounds active workers. Client cancellation must reach the executor.

## Computation and scope

The executor receives the complete JSON body after the original output-schema wrapping, before
any `read_result` selection or window. It receives no credential, filesystem, network, tool-call
or import capability. Only a finite JSON result may cross back into the host. Do not silently
drop undefined members or convert non-finite numbers to null. JavaScript's ordinary JSON
`toJSON` conversions still apply. Source strings and numbers enter unchanged by this layer;
binary64 arithmetic does not provide exact decimal arithmetic.
Non-plain objects such as Map and Set require an explicit projection or `toJSON` conversion.

A successful answer is:

```json
{
  "source": {
    "handle": "q7Vd2Zc0xTn4bQ1kLw9sYA",
    "tool": "list_orders",
    "scope": "stored_body"
  },
  "value": { "paidCount": 3, "total": 84 }
}
```

`scope: "stored_body"` states the computation's available input, not that the program visited
every member or that the upstream source was exhaustive. A paginated or sampled upstream body
remains paginated or sampled. No count of scanned source rows is invented. Input mutations are
private to an execution; the retained body is immutable from the program's perspective.

## Two output budgets

The executor's output budget bounds the JSON transferred from its worker. Exceeding it returns
`result_execution_failed` with reason `output_limit`; no prefix or partial handle is published.

A successful result that fits that budget still passes the existing response gate. If its
envelope exceeds the host response budget, keep the entire `{ source, value }` under a new
handle, owned by the original producing tool, and return the existing status-free stored
envelope. `read_result` can read `/value`, or `execute_result` can compute again with the new
body's shape. The source operation is not replayed. A derived result has its own normal store
lifetime; it may outlive its parent's handle. Its source metadata records that parent, without
requiring it to remain live. Store refusal/failure or an oversized stored envelope still gives
the normal `response_too_large` refusal. No invented HTTP status accompanies a computation.

## Execution failures

An execution refusal carries `error: "result_execution_failed"`, a bounded fixed `message`,
the executor's `reason`, effective `limits`, and `retryable` (true only for `busy`). The message
explains the violated budget or invalid operation and a concrete recovery. Never forward guest
exception text or worker diagnostics. A program can throw source contents deliberately.

For QuickJS, limits may only tighten the exported defaults. The defaults, enforcement points
and failure reasons are in the [compute-core README](../../cores/compute-core/README.md).
Runtime failure, cancellation and timeout publish no partial value. Exceeding a source's read
cap cannot be repaired here: no complete stored body exists in that case. A non-read-only
source operation must not be repeated automatically when its stored result becomes unavailable.
