# Error Mapping

> Status: **normative** — validated by two independent implementations (ASP.NET `InvokeResultMapper` + TS `mapInvokeResult` pass the same `error-mapping/` corpus).

Converts the backend's HTTP errors into an MCP result the agent can act on **by reading the `invoke_tool` result alone** — repairing its arguments and retrying — while internal detail (a stack, a connection string, an internal path, an authentication body) MUST NEVER leak under any circumstances. The machine-readable counterpart is [schemas/invoke-result.schema.json](schemas/invoke-result.schema.json); the corpus is [conformance/error-mapping/](../conformance/error-mapping/).

## Principles

- The backend's HTTP status code is the single source of truth (RFC 9110); sezzlee adds no interpretation, reduces it to a nine-code dictionary, and forwards whatever is forwardable.
- The leak filter is mechanical and always on — there is no off switch; a host that wants raw output replaces the whole mapper (see below).
- The SDK's own composition errors (argument mapping, `unknown_tool`, `not_invocable`) and errors returned from the backend's pipeline share the **same envelope**; the agent has exactly one parsing path.
- `invoke_tool` MUST NOT consult the visibility filter ([visibility.md](visibility.md) invariant 1); this document defines only the _shape of the result_, not who may call.

## Wire form

An `invoke_tool` result stays JSON inside a single text content block. Success and failure share the same `CallToolResult` carrier and are distinguished by the `isError` flag:

- **Success** (when the backend returned `< 400`) → [`InvokeSuccess`](schemas/invoke-result.schema.json): `status`; `body` (the parsed value when the content type is JSON, otherwise the raw string together with `contentType`; when there is no body the field is absent entirely); `location` (when the response is a 3xx redirect).
- **A backend error** (4xx/5xx) → `CallToolResult.isError = true` plus a [`MappedError`](schemas/invoke-result.schema.json) envelope: `error` (a `BackendErrorCode`), `message`, `status`, `retryable`, `fields?`, `retryAfterSeconds?`, `reference?`.
- **An SDK-side error** — argument composition, `unknown_tool`, `not_invocable`, and the invoke guards of [invoke-semantics.md](invoke-semantics.md) — → `CallToolResult.isError = true` plus an [`SdkError`](schemas/invoke-result.schema.json) envelope: `error` (an `SdkErrorCode`), `message`, `retryable`, `fields?`, `payload?`. `status` MUST NOT be present: the backend was never reached, or its answer was discarded.

`load_tool`'s `unknown_tool` answer — for a tool hidden by visibility or one that genuinely does not exist ([visibility.md](visibility.md)) — uses the same `isError: true` plus `SdkError` shape; the two meta-tools speak one error language.

A JSON-RPC level error is used **only** for a protocol violation (a malformed `arguments` type, an invalid catalog state). A request the backend rejected MUST NEVER become a JSON-RPC error — it is always a normal result carrying `isError: true`. The rationale: that is the parsing agents and [sdks/nestjs/samples/agent-client](../../../sdks/nestjs/samples/agent-client) already implement, and two separate error channels would require two branches in agent code.

### SDK-side codes

Independent of any backend status code, fixture-pinned, and carried by `SdkError`. The two enums MUST stay disjoint; a shared member breaks the `InvokeResult` union.

| code                                                                                                                      | `retryable`                     | when                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown_argument`, `invalid_path_type`, `missing_path_parameter`, `header_injection`, `null_not_allowed`, `invalid_type` | false                           | Composition rejected the arguments ([argument-mapping.md](argument-mapping.md))                                                         |
| `deferred_value_missing`, `deferred_value_invalid`                                                                        | false                           | A curated value could not be resolved ([argument-curation.md](argument-curation.md))                                                    |
| `invalid_cookie_value`, `cookie_carrier_collision`                                                                        | false                           | A cookie argument could not be written, or would collide with the caller's identity cookie ([argument-mapping.md](argument-mapping.md)) |
| `invalid_file_argument`, `file_too_large`                                                                                 | false                           | A file argument was malformed or over its budget ([request-bodies.md](request-bodies.md))                                               |
| `file_unresolved`                                                                                                         | **true** only for `unavailable` | The file resolver did not deliver a `ref` ([request-bodies.md](request-bodies.md))                                                      |
| `unknown_tool`                                                                                                            | false                           | No such operation, or one the caller may not see                                                                                        |
| `not_invocable`                                                                                                           | false                           | The operation has no request template                                                                                                   |
| `tool_changed`                                                                                                            | false                           | The call pinned a tool version the answering process does not hold ([invoke-semantics.md](invoke-semantics.md))                         |
| `response_too_large`                                                                                                      | false                           | The answer exceeded the payload budget ([invoke-semantics.md](invoke-semantics.md))                                                     |
| `invoke_timeout`                                                                                                          | **true**                        | The invoke deadline expired ([invoke-semantics.md](invoke-semantics.md))                                                                |
| `search_ranker_unavailable`                                                                                               | **true**                        | A host-bound search ranker failed and the host chose `error` over fallback ([search-semantics.md](search-semantics.md))                 |
| `internal_error`                                                                                                          | false                           | The layer itself threw; the message passes the leak filter first                                                                        |

The first four families carry a message the SDK writes from the argument or tool name. `response_too_large` and `invoke_timeout` have standard messages pinned in [invoke-semantics.md](invoke-semantics.md), `search_ranker_unavailable` has the one pinned in [search-semantics.md](search-semantics.md), and a refused `ref` has the ones pinned in [request-bodies.md](request-bodies.md); `response_too_large` also carries `fields` and `payload`.

## Code dictionary

The backend's HTTP status is reduced to one of the following nine codes. `retryable` means "the same call may succeed later"; it does not indicate that the arguments were wrong — for argument errors it is always `false`.

| code                  | status                                         | retryable | standard message (when there is nothing forwardable)                                                                                                            |
| --------------------- | ---------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validation_failed`   | 400/422 with field errors, or a message array  | false     | "The backend rejected one or more arguments. Fix the listed fields and call the operation again."                                                               |
| `bad_request`         | 400, 405, 406, 415, 422 (no fields), other 4xx | false     | "The backend rejected the request ({status}) without usable details. Check the arguments against the input schema."                                             |
| `unauthenticated`     | 401                                            | false     | "The backend did not accept the caller's identity (401). The MCP session's credentials were forwarded unchanged; retrying with the same session will not help." |
| `forbidden`           | 403                                            | false     | "The caller is authenticated but not permitted to perform this operation (403)."                                                                                |
| `not_found`           | 404, 410                                       | false     | "No resource matched these arguments (404). The operation exists; check identifier arguments."                                                                  |
| `conflict`            | 409, 412, 428                                  | false     | "The request conflicts with the current state of the resource ({status}). Re-read the resource before retrying."                                                |
| `rate_limited`        | 429                                            | true      | "The backend is rate-limiting this caller (429). Retry after {retryAfterSeconds} seconds."                                                                      |
| `backend_error`       | 500, 501, other 5xx                            | false     | "The backend failed while handling the call ({status}). Details were withheld. Reference: {reference}."                                                         |
| `backend_unavailable` | 502, 503, 504, 408                             | true      | "The backend is temporarily unavailable ({status}). Retry later."                                                                                               |

The distinction between `validation_failed` and `bad_request` looks at **the body's structure**, not at the status code: if a 400/422 carries a field dictionary (`recognizeFieldErrors`) or Nest's message array arrives (`recognizeNestException`), the result is `validation_failed`; if the same statuses carry a single unstructured message it is `bad_request`. `408` should not be mistaken for appearing in two families: here it is only in `backend_unavailable` (it is read as the backend declaring itself temporarily unable, not as a client timeout).

## The mapping pipeline

The pure signature is identical in both languages:

```typescript
mapInvokeResult(response: BackendResponse, options?: { recognizers?: ErrorRecognizer[]; knownFields?: string[] }): InvokeSuccess | MappedError
```

`BackendResponse = { status, contentType?, headers, body }`. The body is parsed **once**: `ParsedBody = empty | json | html | text` — parsing is attempted when the content type is `application/json`/`text/json`/`*+json`, or when there is no content type at all; `text/*` MUST NEVER be parsed as JSON; HTML always takes its own branch.

The order is **first non-null result wins**:

1. **Host recognizers**, in registration order.
2. **Status short circuits:** `< 400` → success; `401` → the standard `unauthenticated` (the body is ignored entirely); `5xx` → the standard message, with `reference` taken only from a header or from a ProblemDetails `traceId`.
3. **Built-in recognizers**, in order:
   - `recognizeFieldErrors` — `{ errors: { field: string | string[] } }` (ASP.NET `ValidationProblemDetails`, Nest `exceptionFactory`).
   - `recognizeProblemDetails` — `application/problem+json`, or `{ title | detail, status }`.
   - `recognizeNestException` — `{ statusCode, message: string | string[], error? }`; when `message` is an array and the status is 400/422 the fields stay unnamed (see below).
   - `recognizeMessageEnvelope` — the first present key, case-insensitively, among `message, detail, error_description, error, title, reason`; or the whole body being a bare JSON string literal (because we send `Accept: application/json`, some backends return exactly that from calls like `BadRequest("...")`).
   - `recognizePlainText` — `text/*` or an unknown content type, and not HTML.
4. **Status-only fallback** — when nothing matched, the standard message from the code dictionary.
5. **The leak filter**, applied to **every forwarded string** including host-recognizer output (see below); the `Retry-After` header is converted to `retryAfterSeconds` only when it is an integer number of seconds; field names are normalized.

## Field errors

`fields[].name` is matched **case-insensitively** against the `inputSchema.properties` names (`knownFields` being that tool's input schema property names); with no match, the name is preserved as the backend gave it. The JSON-path prefix of ASP.NET's `ValidationProblemDetails` (`$.quantity`) is stripped and the remaining `quantity` is matched by name.

When Nest's `class-validator` output is a flat message array, the field name is embedded in the message text rather than structured. **When `knownFields` is supplied the name is resolved**: the message's leading token (cut at the first non-alphanumeric character) is matched case-insensitively against `knownFields`; on a match `fields[].name` is written, and without one the field stays unnamed.

This is not a guess: `knownFields` is a **closed** set built from that tool's `inputSchema.properties` names, so the match is a lookup. When `knownFields` is not supplied (raw mapper usage) the old behaviour is preserved — the field stays unnamed. The rule applies in both SDKs; it follows the same path in ASP.NET setups that return a flat message array. Fixture: `nest-message-array-resolves-known-field`.

Closed in phase 6: the rule became writable once the NestJS SDK's catalog layer could supply `knownFields`.

## Leak prevention

There is no switch: the rules below apply identically in every deployment.

**A. Never forwarded**

| Source       | Rule                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| A 401 body   | Never forwarded, under any circumstances.                                                                          |
| A 5xx body   | Not forwarded; only a ProblemDetails `traceId` (≤100 characters, `^[A-Za-z0-9:_.\-]+$`) is carried to `reference`. |
| An HTML body | Not forwarded, for any status.                                                                                     |
| Headers      | Nothing is read except `retry-after`, `location`, `x-correlation-id`, `x-request-id`, `request-id`, `x-trace-id`.  |

**B. Patterns applied to every forwarded string** — on a match the message is replaced with the status-standard message; for a field message specifically, "The value was rejected; details were withheld." is used:

| Pattern             | What it catches                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stack_frame`       | .NET/Java `at X.Y(`, Node `at ...(file:line:col)`, Python `Traceback`.                                                                                                    |
| `exception_type`    | `\w+Exception`; JS `TypeError \| ReferenceError \| ...`. Deliberately not a bare `\bError\b` — innocent messages such as "Error: quantity must be positive" have to pass. |
| `file_path`         | Windows/UNC paths; the `/Users`, `/home`, `/var`, `/usr`, `/opt`, `/srv`, `/app`, `/src`, `/etc`, `/tmp` roots; `file.cs:line N` forms.                                   |
| `connection_string` | `;`-separated key-values such as `Server=`, `Data Source=`, `Password=`; `mongodb\|postgres\|mysql\|redis\|amqp\|mssql://`; URL userinfo.                                 |
| `credential`        | `Bearer xxx`; a JWT (`eyJ...`).                                                                                                                                           |
| `too_long`          | A message longer than 1000 characters.                                                                                                                                    |

**C. The 403/404/409/400 forwarding rule:** if the `detail` or message trips none of the patterns above it **is forwarded**; if it trips one it is replaced with the standard message.

Allow-list-by-shape (forwarding only known envelope forms) was deliberately rejected: on the real backend, envelope-less 400 messages such as a plain `BadRequest("callId is required.")` would be lost in such a list. Instead the rules are **structural** (A) plus a **pattern-based deny-list** (B); a clean message in an unrecognized envelope passes.

## 401 and 403 (asymmetric)

A 401 body is never forwarded under any circumstances — the evidence from the real backend: its `JwtAuthenticationMiddleware` writes a 401 body of `{"error":"Unauthorized","message":"Portal resolution failed: " + ex.Message}`, so an inner exception message could leak straight to the agent. 403 is different: if `detail` passes the leak filter cleanly it is forwarded — a resource-level reason ("someone else's order", "outside business hours") is actionable for an agent, whereas a 401 has no forwardable reason at all: the identity channel is already fixed (the credentials the MCP session carries), and retrying with the same session will not help.

**Rationale ("the SDK does not invent"):** the standard messages state only what the backend declared itself through its status code (RFC 9110) and what sezzlee knows about itself. Dropping the 401 body is the authentication form of [visibility.md](visibility.md) invariant 4 ("hiding MUST NOT report a reason"); 403 behaving differently does not contradict that principle, because a resource-level rejection has already disclosed existence (the endpoint is visible, the argument shape was correct) and only a reason is added.

## 404

The SDK cannot tell a wrong route from a missing resource — because the route was produced by sezzlee from the catalog and reached with correctly composed arguments (the tool exists, and argument composition passed steps 1-5), **a resource is assumed**: `not_found`, whose guidance is to check identifier arguments. `410` joins the same family (the resource existed and no longer does — from the agent's point of view the distinction is meaningless).

## 5xx and retrying

500/501 and any other unlisted 5xx are `retryable = false`: this is the backend's own failure, and retrying with the same arguments generally produces the same result. The sole exception is the `backend_unavailable` family (502/503/504/408), where a transient infrastructure fault is assumed and `retryable = true`. No 5xx body is forwarded; only `reference` (a ProblemDetails `traceId` or a known correlation header) may be carried.

## Extension points

Exactly two — nothing beyond them is added without demonstrated demand:

- **(a) Replace the mapper entirely.** dotnet: `IInvokeResultMapper { InvokeOutcome Map(BackendResponse, IReadOnlySet<string> knownFields) }`, registered with `TryAddSingleton<IInvokeResultMapper, InvokeResultMapper>`. Nest: `ExtensionPoints.invokeResultMapper`. A host that wants raw output, or an entirely different mapping, uses this.
- **(b) Add a recognizer at the front.** dotnet: `options.Errors.Recognize(ErrorRecognizer)`. Nest: `options.errors.recognize(fn)`. It runs **before** the built-in recognizers (step 1), and its output still passes through the leak filter (step 5). Same delegate style as the existing `Identity.Project`/`Naming.Prefix`.

**Deliberately not added:** a redact/post-process hook (the filter is already mechanical and always on; a host wanting raw output uses (a)), per-status message overrides, i18n, and parsing the HTTP-date form of `Retry-After`.

## Fixture pattern

An `error-mapping` fixture's `input` is a [`BackendResponseSpec`](schemas/fixture.schema.json): `status` (required), `contentType?`, `headers?` (lowercase keys), `body?` (a string is raw text; an object or array is serialized by the harness with `JSON.stringify` and handed to the parser that way), `knownFields?` (the set of field names to pass to `mapInvokeResult`). `expected` conforms directly to [`invoke-result.schema.json`](schemas/invoke-result.schema.json) (either `InvokeSuccess` or `MappedError`). For envelope and directory rules see [fixture-format.md](fixture-format.md).

## Known limits

- `Retry-After` is read only as an integer number of seconds; the HTTP-date form (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`) is not supported — `retryAfterSeconds` simply stays unfilled in that case.
- The standard messages are always in English (the meta-tools' language — [search-semantics.md](search-semantics.md)); a message the backend returned in its own language is forwarded **in that language** if it passes the leak filter cleanly, and is never translated.
- In-body correlation identifiers (a `correlationId` carried as a body field rather than a header) are not carried to `reference`; only a header or a ProblemDetails `traceId` is read.
