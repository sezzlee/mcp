# Phase 2 implementation and verification

Status: implemented; local acceptance passed on 2026-10-25. This plan covers F2-01 through F2-08 in [the phase scope](README.md).

## Recorded decisions

The user selected these A-05 behaviors on 2026-10-25:

- Transfer values in Phase 2. Formula expressions and formatting must be copyable in Phase 3; that requirement is recorded as F3-09. It is not dropped or left as an optional future idea.
- A formula contributes its last saved result, with cached-formula counts and recalculated: false in the receipt. Missing formula results fail before publication.
- A changed source stops the transfer and requires a new preparation. Never silently use current bytes in place of the selected version.
- Transfer every matching record even if an earlier preview displayed only the first 20. An explicit physical-row subset remains restricted to that subset.
- Occupied destination cells require explicit overwrite. Blank source cells clear targets only when overwrite is authorized; empty text remains distinct from blank.

## Existing foundation and implementation

The existing writer already owns deterministic workbook generation, occupancy checks, immutable versions, secure publication, admission, cancellation checkpoints and compact receipts. The reader already owns format parsing, range/table selection, column resolution, explicit type interpretation, predicates and aggregation. No spreadsheet engine or production dependency is added.

The new tools are available only in explicit writing mode:

| Tool             | Input and result                                                                                                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prepare_transfer | Accepts filePath and a range, records or aggregate selection. Reads the complete bounded selection internally, validates representability, and returns a replayable transfer reference containing the exact source path, SHA-256 and normalized selection, plus counts. It returns no cell matrix and writes nothing. |
| transfer_data    | Accepts that transfer reference and a new-workbook, new-sheet or selected-authored-sheet target. Rechecks source and target versions, materializes the values internally, applies changes atomically and publishes one immutable result.                                                                              |

The reference contains a declarative selection, not retained cell data or an implicit latest-source lookup. It needs no process-local handle store, lifetime or eviction policy. Calls rerun the selected operation against the pinned bytes. An identical retry against the same source and target versions reuses the deterministic output.

Selection kinds have separate semantics:

- range preserves the explicitly requested rectangle, including blank cells outside the used area. Open column/row ranges use the occupied extent in their unspecified dimension. With no explicit headerRow, range uses 0; header-based column selection therefore needs an explicit headerRow.
- records excludes the resolved header row and wholly blank rows, applies conditions across all data records, projects selectColumns in the requested order and optionally adds headers. A stored empty string remains a record, distinct from an absent or stored blank. scope defaults to all; scope rows identifies unique physical source rows and keeps source order. A subset row excluded by blank-row, filter or visibility rules is an error.
- aggregate exports the complete grouped summary with a header row, independently of the reader's 500-group presentation ceiling. Existing aggregate scan/state limits still apply; no truncated result is exported as complete. Existing analysis warnings, including their column identifiers, are carried in the receipt. Date extrema identified by the analysis engine and explicitly date-typed group keys are written as date/datetime cells; other group labels retain the engine's scalar representation. Explicit time/duration column readings are rejected in this phase.

Predicates and explicit column readings reuse the reader's existing semantics. Incomparable record predicates fail with guidance to select an explicit reading. Cross-column membership joins, pivots and grouping sets remain outside this initial transfer schema; keyed joins belong to Phase 4. Source columns can be addressed by unique headers or A1 letters. Existing-sheet mapping may match source headers to unique destination headers even when their column order differs; startCell supplies the destination row. Duplicate, missing or ambiguous mappings fail atomically.

The default copies stored value meaning. CSV text stays text unless explicit columns request conversion. ISO-looking literal text and formula-looking text remain text. Transfer reads raw OOXML cell-kind provenance alongside the reader's normalized value to distinguish real date/datetime cells from identical-looking strings. No field is added to the existing reader snapshots or facts. Calendar values are written through the existing explicit date/datetime writer, so source date1904 does not shift the destination date.

The writer still refuses unsupported or lossy representations: errors, rich values, images, durations, time-only values, unsafe numeric precision, invalid dates and values outside its existing domain. It does not silently substitute blanks or display strings. Raw numeric serials without date semantics remain numbers. Formulas and cell formatting are not copied in this phase.

External .xlsx/.xlsm and CSV files can be read as transfer sources. Mutation targets still require the exact authored-workbook subset accepted by Phase 1. Copying an arbitrary workbook with create_workbook_version does not widen that target contract. Macro bytes, relationships, styles and other source package features are not copied by value transfer.

## Budgets and atomicity

The descriptor has a 64 KiB serialized byte limit and an explicit subset has at most 10,000 physical row numbers. The materializer enforces the existing 20,000,000-cell scan ceiling, 1,000,000 output cells including headers, 32 MiB output text and the existing per-value, file and ZIP limits. Header mapping uses at most 128 blocks. Workbook-wide stored-cell, sheet and output limits continue to apply.

Preparation and transfer share the writer's single admission slot. Cancellation is checked before work and before publication. The transfer reads pinned snapshots, constructs the entire destination in memory, verifies source/target versions again and publishes once. Validation, occupancy, mapping or budget failures produce no completed output. Sources and previous target versions remain untouched.

## Verification approach

The MCP acceptance tests exercise full versus previewed data, explicit subsets, projection, grouping beyond presentation limits, target mapping, overwrite and blank clearing, both workbook date systems, literal text versus dates/formulas, cached and missing formula results, hidden rows, stale sources, unsupported values, path escapes, target overflow and default read-mode exclusion. Source fixtures use literal CSV and raw OOXML. Output cell expectations use an independent SheetJS reader. Optional external-corpus transfers compare 40 source coordinates per workbook against that independent reader and verify original bytes remain unchanged.

The reproducible lab transfer-bench.ts generates a numeric CSV, transfers it through the real MCP tools, continues from the selected output with a one-cell transfer and retries the identical continuation. It isolates the run in a child process with a fixed heap and 180-second watchdog, records source/build digests, timings, input/receipt bytes and peak RSS, and retains artifacts outside the repository. The Python standard-library transfer-oracle.py independently checks every source CSV field and output numeric cell, values, counts, sums, SHA-256, package CRCs and absence of formulas.

## Pre-implementation evidence

- Authoring/foundation/tool/schema baseline: 4 files, 73 tests passed through Turbo with one worker.
- Selected read, aggregate, typed-boundary, typed-I/O, visibility and cursor baseline: 6 files, 114 tests passed.
- Existing external corpus parity: 2 files, 5,007 tests passed (948 OOXML cell cases and 4,059 CSV cases), with SEZZLEE_CORPUS configured. Inventory contains 945 .xlsx, 4 .xlsm and 3,983 CSV entries; these inventory counts are not transfer coverage claims.

## Research and skills

The existing find-skills, test-audit, typescript-best-practices and principle-type-system-discipline skills guided discovery, independent expectations and implementation. The available Spreadsheets skill was reviewed; its end-user artifact authoring workflow does not replace this existing server's secure writer or independent harness. Public [Anthropic xlsx](https://github.com/anthropics/skills/tree/main/skills/xlsx) and [mcp-builder](https://github.com/anthropics/skills/tree/main/skills/mcp-builder) skills were discovered; no new skill or runtime engine was installed.

Microsoft's [CellValue reference](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.cellvalue) defines a formula cell's stored value as its last calculated result; its [formula guidance](https://github.com/OfficeDev/open-xml-docs/blob/main/docs/spreadsheet/working-with-formulas.md) explains that the cached value can be absent. The [Date1904 reference](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.workbookproperties.date1904) identifies the workbook date-system flag. These support testing cache absence and preserving calendar meaning separately from serial values.

## Acceptance evidence

All final checks below passed locally on macOS arm64 with Node 24.12.0:

- Build, type checking and lint passed through Turbo for excel-mcp and excel-lab, including their dependencies: 13 tasks passed. The lab's already-declared SAX dependencies were absent from the installation. A frozen install with lifecycle scripts disabled restored the installation without changing a manifest or lockfile; the offline attempt lacked a cached tarball and the normal frozen install completed successfully.
- The focused final reader/writer/corpus matrix passed 20 files and 5,362 tests, with SEZZLEE_CORPUS configured and --maxWorkers=1. It includes all 5,007 existing corpus parity cases and the three new independent external-corpus transfers. No suite in that run was skipped.
- A subsequent aggregate-date regression added one test. The final affected-boundary run passed 7 files and 160 tests, including all 28 transfer acceptance cases, with the corpus configured and no skips. Those files are transfer-data, aggregate, read-sheet, tools, tool-schema, create-and-populate and write-foundation. A whole-package test suite was not run.
- The corpus matrix caught 146 snapshot-comparison failures when an early implementation added a temporal field to shared reader facts. Reader values matched, but snapshot shapes differed. The field was removed and transfer now obtains raw provenance without modifying reader structures. The existing independent corpus oracle was not weakened; the failing SimpleStrict case and the complete matrix passed afterward.
- The blank-record regression was demonstrated before its fix: the expected 3 output rows / 2 records became 5 rows / 4 records because absent and stored blank cells were counted as records. The fixed boundary test preserves empty text and excludes both blank representations.
- The new aggregate-date regression failed before its fix with a string cell containing 2026-10-24 where a date cell was required. Date extrema and explicitly date-typed group keys now preserve that type, and the final affected-boundary run passed.
- Package boundaries passed: 1,560 files in 23 packages. Formatting and git diff --check passed.

The final isolated transfer benchmark passed at 50,000 rows by 20 columns, with a 1,024 MiB V8 heap and the 180-second watchdog. The measured peak RSS was 786,960 KiB. The complete numeric transfer took about 1.26 seconds after a 0.55-second preparation; selected-version continuation took about 2.67 seconds and its identical retry about 2.57 seconds. These are local measurements, not service or cross-platform guarantees. The large transfer used a 1,152-byte request and returned a 617-byte receipt; continuation/retry receipts were 752 bytes.

The independent Python standard-library oracle passed both million-cell outputs. It verified every original CSV field, every numeric output coordinate, uniqueness of coordinates, exact values and counts, sums of 499999500000 before the correction and 499999499999 afterward, ZIP CRCs, file hashes and absence of formulas. The source digest stayed unchanged and the identical retry reused the selected output version. Generator and built implementation digests, source/output files, complete logs and oracle JSON are retained in external acceptance artifacts, not committed.

No Phase 2 cross-platform/native CI, live Excel/LibreOffice run, live planning-model acceptance or Open XML XSD validation was performed. The existing native filesystem implementation was not changed. Local tool execution and independent file validation establish transfer behavior; they do not prove that a live model always chooses the intended source, scope or target.

Change size excluding documentation: production +907/-3 lines; acceptance tests and lab verification support +1268/-0 lines. No dependency manifest, lockfile or shared reader fact/snapshot implementation changed.
