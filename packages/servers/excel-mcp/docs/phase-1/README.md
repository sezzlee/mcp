# Phase 1: create and populate workbooks

Status: implemented; final local acceptance evidence is recorded in [the implementation and verification plan](implementation-plan.md). Builds on [Phase 0](../phase-0/README.md). The source-preservation, separate-calculation and explicit-writing-mode decisions in [the roadmap](../README.md) remain binding.

## Goal and coverage

An agent can create an Excel workbook, write explicitly typed rectangular blocks, and continue the conversation by selecting an immutable output version for further edits.

| ID    | Implemented behavior                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1-01 | Create a new .xlsx through create_workbook.                                                                                                                                           |
| F1-02 | Create multiple named sheets, preserving their order; add sheets in subsequent edit_workbook requests.                                                                                |
| F1-03 | Create a blank workbook with at least one sheet, or a header-only workbook using an ordinary value block.                                                                             |
| F1-04 | Write a cell, row or rectangle at an explicit A1 start cell. Ragged rows and out-of-bounds blocks are rejected.                                                                       |
| F1-05 | Apply explicit text, number, boolean, blank, date and local datetime kinds. Literal text is never inferred as a formula, date or number.                                              |
| F1-06 | Require the selected source path and SHA-256 version for continuation. Correct cells, write additional records and add sheets in one atomic request. Preserve every previous version. |
| F1-07 | Return the completed version receipt and fixed-size counts of added sheets, applied blocks and written cells. Do not repeat the full input.                                           |

## Accepted decisions

- Produce .xlsx only. General external workbook editing remains Phase 3. Phase 1 edits only its canonical generated package format, comparing the complete part inventory and original part contents before reconstructing it. Unsupported content is rejected rather than discarded. Preparing a source with create_workbook_version does not expand the editing scope.
- Reject writes to populated cells by default, including empty text. A write_cells operation must explicitly choose overwrite: true to replace or clear them. Missing operations leave cells unchanged; blank explicitly clears a cell. Adding a duplicate sheet name, including a case-folded or normalized collision, fails.
- Reject precision-losing numbers, unsafe JSON integers, non-finite numbers and unsupported Excel numeric magnitudes. The agent must explicitly choose text for long identifiers. Never silently round or convert to text.
- Dates use real Gregorian days from 1900-01-01 through 9999-12-31. Datetime values are local wall-clock times with seconds and optional 1–3 fractional digits, without a zone. Date cells use explicit ISO encoding and fixed date/datetime formats; formula generation and calculation remain later phases.
- A request is one transaction over one workbook. Every address in it names the selected source as it was read, never a position produced by another operation in the request. Validate and apply all operations before publication. A late failure publishes no completed partial version. Multi-request and multi-workbook transaction execution remains Phase 4.
- Appending means writing at an explicit start cell selected using the existing reader. It never inserts rows or moves totals, notes or other content.
- Retry the same request against the same selected source. Deterministic part order, XML and ZIP metadata produce the same output bytes and content version. Distinct branches from an old source remain distinct immutable outputs.

## Limits and acceptance

The requested scale target is 50,000 rows × 20 columns. The initial limits are 1,000,000 touched cells per request, 1,000,000 stored cells per workbook, 64 sheets, 128 blocks or changes, 32 MiB stored text and 64 MiB serialized request input. The existing 50 MiB compressed file ceiling and OOXML part, expanded-package, part-count and expansion-ratio limits also apply. These are separate ceilings; staying below one does not waive another. One writing job per server is admitted before source loading or package generation.

Acceptance covers blank/header-only and multi-sheet creation; explicitly positioned typed data; correction, new records and new sheets in one edit; preservation of source and previous versions; deterministic retry; strict rejection and atomic failure; independent ZIP/XML and spreadsheet-reader validation; a measured million-cell workload; and unchanged default reading behavior over the existing corpus.

The implementation sequence, owner tests, commands, benchmark reports and inherited native-platform validation limits are in [the execution plan](implementation-plan.md).
