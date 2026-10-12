# Transport and OAuth 2.1

> Status: **normative** — validated by two independent implementations (the ASP.NET T1-T15 and Nest N1-N6 / G1-G2 matrices, plus `sdks/nestjs/samples/agent-client` against both demos).

Defines what sezzlee adds on top of the Streamable HTTP transport: a `tools/list_changed` notification when the catalog changes, and RFC 9728 Protected Resource Metadata (PRM) with 401 decoration. Session management, Origin/CORS/TLS, and authorization itself (whether auth is required) are the **host's** design — ASP.NET and Express already offer first-class idioms for those; sezzlee does not wrap them and only adds the two things that have no idiom.

## Scope

The complete surface sezzlee adds to the transport layer:

1. `tools/list_changed` fan-out, bound to catalog reload.
2. `GET /.well-known/oauth-protected-resource{mcpPath}` — the RFC 9728 PRM document, when `ResourceServer.Metadata` is configured.
3. `resource_metadata` decoration in the `WWW-Authenticate` header of 401 responses (without touching the host's own 401 body or its existing challenge parameters).
4. The audience rule (RFC 8707) — the SDK does not perform validation; it states what the host must put into its `TokenValidationParameters`/verifier.

sezzlee MUST **never** set up `AddAuthentication`/`AddMcp` or an equivalent auth pipeline; enforcement is always whatever mechanism the host already has (JwtBearer plus `.RequireAuthorization()`, custom middleware, or nothing).

## Protocol revisions

The revisions sezzlee speaks are declared in one place, [schemas/protocol-revision.schema.json](schemas/protocol-revision.schema.json), and reach every language through code generation — `ProtocolRevision` plus `protocolRevisions`/`defaultProtocolRevision` in TypeScript (`@sezzlee/core`), the `ProtocolRevision` constants class in C# (`Sezzlee.AspNetCore.Spec`). A revision spelled as a literal anywhere else is a defect: a server that advertises one set and a test that probes another negotiate against different protocols and the mismatch surfaces as a transport error with no revision named in it.

`default` names what an sezzlee server advertises when the caller states no preference. It is the newest revision in the enum, and it moves only when a new revision is added to the schema.

## Session mode

There is no session mode, and sezzlee offers no knob for one. The 2026-07-28 revision removed protocol-level sessions and the `Mcp-Session-Id` header, so both SDKs serve every request on its own.

- **.NET:** `HttpServerTransportOptions.SessionMode` defaults to `Stateless` (the 2026-07-28 protocol, no `Mcp-Session-Id`). A host that wants otherwise changes it with `services.Configure<HttpServerTransportOptions>(o => o.SessionMode = StatefulForInitializeClients)` — ASP.NET's own idiom, a surface sezzlee does not wrap.
- **Nest:** `SezzleeStreamableHttp.serve(factory)` binds one endpoint to `createMcpHandler`, which builds a fresh `McpServer` per exchange. Its `legacy: 'stateless'` default serves 2025-era traffic the same way, so GET and DELETE — the 2025 session operations — are answered with `405`.

A server that needs state across calls mints an explicit handle and passes it as an ordinary tool argument; nothing is keyed on the connection. Because `tools/list` no longer varies per connection, a catalogue that differs per caller is advertised with `cacheScope: "private"` — the SDK's default for every cacheable result, so a visibility-filtered catalogue is never published to a shared cache by accident.

## `listChanged` semantics

sezzlee's three meta-tools (`search_tools`, `load_tool`, `invoke_tool`) do **not** change when the catalog changes — the backend endpoint catalog behind them does. So what carries the change is not the meta-tool list itself but each meta-tool's `_meta` field:

- The `tools.listChanged` capability is always declared `true`.
- Every meta-tool definition is stamped with `_meta["sezzlee/catalogGeneration"]` — the catalog snapshot's generation counter ([caching.md](caching.md), "Invalidation" — `ISezzleeCatalogChangeSource.ReloadAsync` → `Generation++`).
- The notification fires **only** on catalog reload; authorization-invalidation operations (`InvalidateCallerAsync` and friends) do not change the catalog and therefore MUST NOT trigger `listChanged`. The payload a `tools/list` call returns genuinely differs when the generation changes (the `_meta` stamp increments) — the notification is honest, not an empty "something changed" signal.

**The .NET mechanism:** the `McpServerOptions.ToolCollection.Changed` event triggers the SDK's own `SendListChangedNotificationAsync` (covering both the pre-SEP-2575 broadcast and the 2026-07-28 `subscriptions/listen` routing). sezzlee does not build its own session registry — commandeering the SDK's single-slot `RunSessionHandler`/`ConfigureSessionOptions` would mean rewriting the fan-out the SDK already performs. A single `NotifyChanged()` call reaches every live session in every mode; in stateless mode, with no listener, nothing happens silently.

**The Nest mechanism:** `registerSezzleeTools` stamps the generation into each meta-tool's `_meta` as it registers them. Re-stamping a live instance is no longer a thing to do — the instance serving the next `tools/list` is built after the reload and reads the current generation — so the only moving part is delivery: the module subscribes to catalog changes once and calls `SezzleeStreamableHttp.notifyToolListChanged()`, which publishes `toolsChanged` on each endpoint's `subscriptions/listen` bus. A 2026-07-28 client that opened a listen stream receives exactly one notification per reload; a 2025-era stateless client has no server-to-client channel at all, so nothing is sent and nothing fails.

**The gateway mechanism:** `openapi-mcp` re-reads its document when the operator configures `reload` ([its README](../../servers/openapi-mcp/README.md)) and follows the reload order of [caching.md](caching.md): a candidate with a fatal diagnostic keeps the current catalog. On the http transport each request gets a fresh instance that reads the current generation, and a commit publishes `toolsChanged` on the handler's bus; on stdio the one pinned instance re-stamps its meta-tools and sends a single `tools/list_changed`.

**Known limit (documented):** on the .NET side, if the host uses its own `ConfigureSessionOptions` to create a per-session clone of the tool collection and that clone does not share sezzlee's collection reference, the fan-out will not reach that session. In a multi-instance deployment the notification reaches only the sessions in the local process — cross-instance fan-out is outside sezzlee's scope. The Nest side has the same limit for the same reason: `createMcpHandler`'s default change-event bus is in-process, and a multi-process deployment supplies its own `ServerEventBus`.

## Protected Resource Metadata (PRM)

When `ResourceServer.Metadata` is configured (if the host does not set it, the PRM endpoint is never published and no decoration is ever added):

- **Path:** `GET /.well-known/oauth-protected-resource{mcpPath}`, where `mcpPath` is the path of the endpoint sezzlee is mapped to (for `/mcp`, therefore, `/.well-known/oauth-protected-resource/mcp`), following RFC 9728's path-prefix rule.
- **Required fields:** `resource` and `authorization_servers` (at least one element) — without both, startup validation fails, and PRM is never published incomplete.
- **Access:** the endpoint is fully anonymous; it is the first step of the authentication flow and cannot itself be protected.
- **Caching:** `Cache-Control: public, max-age=300`.
- **`ChallengeUri`** is derived by prefixing `Metadata.Resource` with the `/.well-known/oauth-protected-resource` path segment; it is **not** derived from the incoming request (Host header, proxy) — for deployments behind a proxy this is explicitly `Metadata.Resource` itself, never implicit.

## The 401 rule — merging

sezzlee's transport layer adds `resource_metadata="<ChallengeUri>"` to the `WWW-Authenticate` header of every `401` response on the protected path (plus `scope="..."` when present), **but**:

- If the host already wrote a `WWW-Authenticate: Bearer ...` (for example ASP.NET JwtBearer's own `error="invalid_token"` challenge), sezzlee MUST NOT add a new header — it **merges** the `resource_metadata` parameter into the single existing `Bearer` value. The rationale: the `WWW-Authenticate` parsers on both the .NET and TS sides (`ParseWwwAuthenticateParameters`, `extractWWWAuthenticateParams`) expect one `Bearer` value, and a second header may stay invisible to clients.
- If the host wrote no `WWW-Authenticate` at all (for example custom middleware, such as the real backend's `JwtAuthenticationMiddleware`), sezzlee adds the `Bearer resource_metadata="..."` header **from scratch**.
- **The host's 401 body MUST NEVER be modified** — decoration is at the header level only; body leak-prevention rules are defined in [error-mapping.md](error-mapping.md), and PRM decoration is independent of them.
- If the host's own SDK `AddMcp`/`mcpAuthMetadataRouter` already adds `resource_metadata`, sezzlee **sees it and does not touch it** — whichever service runs first serves PRM, and there is no double write.

## Audience (RFC 8707)

sezzlee does **not** perform audience validation — it states what value the host must put into the `TokenValidationParameters`/verifier mechanism it already has: `ValidAudience` (or its equivalent) MUST be **the same** as `ResourceServer.Metadata.Resource`. RFC 8707 requires the authorization server issuing the token to write that `resource` value into the `aud` claim; the host's token validator (including a custom validator) must accept that audience, or add sezzlee's MCP URL to its `ValidAudiences` list.

## Scope delegation

Scope is fully **delegated** to the host: `ScopesSupported` is passed through into the PRM document as-is, and sezzlee does not inspect, validate or enforce scope contents. Which scope is required for which operation is a decision of the backend's own authorization layer (policy, guard) — and [visibility.md](visibility.md)'s T1 declarative tier already reads those decisions.

## Host responsibilities

| Responsibility               | .NET                                                               | Nest                                                                    | sezzlee's role                                                              |
| ---------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Requiring auth (enforcement) | `.RequireAuthorization()` (on the builder `MapSezzlee` returns)    | A guard or middleware, the host's choice                                | Never calls it; offers no knob — the host already has an idiomatic path     |
| Origin/CORS/DNS rebinding    | The host's own CORS middleware                                     | `hostHeaderValidation([...])` (not the deprecated `allowedHosts`)       | Adds no middleware; if bearer is required, rebinding cannot obtain a token  |
| TLS                          | The host's hosting / reverse-proxy setup                           | The same                                                                | Out of scope                                                                |
| Body limits                  | The host's own limits                                              | The host's own body parser limits                                       | Documents them, does not wrap them                                          |
| Session mode                 | `HttpServerTransportOptions.SessionMode` (defaults to `Stateless`) | None — serving is per request                                           | Publishes `listChanged` on the subscription bus; there is no mode to choose |
| Audience validation          | `JwtBearer.ValidAudience = Metadata.Resource`                      | The `authInfo.resource` the `verifier` returns plus `withAudienceCheck` | Provides the rule and the tests; the host's validator does the validating   |

## SDK parity

| Topic                                                                                  | .NET test | Nest test                                                               |
| -------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------- |
| PRM anonymous, RFC 9728 shape                                                          | T1        | `transport.spec.ts` (N1–N6)                                             |
| No bearer → 401 plus `resource_metadata`                                               | T2        | `transport.spec.ts` (N1–N6)                                             |
| Invalid token → 401, merged into the existing challenge                                | T3        | `transport.spec.ts` (N1–N6)                                             |
| A wrong audience is rejected                                                           | T4        | `transport.spec.ts` (N1–N6)                                             |
| The issued token's `aud` equals the MCP resource URL                                   | T6        | `transport.spec.ts` (N1–N6)                                             |
| The full OAuth flow (DCR → PKCE → token → `search_tools`)                              | T5        | End to end with `sdks/nestjs/samples/agent-client` (against both demos) |
| On a custom-middleware host, the body is preserved and a challenge is added            | T7        | — (the simulated host is .NET-specific)                                 |
| With `ResourceServer` unconfigured, no PRM and no decoration at all                    | T8        | `transport.spec.ts` (N1–N6)                                             |
| A subscribed client receives `tools/list_changed` after a catalogue reload             | T9        | `transport.spec.ts` (N1–N6)                                             |
| With no subscription open, no notification and no error                                | T10       | `transport.spec.ts` (N1–N6)                                             |
| `initialize` declares `tools.listChanged`                                              | T11       | `transport.spec.ts` (N1–N6)                                             |
| `tools/list` carries the `_meta` generation and it increments after a change           | T12       | `transport.spec.ts` (N1–N6)                                             |
| With the host's own `AddMcp`/`mcpAuthMetadataRouter`, no duplicate `resource_metadata` | T13       | `transport.spec.ts` (N1–N6)                                             |
| `.RequireAuthorization()` blocks an anonymous `initialize`                             | T14       | `transport.spec.ts` (N1–N6)                                             |
| Without `ResourceServer.Metadata.Resource`, validation fails                           | T15       | `transport.spec.ts` (N1–N6)                                             |

On the Nest side the granular test-to-concept mapping lives in `transport.spec.ts` itself (an implementation detail); in both SDKs the full OAuth round trip is validated not inside the SDK's own test suite but against the running demo with [sdks/nestjs/samples/agent-client](../../../sdks/nestjs/samples/agent-client) — which on the dotnet side holds **in addition to** T5's TestServer run inside xunit, not instead of it.

## The demo authorization server

An in-repo authorization server with no Docker and no external service (`sdks/dotnet/samples/DemoAuthServer/`; on the Nest side the SDK's own `mcpAuthRouter` plus an in-memory provider) exists so that all three exit criteria (DemoApi, the xunit `TestServer`, the Nest demo) can run the OAuth 2.1 flow (DCR, mandatory PKCE S256, authorization code, refresh) end to end inside a single process. An external authorization server (Keycloak, Duende, Auth0) is only documented as "this is how you connect in production" and does not enter the repository.
