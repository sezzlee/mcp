# @sezzlee/spec

The normative specification for sezzlee: prose plus the JSON Schemas that every language's
types are generated from.

`private: true`, version `1.0.0`, never published. It is consumed as a `workspace:*` dependency by
the type generators. If you are reading this you are changing the spec, not installing it.

## Read the status banner first

Every `.md` file here opens with a `> Status:` line, and the values are **not uniform**. Do not
treat a file as binding without reading it.

| File                         | Subject                                          | Status                                   |
| ---------------------------- | ------------------------------------------------ | ---------------------------------------- |
| `metadata-contract.md`       | `EndpointDescriptor`, `Auth`, `ToolDefinition`   | normative, two implementations           |
| `naming.md`                  | Tool naming, container prefixes, collisions      | normative, two implementations           |
| `selection-hierarchy.md`     | Selection layers and precedence                  | normative, two implementations           |
| `visibility.md`              | Visibility decision, three-valued semantics      | normative, two implementations           |
| `search-semantics.md`        | Search-first contract, tokenization, cards       | normative, two implementations           |
| `error-mapping.md`           | Error envelope, code dictionary, leak prevention | normative, two implementations           |
| `invoke-semantics.md`        | Response budget, invoke deadline, cancellation   | normative, two implementations           |
| `transport.md`               | Streamable HTTP, PRM, the 401 rule               | normative, two implementations           |
| `fixture-format.md`          | Fixture envelope and kinds                       | normative, two implementations           |
| `schema-conversion-rules.md` | TypeShape → JSON Schema                          | **rule layer normative, binding partly** |
| `rate-limiting.md`           | Per-caller limits on meta-tool calls             | normative, two implementations           |
| `caching.md`                 | Cache key, namespace, TTL, invalidation          | **partly normative**                     |
| `argument-mapping.md`        | Flat arguments → HTTP request                    | **normative candidate**                  |
| `request-bodies.md`          | Body media types, form and multipart, file parts | normative, two implementations           |
| `argument-curation.md`       | Renaming, re-describing and hiding arguments     | normative, two implementations           |
| `tool-families.md`           | One dispatching operation → one tool per method  | normative, two implementations           |
| `openapi-ingestion.md`       | OpenAPI document → descriptors, diagnostics      | normative, one implementation            |
| `credentials.md`             | Backend credentials for a network invoker        | normative, one implementation            |

The three highlighted rows are the ones that bite. `schema-conversion-rules.md` has an
"Unpinned areas" section listing behaviour that is deliberately not settled; `caching.md` is
normative only in part; `argument-mapping.md` is validated by two implementations but not yet
declared normative. `openapi-ingestion.md` and `credentials.md` have one implementation each and
bind only an implementation that reads OpenAPI documents or calls a backend over the network.

The prose is English, like the documentation site that links to it.

## Schemas

`schemas/` holds the machine-readable half, and it is the source of truth for all languages:

```text
endpoint-descriptor.schema.json   tool-definition.schema.json
invoke-result.schema.json         type-shape.schema.json
fixture.schema.json
```

Types are generated from these — never written by hand:

```bash
pnpm turbo run gen
```

That writes `packages/http/core/src/generated/` and
`sdks/dotnet/src/Sezzlee.AspNetCore/Generated/`. Both are committed; both are off-limits to manual
edits.

Two schema constraints, enforced by the generator's limits: `$id` must equal the file name, and
`prefixItems`, `unevaluatedProperties`, `$dynamicRef` and `dependentSchemas` are unsupported.

## Changing the spec

RFC 2119 keywords — `MUST`, `SHOULD`, `MAY` — appear **only** in this directory. Nowhere else in
the repository, and never on the docs site.

To claim `normatif` a rule needs a fixture in [`../conformance`](../conformance) and two
independent implementations passing it. A rule change that does not move a fixture has not been
made; if a schema change breaks fixtures, update them in the same commit.

## Related

- [`../conformance`](../conformance) — the fixture corpus that pins these rules
- [`../core`](../core) — the TS reference implementation
- `apps/docs` — the public site. **Site pages must not restate normative rules; they link here.**
- [`../../../apps/docs/WRITING.md`](../../../apps/docs/WRITING.md) — the binding
  convention for anyone writing those pages
