# OpenAPI Ingestion

> Status: **normative, one implementation** (`packages/http/openapi`). Bound by the `openapi-ingestion` fixture profile ([fixture-format.md](fixture-format.md)), not by the core profile: an SDK that never reads an OpenAPI document is not bound by this file.

An OpenAPI document is a second source of `EndpointDescriptor`s, next to framework discovery. This document defines how a Swagger 2.0 or OpenAPI 3.0–3.2 document becomes descriptors, a server map and a security model, and which diagnostics the conversion reports. Everything after the descriptor — naming, selection, curation, template production, composition, error mapping, search — is the existing catalog and is not restated here. The embedded SDKs reach only ASP.NET Core and NestJS; for any other backend, its document is the only machine-readable account of its operations.

## Principles

1. **Nothing is silent.** Every construct in the document that cannot be represented produces a diagnostic carrying a JSON Pointer into the **original** document (RFC 6901), a code and a severity. A dropped operation, an ignored media type and a stripped keyword are all reported.
2. **Severity decides reach, not correctness.** `fatal` stops the catalog; `endpointDropped` removes one operation and reports why; `warning` changes nothing the agent can reach. A diagnostic is addressed to the document's author: the agent cannot repair a document, so no ingestion diagnostic ever reaches the MCP surface.
3. **Ingestion never throws for document content.** Only the loader's I/O can fail as an exception. A malformed document is a set of diagnostics.
4. **The descriptor means what OpenAPI means.** Where the descriptor vocabulary is OpenAPI's (`style`, `explode`, `deepObject`, `in`), the defaults are OpenAPI's, as [argument-mapping.md](argument-mapping.md) already requires.

## Pipeline

| Step            | Input → output                                                                                     | Fails as                                                              |
| --------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1. Parse        | JSON or YAML text → value                                                                          | `openapi_document_unparseable` (fatal)                                |
| 2. Version      | `swagger: "2.0"`, `openapi: 3.0.x / 3.1.x / 3.2.x`                                                 | `openapi_version_unsupported` (fatal)                                 |
| 3. Validate     | against the document's own version                                                                 | `openapi_document_invalid` — warning by default, fatal under `strict` |
| 4. Upgrade      | to the 3.2 shape (§ Swagger 2.0, § OpenAPI 3.0)                                                    | per rule                                                              |
| 5. Bundle       | external `$ref` resolved into the document                                                         | `external_ref_blocked` (fatal)                                        |
| 6. Inline       | non-schema components (`parameters`, `requestBodies`, `responses`, `headers`, `pathItems`) inlined | `circular_component_ref` (endpoint dropped)                           |
| 7. Schema slots | per slot, `#/components/schemas/*` closure → local `$defs` (§ References)                          | `schema_def_conflict` (endpoint dropped)                              |
| 8. Normalize    | JSON Schema keywords (§ Schema normalization)                                                      | per rule                                                              |
| 9. Lower        | operation → `EndpointDescriptor`                                                                   | per rule                                                              |

Validation defaults to warnings because real documents are routinely invalid in ways that do not matter to the operations actually used, and a gateway that refuses a whole backend over one bad example is unusable. A strict mode exists for CI. The implementation validates by point checks on the constructs it reads, not against the version's full meta-schema, so a defect in a part of the document nothing lowers produces no diagnostic.

## References

- An **external** `$ref` (another file, a URL) is resolved only through the loader the host supplied: a file ref MUST stay inside the configured root directory; an http(s) ref MUST pass a host allowlist, a deadline and a size limit. The gateway allows the document's own host plus the hosts its operator lists in `refHosts` — a list kept apart from the invocation allowlist — with a 64 MiB limit, and a refused host stops the gateway with a message naming that setting. Anything else is `external_ref_blocked`. An external ref is a way for the document's author to make the ingesting process issue a request.
- A reference to a **non-schema** component is inlined. A cycle among them (a path item that references itself) drops every operation it reaches.
- A reference to a **schema** is kept as a reference, because schemas are legitimately recursive. For each schema slot (every parameter, the request body, every response) the transitive closure of `#/components/schemas/<name>` is copied into that slot's `$defs` under the escaped name and the reference is rewritten to `#/$defs/<name>`. `liftDefs` then merges the slot bags exactly as it does for framework descriptors ([schema-conversion-rules.md](schema-conversion-rules.md)).
- Every slot is **dereferenced at its top level**: a parameter because its kind is read from its top-level `type`, a body because the core flattens only an object root, a response so its output schema is an object rather than a reference. A nullable reference (`anyOf` of the reference and `null`, which is what `nullable` next to `$ref` becomes) is dereferenced the same way. A parameter schema that is recursive at its top level is `recursive_parameter_schema` (endpoint dropped); a recursive body or response keeps its reference and the body is sent in root mode.
- A `$ref` with sibling keywords follows the document's version: siblings are ignored in 2.0 and 3.0 (`ref_siblings_ignored`, warning) and applied in 3.1+.

## Schema normalization

The descriptor carries JSON Schema 2020-12 and the core passes property schemas through unchanged, so everything OpenAPI-specific is normalized here.

| OpenAPI construct                                           | Result                                                                                                                                          | Diagnostic                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `nullable: true` (3.0), including next to `$ref` or `allOf` | `anyOf: [<schema>, {"type": "null"}]`; a plain `type` becomes a type array                                                                      | —                                                             |
| `default`                                                   | removed, on every slot ([schema-conversion-rules.md](schema-conversion-rules.md): "absent" and "explicitly the default" are different requests) | —                                                             |
| `readOnly` property                                         | removed from request slots and from their `required`; kept in responses                                                                         | —                                                             |
| `writeOnly` property                                        | removed from response slots; kept in requests                                                                                                   | —                                                             |
| `format: binary`                                            | `contentMediaType` from the part's `encoding.contentType`, else `application/octet-stream`; `format` removed                                    | —                                                             |
| `format: byte`                                              | `contentEncoding: "base64"`                                                                                                                     | —                                                             |
| `example`                                                   | `examples: [<example>]`                                                                                                                         | —                                                             |
| `discriminator`                                             | removed; `oneOf`/`anyOf` and its mapping targets are kept                                                                                       | `annotation_removed` (warning, once per keyword per document) |
| `xml`, `externalDocs`, `x-*` inside a schema                | removed                                                                                                                                         | `annotation_removed`                                          |
| boolean `exclusiveMinimum`/`exclusiveMaximum` (3.0)         | numeric form                                                                                                                                    | —                                                             |
| `allOf` of object schemas without conflicting properties    | merged into one object, so a body root can flatten                                                                                              | —                                                             |
| `allOf` that cannot be merged                               | kept; the body is sent in root mode                                                                                                             | the existing `unflattenable_body_root`                        |

"Removed" keywords are annotations: they change neither what the backend accepts nor what the composer writes. They are listed so that removal is a documented rule rather than a loss.

## Swagger 2.0

| 2.0 construct                                | 3.2 form                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host` + `basePath` + `schemes`              | one server per scheme, `https` first; no `host` → relative server resolved against the document URL                                                                           |
| `consumes` / `produces` (root and operation) | media types of `requestBody` and responses; absent `consumes` → `application/json`                                                                                            |
| `in: body`                                   | `requestBody` with one entry per consumed media type                                                                                                                          |
| `in: formData`                               | `requestBody` as `application/x-www-form-urlencoded`, or `multipart/form-data` when `consumes` names it or a field is `type: file`                                            |
| `type: file`                                 | a file field: `contentMediaType: "application/octet-stream"`                                                                                                                  |
| `collectionFormat: csv`                      | query/cookie `form` + `explode: false`; path/header `simple`                                                                                                                  |
| `collectionFormat: ssv` / `pipes`            | `spaceDelimited` / `pipeDelimited`, query only; elsewhere `unsupported_collection_format`                                                                                     |
| `collectionFormat: multi`                    | `form` + `explode: true`, query only                                                                                                                                          |
| `collectionFormat: tsv`                      | `unsupported_collection_format` (endpoint dropped)                                                                                                                            |
| `securityDefinitions`                        | `securitySchemes`: `basic` → `http basic`; `apiKey` unchanged; `oauth2` flows `implicit`, `password`, `application` → `clientCredentials`, `accessCode` → `authorizationCode` |
| `x-nullable`                                 | `nullable`                                                                                                                                                                    |

## Operations

- Every path item method is an operation, including 3.2 `query` and every entry of `additionalOperations`. `TRACE`, and any `additionalOperations` method other than those the descriptor carries, is `unsupported_method` (endpoint dropped).
- Path-level and operation-level parameters merge by the pair `(name, in)`, the operation's winning. Merging by `name` alone collapses a query `id` into a path `id`.
- A header parameter named `Accept`, `Content-Type` or `Authorization` is ignored, as OpenAPI requires, and reported as `reserved_header_parameter_ignored` (warning). `Authorization` is identity and arrives through a credential.
- A parameter in the slot one of the operation's security schemes writes its credential into (an `apiKey` scheme's `in` and `name`) is the credential itself, not an argument: it is ignored and reported as `credential_parameter_ignored` (warning), and the slot is added to `auth.carriers`.
- `style` and `explode` are written **explicitly** for every array and every declared style, with OpenAPI's defaults: `simple` for path and header, `form` for query and cookie, `explode` true exactly for `form`. The descriptor's own default for an unstyled header array is `form`, which is not OpenAPI's, so leaving it implicit would change the wire form. An exploded cookie array is therefore refused by the core (`unsupported_parameter_style`), as OpenAPI's default asks for a form the Cookie header cannot carry.
- A parameter with `content` instead of `schema` becomes a content-serialized parameter (`contentType`) when its one media type is `application/json`, another JSON-family type (written as JSON), `text/plain`, or — for an `in: querystring` parameter — `application/x-www-form-urlencoded`; any other media type, or more than one, is `unsupported_parameter_content` (endpoint dropped).
- `deprecated` on an operation is carried to the descriptor.
- `allowEmptyValue` is ignored (`allow_empty_value_ignored`, warning); an empty string already writes `key=`.
- `allowReserved: true` on a query parameter is carried to the descriptor; on any other location OpenAPI ignores it, and so does ingestion.
- `deprecated` is carried to the descriptor and the card.
- `callbacks`, `links` and root `webhooks` are not operations the agent calls: `callbacks_ignored`, `links_ignored`, `webhooks_ignored` (warning, once per document).

### Identity cookies

A cookie parameter is an identity carrier, never an argument, when its name is the `name` of an `apiKey` security scheme with `in: cookie`, or matches the configured deny-list (default: `session`, `sid`, `token`, `auth`, `jwt`, and any name containing `sess`, case-insensitive). It is moved to `Auth.carriers` and reported as `identity_cookie_parameter` (warning); when no security scheme covers it, also `identity_cookie_uncovered`. The deny-list is a safety net for documents that never declare their session cookie; the security scheme is the authoritative source. A host of the library can replace the deny-list (`cookieDenyList`) or extend it with exact names (`identityCookies`, compared case-insensitively); names added this way MUST extend the list, never replace it. The gateway exposes only the extension.

### Request body

`requestBody.required` defaults to `false` in OpenAPI and to `true` in the descriptor, so an undeclared one is written as `required: false`; the core then exposes the body as a single optional `body` argument. A host MAY declare that an undeclared `required` means `true` (`requestBodyRequired: always`), for a generator that omits it although the backend rejects an empty body — Swashbuckle does, for an ASP.NET `[FromBody]` that is required by default. A body that declares `required: false` stays optional either way. A body whose root schema admits `null` — `nullable`, a type array with `null`, or `oneOf`/`anyOf` of `null` and a reference, which is how generators write an optional C# `NotePayload?` — is optional unless the document declares `required: true`, and the `null` member is removed so the root can flatten: `null` is not a body a client sends. The media type is chosen with the order in [request-bodies.md](request-bodies.md), extended by two final steps for a root that is a file schema: `application/octet-stream`, then any other concrete binary media type, whose name becomes the file's `contentMediaType`. Every other declared media type is reported once per operation as `request_media_type_alternative_ignored` (warning) — the choice is not a conflict, but a document author who expected XML to be used needs to learn that it was not. No writable media type: `unsupported_media_type` (endpoint dropped). An `encoding` entry is honoured for `contentType` of a file part; a non-default `style`, `explode` or per-part `headers` is `unsupported_encoding` (endpoint dropped).

### Responses

Every documented response is carried with its schema. The output schema is chosen by the primary-response rule of [metadata-contract.md](metadata-contract.md). A success response whose only media types are streaming sequences (`itemSchema`, `text/event-stream`, `application/jsonl`, `application/x-ndjson`, `application/json-seq`) is `streaming_response_unsupported` (endpoint dropped). Response headers and links are not part of the output schema.

A host MAY configure the output schema as omitted for a backend whose responses do not match its document. The descriptor then carries responses without schemas; nothing else changes.

## Naming inputs

- `operationId` becomes the descriptor's `operationId`. One whose snake_case form cannot satisfy the tool-name pattern is not passed on (`operation_id_unusable`, warning), and route-based naming applies.
- The operation's **first tag** becomes its `container`; every tag becomes a descriptor tag. An operation without tags has no container and no prefix.
- An operation's `x-sezzlee-search-terms` becomes the descriptor's `searchTerms` ([metadata-contract.md](metadata-contract.md)). It MUST be an array of strings; any other value is `search_terms_invalid` (warning) and nothing is carried, and a blank entry is dropped the way a blank tag is. The extension is the document author's declaration; a host that cannot edit the document declares the same vocabulary in its own configuration, which replaces the extension for that operation.
- `x-sezzlee-revision` declares the descriptor's `revision` ([metadata-contract.md](metadata-contract.md)) on three levels: at the document root it is the `catalog` level, on a path item the `container` level for every operation under it, and on an operation the `operation` level. The revision's container is the path item and not the naming container above: a tag may be shared by many operations and an operation may carry many tags, so a tag cannot say which revision one operation inherits. The levels are carried side by side and never replace one another. Each value MUST be a whole number from 1; any other value is `revision_invalid` (warning), reported once at its own location, and that level is not carried. A host that cannot edit the document declares the same levels in its own configuration, which comes first at each level; the extension it hides is reported as `revision_overridden`.
- Duplicate `operationId`s, and route-derived names that collide, reach the existing fatal `name_collision` ([naming.md](naming.md)). The host resolves them with a `names` override. Nothing is renamed automatically.
- A host MAY hoist a common path prefix into the server base (`/Rest` in `/Rest/Tasks/{id}`), so that it does not become a segment of every derived name. Hoisting is a declaration and is applied to every operation whose path starts with the prefix; an operation that does not start with it keeps its full path.

## Servers

The server of an operation is the first non-empty list among the operation's `servers`, its path item's, and the root's. Variables take their `default` unless the host overrides them; a value outside a variable's `enum` is `server_variable_invalid` (fatal). A relative server URL is resolved against the document's URL; a document read from a file with a relative server and no host-supplied base is `server_url_unresolvable` (fatal). The descriptor's `route` is relative to that server URL.

A server whose host is not on the invocation allowlist drops every operation that uses it (`server_host_not_allowed`).

## Security

The effective requirement of an operation is its own `security`, else the root's. `[]` and `[{}]` mean anonymous: the descriptor's `auth.anonymous` is `"yes"`. Anything else is `"unknown"`, and `policies` is empty: a document says which credential a call needs, never which caller may make it, so visibility is `unknown` and enforcement stays with the backend ([visibility.md](visibility.md), invariant 1).

There is no remote probe. An embedded probe stops a synthetic request before the handler runs ([visibility.md](visibility.md)); the same request sent to a remote backend would run the handler for real.

How a requirement is satisfied at invocation time is [credentials.md](credentials.md). A scheme the invoker cannot satisfy (`mutualTLS`; an `oauth2` or `openIdConnect` scheme with no token exchange configured) is `security_scheme_unsupported`; the operation is dropped only when no alternative of its requirement can be satisfied (`security_unsatisfiable`).

## Diagnostics

| Code                                                     | Severity                       |
| -------------------------------------------------------- | ------------------------------ |
| `openapi_document_unparseable`                           | fatal                          |
| `openapi_version_unsupported`                            | fatal                          |
| `openapi_document_invalid`                               | warning (fatal under `strict`) |
| `external_ref_blocked`                                   | fatal                          |
| `server_variable_invalid`                                | fatal                          |
| `server_url_unresolvable`                                | fatal                          |
| `circular_component_ref`                                 | endpointDropped                |
| `recursive_parameter_schema`                             | endpointDropped                |
| `unsupported_method`                                     | endpointDropped                |
| `unsupported_collection_format`                          | endpointDropped                |
| `unsupported_parameter_content`                          | endpointDropped                |
| `unsupported_media_type`                                 | endpointDropped                |
| `unsupported_encoding`                                   | endpointDropped                |
| `streaming_response_unsupported`                         | endpointDropped                |
| `server_host_not_allowed`                                | endpointDropped                |
| `security_unsatisfiable`                                 | endpointDropped                |
| `security_scheme_unsupported`                            | warning                        |
| `ref_siblings_ignored`                                   | warning                        |
| `annotation_removed`                                     | warning                        |
| `reserved_header_parameter_ignored`                      | warning                        |
| `credential_parameter_ignored`                           | warning                        |
| `allow_empty_value_ignored`                              | warning                        |
| `identity_cookie_parameter`                              | warning                        |
| `identity_cookie_uncovered`                              | warning                        |
| `request_media_type_alternative_ignored`                 | warning                        |
| `operation_id_unusable`                                  | warning                        |
| `search_terms_invalid`                                   | warning                        |
| `revision_invalid`                                       | warning                        |
| `callbacks_ignored`, `links_ignored`, `webhooks_ignored` | warning                        |

Template-production codes of the core catalog (`unsupported_array_style`, `identity_carrier_parameter`, …) keep their own severities; ingestion does not re-grade them.

A host MAY escalate or downgrade a code, as with framework discovery. A report SHOULD group diagnostics by code, with a count and the first pointers: a document with 871 operations that each declare four body media types produces hundreds of identical warnings.

## Not supported

Callbacks, links, webhooks, `mutualTLS`, XML-only bodies, streaming success responses, non-default multipart encodings, parameter content other than JSON, text and a urlencoded querystring, `TRACE`, and `tsv`. Each is listed above with the diagnostic it produces.

## Rejected

- **`swagger-client` as a runtime dependency.** Its serialization is the closest thing to a reference, but it is 6.3 MB of CommonJS and carries known defects this implementation does not repeat: it merges path-item and operation parameters by name alone, each cookie parameter overwrites the previous one, it applies every scheme instead of one satisfiable requirement, and it skips `querystring`.
- **Picking the first media type an operation lists.** It would tie a tool to the order of a list nobody wrote for it; [request-bodies.md](request-bodies.md)'s ordered selection applies instead.
