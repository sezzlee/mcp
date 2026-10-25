# Phase 1 implementation and verification plan

Status: implemented; local and full native CI acceptance passed on 2026-10-25. The collision, precision and scale decisions below were selected by the user. This plan implements F1-01 through F1-07 in [the phase scope](01-create-and-populate.md), using the completed Phase 0 publication capability.

## Accepted behavior

- Produce `.xlsx` only. Continue from the exact selected source path and SHA-256 version, never an implicit latest version. Every successful mutation publishes a new immutable output; identical output bytes reuse the existing output.
- Preserve the default read-only CLI and tool catalog. Writing requires the existing `--write <relative-output-directory>` capability.
- Support explicit text, number, boolean, blank, date and local datetime values. Empty text is distinct from blank; omitted operations leave cells unchanged. Never infer a formula, date or number from text.
- Reject occupied target cells by default. A write operation may explicitly choose replacement. Empty text counts as occupied. Adding a duplicate sheet name is always an error; names are also checked for collisions under the reader's normalization.
- Reject numbers that would lose precision under Excel's 15-significant-digit limit, non-finite numbers, unsafe JSON integers and unsupported numeric magnitudes. Return advice to choose text for long identifiers rather than converting implicitly.
- Target one block of 50,000 rows by 20 columns: 1,000,000 cells. Measure input bytes, elapsed time, resident memory, output bytes and expanded package bytes before claiming capacity. Separately bound input cells, stored cells, text bytes, operations, sheets and publication concurrency.
- A request is one transaction over one workbook. Validate and apply every operation before publication. Failure, cancellation before publication, collision or budget exhaustion must not expose a partial workbook as complete.
- Phase 1 continuation accepts the writer's bounded, canonical workbook format. Reject additional or changed unsupported package features; never reconstruct an arbitrary external workbook from the reader's lossy presentation. General external workbook editing remains Phase 3.
- Appending records means writing a block at an explicit start cell selected using the existing reader. It does not insert rows, infer a table boundary or move totals and notes.
- Retry the same request against the same source version to obtain the same bytes and output version. ZIP metadata, part order and serialization must be deterministic. Independent branches from an old source remain separate outputs.

## Implementation sequence

| Step | Responsibility and intended files                                                                                                 | Completion evidence                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Pure schemas and limits in `src/authoring/`; precision and value semantics extend the existing value contract.                    | Independent accepted/rejected wire examples, rectangular blocks, sheet names, unsupported values and missing fields.             |
| 2    | Generic deterministic ZIP creation in `packages/cores/ooxml-core`; no Excel vocabulary in that core.                              | A standard ZIP reader opens the produced bytes; deterministic output and invalid/budgeted inputs are checked.                    |
| 3    | Excel package generation and canonical-source validation in `src/format/`; reuse the namespace-aware XML reader.                  | Independent ZIP/XML inspection and a second spreadsheet reader verify relationships, types, values, order, empty text and dates. |
| 4    | Atomic create/edit execution and compact receipts in `src/tools/writing.ts`, with publication through `src/platform/versions.ts`. | Real MCP create → read → edit → retry flow; old source/output digests unchanged; rejected jobs publish nothing.                  |
| 5    | Isolated writing benchmark and replay evidence in `packages/lab/excel-lab`; generated inputs/results outside the repository.      | Small correctness fixtures, boundary fixtures, 1,000,000-cell create and continuation measurements against independent answers.  |
| 6    | Documentation, existing reader regression selection, native output tests, package/type/lint checks.                               | Recorded commands and counts; optional corpus skips and unavailable platforms remain explicit.                                   |

## Tool contract

- `create_workbook`: an explicitly named, non-empty sheet list, each with optional rectangular value blocks and their A1 start cells. An empty sheet list is rejected; a sheet without blocks is a valid blank workbook component. A header-only block needs no special mode.
- `edit_workbook`: required source path and version, followed by a bounded ordered operation list. Operations add a named sheet or write an explicit block to a named sheet. Replacing an occupied target requires an explicit choice on that write operation.
- Retain `create_workbook_version` as the Phase 0 preparation tool. Its ability to copy an external workbook does not grant that workbook Phase 1 editing support.
- Mutation results extend the existing version receipt with fixed-size counts for added sheets, applied blocks and written cells. Never echo the complete request or every cell/range.
- All writing tools share one server-level admission slot, acquired before loading source bytes or generating package parts. All responses pass through the existing guarded payload budget and root redactor.

## Value and package details

- Text preserves leading/trailing spaces, Unicode, line endings, XML metacharacters, literal `_xHHHH_` sequences, formula-looking strings and leading-zero identifiers. Reject malformed Unicode. Encode XML-disallowed code units with SpreadsheetML string escapes, escaping literal escape prefixes first.
- Blank clears a cell and does not become empty text. Block rows must be rectangular; missing values are rejected rather than padded or shifted.
- Dates are real Gregorian dates from 1900-01-01 through 9999-12-31. Datetimes are local wall-clock values with seconds and optional millisecond precision; zones are rejected. Use explicit ISO date cells with fixed date/datetime number formats, avoiding accidental timezone conversion or the fictitious 1900-02-29.
- Produce complete content types, root relationships, workbook relationships, styles and worksheets. No formulas, macros, links, calculations, formatting controls or external relationships are added.
- Validate supported continuation by reconstructing the canonical parts and comparing every original part, including the complete part inventory. A marker alone does not authorize dropping unknown content.
- Respect compressed output, individual part, total expanded bytes, expansion ratio and part-count limits. Use deterministic modest compression and measure highly repetitive as well as heterogeneous data.

## Verification matrix

| Boundary                 | Required evidence                                                                                                                                                       | Credible regression caught                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| MCP create/edit          | Blank, header-only and multi-sheet creation; positioned blocks; correction, new records and added sheet in one edit; fixed compact receipt.                             | Broken registration, bad operation ordering or incomplete F1-01–F1-07 behavior.       |
| Independent file meaning | JSZip plus an independent spreadsheet reader and a standard-library Python ZIP/XML verifier over fixed expected inputs.                                                 | Writer and in-house reader sharing the same encoding/type bug.                        |
| Values                   | `=SUM(...)`, `00123`, empty text, blank, zero, false, XML escapes, control characters, astral Unicode, precision boundaries, leap dates and fractional local datetimes. | Silent coercion, double escaping, timezone drift or loss of data.                     |
| Transaction/retry        | Late invalid operation, collision, source version mismatch, unsupported package content, same-request retry, independent branches and simultaneous admission.           | Partial success, duplicate appended records, lost updates or overwritten sources.     |
| Budgets                  | Oversized block/text/operation input, worksheet coordinate overflow, package/output limits and generated repeated-text compression case.                                | Allocation beyond the declared envelope or an unreadable self-produced workbook.      |
| Reader regression        | Existing targeted reader/value/metadata suites, existing corpus parity entry points and manifest-driven external corpus comparison.                                     | Default read behavior or tool catalog changing when writing is added.                 |
| Native filesystem        | Existing native output tests and security tests where the environment permits.                                                                                          | Replacing existing output, escaping the pinned directory or publishing partial bytes. |
| Scale                    | Isolated fresh process with fixed heap/wall limits; 50,000 × 20 create and selected-version continuation; independent counts and sampled boundary values.               | A scale claim based only on small tests, or budgets that reject the requested target. |

Tests assert observable behavior with independent expected values. Do not add source-text inventory tests, test-only production exports or copies of the implementation as an oracle. Keep generated corpus bytes and results outside the repository; third-party corpus originals are read-only and never committed.

## Commands and acceptance gates

Run focused suites through Turbo, which builds runtime dependencies first:

```sh
pnpm turbo run build check-types lint --filter=@sezzlee/excel-mcp --filter=@sezzlee/ooxml-core --filter=@sezzlee/excel-lab --env-mode=loose
pnpm turbo run test --filter=@sezzlee/excel-mcp --env-mode=loose -- test/create-and-populate.spec.ts test/write-foundation.spec.ts test/tools.spec.ts test/tool-schema.spec.ts
pnpm turbo run test --filter=@sezzlee/ooxml-core --env-mode=loose -- test/zip-writer.spec.ts
pnpm turbo run test:output --filter=@sezzlee/file-core-native --env-mode=loose
```

Select reader regressions and corpus cases after identifying the changed boundaries. Request approval for a whole-package test run as required by the applicable test skill; record the exact approved command. Do not represent skipped external corpus tests as passes.

The local corpus was discovered from the existing harness launch configuration and supplied through `SEZZLEE_CORPUS`. Its current manifests contain 945 `.xlsx`, 4 `.xlsm` and 3,983 CSV entries; these inventory counts are not claims of successful execution or supported editing.

Phase 1 is complete only after F1-01–F1-07 pass, the requested million-cell target has measured evidence, the source and previous versions remain unchanged, retry/atomicity behavior is demonstrated and documentation matches the supported behavior. Linux/Windows/macOS x64 native validation remains an explicit inherited gate until actually run; local macOS arm64 success does not prove those platforms.

## Primary references

- [Microsoft Excel specifications and limits](https://support.microsoft.com/en-gb/excel/excel-specifications-and-limits?nochrome=true): numeric precision, worksheet bounds, cell text and date range.
- [Microsoft Open XML cell types](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.cellvalues): explicit boolean, numeric, inline-string and ISO date encodings.
- Existing local corpus contracts: `packages/lab/excel-lab/README.md`, `FINDINGS.md` and `AGENT_LAB.md`.

## Execution evidence

All F1-01–F1-07 local acceptance gates passed on macOS arm64, Node 24.12.0.

- Build, type checking and lint passed for excel-mcp, ooxml-core and excel-lab. The lab initially lacked its already-declared sax dependencies; installing the frozen lockfile with lifecycle scripts disabled restored the installation without manifest or lockfile changes.
- The approved complete regression ran with SEZZLEE_CORPUS set and --maxWorkers=1: 72 Excel test files / 6282 tests and 10 OOXML test files / 139 tests passed. The corpus cell-parity file contributed 948 cases and CSV parity 4059 cases; these are test-case counts, not unique corpus-file counts. No suite was skipped in that run.
- Native output tests: 4 passed. Native filesystem security tests: 5 passed. No native source changes were needed in this phase.
- The first acceptance run exposed a missing case-insensitive sheet-name collision check; the corrected implementation passed the same case and the complete regression. Reader acceptance also uses the actual headerRow/valueMode/values wire contract.

| Workload                    | Input bytes | Create  | Edit A1 | Same-source retry | Compressed output | Expanded package | Peak RSS    |
| --------------------------- | ----------- | ------- | ------- | ----------------- | ----------------- | ---------------- | ----------- |
| 50000 × 20 numeric sequence | 32988963    | 1304 ms | 3062 ms | 2796 ms           | 4515163 bytes     | 37708586 bytes   | 788752 KiB  |
| 50000 × 20 mixed kinds      | 34613971    | 1419 ms | 3427 ms | 3446 ms           | 4886188 bytes     | 45169700 bytes   | 1064336 KiB |

Both runs used a fresh process, a 1024 MiB V8 heap ceiling and a 180-second wall ceiling. Peak RSS includes native allocations, protocol validation, request generation and prior calls in the process; it is not a measurement of a minimal resident server or a promise of 1024 MiB total memory. Timings are one local trial per dataset.

The independent Python ZIP/XML oracle passed both original and edited outputs for both runs. It checked all 1000000 stored numeric cells per numeric file (sum 499999500000 before edit, 499999499999 after edit) and all 950000 stored cells per mixed file, including exact text, empty text, booleans, dates and local datetimes. The remaining 50000 mixed input cells were blank and correctly omitted. The in-house MCP and independent SheetJS checks also passed the small typed, blank, header-only and multi-sheet fixtures.

Create receipts were 300 bytes and edit receipts 457 bytes on the million-cell runs. Retries returned the same output version and the original source digest stayed unchanged. Generated files, detailed reports and oracle JSON were retained outside the repository.

Linux, Windows and macOS x64 native execution were not run locally. The inherited native platform gate was subsequently closed by the successful full CI run recorded below. No live Excel/LibreOffice session or XSD validation is claimed.

Final focused rerun after adding the aggregate-text budget boundary: 4 Excel files / 73 tests passed; type checking and lint passed again for all three changed packages. Production changes: +637 / -16 lines. Tests and lab verification support: +1007 / -0 lines (documentation excluded).

Formatting and git diff --check passed. The initially failing repo-wide pnpm boundaries check is now closed: apps/docs declares the existing root-pinned prettier 3.9.6 as a devDependency, and its lockfile importer is updated. A frozen installation and installed-version check passed. The final boundaries run checked 1552 files in 23 packages with no issues; package formatting and git diff --check also passed. Native cross-platform execution subsequently passed in the full workflow_dispatch run on 8a0e11c, recorded below. Normal pull-request runs intentionally skip that matrix.

## Native CI follow-up

The first full CI run on commit 0385075 ([run 40203076121](https://github.com/sezzlee/mcp/actions/runs/40203076121)) passed the build/lint/type/fixture job, both NestJS compatibility jobs and all eight Linux/macOS native legs. Both Windows legs failed the four unchanged native output-publication tests with internal_error; the five native read-security tests passed. This is a Windows implementation failure, not a passing cross-platform acceptance result.

The fix uses NtSetInformationFile with FileRenameInformation for the handle-relative, replace-disabled rename and maps STATUS_OBJECT_NAME_COLLISION to output_exists. The target remains relative to the retained directory handle; no pathname-based fallback or replacement is introduced. The [Microsoft NT rename contract](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information) and [user-mode NtSetInformationFile guidance](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/nf-wdm-zwsetinformationfile) define the operation.

After the change, the existing four native output tests, five native security tests and 34 focused Excel authoring/foundation tests pass locally. The security watchdog needed execution outside the sandbox because its Unix socket was denied inside it. Windows execution must be proven by CI on the fixed revision. The pre-fix Windows log is retained with the local acceptance artifacts.

## Final CI acceptance

[Full CI run 40203876886](https://github.com/sezzlee/mcp/actions/runs/40203876886) completed successfully on runtime commit 8a0e11c0b7cf19293298c1846727972b5b713391: all 15 jobs passed. The 10 native legs cover Linux x64/arm64, macOS x64/arm64 and Windows x64, each on Node 22 and Node 24. The build/lint/type/fixture job, both NestJS compatibility jobs and final package validation also passed.

The Windows fix initially exposed an SDK-header omission: the user-mode headers do not name FileRenameInformation. The final implementation supplies its typed NT ABI value, 10. Both Windows legs then passed the unchanged native output/security tests, Excel tests and installed-tarball smoke checks. The inherited native acceptance gate and the earlier boundaries failure are closed. Live Excel/LibreOffice execution and Open XML XSD validation remain outside the claims.
