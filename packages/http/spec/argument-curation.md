# Argument Curation

> Status: **normative.** `packages/http/core` and the NestJS SDK pass the curation corpus. The rules were written before the implementation, which is the order this repository requires: a rule change that does not move a fixture has not been made, and a spec written from one implementation is a description of that implementation.

Defines how a host reshapes the **agent-facing** surface of an endpoint without touching the backend's own contract. The machine-readable counterpart is `ArgumentCuration`, `ArgumentFill` and `ToolVariant` in [schemas/endpoint-descriptor.schema.json](schemas/endpoint-descriptor.schema.json); the fixture corpus lives in [conformance/metadata-extraction/](../conformance/metadata-extraction/) and [conformance/argument-mapping/](../conformance/argument-mapping/).

## What curation is, and what it is not

A backend's DTO is written for its HTTP clients. Handed to an agent unchanged, it exposes arguments the agent cannot know (`tenantId`), cannot interpret (`fq`) and should not touch (`includeDeleted`). Curation lets the host declare a different agent-facing surface over the same endpoint: rename an argument, replace its description, or hide it and supply the value from somewhere else.

Two things it is not:

- **Curation is not enforcement.** Hiding `tenantId` and filling it from a verified token does not isolate tenants. The backend's own pipeline decides, exactly as it does for every other request. This is the argument-shaped form of the rule in [visibility.md](visibility.md), and it needs stating more loudly there than here: visibility only filters a list, whereas curation writes a value onto the wire and therefore looks like a boundary.
- **Curation is not confidentiality.** A hidden path parameter's name survives in the route, and the route is a search field ([search-semantics.md](search-semantics.md)). What curation withholds is a **slot**, not a **vocabulary**. The `parameters` search field is the other way round: it is built from the published schema, so a hidden argument's name never enters it and a renamed one enters only as `as`.

## The declaration

`EndpointDescriptor.arguments` carries one `ArgumentCuration` record per curated argument. Like `toolName` and `containerPrefix` ([metadata-contract.md](metadata-contract.md)), these are **declarations** the platform collects from host attributes, decorators and options and reduces to pure data for the rule layer; they are not facts discovered from the framework.

| Field         | Meaning                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `name`        | The **wire** name: a parameter name, a flattened request-body field name, or the body root argument name |
| `as`          | The name the agent sends. The wire name is unchanged                                                     |
| `description` | Replaces the description the schema carries                                                              |
| `hidden`      | An `ArgumentFill`. Present means the argument is hidden                                                  |

`name` is matched **ordinally and case-sensitively**. JSON keys are case-sensitive, and the case-insensitive matching in [error-mapping.md](error-mapping.md) is a tolerance for backend error payloads rather than a naming rule; importing it here would let `tenantID` silently bind to `tenantId`.

`as` MUST match `^[A-Za-z_][A-Za-z0-9_]*$`. The excluded characters are the ones error mapping uses to split a reported field name (`$.`, `.`, `[`), and a renamed argument carrying one of them could not be canonicalised back.

`description` MUST be non-empty. There is consequently no way to **erase** a description — an empty string would be indistinguishable from "no declaration" in a JSON fixture. This is a deliberate limit, not an oversight.

### The three fills

| `kind`     | Behaviour                                                      | Use                                                 |
| ---------- | -------------------------------------------------------------- | --------------------------------------------------- |
| `constant` | The declared value is written on every call                    | A fixed filter the agent must not vary              |
| `deferred` | The value comes from a named provider, resolved at invoke time | A tenant identifier taken from the caller's token   |
| `omit`     | Nothing is written at all                                      | An optional flag whose backend default should stand |

`omit` is not redundant with a constant. Writing a constant **overrides** the backend's own default, and [schema-conversion-rules.md](schema-conversion-rules.md) Table 5 already records why that distinction matters: in a PATCH body, "absent" and "explicitly the default" are different requests. Without `omit` a host cannot say "the agent should not see this, and the backend should decide".

A fill's requiredness is **derived, never declared**: a parameter is required exactly when its own `required` flag says so, a flattened body field when `requestBody.schema.required` names it, and the body root unless `requestBody.required` is `false`. A path parameter is additionally treated as required at composition time, because a route with an unfilled placeholder cannot be composed at all. Deriving it makes it structurally impossible for a fill's requiredness to disagree with the schema.

A required argument MUST NOT be hidden with `omit` — the backend would reject every call and the agent could do nothing about it. On a path parameter this is fatal, because the route cannot be composed at all; elsewhere the endpoint is dropped with `hidden_required_omitted`.

## Curation does not influence shape selection

The body-root decision, the flattening predicate and the wire-name uniqueness check ([schema-conversion-rules.md](schema-conversion-rules.md) Table 6, [metadata-contract.md](metadata-contract.md)) all run on **wire names, before curation is applied**. Curation is a projection over a shape that has already been decided.

The tempting alternative — letting a rename or a hide resolve the parameter/body-field collision that forces root mode — is wrong, and the reason is worth recording because the analogy that suggests it is close. Table 6 says the collision check runs on the renamed form when a host renames through `propertyName`. But `propertyName` is a **serialization** rename: it changes the JSON key the backend accepts. Curation changes only the agent-facing name; the wire ambiguity that forces root mode is untouched by it. A host that genuinely wants to resolve such a collision renames the wire field, which is what `propertyName` is for.

The second reason is mechanical: the body-root decision is taken independently while producing `inputSchema` and while producing the request template. Making it depend on curation would make both depend on curation and would double the surface on which the two can silently drift.

## Producing `inputSchema`

Curation is resolved once and the same resolution feeds both the tool definition and the request template. An implementation that interprets the declaration separately in each place will eventually let the published `properties` and the composer's allow-list disagree, and that disagreement is invisible: the tool builds and the call fails.

Against the rules in [metadata-contract.md](metadata-contract.md):

- A hidden argument contributes **no** `properties` entry and **no** `required` entry.
- A renamed argument's property key is `as`. Its position is unchanged — curation MUST NOT reorder `properties` or `required`. A hidden argument's position simply closes.
- A curation `description` **overrides**, including a description the schema already carries. This is the one place the "the schema source takes precedence" rule of [metadata-contract.md](metadata-contract.md) is inverted, and deliberately: the parameter description is a fallback for a missing description, whereas a curation description is the host stating what the agent should read.
- When the body flattens, the wire-to-agent mapping MUST be applied **before** the check that a `required` entry names a published property. A renamed required field is keyed by its agent name, so a check performed on the wire name finds nothing and silently drops the requiredness.
- The visible agent namespace MUST be unique. A collision between an `as` and any other argument's name — wire or agent, and including an argument that is itself renamed away — is `argument_collision`.

### `$defs`

A hidden argument's schema is not published, so no `$ref` in the document addresses its `$defs` bag and the bag MUST NOT be lifted. Lifting it would publish unreferenced definitions and, worse, could raise `schema_def_conflict` over a schema the agent never sees.

Two consequences follow and are normative:

- An endpoint dropped today for `schema_def_conflict` MAY start building once the conflicting argument is hidden. That is correct behaviour, not a regression.
- A flattened body's `$defs` seed is still contributed **unconditionally and is not pruned**, even when every property that referenced it is hidden. Pruning would require a reachability analysis neither implementation performs, and an unreferenced `$defs` entry is valid JSON Schema. An implementation that prunes diverges.

## Composition

The composer receives the resolved deferred values as plain data; it never invokes a provider. Constants live in the template and never enter that map, so a fixture with no host delegate still pins constant behaviour.

Against the algorithm in [argument-mapping.md](argument-mapping.md):

1. **The allow-list speaks agent names, and the deny-list beats the free-form allowance.** The wire name of every curated argument is refused, and so is the agent name of every hidden one. Without the second half of that rule a free-form body (`additionalProperties` open) accepts a hidden field's wire name and the hide is bypassed; without the first half, the wire name of a renamed parameter is accepted, consumed by nothing and dropped in silence.
2. The error message lists the permitted names and MUST NOT mention a refused one. It MUST NOT distinguish "no such argument" from "that argument is not yours to set"; both are `unknown_argument`. Reporting the difference would turn the composer into an existence oracle for hidden arguments.
3. **Filled values pass through the same gates as agent values** — the same type gate, the same RFC 3986 encoding, the same CR/LF/NUL rejection on headers. The header check in particular is load-bearing rather than merely consistent: in a multi-tenant deployment a deferred tenant identifier is attacker-influenced, and skipping the check there is a header-injection hole.
4. Declaration order is preserved, so a hidden query parameter occupies its declared position. The composed query string is byte-for-byte identical to the one the agent would have produced by supplying the value itself.
5. In root mode a `rootFill` value **is** the body. An absent optional fill sends no body at all, preserving root mode's distinction between "no body" and `{}`.

### Deferred values

A deferred source MUST be resolved **exactly once per invocation**, before the first composition, and the same map MUST be used for every composition of that invocation. An SDK that composes twice — once to validate and once to dispatch — would otherwise let a non-constant source disagree with itself between the two.

A filled slot MUST NOT produce `invalid_path_type`, `invalid_type`, `null_not_allowed`, `missing_path_parameter` or `header_injection`. Those codes instruct the agent to repair an argument it cannot see, and an SDK that surfaces the code verbatim turns that instruction into a retry loop. Two codes replace them:

| Condition                                                                                                    | Code                                                         |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| The source is absent and the slot is required                                                                | `deferred_value_missing`                                     |
| The source is absent and the slot is optional                                                                | no error; the slot is omitted                                |
| The value fails the slot's type gate, is not an array for an array binding, or carries CR/LF/NUL in a header | `deferred_value_invalid`                                     |
| A constant of any kind                                                                                       | cannot fail; constants are validated at tool-production time |

Both messages MUST carry no value, no source name and no wire slot name, in the same register as the withheld-detail messages in [error-mapping.md](error-mapping.md), and MUST state that retrying will not help. The source and the slot belong in the host's log.

A provider fills a slot and nothing else, so it cannot write an identity channel: a slot on a declared identity carrier is refused at template production ([argument-mapping.md](argument-mapping.md), `identity_carrier_parameter`), hidden or not. Carrying identity to the backend is the carriers' job, not curation's.

`null` from a provider is not a value on a path, query or header slot: it is treated as absent, because `null_not_allowed`'s guidance ("omit it instead") addresses an agent that cannot act here. On a body slot `null` is written verbatim, because `{"x": null}` is a legitimate body.

**Forward constraint.** No response cache exists today ([caching.md](caching.md) covers `facts` and `probe` only), so nothing is broken. But any future cache keyed by `CallerScope` MUST fold every source an endpoint fills into its key. A provider reading a header outside the declared identity carriers is invisible to the carrier digest, and a cache that misses it serves one tenant's response to another.

## Error mapping

Published argument names are agent names while the backend reports wire names, so [error-mapping.md](error-mapping.md)'s field-name canonicalisation needs both directions. A field reported under a hidden argument's name MUST be emitted with its message and **without** a name: dropping the entry loses the only useful information, and keeping the wire name sends the agent to repair an argument it cannot set.

## Variants

`EndpointDescriptor.variants` turns one operation into several tools. When present, the endpoint produces **exactly one tool per variant** and its own `toolName` and `description` are unused. There is no additional uncurated tool: one would re-expose the argument the host just hid.

A variant MUST declare its own `name` and `description`. The requirement is not stylistic. A description written for an endpoint cannot honestly describe two tools whose arguments are hidden differently, and the same failure exists in a milder form on a single tool — "filter by tenant and status" describes an argument the agent cannot reach once `tenantId` is hidden. Implementations SHOULD therefore emit `curation_leaks_name` when a tool's **name or description** contains the wire name of a hidden or renamed argument as a contiguous token sequence, using the tokenizer of [search-semantics.md](search-semantics.md). Checking the name is not optional: a generated name carries `by_<path parameter>`, so hiding a path parameter leaves the wire name in the name itself. The diagnostic is heuristic — a single-token wire name such as `page` will fire on "page size" — so it is a warning and MUST NOT default to fatal.

A second haystack earns a second code. The descriptions the host writes in its own `arguments` records are published on the tool's schema **and indexed** as the `parameters` search field ([search-semantics.md](search-semantics.md)), so prose there that names a curated-away argument does more than confuse a reader: discovery routes an agent to a tool by a term `invoke_tool` will refuse. Implementations SHOULD therefore emit `curation_leaks_name_in_argument` when any **curation-declared description** on the tool contains such a wire name, by the same tokenizer and the same contiguous-sequence rule.

The haystack is deliberately only the host's own declarations, resolved through the variant's whole-record replacement — never a description inherited from the operation's parameters or body type. Inherited prose is not evidence that anything was curated: the host did not write it while hiding or renaming the argument, and a single-token wire name such as `type` or `source` collides with ordinary schema prose often enough to drown the signal at the scale of a whole property set. The separate code exists so a host can tune or silence this heuristic without losing the tool-description one; like it, it is a warning and MUST NOT default to fatal.

A variant's `arguments` merge with the endpoint's by **whole-record replacement per wire name**, never field by field. Field-level merging means a host who omits `tenantId` from one variant leaks it, which is a security-shaped silent failure. A record carrying only `name` resets that argument to the endpoint's own shape, and is the only way to un-hide an argument in one variant.

Operation identity is unchanged: `(container, operationId, method)`. Variants produce tools, not operations, and tool uniqueness is already enforced by `name_collision` ([naming.md](naming.md)). Expansion happens **strictly after** route folding, so the folding rule needs no change.

Three consequences:

- **Variant names are absolute.** A declared name already skips prefixing; variants inherit that, `PrefixMode` does not touch them, and a collision is fatal.
- **`alternateRoutes` belongs to the operation**, so every variant carries the same list and a query naming a compatibility path returns all of them. Alternate routes are search text and are never invoked: a hidden path parameter cannot be bypassed through one.
- **Every variant shares `auth`** and therefore receives the same visibility decision. A narrowly curated variant is not a narrower permission.

A variant MAY declare `annotations`, merged per key over the operation's ([tool-families.md](tool-families.md) §Annotations). A variant MAY declare its own `requestBody` only when the operation declares a `family`; the variants of such an operation are its members, and [tool-families.md](tool-families.md) defines what a member's body, key and search behaviour are.

Variants dilute search: several cards with the same route and adjacent descriptions compete for the same terms. Implementations SHOULD warn (`variant_indistinguishable`) when two variants of one operation produce an equal `inputSchema` and an equal description, and variant descriptions should differ in their first clause, because the card truncates at 160 characters.

## Curation and route folding

Folding keeps the shortest route ([naming.md](naming.md)), and two routes of one operation may carry different path parameters. A curation naming a parameter that exists only on a folded-away route becomes unresolvable through no fault of the declaration.

Curation is resolved against the **kept** route. `curation_unresolved` drops the endpoint in general, but in the narrow case where the name is unresolvable on the kept route and resolvable on a folded-away one, implementations emit `curation_unused_on_kept_route` and do not drop. Fail-closed is preserved, because the argument genuinely does not exist on the route that will be invoked.

## Where declarations come from

The descriptor carries curation as pure data, so how a host writes it is an SDK concern. Two rules are normative anyway, because both decide whether a declaration reaches the descriptor at all.

A host that can declare curation at several levels MUST resolve them by specificity, nearest to the endpoint winning. Between levels the nearer declaration simply wins and nothing is reported. Within one level there is no nearer declaration, so two that set the same argument to different values are `ambiguous_curation` and fatal — resolving them by registration order would present the host with a ladder that does not decide anything. A host that offers sealing MUST reject an override of a sealed argument from any level with `sealed_curation_overridden`, and MUST determine the sealed names before merging: sealed declarations are applied last so that they win, so a check that learns them while merging can never observe an override.

## Diagnostics

| Code                              | Result                                      | When                                                                                                                                      |
| --------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `curation_unresolved`             | endpoint dropped                            | A declaration names no parameter, no flattened body field and no body root — including naming a body field while the body is in root mode |
| `invalid_fill_constant`           | endpoint dropped                            | A constant whose JSON type does not satisfy the binding, or `null` on a path, query or header slot                                        |
| `hidden_required_omitted`         | endpoint dropped; fatal on a path parameter | A required argument is hidden with `omit`                                                                                                 |
| `unknown_fill_source`             | endpoint dropped                            | A declared `source` has no registered provider                                                                                            |
| `curated_open_body`               | warning                                     | An argument is hidden on a body that accepts additional properties, so only the composer can enforce the hide                             |
| `curation_leaks_name`             | warning                                     | A tool name or description still names a hidden or renamed argument                                                                       |
| `curation_leaks_name_in_argument` | warning                                     | A curation-declared argument description still names a hidden or renamed argument                                                         |
| `curation_unused_on_kept_route`   | warning                                     | See above                                                                                                                                 |
| `variant_declaration_conflict`    | endpoint dropped                            | `toolName` and `variants` are both declared                                                                                               |
| `variant_indistinguishable`       | warning                                     | Two variants produce an equal input schema and an equal description                                                                       |
| `ambiguous_curation`              | fatal                                       | Two declarations of equal specificity set the same argument to different values                                                           |
| `sealed_curation_overridden`      | fatal                                       | A sealed declaration is overridden from any level                                                                                         |

Reused rather than added: two declarations for one wire name is `duplicate_argument`; an `as` collision is `argument_collision`; an agent sending a refused name is `unknown_argument`; two variants producing one tool name is `name_collision`; an over-long variant name is `long_tool_name`.

`unknown_fill_source` and `invalid_fill_constant` are checked at **tool-production** time. Deferring either to invoke time converts a host mistake into a failure that recurs on every call and that nobody in the request path can act on.

## Deliberately out of scope

- **Narrowing an argument's schema.** Whether a declared schema narrows or widens the backend's own cannot be checked mechanically, and a wrongly narrowed contract stops the agent from composing a call the backend would have accepted. A family member's body is not an exception to this: the dispatcher's own body is deliberately opaque, so the member body narrows nothing — it is the only statement of that member's contract ([tool-families.md](tool-families.md)).
- **A visible default.** [schema-conversion-rules.md](schema-conversion-rules.md) Table 5 declines to write `default`; `hidden` is the only value-injection path, and `omit` covers "let the backend decide".
- **Per-caller curation.** The published schema MUST be caller-independent. A caller-dependent schema would break the catalog snapshot, the generation stamp and the `listChanged` fan-out ([transport.md](transport.md)), all three of which assume a single global generation. Only the **value** of a deferred fill varies per caller. Family membership is global for the same reason ([tool-families.md](tool-families.md) §Membership).
- **Reordering arguments.** The order of `properties` and `required` is normative; curation renames in place.
- **A general tool-transformation hook.** Curation is a named, single-purpose declaration that the tool-definition factory and the request composer read as an **input**; neither gains a hook, and no new extension point is added for it. A general callback over the finished tool would let a host reshape the published schema without the template that enforces it, and the drift would be invisible until a call failed. A family source is not such a hook: it returns data that is lowered into variants before the factory runs, and the factory builds the schema and the template from that one input.
- **Deleting a description.** A curated description is at least one character: an empty string cannot be told apart from "no declaration" in a JSON fixture.
- **Deriving a value from another argument.** Not specified here. The provider contract is written so that it can be specified later without a second mechanism.
