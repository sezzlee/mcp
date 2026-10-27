# Phase 7 implementation status

Status, 2026-10-27: all eight approved families are implemented on `codex/excel-phase4-bulk` for [PR #73](https://github.com/sezzlee/mcp/pull/73). Final local acceptance passed. Full native and installed-package CI remains pending before closure. The [plan](implementation-plan.md) defines the support profiles; the [machine-readable acceptance record](acceptance-record.json) binds the evidence to the actual runtime.

## Delivered support

| Family                       | Accepted initial profile                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F7-06 names/templates        | Static workbook/sheet names, exact typed target fill, explicit replacement/deletion and scope resolution.                                                                           |
| F7-03 validation             | List, numeric/date/text-length bounds and custom formulas; explicit replacement/removal and overlap refusal.                                                                        |
| F7-04 conditional formatting | Comparison/expression rules, differential font/fill, explicit priority and `stopIfTrue`, replacement/removal.                                                                       |
| F7-05 content                | HTTPS/internal links, legacy notes and anchored embedded PNG/JPEG; explicit replacement/removal and dependency cleanup.                                                             |
| F7-01 charts                 | Column/bar/line/pie, literal-source caches, explicit visible series colors, bounded vectors, refresh diagnostics and removal.                                                       |
| F7-02 pivots                 | Real OOXML PivotTable, private cache definitions/records and independently materialized categorical sum/count/min/max results; source replacement, refresh and stale-tail clearing. |
| F7-07 protection             | Cell locking, sheet/workbook legacy protection, authenticated explicit removal and atomic refusal of unsupported protection.                                                        |
| F7-08 recurring reports      | Existing bulk finishing accepts all new operations. Two periods, shorter replacement, replay, retained versions and late-failure atomicity are exercised.                           |

The package README documents exact limits and refusals. Chart refresh, PivotTable refresh and formula calculation remain distinct states. Affected source edits invalidate caches; unrelated formatting retains them. Existing immutable publication, transfer, structural-edit and preservation rules continue to apply.

## Final local acceptance

| Gate                                                             | Result                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Excel full suite, external corpus and calculation oracle enabled | 81 files, 6,520 tests passed; zero skips; 227.79 seconds. Includes 29 expert-authoring tests and prior-phase regression.                                                                                                                       |
| Excel lab suite                                                  | 17 files, 136 tests passed; zero skips.                                                                                                                                                                                                        |
| Independent Python oracle self-tests                             | Expert 6, visual 3, authoring 12, bulk 11 and corpus scanner 8 passed. Fixed corrupt fixtures reject wrong totals, caches, relationships and invisible charts.                                                                                 |
| Build, types and lint                                            | All 13 tasks passed for Excel MCP, Excel lab and dependencies.                                                                                                                                                                                 |
| Repository boundaries                                            | 1,703 files in 23 packages; zero issues.                                                                                                                                                                                                       |
| Generated reference                                              | Generated from the final built tool schemas; `gen-reference.mjs --check` passed.                                                                                                                                                               |
| Deterministic composed report                                    | Typed period target, calculated sum, pivot cache/results, four chart types, rules, notes, links, image and protection independently checked.                                                                                                   |
| TR/EN Qwen                                                       | Both final trials passed whole-artifact, application and visible-chart checks with `qwen3.8:latest`; model digest and settings recorded.                                                                                                       |
| Open XML SDK                                                     | All four selected final outputs passed with zero errors: deterministic, TR, EN and scale. TR and EN independently converged on identical output bytes.                                                                                         |
| Actual application                                               | LibreOffice reopened and exported all three final report outputs. Values, pivot results/cache, chart series, effective rules, content and protection were compared independently. Source hashes stayed unchanged.                              |
| Actual rendered charts                                           | Final deterministic plot bands contained 56,374 / 72,845 / 2,795 / 43,377 blue series pixels. TR and EN each contained 75,527. The old invisible-chart fixture fails with zero pixels in every band. Final render was also visually inspected. |
| Resource ceiling                                                 | 100,000 source cells, 24,999 records, 100 pivot groups and 10,000 chart points passed in 4,646.30 ms; process maximum RSS 498,400 KiB. Source stayed unchanged. This is one measured local case, not a portable performance guarantee.         |

The corpus contains 10,713 spreadsheet inputs after excluding evaluation outputs and ground-truth copies: 9,762 CSV, 947 XLSX and four XLSM. The suite applies its existing discovery/selection rules; this does not claim every file was edited. Licensed inputs, generated workbooks, endpoints and full model traces remain outside the public repository.

## Findings and consumer limits

Independent application/visual checks found and fixed missing theme-independent chart colors, incorrect pivot total metadata and differential-fill background color. The catalog bound initially failed after schema growth; compact wire schemas derived from the canonical cell contracts restored the existing 50,000-byte limit. Final `prepare_bulk_job` and `run_bulk_job` input schemas are 47,549 and 46,099 bytes.

Earlier model trials failed exact period/note requirements. Prompts were clarified to require literal period text and separate exact note author/text; the artifact oracle was retained. The final runtime was rerun in both languages after the chart fix.

LibreOffice drops the deterministic report's `stopIfTrue` flag on export. The produced original flag and relative/effective rules are independently checked; the application record exposes this consumer limitation. Microsoft Excel desktop interaction and all possible workbook/advanced-feature combinations are not claimed. Macros are never executed; encrypted, signed and unsupported protection edits refuse.

## Remaining closure

Seven fresh local tarballs passed dependency/content audit. A clean npm installation on darwin-arm64 Node 24.12.0 passed the expanded expert-report smoke and existing edit/transfer/calculate/retry/restore scenarios. The expert smoke independently checks named fill, validation, conditional rules, notes/links/images, chart caches/visible-color metadata, pivot results and protection. Its initial single-cell spelling assertion was corrected to accept semantically equivalent A1 range forms; other assertions were retained.

Push this implementation to PR #73, run full native/platform/Node and installed-tarball CI, then bind those green results to the unchanged runtime here. Package publication, website deployment and private runtime rollout remain separate.
