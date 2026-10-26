# Phase 5 implementation and verification plan

Status, 2026-10-26: F5-01–F5-07 implementation and local acceptance are complete. The [implementation status](implementation-status.md) records the final evidence and the remaining remote native gate before release. Starting vendor revision: `71066444b21c514d80e3e9188317d18c0d2ad17d`. Retain unrelated workspace changes.

Phase 5 lets an agent deliver a formatted workbook containing real Excel tables and formulas. It extends the current writing mode and immutable editor. Server-side calculation remains [Phase 6](../phase-6/README.md); charts, pivots and conditional-format authoring remain [Phase 7](../phase-7/README.md).

## Recorded decisions

The user resolved these A-09 choices on 2026-10-26:

- Merging occupied cells refuses by default. An explicit destructive merge may retain the top-left cell and clear the other cells' contents. A general overwrite flag alone does not authorize this loss.
- Formula authoring and copying include table and column names: `SUM(Sales[Amount])` and row-context formulas are in scope alongside ordinary A1 references. Adding a sales record must expand the table reference's scope. Dynamic arrays and external-workbook links remain outside new authoring support.
- Table operations include creation, growth, shrinkage and conversion to an ordinary range. Preserve the totals row where applicable. Occupied expansion targets and deletion of values require explicit intent.
- The planning turn established this plan before implementation. The user authorized the subsequent phase's tests and actual-model trials without repeated permission prompts. Use public fixtures and the configured model target; credentials and private product inputs do not enter committed evidence.

Existing K1-01–K1-09 decisions remain binding: explicit value types, literal text without inference, writing separately enabled, unchanged source/retained versions, exact selected versions, atomic dependent jobs and explicit independent-job partial results. Formulas are written, not calculated.

No further user decision blocks this plan. Internal schema names and numerical budgets are implementation decisions, settled against compatibility and measurements rather than sent back as product questions.

## Previous phases and carryovers

[Phase 3](../phase-3/implementation-plan.md) closes external `.xlsx` preservation editing and required formula/formatting copy. [Phase 4](../phase-4/implementation-plan.md) closes F4-01–F4-09, including dependent publication and independent-job recovery. Their recorded acceptance is historical evidence, not acceptance of the changed Phase 5 runtime.

| Origin      | Work entering Phase 5                                                                                                  | Owner and acceptance                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phases 0–1  | Add explicit formula intent while retaining literal `=SUM(A1:A2)` text and scalar/date semantics.                      | P5-01/P5-07: typed contracts and raw-cell assertions; never infer a formula from a text value.                                                                                                   |
| Phases 1–3  | Continue editing a newly formatted/formula-bearing version without dropping its new features.                          | P5-02/P5-09: create → format → write values → transfer → bulk edit → retained-version branch. Test the canonical fast path as well as preserved editing.                                         |
| Phases 2–3  | Existing copy/move/structural operations must handle features authored in this phase.                                  | P5-03–P5-08: same/cross-workbook style copying, structured references, renamed sheets/tables/columns and row/column edits; unsupported affected dependencies refuse atomically.                  |
| Phase 3     | Preserve correct formula-cache and calculation-chain policy.                                                           | P5-07: writing formulas invalidates stale caches; pure appearance changes retain valid saved results; receipts distinguish both.                                                                 |
| Phase 4     | Remove the current totals-row resizing limitation for the newly supported table profile.                               | P5-08/P5-09: `format/bulk-table.ts` currently refuses resizing tables with totals. Replace the isolated logic with the shared table editor and prove append/upsert/replacement/removal behavior. |
| Phase 4     | Data preparation and appearance/formula changes belonging to one report need one completion boundary.                  | P5-09: validate and finish each output in memory before the existing atomic publisher commits the group. A failure in the final formatting/formula step exposes no completed dependent output.   |
| Every phase | Re-run resource, corpus, actual-model, application, native and installed-package acceptance against the final runtime. | P5-10–P5-12: exact source/build identities and distinct passed/failed/skipped/interrupted results.                                                                                               |

Publication and private consumer rollout remain separate from capability implementation. They are not missing F5 features. Phase 2 transpose, macro-enabled/encrypted/protected editing, a calculation engine and advanced presentation authoring do not enter this phase as carryovers.

## Support contract

### Values and number formats

F5-01 changes presentation without changing the stored scalar. Initial formats cover general/text, integer/decimal, grouped numbers, explicit-currency display, percentages, dates, datetimes and times/durations. Include bounded custom number-format codes with a documented supported profile; preserve untouched existing codes.

Formatting `0.15` as a percentage leaves the stored value `0.15`. Formatting a money column does not convert currencies. Formatting text `00123` does not turn it into a number. Date/time presentation respects the source date system and existing Phase 1 date meaning; no timezone or date parsing is inferred from appearance. Independent assertions inspect OOXML values/types as well as display: reader date interpretation alone cannot establish unchanged storage.

### Cell appearance

F5-02 includes font family/size, bold/italic/underline/strike, foreground/background color, basic fills, per-side borders, horizontal/vertical alignment and wrapping. Public inputs use explicit colors and validated enums. Existing theme/indexed colors and unrelated style fields survive patches; a font patch does not reset a number format or border.

Define omission, set and explicit reset separately. Deduplicate equivalent style components and cell formats deterministically. Keep existing indices stable where possible; never mutate a shared style in place and accidentally restyle unrelated cells. Bound style growth, format-code bytes and touched cells before expansion. Exact limits are recorded in P5-01 and verified in P5-10.

### Sheet layout

F5-03 includes explicit column widths and row heights, frozen row/column panes, row/column/sheet visibility, and basic print setup: orientation, paper choice, margins, print area, repeating title rows/columns and fit-to-page settings. Specify units and mutually exclusive print options. Do not claim font-measured automatic sizing without an actual measurement implementation.

Preserve selections, views and unrelated page settings. Keep at least one visible sheet and valid active/selected sheet references. Structural row/column edits transform panes, print names and layout ranges together. Repeated operations replace the intended setting instead of appending duplicate XML elements.

### Merged ranges

F5-04 includes merge and unmerge. A merge must be one bounded rectangle, must not overlap another merge or an Excel table, and must respect existing array/spill and preservation guards. Blank cells are distinguished from empty text, zero, false and formulas when checking loss.

Default: reject a merge with content outside its top-left cell. Explicit destructive mode clears exactly the non-anchor contents and reports the loss count in preparation and receipt; preserve unrelated formatting and outside cells. Unmerge retains the anchor value and does not invent copies in the newly independent cells. Copy/move and row/column operations continue to update whole merged regions or refuse partial unsupported edits.

### Formula syntax and references

F5-06 introduces dedicated formula edit operations, including bounded block writes and fill from an anchor over a target range. Keep scalar `WriteCell` semantics used by transfers, keys and bulk datasets intact; do not widen them so that ordinary CSV text becomes executable formula input.

Support scalar expressions, function calls, constants, operators, ordinary A1 cells/ranges/full axes, mixed and absolute references, quoted/Unicode sheet names, supported existing local defined names, and table structured references. Initial acceptance includes `SUM`, `AVERAGE`, `COUNT`, `MIN`, `MAX`, `IF`, `IFERROR`, `ROUND`, conditional sums/counts and `SUBTOTAL`. This is a syntax/reference contract, not an evaluation guarantee for those functions.

Specify the stored formula convention and normalize an optional leading `=` only at the explicit formula boundary. Formula text uses Excel's file syntax; an agent translates a Turkish request to that syntax without rewriting text literals or named columns. Validate bounds, tokenization and the documented grammar; malformed or unsupported input gets a specific refusal. Do not execute formulas or access their named resources on the server.

Reuse and extend `format/formula-edit.ts`. Copy/fill, move and structural edits have separate reference semantics. Never rewrite references by substituting digits in text. Formula string literals, dollar signs, quoted sheet names, range boundaries and out-of-grid references have fixed known-answer cases.

Structured references cover table-qualified columns, row context, supported column spans and header/data/totals selectors. Resolve table/column identity from the package and validate escaped names. Pin both vertical and horizontal copy/fill behavior; do not assume that all structured references are ordinary A1 offsets or that every copy operation has identical semantics. Table/column renaming updates supported dependent formulas and names throughout the workbook. Cross-workbook copies import or map dependencies explicitly, or refuse; they never silently bind to an unrelated same-named table.

New dynamic/spill arrays, legacy array-formula authoring, external-workbook links, 3D references, opaque extension formula syntax and newly authored named functions are outside this initial profile. Preserve existing unsupported formulas where unaffected; refuse operations that would require unsupported rewriting. Existing protection policy still applies.

### Formula result state

F5-07 keeps formula text, a saved cached scalar, absence of a saved result and a saved error distinct. Extend existing reader notes and receipts additively, with bounded summaries rather than a cell dump. Reuse `recalculated: false`, `recalculationRequired`, `cachedFormulaValues` and `refreshRequired` instead of introducing conflicting truth sources.

New/changed formulas have no fabricated cached result. Never emit a zero or an empty-string cache as a substitute for not calculated. Invalidate stale dependent caches and calculation-chain relationships/content types using the existing conservative policy, and set the appropriate workbook recalculation flags. A saved error is reported as a saved error, not a server calculation failure. Formatting-only changes must not unnecessarily claim recalculation or erase an otherwise valid cache.

Application tests may calculate a separate copy. Their resulting numbers verify interoperability; they do not retroactively turn the server's output into a calculated workbook. Model-facing responses must state when Excel or another spreadsheet application still needs to calculate.

### Excel tables

F5-05 includes create, rename, column-header changes, resize/append, totals controls, supported table style/options, filter-dropdown controls and convert-to-range. Validate unique table IDs/names, nonempty unique headers, dimensions, relationships, content types and nonoverlap with tables/merges. Do not silently repair or rename invalid headers. Table-level style and direct cell formatting retain their separate precedence.

Define header, data body and totals extents separately, including zero data rows. Growth checks all destination content before moving a totals row; it cannot overwrite neighboring data silently. Preserve or propagate supported calculated-column formulas, totals formulas and number formats to the intended new records. Formula propagation does not calculate their values.

Shrinking a table changes its membership; it preserves excluded cell contents unless an explicit clear is requested. Phase 4 whole-list replacement retains its existing rule: clear the old selected list tail, keep formatting and outside content. These are distinct intents. Moving or removing a totals row must neither duplicate it nor leave a misleading stale total inside the new data body.

Creating filter dropdowns does not filter/delete the dataset or claim that rows were recalculated as hidden. Preserve supported existing saved filter state; when a structural change invalidates it, transform it correctly or refuse with a specific reason. New advanced filter-expression authoring is outside the initial table controls; Phase 4 dataset filtering remains available.

Converting to an ordinary range preserves values, formulas and supported effective formatting. Replace affected supported structured references with equivalent ordinary references, materialize supported table styling where needed, and remove only the table-owned relationships/content types/parts. Unsupported affected dependencies or table-style materialization refuse the complete request. Never leave formulas pointing to a deleted table name.

## Architecture and concrete owners

Extend the existing package. No new server, runtime spreadsheet engine or private dependency is needed. OOXML-specific logic belongs in excel-mcp; `ooxml-core` remains format-neutral and `file-core` remains format-neutral filesystem machinery.

| Owner                                                                             | Change                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/authoring/edit.ts`, `workbook.ts` and new topic-specific authoring schemas   | Strict discriminated operations for appearance, layout, merge, formulas and tables; inferred types and bounds. Keep bulk scalar input separate.                                                                                                      |
| `src/tools/edit-schemas.ts`, `writing.ts`                                         | Extend `prepare_edit`/`edit_workbook`; keep model-discoverable flat operation fields and specific refusal advice. Extend `create_workbook` with optional ordered finishing changes so a new report can be published once. Preserve current defaults. |
| `src/format/preserved-workbook.ts`, `xml-edit.ts`, `edit-inspection.ts`           | Reuse package preservation, validation and ordered changes; add focused format/style/layout/table modules rather than putting every new concern into the already large editor.                                                                       |
| `src/format/authoring.ts`, `edit-workbook.ts`                                     | Make new workbooks and later scalar edits retain newly authored state. The current canonical fast path supports only a narrow authored package; explicitly guard eligibility or route through preservation once richer features exist.               |
| `src/format/formula-edit.ts`                                                      | One reference tokenizer/mapper shared by formula write/fill, copy/move, table identity changes and structural edits. No independent bulk-only parser.                                                                                                |
| `src/format/bulk-table.ts`, `src/tools/bulk-output.ts`, bulk job schemas/executor | Share the table editor; apply bounded output-local finishing changes before existing atomic publication. Resolve them against the declared intermediate output, not a stale pre-edit sheet.                                                          |
| `src/platform/versions.ts`, `src/grid/cell-value.ts` and reader metadata          | Additive receipts and bounded result-state reporting. Preserve current versioning, default reads and response budgets.                                                                                                                               |
| `packages/lab/excel-lab`                                                          | Extend existing corpus, independent oracle, scale and writing-aware model harnesses; no production import from this private package.                                                                                                                 |

Preparation executes the same pure transformations and bounds as execution, returning the selected source versions, request fingerprint, bounded effects/loss counts and specific blockers. It remains read-only. Execution rechecks every selected source and publishes only after all operations succeed. No arbitrary filesystem path or network capability is added.

Keep existing 1,000,000-cell, 64-sheet, 128-operation, 32 MiB text and 64 MiB input limits unless a measured change explicitly revises them. Also bound newly styled/materialized cells, unique style components, formula count/text/tokens, table count/columns and expanded finishing operations. Sparse style ranges can create stored cells; charge their expansion before allocating or serializing. Formatting an entire empty worksheet is not a free operation.

## Ordered implementation sequence

Each step ends with its focused checks and evidence before the next dependent step. Existing authoring, transfer and bulk interfaces keep working throughout.

| Step  | Deliverable and files                                                                                                           | Acceptance before advancing                                                                                                                                                                                      | Depends on        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| P5-00 | This plan, source/corpus inventory, carryover audit and Phase 0–4 baseline.                                                     | Record exact revision, user decisions, current corpus counts and actual command outcomes. No Phase 5 implementation claim.                                                                                       | None              |
| P5-01 | Finalize support matrix, strict schemas, operation ordering, error/result variants and bounds in `authoring/` and wire schemas. | Fixed accepted/rejected MCP payloads; formula/text separation; explicit merge loss; model-visible fields; existing read/write catalogs unchanged by default.                                                     | P5-00             |
| P5-02 | Shared editor dispatch, style/part allocation and new-workbook finishing path; guard canonical-path eligibility.                | Repeated styles deduplicate, unknown untouched XML survives, missing style part is created safely, richer versions survive a later scalar edit, late failure publishes nothing.                                  | P5-01             |
| P5-03 | Number formats and cell appearance.                                                                                             | Raw scalar/type invariants; style patch/reset/precedence; appearance-only formula caches; mixed existing/theme/date styles; same/cross-workbook formatting copy.                                                 | P5-02             |
| P5-04 | Dimensions, panes, visibility and print settings.                                                                               | Valid units/options; print names, active-sheet rules and XML ordering; repeated updates; insert/delete/copy/rename interaction.                                                                                  | P5-02             |
| P5-05 | Merge/unmerge and explicit loss reporting.                                                                                      | Occupied defaults; explicit anchor-only retention; empty-text/zero/false/formula cases; merge/table/array conflicts; structural/copy interaction.                                                                | P5-02             |
| P5-06 | Extend the shared reference engine for supported structured references.                                                         | Independent known-answer text for A1/mixed/absolute/Unicode/quoted names, row context, escaped column names, horizontal/vertical fill, table/column renames and explicit unsupported cases.                      | P5-01/P5-02       |
| P5-07 | Formula write/block/fill, stale-cache policy and reader/receipt state.                                                          | Real `<f>` versus literal text, no fabricated `<v>`, retained saved error versus missing result, `calcPr`/chain cleanup, copy/move/structural semantics and bounded responses.                                   | P5-03/P5-06       |
| P5-08 | Shared table editor: create, names/headers, resize/append, styles/filters/totals, convert-to-range.                             | Zero/one/many rows; totals move exactly once; new records join column-name formulas; safe shrink/clear; conversion rewrites references and retains supported appearance; valid OPC graph.                        | P5-03/P5-05/P5-07 |
| P5-09 | Integrate authoring with Phase 4 outputs and multi-call continuation.                                                           | Atomic data+formula+style reports; 9/10 independent completion and failed-only retry; response loss/restart/concurrent retry; actual total-table append/upsert/replace/remove; no duplicate data or lost styles. | P5-04–P5-08       |
| P5-10 | Extend excel-lab with authoring cases, corpus selection, independent Python oracle, application checks and resource benchmarks. | Known-answer oracle controls first; selected real `.xlsx` mutations and explicit refusals; scale/unique-style/formula/table stress; hashes and all generated files outside the repository.                       | P5-09             |
| P5-11 | Scripted and actual-model authoring acceptance in Turkish and English.                                                          | Complete emitted files and receipts pass independent grading; no acceptance from prose, preparation alone or a preliminary unformatted version. Record failures and attempts.                                    | P5-10             |
| P5-12 | Final combined regression, generated reference/examples, native/installed-package acceptance and completion record.             | Final build/types/lint/corpus/model/application/native/tarball evidence refers to the same runtime. Every F5 requirement has an owner and passing acceptance; skips stay explicit.                               | P5-11             |

Start coding with P5-01, then P5-02. Build the appearance and reference foundations before tables so table authoring does not create a second style or formula implementation. Production changes remain scoped to this public MCP repository; publication and product rollout have their own handover.

## Test and corpus reuse

### Existing owners

- `test/write-foundation.spec.ts`, `transfer-data.spec.ts`, `edit-preparation.spec.ts` and `preserved-edit.spec.ts`: extend the owner tables for literal/formula intent, continuation, style preservation, preparation/execution agreement and atomic refusal.
- `test/bulk-preparation.spec.ts`, `bulk-jobs.spec.ts`, `bulk-corpus.spec.ts`: extend for formatted/formula-bearing outputs, total-row tables and complete-group failure/retry. Do not duplicate the existing publisher's filesystem suite unless a new boundary introduces a distinct risk.
- `test/tool-schema.spec.ts`: actual MCP catalog, directly discoverable operation fields and strict kind-specific inputs. `test/bulk-jobs.spec.ts` separately caps each advertised `prepare_bulk_job`/`run_bulk_job` tool at 40,000 bytes. Retain that per-tool cap and measure the complete authoring catalog as well; do not silently raise budgets for new operations.
- `test/corpus-cells-parity.spec.ts`, `corpus-csv-parity.spec.ts`, table/formula/number-format reader suites and the existing excel-lab suite remain regression gates. Add a dedicated authoring test owner only for a contract absent from these boundaries.
- `scripts/inspect-edit-corpus.py` and its known-answer tests: reuse independent feature inventory and hash/containment checks to select editable, preservable and explicitly blocked workbooks.
- `scripts/verify-written-workbook.py`, `edit-oracle.py`, `edit-agent-oracle.py`, `bulk-oracle.py` and `transfer-oracle.py`: reuse independent ZIP/XML/type/version checks; extend where their contract owns the new case.
- `scripts/openxml-validate/`, `edit-lo-oracle.py` and `bulk-application-oracle.py`: reuse Microsoft Open XML SDK validation and isolated real LibreOffice checks. These are lab dependencies, never a runtime fallback or a server calculation engine.
- `src/edit-bench.ts`, `bulk-bench.ts`, `edit-agent-cli.ts`, `bulk-agent-cli.ts` and `src/agent/`: reuse transports, host identity, call budgets, scripts, traces and grading. Add an authoring scenario profile/entrypoint without cloning the whole runner.

Use the discovered TypeScript/type-discipline, test-audit and vendor Turborepo guidance. Each new test identifies an observable contract, a credible regression, the missing coverage and an independent expected value. No test-only production export or implementation snapshot is needed. The user's run authorization already covers these phase checks; use narrow runs during development and serialize expensive final runs on this machine.

### Corpus and independent evidence

The local manifest inventory on 2026-10-26 has 22 manifests and 7,853 entries: 947 `.xlsx`, four `.xlsm` and 3,983 CSV entries among other formats, with no malformed JSON entries. The Phase 4 record's 945 `.xlsx` count is historical. These are manifest counts, not claims that files exist, pass hashes, can be edited or support Phase 5. Verify selected bytes against manifest hashes before using them.

Supply the discovered local root through `SEZZLEE_CORPUS`; machine-specific paths stay in local evidence. Never overwrite originals or commit restricted corpus files/derived outputs. `.xlsm` remains read/refusal coverage. CSV participates through explicit scalar transfer and read regression; appearance/table/formula editing targets `.xlsx`.

Select existing real files covering styled and unstyled cells, theme/custom formats, both date systems, existing tables/totals, merged regions, formulas/names, views/print settings and opaque unrelated parts. Add deterministic public synthetic fixtures for combinations the corpus does not supply. Record each selection's source, license, hash, observed features, expected operation and supported/refused outcome. Discovery counts do not become an edit-success percentage.

The independent oracle must check exact cells/formulas/types, style component references and effective supported styles, dimensions/panes/print names, merge/table extents, totals/filter metadata, OPC relationships/content types and source/retained hashes. Expected values/reference text come from fixed documented examples or externally authored fixtures, never the production mapper. Add negative controls that deliberately corrupt a formula, style link, table extent, cache or source and prove that the oracle rejects each intended fault.

Use selected Open XML SDK validation for schema/package errors. Use an isolated spreadsheet application on copies for formulas, table interoperability, displayed number formats and layout; retain rendered PDF/screenshots for representative visual checks. A successful opening or conversion alone is insufficient. Distinguish saved XML assertions, actual application observations and visual inspection. If native Microsoft Excel is unavailable, record that limit; Calc acceptance does not claim an Excel UI run.

### Scale and resource cases

Measure, at minimum, a 50,000 × 20 one-style range within the current one-million-cell budget, repeated equivalent style patches, adversarial unique styles, formula fills, table growth/shrink with totals, and a data+formula+style dependent group. Include blank-range materialization, formula/text bytes, table count/width and exact guard boundaries. Use isolated bounded children and the existing watchdog/RSS infrastructure; heap and RSS are separate.

Record source/build/native identities, request/catalog/receipt bytes, call count, preparation/execution/retry time, peak RSS, stored-cell/style/formula counts, source hashes and refusal reasons. Same input/version/normalized operations must have deterministic retained-output behavior. A resource refusal is valid only when explicit and atomic; it is not a throughput success.

## Agent acceptance scenarios

Run deterministic scripted baselines first, then actual-model TR/EN trials against the configured host using public pinned fixtures. Reuse the existing model configuration or resolve the preceding successful trial's identity from local evidence; do not select an unrelated external host. Keep the reader lab intact. Start with these end-to-end tasks:

| Scenario                 | User intent and independently graded result                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expense report           | Format dates, money and percentages; highlight headers, wrap descriptions, size columns, freeze the header and set a printable area. Stored scalars and unrelated content stay intact.        |
| Merge decision           | Reject an unsafe occupied merge; a separate explicit-loss request keeps only the anchor contents and reports the exact loss scope.                                                            |
| Ordinary formulas        | Fill quantity × price with mixed/absolute tax references and a quoted other-sheet reference; literal text beginning with `=` stays literal. Report that new results are not calculated.       |
| Sales table              | Create a named table, add a calculated column and totals, append records, and verify that a column-name total includes the new table extent.                                                  |
| Table lifecycle          | Rename a referenced column/table, shrink with safe tail behavior, then convert a retained version to a range; formulas and supported effective appearance remain correct.                     |
| Atomic final report      | Produce multiple related data+formula+style outputs; force a final unsupported operation, verify no completed group, repair, retry and retrieve durable completion without duplicate records. |
| Independent reports      | One report fails, others remain completed; retry only the failed report with explicit overall partial/complete status.                                                                        |
| Unsupported request      | Refuse new external links/dynamic arrays or unsupported affected preservation without publishing a degraded output.                                                                           |
| Continuation and restore | Add values and transfer/bulk results to a newly styled version, then branch from an older retained version. Verify hashes, formulas, tables, layout and appearance.                           |

Run the supported scenario/language matrix at least once on the final runtime. Repeat representative formula/table/atomic scenarios to observe variation. Record model/host identity, build digests, parameters, tool catalog, all attempts and grader results. A timeout, interrupted run, no-tool answer, wrong target, missing formatting or false calculation claim is not a pass. Attribute failures to tool contract, implementation, harness or model and fix the owning layer; do not hide unsuccessful trials behind a later success.

## Commands and completion gates

Run package tasks through Turbo from the vendor repository root. Start focused, then run the final combined suite with the corpus configured. Do not pass Vitest file arguments to build/lint/type tasks.

```sh
pnpm turbo run build check-types lint --filter=@sezzlee/excel-mcp --filter=@sezzlee/excel-lab
SEZZLEE_CORPUS=/path/to/corpus pnpm turbo run test --filter=@sezzlee/excel-mcp --concurrency=1 --ui=stream -- --maxWorkers=1
pnpm turbo run test --filter=@sezzlee/excel-lab --concurrency=1 --ui=stream -- --maxWorkers=1
python3 -I packages/lab/excel-lab/scripts/test-inspect-edit-corpus.py
python3 -I packages/lab/excel-lab/scripts/test-authoring-oracle.py
python3 -I packages/lab/excel-lab/scripts/test-bulk-oracles.py
git diff --check
```

The existing runners now include the authoring cases. Omit `--model` for deterministic scripted baselines; supplying it runs those baselines before actual TR/EN trials. Set `SEZZLEE_AGENT_LAB_OLLAMA_URL` to the configured host, retain its model digest and use a fresh output directory for each run. Named thinking levels require a host/model that advertises them; omission preserves the host default. The optional `--final-think false` switches thinking only after the independent file oracle passes; it retains the same messages and available tools. Both phases' parameters remain in the manifest and per-request trace.

```sh
node packages/lab/excel-lab/src/edit-agent-cli.ts --out /tmp/excel-phase5-agent --corpus /path/to/corpus --model qwen3.8:latest --think low --final-think false --languages tr,en --only authoring_format,authoring_formula,authoring_table,authoring_lifecycle,authoring_continuation,authoring_merge,authoring_unsupported
node packages/lab/excel-lab/src/bulk-agent-cli.ts --out /tmp/excel-phase5-bulk-agent --model qwen3.8:latest --think low --languages tr,en --only report,independent_report
python3 -I packages/lab/excel-lab/scripts/authoring-application-oracle.py /tmp/excel-phase5-agent
```

Bind final scripted/model/application outputs and selected corpus results to the same runtime. Reuse the repository CI planner/native matrix and installed-tarball smoke tests for affected packages: Linux x64/arm64, macOS x64/arm64 and Windows x64 on Node 22/24 where the current matrix requires them. A changed generic publication primitive additionally needs its existing crash/concurrency gate; do not redesign that primitive merely to add formatting.

Regenerate public reference material through the existing generator from actual registered contracts and validate examples against the server. Re-read `apps/docs/CLAUDE.md` before touching the public docs application. Source documentation/reference generation and live-site deployment are distinct outcomes.

### Planning baseline

The initial combined whole-suite attempt with the local corpus did not return a usable result before the tool's 300-second deadline. No passing total is claimed, and a process check found no remaining test/Turbo child from that attempt. The full configured corpus suite remains an explicit P5-00/P5-12 gate with a suitable execution time window; this timeout is not evidence of a product failure.

The following planning checks completed against the unchanged runtime:

| Check                                                                   | Actual outcome                                                                                     |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Configured writer/transfer/edit/bulk/corpus-integration/schema baseline | Eight files, 190 tests passed, no skips; exit 0, 31 seconds wall time including dependency builds. |
| Existing excel-lab regression                                           | 13 files, 112 tests passed, no skips; exit 0, seven seconds including dependency builds.           |
| Independent edit-corpus scanner known answers                           | Eight Python tests passed; exit 0.                                                                 |
| Independent bulk-oracle known answers                                   | Five Python tests passed; exit 0.                                                                  |
| Documentation checks                                                    | F5-01–F5-07 and P5-00–P5-12 present; local Markdown links resolve; `git diff --check` passes.      |

The focused baseline command was:

```sh
SEZZLEE_CORPUS=/path/to/corpus pnpm turbo run test --filter=@sezzlee/excel-mcp --ui=stream -- test/write-foundation.spec.ts test/transfer-data.spec.ts test/edit-preparation.spec.ts test/preserved-edit.spec.ts test/bulk-preparation.spec.ts test/bulk-jobs.spec.ts test/bulk-corpus.spec.ts test/tool-schema.spec.ts --maxWorkers=1
```

The other completed commands are the lab, scanner and bulk-oracle commands above. These checks establish the focused existing baseline, not full-corpus parity or Phase 5 behavior. No Phase 5 actual-model, application/visual, scale or native/package acceptance was run during this planning turn. Only the three planning/index Markdown files changed in the vendor repository.

### Requirement completion checklist

- [x] F5-01: number/date/time/currency/percentage display verified without unintended scalar changes.
- [x] F5-02: bounded composable cell appearance, shared-style safety and supported copy behavior.
- [x] F5-03: dimensions, freeze panes, visibility and basic print layout verified independently.
- [x] F5-04: merge/unmerge, default refusal and explicitly authorized loss verified.
- [x] F5-05: table creation, identity/header changes, growth/shrink, totals, filters and conversion verified with existing bulk operations.
- [x] F5-06: explicit formula write/fill and ordinary/structured reference semantics verified across copy/move/structural edits.
- [x] F5-07: independent files, reads, receipts and reviewed final model answers pass across all 18 TR/EN cases, with exact replay evidence for unchanged editing observations.
- [x] Scripted and model multi-call continuation and data+appearance+formula group atomicity/recovery pass; unsuccessful trials remain retained.
- [x] Final local regression, configured corpus, independent oracles, application/visual, model/replay, resource and installed-package gates have explicit results and immutable evidence identities.
- [ ] The remaining remote native platform matrix on Node 22/24 passes before release.
- [x] Documentation describes actual support and refusals; publication and consumer rollout remain separately tracked.
