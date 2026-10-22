# Request Bodies

> Status: **normative**, implemented by the NestJS/Express SDK. Pinned by the `json-family-*`, `text-plain-*`, `form-*`, `multipart-*` and `file-*` families in `argument-mapping/`, the body-shape fixtures in `metadata-extraction/`, and the `file-*` fixtures in `error-mapping/`.

A body is not always JSON. This document defines which media types an operation's body may carry, how the agent's arguments become that body, and how a file part reaches the backend without the agent writing its bytes into its own context. It extends step 5 of [argument-mapping.md](argument-mapping.md); every rule there still holds.

## The media type

`requestBody.contentType` names the **one** media type the SDK writes the body as. It is lowercase, has no parameters and no wildcard. **Absent means `application/json`**, so every descriptor written before this field existed means exactly what it meant.

| Family    | Media types                                     | Body                                               |
| --------- | ----------------------------------------------- | -------------------------------------------------- |
| JSON      | `application/json`, `text/json`, any `*/*+json` | the same bytes; only `Content-Type` differs        |
| Form      | `application/x-www-form-urlencoded`             | one `key=value` pair per wire key                  |
| Multipart | `multipart/form-data`                           | one part per wire key; a file field is a file part |
| Text      | `text/plain`                                    | the body root string, as is                        |

A body of any other media type is written as **one file's bytes** when the body root is a file schema (`contentMediaType` without `contentEncoding`) — `application/octet-stream`, `image/png`, `application/pdf`. The agent sends a file argument ([below](#the-file-argument)) as the body root, the same budgets apply, and `Content-Type` is the declared media type, never the file's own. Absent, no body is sent. Any other media type, or one of these whose root is not a file, has no writer: the template MUST be refused with `unsupported_body_shape`, and discovery reports the endpoint as `unsupported_binding`.

### Choosing one

A backend may accept several media types. The discovering SDK picks one, in this order, after dropping every wildcard and every parameter:

1. `application/json`, also when a listed `*/*` or `application/*` covers it;
2. another JSON-family type, in the order the backend declares them;
3. `application/x-www-form-urlencoded`, when the body has no file field;
4. `multipart/form-data`;
5. `text/plain`.

Every accepted type is correct, so choosing one is not a conflict and is not reported. "The first one declared" was rejected: it makes the tool depend on the order of a list nobody wrote for it.

A host MAY declare the media type itself (`@McpTool({ consumes })`). The declaration replaces the choice, but it MUST be one the backend accepts; otherwise the endpoint is dropped with `content_type_not_accepted`. A declaration that contradicts the backend is resolved by neither side.

## The wire, per family

**JSON.** Unchanged from [argument-mapping.md](argument-mapping.md) step 5. `Content-Type` is the media type followed by `; charset=utf-8`.

**Text.** Only a body root whose schema is a string can be `text/plain`; anything else MUST be refused at template-production time (`unsupported_body_shape`). A non-string value at call time is `invalid_type`. `Content-Type` is `text/plain; charset=utf-8`.

**Form (urlencoded).** A form body is **closed and typed**: every field is a scalar, an array of scalars, or an object whose members are scalars or arrays of scalars — one level, the same limit `deepObject` has. A free-form body (`additionalProperties`), a deeper object, an array of objects, a file field and a member name the notation would re-read as structure MUST be refused at template-production time (`unsupported_body_shape`). Fields are written in the template's declaration order; each value goes through the same type gate and the same strict RFC 3986 encoding as a query value ([argument-mapping.md](argument-mapping.md) step 3), so a space is `%20`, never `+`. An array repeats its key; an empty array writes no key; an absent field writes no key; `null` is `null_not_allowed`. An object field writes one key per member, as `group[member]` or `group.member` per `requestBody.objectNotation` (absent means `bracket`), with the structural character raw and the two names encoded separately. **`Content-Type` carries no `charset` parameter**: ASP.NET decodes escaped bytes with the declared charset, so a body labelled `us-ascii` turns `%C4%B0` into `??`.

Field mode always produces a body, as for JSON: with no field supplied the body is empty and still sent. In root mode the `body` argument is an object whose members are the form fields; a member the template does not declare is `unknown_argument`.

**Multipart.** The same fields and the same walk as a form body, with three differences: a part name is **not** percent-encoded; a file field is allowed; and a JSON part is **never** written — ASP.NET's form binder does not deserialize one into a complex property, which is why an object field is spelled with the notation instead. The boundary and each part's headers are the SDK's; the composer's output is the ordered list of parts, which is what the conformance corpus pins.

Each part carries `Content-Disposition: form-data; name="…"`. A file part also carries a `filename`, **always**: busboy and `IFormFile` treat a part as a file only when it has one. A filename outside ASCII is written as `filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded>` (RFC 5987): multer decodes a bare UTF-8 `filename` as latin1 (N3) and decodes `filename*` correctly (N3b). A field part carries `Content-Type: text/plain; charset=utf-8`; a file part carries its own media type.

## The file argument

A file field is published as an object with **exactly one** of three sources, plus two optional keys:

| Key         | Meaning                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `text`      | the file's content as text, written as UTF-8 bytes; for content the agent produces itself         |
| `base64`    | the file's bytes, standard base64 (RFC 4648 §4) with padding, no whitespace, no URL-safe alphabet |
| `ref`       | a reference the host's file resolver turns into bytes; offered only when a resolver is bound      |
| `name`      | the filename; MUST NOT be empty or contain `"`, CR, LF, NUL, `/` or `\`                           |
| `mediaType` | the part's media type; MUST match `type/subtype` with optional parameters                         |

A file array is published as an array of these objects and repeats the part. The schema uses `oneOf` with one `required` branch per source; that is safe because an operation's schema reaches the agent as data inside a `load_tool` result and is never registered with a client's function-calling layer. **The byte limit is never written into the schema**, so a tool's definition does not change with the host's budget; the refusal names it.

Every violation is `invalid_file_argument`, and the message never names `ref` to an agent whose host bound no resolver: an unoffered source is simply an unknown key. The base64 gate is strict on purpose — `Buffer.from` accepts almost anything, so a lenient gate would make the decoded bytes depend on the decoder. The filename gate exists because the value reaches `IFormFile.FileName` and `originalname`, which handlers join onto directories.

**Defaults.** The filename is the agent's `name`, then the resolver's, then the field's wire name. The media type is the agent's `mediaType`, then the resolver's, then the descriptor's `contentMediaType` when it is concrete (no `*`) and not `application/octet-stream`, then `text/plain; charset=utf-8` for `text` and `application/octet-stream` otherwise.

### Marking a file field

Inside a `multipart/form-data` body, a property whose schema carries `contentMediaType` and no `contentEncoding` is a file field — the OpenAPI 3.1 idiom for raw binary. "This is a file" is a fact about the binding (`IFormFile`, `@UploadedFile`), not about the type, so the SDK writes it at discovery; a TypeShape `binary` value (`byte[]`) remains a base64 string inside JSON.

### Budgets

| Budget                      | Default    | Counts                                       | Enforced by                                                |
| --------------------------- | ---------- | -------------------------------------------- | ---------------------------------------------------------- |
| `invoke.maxInlineFileBytes` | 1 048 576  | decoded `base64` bytes, summed over one call | the composer, arithmetically                               |
| `invoke.maxFileBytes`       | 16 777 216 | the bytes of one resolved `ref`              | the SDK, and passed to the resolver so it can refuse early |

`text` has no budget: the agent already paid for it in tokens, and an inline limit would only refuse what is already in its context. Over the inline budget the call is `file_too_large` and the message names the total and the limit, and advises `ref` when a resolver is bound. The composer computes decoded length from the base64 length alone, so the refusal is deterministic and fixture-pinned.

### Resolving a `ref`

A `ref` is resolved **inside the dispatch, after the invoke deadline is armed**, never during the validating composition: a resolver that hangs is then bounded by the same deadline as the backend, and no I/O happens before an argument error could surface. The resolver receives the ref, the field, the operation, the caller (`McpCaller`), the byte limit and the cancellation signal, and answers with bytes plus an optional filename and media type, or with one of four refusals:

| Refusal       | Envelope          | `retryable` | Message                                                                                                     |
| ------------- | ----------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `not_found`   | `file_unresolved` | `false`     | `File argument '<field>' names a ref that could not be resolved. Retrying with the same ref will not help.` |
| `forbidden`   | `file_unresolved` | `false`     | the same message                                                                                            |
| `unavailable` | `file_unresolved` | `true`      | `File argument '<field>' could not be resolved right now. Retry the call.`                                  |
| `too_large`   | `file_too_large`  | `false`     | `File argument '<field>' is over the limit of <limit> bytes and was not sent.`                              |

`not_found` and `forbidden` MUST produce one message: a ref is a string the agent wrote, and a refusal that told them apart would let it probe which refs exist for other callers. Resolved bytes over `invoke.maxFileBytes` are `too_large` whatever the resolver said.

**A ref is not a capability.** The resolver MUST authorize the ref against the caller it receives; the SDK checks nothing about it. Visibility is not enforcement ([visibility.md](visibility.md)), and a ref the agent was never shown is still a string it can write. File bytes and resolver internals never appear in a message or a log.

## Known limits

- **Nest cannot see its own body parsers' types.** Express registers `jsonParser` for `application/json` only; a `+json` body reaches the handler as `req.body === undefined` unless the host configured `useBodyParser('json', { type })` (N6), and the parser's `type` lives in a closure. The Nest SDK therefore collapses the JSON family to `application/json`, which the default parser reads and which Nest, having no 415 filter, accepts. `text/plain` is chosen only when a `textParser` layer is on the router stack (N7); otherwise the endpoint is dropped with `body_parser_missing`.
- **A file field's name is not discoverable in Nest.** `FileInterceptor("attachment")` keeps the name in a closure. The host declares it (`@McpTool({ files })`) or documents it with `@ApiBody`'s `format: binary` schema; with neither, the endpoint is dropped with `unresolved_file_field`. The name is never guessed — a wrong guess is a field multer refuses with `400 Unexpected field` (N4) at best and one the handler silently never reads at worst.
- **Bodies are buffered.** The dispatcher holds the whole body in memory, so `invoke.maxFileBytes` multiplied by concurrent calls is the peak. Streaming is out of scope.
- **sezzlee offers no upload endpoint of its own.** Out-of-band upload with an `mcp-file://` handle (SEP-2631) is a draft without a sponsor, and a shape guessed today would break when a standard lands. The `ref` port is shaped to accept such a handle when one exists.
- **A file is never a data URI.** An encoded value must not enter the model's context (SEP-2356), and a data URI is exactly a value that does.
