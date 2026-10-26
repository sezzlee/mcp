# Phase 4 implementation and verification plan

Status, 2026-10-26: P4-00–P4-10 are complete. F4-01–F4-09 have executable behavior, independent acceptance and closed regression/model/platform/package gates. prepare_bulk_job, run_bulk_job and get_bulk_job validate, execute, atomically publish and recover complete groups or independent batches. The original prepare_bulk remains focused key analysis. The final runtime revision is `424015b7708e53303ce6b0654c761a582b2b375a`; the [full CI gate](https://github.com/sezzlee/mcp/actions/runs/40314833068) passed all 15 jobs. The starting vendor revision was `2dd2a37464dab05d66a4e3c9d8f90b3a78724e76`. Publication and consumer rollout remain separate.

## Recorded user decisions

Resolved with the user on 2026-10-26:

- Keys preserve value type and letter case. Text `0012`, text `12` and number `12` are distinct; `abc` and `ABC` are distinct. Normalization requires an explicit transformation.
- Missing or duplicate keys block keyed update/join by default. Never silently choose a first/last match. An explicitly selected resolution rule may permit continuation.
- Replacing a 100-record list with 80 records clears the remaining 20 records' values within the selected old list extent. Preserve formatting and content outside that extent. Physical worksheet-row deletion is a separate explicit operation.

Already binding: preserve all sources and retained versions; require explicit overwrite for occupied targets; changed sources require preparation again; select all matching records unless a subset is explicit; reject unsupported preservation instead of silently degrading. Related changes must finish together; independent jobs may report partial success. Undo selects retained versions. New formula/style authoring remains Phase 5 and calculation remains Phase 6.

## Previous-phase carryovers

| Origin    | Work entering Phase 4                        | Owner and acceptance                                                                                                             |
| --------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Phase 2/3 | Conditional bulk updates and removals        | P4-03: complete bounded selections, explicit removal mode, outside-selection preservation.                                       |
| Phase 2/3 | Keyed updates, insert-if-missing and joins   | P4-04/P4-06: typed composite keys, missing/duplicate conflicts, explicit unmatched/cardinality rules.                            |
| Phase 2/3 | Whole-list replacement                       | P4-05: clear the complete old tail without erasing formatting or neighboring content.                                            |
| Phase 0/3 | More than one output in a logical job        | P4-02/P4-08: preparation/publication separation, durable completion and recoverable retry; one-file publication is insufficient. |
| Phase 3   | Ordered operations can change later targets  | P4-02/P4-03: define snapshot versus intermediate-result references and resolve each step against its declared input.             |
| Phase 1–3 | Resource limits and independent verification | P4-09/P4-10: extend existing lab machinery to the final combined implementation; historical success is not Phase 4 acceptance.   |

Closed work is not carried over: Phase 3 implements external `.xlsx` preservation editing and required formula/formatting copy. The Phase 3 plan records completed native/installed-package acceptance and publication. Consumer rollout remains a separate operation, not a missing Phase 4 data feature.

Phase 2 transpose was explicitly not added implicitly. It is not an additional Phase 4 requirement. Macro-enabled/encrypted/protected editing and new formula/style authoring do not enter this phase through bulk operations.

## Boundaries and reuse

Keep generic implementation inside this public repository. No product-specific data, imports or orchestration belongs here. No new server package or private runtime dependency is needed.

- `src/tools/transfer-schemas.ts`, `transfer.ts`: reuse version-pinned source selections, complete record materialization, typed reading hints, visibility provenance and target mapping. Reader response pagination must not truncate a bulk selection.
- `src/authoring/values.ts`, `workbook.ts`, `edit.ts`: reuse explicit cell types, authoring budgets and ordered change contracts. Derive types from schemas; use discriminated unions for operations and outcomes.
- `src/format/edit-workbook.ts` and preservation machinery: apply existing-workbook changes without reconstructing worksheets from reader presentation data. Preserve supported dependencies or refuse the complete request.
- `src/platform/versions.ts`, output capability and `src/tools/writing.ts`: retain source validation, safe output roots, writing gate, deterministic versions, concurrency/cancellation and sanctioned response constructors. Audit publication primitives before designing multi-output completion.
- `packages/lab/excel-lab`: extend existing acceptance, corpus, independent oracle, scale and agent harnesses. Published code never imports this private package.

Existing authoring limits are 1,000,000 cells, 64 sheets, 128 operations, 32 MiB text and 64 MiB input. They are not a measured promise for joins or multi-output jobs. Add explicit bounds for source count, indexed keys, intermediate cells/bytes, join expansion, conflicts and job outputs; enforce them during preparation and execution. Do not silently raise existing limits.

## Data semantics

### Selection and comparison

Every input names an exact source version and an explicit sheet/table/range with header rules. A target list has an explicit old extent; do not guess it from worksheet dimensions or the last nonblank cell. Duplicate/ambiguous headers require explicit mapping.

Reuse existing conditions where their semantics fit. Key identity is a separate contract: no implicit trim, Unicode normalization, number parsing, date parsing or case folding. Composite keys encode both types and component boundaries, avoiding concatenation collisions. Blank cells and empty text are missing keys; whitespace-only text stays literal unless explicitly normalized. Error cells cannot become a valid key. Typed dates and datetimes remain distinct from text and numbers; canonicalize equivalent datetime precision without assuming a timezone.

Conditions distinguish blank, empty text, zero, false and error. Invalid coercion, absent columns or unsupported formula caches must not silently produce a partial selection. Existing saved-hidden-row semantics remain explicit; filtering to a new dataset does not hide or delete source rows.

### Updates, removals and replacement

- Update only selected columns of matching rows. Preserve other fields and content. Report equal-value assignments as unchanged.
- Removal requires a mode: clear selected record contents while retaining formatting, or physically delete worksheet rows. Physical deletion must pass Phase 3 dependency checks and account for row shifts; it cannot erase neighboring data merely because it shares the same worksheet row.
- Keyed update distinguishes update-only from upsert. Missing target keys are reported for update-only; upsert appends once in source order to the declared list, with collision and expansion checks.
- Replacement validates headers/types, new extent, occupied expansion and old-tail clearing before publishing. Clearing the tail preserves formatting, does not shift cells and updates supported table metadata coherently. Unsupported impacted tables/dependencies block the request.
- Operations overwriting formulas require the existing explicit overwrite contract. Value pipelines report saved formula-cache use and never claim recalculation. Sort/join/projection must either preserve affected formula meaning under a supported explicit mode or refuse; never silently flatten a formula-preserving edit to values.

### Dataset operations

- Append inputs in declared source order. Require explicit column mapping for schema differences and explicit typed blank filling for absent fields; no automatic widening or coercion.
- Joins require an explicit kind (`inner`, `left`, `full`) and key columns. Default cardinality is one-to-one. Missing/duplicate keys block by default. First/last resolution requires explicit selection and stable input order. Many-to-many expansion requires explicit permission and a hard pre-publication bound. Column-name collisions require mapping/prefixes.
- Deduplication reports duplicate groups before removal; removal requires explicit keep-first, keep-last or drop-all-duplicates policy and declared keys. This intentional deduplication rule does not weaken keyed join/update defaults.
- Sort is stable, with explicit direction and blank placement; preserve input order for ties. Use deterministic typed comparison, not machine locale. Locale-sensitive collation requires an explicit locale. Mixed-type ordering requires an explicit policy or refusal.
- Projection/rename/reorder cannot create duplicate output columns. Initial transformations are a bounded declarative set: typed constants, trim, case conversion with explicit locale, and explicit text/number/date/datetime conversion using existing reading semantics where applicable. Conversion errors block by default; any requested per-record error policy must be explicit and counted. No arbitrary JavaScript, spreadsheet formula evaluation or new formula/style authoring.

## Job, publication and retry contract

Preparation is read-only: inspect every source/target, validate the complete ordered plan and bounds, return exact source versions, a normalized request fingerprint, bounded effects/conflicts and ready/blocked status. Revalidate at execution. A fingerprint is not authorization and preparation is not completion.

Represent dependencies by stable step/output identifiers, not mutable sheet positions or guessed latest filenames. An input is either an original snapshot or an explicitly named previous step result. Same-target changes execute in declared order; independent jobs cannot race to modify a shared logical target.

For a dependent group, stage and validate every output before recording group completion. A failed group exposes no completed report and preserves originals and previous versions. A set of per-file renames is not an atomic multi-file transaction. P4-02 must establish a durable completion manifest/publication capability and a recovery rule, or a container-level atomic publication mechanism. Do not expose internal staged files as successful outputs; document filesystem discoverability and cleanup, not just MCP response visibility.

For independent jobs, each has its own completion boundary. Return completed outputs alongside explicit failed/blocked jobs and overall partial status. Retry only failed jobs; never reapply completed appends/upserts.

Persist enough completion information to recover after restart and after a lost response. Bind logical retry identity to source versions plus normalized operations and output policy; reject reuse with different inputs. An identical retry returns the prior completed result. Define stale-source versus recovery behavior: locating an already completed result must not accidentally rerun against changed source bytes. Cancellation, crashes before/after publication, manifest failure, collisions and concurrent retries need acceptance evidence.

Receipts are bounded: job/step identity, exact versions, completed/partial/failed state, matched/updated/inserted/removed/unchanged/unmatched/conflict counts, bounded row examples and explicit cache/recalculation/refresh facts. Define count populations per operation; joins may expand rows, so one global sum equation is invalid. No complete records or unbounded conflict/output lists in tool responses. Detailed diagnostics use a bounded retrievable artifact. Overall job completion is separate from one tool call's success.

## Ordered implementation sequence

Each row is a reviewable implementation slice. Complete its acceptance before moving to dependent work. Tests belong with the real production boundary; do not add unused production helpers solely for tests.

| Step  | Work and files                                                                                                                                                                                                                        | Required acceptance                                                                                                                                                                                                                      | Depends on  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| P4-00 | Record decisions, inspect carryovers, identify corpus and run Phase 0–3 baseline. This plan and phase index.                                                                                                                          | Exact revision, inventory counts, commands and passed/skipped results; no Phase 4 implementation claim.                                                                                                                                  | None        |
| P4-01 | Define bulk operation/preparation/receipt schemas, typed keys, conditions and budgets under `src/authoring/` and `src/tools/`; integrate the first preparation path into writing registration.                                        | Actual MCP preparation: typed/composite keys, empty/error keys, header conflicts, bounded diagnostics, read mode gate, no output, schema decoder compatibility.                                                                          | P4-00       |
| P4-02 | Separate pure bulk planning from execution/publication; implement source snapshots and ordered step references. Design and prove group completion/recovery on existing native/output primitives.                                      | Stale versions, invalid later step, shared-target conflicts, group publication failure and restart recovery. If current primitives cannot meet the contract, extend generic capabilities before claiming dependent multi-output support. | P4-01       |
| P4-03 | Conditional update/removal through complete selections and the preservation editor; wire prepare/execute through writing tools.                                                                                                       | Pending orders only; no-match and unchanged counts; explicit overwrite; clear versus physical deletion; shifting rows, outside data, formulas and late failure.                                                                          | P4-02       |
| P4-04 | Keyed update and upsert using one typed-key implementation.                                                                                                                                                                           | Composite/type/case distinctions; missing/duplicate conflicts on both sides; explicit resolution; unmatched update-only; upsert replay creates no duplicate.                                                                             | P4-03       |
| P4-05 | Replace an explicitly bounded list.                                                                                                                                                                                                   | 100→80 leaves no stale 20 records; 80→100 expansion collision; empty replacement; headers/table extents/formats/neighbors and immutable sources.                                                                                         | P4-03       |
| P4-06 | Append and keyed joins across sheets/files.                                                                                                                                                                                           | Declared order, missing/extra columns, all join kinds, unmatched rows, duplicate/empty keys, column collisions and bounded many-to-many expansion.                                                                                       | P4-04       |
| P4-07 | Stable sorting, filtered outputs, deduplication, projection/rename/reorder and declarative transformations.                                                                                                                           | Fixed known-answer records; ties, blanks, mixed types, Turkish case examples, invalid conversion and preservation/refusal behavior.                                                                                                      | P4-06       |
| P4-08 | Expose dependent groups and independent job batches; complete durable status/retry and bounded receipts. Finalize minimal model-facing tools in `writing.ts`; extend current prepare/execute style rather than one tool per operator. | Related report failure yields no completed group; 9/10 independent outputs yield partial; retry failed-only; lost response/restart/concurrent retry; manifest retrieval and payload bounds.                                              | P4-02–P4-07 |
| P4-09 | Extend excel-lab with bulk scale, corpus cases and independent Python oracle; extend writing-aware agent scenarios.                                                                                                                   | Real MCP, unchanged source hashes, complete output values/types/order/counts, expected refusal, deterministic replay and TR/EN scripted baselines before actual model trials.                                                            | P4-08       |
| P4-10 | Combined regression, docs/reference generation, package/native acceptance and completion evidence.                                                                                                                                    | Build/types/lint; reader/writer/corpus tests; selected Open XML SDK/Calc checks; final platform/installed-tarball gate and explicit release/consumer boundary.                                                                           | P4-09       |

P4-01 is the first runtime slice; P4-03 is the first executable user-facing bulk mutation. Partial milestones do not complete F4-01–F4-09. New questions are required only when implementation reveals a user-visible tradeoff not covered by these decisions; include a simple example and record the answer here.

## Test and corpus plan

The existing local corpus was located and supplied using `SEZZLEE_CORPUS`; machine-specific paths stay in local evidence outside this public repository. Current manifest inventory contains 945 `.xlsx`, four `.xlsm` and 3,983 CSV entries across the larger mixed-format corpus. These are inventory counts, not bulk-edit success counts. `.xlsm` stays a source-reading/refusal case, never a writable target.

Reuse the existing owner boundaries:

- `test/transfer-data.spec.ts`: complete selections, typed transfer, exact versions and three optional external-corpus cases with an independent SheetJS reader.
- `test/write-foundation.spec.ts`, `edit-preparation.spec.ts`, `preserved-edit.spec.ts`: writing gate, output safety, preparation, atomic edits, source/version preservation and refusal.
- `test/corpus-cells-parity.spec.ts`, `corpus-csv-parity.spec.ts`: reader regression; passing these does not establish new bulk-operation support.
- Lab `inspect-edit-corpus.py` and its known-answer scanner tests: feature characterization, hashes, containment and budgets. Reuse previous inventory only when manifest/script digests match; refresh changed inputs. Select public, independently inspectable workbook pairs for joins/updates and keep unsupported-feature cases as expected refusals.
- Lab `transfer-bench.ts`, `edit-bench.ts` and their Python oracles: reuse real MCP execution, fixed heaps/watchdogs, retry checks, hashes, call sizes, timings and RSS. Extend for bulk cases rather than substituting a reader round trip as the only oracle.
- Lab `edit-agent-cli.ts`, `edit-agent-oracle.py`, Open XML SDK validator and LibreOffice oracle: add fixed bulk tasks, judge files and receipts independently of model prose. Keep actual-model trials on public pinned fixtures and record target/model identity; follow existing network/data authorization requirements.

New assertions must have an independent expected result: hand-audited small record tables, fixed CSV/raw OOXML, Python standard-library transformations independent of production code, and ZIP/XML/package checks. Never generate expected keys, joins, counts or fingerprints by calling the implementation under test. Extend existing owner tables where possible; use a separate bulk acceptance suite for new external behavior, not duplicate every internal helper.

Required adversarial cases include delimiter collisions in composite keys, numeric/text IDs, zero/false, missing/empty/whitespace keys, Unicode/case, temporal types, duplicate keys on either side, no matches, all matches, empty replacement, style/formula dependencies, hidden rows, table growth/shrink, output collisions, stale sources, cancellation, late failure and replay after response loss.

Start performance measurements at 10,000 and 50,000 records, then the established 50,000×20 million-cell scale where operation budgets permit. Measure update, replacement, upsert, append, join, sort/dedup and mixed independent/dependent jobs separately. Pin source cardinality/skew/duplicates, output expansion, seed, source/build/script hashes, heap, watchdog, RSS and full-oracle verdict. No numeric throughput/SLA promise until measured. Budget refusal must publish no completed output.

All generated workbooks, traces, manifests containing local paths and measurement reports stay outside the public repository. Evidence must identify what was actually attempted, passed, refused or skipped. Recheck originals after every mutating acceptance case.

## Baseline commands and evidence

Run from the vendor repository root through Turbo so dependent core/native artifacts are current:

```sh
SEZZLEE_CORPUS=/path/to/corpus pnpm turbo run test --filter=@sezzlee/excel-mcp --ui=stream -- test/write-foundation.spec.ts test/transfer-data.spec.ts test/edit-preparation.spec.ts test/preserved-edit.spec.ts test/corpus-cells-parity.spec.ts test/corpus-csv-parity.spec.ts --maxWorkers=1
pnpm turbo run test --filter=@sezzlee/excel-lab --ui=stream -- --maxWorkers=1
python3 -I packages/lab/excel-lab/scripts/test-inspect-edit-corpus.py
pnpm turbo run build check-types lint --filter=@sezzlee/excel-mcp --filter=@sezzlee/excel-lab
```

Verified on 2026-10-26:

- Initial focused baseline without `SEZZLEE_CORPUS`: four files passed, 108 tests passed and seven corpus-dependent tests skipped.
- Configured writer/edit/transfer plus corpus baseline: six files passed, 5,122 tests passed and none skipped. The initial 60-second command deadline was insufficient; a bounded longer run completed successfully without code changes.
- Existing excel-lab suite: 13 files and 112 tests passed.
- Independent corpus scanner known-answer suite: eight tests passed.
- Turbo rebuilt required dependencies during test runs. Full build/type/lint and final native/application/model gates are future implementation acceptance, not claimed by this documentation change.

No production changes were made for this planning baseline. Local evidence is retained outside the public repository.

## P4-01 implementation and acceptance

Implemented files: pure operation/limit contracts in src/authoring/bulk.ts; version-pinned input and bounded preparation/conflict schemas in src/tools/bulk-schemas.ts; analysis and orchestration in src/tools/bulk.ts; registration/admission in src/tools/writing.ts. The shared materializeTransfer path now accepts production caller capacity bounds, checked while rows/text are accumulated. Existing transfers retain their default capacities.

prepare_bulk accepts keyed_update/upsert planning with exact source/target versions, explicit record extents and named keys/set mappings. It reuses complete transfer selections and explicit typed reading, preserves type/case/whitespace/Unicode identity, detects missing/duplicate keys and headers, reports changed/unchanged/unmatched/insert candidates, and refuses occupied changes without overwrite. Key fields cannot be reassigned. Insert candidates require complete target column mapping. Target filters/subsets/projection/visibility restriction are excluded so an incomplete target preview cannot masquerade as the whole list. First/last conflict resolution remains P4-04.

The tool is read-only and available only in writing mode. It returns validation: keys_and_target_policy and executionAvailable: false. Policy blockers are separate from bounded record conflicts. Conflict records are one-based selected-record positions, not physical worksheet rows. Both sources are checked again before returning. Readiness does not imply complete mutation dependency support, publication, job completion or authorization; these remain P4-02/P4-03/P4-08. Mutation receipts will be finalized with executable operations rather than exported unused in this preparation slice.

Preparation bounds are 64 KiB descriptor, 100,000 records per input, 1,000,000 combined selected cells, 32 MiB combined text, 16 MiB serialized key candidates, 16 key components, 64 assignments and eight conflict examples. Snapshots additionally have a 64 MiB combined input bound and retain the existing per-file/container limits. These are refusal limits; performance acceptance is still P4-09.

Verification on 2026-10-26:

- Real MCP acceptance in test/bulk-preparation.spec.ts: 31 tests passed. Fixed raw OOXML/CSV examples pin typed/case/composite/Unicode/temporal keys, explicit filtering/subsets/readings, conflict bounds, header rules, overwrite, stale versions, protection, empty lists, descriptor/record/key-byte budgets, source preservation and an empty output directory. The read server rejects the new tool; the advertised operation schema has object type.
- Combined writer/edit/transfer/schema plus corpus regression: eight files and 5,152 tests passed without skips. This run included the initial 28 bulk cases; the final focused run includes three further empty-list/key-byte cases and a stronger fingerprint assertion. Existing excel-lab regression: 13 files and 112 tests passed.
- Initial negative CSV acceptance found an incorrect workbook-container check on CSV sources. It failed with not_a_workbook before the intended record guard. CSV now uses its existing format-specific reading path; both its positive typed selection and record-budget refusal pass. Initial TypeScript/default-capacity and test-reading configuration failures were corrected before acceptance.
- Final Turbo build/type/lint for excel-mcp, excel-lab and required dependencies passed: 13 tasks, zero lint warnings/errors. The final focused writer/edit/transfer/schema/bulk matrix passed six files and 148 tests without skips. Prettier and git diff --check passed. Source digests and exact commands are retained with local evidence outside the public repository. Final native/installed-package, actual-model and whole-phase performance/application gates remain P4-09/P4-10, not a claim of this preparation milestone.

Generated reference pages enumerate the default read server, whose catalog is unchanged. The package README documents the optional writing-mode tool; generated reference files were not hand-edited.

## P4-02–P4-09 implementation and acceptance

P4-02 adds the generic native publishDirectory capability, available only on NativeOutputRoot. Its bounded copied entries, root-relative private staging, no-replacement directory rename, identity checks and cleanup implement one completion boundary on Linux/macOS/Windows. The Excel platform derives a separate job store; original source capabilities remain read-only. A group manifest and every workbook are published together. Independent batches retain their descriptor, separately commit each child and retain the first failed diagnostic where possible. Completion takes precedence; current failures and retained first failures are distinguished, and an unusable diagnostic path does not hide completed siblings. Recovery verifies exact output locations, byte hashes and lengths before trusting a committed result, without rereading changed originals.

P4-03–P4-07 add a typed dataset engine with physical row provenance and explicit source/intermediate references. It implements conditional update/removal, keyed update/upsert, complete list replacement, append, inner/left/full joins, explicit many-to-many expansion, stable sort, filtering, duplicate reporting/removal, projection/rename/reorder and declarative constants/trim/locale case/typed conversion. Default key decisions remain unchanged. Named tables retain their declared column identity and resize basic range/filter metadata; unsupported totals/column changes refuse. Existing workbooks use the preservation editor, with unchanged formulas omitted from value writes. Physical removals retain Phase 3 reference/dependency checks and refuse neighboring data. Shape-changing operations cannot silently succeed through changed_values; replace_values is explicit.

P4-08 exposes ordered dependent groups and independent jobs through writing-only prepare/run/status tools. All outputs are dry-run and original versions rechecked before a first commit. Retry first looks for verified completion, so response loss, restart and changed originals do not create another append/upsert. Source changes before commit still refuse. Distinct-sheet changes can form one existing-workbook output; same-sheet data changes share one pipeline and retained row identities. No mutable latest-version pointer or server undo stack is introduced.

The job guard profile is separate from focused P4-01 analysis: 32 steps/group, 16 jobs, 16 outputs/group, eight snapshots, 100,000 records/dataset, 256 columns, 1,000,000 cells/dataset, 2,000,000 combined intermediate cells, 64 MiB snapshot/text budgets, 16 MiB serialized key candidates, 20,000,000 predicate/join/sort visits, 256 internal expanded changes, a 64 KiB descriptor and 50 MiB published group including metadata. The legacy 128-operation public edit API is unchanged. Bounds are explicit refusal points, not measured service-level guarantees.

Local verification so far:

- Native output capability: nine tests pass, including complete directory publication, concurrent one-winner publication, containment/name/byte guards, pinned parent paths, collisions and copied asynchronous buffers. Cross-platform results are recorded after the full CI matrix.
- Bulk jobs plus focused preparation: 70 MCP tests pass. Three additional configured external-corpus cases pass against independent CSV/SheetJS/ZIP expectations. Coverage includes 9/10 partial success and failed-only retry after restart, late dependent refusal, retained-output tamper, source versions, physical versus clear removal, typed keys, explicit duplicate resolution, 100→80 range/table replacement, joins, many-to-many limits, stable order, transformations, duplicate finding, empty replacement and combined sheet edits. Group receipts are bounded to 128 KiB; large batches return explicit completed-child summaries with retrievable full receipts.
- A negative diagnostic-location regression failed before its fix with not_a_file, discarding a successful independent sibling. The same actual MCP test passes after status collection and diagnostic persistence are isolated per child.
- The served job schema was measured at about 52 KiB/tool when the operation union was repeated. Flat input publication now parses through the strict canonical discriminated union; kind-specific missing/extra fields remain invalid. An actual MCP catalog test caps each job tool at 40,000 bytes. This follows the existing column-spec publication pattern and addresses observed Qwen argument errors without accepting aliases or weakening validation.
- bulk-bench.ts plus the independent bulk-oracle.py passed all nine operators at 10,000 records/ten columns. Update and sort also passed at 49,999 data records plus headers/20 columns: exactly 1,000,000 cells verified each. Observed run calls were approximately 7.5 seconds, with peak RSS approximately 817/923 MiB under a 1,024 MiB heap setting. These measurements predate final gate reruns and retain exact implementation hashes; they are not universal capacity claims.
- bulk-agent-oracle.py and bulk-agent-cli.ts add public synthetic fixtures and five scripted tasks: update, join, replacement, exact retry/status and protected refusal. All five scripted baselines and five independent oracle known-answer tests pass. Actual-model trials use the user-selected Qwen latest hosts, TR/EN, pinned model identity and isolated traces. Initial trials exposed catalog ambiguity, omitted numeric CSV readings, preservation-mode ambiguity and a model timeout; clarification and final rerun results are retained rather than treating those failures as passes.

Generated workbooks, full traces, local paths and reports stay outside the public repository. Public documentation records commands and scope. Default read-server reference pages are unchanged; optional writing tools are documented in the package README. Release/public consumer rollout remain separate from implementation and validation.

## Combined acceptance, 2026-10-26

The local combined run passed 6,790 Vitest tests without failures or skips: excel-mcp 6,444 across 78 files, excel-lab 112 across 13 files, ooxml-core 139 across ten files and file-core 95 across 11 files. The native suite passed 14 tests without skips; the independent bulk oracle known-answer suite passed five. Tests used the configured external public corpus, not a reduced synthetic substitute. Each package ran sequentially with one Vitest worker. Final receipt compaction after replacing retained failures with current-attempt diagnostics additionally passed all 70 focused bulk MCP tests and 13 build/type/lint tasks.

All nine bulk benchmark operations passed again at 10,000 records/ten columns. Update and sort additionally passed exactly 1,000,000 output cells each (49,999 data records and a header, 20 columns), with run calls of approximately 8.5/8.2 seconds and peak RSS approximately 879/799 MiB under the 1,024 MiB heap setting. These are observed local measurements, not general throughput guarantees. Independent Python checks compare every output coordinate, type, value, order, hash and size and recheck immutable inputs; retries retain the same completed identity.

Selected application acceptance passed five outputs from update, replacement, join and a two-output dependent group. Actual LibreOfficeDev 26.8.0.0.alpha0 produced ODS files; bulk-application-oracle.py compared 340,036 scalar coordinates/types/values against independently verified expected results and checked unchanged input bytes. Open XML SDK 2.16.0 with Office2019 validation passed all 21 selected scale outputs with zero errors. This does not imply application or schema validation of the whole external corpus.

Actual Qwen acceptance uses public deterministic fixtures and qwen3.8:latest, digest 22130167c4c20e20c7b71454612966ca8e8171e9b3cc8ab6ce8aa6cbfec79643 (qwen3.8:27b-q4_K_M). The isolated manifests retain exact model, implementation, controller and oracle hashes. The final configuration allows 12,288 generated tokens per call, a 360-second request deadline and 16 calls/turns. Two generic incomplete-task reminders are allowed, but none was needed in the ten verified scenarios below. Output values/types/order, source immutability, preserved package content, identical retry/status and actual protected-workbook refusal are independently graded. Preparation or model prose never counts as a completed report.

| Scenario                                     | TR verified calls | EN verified calls | Evidence batch |
| -------------------------------------------- | ----------------- | ----------------- | -------------- |
| Conditional update                           | 4                 | 4                 | v7             |
| Left join with numeric CSV readings          | 8                 | 9                 | v7             |
| Whole-list replacement and old-tail clearing | 6                 | 8                 | TR v7; EN v9   |
| Identical retry and durable status           | 4                 | 5                 | TR v7; EN v9   |
| Protected-workbook refusal without output    | 3                 | 3                 | TR v7; EN v9   |

This table records successful scenario coverage, not a 100% first-attempt model success rate. Both joins and the EN replacement corrected one real tool argument error within the unchanged call budget. Earlier runs exhausted reasoning budgets, returned no tool call or were interrupted during contract clarification; they remain failed or interrupted observations and are excluded from successful counts. The v7 catalog exposes direct job properties through the strict canonical union; observed initial model input increased from about 3,000 to 30,000 tokens, consistent with the provider finally including nested fields. The v9 description additionally names replace.input as the target dataset and replace.source as the replacement dataset; the engine contract is unchanged. An optional duplicate TR replacement attempt on the other host was interrupted after the required coverage had completed; it is not counted as a pass. These observations do not promise deterministic model behavior.

A local macOS arm64 process-kill acceptance check interrupted the actual native publisher once while a staging directory existed and once after confirmed completion. Both children exited via SIGKILL. The first exposed no completed group (one ignored staging directory); retry after process restart published a complete group. The second retained one complete group and rejected a duplicate publication. All four 8 MiB payload hashes, the completion manifest and an unrelated source sentinel were checked after recovery. This is selected process-crash evidence, not a power-loss guarantee.

The first full platform run caught Windows STATUS_ACCESS_DENIED in directory publication: open child file handles prevented renaming their parent. The implementation now closes flushed child handles before the Windows directory rename and reopens only its staged entries for failure cleanup. Node 22/24 Windows acceptance passes in the corrected runtime run; final CI records below bind all platforms and installed packages to that correction.

The corrected runtime revision d08eb986476ebf88b0fa5acfdec5309715a1a428 passed the [full CI gate](https://github.com/sezzlee/mcp/actions/runs/40310549072): all 15 jobs, including ten Linux/macOS/Windows Node 22/24 native legs, both NestJS host generations, combined build/lint/type/fixture checks and the final installed-tarball pack/smoke gate. Subsequent catalog publication keeps the same canonical job union but exposes job properties directly, matching the existing flat step/output publication pattern. Actual MCP catalog tests require the directly discoverable group/step/condition properties and reject missing or extra kind-specific job fields. This addresses a provider-compatibility concern observed while Qwen spent its response budget reasoning about undeclared argument shapes. A final CI/model rerun binds that catalog change.

Selected preserved-output application checks additionally passed an actual-model update and replacement workbook against the independent agent oracle, raw OOXML and real Calc-produced ODF values/types/order: 21 scalar coordinates, unchanged source/output hashes and zero Open XML SDK errors. The earlier five-output scale application check remains separate evidence.

After catalog normalization changed, the final server also recovered all 20 previously committed scale groups and their complete ten-child independent batch through actual get_bulk_job calls, verified the retained output inventories/hashes and left the output directories unchanged. The final configured corpus regression repeated excel-mcp's 6,444 tests and excel-lab's 112 tests without failures or skips. The final replacement-description clarification additionally passed all 39 bulk-job MCP tests, including direct schema publication, strict kind-specific validation and the 40,000-byte catalog cap, plus all 13 build/type/lint tasks.

The [final full CI run](https://github.com/sezzlee/mcp/actions/runs/40314833068) passed on 424015b7708e53303ce6b0654c761a582b2b375a: all ten native platform/Node legs, both NestJS host generations, combined build/lint/type/fixture checks and the installed-tarball pack/smoke gate (15 jobs total). Linux x64/arm64, macOS x64/arm64 and Windows x64 were checked on Node 22 and 24. Local selected Open XML SDK acceptance covers 23 outputs with zero errors; actual Calc acceptance covers seven outputs and 340,057 scalar coordinates/types/values. All 11 scale cases passed. The completion update changes documentation only; it introduces no further runtime change. Generated workbooks and failed/interrupted model traces remain outside the repository.

## Completion checklist

- [x] Every F4-01–F4-09 requirement has implemented behavior and independent acceptance; unsupported preservation is an explicit refusal, not silent data loss.
- [x] User decisions above hold through actual MCP requests and retries.
- [x] Complete selections, list-tail clearing, source immutability and exact record outcomes are verified.
- [x] Dependent and independent jobs have distinct, crash-safe completion/retry evidence; a per-file receipt is never mistaken for a completed group.
- [x] Receipts and diagnostic retrieval stay bounded; large joins/intermediates fail safely within measured resource bounds.
- [x] The final implementation passes existing reader/writer/corpus regression, scripted and actual-model acceptance, selected independent application/schema validation and the required native/installed-package gate.
- [x] Documentation is generated from actual registered contracts where required. Publication and private consumer rollout are tracked separately from local implementation completion.
