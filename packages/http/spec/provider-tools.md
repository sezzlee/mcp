> Status: normative for implementations offering provider-backed tools. This is an optional
> extension; HTTP-only implementations retain their existing behavior.

# Provider-backed tools

A provider-backed tool is an explicitly registered operation with no corresponding HTTP route.
It shares the search-first MCP surface with HTTP-backed operations. HTTP remains one execution
target; it is not the descriptor of a provider operation.

## Registration and catalog

An implementation MUST require a tool name, description, runtime input validator, publishable
input schema, handler binding and explicit access policy. A public access policy is an explicit
choice, independent of MCP transport authentication. The input schema MUST describe a strict
object. The first Nest implementation accepts Standard Schema validators that also implement
Standard JSON Schema conversion to draft 2020-12. A declared output validator MUST run before
success is published. The published output schema describes the success envelope containing
`body`, rather than the body alone.

A provider binding MUST NOT register a route, fabricate an HTTP method/path, or pass through an
HTTP adapter. Provider and HTTP tool names occupy one namespace. A collision MUST fail catalog
activation; an invalid replacement catalog MUST NOT replace a working generation. Each invocation
uses the entry it resolved, including its handler, schemas and policy, for its entire lifetime.
The Nest implementation supports singleton providers with static dependency trees; missing,
ambiguous, transient and request-scoped bindings fail startup.

Search, detail, schema versions and change notifications use the same tool metadata conventions
as HTTP tools. Provider documents have no route field. A ranker MUST tolerate an absent route on
such documents. Existing HTTP rank documents keep their route fields. OpenAPI export contains
HTTP operations only and MUST diagnose provider omission. In the Nest SDK, `catalog.current` and
`find` preserve their HTTP-only contracts; `catalog.callable` and `findCallable` expose both target
kinds as a discriminated union.

## Access and execution

The implementation MUST resolve caller identity from the transport/host context, never from tool
arguments. A provider handler receives a fresh invocation context with the caller, tool name and
abort signal. Header access exposes transport headers; a host using a header as identity remains
responsible for authenticating it. A verified token is exposed through the existing caller claims.

An access policy is either explicitly public or returns an allow/deny answer for that context.
Unknown, missing, failed and non-true answers MUST NOT authorize execution. Search and detail may
evaluate the same policy, but a discovery answer MUST NOT replace an invocation-time check. Every
invocation and stored-result read MUST recheck access. HTTP visibility probes MUST NOT run for
provider entries. HTTP middleware, guards, pipes, interceptors and filters do not run for these
tools; hosts MUST express the required access checks in the tool policy and business service.

The deadline covers access, input validation, handler work and output validation. A cancelled or
expired invocation MUST NOT enter a handler that has not started. Cancellation propagates to the
handler's signal. A deadline bounds the awaited asynchronous work; it does not preempt synchronous
JavaScript, undo side effects, or provide process isolation. The invocation retains the existing
meta-tool admission/rate limits. In the Nest limiter context, HTTP `target` remains unchanged;
`providerTarget` identifies a provider tool without HTTP fields. Global invoke timeout and byte
limits apply to providers; the existing HTTP-specific per-target override hooks do not run for them.

## Results and errors

`schemas/provider-result.schema.json` defines provider success and stored-result envelopes.
Success is `{ "body": <JSON value> }`, with no HTTP status, content type or location. Results MUST
contain finite numbers and JSON-compatible values; cycles, `undefined`, bigint and class instances
are rejected. A declared output schema validates the returned body before delivery. The shared
UTF-8 response budget, narrowing guidance, result store and `read_result` selection apply. A result
over the buffered-result ceiling is refused rather than stored. For provider results this ceiling
is checked after materialization/serialization; it cannot limit allocations inside host code.
Stored provider envelopes omit HTTP metadata; stored HTTP envelopes remain unchanged. Result
partitions MUST identify callers through the configured identity carriers or scope resolver when
using identity-dependent results.

Provider failures use the existing SDK error envelope with these additive codes:

| Code                      | Meaning                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `provider_invalid_input`  | Input validation failed before handler entry               |
| `provider_forbidden`      | Access was denied, failed or absent                        |
| `provider_invalid_output` | Output failed validation or was not JSON-compatible        |
| `provider_failed`         | Work failed unexpectedly or the caller cancelled it        |
| `provider_business_error` | The handler intentionally raised a public business refusal |

Deadlines use `invoke_timeout`; response budgets use the existing refusal codes. Unexpected
exceptions and validation details MUST NOT be forwarded. The Nest `ProviderToolError` opts into
a public business message; that message still passes through the shared leak filter and response
budget. Cancellation or a deadline does not establish whether a mutating operation took effect.

Streaming, file uploads, HTTP parameter decorators, provider families and automatic HTTP lifecycle
emulation are outside this extension's first version. Adding a tool does not change the negotiated
MCP protocol revision. Consumers opting into provider tools must accept their documented envelopes
and absent rank-document routes; existing HTTP envelopes and authorizer signatures are unchanged.
