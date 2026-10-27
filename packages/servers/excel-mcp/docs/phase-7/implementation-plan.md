# Phase 7 implementation and verification plan

Post-review closure: all required gates were renewed after current-main integration and pivot/lookup fixes. See [review-closure.md](review-closure.md) for the completed review coverage and [acceptance-record.json](acceptance-record.json) for final runtime/native/model and live-docs evidence. Earlier measurements below are historical unless explicitly renewed there.

Status, 2026-10-27: implementation and acceptance are complete for all eight approved F7 families and their documented profiles. The [status](implementation-status.md) and [acceptance record](acceptance-record.json) bind local corpus/model/application/schema/resource checks and full native/installed-package CI to the final runtime. PR #73 remains for user review; publication and consumer rollout are separate.

## Recorded decisions

- The user approved F7-01–F7-08, in this order: F7-06 → F7-03 → F7-04 → F7-05 → F7-01 → F7-02 → F7-07 → F7-08.
- Finish Excel authoring and its acceptance in the existing [PR #73](https://github.com/sezzlee/mcp/pull/73), alongside Phases 4–6. Review and merge belong to the user. Publication and private consumer rollout remain separate.
- Reuse immutable versions, the preservation editor, bounded MCP responses, bulk jobs and existing lab runners. Never edit an input workbook or a retained output in place.
- Use deterministic acceptance first; use the available Ollama/Qwen model for Turkish and English tool-use acceptance after output correctness is established.
- Support is explicit and bounded. The profiles below define the accepted support within the approved families. Record any later scope change here before claiming acceptance.

## Earlier-phase obligations

| Origin      | Obligation in Phase 7                                                                                                     | Owner and evidence                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Phases 0–1  | Preserve literal text, blank, number, boolean and date semantics; a leading equals sign is not implicit formula intent.   | P7-01/P7-10: typed template inputs, independently inspected raw cells and reopened values.                          |
| Phases 0–3  | Preserve sandbox authority, payload/resource limits, immutable publication and retained-version branching.                | Every operation uses the existing pipeline; P7-09/P7-10 cover rejection, source hashes and late failure.            |
| Phases 2–3  | Copy/move, sheet rename/delete and row/column edits must update affected advanced references or refuse atomically.        | P7-02–P7-09: feature-specific dependency matrices, including rules, anchors, names, chart series and pivot sources. |
| Phase 3     | Unknown OOXML parts survive supported unrelated edits; presence is not proof that affected dependencies can be rewritten. | P7-09: byte comparisons for retained parts and explicit refusals for unsupported affected markup.                   |
| Phase 4     | Dependent reports have one publication boundary; independent reports keep their retry/recovery semantics.                 | P7-08/P7-10: integrate through existing bulk finish and publication, including final-step failures and retry.       |
| Phase 5     | Tables, styles, merge policies, ordinary/structured formulas and formatting-only cache retention remain valid.            | P7-09/P7-10: fresh presentation, table, bulk and continuation regression.                                           |
| Phase 6     | Formula calculation, chart cache and pivot refresh are distinct operations and states.                                    | P7-05/P7-06/P7-09: current/stale/refused cache checks and calculated-version continuation.                          |
| Every phase | Historical evidence does not accept the changed runtime.                                                                  | P7-00/P7-10/P7-11: fresh checks, runtime identity, model/application/native/packed acceptance.                      |

The earlier explicit deferrals of charts, pivots and conditional-format authoring now enter this phase. Phase 2 transpose is a separate deferred capability, not required by these families. Existing macro-enabled/encrypted/protected edit refusals must be reconciled explicitly in P7-07; removing a blocker alone is never support. No npm publication, website deployment or private runtime rollout is implied.

## Support profiles

| Family                       | Initial authoring profile                                                                                                                                                                                      | Required continuation and bounds                                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F7-06 Names/templates        | Create, replace and remove static A1 defined names with workbook or worksheet scope; fill named rectangular targets with typed values. Preserve template content outside the declared target.                  | Resolve scope and quoted sheet names; reject ambiguous names, reserved built-ins, name/cell collisions, formulas/unions/external names outside the profile. Enforce shape and overwrite intent. Names must participate in structural reference handling and Phase 6 calculation.                  |
| F7-03 Validation             | List rules, numeric/date/text-length comparisons and bounded custom formulas; explicit blank, prompt and error settings. Create/replace/remove a rule at a declared range.                                     | Stable targeting and overlap policy; rules extend only through explicit range changes or supported structural edits. Check Excel list/formula limits. Do not claim the server enforces Excel's interactive input UI on every write.                                                               |
| F7-04 Conditional formatting | Comparison and expression rules with bounded differential font/fill formatting; explicit application range, rule identity, priority and stop-if-true.                                                          | Add/replace/remove and reorder rules without altering unrelated rules; maintain differential-style references. Unsupported extensions, icon sets and data bars need distinct support decisions.                                                                                                   |
| F7-05 Content                | Internal/HTTPS hyperlinks, plain legacy cell notes and embedded PNG/JPEG images with cell anchors and bounded dimensions/bytes.                                                                                | Explicit replacement/removal; preserve other relationships and drawings. No network image download, active content or HTML execution. Threaded comments and arbitrary drawing objects are outside the initial profile.                                                                            |
| F7-01 Charts                 | Real OOXML column/bar/line/pie charts; bounded direct cell-range series, title and placement. Create/update/remove; retain unrelated existing charts.                                                          | Series category/value lengths and types validated; caches distinguish current literal values from stale/unsupported formulas. Supported source/structure changes update references or refuse. Existing chart variants are not silently rewritten into the supported profile.                      |
| F7-02 Pivots                 | Real OOXML PivotTable with cache definition/records and materialized results; bounded worksheet source, categorical row groups and sum/count/min/max measures. Explicit create and refresh/source replacement. | Actual pivot parts and independently correct results are both required. Define blank/type/error/group ordering and totals semantics. No claim that an ordinary aggregate grid is a pivot. Date grouping, slicers, external connections and OLAP remain separate decisions.                        |
| F7-07 Protection             | Explicit sheet/workbook protection authoring and supported removal; preserve unlocked/locked cell behavior through the supported profile.                                                                      | Never bypass password protection or mislabel protection as encryption. Define how an intentionally protected output can be continued. Macros are never executed; encrypted, signed and macro-enabled editing remain explicit refusals unless a separately verified preservation profile is added. |
| F7-08 Recurring reports      | Fill named targets, replace the complete prior dataset, maintain tables/formulas/rules/content, refresh supported chart/pivot sources and produce a new report version.                                        | Explicit report period/source identity, replay and source-change policy; no duplicate rows or stale old tail. Reuse existing job receipts and idempotency/recovery boundaries. Do not invent a second transaction engine.                                                                         |

## Architecture and owners

- Contracts: extend `src/authoring/` with strict discriminated feature schemas. Derive TypeScript types and flat MCP wire schemas from those schemas. The existing presentation wire contract cannot grow into an unvalidated optional-field bag.
- Mutation: feature modules under `src/format/`, called by the existing preserved-workbook dispatcher. Reuse `presentation-xml.ts`, namespace-aware XML scanning, relationship helpers and the package writer. Keep format vocabulary out of generic cores.
- Inspection: extend `format/edit-inspection.ts` and preparation descriptions only when the feature profile is actually editable. Preparation and execution must use the same support decision.
- Preservation: include names, rule formulas/ranges, chart series/anchors, image/note anchors, hyperlinks and pivot source/cache dependencies in the operation-specific structural matrix.
- Tools: reuse `create_workbook`, `prepare_edit`, `edit_workbook` and bulk finish where contracts fit. Add a separate inspection/refresh tool only when existing tools cannot express the operation honestly. Read-only mode must never expose mutation.
- Verification: feature owner tests at the public MCP boundary; independent fixture/oracle code in `packages/lab/excel-lab`. No production export or injection hook solely for tests.
- Documentation: package support/reference and generated public tool docs must describe actual registered schemas. Read `apps/docs/CLAUDE.md` before regenerating the docs application.

## Ordered work packages

| Package | Work                                                                                                                                        | Acceptance before closure                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P7-00   | Record decisions/carryovers; inspect source and existing fixtures; record baseline revision and available corpus/model/application tooling. | Exact commands, passed/failed/skipped results and environment availability. No inherited test count represented as fresh evidence.                                                      |
| P7-01   | F7-06 strict named-target contracts, static defined-name lifecycle and typed template fill.                                                 | Workbook/sheet scope, collisions, quoted names, dimensions, overwrite, retention, calculation and structural reference cases.                                                           |
| P7-02   | F7-03 validation lifecycle and explicit extension.                                                                                          | Reopen rules independently; list/numeric/date/custom examples, replacement/removal, new rows, overlap, limits and unsupported extension refusal.                                        |
| P7-03   | F7-04 conditional-format lifecycle, differential styles and ordering.                                                                       | Priority/stop behavior, independent rule/style inspection, replacement/removal and structural ranges/formulas.                                                                          |
| P7-04   | F7-05 links, notes and embedded image lifecycle.                                                                                            | Reopen links/notes/images independently; media hashes, anchors, relationships, remove/replace, bounds and unsafe input refusals.                                                        |
| P7-05   | F7-01 chart lifecycle, direct source references and cache policy.                                                                           | Real chart parts, expected series/title/anchor, source replacement and structural references; literal/calculated/stale cache cases and unsupported existing chart preservation.         |
| P7-06   | F7-02 pivot lifecycle, source refresh, cache records and independent aggregation.                                                           | Real pivot/cache package validated; expected group values/totals; changed source, empty/mixed data, refresh, limits and unsupported-source refusal.                                     |
| P7-07   | F7-07 explicit protection profile and continuation policy.                                                                                  | Independently reopened protection/locked cells; intentional removal, protected input refusal, no silent password bypass, encryption/signature/macro refusals.                           |
| P7-08   | F7-08 composed period report through the existing job pipeline.                                                                             | Two periods, shorter replacement, replay, source change, retained-version branch and late-failure atomicity; formulas/charts/pivots are current or explicitly pending.                  |
| P7-09   | Cross-feature dependency and preservation closure.                                                                                          | Create → author → fill/transfer → structural edit → bulk → calculate → refresh → reopen. Unsupported affected dependencies refuse before publication; source/retained hashes unchanged. |
| P7-10   | Final deterministic, corpus, resource, independent application/schema and TR/EN Qwen acceptance.                                            | All F7 requirements map to executable evidence; real files independently graded; exact runtime identity, resource measurements and honest skipped/failed records.                       |
| P7-11   | Generated references, final native/installed-package CI and PR #73 update.                                                                  | Build/types/lint/format/boundaries pass; required platform/Node matrix and packed smoke gates green. Push to the existing branch; no merge/publication/deployment.                      |

## Verification sequence

Run from the vendor repository root through Turbo. Start with the affected owner files and one worker. A final whole-suite run follows implementation; the user's request explicitly includes tests and Qwen where useful.

1. Focused baseline: presentation, calculation, preserved editing, edit preparation and bulk jobs; existing lab regression separately.
2. Each new contract has an independent expected result and a credible regression. Extend existing scenario tables where they own the behavior; avoid duplicate implementation-level tests.
3. New OOXML is checked with a second reader and targeted raw-part assertions. Use Open XML SDK schema validation and LibreOffice/application output checks where available. Successful ZIP creation or application opening alone is insufficient.
4. Run the configured existing corpus for reader/transfer/preservation regression. Keep licensed inputs and generated workbooks outside the public repository.
5. Run final build/check-types/lint for changed packages and affected dependencies, repository boundaries, formatting, full Excel/lab tests and independent oracle self-tests. Use `--maxWorkers=1` for Vitest runs.
6. Extend existing lab runners with deterministic expert-report scenarios, then TR/EN Qwen trials. Record model name/digest, endpoint availability, request settings and whole-output grading. Sanitize all public acceptance records.
7. Bind final deterministic/model/application evidence to the same built runtime. Run required native and installed-tarball CI, then update PR #73 title/body around the final delivered scope.

## Acceptance record and completion checklist

Maintain `implementation-status.md` and a sanitized `acceptance-record.json` as evidence appears. Include revision, dirty-source/runtime hashes, commands, counts, skipped/failed checks, model identity, output oracles, platform/package runs and remaining release boundaries. Do not commit endpoint addresses, credentials, licensed corpus files or full model traces.

- [x] F7-01 charts implemented and accepted.
- [x] F7-02 pivots implemented and accepted.
- [x] F7-03 validation implemented and accepted.
- [x] F7-04 conditional formatting implemented and accepted.
- [x] F7-05 content implemented and accepted.
- [x] F7-06 names/templates implemented and accepted.
- [x] F7-07 protection profile implemented and accepted.
- [x] F7-08 recurring reporting implemented and accepted.
- [x] Earlier-phase obligations and cross-feature preservation accepted on the changed runtime.
- [x] Deterministic, independent, corpus, resource and TR/EN model gates recorded.
- [x] Generated docs and native/installed-package CI green; changes pushed to PR #73 for user review.
