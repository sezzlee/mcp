# agent-client

A small CLI that drives the `search_tools` → `load_tool` → `invoke_tool` flow with a real MCP
client (`@modelcontextprotocol/sdk`) and automates the "done" criteria for each flow. It runs
against the Nest demo (`sdks/nestjs/samples/demo-api`); with `SEZZLEE_AUTH=bearer` it can run
against any sezzlee backend.

## Setup and build

From the repository root:

```sh
pnpm install
pnpm turbo run build --filter=@sezzlee/agent-client
```

## Environment variables

| Variable           | Default                 | Description                                                          |
| ------------------ | ----------------------- | -------------------------------------------------------------------- |
| `SEZZLEE_BASE_URL` | `http://127.0.0.1:3000` | The backend's root URL; the MCP endpoint is called at `{base}/mcp`.  |
| `SEZZLEE_USER`     | `alice`                 | The demo username (used as `login_hint` in `token`/`oauth` modes).   |
| `SEZZLEE_AUTH`     | `oauth`                 | `oauth` \| `token` \| `bearer`.                                      |
| `SEZZLEE_TOKEN`    | —                       | Required only when `SEZZLEE_AUTH=bearer`, a ready-made access token. |

## Auth modes

- **`oauth`** (default): `src/headless-oauth-provider.ts` implements
  `@modelcontextprotocol/sdk`'s `OAuthClientProvider` in memory. The first connection attempt
  through `StreamableHTTPClientTransport` throws `UnauthorizedError`; the provider's
  `redirectToAuthorization` method appends `login_hint=<SEZZLEE_USER>` to the authorization URL and
  fetches it with `redirect: "manual"`, capturing the authorization code from the `Location`
  header. `finishAuth` is then called on a fresh transport with the captured callback parameters,
  and the session reconnects through it. Because the demo authorization server auto-consents, the
  whole flow is headless.
- **`token`**: `POST {base}/auth/token {"user": SEZZLEE_USER}` → `{ access_token }`; the token is
  then sent on every request as a static `Authorization: Bearer` header. This is the demo's
  shortcut.
- **`bearer`**: uses `SEZZLEE_TOKEN` as-is, as a static bearer token — for running against a real
  backend with your own token.

If the connection cannot be established (a wrong or missing token, an incomplete OAuth flow, and
so on) the process exits with **code 3**.

## Scenarios

`--scenario provider` loads and invokes the demo's `summarize_note` provider tool, verifies its
JSON result without HTTP status metadata, and checks that `POST /summarize_note` returns 404.
Build the demo and agent-client through Turbo, start the demo API, then run
`SEZZLEE_AUTH=token node sdks/nestjs/samples/agent-client/dist/main.js --scenario provider`.

```sh
node dist/main.js --scenario <smoke|validation-retry|error-envelope|upload|family> [--tool <name>] [--query <q>] [--arguments <json>]
```

The legacy positional form (`<query> [tool] [argumentsJson]`) still works and maps to the `smoke`
scenario.

- **`smoke`**: verifies that `tools/list` contains the three meta-tools, and that `search_tools`
  (default query is a non-ASCII term used to exercise tokenization), `load_tool` and `invoke_tool`
  (default arguments `{}`) all succeed; each step is printed in a checklist table. The result is
  **exit 0** when the call is not `isError` and `status < 400`, otherwise **exit 1**.
- **`validation-retry`**: starts with `search_tools` (default query `"create order"`); if `--tool`
  is not given, it picks the first result that has required fields. It then builds **deliberately
  invalid** arguments from the schema (`string → ""`, `integer`/`number → 0`, `boolean → false`,
  required fields only). It verifies that the first `invoke_tool` call reports `isError: true`,
  `error: "validation_failed"`, at least one `fields` entry, and no leaked internal detail in any
  message. It then makes a second `invoke_tool` call with arguments fixed **only from the returned
  `fields` payload** (`string → "sample"`, `integer`/`number → 1`, `boolean → true`); this call is
  expected to be `!isError` with a `2xx` status. Both payloads are printed. Success is **exit 0**.
- **`error-envelope`**: calls `invoke_tool` directly with `--tool` and `--arguments`
  (backend-agnostic — it can be pointed at any other backend too). It verifies `isError: true`,
  that `error` is one of nine backend codes or eleven SDK codes, that backend codes carry a
  `status`, and that the message is non-empty and carries no leaked internal detail. Success is
  **exit 0**.
- **`upload`**: searches for a tool with a file argument (default query `"attach file"`), then
  drives it through four calls: a text file, the caller's own file reference when the schema
  offers a `ref` field, a reference that resolves to nothing, and a malformed file argument (both
  `text` and `base64` set). The first two must succeed; the unresolved reference must come back as
  an SDK-side `file_unresolved` error, and the malformed argument as an SDK-side
  `invalid_file_argument` error — never as a backend error built from an empty part. Success is
  **exit 0**.
- **`family`**: drives the demo's dispatching endpoint (`POST /Rest/InvokeDynamicMethod/{methodId}`),
  published as one tool per method ([tool-families.md](../../../../packages/http/spec/tool-families.md)).
  It verifies that `search_tools "courier"` (or `--query`) ranks `assign_courier` first, that its
  loaded schema has `orderNumber` and `courierCode` but no `methodId` and is marked destructive,
  that invoking it reaches the backend with that member's own key (the demo echoes the key and the
  method it resolved), that sending `methodId` as an argument comes back as an SDK-side
  `unknown_argument` error, and that searching for the member's key finds nothing. Success is
  **exit 0**.

## Exit codes

| Code | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 0    | The scenario passed.                                                 |
| 1    | An assertion failed.                                                 |
| 2    | A setup problem: no tool matched the query, or `load_tool` errored.  |
| 3    | An auth failure: the connection or session could not be established. |

## Example runs

Against the Nest demo (default OAuth flow):

```sh
pnpm turbo run build --filter=@sezzlee/demo-nestjs
node sdks/nestjs/samples/demo-api/dist/main.js &
SEZZLEE_AUTH=oauth SEZZLEE_USER=alice node sdks/nestjs/samples/agent-client/dist/main.js --scenario smoke
```

With today's demo token shortcut:

```sh
SEZZLEE_AUTH=token SEZZLEE_USER=alice node sdks/nestjs/samples/agent-client/dist/main.js --scenario validation-retry
```

Against a real backend (if you already hold a valid access token):

```sh
SEZZLEE_AUTH=bearer SEZZLEE_TOKEN=eyJ... SEZZLEE_BASE_URL=https://example.internal \
  node sdks/nestjs/samples/agent-client/dist/main.js --scenario error-envelope --tool create_order --arguments '{"item":"","quantity":0}'
```
