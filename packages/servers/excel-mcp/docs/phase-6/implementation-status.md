# Phase 6 implementation status

Status, 2026-10-27: implementation present; final regression, model and CI gates are being recorded. No closed acceptance claim yet.

## Implemented contract

`calculate_workbook` is an explicit writing-mode operation using an exact source version. It recomputes supported formulas from input cells, tracks actual cell/range/name dependencies, diagnoses cycles and unavailable dependencies, and publishes typed numeric/string/boolean/error caches in a new immutable `.xlsx`. Ordinary edits invalidate those caches again. Source and retained versions remain unchanged.

The package-owned `bounded-excel-v1` parser/evaluator adds no runtime dependency. The [plan](implementation-plan.md) and package README enumerate its 21 supported functions, reference/value semantics, explicit exclusions, resource ceilings and conservative recalculation metadata. It does not claim general Excel function compatibility or persistent incremental caching. Calculation follows a bulk publication as a separate operation; no hidden calculation step was added to bulk groups.

## Independent expected values

The calculation owner has 64 fixed known-answer formula cases, plus dependency/version continuation, table preservation, scoped names, shared-cache clearing, protection/profile refusals, date-system and resource-budget controls. The optional LibreOffice owner recalculates **uncached** source formulas independently, then reads the results with SheetJS. It covers the 56 common cases. Stale input caches are deliberately used in the production evaluator tests; they are deliberately absent from the independent recalculation input so LibreOffice cannot merely echo them.

Eight Excel-specific cases are excluded from LibreOffice agreement, rather than reported as passing agreement:

| Formula/case                                                   | Accepted Excel result    | Independent basis                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1<TRUE`                                                       | `TRUE`                   | Separate HyperFormula 3.5.0 probe using its `TRUE()` syntax.                                                                                                                                                                                                                                                                                 |
| `SUM("7",TRUE)`                                                | `8`                      | Separate HyperFormula probe; direct arguments differ from reference arguments.                                                                                                                                                                                                                                                               |
| `SUM(Inputs!C1)` for a referenced boolean                      | `0`                      | Separate HyperFormula probe.                                                                                                                                                                                                                                                                                                                 |
| `COUNT(Inputs!A1:C3)` with numeric text, booleans and an error | `3`                      | [Microsoft COUNT semantics](https://support.microsoft.com/en-us/excel/functions/count-function) and a separate HyperFormula probe with explicitly preserved text input.                                                                                                                                                                      |
| `COUNTIF` on boolean cells with `TRUE` or `"TRUE"` criteria    | `1` in each of two cases | Separate HyperFormula probes with typed booleans.                                                                                                                                                                                                                                                                                            |
| `COUNTIF` numeric equality over a number and numeric text      | `2`                      | Separate HyperFormula probe with explicitly preserved numeric text.                                                                                                                                                                                                                                                                          |
| `0^0`                                                          | `#NUM!`                  | [Independent Excel reproducer hosted by Microsoft](https://learn.microsoft.com/en-us/answers/questions/4850441/excel-formula-bug-00-gives-num?forum=msoffice-msoffice_excel-mso_winother-mso_2010&page=2). LibreOffice and HyperFormula return `1`; neither is an oracle for this Excel exception. No native Excel UI session was performed. |

HyperFormula was used only in a separate local validation workspace, under its validation license setting. It is not a production dependency, package devDependency, published artifact or bundled source. A validator's advertised compatibility is not treated as universal proof.

Operator precedence and basic coercion follow [Microsoft's operator reference](https://support.microsoft.com/en-us/excel/calculation-operators-and-precedence-in-excel); logical reference handling follows [Microsoft AND semantics](https://support.microsoft.com/en-us/excel/functions/and-function). The independent checks exposed numeric COUNTIF coercion and binary ROUNDUP/ROUNDDOWN boundary regressions. The intended failing rounding case was observed before the fix (`ROUNDUP(0.14,2)` returned `0.15`) and passes after correction. Formula Xstring escapes are decoded once for calculation while original formula XML is preserved.

## Model and output checks

The calculation lab uses the existing Ollama host/protocol with explicit thinking disabled, a 65,536-token window, temperature zero, 4,096 output tokens and a ten-turn budget. It tests ordinary calculation, edit → calculate, and unsupported/circular reporting in Turkish and English. A separate Saxes/ZIP oracle checks formula text, cache types, values and absence of unavailable caches; corrupted-output controls ensure it rejects wrong values, wrong types, changed/missing/duplicate cells and stale caches. Final model claims and source hashes are checked separately.

The first model run completed five of six cases. The Turkish partial-result case exhausted its call budget while repeatedly reading cells and did not produce a final answer. The harness now states that an explicitly reported partial calculation completes that reporting task and reports budget exhaustion directly. Final rerun evidence remains separate from that first failure.

## Gates still to record

- Full Excel/lab regression using the recovered Phase 5 corpus and independent calculation oracle.
- Final build, types, lint, formatting and boundary checks.
- Final scripted/model output package validation and exact source identity.
- PR #73 final native/packed CI results. No merge or publication.

Licensed corpus files, endpoint addresses, full model traces and generated output workbooks remain outside the public repository. Phase 7 remains deferred at the user's request.
