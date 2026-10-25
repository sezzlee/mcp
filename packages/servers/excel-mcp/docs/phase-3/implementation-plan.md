# Phase 3 implementation and verification plan

Status, 2026-10-25: P3-00–P3-09 implemented and package acceptance closed. The full Publish dry run on main commit a5f0bba8820e7cdd931b415a3e30e93c641031ce passed, including all ten native legs and the all-platform installed-tarball gate. Published versions are Excel 0.11.0, file-core 0.3.4 and file-core-native/ooxml-core 0.3.0. Npm and MCP Registry receipts are recorded below; consumer rollout is a separate operation.

## Recorded decisions

- Reject the entire request when a required feature or dependency cannot be preserved. No lossy-output override or values-only fallback for a formula/formatting copy.
- Edit .xlsx first. Macro-enabled, encrypted and protected inputs are excluded. Existing .xlsm/.csv reading and Phase 2 source-value transfer remain available.
- Undo selects an earlier immutable version; the combined request is the transaction boundary. Redo selects its retained result. There is no mutable latest pointer or server-side undo stack.
- K1-01–K1-09 and Phase 2 A-05 remain binding. F3-09 copies existing formulas and formatting now. New formula/style authoring remains Phase 5; server-side calculation remains Phase 6.

## Completed sequence

| Step  | Implementation                                                                   | Acceptance boundary                                                                                                                                                                                             |
| ----- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3-00 | Independent corpus feature inventory in excel-lab                                | 949 manifest entries attempted, 940 inspected, nine explicit errors; eight known-answer scanner tests. Characterization is not edit support.                                                                    |
| P3-01 | prepare_edit, exact versions, request fingerprint, raw package policy inspection | Ready/blocked dry-run uses the same editor as execution; macros/protection/signatures/Strict and stale versions have specific refusal paths. No output is published.                                            |
| P3-02 | format/preserved-workbook.ts, xml-edit.ts and edit-workbook.ts                   | Retain original package part payloads; lexically edit validated XML spans. Original canonical validation is retained as a separate fast path.                                                                   |
| P3-03 | External write_cells/clear_contents and Phase 2 external transfer targets        | Explicit overwrite, style-preserving clear, typed value/date writes, header mapping and source immutability. No worksheet reconstruction through the reader's presentation model.                               |
| P3-04 | format/formula-edit.ts reference tokenizer/mapper                                | Normal A1 refs, ranges, full axes, mixed/absolute axes, Unicode/quoted sheet names and text literals; unsupported impacted reference families refuse.                                                           |
| P3-05 | Range copy/move and cross-workbook source snapshots                              | Four explicit copy modes, merged-region checks, style/date meaning, incoming move refs, exact selected source versions and atomic refusal.                                                                      |
| P3-06 | Sheet add/rename/reorder/copy/delete                                             | Visibility/order, scoped names, identifiers, supported relationship-graph clones and deletion ownership; keep at least one visible sheet.                                                                       |
| P3-07 | Row/column insertion/deletion and dependent transformations                      | Cells, formula/name/rule/table/hyperlink ranges, merges, panes, row/column metadata, drawings and chart refs transform together within the supported profile.                                                   |
| P3-08 | Immutable continuation, retry, restore and compact receipts                      | Create → edit → edit → select retained source → branch/reapply; deterministic retry and late failure without partial output.                                                                                    |
| P3-09 | Independent package/value oracles, scale and actual-model harness                | Focused writer/read-corpus regression, million-cell write/row/column/copy, selected Open XML SDK and real Calc checks, scripted baseline and Turkish/English Qwen acceptance. Exact evidence is recorded below. |

P3-03 (3A) and P3-07 (3B) were intermediate milestones, not Phase 3 completion.

## Previous-phase carryovers

| Carryover                                                                            | Resolution                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0/1 native source/output capability, admission, immutable versions and budgets | Reused platform/versions.ts; no second filesystem writer or unsandboxed fallback. Every selected source is checked again before publication.                                                          |
| Phase 1 canonical-only editing                                                       | Kept strict readAuthoredWorkbook validation. Arbitrary .xlsx goes through the preservation editor instead of weakening the canonical serializer.                                                      |
| Phase 2 existing external targets                                                    | transfer_data now uses preservation editing for an existing .xlsx target, including header mapping. New targets keep canonical creation. Selection/scope/provenance/overwrite semantics are retained. |
| Phase 2 required formula/style copy                                                  | copy_range/copy_sheet provide values/formulas/formatting/all. Cross-workbook incompatible profiles fail explicitly. No deferred F3-09.                                                                |
| Saved formula results                                                                | Values-mode copies report saved-cache use; mutations invalidate stale formula caches and calculation-chain parts/relationships and mark refresh/recalculation required. No calculated-result claim.   |
| Missing application/schema/live-model evidence                                       | Selected independent Open XML SDK, real LibreOffice Calc and actual model acceptance added in P3-09. Their exact scopes do not imply whole-corpus application or schema validation.                   |
| Platform gate                                                                        | Phase 1 native run 40203876886 on 8a0e11c0b7cf19293298c1846727972b5b713391 is historical closed evidence. Final combined Phase 2/3 platform/tarball CI still must run before release.                 |

Phase 2 transpose is not added implicitly. Keyed joins, conditional bulk updates, whole-list replacement and multi-workbook transaction orchestration remain Phase 4. The combined request publishes one target workbook; external copy sources are read-only snapshots.

## Preservation and refusal contract

The pure format engine consumes bytes and operations; platform/tools own paths, snapshots, cancellation and publication. Authoring schemas have no platform import. The reader's SheetView/DefinedName presentation is not used as an editable source of truth.

Unrelated uncompressed parts retain exact payload bytes. Changed parts retain unrelated XML nodes, attributes and namespace declarations through validated lexical span edits. Deterministic ZIP repackaging may change compression/container metadata. Unknown content can pass unchanged only where the requested operation cannot affect its semantics. Unsupported impacted dependencies refuse the complete request.

prepare_edit validates the entire ordered request in memory and returns source, requestFingerprint, features and profile canonical_values/preserved_package. Execution repeats source/request/dependency validation; the fingerprint is not an authorization token. Policy blockers are bounded structured results; malformed inputs and operation-specific unsupported cases can return tool errors. No ready result guarantees that subsequently changed bytes can be edited.

Sources and all retained outputs are immutable. Stale source, cancellation before publication, collisions, invalid later operations and budget exhaustion publish no completed output. Identical source bytes and normalized changes produce the same version. Undo/redo/branch select retained exact versions rather than mutating a latest pointer.

The compact receipt retains source/output versions and normal change counts. Preservation edits add editing with operations, partsChanged, cellsCleared, recalculated: false, recalculationRequired, cachedFormulaValues and refreshRequired (formulas/charts/pivots). It never returns every cell or an unbounded part list.

## Supported profile and limits

- Transitional .xlsx, including supported noncanonical main-part paths. Reject .xlsm, disguised macros, encryption/legacy compound containers, enabled workbook/sheet protection, write reservations, signatures and Strict markup. Inactive protection markup alone is not active protection.
- write_cells uses the existing explicit text/number/boolean/blank/date/datetime contract. Empty text counts as occupied. overwrite: true is required for replacement; clear_contents explicitly clears a closed A1 range while retaining styles. Explicit numeric replacement of a date clears its date number format while preserving other style properties.
- Row/column operations use one-based at/count. Sheet rename/delete updates supported formulas/names and view indices; reorder preserves identity/visibility. Duplicate names and deleting the last visible sheet fail.
- copy_range/copy_sheet require values/formulas/formatting/all. Values uses literal/saved results and existing Phase 2 value safety (missing cache, error/rich/time/duration values can refuse). Formulas copies existing formulas and constants without source styling. Formatting keeps destination content. All combines supported content/style. Contents-only sheet copies create a fresh grid; formatting/all sheet copies retain the supported layout/dependency scope.
- Full-sheet all clones supported drawing/chart/table relationships with unique identifiers and scoped names. Range copies do not duplicate sheet-level charts/tables/rules. Full merged ranges are supported; partial merges, overlap, hidden destination values under a merge and partly intersecting incoming move refs refuse.
- Optional from: {filePath, versionId} is available only on copy_range/copy_sheet. Cross-workbook style/theme bytes must match; incompatible numeric calendar systems refuse (ISO date cells are independent). Source shared strings are safely inlined. Unsupported other-sheet/global-name bindings refuse. Source snapshots and temporary imported in-memory sheets are not published.
- Normal A1 refs, quoted/Unicode sheet names, mixed/absolute axes and supported names/ranges transform without rewriting string literals. Structured, external, 3D, spill/array syntax or unknown dependency families refuse operations requiring unsafe transformations. Shared/array group intersection/copy refuses; supported whole-group shifts outside an insertion/deletion can retain the group.
- Supported dependency transforms include merges, tables/autofilters, validation/conditional-format formulas and ranges, hyperlinks, panes, print areas, drawing anchors and standard chart refs. Unsupported table-header/totals deletion, VML positional edits, pivot/external-link/chartEx structural changes, extension/rich-metadata changes and unknown affected relationships refuse atomically. Byte preservation alone is not reference correctness.
- Formulas are never calculated. Applicable mutations remove cached results across the workbook, remove calcChain with its relationship/content type, and request application recalculation. Unsupported cache/metadata removal refuses rather than discarding rich content.
- Existing ceilings remain: 1,000,000 touched/stored cells, 64 sheets, 128 operations, 32 MiB stored text, 64 MiB serialized input, 50 MiB file limit and package budgets. Cross-workbook combined source/target retention is additionally bounded (1,000,000 cells, 512 MiB inflated; selected source snapshots total 50 MiB). Scale measurements report RSS separately from V8 heap.

## Existing tests and corpus

The existing write-foundation, create-and-populate, transfer-data, tools and tool-schema suites were extended/reused. edit-preparation adds policy/dry-run coverage; preserved-edit owns the distinct package-edit boundary. Independent expected formulas/coordinates/styles are literal fixture expectations and SheetJS reads, not values calculated by the editor. The raw preservation fixture is original redistributable XML. Existing corpus parity tolerances are unchanged.

The local manifest inventory has 945 xlsx, four xlsm and 3,983 CSV entries. All 949 OOXML entries were attempted: 940 inspected, six ZIP/container failures and three inspection-budget errors. No hash mismatch. Observed features overlap: 135 files with formulas, 47 shared formulas, two arrays, 26 tables, 191 merges, 168 names, 562 charts, 61 external links and 133 calculation chains. Protection markup occurred in 36 files, macros in four and signatures in two. These are feature counts, not supported-edit counts.

Corpus originals, output workbooks, traces and reports stay outside the public repository. Manifest-relative paths, file SHA-256 and manifest/script/build digests pin evidence. Public Apache test fixtures alone are used for model acceptance. No private product data is included.

## P3-09 independent tooling

Run from the vendor repository root after building:

```sh
pnpm turbo run build check-types lint --filter=@sezzlee/excel-mcp --filter=@sezzlee/excel-lab
python3 -I packages/lab/excel-lab/scripts/test-inspect-edit-corpus.py
python3 -I packages/lab/excel-lab/scripts/inspect-edit-corpus.py --corpus /path/to/corpus --out /tmp/excel-edit-inventory
node packages/lab/excel-lab/src/edit-bench.ts --out /tmp/excel-edit-scale --rows 50000 --columns 20 --operation write --heap-mib 1024
python3 -I packages/lab/excel-lab/scripts/edit-oracle.py /tmp/excel-edit-scale/edit-REPLACE
```

Repeat the scale command with operation rows, columns and copy. Each fresh child has the selected heap and a 180-second watchdog. It verifies original hashes and deterministic retry; reports request/receipt bytes, call times, peak RSS and generator/build digests. The independent standard-library Python oracle checks every million-cell value/coordinate, hashes, ZIP CRCs, relationships, types, stale-cache policy and retained opaque bytes.

```sh
node packages/lab/excel-lab/src/edit-agent-cli.ts --out /tmp/excel-edit-scripted --corpus /path/to/corpus
SEZZLEE_AGENT_LAB_OLLAMA_URL=http://MODEL_HOST:11434 node packages/lab/excel-lab/src/edit-agent-cli.ts --out /tmp/excel-edit-live --corpus /path/to/corpus --model MODEL --languages tr,en
```

The isolated writing-aware lab uses prepare_edit/edit_workbook/create_workbook_version/describe_workbook/read_sheet, preserves the existing read-agent lab and grades saved files through edit-agent-oracle.py. Scenarios: value correction, copy, clear, row insertion, previous-version restore and protected-file refusal. Tool execution and exact output contents determine success; model final prose does not. Model identity, fixture/script/build digests and traces are retained externally. Network use must have authorization for the selected fixture and target.

Optional independent schema/application checks:

```sh
dotnet build packages/lab/excel-lab/scripts/openxml-validate/Validate.csproj -o /tmp/excel-openxml-validator
dotnet /tmp/excel-openxml-validator/Validate.dll /path/to/source.xlsx /path/to/output.xlsx
python3 -I packages/lab/excel-lab/scripts/edit-lo-oracle.py /tmp/excel-edit-scripted /tmp/calc-ods-output
```

The SDK validator uses Office 2019 validation and prints bounded failures; it is a lab-only optional .NET tool. For Calc, open/convert the five scripted output workbooks to ODS through a real isolated headless LibreOffice instance first. The ODF oracle compares typed values and formulas after the application has read/calculated them. Neither tool is a runtime dependency or server calculation fallback.

## Local acceptance ledger, 2026-10-25

- P3-00 scanner: eight known-answer tests passed; full inventory results above.
- P3-01 historical focused acceptance: 131 tests passed. This predates full editing and is not the final count.
- Full preservation editor focused acceptance: 29 tests passed, including external transfers, four range/sheet modes, both calendar systems, merged copy, structural refs/tables/charts, hidden/scoped sheets, cross-workbook snapshots, stale versions, immutable branch/retry and atomic refusal.
- Final configured writer plus corpus-parity regression: nine files, 5,167 tests passed, no skips, one worker (198.49 seconds). This includes the existing 5,007 reader-parity cases and 160 writer/preparation/preservation cases; historical runs are not added as unique tests. Existing agent-lab infrastructure: four files, 38 tests passed.
- Million-cell sequence write, row insertion, column insertion and range copy: each passed the actual MCP call/retry and independent Python validation of all 1,000,000 cells. With a 1024 MiB V8 heap and 180-second watchdog, first/retry times were write 14.57/13.48 s, rows 11.73/11.91 s, columns 13.70/15.53 s and copy 13.43/14.90 s. Peak RSS was respectively 881072, 1111264, 983600 and 959088 KiB. Reports pin each measured build/generator digest; measurements span development builds and are not a service guarantee. The final preparation-only source recheck passed the affected 59 tests again; it does not relabel earlier measurement digests.
- Actual Qwen acceptance: six scripted baselines plus twelve live tasks (six each in Turkish/English) passed on public Apache fixtures. The model digest is pinned in the external run report. A later-build smoke additionally passed two scripted and four live write/copy tasks (Turkish/English). Reports retain their distinct implementation digests; the final preparation-only recheck was then covered by the affected 59 tests.
- Microsoft Open XML SDK: 14 selected source/output packages validated with zero errors: public source, 20,000-cell benchmark source/output, five scripted edits, plus an original table/chart/drawing source and five row/column/sheet-copy/rename/range-copy outputs. This is not whole-corpus XSD validation.
- Real LibreOffice 26.8.1 Calc: six selected workbooks opened/converted successfully; five scripted scenarios passed the independent ODF typed-value/formula oracle (23 checks). The sixth is the 20,000-cell sequence smoke. No Microsoft Excel application acceptance is claimed.

## Release and consumer boundary

The package gate is closed by [Publish dry run 40225865141](https://github.com/sezzlee/mcp/actions/runs/40225865141): build/lint/types/fixtures, both Nest compatibility legs, Linux x64/arm64, macOS x64/arm64 and Windows x64 on Node 22/24, platform-specific clean installs, merged prebuild inventory, clean all-platform package install and npm dry-run all passed. This supersedes the inherited Phase 2/3 package CI gap. Only the four intended new versions were publication candidates; unrelated published versions were skipped.

[Publish 40226890188](https://github.com/sezzlee/mcp/actions/runs/40226890188) published the four versions using this green run through from_run on the same main commit. All four registry sha512 integrities match the downloaded CI tarballs. [Registry 40227129977](https://github.com/sezzlee/mcp/actions/runs/40227129977) published the Excel 0.11.0 MCP Registry entry. Host final-image acceptance belongs to the consumer integration and is not claimed by the package matrix. No source package test implies a consumer deployment or formula calculation.

## Final closure work, 2026-10-25

The complete local Excel suite passed 75 files and 6,370 tests with the external corpus configured and no skips. The complete lab suite passed 13 files and 112 tests. The installed-tarball smoke now also exercises external structural editing, formula/formatting copy, source immutability, Phase 2 CSV transfer, deterministic retry, atomic refusal, retained-version branching and exact previous-version restore through the real stdio CLI. Formula-cache absence and unchanged styles are independently checked through Python ZIP/XML; cell/formula expectations use SheetJS. The full native CI must execute this strengthened smoke on the committed revision before its gate can close.

The writing-aware model lab additionally covers transfer_range, transfer_records and transfer_aggregate. Each has a scripted baseline and an independent output oracle; live Turkish/English results are recorded separately from the earlier edit scenarios.

## Final model and regression closure

The additional object-union contract regression failed before the fix and the configured transfer selection then passed all 29 tests. Selection/target unions now explicitly advertise type: object; JSON-encoded strings remain invalid. Tool descriptions explain headerRow: 0, where arrays and one-based physical rows instead of coercing invalid requests.

The final Phase 2 model profile passed three scripted baselines and all six live tasks (range values, filtered/reordered records and aggregate results, each in Turkish/English). It exposes prepare_transfer, transfer_data, describe_workbook and read_sheet; the five-tool editing profile remains separate. Both profiles, exact model/fixture/script/build identities and independent output grading are retained in external reports. Earlier diagnostic failures and timeouts remain recorded and are not counted as passes. The evaluator selects the requested mutation output rather than prematurely accepting a preparatory version receipt.

All nine runnable Excel documentation pages passed against the workspace server. The generated 0.11.0 reference pages passed content validation and a production build. The three generated 0.11.0 reference pages were deployed to the existing documentation Worker and each returned HTTP 200 with version 0.11.0: [tools](https://docs.sezzlee.app/docs/excel-mcp/tools), [errors](https://docs.sezzlee.app/docs/excel-mcp/error-codes) and [limits](https://docs.sezzlee.app/docs/excel-mcp/limits).
