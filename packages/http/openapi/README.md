# @sezzlee/openapi

Turns a Swagger 2.0 or OpenAPI 3.0–3.2 document into the same `EndpointDescriptor[]` shape sezzlee's
catalog builds from framework discovery. This is the ingestion library; everything after the
descriptor — naming, selection, curation, template production, composition, error mapping, search
— is the existing catalog and lives elsewhere. The one consumer today is
[`@sezzlee/openapi-mcp`](../../servers/openapi-mcp).

> Status: `0.2.0`, alpha. Normative source: [openapi-ingestion.md](../spec/openapi-ingestion.md).

## Usage

```ts
import { ingest } from "@sezzlee/openapi";

const result = await ingest(documentTextOrObject, {
  documentUrl: "file:///abs/path/to/openapi.json",
  baseUrl: "https://api.example.com",
  strict: false,
});

if (result.fatal) {
  // result.diagnostics holds at least one "fatal" entry
}
```

### `ingest(source, options?)`

`source` is either the document's raw text (JSON or YAML) or an already-parsed `JsonObject`.
`options` (`IngestOptions`, from `src/ingest.ts`):

| Option                | Type                               | Default                | Notes                                                                                                     |
| --------------------- | ---------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `documentUrl`         | `string`                           | —                      | Where the document was read from; relative servers and external `$ref`s resolve against it                |
| `baseUrl`             | `string`                           | —                      | Replaces the document's root `servers`                                                                    |
| `serverVariables`     | `Readonly<Record<string, string>>` | —                      | Overrides for server variable defaults                                                                    |
| `loader`              | `DocumentLoader`                   | —                      | Reads an external `$ref`; without one, a document that has any is refused (`external_ref_blocked`, fatal) |
| `strict`              | `boolean`                          | `false`                | Raises `openapi_document_invalid` from a warning to a fatal diagnostic                                    |
| `cookieDenyList`      | `RegExp`                           | the built-in deny-list | Cookie names treated as identity carriers even when no security scheme declares them                      |
| `identityCookies`     | `readonly string[]`                | `[]`                   | Exact cookie names added to the deny-list (case-insensitive); they extend it and never replace it         |
| `outputSchema`        | `"document"` \| `"omit"`           | `"document"`           | `omit` for a backend whose responses do not match its document                                            |
| `hoistPathPrefix`     | `string`                           | —                      | A leading path segment moved from every route into the base URL                                           |
| `requestBodyRequired` | `"document"` \| `"always"`         | `"document"`           | `always` treats an undeclared `requestBody.required` as `true`                                            |

`ingest` returns an `IngestionResult`:

| Field         | Type                             | Meaning                                                            |
| ------------- | -------------------------------- | ------------------------------------------------------------------ |
| `endpoints`   | `readonly SourcedEndpoint[]`     | Empty when `fatal` is `true`                                       |
| `rootBaseUrl` | `string \| undefined`            | The resolved root server, or the `baseUrl` option that replaced it |
| `security`    | `SecurityModel`                  | The document's security schemes, keyed by scheme name              |
| `diagnostics` | `readonly IngestionDiagnostic[]` | Every diagnostic produced, fatal or not                            |
| `fatal`       | `boolean`                        | `true` when at least one diagnostic is `"fatal"`                   |

## No I/O

`ingest` performs no network or filesystem access itself: `node:http`, `node:https`, `node:net`,
`node:tls`, `node:fs`, `node:fs/promises`, `undici`, `node-fetch`, `axios`, and the global `fetch`,
`WebSocket` and `EventSource` are all lint-banned across `src/` (`oxlint.config.ts`). Reading the
document itself is the caller's job; reading an **external** `$ref` (another file or a URL the
document points to) is done only through the `loader` a caller injects:

```ts
export type DocumentLoader = (url: URL) => Promise<string>;
```

Without a `loader` (and a `documentUrl` to resolve relative references against), a document that
contains any external `$ref` is refused with `external_ref_blocked` rather than read — ingestion
never decides on its own which file or host it may reach; that decision belongs to the host. A
loader is expected to enforce its own limits (an allowlisted host, a deadline, a size cap, a root
directory for a file); `@sezzlee/openapi-mcp`'s loader is one example, restricted to the document's
own host plus its configured `refHosts`, with a 64 MiB cap.

## Diagnostics

Every construct the document contains that ingestion cannot represent produces a diagnostic
instead of throwing — only the `loader`'s own I/O can reject. A diagnostic (`IngestionDiagnostic`,
`src/diagnostics.ts`) carries:

- `code` — one of the `IngestionCode` values (`openapi_document_unparseable`,
  `external_ref_blocked`, `unsupported_media_type`, `identity_cookie_parameter`, …; the full list
  and each code's severity is in [openapi-ingestion.md](../spec/openapi-ingestion.md#diagnostics))
- `severity` — one of three: `"fatal"` (stops the catalog), `"endpointDropped"` (removes one
  operation), `"warning"` (changes nothing the agent can reach)
- `at` — an RFC 6901 `JsonPointer` into the **original** document
- `message` — human-readable, addressed to the document's author

`ingestionSeverities` (exported from the package) is `as const satisfies Readonly<Record<string,
CatalogSeverity>>`, so a code added without a severity fails to compile.

## Rules

- No runtime dependency on any other `@sezzlee/*` package besides `@sezzlee/core`, which supplies
  `CatalogSeverity` and the descriptor types this library fills in.
- Bound by the `openapi-ingestion` fixture profile, not the core catalog's fixture profile — an
  SDK that never reads an OpenAPI document is unaffected by a change here.

## Development

```bash
pnpm turbo run build --filter=@sezzlee/openapi
pnpm turbo run lint --filter=@sezzlee/openapi
pnpm turbo run check-types --filter=@sezzlee/openapi
pnpm turbo run test --filter=@sezzlee/openapi
```

Run these through Turbo rather than `pnpm --filter @sezzlee/openapi <task>`, per this repository's
convention. `test/ingest.spec.ts` covers the pipeline directly; `test/conformance-fixtures.spec.ts`
runs the package against the `openapi-ingestion` fixture corpus.
