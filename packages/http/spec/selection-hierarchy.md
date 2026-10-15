# Selection Hierarchy

> Status: **normative** — validated by two independent implementations (ASP.NET `SelectionResolver` + TS `isSelected`; `[McpTool]`/`[McpIgnore]` and `@McpTool()`/`@McpIgnore()` pass the same `selection/` corpus, as do `SelectionOptions.Rules` and `selection.rules` through `ResolveRules`/`resolveRules`).

Defines which endpoints are exposed on the MCP surface. The machine-readable counterpart is the `selection` fixture kind in [schemas/fixture.schema.json](schemas/fixture.schema.json); the corpus is [conformance/selection/](../conformance/selection/).

## Three separate layers, not to be conflated

| Layer           | Its question                                     | Defined in                     |
| --------------- | ------------------------------------------------ | ------------------------------ |
| **Selection**   | Is this endpoint exposed to agents at all?       | this document                  |
| **Visibility**  | Of the exposed ones, which does this caller see? | [visibility.md](visibility.md) |
| **Enforcement** | Does the call go through?                        | the backend's pipeline         |

Selection is caller-independent and fixed at application startup; visibility is computed per caller on every search. An unselected endpoint is invisible to every identity.

## Five levels, most specific wins

| Level       | Scope                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| `global`    | Every endpoint in the application                                                |
| `rules`     | Every endpoint whose route and method a config-level rule matches                |
| `provided`  | The one endpoint a row from the host's selection source names                    |
| `container` | Every endpoint in a group (C#: the controller class; Nest: the controller class) |
| `operation` | A single endpoint (C#: the action method; Nest: the handler method)              |

An endpoint's effective decision is the decision of **the most specific level carrying a marker**: `operation` > `container` > `provided` > `rules` > `global`. More general levels apply only when no more specific marker exists.

The three attribute-free levels follow directly from the frameworks' own metadata models; no new mechanism is invented. (The C# counterpart: endpoint metadata arrives ordered from most general to most specific, and the last writer wins. The Nest counterpart: `Reflector`'s resolution, which puts method metadata ahead of class metadata.)

An attribute MUST outrank a rule. A rule is written where the host configures the SDK and an attribute is written on the endpoint itself, so the more local declaration is the more specific one; the same ordering is what every OpenAPI generator in this space already does, and reversing it would let a line in `Program.cs` silently overrule an `[McpIgnore]` sitting on the action.

## Markers

Every level is in one of three states: no marker · `include` · `exclude`. The `global` level MUST NOT be marker-less; it always carries a default.

| Input                                      | Result                                          |
| ------------------------------------------ | ----------------------------------------------- |
| `container: include`, `operation: exclude` | out — the most specific wins                    |
| `container: exclude`, `operation: include` | in — the exception exposes that single endpoint |
| `global: include`, no marker               | in                                              |
| `global: exclude`, no marker               | out                                             |
| `rules: exclude`, `container: include`     | in — an attribute outranks a rule               |
| `rules: exclude`, no attribute             | out — the rule outranks the global default      |
| `provided: include`, `rules: exclude`      | in — a row names the endpoint, a rule a pattern |
| `provided: include`, `operation: exclude`  | out — an attribute outranks a row               |

## The global default is `exclude`

Nothing undeclared is exposed. This is the selection form of the default-deny invariant: adding the SDK to a backend MUST NOT mean exposing that backend's entire surface to agents.

`global: include` is a legitimate setup (expose everything, then carve out exceptions), but it **requires a declaration** — it cannot be the default.

## The selection source

Some hosts keep the list of exposed endpoints in data, such as a table an administrator edits. They register one source (C#: `options.Selection.Provide`; NestJS: `selection.provide`) that returns rows of `{ method, route, decision }`, each optionally carrying a name, a description, tags and search terms. The source loads exactly like a family source ([tool-families.md](tool-families.md) §Membership): at startup or in the background, again on a refresh interval, a refresh whose rows are unchanged rebuilds nothing, a reload that would turn the catalog newly fatal is refused, and a failure keeps the rows it last returned.

A row names one endpoint: its method compared case-insensitively and its route compared exactly with the composed route template, with no wildcards — patterns are what config-level rules are for. That is why `provided` ranks above `rules` and below the attributes: a row names a single endpoint, which makes it more specific than a pattern, but it is written far from the endpoint, so an attribute on the endpoint itself still wins.

Its overrides sit at the same place: a row's name, description, tags and search terms rank below the operation's own declaration and above the host's per-endpoint hooks.

Rows are data, so a defect in one is that row's alone, as with family members. A row naming no endpoint is `selection_target_unknown`, a malformed row is `selection_entry_rejected` (an invalid override loses only that override), and two rows that disagree about one endpoint are `selection_entry_conflict` — all warnings, and a contested endpoint is **excluded**, never left to a lower level that might include it. Contradictory data is not `ambiguous_selection`: it is not source code, and one bad row should not stop a backend.

The source fails **closed**. Until it has returned once, an endpoint with no attribute marker is excluded and `selection_not_loaded` is reported, because the source may be the only thing keeping that endpoint out and a lower level might let it in. Attribute-marked endpoints are decided as usual. A host MAY make a failed first load stop startup instead (`selection_source_failed`).

## Config-level rules

A rule is a `{ route?, method?, decision }` triple declared where the host configures the SDK. It exists for the surface an attribute cannot reach: controllers the host does not own, generated code, and the case where carving `/admin` out of a `global: include` would otherwise mean editing every admin controller and remembering to edit the next one.

**Matching.** `route` is a glob against the composed route template of [metadata-contract.md](metadata-contract.md): `*` matches within one path segment and `**` matches across them, so **`**` is the catch-all and `*` is not** (`rule-single-star-is-not-the-catch-all.json`). Matching is whole-string and case-sensitive, and a `{id}` placeholder is matched literally, because the route template is what the rule sees — not a filled path. `method` is compared case-insensitively. An absent field matches everything. This is the same matcher and the same glob semantics that `CurationTarget.route` already uses in [argument-curation.md](argument-curation.md); a second pattern language in one product would be a defect.

Implementations MUST NOT use a host-written pattern as a regular expression without escaping every metacharacter outside the two wildcards, and MUST NOT let the pattern language grow a construct whose meaning the two regex engines do not share.

**Specificity** is the count of fields a rule names: `route` and `method` is 2, either alone is 1, neither is 0. A rule naming a method is therefore sharper than one naming only a route, which is what makes "expose `GET` under this subtree, nothing else" writable (`rule-method-breaks-the-tie.json`). This deviates on purpose from `CurationTarget`, where `method` does not contribute; there the sharper levels are the controller and the action, and selection rules have neither.

**Order carries no meaning.** Implementations MUST NOT resolve overlapping rules by declaration order. Order-sensitivity is the shape FastMCP's `RouteMap` list uses, and it makes the answer depend on where a line was typed: appending a rule to the end of a list — the natural edit — silently does nothing when an earlier entry already matched. Every rule here is evaluated, and only specificity ranks them.

**Repetition is not a conflict; contradiction is.** Two rules of equal specificity that decide the same way may overlap freely, which is what lets independent rules cover one endpoint (`rule-same-decision-does-not-conflict.json`). Two that decide differently are `ambiguous_selection` (`rule-contradiction-is-ambiguous.json`), by the same reasoning as the section below.

A consequence is normative: **a carve-out cannot be written among the rules.** `/admin/**` excluded plus `/admin/health` included is a contradiction, not a refinement, because both rules name one field. The carve-out belongs on the operation, which is already the most specific level (`rule-loses-to-operation-marker.json`). Ranking rules against each other by pattern length was rejected: it would put a second, rule-only specificity ladder next to the one the rest of the product uses, and "which glob is more specific" is a question two implementations would have to agree on for every pattern shape rather than for one integer.

## A conflict at the same level is an error

If one level carries both an `include` and an `exclude` marker, that is an error (`ambiguous_selection`). The SDK MUST NOT silently pick one; it fails loudly at startup or build time.

The rule holds even when a more specific level would override that level anyway. The rationale: a contradictory declaration is contradictory source code, and not reporting it would silently change behaviour later, when the more specific marker is removed. Same principle as `name_collision` in [naming.md](naming.md) — silent resolution is forbidden.

## Selection does not determine the name

Selection answers only "is it exposed." The tool name is produced per [naming.md](naming.md), and a name collision is an error independent of selection. Selecting an endpoint does not guarantee its name is valid — both checks run at startup.

## Known limits

- **A rule matches the route template, and the two SDKs derive that template from different frameworks.** Empty segments, a trailing separator and surrounding whitespace fold away identically on both sides. Parameter syntax does not: ASP.NET's constraints and defaults (`{id:int}`, `{id=1}`) are reduced to `{id}`, while a Nest path-to-regexp constraint (`:id(\d+)`) survives as `{id(\d+)}`. A pattern that reaches into a parameter's constraint is therefore not portable; one that matches `{id}` or a wildcard segment is. Route normalisation has no conformance corpus: each SDK pins its own with unit tests, so the agreement above is tested per SDK rather than against shared fixtures.
- **Selection runs before route folding.** An operation mounted at several routes is selected per route, so a rule that excludes one of them changes which route the surviving tool invokes rather than dropping the operation. The `route_folded` diagnostic still names the routes that were folded away.
- **There is no tag dimension.** A rule cannot match on `tags`, because tags are resolved while the descriptor is built and selection decides before that on one of the two SDKs. Moving tag resolution ahead of selection would make every excluded endpoint pay for a tag lookup it never uses.
- **There is no container dimension.** A rule names a route and a method, not a controller type: a host that can reference the type can also decorate it, and the level for that is `container`.
