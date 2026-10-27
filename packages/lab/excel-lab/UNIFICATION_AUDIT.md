# Excel lab unification audit

## Status and evidence boundary

This is a **source-backed Phase A audit**, completed by the measurements in
[Measured on the current main](#measured-on-the-current-main); it is not
acceptance of the unified lab. The audited server and lab snapshot is
`585676cf46a1ef271ab218871bae6a5bea8a90fb`, the merge of PR #74. All source links
below name that commit. The PR head and merge were compared and had no file
changes between them.

No harness was replaced. The source inventory was written in an environment with
Node 22.16.0, no `pnpm` and no registry access, so it executed nothing. The
scripted baselines, oracle verification and catalog measurements in
[Measured on the current main](#measured-on-the-current-main) were run afterwards
in a provisioned checkout. No model trial or migration-parity comparison has run
yet, and no model host was contacted.

The inventory below is derived from source. An advertised tool is not an
exercised tool, a fixture-setup call is not an agent call, and a scripted
assertion is not a model result. What remains open is listed in
[Closing the audit](#closing-the-audit). This document does not authorize
deleting a harness or starting model trials; each harness is deleted only after
its parity comparison passes.

## Measured on the current main

These measurements were taken after the audit was written, on this branch after merging `main` at `bd929bb`. Excel 0.13.0 is published from that `main`. The corpus is the local copy that `SEZZLEE_CORPUS` names; its 40 catalog files and both Apache editing fixtures match their pinned SHA-256. Raw outputs stay outside the repository. No model host was contacted.

### Scripted baselines before any migration

Every existing scripted baseline passes. This is the "before" side of every later parity comparison.

| Harness                         | Command                                        | Verdict                                                                                        | Wall time | Peak RSS |
| ------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------- | -------- |
| Editing, transfer and authoring | `src/edit-agent-cli.ts --out … --corpus …`     | 16 of 16                                                                                       | 1.7 s     | 252 MiB  |
| Bulk                            | `src/bulk-agent-cli.ts --out …`                | 7 of 7                                                                                         | 1.3 s     | 239 MiB  |
| Expert                          | `src/expert-agent-cli.ts --out …`              | 1 of 1 (scripted four-chart report)                                                            | 0.4 s     | 205 MiB  |
| Calculation                     | `src/calculation-agent-cli.ts --out …`         | 6 of 6 (three scenarios, run once per language because scripted and model modes are exclusive) | 0.7 s     | 233 MiB  |
| Reading plans                   | `src/agent/baseline-cli.ts --out … --corpus …` | 104 of 104 `verified`; 196 calls, 121 answer calls, 591,004 response bytes                     | 63.5 s    | 702 MiB  |
| Reading oracle                  | `scripts/agent-oracle.py verify --corpus …`    | 104 passed, 0 failed, 0 missing, 0 unused                                                      | —         | —        |
| Retained result scenario        | `pnpm turbo run result-scenario … -- --out …`  | `passed`                                                                                       | 8.6 s     | —        |

The protected editing fixture `workbookProtection_worksheet_protected.xlsx` was copied without a pinned digest. It is now pinned to `95a35c2e…7fb8f7cd` in `src/edit-agent-cli.ts`, and the `protected` scenario passes with the check.

### What each catalog costs

`src/lab/measure-cli.ts` lists the real `tools/list` of a read-mode and a write-mode server and prices each condition the way the runner sends it: description bytes, compact input-schema bytes, the whole host-side function object, and an estimate of `ceil(bytes / 3)` tokens. The catalog total uses the same `estimateTokens` the Ollama preflight applies, including its template reserve. These are byte-derived estimates, not tokenizer counts.

| Condition                          | Tools | Bytes   | Estimated tokens |
| ---------------------------------- | ----- | ------- | ---------------- |
| Read mode, full                    | 13    | 35,249  | 12,006           |
| Write mode, full                   | 24    | 373,359 | 124,709          |
| Editing harness `editing` catalog  | 5     | 160,809 | 53,859           |
| Editing harness `transfer` catalog | 4     | 44,762  | 15,177           |
| Bulk harness                       | 5     | 99,265  | 33,345           |
| Expert harness                     | 3     | 155,247 | 52,005           |
| Calculation harness                | 4     | 84,886  | 28,552           |

The full write catalog does not fit a 65,536-token window before a single message. Four tools carry two thirds of it:

| Tool               | Whole object bytes | Description | Input schema | Estimated tokens |
| ------------------ | ------------------ | ----------- | ------------ | ---------------- |
| `edit_workbook`    | 77,579             | 6,192       | 71,285       | 25,860           |
| `prepare_edit`     | 76,472             | 5,185       | 71,186       | 25,491           |
| `prepare_bulk_job` | 47,000             | 2,890       | 43,995       | 15,667           |
| `run_bulk_job`     | 45,524             | 1,420       | 43,995       | 15,175           |
| `create_workbook`  | 37,546             | 3,849       | 33,593       | 12,516           |

`edit_workbook` and `prepare_edit` repeat the same change schema, as do `prepare_bulk_job` and `run_bulk_job`. In the two edit tools, 36,834 bytes of each schema are the 0.13 `source` and `header` alternatives of `write_cells` and `insert_rows`; in `create_workbook`, 18,438 bytes. The transfer selection schema, with its column readings, is inlined at every place a block may take a source. Every other tool costs under 15 KB. This is a measured cost, not a cause: whether it changes agent outcomes is for the context-window axis of the night run.

### Error envelopes and recovery hints

The shared conversion adds no recovery text of its own (`packages/cores/mcp-core/src/tools.ts`), so a hint exists only where an error is constructed with one. A static count of direct `new SezzleeExcelError(…)` sites in `excel-mcp/src` finds 36 codes and 239 sites, 101 of them with a recovery argument. The largest codes are `invalid_argument` (81 sites, 29 with recovery), `resource_limit` (39, 14), `invalid_range` (17, 3) and `corrupt_workbook` (13, 5). Errors raised through local helpers such as `invalidPresentation` are not in this count, and a site is not proof that a request reaches it; observed wire errors are recorded per trial by the unified runner.

### Reading plans

The 104 reading plans make 196 calls. Plan lengths are 0 (one `readOnly` refusal), 1 (27 plans), 2 (61), 3 (13) and 4 (2). By calls and tasks: `read_sheet` 88/84, `aggregate_sheet` 70/59, `describe_workbook` 17/17, `find_in_sheet` 9/9, `list_workbooks` 4/4, `get_data_validations` 2/2, and one task each for `get_tables`, `get_conditional_formats`, `get_charts`, `get_images`, `profile_sheet` and `get_merged_ranges`. `query_result` has no reading task. The most common authored transitions are `read_sheet → aggregate_sheet` (53), `describe_workbook → read_sheet` (12), and `aggregate_sheet → read_sheet` and `find_in_sheet → read_sheet` (6 each). These are authored plans, not observed model behavior.

## Harness inventory

### Reading: `src/agent/agent-cli.ts`

**Tasks:** Catalog tasks with K0-K2, L1-L5, case IDs, attached files, TR/EN questions and typed answers. The documentation reports 104 tasks over 40 files; this audit did not recount the catalog.

**Grading:** Typed submission grading against catalog answers; the documented original-byte oracle is `scripts/agent-oracle.py`. The scripted plan derives an answer separately.

**Host:** Shared `OllamaHost`; one model/window condition, serial task/language/repetition loops, resume and manifest comparison. The CLI does not invoke the baseline itself.

**Evidence:** `buildManifest`, condition hash, append-only runs/events, numbered attempts and language summary. Whole saved JSONL files are read into memory during resume. [runner][read-cli] [task model][task-model] [lab design][agent-doc] [oracle commands][agent-running]

### Editing/transfer: `src/edit-agent-cli.ts`

**Tasks:** 16 scenario keys; seven come from `authoring-scenarios.ts`. Explicit paths/ranges and an exact source version are supplied. Ordinary and authoring scenarios use different budgets.

**Grading:** Python `edit-agent-oracle.py` or `authoring-agent-oracle.py` checks selected output bytes; additional source/retained-version, lifecycle and final-claim checks live in the harness. Protection/refusal scenarios require no published output.

**Host:** Shared host and assistant-message adapter, but a separate model loop, completion policy and reminders. Separate editing and transfer catalogs. A new server is created for each scenario/language/mode.

**Evidence:** Selected implementation hashes, source/script/host/oracle/scenario hashes, controls and catalog names; `tools.json`, JSONL trace plus a retained in-memory trace and final JSON copy. [setup][edit-head] [dispatch][edit-middle] [grading][edit-tail]

### Bulk: `src/bulk-agent-cli.ts`

**Tasks:** Seven scenario keys: update, join, replace, retry, blocked, report and independent report. The README's earlier five-scenario enumeration is incomplete.

**Grading:** Python `bulk-agent-oracle.py` plus retry identity, durable status, atomic publication, partial-success and final-claim assertions.

**Host:** Shared host, separate 16-call/16-turn loop and reminders; five offered tools; allowlist checked before dispatch. Scripted mode precedes model mode but failures do not gate entry to model mode.

**Evidence:** Hand-selected implementation/native hashes, script/host/claims/oracle hashes, generation controls; tool catalog, selected output, incremental logs and duplicate full trace. [setup][bulk-head] [dispatch][bulk-middle] [grading][bulk-tail] [README][readme-bulk]

### Expert: `src/expert-agent-cli.ts`

**Tasks:** One report scenario. The scripted path creates four chart types; the model prompt asks for one column chart. These are not identical scenario contracts.

**Grading:** Python `expert-oracle.py` parses the output; the harness asserts fixed values and features. Optional application and visual oracles run only when selected.

**Host:** Shared host; separate fixed-profile loop, three offered tools and enforced call/allowlist checks. Scripted then TR/EN; caught failures do not stop the next language. Fixture creation is not a model task.

**Evidence:** Sorted JavaScript runtime digest and module count, host/controls; full registered-catalog byte sizes, traces, selected version and oracle/application evidence. Full-catalog sizes are not the cost of the three-tool model catalog. [setup][expert-head] [grading][expert-middle] [outcomes][expert-tail]

### Calculation: `src/calculation-agent-cli.ts`

**Tasks:** Three scenarios, each in TR/EN: calculate, edit then calculate, and unavailable formulas. `--model` selects the model path instead of the scripted path.

**Grading:** `calculation-oracle.ts` checks saved ZIP/XML independently of the calculation response, with fixed expected values/formulas; final JSON claims are additional checks. This is TypeScript/Saxes, not Python.

**Host:** Shared host; four allowed tools, ten turns, fixed controls. There is no per-tool-call counter inside a model batch. Host comes from `--url` or a loopback default, not the requested host environment variable.

**Evidence:** Runtime digest before/after the run, host/controls, traces, output paths and final protocol results. [runner][calculation-cli] [oracle contract][calculation-doc]

### Retained results: `src/result-scenario.ts`

**Tasks:** Scripted scenario schema, generated ledger and optional external scenario; inline aggregate, retained aggregate, exact query and complete paging.

**Grading:** Independently authored arithmetic/rows, including continuation order and counts. No model-provided answer is used.

**Host:** No model host; real MCP client and read-mode server. This is a baseline/scenario runner, not an agent harness.

**Evidence:** Scenario digest, source version, commit label, call durations and text/envelope bytes, process peak RSS and external request/response files. [setup][result-head] [checks][result-tail]

### Authoring: `src/authoring-scenarios.ts`

**Tasks:** Seven bilingual prompt/change definitions consumed by the edit harness.

**Grading:** The edit harness selects the authoring Python oracle.

**Host:** No independent model loop. Do not count these seven tasks twice.

**Evidence:** Scenario-source digest is included by the edit harness. [scenarios][authoring] [setup][edit-head]

### Scenario identities that must survive migration

The edit set is `authoring_format`, `authoring_formula`, `authoring_table`,
`authoring_lifecycle`, `authoring_continuation`, `authoring_merge`,
`authoring_unsupported`, `transfer_range`, `transfer_records`,
`transfer_aggregate`, `write`, `copy`, `clear`, `rows`, `restore` and `protected`
([declaration][edit-head]). The bulk set is `update`, `join`, `replace`, `retry`,
`blocked`, `report` and `independent_report` ([declaration][bulk-head]). The expert
key is `expert_report` ([result][expert-tail]); calculation has `calculate`,
`edit_calculate` and `unavailable` ([loop][calculation-cli]).

Preserve namespaced identities, not merely a count of passing tasks. In particular,
ordinary editing can stop after producing an output, authoring adds completion and
claim checks, bulk reports add atomic/partial-status requirements, and calculation
requires a final answer even after a correct artifact exists. Those are observable
contract differences in the harnesses cited above.

### Shared infrastructure versus duplicated infrastructure

The wire client is **already shared**: the four writing harnesses import
`OllamaHost`, and they reuse `assistantMessage` and `toolSpecsOf`. Replacing that
adapter independently in every migrated task would introduce another protocol.
`ModelHost` already provides identity, chat, loaded-window inspection, typed
failure classes and unknown usage/timing states ([host interface][host]).

What is duplicated is orchestration: CLI parsing, fixture/workspace lifetime,
MCP connection lifetime, local manifest assembly, trial loops, call budgets,
completion rules, trace serialization, output selection and oracle invocation
([reading][read-cli], [editing][edit-middle], [bulk][bulk-middle],
[expert][expert-head], [calculation][calculation-cli]). The reading runner is the
reuse candidate for resume/condition identity; the writing harnesses contribute
artifact and publication assertions that cannot be replaced with answer grading.
The retained scenario contributes exact paging checks and explicit byte/timing
measurement boundaries ([retained report][result-tail]).

## Source-confirmed migration risks

### A01: tool guidance is a treatment, not neutral infrastructure

The edit system prompt explicitly prescribes `prepare_transfer` then
`transfer_data`, and source selection through `prepare_edit` or
`create_workbook_version`. Its user message also receives the exact version.
Bulk supplies versions and headers. Expert supplies source values and a prescribed
calculation/protection order ([edit prompt][edit-head], [edit loop][edit-tail],
[bulk loop][bulk-tail], [expert prompt][expert-middle]).

These trials cannot establish unaided tool-list discoverability. Keep their
existing prompts for parity, then give new discovery trials a separate prompt
condition and manifest identity. Do not pool coached and uncoached accuracy or
use coached prepare/execute adjacency as evidence that two tools must be merged.

### A02: baseline-first ordering is not a fail-closed gate

Editing and bulk iterate scripted mode before model mode, but catch a failed
scenario and defer the failure exit status until the outer loops finish. Expert
also catches a failed scripted report and continues. Calculation chooses either
the scripted or model path. The reading CLI does not run the baseline before
constructing its host ([edit loops][edit-middle], [edit outcome][edit-tail],
[bulk loops][bulk-head], [bulk outcome][bulk-tail], [expert outcome][expert-tail],
[calculation][calculation-cli], [reading][read-cli]).

The night-run gate must be a distinct stage. Its test should use a failing real
baseline and a dumb host stub, and assert that the stub receives **zero requests**,
including identity requests. A printed baseline failure followed by model trials
must not pass this test.

### A03: hiding a tool must also prevent dispatch

Editing filters the advertised catalog but dispatches returned tool names without
checking membership in that catalog. Bulk and expert check membership; calculation
also checks its allowlist ([edit loop][edit-tail], [bulk dispatcher][bulk-middle],
[expert loop][expert-middle], [calculation loop][calculation-cli]).

A hidden-tool experiment based only on the edit harness's filtering would not
exclude an unadvertised call. The unified dispatcher must record and refuse it
without forwarding it to MCP. This is a lab condition guard, not a server change.

### A04: the calculation budget is a turn budget

The calculation manifest says `callBudget: 10`; the loop limits ten turns but
executes every tool call in each returned batch. This differs from bulk's
per-dispatch counter and expert's per-call check ([calculation][calculation-cli],
[bulk][bulk-middle], [expert][expert-middle]). A fixed wire reply containing more
calls than the remaining budget is a required runner control. Record turns,
requested calls, dispatched calls and refused-over-budget calls separately.

### A05: version-object pass-through has a concrete schema disagreement

`workbookVersionSchema` is `{filePath, versionId}`, while
`workbookVersionIdSchema` is a 64-character hexadecimal **string**.
`edit_workbook.source` accepts the object; `prepare_edit.expectedVersion` uses
the string schema ([versions][versions], [edit schema][edit-schemas],
[writing definitions][writing-tail]). The writing description nevertheless says
that the read version can be passed as source "or expectedVersion"
([source-frame advice][writing-head]).

The task brief's unchanged-object claim for `expectedVersion` is therefore not
what the pinned schema declares. The repository contract wins: bind
`read.version` to `edit_workbook.source`, or bind `read.version.versionId` to
`prepare_edit.expectedVersion` alongside the file path. Add a separately labelled
forced-invalid-object/recovery case before proposing any description or schema
change. The discrepancy is source-confirmed; the actual wire error and recovery
have **not** been executed here. It is not yet evidence that one particular layer
should be changed.

### A06: old read-only answers need an applicability boundary

The reading model requires a typed answer, at least one input file and a plan
whose tool names validate against the reading definitions. It has no artifact
answer, dynamically bound retained handle, or write/refusal contract. The
`readOnly` refusal is exempt from a confirmation plan. The documentation's `X5`
case explicitly describes a read-only server ([task model][task-model],
[case definitions][agent-cases], [reading tool-name owner][read-definition-tail]).

Do not carry an old `readOnly` expected answer into a write-enabled full catalog
and call the resulting difference a regression. Preserve the old condition and
introduce a revised task/condition with its own oracle and revision. Empty-input
creation tasks and previous-result bindings require an explicit model extension.

### A07: oracle migration must preserve more than a success boolean

Calculation's documented byte oracle uses TypeScript/Saxes, while the requested
new-oracle rule specifies Python standard-library parsing or a recorded hand
count. Expert uses a Python snapshot plus TypeScript assertions. Editing and bulk
also add publication, branching or final-claim assertions outside Python
([calculation acceptance][calculation-doc], [expert checks][expert-middle],
[edit checks][edit-tail], [bulk checks][bulk-tail]).

Retain these existing checks for parity. A Python calculation companion must have
independent known-answer/corruption controls and match existing verdicts before
replacing the old oracle. Keep artifact correctness, interaction/path compliance,
refusal/publication safety and answer-claim compliance as separately visible
results; a good preparation receipt or convincing prose cannot pass an artifact.

### A08: catalog size and bounded memory need condition-specific evidence

Expert records the full registered catalog but offers only three tools. Editing
and bulk retain every trace event in an array as well as writing JSONL. Reading
resume reads complete run/event files and waits indefinitely for an unreachable
host ([expert catalog][expert-head], [expert model catalog][expert-middle],
[edit trace][edit-middle], [bulk trace][bulk-middle], [reading resume][read-cli]).

Measure the actual offered catalog separately from the registered surface and the
lab submission tool. Stream historical logs for bounded-memory resume. Apply the
night deadline to host readiness, retries, requests, tools and oracle processes;
checking it only between trials cannot bound the existing readiness loop. Verify
these controls with fixed stub responses and an injected clock, not a live model.

### A09: preparation tools do not all have the same contract

`prepare_bulk` returns `executionAvailable: false` and validates keys/target
policy; it is not simply the executing twin of `run_bulk_job`.
`prepare_bulk_job` and `run_bulk_job` share a job schema, while `get_bulk_job`
addresses durable completion by job ID ([bulk schemas][bulk-schemas],
[job schemas][bulk-job-schemas], [tool descriptions][writing-head]). Preserve
these distinctions in hypotheses and in error/refusal reporting.

## Tools by harness and scenario family

This is a **static exposure matrix**, not the completed tools-by-exercised-task
matrix. `O` means offered to the model; `F` means fixture setup only; `S` means a
scripted call in the inspected runner; `-` means not offered/called there.
`R` uses the read-mode tool list, but individual reading plans were not enumerated
in this audit. No cell claims a newly passing trial.

`E` is the edit/authoring scenario family, `T` the three transfer scenarios, `B`
the seven bulk scenarios, `X` expert report, `C` the three calculation scenarios,
and `S` the retained-result scenario. The declarations and dispatchers above are
the evidence for those columns; [reading definitions][read-definitions] and
[writing definitions][writing-head] distinguish catalog families.

| Tool                      | R   | E   | T   | B   | X   | C   | S   |
| ------------------------- | --- | --- | --- | --- | --- | --- | --- |
| `list_workbooks`          | O   | -   | -   | -   | -   | -   | S   |
| `describe_workbook`       | O   | O   | O   | O   | -   | O   | S   |
| `read_sheet`              | O   | O   | O   | O   | -   | O   | -   |
| `profile_sheet`           | O   | -   | -   | -   | -   | -   | -   |
| `get_merged_ranges`       | O   | -   | -   | -   | -   | -   | -   |
| `get_data_validations`    | O   | -   | -   | -   | -   | -   | -   |
| `get_tables`              | O   | -   | -   | -   | -   | -   | -   |
| `get_conditional_formats` | O   | -   | -   | -   | -   | -   | -   |
| `get_images`              | O   | -   | -   | -   | -   | -   | -   |
| `get_charts`              | O   | -   | -   | -   | -   | -   | -   |
| `aggregate_sheet`         | O   | -   | -   | -   | -   | -   | S   |
| `query_result`            | O   | -   | -   | -   | -   | -   | S   |
| `find_in_sheet`           | O   | -   | -   | -   | -   | -   | -   |
| `create_workbook`         | -   | -   | -   | -   | F   | F   | -   |
| `edit_workbook`           | -   | O   | -   | -   | O   | O   | -   |
| `prepare_edit`            | -   | O   | -   | -   | O   | -   | -   |
| `create_workbook_version` | -   | O   | -   | -   | -   | -   | -   |
| `prepare_transfer`        | -   | -   | O   | -   | -   | -   | -   |
| `transfer_data`           | -   | -   | O   | -   | -   | -   | -   |
| `prepare_bulk`            | -   | -   | -   | -   | -   | -   | -   |
| `prepare_bulk_job`        | -   | -   | -   | O   | -   | -   | -   |
| `run_bulk_job`            | -   | -   | -   | O   | -   | -   | -   |
| `get_bulk_job`            | -   | -   | -   | O   | -   | -   | -   |
| `calculate_workbook`      | -   | -   | -   | -   | O   | O   | -   |

There is no offered agent task for `create_workbook` or `prepare_bulk` in these
harness catalogs. An accidental unadvertised edit-harness call would not change
that conclusion. `list_workbooks`, `profile_sheet`, the six metadata tools,
`aggregate_sheet`, `query_result` and `find_in_sheet` have no offered writing-agent
scenario in the inspected catalogs. `describe_workbook` and `read_sheet` are
available in writing scenarios; availability alone does not establish their use
in an ideal or observed path. The reading catalog still needs task-by-task
enumeration before assigning per-tool "no reading task" labels.

### Required top-level argument inventory

These are source-schema requirements, not a captured `tools/list` JSON Schema.
Nested union requirements, defaults, refinements and complete optional-key
expansion remain part of the pending surface measurement. A field being optional
does not imply that every combination of optional fields is valid.

**`list_workbooks`.** Required: None. Optional: `subdirectory`, `pattern`, `maxResults`; [reading definitions][read-definitions]

**`describe_workbook`.** Required: `filePath`. Optional: `includeDefinedNames`, `delimiter`, `encoding`; [reading definitions][read-definitions]

**`read_sheet`.** Required: `filePath`. Optional: Sheet/selection/range, typing hints, paging, value/merge/header/hyperlink options and CSV options; [reading definitions][read-definitions]

**`profile_sheet`.** Required: `filePath`. Optional: Sheet/selection/range, header/typing/merge options, row/column sample limits and CSV options; [reading definitions][read-definitions]

**`get_merged_ranges`.** Required: `filePath`. Optional: `sheetName`; [reading definitions][read-definitions-tail] [shared schema][read-schemas]

**`get_data_validations`.** Required: `filePath`. Optional: `sheetName`; [reading definitions][read-definitions-tail] [shared schema][read-schemas]

**`get_tables`.** Required: `filePath`. Optional: `sheetName`; [reading definitions][read-definitions-tail] [shared schema][read-schemas]

**`get_conditional_formats`.** Required: `filePath`. Optional: `sheetName`; [reading definitions][read-definitions-tail] [shared schema][read-schemas]

**`get_images`.** Required: `filePath`. Optional: `sheetName`, `kind`; [reading definitions][read-definitions-tail]

**`get_charts`.** Required: `filePath`. Optional: `sheetName`, `chartId`, `maxPoints`; [reading definitions][read-definitions-tail]

**`aggregate_sheet`.** Required: `filePath`, `metrics`. Optional: Selection, retained mode, grouping/pivot/sets, predicates, typing, derived metrics, ordering and preview controls; [reading definitions][read-definitions-tail]

**`query_result`.** Required: `resultId`. Optional: `columns`, `where`, `offset`, `maxRows`; [reading definitions][read-definitions-tail]

**`find_in_sheet`.** Required: `filePath`, `query`. Optional: Sheet/selection/header/typing, matching, range, limits and CSV options; [reading definition][read-definition-tail]

**`create_workbook`.** Required: `sheets`. Optional: `changes`; [writing definitions][writing-create]

**`edit_workbook`.** Required: `source`, `changes`. Optional: None at top level; [writing definitions][writing-tail]

**`prepare_edit`.** Required: `filePath`, `changes`. Optional: `expectedVersion` is a digest string; [edit schema][edit-schemas]

**`create_workbook_version`.** Required: `filePath`. Optional: `expectedVersion`; [writing definitions][writing-tail]

**`prepare_transfer`.** Required: `filePath`, `selection`. Optional: None at top level; [writing definitions][writing-head]

**`transfer_data`.** Required: `transfer`, `target`. Optional: None at top level; [writing definitions][writing-head]

**`prepare_bulk`.** Required: `source`, `target`, `operation`. Optional: None at top level; [bulk schema][bulk-schemas]

**`prepare_bulk_job`.** Required: `job`. Optional: None at top level; [job schema][bulk-job-schemas]

**`run_bulk_job`.** Required: `job`. Optional: None at top level; [job schema][bulk-job-schemas]

**`get_bulk_job`.** Required: `jobId`. Optional: None at top level; [job schema][bulk-job-schemas]

**`calculate_workbook`.** Required: `source`. Optional: None at top level; [writing definitions][writing-head]

Description, input-schema and whole-tool bytes and their token estimates are now
measured for every tool and condition in [What each catalog costs](#what-each-catalog-costs).
Exhaustive reachable error codes per tool remain unmeasured; the static
construction count in [Error envelopes and recovery hints](#error-envelopes-and-recovery-hints)
is an upper view of what the source can raise, not of what a tool reaches.

Capture them from the real MCP `tools/list` result in write mode, and separately
capture the read-mode catalog and each offered condition. Count UTF-8 bytes of the
unescaped description and compact serialized schema separately; also record the
whole tool object and the actual host-side function wrapper. Label byte-derived
token estimates explicitly and retain the estimation method. Exact
model-tokenizer costs require an identified tokenizer; the existing preflight
estimate is not such a tokenizer ([context accounting][agent-doc]).

Classify error envelopes, schema-validation failures, `kind: blocked` preparations
and partial-job outcomes separately. The writing handlers contain admission/input
budget errors, and preparation schemas contain blocker/conflict payloads
([writing guards][writing-tail], [edit preparation][edit-schemas],
[bulk preparation][bulk-schemas]). A constructor without an explicit hint does not
by itself prove that the final wire error has no hint; the shared error conversion
and a real response must also be inspected. Do not label a schema rejection as a
schema _design defect_ solely because it rejected invalid arguments.

### Adjacency evidence available without execution

The bulk scripted path calls `prepare_bulk_job` before `run_bulk_job`; `blocked`
ends at preparation, and `retry` repeats execution then reads `get_bulk_job`
([scripted path][bulk-tail]). Transfer scripts call `prepare_transfer` then
`transfer_data`; restore follows an edit with `create_workbook_version`
([transfer path][edit-middle], [restore path][edit-tail]). Expert scripts use
edit, calculate, then protection edit ([expert path][expert-middle]). Retained
scripts use aggregate then one or more result queries ([retained path][result-tail]).

These are authored paths, not observed model transition frequencies. The complete
reading-plan adjacency counts and per-scenario ideal lengths are not yet extracted.
None of these examples establishes that a pair _always_ occurs across the lab.

## Excel 0.13 chain gaps

The evidence below is limited to the inspected lab runners and their explicit
assertions. It is **not** a claim that the server has no unit tests for these
features. "Missing" means a dedicated lab chain with the required binding and
independent verdict has not been identified here; catalog enumeration and the
remaining oracle/test read-through must finish before coverage is closed.

**Read version into editing.** Writing harnesses supply fixture/version hashes. Missing: A read-origin binding, correct object versus digest use, and output checked against the read bytes.

**Stale version then recovery.** Exact versions are used in existing harnesses. Missing: Controlled external mutation after a read; genuine `file_changed`; fresh read and successful corrected edit, with old/new byte hashes.

**Validation ranges into removal.** Expert authors a literal rule. Missing: `get_data_validations` output reused unchanged in `remove_validation`, plus independent preservation/removal checks.

**Defined-name scope and target into editing.** Expert authors a workbook-scoped name. Missing: Read-derived workbook/sheet scope, `sheetName` and `range` passed into define/delete operations.

**Chart references into editing.** Expert authors literal chart series. Missing: Read-derived series references passed into `set_chart`, with independent formulas/cache/provenance checks.

**Image name into removal.** Expert authors a named image. Missing: Read-derived image `name` passed into `remove_image`, retaining other drawings.

**Numeric conditional-format priority.** Expert authors priorities in its scripted report. Missing: Read-derived numeric priority used for replace/remove and independently checked order.

**Source-frame restructure and placements.** Edit has a simple blank-row insertion scenario. Missing: One request combining deletion, insertion and rename; moved-target assertions and a follow-up using actual returned placements.

**Inserted `{row}` formulas.** Existing authoring fills formulas in new sheets. Missing: Insert into an existing maintained table; exact relocation/formulas; fill-equivalent control and the non-fill 128/129 boundary.

**Retained aggregate/query.** Scripted ledger checks groups, filtering, projection and paging. Missing: Agent tasks for pivots, per-grouping-set handles, cross-column predicates and a narrowed preview with `totalColumns`.

**Retained result into output.** The retained runner is read-only; writing catalogs omit aggregate/query tools. Missing: Retain then write through `source`, validate output bytes and source receipts, and distinguish reference writes from literals.

**Range/records/aggregate block sources.** Transfer scenarios use the prepare/transfer pair. Missing: Each source kind through create/write/insert blocks, optional version pinning and header/selection semantics.

**Copy refusal then recovery.** No dedicated case identified in the inspected writing scenarios. Missing: Real three-consecutive-row refusal, recovery through the named source, no publication on refusal, separate natural and forced trials.

**Read total then formula summary.** Authoring creates Calc and Summary from supplied literals. Missing: Read an existing workbook, derive the total independently, then write source-referencing summary formulas.

**Same report with/without retained input.** No matched agent condition identified. Missing: Identical output oracle and task intent; retained availability as an axis; producer cost separated from write-only and end-to-end cost.

**Correction across two files.** Bulk join/replace already reads two inputs. Missing: A correction with the requested selected outputs and preservation checks for both files; a join alone is not that task.

Evidence: [edit scenarios][edit-head], [scripted edits][edit-middle],
[authoring definitions][authoring], [bulk scenarios][bulk-head],
[expert report][expert-middle], [calculation][calculation-cli],
[retained generator][result-head] and [retained checks][result-tail].
The 0.13 source-input refinements and receipt fields are in
[edit schemas][edit-schemas] and [version/source receipts][versions].

## Merge and split hypotheses, not recommendations

A hidden-tool condition tests necessity under the remaining surface. It does not
implement or validate a merged/split replacement. Retain a full-catalog control,
matched task/oracle revisions, language, model digest, context window, thinking
configuration and repetition. Record excluded/preflight/host-invalid trials
separately from accuracy. A preflight refusal caused by catalog size is still
relevant context-feasibility evidence, not an incorrect workbook.

### H1: `prepare_edit` adds avoidable cost when the read already pins a version.

Support: Hiding preparation preserves artifact/refusal correctness while reducing calls under neutral prompts.

Counterevidence: Dry-run scope/blocker tasks need its output; direct execution worsens recovery or publication safety. Current coached adjacency is not supporting evidence.

### H2: `prepare_transfer`/`transfer_data` are redundant for value export now that blocks accept sources.

Support: The source-block path handles range, records and aggregate selections with equal correctness and lower total cost.

Counterevidence: Existing-target mapping, blanks, header semantics or preservation tasks lose capability; invalid/stale selections recover worse.

### H3: `prepare_bulk_job` is unnecessary for agents that execute a complete job.

Support: Hidden preparation retains atomic and independent-job correctness with fewer calls.

Counterevidence: Inspection-only tasks, blocker explanations or error recovery materially worsen.

### H4: The bulk family has redundant analysis but distinct durable execution/status responsibilities.

Support: `prepare_bulk` ablation leaves explicit key-analysis tasks correct; status ablation remains recoverable after a lost reply/restart.

Counterevidence: Focused analysis is uniquely useful, or hiding `get_bulk_job` loses durable status/partial recovery. Do not treat `prepare_bulk` as an executing twin.

### H5: `create_workbook_version` confuses edit selection more often than it helps.

Support: Hiding it removes false preparation-as-completion without hurting restore/branch tasks.

Counterevidence: Exact original-byte restoration/export needs it; nonempty editing is not an equivalent substitute.

### H6: `profile_sheet` can be replaced by describe/read without losing reusable typing decisions.

Support: Matched locale/ambiguous-data tasks retain correctness at lower total context/call cost.

Counterevidence: Sampling/type confidence or reusable column plans yield better accuracy or fewer recovery calls.

### H7: A separate `query_result` is unnecessary for retained analysis.

Support: Beyond-preview, projection and exact-filter tasks retain correctness and efficiency when it is hidden.

Counterevidence: Snapshot-only answers, grouping-set handles or stable full paging cannot be reproduced. Reading a changed workbook is not an equivalent query.

### H8: The edit or bulk schemas combine operations that agents confuse and should be split.

Support: Repeated, operation-specific wrong-kind/argument episodes and context pressure persist under neutral prompts across languages/repetitions.

Counterevidence: Errors disappear with ordinary recovery or are not stable across conditions. Ablation alone cannot establish that a proposed split improves outcomes.

The present source evidence establishes authored dependencies and potential
confounds, not model success rates, redundancy or root causes. The six cause
labels already exist in [AGENT_LAB.md][causes]. Automatically extract facts such as
error code, blocked operations, invalid argument paths, publication state and the
next same-task call. Leave causal attribution for review unless independent
baseline/oracle and trace evidence make it certain. A wrong final answer alone is
not proof of a `model` cause.

## Parity ledger and closure requirements

**Reading agent/baseline.** Replaced: no. Before/after parity: not run. Retain; original corpus and oracle verification remain prerequisites.

**Edit/transfer/authoring.** Replaced: no. Before/after parity: not run. Retain all 16 scenarios and both byte oracles; pinned external fixtures are needed.

**Bulk.** Replaced: no. Before/after parity: not run. Retain all seven scenarios and publication/retry/final-claim assertions.

**Expert.** Replaced: no. Before/after parity: not run. Retain; distinguish scripted four-chart and model one-chart contracts.

**Calculation.** Replaced: no. Before/after parity: not run. Retain TS oracle and final-claim checks pending independently tested migration.

**Retained result scenario.** Replaced: no. Before/after parity: not run. Retain as scripted evidence; do not relabel it agent acceptance.

### Closing the audit

The following are unfinished requirements, not completed measurements:

1. Finish the required source read-through: all `src/agent/*`, the complete catalog,
   `FINDINGS.md`, Python oracle implementations and their known-answer controls,
   the server README/unreleased changelog, and source-frame planner. The source
   links above cover the inspected sections only; they do not imply this entire
   list was read.
2. Done for catalog cost: every tool and condition is priced from the real
   `tools/list`. Still open: reachable errors and blocker variants per tool,
   which the unified runner records from observed trials.
3. Done for reading plans (usage and transitions above) and for the writing
   harnesses, whose scripted calls are listed in the inventory. Observed model
   transitions come from the night run.
4. Done for the "before" side: every existing scripted baseline and the reading
   oracle pass. Per-scenario before/after parity is produced when each harness
   moves to the unified runner, and no harness is deleted before it.

The subsequent unified runner must also preserve attachment knowledge levels and
language pairs, independent artifact grading, separate forced-error trials,
strict catalog dispatch, per-call budgets and external-only outputs. A single
active in-process server with serial trials must not leak retained handles,
copy-refusal state, stale mutations or generated outputs across trials. Resuming
an interrupted trial must recreate its retained handles through its producer
calls, not trust handles from a previous server instance. These are acceptance
requirements for later implementation, not claims that such a runner exists.

There is **no new unified night command or executable matrix schema in this
change**. Consequently there is no measured smoke/full-matrix GPU duration and no
new morning report to interpret. A one-hour wall-clock cap would be a budget,
not an estimate that a matrix completes in one hour. Do not substitute a loop over
legacy model CLIs: their baseline gates, budgets, prompts, manifests and host
configuration differ as documented above.

The existing repository validation entry points remain:

```sh
pnpm turbo run check-types lint --filter=@sezzlee/excel-lab
pnpm turbo run test --filter=@sezzlee/excel-lab
pnpm turbo run format:check
```

They are listed for verification in a provisioned checkout, not reported as having
run in the inspection environment. This audit changes no server behavior, task
expectation, oracle or harness.

[read-cli]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/agent/agent-cli.ts#L1-L330
[task-model]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/agent/task.ts#L150-L325
[agent-doc]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/AGENT_LAB.md#L15-L190
[agent-cases]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/AGENT_LAB.md#L300-L365
[causes]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/AGENT_LAB.md#L202-L225
[host]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/agent/host.ts#L1-L163
[edit-head]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/edit-agent-cli.ts#L1-L250
[edit-middle]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/edit-agent-cli.ts#L251-L500
[edit-tail]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/edit-agent-cli.ts#L501-L850
[bulk-head]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/bulk-agent-cli.ts#L1-L230
[bulk-middle]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/bulk-agent-cli.ts#L231-L470
[bulk-tail]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/bulk-agent-cli.ts#L471-L800
[readme-bulk]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/README.md#L23-L45
[expert-head]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/expert-agent-cli.ts#L1-L270
[expert-middle]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/expert-agent-cli.ts#L271-L620
[expert-tail]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/expert-agent-cli.ts#L621-L675
[calculation-cli]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/calculation-agent-cli.ts#L1-L400
[calculation-doc]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/CALCULATION.md#L1-L28
[result-head]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/result-scenario.ts#L1-L260
[result-tail]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/result-scenario.ts#L261-L366
[authoring]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/src/authoring-scenarios.ts#L1-L350
[read-definitions]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/servers/excel-mcp/src/tools/definitions.ts#L1-L220
[read-definitions-tail]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/servers/excel-mcp/src/tools/definitions.ts#L221-L510
[read-definition-tail]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/servers/excel-mcp/src/tools/definitions.ts#L511-L590
[read-schemas]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/servers/excel-mcp/src/tools/schemas.ts#L1-L120
[writing-head]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/servers/excel-mcp/src/tools/writing.ts#L70-L152
[writing-create]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/servers/excel-mcp/src/tools/writing.ts#L145-L170
[writing-tail]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/servers/excel-mcp/src/tools/writing.ts#L170-L340
[edit-schemas]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/servers/excel-mcp/src/tools/edit-schemas.ts#L1-L138
[versions]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/servers/excel-mcp/src/platform/versions.ts#L14-L103
[bulk-schemas]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/servers/excel-mcp/src/tools/bulk-schemas.ts#L1-L175
[bulk-job-schemas]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/servers/excel-mcp/src/tools/bulk-job-schemas.ts#L300-L390
[agent-running]: https://github.com/sezzlee/mcp/blob/585676cf46a1ef271ab218871bae6a5bea8a90fb/packages/lab/excel-lab/AGENT_LAB.md#L365-L399
