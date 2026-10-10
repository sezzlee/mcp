# @sezzlee/openapi-mcp

MCP server that exposes an OpenAPI (Swagger 2.0 / OpenAPI 3.0–3.2) document as sezzlee's
search-first tool catalog — `search_tools`, `load_tool`, `invoke_tool` — over a **remote**
backend, calling it with `fetch`.

> Status: `0.1.0`, alpha. Install with `npm install -g @sezzlee/openapi-mcp` or run it with
> `npx -y @sezzlee/openapi-mcp`; the binary is `sezzlee-openapi`.

## How this differs from the embedded SDKs

`Sezzlee.AspNetCore` and the NestJS SDK sit **inside** your backend process: they discover
endpoints from your own controllers/routes and replay each MCP call through your existing
pipeline, so your authentication and authorization run exactly as they do today.

`openapi-mcp` is a separate service. It has no access to a backend's process or pipeline — it
reads the backend's **OpenAPI document** to learn what operations exist ([the ingestion
rules](../../http/spec/openapi-ingestion.md)), and calls the backend over the network for every
invocation, attaching a credential it resolves itself ([how a credential is chosen and
written](../../http/spec/credentials.md)). This is the only path for a backend that has no
embedded SDK integrated into it.

## Quick start

The server reads its configuration from the file named by `SEZZLEE_OPENAPI_CONFIG`. Build the
package first (this repository never runs `@sezzlee/core`'s consumers against a stale `dist`):

```bash
pnpm turbo run build --filter=@sezzlee/openapi-mcp
```

A minimal config — a local document, opt-in selection so at least one operation is exposed,
default `stdio` transport:

```json
{
  "source": "./openapi.json",
  "selection": { "default": "include" }
}
```

```bash
SEZZLEE_OPENAPI_CONFIG=/absolute/path/to/config.json node packages/servers/openapi-mcp/dist/cli.js
```

`source` is either a path (resolved relative to the config file's own directory) or an
`http(s)://` URL. On startup the server ingests the document, builds the catalog, prints a
one-line-per-diagnostic-code summary to stderr, and then serves `stdio` or listens for
`streamable HTTP`, depending on `transport.kind`.

A config that fails validation, or that names an environment variable that is not set, stops the
process with a message on stderr and exit code `2`. A document that ingests with a fatal
diagnostic, or a catalog with a fatal diagnostic (`name_collision`, `invalid_name`,
`ambiguous_selection`, …), stops it with exit code `1`.

## Configuration

All keys below are read from the `SEZZLEE_OPENAPI_CONFIG` JSON file and validated with a `zod`
schema (`src/platform/config.ts`) that rejects unknown keys.

| Key                              | Type                                       | Default        | Notes                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `transport.kind`                 | `"stdio"` \| `"http"`                      | `"stdio"`      | —                                                                                                                                                                              |
| `transport.host`                 | string (`http` only)                       | `"127.0.0.1"`  | Must stay loopback (`127.0.0.1`, `::1`, `localhost`) unless `tokenExchange` is configured — see below                                                                          |
| `transport.port`                 | int, 0–65535 (`http` only)                 | `8787`         | —                                                                                                                                                                              |
| `transport.path`                 | string starting with `/` (`http` only)     | `"/mcp"`       | —                                                                                                                                                                              |
| `transport.resource`             | url (`http` only)                          | required       | The OAuth protected-resource identifier advertised at `/.well-known/oauth-protected-resource`                                                                                  |
| `transport.authorizationServers` | array of url, min 1 (`http` only)          | required       | —                                                                                                                                                                              |
| `transport.allowedHostnames`     | array of string (`http` only)              | `[]`           | Extra `Host` header values accepted, on top of the localhost defaults                                                                                                          |
| `tokenExchange`                  | object                                     | not configured | RFC 8693 token exchange; required for an `http` transport to authenticate a caller (see [Rules](#rules))                                                                       |
| `tokenExchange.tokenEndpoint`    | url                                        | required       | —                                                                                                                                                                              |
| `tokenExchange.clientId`         | string                                     | required       | —                                                                                                                                                                              |
| `tokenExchange.clientSecret`     | `{ fromEnv: string }`                      | required       | —                                                                                                                                                                              |
| `tokenExchange.clientAuth`       | `"basic"` \| `"post"`                      | `"basic"`      | `client_secret_basic` or `client_secret_post`                                                                                                                                  |
| `tokenExchange.audience`         | string                                     | not sent       | —                                                                                                                                                                              |
| `tokenExchange.resource`         | url                                        | not sent       | —                                                                                                                                                                              |
| `tokenExchange.scope`            | string                                     | not sent       | —                                                                                                                                                                              |
| `tokenExchange.schemes`          | array of string, min 1                     | required       | The security scheme names the exchanged token satisfies                                                                                                                        |
| `source`                         | string, non-empty                          | required       | A local file path (relative to the config file) or an `http(s)://` URL to the OpenAPI document                                                                                 |
| `baseUrl`                        | url                                        | not set        | Replaces the document's root `servers`                                                                                                                                         |
| `serverVariables`                | record\<string, string\>                   | not set        | Overrides for the document's server variable defaults                                                                                                                          |
| `hoistPathPrefix`                | string starting with `/`                   | not set        | A leading path segment moved from every route into the base URL                                                                                                                |
| `outputSchema`                   | `"document"` \| `"omit"`                   | `"document"`   | `omit` for a backend whose responses do not match its document                                                                                                                 |
| `requestBodyRequired`            | `"document"` \| `"always"`                 | `"document"`   | `always` treats an undeclared `requestBody.required` as `true`                                                                                                                 |
| `strict`                         | boolean                                    | `false`        | Raises `openapi_document_invalid` from a warning to a fatal diagnostic                                                                                                         |
| `selection.default`              | `"include"` \| `"exclude"`                 | `"exclude"`    | Whether an operation is exposed when no rule matches it (opt-in by default)                                                                                                    |
| `selection.rules`                | array of `{ route?, method?, decision }`   | `[]`           | `route`/`method` are matched the same way the embedded SDKs match a controller route                                                                                           |
| `names`                          | record\<operation key, string\>            | `{}`           | Overrides a tool's name; the value must match `^[a-z][a-z0-9_]{0,255}$`                                                                                                        |
| `credentials`                    | record\<security scheme name, credential\> | `{}`           | Either `{ "value": { "fromEnv": "..." } }` or `{ "username": { "fromEnv": "..." }, "password": { "fromEnv": "..." } }`; see [credentials.md](../../http/spec/credentials.md)   |
| `allowHosts`                     | array of string                            | `[]`           | Hosts a backend operation may be served from, beyond the document's own root server                                                                                            |
| `refHosts`                       | array of string                            | `[]`           | Hosts an external `$ref` may be fetched from, beyond the document's own host. Kept apart from `allowHosts`, so allowing a schema host never lets calls or credentials go there |
| `identityCookies`                | array of string                            | `[]`           | Cookie names treated as identity carriers on top of the default deny-list (compared case-insensitively); they extend it and never replace it                                   |
| `limits.timeoutMs`               | positive int                               | `30000`        | Per-invocation deadline                                                                                                                                                        |
| `limits.maxResponseBytes`        | positive int                               | `262144`       | Response byte cap, applied while the body streams                                                                                                                              |
| `limits.maxInlineFileBytes`      | positive int                               | `1048576`      | —                                                                                                                                                                              |

A `credentials` entry is keyed by the security scheme name it satisfies; a `tokenExchange.schemes`
entry marks that same scheme as satisfied by the exchanged token instead. `credentials` values are
never inlined — only a reference to an environment variable — so a config file can be committed
and shared.

## Rules

- **Only `src/net/fetch.ts` reaches the network.** It is the one place the host allowlist, the
  manual redirect handling and the byte cap are applied; `src/transport/http.ts` may use
  `node:http` only to _listen_, never to call out. Redirects are never followed — a followed
  redirect could carry a request, and its credential, to a host the allowlist never approved.
- **Only `src/platform/files.ts` touches the filesystem.** A file the document references through
  an external `$ref`, or named by `source`, is checked against the directory the document was
  read from on its _realpath_, so neither a `../` segment nor a symbolic link can escape it.
- **The caller's MCP token is never forwarded to the backend.** Its audience is this server, not
  the backend; forwarding it would bypass the backend's own audience check. On the `http`
  transport with `tokenExchange` configured, the caller's token is exchanged (RFC 8693) for a
  backend-scoped token at the transport's bearer gate, and only the exchanged token reaches
  `invoke_tool`.
- **An `http` transport without `tokenExchange` authenticates no caller**, so it may only bind a
  loopback host (`127.0.0.1`, `::1`, `localhost`); otherwise the operator's static credentials
  would be reachable from the network. Configuring `tokenExchange` on the `stdio` transport is
  likewise refused (`token_exchange_requires_http`) — there is no caller token on `stdio` to
  exchange.
- Visibility is not enforcement: an operation's `security` says which credential a call needs, not
  which caller may make it, so the catalog reports every operation's identity as `unknown` unless
  its document says `security: []`.

## Development

```bash
pnpm turbo run build --filter=@sezzlee/openapi-mcp
pnpm turbo run lint --filter=@sezzlee/openapi-mcp
pnpm turbo run check-types --filter=@sezzlee/openapi-mcp
pnpm turbo run test --filter=@sezzlee/openapi-mcp
```

Run these through Turbo, not `pnpm --filter @sezzlee/openapi-mcp <task>` — the bare filter skips
`dependsOn: ["build"]` and the test task would run against a stale `dist`.

`test/` holds four suites:

- `gateway.spec.ts`, `http.spec.ts` — unit tests, no environment variables needed.
- `acceptance.spec.ts` — skipped unless `SEZZLEE_OPENAPI_ACCEPTANCE_DOC` names a path to a real
  backend's OpenAPI document. The document itself never enters the repository; the suite ingests
  it, builds a catalog, asserts there is no fatal diagnostic, and prints the diagnostic summary
  instead of pinning a snapshot that would copy that backend's surface into the tree.
- `parity.spec.ts` — skipped unless `SEZZLEE_PARITY_DIR` names a directory of fixtures written by
  `sdks/dotnet/tests/Sezzlee.Tests/OpenApiParityDump.cs`, comparing this ingestion's output against
  the .NET SDK's.

Both `SEZZLEE_OPENAPI_ACCEPTANCE_DOC` and `SEZZLEE_PARITY_DIR` are declared in `turbo.json`'s `test`
task so Turbo passes them through.
