# Credentials

> Status: **normative, one implementation** (`packages/servers/openapi-mcp`). Applies to an invoker that calls a backend over the network. An embedded SDK forwards the caller's own carriers to its own pipeline and is not bound by this file.

An embedded SDK replays a call through the backend's own pipeline, so the caller's `Authorization` header is already addressed to the right audience. A network invoker is a separate service: the token the agent presented is addressed to the invoker, not to the backend. This document defines where the credential for a backend call comes from and where it is written.

## Invariants

1. **The caller's MCP token is never forwarded.** Its audience is the invoker ([transport.md](transport.md)); a backend that accepted it would have its audience check bypassed, and a stolen MCP token would reach the backend directly. There is no configuration that forwards it, including a declaration that the backend accepts the invoker's audience.
2. **A credential reaches only an allowlisted host.** The allowlist is the one invocation uses. A redirect is not followed, so a `Location` header cannot move a credential. A re-read document cannot move one either: the hosts the first catalog may call are the ceiling for every later catalog, and a document whose servers leave them, move one from https to plain http, or send a credential to a plain-http origin that did not carry it before is refused, keeping the running catalog.
3. **A credential is never an argument and never appears in a result.** It is written after composition and is invisible to the agent, the card, the error envelope and the log.

## Sources

| Source          | Satisfies                                                            | Identity at the backend                           |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| `static`        | `apiKey` (header, query, cookie), `http basic`, `http bearer`        | one service identity for every caller             |
| `tokenExchange` | the schemes the host names: `oauth2`, `openIdConnect`, `http bearer` | the caller, as the authorization server maps them |

A static value is declared by reference to an environment variable, never inline. A static source is the only one available on stdio, where there is no caller token to exchange.

## Choosing a requirement

`security` is a list of alternatives. The alternatives are combined with OR; the schemes inside one alternative are combined with AND.

1. `[]` or `[{}]` → anonymous: nothing is written.
2. Otherwise the invoker takes the **first alternative in document order whose every scheme it can satisfy**, and applies only that alternative.
3. No alternative can be satisfied → the operation is dropped at catalog time with `security_unsatisfiable`. It never reaches the agent as a tool that always fails.

Applying every configured scheme at once was rejected: it sends the backend credentials it did not ask for, and a backend that reads the first credential it finds may authenticate the call as the wrong principal.

## Placement

| Scheme                                   | Written as                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `apiKey`, `in: header`                   | header `<name>: <value>`                                                                             |
| `apiKey`, `in: query`                    | query pair `<name>=<value>`, percent-encoded like any query value, appended after the composed query |
| `apiKey`, `in: cookie`                   | cookie `<name>=<value>` in the single `Cookie` header                                                |
| `http basic`                             | `Authorization: Basic <base64(user ":" password)>`                                                   |
| `http bearer`, `oauth2`, `openIdConnect` | `Authorization: Bearer <token>`                                                                      |

A credential slot that collides with a composed value is an error, never an overwrite: `cookie_carrier_collision` for a cookie, and the existing identity-carrier rules keep a data parameter from occupying a header or query name a scheme uses (`identity_carrier_parameter`, [argument-mapping.md](argument-mapping.md)).

## Token exchange

The exchange follows RFC 8693:

```text
POST <token endpoint>
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<the caller's verified MCP access token>
subject_token_type=urn:ietf:params:oauth:token-type:access_token
audience=<configured>            (and/or resource=<configured>)
scope=<configured, optional>
```

The invoker authenticates to the token endpoint as a registered client (`client_secret_basic` or `client_secret_post`).

- **When.** At the transport's bearer gate, before the MCP request is served: the exchange **is** the gate's verification. The invoker holds no key for the caller's token; the authorization server that issued it validates it while exchanging it.
- **Cache.** Keyed by a digest of the subject token, the audience, the resource and the scope — never by the raw token. Lifetime is the smaller of the issued `expires_in` minus a skew and the subject token's own expiry, so an exchanged token never outlives the token it was issued for. Failures are not cached. Concurrent exchanges for the same key are coalesced into one request.
- **Failure.** A refused exchange answers the MCP request with `401` and the `invalid_token` bearer challenge, so the client re-authorizes; an unreachable or failing authorization server answers `500 server_error`. Neither is a tool error: the agent cannot repair a credential. The token endpoint's response body is never forwarded, for the reason a backend's 401 body is not — it describes the credential, not the call.
- **Configuration.** Token exchange configured on a stdio transport is `token_exchange_requires_http` and stops startup. An http transport **without** token exchange authenticates no caller, so it MUST listen on a loopback host only; otherwise the operator's static credentials would be offered to the network.

## Not specified

Mutual TLS, obtaining a token from a login endpoint, and OAuth flows in which the invoker itself is the resource owner's client (`authorizationCode`, `deviceAuthorization`). A scheme that needs one of them cannot be satisfied and is handled by [Choosing a requirement](#choosing-a-requirement).
