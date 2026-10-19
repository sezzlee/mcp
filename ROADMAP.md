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
- **Typed-text aggregate cost.** Reading every text value to decide a column's separators and
  day/month order made an eight-sum aggregate over a 2,000,000-cell CSV 3.9 times slower on the
  first call and 5.7 times slower on a cached call than `coerceText` was (median of five
  alternating trials on a GitHub runner: 885 to 3,455 ms and 555 to 3,150 ms). A CPU profile puts
  about 32% in number-mark sniffing and 6% in duration sniffing, repeated on every call. Keeping
  each column's decision with the cached workbook and rejecting plain ASCII decimals before the
  full sniff are the candidates; either has to keep the every-value ambiguity contract and is
  measured with the `bench` label before it lands.

### Streaming CSV: proposed contract, pending approval

The current `chunked` mode controls responses. `createDocumentStore` still reads the complete
native snapshot, hashes it, and gives parsers a `bufferSource`; CSV parsing materializes the
complete table. The native file ceiling is 50 MiB, CSV input is limited to 16 MiB and two million
cells, and `readRange` resolves a fresh handle for each call. Its existence does not establish
a single large-file snapshot. Raising a byte limit would retain the allocation and consistency
problems. The following design requires approval before runtime implementation.

1. **Capture one authorized version.** Add a format-neutral, cancellable snapshot capability
   to `file-core-native` and `file-core`. Capture through one verified native handle, retaining
   pinned-root, regular-file and before/after identity checks. Do not reopen a caller path
   through JavaScript's filesystem API. Copy and hash the complete bounded source into a
   private temporary file before publishing any cursor. Existing native checks detect observed
   concurrent changes; they do not promise an atomic filesystem snapshot. Once capture succeeds,
   the private copy is immutable and its digest identifies exactly the bytes being analyzed.
   This makes the first response wait for full-file I/O. Native integer widths and byte limits
   must be reviewed before accepting the proposed 2 GiB input size.
2. **Bind authority and lifetime.** A snapshot lease binds the configured root, server session,
   selected source and captured version, not only a public digest or a guessed cache key.
   Native-owned temporary files have private permissions, accept no caller-selected paths,
   and are removed only through their owning lease. A live operation prevents eviction while
   it reads. Idle expiry, the hard lifetime, restart or quota eviction returns an explicit
   snapshot-expired error requiring a new cursorless call; it never silently reopens the source.
   The hard lifetime blocks new reuse; an operation already holding a lease can finish within
   its own deadline, then release and clean up. Cancellation reaches copying, hashing, decoding,
   tokenizing, aggregation and cleanup.
3. **Publish stable structure and interpretation.** A structural prepass over the captured
   bytes establishes record count, maximum width and ragged-record diagnostics before the
   first page. This preserves existing padding semantics when a late record is wider.
   Freeze encoding, BOM, `sep=`/delimiter precedence, header, locale, numbering system, literal
   lists and the parser/runtime version with the inferred or explicit `columns` plan.
   Inference uses a bounded prefix and bounded non-missing evidence, then stops. Later
   incompatible values increment contradiction, skipped and bounded-example counters; they
   cannot revise earlier groups or values. Explicit columns bypass type inference. Raw values
   remain available. Scanning all blank records to fill a sample is prohibited by the prefix
   and time budgets.
4. **Separate resident and sequential access.** Keep synchronous `SheetView` for resident
   workbooks. Add an asynchronous row-source contract for complete row batches, stable column
   span and cancellation, then adapt read, profile, find and aggregate to it. Sparse indexes
   store tokenizer restart points, including decoder state where necessary. Quoted newlines,
   escaped quotes and CRLF boundaries prevent treating an arbitrary byte offset as a row
   cursor. The initial design retains A1 limits of 1,048,576 rows and 16,384 columns and refuses
   larger dimensions explicitly. A CSV ordinal API beyond those limits needs a separate schema
   and cursor-version decision; a larger byte cap alone does not authorize larger coordinates.
5. **Continue the captured version.** A cursor carries the snapshot lease, dialect and frozen
   plan identities and next complete record. It continues that captured version even when
   the original file later changes; a new cursorless call captures the latest source. Responses
   expose the version used. This deliberately differs from current changed-file cursor refusal
   and avoids rehashing a multi-gigabyte source before every page. Preparation failures publish
   no cursor. No partial scan may be reported as a completed aggregate.

All values below are proposed operator limits, not implemented or measured guarantees. Byte
accounting includes retained text and state; counts alone do not bound their sizes.

| Resource                   | Proposed first limit                                             | Refusal or accounting rule                                                                                     |
| -------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Input batch                | 256 KiB                                                          | Preserve decoder and tokenizer state between batches.                                                          |
| Logical record             | 1 MiB encoded bytes and 2 MiB decoded UTF-16 payload             | Refuse excess; never truncate a field. This can reject a large record accepted by the current resident parser. |
| File and temporary storage | 2 GiB per file; 4 GiB per server process                         | The shared quota includes captures, persisted indexes and any future owned spill files.                        |
| Sample prefix              | First 20,000 records or 8 MiB decoded text, whichever ends first | Blank and missing records consume the prefix budget too.                                                       |
| Type evidence              | 10,000 non-missing values per column; 100,000 across columns     | Stop at any earlier prefix, byte or time limit and report the actual sample scope.                             |
| Retained working data      | 128 MiB across active streaming data and cached indexes          | Includes at most 32 MiB sample/evidence data; byte accounting is not an exact RSS ceiling.                     |
| Sparse index               | 8 MiB per snapshot                                               | Included in working-data accounting and the disk quota when persisted.                                         |
| Cached captures            | At most two                                                      | A current lease blocks eviction during its operation; admission can fail instead.                              |
| Work admission             | One active preparation or scan per server process; no queue      | A concurrent request receives a bounded busy refusal.                                                          |
| Lifetime                   | 15-minute idle expiry; 60-minute hard lifetime                   | Expiry ends reuse; a cursor does not pin a capture indefinitely.                                               |
| Deadline                   | 120 seconds for preparation and for each query                   | Cancel work and clean up; never return partial totals as complete.                                             |

Existing response, per-page, profile, group, metric-state, dense-pivot, distinct, exact-percentile
and 20-million aggregate cell-visit limits remain explicit. The resident two-million-cell
materialization limit cannot be blindly reused as an allocation strategy for streaming.
Diagnostics distinguish a page, a sample, a scanned prefix and a completed selected scope.
Full aggregates require a completed scan of that scope; a deadline or state-budget refusal
does not become a partial answer. Resident-cache coexistence must be included in admission
and memory measurement. A 512 MiB peak-RSS target for streaming acceptance workloads is a
proposed measurement target, not a guarantee for arbitrary mixed cached workbooks.

Acceptance requires independent CSV oracles across every chunk boundary of multibyte text,
escaped quotes, CRLF and embedded line breaks; late wider records and type contradictions;
mutation during capture and after publication; concurrent requests, cancellation, expiry,
eviction and restart; and measured memory and temporary-disk use on progressively larger files.
A bounded 16 MiB fixture must produce the same values through resident and streaming paths,
apart from explicitly documented sampling diagnostics. Native platform CI is required.
No streaming runtime code is part of the current work.

### Multiple-source analysis: execution owner to be decided

| Owner                      | Fit                                                       | Costs and constraints                                                                                                                                    |
| -------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reader MCP                 | Small, bounded joins under one configured filesystem root | Adds multi-file authorization, source lifetime and cardinality handling to the reader contract; unsuitable as an implicit extension of `aggregate_sheet` |
| Host-managed local worker  | Ad hoc joins of explicitly selected files or sheets       | Keeps a closed join plan and per-source approvals in the host; needs worker cancellation, memory limits and optional private spill storage               |
| Persisted semantic service | Repeated governed analysis over stable datasets           | Requires ingestion, refresh, ownership and storage policy; too much setup for an isolated workbook question                                              |

The recommendation is a host-managed local worker for ad hoc joins. The first closed contract
would support `inner` and `left`, with an explicitly authorized captured version for each
source, aliases, composite keys, per-source types and output columns. A key is a typed tuple,
not a delimiter-concatenated string. Identifier keys remain text unless explicitly typed.
Null keys do not match; unreadable keys have separate counts. No implicit trimming, case
folding, numeric conversion, currency conversion, fuzzy matching, executable cell content or
unrestricted SQL is allowed. Currency and unit compatibility must be checked before a typed
comparison is admitted.

The plan declares one-to-one, many-to-one or one-to-many cardinality. Unexpected duplicate keys
are refused; many-to-many is excluded from the first version. Count multiplicity before
materialization, using bounded arithmetic: a left join emits the left-key count multiplied
by the larger of the right-key count and one. Enforce build-side bytes, distinct keys, visited
cells, output rows and output bytes before emission. The first version has no spill path;
any later spill belongs to the same private-storage quota and cancellation contract.

Results preserve left-source order, then right-match order. Conflicting column names require
explicit aliases. Return both source versions and row provenance, distinct matched/unmatched
counts for each input, key-read failures and the output-row count; output rows are not a proxy
for matched input rows. Proposed first-worker limits are two sources, 100,000 distinct keys,
100,000 output rows, one million output cells, 64 MiB total serialized output and 128 MiB
accounted working data, with 512 KiB response pages, one active job and a 120-second deadline.
These are unimplemented candidate limits; every applicable limit must pass. Budget excess is
an explicit refusal, not silent truncation of a full analysis. The execution owner,
first-version cardinalities and operator budgets must be chosen before code or a new tool is
added.

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
