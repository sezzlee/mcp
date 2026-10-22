# Metadata Contract

> Status: **normative** — TS `createToolDefinition` passes the `metadata-extraction/` corpus; `EndpointDescriptor` is produced by the NestJS discovery layer and by OpenAPI ingestion ([openapi-ingestion.md](openapi-ingestion.md)).

Defines two models: the **neutral endpoint model** (`EndpointDescriptor`) that an SDK must extract from its framework, and the **tool definition** (`ToolDefinition`) produced from it. The machine-readable schemas are [schemas/endpoint-descriptor.schema.json](schemas/endpoint-descriptor.schema.json) and [schemas/tool-definition.schema.json](schemas/tool-definition.schema.json) — those are the single source; this document explains them.

## The neutral endpoint model (EndpointDescriptor)

A small, strict subset of OpenAPI. Not a new ontology; a narrowed form of a known vocabulary. The fields:

| Field             | Required | Meaning                                                                                                                                                                                                                                                                       |
| ----------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operationId`     | no       | The framework's stable operation identity (Nest: the method name)                                                                                                                                                                                                             |
| `container`       | no       | The unit hosting the operation (Nest: the controller class). The source of the operation identity and of the tool-name prefix                                                                                                                                                 |
| `containerPrefix` | no       | A container-prefix declaration; when absent it is derived from the container name ([naming.md](naming.md))                                                                                                                                                                    |
| `toolName`        | no       | A full-name declaration; when given, no body is generated and no prefix is applied                                                                                                                                                                                            |
| `method`          | yes      | `GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS/QUERY`; `OPTIONS` and `QUERY` are safe and idempotent, and `QUERY` may carry a body                                                                                                                                                   |
| `route`           | yes      | A route template starting with `/`; path parameters in braces                                                                                                                                                                                                                 |
| `description`     | no       | A human-written description (Nest: Swagger decorators)                                                                                                                                                                                                                        |
| `deprecated`      | no       | The operation is deprecated. Carried to the tool definition, the card and the loaded definition, so an agent prefers an alternative; the tool stays invocable                                                                                                                 |
| `parameters`      | no       | `{name, in: path\|query\|header\|cookie, required, schema, style?, explode?, description?}`; `style`/`explode` describe how the value is written, per location ([argument-mapping.md](argument-mapping.md))                                                                   |
| `requestBody`     | no       | `{schema, required?, description?, contentType?, objectNotation?}`; `required` is the body-level bit, distinct from the field-level `required` inside `schema`, and defaults to `true`; `contentType` defaults to `application/json` ([request-bodies.md](request-bodies.md)) |
| `responses`       | no       | Status code, `1XX`–`5XX` range or `default` → `{schema?, description?}`. Written with read-only members **kept**, unlike `parameters` and `requestBody` ([schema-conversion-rules.md](schema-conversion-rules.md) Table 4)                                                    |
| `auth`            | yes      | See below                                                                                                                                                                                                                                                                     |
| `tags`            | no       | Grouping labels; several are allowed. They are index vocabulary and `search_tools` filter keys at once ([search-semantics.md](search-semantics.md)). Derived from the container when the host declares none (Nest: the controller class name)                                 |
| `searchTerms`     | no       | Host-declared search vocabulary: terms an agent may type that the operation's own text does not contain. Index vocabulary only, never a filter key and never shown to the agent ([search-semantics.md](search-semantics.md)). No default                                      |
| `revision`        | no       | Host-declared behaviour revisions, `{catalog?, container?, operation?}`, each a whole number from 1. They enter the tool version and nothing the agent reads ([invoke-semantics.md](invoke-semantics.md), "The tool version"). No default                                     |

`route` is the path the backend actually serves, relative to the server root. It is the composition of every routing layer the framework applies — a deployment-wide prefix (Nest: `setGlobalPrefix`), a module-level mount (Nest: `RouterModule.register`), a URI version segment, the container's route, and the operation's route — in the order that framework composes them, with the framework's own exclusion rules honoured. An SDK MUST NOT reconstruct that composition from parts it reads itself when the framework exposes the composed path or the factory that produces it; the descriptor's route and the route the framework registered have to be the same string, because the dispatcher replays it against the running pipeline and any divergence surfaces as a 404 at invoke time rather than as a build error.

Language rule: field names and tool names are in English; `description` contents are free-form (the backend's language).

`containerPrefix` and `toolName` are **declarations** rather than discovered facts: the platform collects them from hierarchical attributes and from the host's global rule, and reduces them to two fields for the pure naming layer. In Nest, `@McpTool({ name })` fills `toolName` at the operation level and `@McpTool({ prefix })` fills `containerPrefix` at the container (or operation) level; `options.naming.prefix` fills the same field when there is no declaration. The order runs from most specific to most general: operation name → operation/container prefix → host rule → derivation from the container.

`tags` is a declaration on the same ladder: `@McpTool({ tags })` at the operation or the container level, then the host rule (`options.tags`), then the container-derived default. A declaration **replaces** that default rather than adding to it, so a host that groups four containers under one tag does not also carry four container names it never chose; and because it replaces, an SDK MUST read the container's declaration when the operation's marker does not mention tags, rather than letting the presence of an operation marker erase it. Between levels the nearer declaration simply wins and nothing is reported. Within one declaration two tags that fold alike are reported as `duplicate_tag` and the later one is dropped — they are one filter key but two index contributions, which would double that term's weight for what looks like a spelling choice — and a tag that folds to the empty string is reported as `empty_tag` and dropped, since no caller could ask for it. Both are warnings: a tag decides discoverability, not reach. Variants share the endpoint's tags, exactly as they share its `auth`.

`searchTerms` is declared on the same ladder, with the same replacement and reporting rules — `@McpTool({ searchTerms })` at the operation or the container level, then the host rule (`options.searchTerms`) — and has no container-derived default: a term nobody chose is not vocabulary. Two terms that fold alike are reported as `duplicate_search_term` and the later one is dropped, because the second would double the term's weight; a term that folds to the empty string is reported as `empty_search_term` and dropped. Both are warnings. Variants share the endpoint's search terms.

`revision` is declared on three levels: the catalog (`options.revision`), the container (`@McpTool({ revision })` on the container, then the host rule `options.containerRevision`) and the operation (the same marker on the operation). Unlike every other declaration on this ladder, the levels **never replace one another**: each is carried as its own member and enters the tool version on its own. A nearer level that replaced a farther one would make the farther one inert for every operation that declares its own — raising a container's revision would then leave the version of exactly those operations unchanged, which is the failure the field exists to prevent. Within one level the first source in the order above wins, and a later source that declares a value is reported as `revision_overridden` (warning), because raising it changes nothing. A value that is not a whole number from 1 is reported as `invalid_revision` (warning) and ignored. The tool definition carries the reduced `revision` unchanged; variants share the endpoint's revision.

## Auth representation (v0)

```json
{ "anonymous": false, "policies": ["OrdersRead"], "imperative": false }
```

Three fields, three separate questions. This representation does not define an authorization model; it carries **the readable part** of the backend's own decisions.

- `anonymous` — three-valued: `yes` (the framework's anonymous marker is present), `no` (the framework has an authorization declaration or a fallback policy), `unknown` (no declaration at all; protection may live outside the framework). When it is `yes`, `policies` MUST be empty. It is about **identity** only: an anonymous endpoint may still sit behind another gate such as a license or feature check, and `imperative` carries that. Why `unknown` is not collapsed to `yes` is in the T0 section of [visibility.md](visibility.md).
- `policies` — carries **names** only, never content. The visibility filter hands the names to the backend's own evaluator ([visibility.md](visibility.md)); it does not need to know their content. The combination semantics are AND: the effective set flattened from the framework's hierarchy (global + container + endpoint) is written here. Only **evaluable** names enter it.
- `imperative` — whether the endpoint has authorization logic whose verdict is code. When `true`, declarative evaluation cannot produce a certain `allow` for that endpoint. Imperative logic MUST NOT write a name into `policies`; it only raises this flag — so the question "is this name evaluable" never arises.
- `carriers` — optional; the slots the endpoint's credentials travel in, as `{in: header|query|cookie, name}`. A data parameter MUST NOT occupy one (`identity_carrier_parameter`, [argument-mapping.md](argument-mapping.md)). A framework SDK leaves it absent, since its carriers are the host's forwarded headers; an OpenAPI source fills it from `securitySchemes` ([openapi-ingestion.md](openapi-ingestion.md)).

`anonymous: false` plus empty `policies` plus `imperative: false` = "identity is enough, no policy" (an authorization requirement that names no policy).

`anonymous` is determined by the framework's **real** rule: an endpoint is anonymous if an explicit anonymous marker is present, **or** if there is no declarative authorization data at all and no fallback policy is configured. On an anonymous endpoint `policies` is empty — the anonymous marker short-circuits declarative authorization in the framework too.

Role requirements enter `policies` in the form `roles:<name>[,<name>]`. Those are declarative and evaluable, and the visibility side recognizes the prefix ([visibility.md](visibility.md)). Filling this form **requires the framework to carry a declarative role contract**; in a framework that does not, `policies` stays empty (see below).

Source mapping: `policies` comes from the framework's declarative authorization data, and `imperative` from the presence of non-declarative authorization filters or requirements.

In NestJS the situation is asymmetric, and that asymmetry is normative: `@nestjs/common` **defines
no authorization contract at all**. An attached guard is neither "identity required" nor "this is
authorization" — it could equally be a throttler or a tenant resolver. So in Nest the presence of a
guard produces only `imperative: true`, `policies` stays empty, and `anonymous` becomes `unknown`.
There is no framework contract called a "roles decorator" in Nest; the `SetMetadata('roles', …)`
example in Nest's own documentation is a **host convention**, and the SDK MUST NOT read a host type
by name. A Nest host that wants to declare authorization declaratively announces it structurally on
its guard.

The case where both fields stay empty is legitimate and defined: on backends whose auth lives entirely in custom middleware there is nothing to read statically. Such an endpoint becomes `unknown` on the visibility side — missing data MUST NOT be silently converted to `allow` ([visibility.md](visibility.md) rule 4).

## The tool definition (ToolDefinition)

| Field          | Source                                                                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | [naming.md](naming.md)                                                                                                                                                              |
| `description`  | `EndpointDescriptor.description`; when absent, the fallback `"{METHOD} {route}"` (for example `"GET /ping"`)                                                                        |
| `inputSchema`  | The JSON Schema produced from the parameters plus `requestBody` (`type: object`; each parameter is a property, and the `required` list comes from the parameters' `required` flags) |
| `outputSchema` | The JSON Schema produced from `EndpointDescriptor.responses` (`type: object`). Written only when the endpoint declares a success body; see below                                    |
| `annotations`  | From the table below                                                                                                                                                                |
| `auth`         | `EndpointDescriptor.auth` verbatim. It is an internal model: the visibility filter consumes it and it MUST NOT reach the MCP surface ([visibility.md](visibility.md) invariant 3)   |
| `revision`     | `EndpointDescriptor.revision` verbatim, when present. Like `auth` it never reaches the MCP surface; it enters only the tool version ([invoke-semantics.md](invoke-semantics.md))    |

## Producing `inputSchema`

- The root is always `type: object` and writes both `properties` and `required` **even when they are empty**. For deterministic comparison: a missing field and an empty field are not the same thing.
- Every parameter is a property, and the property schema is that parameter's `schema`. A `deepObject` parameter is **one** property whose schema is an object, so the flat namespace is the namespace of _arguments_, not of backend query keys: the wire keys a grouped argument expands to (`filter[status]`, `filter.status`) are not argument names, never appear in `properties`, and never enter `required`. The group's own `required` flag puts the group name in `required`; a member's requiredness lives inside the nested schema, so a required member of an optional group binds only once the group is sent.
- A parameter's `description` is added to the property schema only when **the schema does not carry its own `description`**. The schema source takes precedence; the parameter description is the fallback.
- `requestBody.schema.properties` flatten to the top level and `requestBody.schema.required` entries are appended to the `required` list — **unless** the body itself is optional (`requestBody.required: false`), its root is not an object, or one of its field names collides with a parameter name, in which case the whole body becomes the single `body` property instead ([schema-conversion-rules.md](schema-conversion-rules.md) Table 6). That `body` property is listed in `required` only when the body is required.
- In a `multipart/form-data` body, a file field's schema is replaced by the file argument, wherever the field lands — flattened to the top level or inside the `body` argument ([request-bodies.md](request-bodies.md)). No other media type changes `inputSchema`.
- The `inputSchema` root writes `additionalProperties`, whose value is derived from `requestBody.schema`'s own (see [schema-conversion-rules.md](schema-conversion-rules.md) Table 6). It is not a constant `false`, and it is **not always a boolean**: a body that types its extra keys (`{"additionalProperties":{"type":"integer"}}`) has that schema carried to the root verbatim. Only keys absent from `properties` are subject to it, and every parameter is named in `properties`, so the rule cannot reach them.
- `required` MUST NOT carry duplicate entries and MUST NOT list a name absent from `properties`; a collision between a parameter name and a body field name routes the body through the single `body` property and emits `body_field_collision`, and a collision with the name `body` itself stops tool production with `argument_collision`.
- `requestBody.description` is deliberately dropped: because body fields flatten to the top level, there is no slot left for it.
- `required` order: parameters first in declaration order, then body properties in declaration order; in the synthetic-root form the body contributes the single name `body` in that same position. The order is normative — fixture comparison is sensitive to array order.
- Body property names are the backend's **wire** names, not class member names: the name in the schema is the JSON key the backend actually accepts. The SDK reads this from the framework's serialization settings; in a setup where it cannot be read it MUST NOT guess — it uses the class member name, emits a `naming_policy_unresolved` diagnostic, and the host declares a resolver.

## Producing `outputSchema`

`outputSchema` tells the agent what a call returns, so that a plan can be built before the first
call rather than discovered by making one. It is derived from `EndpointDescriptor.responses`, which
[schema-conversion-rules.md](schema-conversion-rules.md) Table 4 requires to be written with
read-only members kept.

- **Primary response.** The status codes `200`, `201`, `202`, `204` are tried in that order; if the
  endpoint declares none of them, the numerically lowest remaining `2xx` is taken, and then the
  `2XX` range. `default` is never the primary response: it describes whatever the other keys do
  not, which is usually an error. The order is
  normative: it decides which schema is published.
- When the chosen response declares no `schema`, or the endpoint declares no `2xx` status at all,
  `outputSchema` is **not written**. The key is absent, never `null`.
- **The root MUST be an object**, because MCP requires it. A response whose root is anything else —
  an array, a scalar, a bare `$ref`, an `anyOf` — is wrapped as
  `{"type":"object","properties":{"result":S},"required":["result"]}`. A root is an object when its
  `type` is `"object"`, or a type array whose only non-`"null"` member is `"object"`.
- When a schema is wrapped, its `$defs` MUST move to the wrapper root: a `#/$defs/...` reference
  resolves against the document root, so a bag left under `properties.result` leaves every reference
  aimed at nothing. A root declaring `$id` is its own schema resource and rebases its own
  references, so its bag stays where it is — the same rule that keeps such a root out of body
  flattening ([schema-conversion-rules.md](schema-conversion-rules.md) Table 6).
- `additionalProperties` is **not written**. On `inputSchema` it binds what the caller may send; a
  response is the backend's own shape and the agent is not the party constrained by it.
- Argument curation does not reach `outputSchema` ([argument-curation.md](argument-curation.md)): a
  response field is not an argument, is not renamed on the wire at invoke time, and every variant of
  one operation therefore publishes the same `outputSchema`.
- `outputSchema` is published on `load_tool` only. It is **not** validated against
  `InvokeSuccess.body`: `invoke_tool` is one fixed meta-tool whose result shape varies per call, so a
  client cannot check its `structuredContent` against a static schema. The compact card does not
  carry it either ([search-semantics.md](search-semantics.md)).
- `outputSchema` belongs to a catalog tool as `load_tool` returns it. The three meta-tools' own MCP
  `Tool.outputSchema` is not written.

## Method → annotation table

| Method     | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| ---------- | -------------- | ----------------- | ---------------- |
| GET / HEAD | `true`         | —                 | `true`           |
| POST       | —              | `false`           | —                |
| PUT        | —              | `true`            | `true`           |
| PATCH      | —              | `true`            | —                |
| DELETE     | —              | `true`            | `true`           |

`—` = the field is not written. Rationale: POST is additive (create) and does not overwrite data; PUT is a replacement (destructive but idempotent). Because a static mapping cannot be correct for every endpoint, SDKs SHOULD offer a per-endpoint override (Nest: `@McpTool({ destructive: true })`), and an overridden value beats the table. The override is carried on the wire as `EndpointDescriptor.annotations` and `ToolVariant.annotations`, merged per key over this table in that order ([tool-families.md](tool-families.md) §Annotations).
