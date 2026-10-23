# Result Reading

> Status: **normative** — the `result-reading/` corpus pins the outline, the selection and the messages.

Defines what happens to an `invoke_tool` answer that is over the payload budget when a result store is bound: the answer is stored whole, the agent receives a handle and an outline, and `read_result` returns the parts it asks for. [invoke-semantics.md](invoke-semantics.md) owns the budget and the refusal this replaces; the machine-readable counterpart is [schemas/result-reading.schema.json](schemas/result-reading.schema.json); the corpus is [conformance/result-reading/](../conformance/result-reading/).

## Why this document exists

The budget protects the agent's context, and refusal keeps it honest: no fragment is passed off as the whole. Refusal also has a cost the budget does not see. An endpoint with no argument that narrows it cannot be read at all, and the answer of a write the backend already applied is lost, so the only way to see it again is to apply the write again. Storing the answer keeps both properties of refusal, because nothing partial is emitted as if it were the whole, and removes that cost.

## When an answer is stored

At the gate of [invoke-semantics.md](invoke-semantics.md), an answer that is over the budget is stored instead of refused when all of these hold:

- a result store is bound;
- it is an `invoke_tool` success: the backend answered below `400` and the answer is an `InvokeSuccess`;
- it has a `body`, and the body carries no `bodyEncoding`: a base64 window is of no use to an agent.

Anything else is refused exactly as before: errors, a binary body, a `search_tools` or `load_tool` answer, and a body cut off at the read cap. A store that refuses the value or fails is also answered with the refusal; a store can only add a way to read an answer, never lose one. An implementation SHOULD report a store failure to the host.

What is stored is the `body` of the answer the gate measured, after `outputSchema` wrapping ([error-mapping.md](error-mapping.md)), so a path into it is a path into the shape `load_tool` publishes.

## The stored answer

The answer is an `InvokeStored`, emitted with `isError: false`:

```json
{
  "status": 200,
  "stored": {
    "handle": "q7Vd2Zc0xTn4bQ1kLw9sYA",
    "bytes": 812345,
    "limit": 262144,
    "expiresInSeconds": 600,
    "outline": [
      {
        "path": "",
        "kind": "object",
        "count": 2,
        "fields": ["total", "items"]
      },
      {
        "path": "/items",
        "kind": "array",
        "count": 4812,
        "fields": ["id", "status"]
      }
    ]
  },
  "message": "The response is 812345 bytes; the limit is 262144 bytes. It was stored, not returned: read it with read_result and the handle, choosing a path from the outline, the properties to select and a window with offset and limit. The stored result expires in 600 seconds."
}
```

- `status`, `contentType` and `location` are those of the `InvokeSuccess`; `body` and `bodyEncoding` are absent.
- `bytes` and `limit` are the gate's: what the answer measured and the budget in force.
- `expiresInSeconds` is what the store promises, in whole seconds.
- `outline` is derived from the stored body by the algorithm below.

The stored answer passes the gate too. If it is itself over the budget, the call is refused as if no store were bound.

### The message

Fixture-pinned. Every interpolated number is an integer.

```
The response is {bytes} bytes; the limit is {limit} bytes. It was stored, not returned: read it with read_result and the handle, choosing a path from the outline, the properties to select and a window with offset and limit. The stored result expires in {expiresInSeconds} seconds.
```

When the operation was applied, by the rule of [invoke-semantics.md](invoke-semantics.md), one more sentence follows:

```
The backend already applied the operation; read the stored result rather than calling it again.
```

### The outline

The outline names the parts of the body an agent can ask for. It lists the root, then every array and object reached from it through object members only, never through array elements, depth first in member order, at most **3** levels below the root and at most **16** entries in all.

Each entry carries:

- `path` — a JSON Pointer ([RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)): `""` for the root, member names escaped as `~0` for `~` and `~1` for `/`.
- `kind` — `array`, `object`, `string`, or `scalar` for a number, a boolean or `null`.
- `count` — the elements of an array, the members of an object, the UTF-16 code units of a string; absent for a scalar.
- `fields` — for an object, its member names; for an array, the member names of its object elements, in the order they are first seen. At most **32**, absent when there are none.

The outline is a success value, so it may carry member names from the body; it never carries a member's value.

## `read_result`

A meta-tool registered next to the other three whenever a result store is bound, and absent otherwise.

| argument | type             | default | meaning                                                                   |
| -------- | ---------------- | ------- | ------------------------------------------------------------------------- |
| `handle` | string           | —       | The handle of an `InvokeStored` answer; required                          |
| `path`   | string           | `""`    | A JSON Pointer into the stored body                                       |
| `select` | array of strings | none    | The members to keep: of each element of an array, or of an object         |
| `offset` | integer, `>= 0`  | `0`     | The first element, member or code unit of the window                      |
| `limit`  | integer, `>= 1`  | none    | The most elements, members or code units to return; none means to the end |

A `null` is the same as an absent argument. Every argument binds as an unconstrained value and is checked by the implementation, so a wrong type is answered with an envelope rather than the framework's bare validation error.

### The answer

`ReadResult`, emitted with `isError: false`:

```json
{
  "path": "/items",
  "kind": "array",
  "total": 4812,
  "offset": 0,
  "nextOffset": 2,
  "value": [
    { "id": 1, "status": "open" },
    { "id": 2, "status": "paid" }
  ]
}
```

The value at `path` is read as follows:

1. **Resolve** `path` by RFC 6901. An array index is `0` or a decimal without a leading zero, below the array's length; `-` names nothing.
2. **Select**, when `select` is given and not empty. Duplicate names count once. For an array, each object element keeps only the selected members it has, in `select` order, and other elements are kept as they are. For an object, the members are those of the object whose names are selected, in the object's order.
3. **Window**, for an array, an object and a string: `total` is the count after selection, and `value` holds the elements, members or code units from `offset`, at most `limit` of them. `nextOffset` is present when the window stops before `total`. An `offset` at or past `total` yields an empty value.

A scalar is returned whole, with neither `total` nor `offset`.

The answer passes the gate. Over the budget it is refused with `response_too_large`, naming as narrowing arguments, in this order: `limit`, `offset`, `select`, `path`.

### Refusals

`result_unavailable`, `retryable: false`, when the store holds nothing for the handle in the caller's partition: it expired, was evicted, was never issued, or was issued to another caller. The cases MUST NOT be told apart; a handle is a string the agent writes, so a distinguishing answer would let it probe for other callers' results.

```
No stored result answers this handle: it expired, was evicted, or was not issued to this caller. Call the operation again for a new one; if it is not read-only, calling it again applies it again.
```

`invalid_selection`, `retryable: false`, for an argument that cannot be read. Pinned messages, in the order they are checked:

| case                                                    | message                                                                                                                                                                 |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`, `select`, `offset` or `limit` of the wrong type | `Tool 'read_result' takes '{argument}' as {expected}.` with `a string`, `an array of strings`, `a non-negative integer`, `a positive integer`                           |
| `path` is not a JSON Pointer                            | `'{path}' is not a JSON Pointer: it is empty for the whole result, or starts with '/' and escapes '~' as '~0' and '/' as '~1'.`                                         |
| `path` names nothing                                    | `Path '{path}' names nothing in the stored result. The longest part of it that exists is '{prefix}'.`                                                                   |
| `select` at a string or a scalar                        | `select applies to an array or an object; path '{path}' holds a {kind}.`                                                                                                |
| a selected name that no object there has                | `Path '{path}' has no property named {names}. Its properties are: {fields}.` or, when it has none, `Path '{path}' has no property named {names}. It has no properties.` |

A missing `handle` is `unknown_argument` with the message every meta-tool uses for a missing `name`; one that is not a string is `unknown_argument` with `Tool 'read_result' takes 'handle' as a string; {type} arrived. Call it again with the handle an invoke_tool answer returned.` `{names}` lists the unknown names in `select` order, each in single quotes, joined by `, `; `{fields}` is the `fields` list of the outline entry for that path, joined by `, `.

A missing `handle`, or one that is not a string, is checked first, as every meta-tool checks the argument it cannot work without; then the types of the other arguments; then whether the handle names a result of this caller; then the visibility check below; then the path and the selection. A call that has no result to read therefore learns nothing about the shape of one.

## The store

A result store keeps a string under a caller partition and a handle, for a lifetime it chooses:

- `put(partition, handle, value)` answers how many whole seconds the value will be kept, or that it was not kept;
- `get(partition, handle)` answers the value, or nothing.

The handle is minted by the implementation, not the store: **128 random bits**, written in base64url without padding. It is the only thing that names a result, so it MUST come from a cryptographically secure source.

**The partition** keeps one caller's results out of another's reach even when a handle leaks. An embedded SDK uses the caller scope key of [caching.md](caching.md). An implementation that authenticates callers itself uses a digest of the caller's credential; one that admits callers without authenticating them has a single partition. A read carrying a handle from another partition answers `result_unavailable`.

**The visibility check.** A stored result names the tool that produced it. Before a read is answered, the implementation decides that tool for the reading caller as `load_tool` would ([visibility.md](visibility.md)); a tool that is no longer visible, or no longer in the catalog, answers `result_unavailable`. A result fetched under permissions the caller has since lost is then not served for the rest of its lifetime.

**The default store** is in memory and per process:

| setting          | default    | meaning                                           |
| ---------------- | ---------- | ------------------------------------------------- |
| `lifetimeMs`     | `600000`   | How long a value is kept, absolute from its `put` |
| `maxCallerBytes` | `16777216` | The UTF-8 bytes one partition may hold            |
| `maxBytes`       | `67108864` | The UTF-8 bytes the store may hold in all         |

A value larger than `maxCallerBytes` is not kept. To make room, the store drops expired values, then the partition's oldest values, then the store's oldest values. It never refuses a value that fits by dropping others. A host replaces the store for a deployment of several processes, where a handle issued by one process must be readable by another.

## Rate limiting

`read_result` is the meta-tool `read` of [rate-limiting.md](rate-limiting.md), with no target: the tool it reads for is known only after the store is consulted, and the limit is taken first.

## Fixture pattern

`result-reading` fixtures take two input forms. One drives the stored answer:

```json
{
  "kind": "result-reading",
  "description": "...",
  "input": {
    "stored": { "status": 200, "body": {} },
    "handle": "q7Vd2Zc0xTn4bQ1kLw9sYA",
    "bytes": 812345,
    "limit": 262144,
    "expiresInSeconds": 600
  },
  "expected": { "status": 200, "stored": {}, "message": "..." }
}
```

The other drives a read of a body already stored:

```json
{
  "kind": "result-reading",
  "description": "...",
  "input": {
    "body": {},
    "read": { "path": "/items", "select": ["id"], "offset": 0, "limit": 2 }
  },
  "expected": { "path": "/items", "kind": "array", "value": [] }
}
```

`read` holds the arguments as the agent sent them, before any check, so a fixture can pin an `invalid_selection`. `expected` is a `ReadResult` or an `SdkError`.

## Known limits

- A handle is a bearer value inside its partition. A host whose caller scope key does not tell callers apart, because it declares no identity carrier or its callers carry none of those it declares (a session cookie under the default `authorization`), has one partition for all of them; the visibility check is then what stands between a leaked handle and another caller, and it decides the tool, not whose answer was stored. An SDK SHOULD tell the host when it first stores a result for a call that carries none of its identity carriers.
- A gateway partitions by a digest of the caller's token, so a client that refreshes its token cannot read results stored under the previous one. The lifetime bounds that loss.
- The default store lives in one process. Behind a load balancer, a read that reaches another process answers `result_unavailable` unless the host binds a shared store.
- Member order is the order the parsed body enumerates. A JavaScript object enumerates integer-like member names first, so an implementation on another platform can order the outline and an object window differently.
- A string window counts UTF-16 code units, like the payload shape, so it can split a surrogate pair; the halves are still valid JSON escapes.
