# Tool Families

> Status: **normative.** `packages/http/core` and the NestJS SDK pass the family corpus in [conformance/metadata-extraction/](../conformance/metadata-extraction/) (`family-*`, `variant-body-*`, `*-annotations-*`), [conformance/naming/](../conformance/naming/) (`variant-name-*`), [conformance/argument-mapping/](../conformance/argument-mapping/) (`family-*`) and [conformance/search/](../conformance/search/) (`family-*`). OpenAPI ingestion lowers `x-sezzlee.family` into the same form ([conformance/openapi-ingestion/](../conformance/openapi-ingestion/) `family-*`).

Defines how one operation that **dispatches on a parameter** becomes one tool per capability it dispatches to. The machine-readable counterpart is `ToolFamily`, `VariantRequestBody` and the `requestBody` and `annotations` fields of `ToolVariant` in [schemas/endpoint-descriptor.schema.json](schemas/endpoint-descriptor.schema.json).

## The problem

Some backends route many capabilities through one endpoint: `POST /Rest/InvokeDynamicMethod/{methodId}`, where each `methodId` names a different server method with a different body. Published as one tool, that endpoint is unusable: the agent does not know which ids exist, what each one does, or what body each one takes, and search can only ever return the one generic tool.

Such an id selects a **capability**, not a **record**. The test is whether a different value changes the shape and meaning of the call. `GET /orders/{orderId}` reads a different order for a different id and is one tool with an ordinary argument. `InvokeDynamicMethod/{methodId}` takes a different body and does a different thing for a different id; it is several operations sharing one URL, and it should be published as several tools.

## A family is variants plus one declaration

A family is not a second mechanism. [argument-curation.md](argument-curation.md) §Variants already turns one operation into several tools with their own names, descriptions and curation. A family adds three things:

1. `EndpointDescriptor.family.parameter` names the **dispatch parameter**.
2. Each variant is a **member**, and each member writes its own **key** into the dispatch parameter as a hidden `constant`.
3. A member MAY carry its own `requestBody` and its own `annotations`.

Where members come from is an SDK concern ([Membership](#membership)). The descriptor carries only the **lowered form** — the variants each member became — so the whole rule set is pure data and every implementation is tested by the same fixtures.

## The lowered form

- `family.parameter` MUST name a declared parameter whose schema `type` is a scalar type (`string`, `integer`, `number` or `boolean`) or an array of scalar types only, in any location except `querystring`. A union of scalars is still one value: .NET 10 writes every integer as `["integer", "string"]`. Otherwise the endpoint is dropped with `family_parameter_unresolved`. A dispatch key inside the body is out of scope.
- A family with no member produces **no tool at all** and is dropped with `family_without_members`. The uncurated dispatcher is never published in its place: it would hand the agent every capability behind one name, which is the exposure the family exists to remove.
- For every member, the record for the dispatch parameter — resolved by the variant merge of [argument-curation.md](argument-curation.md), whole-record replacement per wire name — MUST be hidden with `kind: "constant"` and a JSON string, number or boolean value. A member that leaves the parameter visible, omits it, or fills it from a `deferred` source is `family_key_unfilled`, and the endpoint is dropped: such a member can reach every other member's capability through its own name.
- Keys MUST be pairwise distinct under JSON value equality; `"1"` and `1` are different keys. Two members with one key are `family_key_duplicate`.
- A key is an ordinary constant fill, so it is checked against the dispatch parameter's schema like any other (`invalid_fill_constant`) and written through the same path encoding ([argument-mapping.md](argument-mapping.md)).

Sending the dispatch parameter's name as an argument does not switch members: it is not an argument of the member, and the call is refused with `unknown_argument` (`family-member-key-agent-name-rejected.json`).

## A member's body

`ToolVariant.requestBody` replaces the operation's body **schema** and **requiredness** for that member. `contentType` and `objectNotation` stay the operation's: they describe the backend's parser, not the member. `description` is the member's when it declares one and the operation's otherwise.

The body is resolved **once** per member, into the descriptor the member's tool is built from. The published `inputSchema`, the request template, the body-root decision and every body diagnostic read that one descriptor; an implementation that substitutes the body separately in two places will eventually publish one body and compose another.

Everything [schema-conversion-rules.md](schema-conversion-rules.md) and [argument-curation.md](argument-curation.md) say about a body applies unchanged to a member's: flattening, root mode, `$defs` lifting and `schema_def_conflict`, and curation. An operation-level declaration applies to every member and is resolved against each member's own body, so a body field one member lacks is `curation_unresolved` (`family-member-body-curation-unresolved.json`).

A member body arrives as host data, not from a discovered type, so nothing upstream has resolved it. It MUST be self-contained: every `$ref` resolves to one of the schema's own `$defs`, and no subschema carries `$id`, `$anchor`, `$dynamicRef`, `$dynamicAnchor`, `$recursiveRef` or `$recursiveAnchor`. Otherwise the endpoint is dropped with `variant_body_invalid`: a reference that leaves the schema would be followed by whichever validator the agent's client runs, and the composer never checks what it points to.

Only a family member may carry `requestBody`. A plain variant carrying one is `variant_body_without_family`. The restriction is what keeps "narrowing an argument's schema" out of scope everywhere else ([argument-curation.md](argument-curation.md)): a dispatcher's own body is deliberately opaque, so a member body narrows nothing — it is the only statement of that member's contract that exists.

## Annotations

A tool's `annotations` are merged **per key**, later sources winning: the hints the method implies ([metadata-contract.md](metadata-contract.md)), then `EndpointDescriptor.annotations`, then `ToolVariant.annotations`. A read-only member of a `POST` dispatcher therefore declares `readOnlyHint` and keeps the `destructiveHint: false` its method implies. Neither declaration is restricted to families.

## What members share

Member names are absolute, like every variant name: no prefix is applied, the name MUST match the tool-name pattern (`invalid_name`), and a name equal to any other tool's is `name_collision` and fatal ([naming.md](naming.md)).

Every member shares the operation's `auth`, `tags`, route and `alternateRoutes`. Visibility is therefore decided once for the whole family ([visibility.md](visibility.md)), and a member is not a narrower permission. Whether a given caller may invoke a given member is the backend dispatcher's decision at invoke time, exactly as it is for the request an existing client sends.

When the probe tier checks a member, a path parameter hidden with a constant is written with that constant, not with a placeholder or a host probe value: the member's own key is the only value that routes to the member.

## Search

Members are separate search documents ([search-semantics.md](search-semantics.md)). Terms from the route every member shares match every member, so their document frequency is at least the member count and they carry little idf; a member's own name, description and body fields decide its rank (`family-member-ranked-by-description.json`, `family-shared-route-does-not-swamp-ranking.json`, `family-member-body-parameter-searchable.json`).

A key is never a search term: it is a hidden constant, so it is in neither the published schema nor the route (`family-key-value-not-searchable.json`). The dispatch parameter's **name** stays in the route and matches every member (`family-dispatch-parameter-name-matches-through-route.json`) — hiding withholds a slot, not a vocabulary.

## Membership

Membership is **global**. An SDK loads members from a host-registered source when it builds the catalog and again on every reload; every caller sees the same members and the same schemas, for the reason [argument-curation.md](argument-curation.md) gives against per-caller curation.

A reload with a family source MUST follow this order: load members, build the candidate catalog, and only then commit. If the candidate has a fatal diagnostic and the current catalog does not, the current catalog is kept and the reload fails; otherwise the candidate is committed, the generation advances and `listChanged` is signalled ([caching.md](caching.md)). Without the check, a member added to the backend's data under a name another tool already has would take every tool offline at the next reload.

A source failure is not a build failure. The members it last returned stay published, and an SDK reports that they are stale; a source that has never returned leaves its families without members, which drops them.

A host MAY opt in to failing startup when a source's first load fails (`Families.OnFailure = Fatal` / `families.onFailure: "fatal"`); a later failure never stops a running catalog. A source that runs past the host's load deadline fails with a message that says it timed out and names the deadline setting, because a bare cancellation does not tell an operator which knob to turn.

Loading MAY happen after startup (`LoadMode = Background` / `loadMode: "background"`): the catalog is built without the members, reports `family_not_loaded`, and follows the reload order above when the load completes. Sources MAY be loaded again on an interval; a periodic load whose members equal the published ones MUST NOT commit, so a refresh that changes nothing does not signal `listChanged`.

A remote gateway has no host process to register a source in, so for an OpenAPI document the document itself is the source: the backend lists the members in the dispatching operation's `x-sezzlee.family` ([openapi-ingestion.md](openapi-ingestion.md) §Families). A reload re-reads the document and follows the same order; a document that cannot be read keeps the running catalog, members included. A member the extension cannot carry is `family_member_rejected`, the same warning an SDK reports.

## Diagnostics

Wire codes, pinned by fixtures in every implementation:

| Code                          | Result           | When                                                                            |
| ----------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `family_parameter_unresolved` | endpoint dropped | The dispatch parameter is undeclared, not scalar, or a `querystring`            |
| `family_without_members`      | endpoint dropped | A family declares no variant                                                    |
| `family_key_unfilled`         | endpoint dropped | A member does not hide the dispatch parameter with a scalar constant            |
| `family_key_duplicate`        | endpoint dropped | Two members dispatch with an equal key                                          |
| `variant_body_without_family` | endpoint dropped | A variant declares `requestBody` on an operation without `family`               |
| `variant_body_invalid`        | endpoint dropped | A member body references outside its own `$defs` or carries an identity keyword |

SDK codes, pinned by the NestJS SDK's host tests because they concern where members come from:

| Code                     | Result           | When                                                                                                                                                      |
| ------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown_family_source`  | endpoint dropped | A family names a source no host registered                                                                                                                |
| `family_source_failed`   | endpoint dropped | The source failed and has never returned members                                                                                                          |
| `family_source_stale`    | warning          | The source failed; the members it last returned stay published                                                                                            |
| `family_not_loaded`      | endpoint dropped | The catalog was built before the source's first load completed; the load's completion triggers a reload                                                   |
| `family_member_rejected` | warning          | One member was refused before lowering (ill-formed name, empty description, repeated name or key, `variant_body_invalid`); the rest of the family is kept |

Reused rather than added: a key that does not fit the dispatch parameter is `invalid_fill_constant`; an operation-level declaration a member body cannot satisfy is `curation_unresolved`; a member name equal to another tool's is `name_collision`; an agent sending the dispatch parameter is `unknown_argument`.

## Deliberately out of scope

- **Per-caller membership.** The published schema MUST be caller-independent ([argument-curation.md](argument-curation.md)). A caller who may not invoke a member still sees it; the backend refuses the call.
- **A dispatch key in the body.** A JSON-RPC-style `{"method": ..., "params": ...}` body would need the key to shape the body it lives in.
- **Per-member tags.** Tags belong to the operation, like `auth`.
