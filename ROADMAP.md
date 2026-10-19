# Roadmap

Work that is designed or wanted but not built. Each item says what is missing today, so it can be
checked against the code. When an item ships, delete it here and put its rules where they bind — the
spec, a guard comment or the package README.

## HTTP catalog and the OpenAPI gateway

- **A search ranker for the gateway CLI.** `createOpenApiMcpServer` takes a host ranker
  ([search-semantics.md](packages/http/spec/search-semantics.md), Replaceable ranker), but the
  `sezzlee-openapi` CLI has no way to bind one: loading a module would cross the gateway's file
  boundary, and calling a remote ranker by URL would be a second network egress beside
  `src/net/fetch.ts`. The intended shape is declarative, never a module path: an `embedding` block
  (an OpenAI-compatible endpoint, its model and a `fromEnv` key), a `store` block (in memory first,
  then an external vector store), fusion with BM25 by reciprocal rank and `onFailure: fallback`.
  Before it lands it needs its own egress rule (the embedding and store hosts named in the config,
  HTTPS only, no redirect, no backend credential), an operator opt-in for sending the catalog to a
  third party, per-tool re-embedding keyed by a digest of its text so a reload re-embeds only what
  changed, and a recall measurement against BM25 on a real document with Turkish and English
  queries.
- **A richer document for the ranker.** `RankDocument` carries the seven BM25 fields only. An
  embedding ranker would gain from the operation `summary`, nested body and response field names
  and generated example queries, none of which reaches it today; adding them changes the ranker
  contract, and a hidden argument must stay out of every one of them.
- **Whole-document validation.** Ingestion validates by point checks on the constructs it lowers
  ([openapi-ingestion.md](packages/http/spec/openapi-ingestion.md), pipeline step 3). A defect in a
  part nothing reads produces no diagnostic. Validate against the version's own meta-schema, still
  warning by default and fatal under `strict`.
- **A wider parity test.** `packages/servers/openapi-mcp/test/parity.spec.ts` compares argument
  name, location, required-ness and body media type between the SDK catalog and the document
  catalog of the .NET test controllers, and rebuilds the SDK's tools from the document its
  `x-sezzlee` extensions annotate, comparing names, argument names and hints; the NestJS SDK runs
  the same rebuild in `sdks/nestjs/test/openapi-extension.spec.ts`. It does not compare
  argument schemas, and it does not yet run against a real backend that embeds the SDK.
- **Host-supplied descriptions and tags in `x-sezzlee`.** The SDKs publish a selection-source row's
  name and search terms and every selection decision, but not a description or tags that come from
  `options.Description` / `options.description`, the endpoint hooks or a selection-source row: the
  extension schema has no field for them, so a gateway rebuilding the catalog from the annotated
  document falls back to the document's own operation text. Adding the two fields is additive.
- **Tests for the gateway's config refusals.** Plain HTTP without token exchange bound to a
  non-loopback host, token exchange on stdio (`token_exchange_requires_http`), and the choice
  between security alternatives have no tests.
- **A login credential source.** Listed under "Not specified" in
  [credentials.md](packages/http/spec/credentials.md).
- **A route-normalisation conformance corpus.** Each SDK pins its own route folding with unit tests
  ([selection-hierarchy.md](packages/http/spec/selection-hierarchy.md), Known limits).
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

- **`docx-mcp` and `pptx-mcp`.** Further OOXML servers over `@sezzlee/ooxml-core`. Moving media
  selection from path prefixes to content types is the generalisation they need; `excel-mcp` keeps
  its prefix so its result set does not change.
- **`excel-mcp` peak memory.** A read workbook retains about seven times its file size, but the
  peak while reading is still 1.2 GiB for the largest corpus file: the cell reader allocates an
  object per cell before storing it, and V8 collects them late
  (`packages/lab/excel-lab/FINDINGS.md`).
- **ZIP64 coverage in `ooxml-core`.** The local-header check reads a ZIP64 entry's offset from its
  extra field; no fixture exercises that path yet.

## Excel analysis and typed data

- **Streaming CSV.** Reading beyond the current 16 MiB byte and two-million-cell limits needs
  a bounded streaming document contract, stable dialect/type decisions, cancellation and
  snapshot validation. The architecture below must be reviewed before implementation.
- **Multiple-source analysis.** Cross-sheet and cross-file joins need an explicit execution
  owner and cardinality, memory and provenance limits. The options below are design only.
- **Excel delimiter declarations.** Recognize a leading `sep=;` declaration without treating it
  as a header, and report the delimiter's source and explicit-argument precedence.

### Streaming CSV: proposed contract, pending approval

The current `chunked` mode is a response policy, not streaming input. `createDocumentStore`
reads the complete native snapshot, hashes it, and gives parsers a `bufferSource`; the CSV
adapter materializes the complete table. Raising a byte limit would retain both costs.

1. **Preserve secure access.** Add a format-neutral, cancellable snapshot reader to
   `file-core-native` and `file-core`. Every open and range read must retain the pinned-root,
   regular-file and changed-file checks. Do not reopen a path through JavaScript's filesystem
   API. A bounded, private temporary snapshot is the preferred first implementation because
   pages and repeated aggregates must read the same bytes. Its disk quota, permissions,
   cancellation cleanup and cache eviction are part of the contract, not caller conventions.
   This choice adds disk I/O and must be approved with the native change.
2. **Separate sequential and random access.** Keep the synchronous `SheetView` for resident
   workbooks. Introduce an asynchronous row-source contract for CSV scanning, with a known
   column span, row batches, cancellation and explicit unknown totals until a scan completes.
   Adapt aggregation, profiling and search to that contract before selecting it for large
   files. An optional sparse record-offset index supports later pages without retaining cell
   strings. Quoted newlines, decoder state and CRLF boundaries belong to the tokenizer;
   a byte offset alone is not a valid row cursor.
3. **Freeze decisions.** Encoding, `sep=` and delimiter precedence are decided once. Infer
   types from the first bounded sample of non-missing values, record the sample size and
   decision version, then freeze the `columns` plan. Later incompatible values increment
   contradiction, skipped and example counters. Never change a grouping key or previously
   emitted value after discovering a later row. Explicit `columns` bypass inference.
4. **Budget every retained resource.** The first proposal is 256 KiB input batches, a 1 MiB
   record limit, at most 10,000 sampled values per column and 100,000 across columns, and a
   2 GiB file / 4 GiB aggregate snapshot-disk quota. These are proposed operator limits,
   not implemented promises. Existing result, group, dense pivot, distinct and percentile
   limits still apply; exact percentiles fail when their sample budget is exhausted.
   A bounded time and cell-visit budget is required even when input can be streamed.
5. **Bind continuation to the snapshot.** A cursor carries the snapshot identity, dialect,
   frozen type-plan identity and next complete record. Eviction or a changed source returns
   a restartable error. Responses state whether totals and diagnostics cover a page, a
   sample or a completed scan. Aggregate results are emitted only after the scan completes.

Acceptance requires independent CSV oracles across every chunk boundary of multibyte text,
escaped quotes, CRLF and embedded line breaks; mutation and cancellation tests; frozen-plan
contradiction tests; and measured peak memory and temporary-disk use on progressively larger
files. A bounded 16 MiB fixture must produce the same values through resident and streaming
paths. Native platform CI is required. No streaming runtime code is part of the current work.

### Multiple-source analysis: execution owner to be decided

| Owner                      | Fit                                                       | Costs and constraints                                                                                                                                    |
| -------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reader MCP                 | Small, bounded joins under one configured filesystem root | Adds multi-file authorization, source lifetime and cardinality handling to the reader contract; unsuitable as an implicit extension of `aggregate_sheet` |
| Host-managed local worker  | Ad hoc joins of explicitly selected files or sheets       | Keeps a closed join plan and per-source approvals in the host; needs worker cancellation, memory limits and optional private spill storage               |
| Persisted semantic service | Repeated governed analysis over stable datasets           | Requires ingestion, refresh, ownership and storage policy; too much setup for an isolated workbook question                                              |

The recommendation is a host-managed local worker for ad hoc joins. The caller selects each
source explicitly; a closed plan names join kind, composite key columns, per-source type
specifications and output columns. No spreadsheet cell or tool argument becomes executable
code or unrestricted SQL. Identifier keys remain text unless explicitly typed, null keys do
not match, duplicate-key multiplicity is measured before emitting results, and an output-row
and memory budget refuses accidental many-to-many expansion. Return source fingerprints,
matched/unmatched row counts and key-read failures. Currency conversion, fuzzy matching and
time-zone guessing are outside that contract. The execution owner and these semantics must
be chosen before code or a new tool is added.

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
