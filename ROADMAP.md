# Roadmap

Work that is designed or wanted but not built. Each item says what is missing today, so it can be
checked against the code. When an item ships, delete it here and put its rules where they bind — the
spec, a guard comment or the package README.

## HTTP catalog and the OpenAPI gateway

- **A search ranker for the gateway CLI.** `createOpenApiMcpServer` takes a host ranker
  ([search-semantics.md](packages/http/spec/search-semantics.md), Replaceable ranker), but the
  `sezzlee-openapi` CLI has no way to bind one: loading a module would cross the gateway's file
  boundary, and calling a remote ranker by URL would be a second network egress beside
  `src/net/fetch.ts`. Either needs its own allowlist rule before it lands.
- **Whole-document validation.** Ingestion validates by point checks on the constructs it lowers
  ([openapi-ingestion.md](packages/http/spec/openapi-ingestion.md), pipeline step 3). A defect in a
  part nothing reads produces no diagnostic. Validate against the version's own meta-schema, still
  warning by default and fatal under `strict`.
- **A wider parity test.** `packages/servers/openapi-mcp/test/parity.spec.ts` compares argument
  name, location, required-ness and body media type between the SDK catalog and the document
  catalog of the .NET test controllers. It does not compare argument schemas, and it does not yet run
  against a real backend that embeds the SDK.
- **Tests for the gateway's config refusals.** Plain HTTP without token exchange bound to a
  non-loopback host, token exchange on stdio (`token_exchange_requires_http`), and the choice
  between security alternatives have no tests.
- **A login credential source.** Listed under "Not specified" in
  [credentials.md](packages/http/spec/credentials.md).
- **A route-normalisation conformance corpus.** Each SDK pins its own route folding with unit tests
  ([selection-hierarchy.md](packages/http/spec/selection-hierarchy.md), Known limits).
- **Tool families from an OpenAPI document.** Ingestion never produces `family`
  ([tool-families.md](packages/http/spec/tool-families.md)), so `openapi-mcp` publishes a
  dispatching endpoint as one opaque tool. An `x-sezzlee-family` extension, or a member list the
  gateway config names, would lower it the way the SDKs do.
- **Per-caller family membership.** Members are global: a caller who may not run a method still
  sees it. Filtering members per caller needs a caller-dependent published schema, which the catalog
  snapshot, the generation stamp and `listChanged` all rule out today
  ([argument-curation.md](packages/http/spec/argument-curation.md), out of scope).
- **A dispatch key in the body.** A family dispatches on a path, query, header or cookie parameter.
  A JSON-RPC-style `{"method": ..., "params": ...}` body is not covered.
- **Variant and family selection parity.** `@McpVariant` and `@McpToolFamily` imply selection on
  NestJS; `[McpToolVariant]` and `[McpToolFamily]` do not on ASP.NET Core, which still needs
  `[McpTool]`.
- **Build-time `unknown_fill_source` on ASP.NET Core.** The spec checks a deferred fill's source at
  tool production ([argument-curation.md](packages/http/spec/argument-curation.md)); the ASP.NET SDK
  skips a missing provider at invoke time instead.
- **Member bodies on `[McpToolVariant]`.** A NestJS `@McpVariant` can carry a family member's body,
  so a fixed family needs no source; on ASP.NET Core a member with its own body comes from a source.

## Source servers

- **`pg-mcp`.** A PostgreSQL server over `@sezzlee/db-core`, which already names no driver.
- **`docx-mcp` and `pptx-mcp`.** Further OOXML servers over `@sezzlee/ooxml-core`. Moving media
  selection from path prefixes to content types is the generalisation they need; `excel-mcp` keeps
  its prefix so its result set does not change.

## llm-mcp

- **Several model hosts.** Only one model host is configured today; what is missing is more
  than one host to queue on, with round-robin and failover between them. Done when a second GPU halves the queue and one
  host going down moves its work to the other.
- **A savings record.** Measure worker time, verification and codex's repair together, so a
  delegation's cost is known rather than assumed.
- **A job model for large inputs.** Start and poll for work over 1 000 rows; `local_map` refuses more
  than 2 000 rows today.
- **Configuration knobs.** A model per `local_task` kind (only `SEZZLEE_LLM_MODEL` exists),
  `SEZZLEE_LLM_TOOLS` to register a subset of tools, `SEZZLEE_LLM_PROMPTS` to override the kind prompts
  (hard-coded in `src/tools/prompts.ts`), and throughput in `local_status`.
- **An OpenAI-compatible backend** for vLLM, llama.cpp and LM Studio. Only `src/backend/ollama.ts`
  exists; the port is `src/backend/port.ts`.
- **Delegation instruction templates.** AGENTS.md and CLAUDE.md templates in the README, and a
  deployment setting that swaps the delegation instructions, for example for a sensitive-data policy.

## Chat product: tool approval

- **Use-count grants** ("the next five calls"). No speculative column: adding a nullable column is
  instant on PostgreSQL 17. Decrement in memory inside the per-turn closure `gateFor` already returns
  and write once when the turn settles, so the gate keeps one read per turn and no write per call; a
  crashed turn overshoots by at most the step budget.
- **Argument-bound grants.** A remembered grant covers every argument today. Mark which input fields
  are part of a tool's identity and bind the grant to those fields only. For a remote tool the server
  does not say which fields those are, so this may not be solvable there.

## Parked

Cheap, but nobody has asked for them.

- A per-tool digest in `load_tool`, so a client can tell whether a tool it loaded earlier changed.
