# Agent lab

The corpus harness ([README](README.md)) proves the server opens real files without crashing.
It does not tell whether an agent that only sees the tool list reaches the right answer, or how
many calls and how many bytes it spends getting there. This lab measures that, on real corpus
files, against answers that do not come from the server under test.

Two questions drive every measurement:

1. **Is the answer right?** If not, which layer made it wrong: the server, a tool description,
   a schema, an error message, or the model?
2. **Is the path short?** If a question can be answered in 3 calls, why did the agent take 5?

## What a task is

A task is one question about one or more corpus files, with everything needed to judge an
attempt:

| Field       | Meaning                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | Stable name, e.g. `uk-spend-top-supplier`                                                                                                                                                                       |
| `files`     | Corpus entries by `source`, `file` and `sha256`; a byte mismatch refuses the task                                                                                                                               |
| `knowledge` | How the file reaches the agent: `K0` not attached, `K1` attached, `K2` attached and named as the user sees it                                                                                                   |
| `level`     | Difficulty, `L1` to `L5` (see [Coverage](#coverage))                                                                                                                                                            |
| `cases`     | The corner-case ids the task exercises                                                                                                                                                                          |
| `question`  | The question as a user types it, in Turkish and in English                                                                                                                                                      |
| `answer`    | The expected answer as typed fields: `integer`, `decimal` and `percent` with their own tolerance, `text`, `date`, `month`, `localDateTime`; a `list`, `set` or `record` of them; or a `refusal` with its reason |
| `plan`      | The calls that answer the question at this knowledge level, each marked `discover` or `answer`, and how the answer is derived from their responses                                                              |

Questions are written the way a person types them in a chat. They never carry a file path, a
cell range, a column letter, an encoding or a separator; finding those is the agent's work and
what the lab measures. The file reaches the agent the way the product delivers it:

| Level | What the agent gets                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------- |
| `K0`  | No attachment. The question names a topic; the agent finds the file in the workspace                                      |
| `K1`  | The task's files are attached: the request carries their paths, as an upload does. The question names nothing inside them |
| `K2`  | Attached, and the question uses a name the user sees in Excel: a sheet tab or a column header as written                  |

`plan` is a hypothesis until phase 1 runs it and derives `answer`. Its steps start from what the
agent knows: with `K0`, `list_workbooks` is necessary; with an attachment, it is a wasted call;
with `K1`, the question names no column, so a read that shows the headers comes before an
aggregate that names one. Those calls are `discover` steps, and the `answer` steps alone are the
privileged plan of someone who already knows the sheet. A step with `expectError` is a call the
agent cannot avoid with what it was given, such as the first read of a Windows-1254 file.

`plan.derive` names where the answer is in the responses and what to compute from it: a cell by
JSON pointer, a row by a key that must be unique, a column or label/value pairs filtered by a
cell, and a closed set of operations (`sum`, `avg`, `percent`, `argmax`, `countNotIn`,
`dayFirst` and others in `src/agent/derive.ts`). A table read from a truncated response is
refused. A refusal task carries `plan.confirm` instead: the cell, match count or error code that
shows the file withholds, lacks or refuses the value; a `readOnly` task needs none.

Expected answers come from an oracle that reads the original bytes without the server: Python's
standard library (`csv`, and `zipfile` with `xml.etree` for SpreadsheetML, as in
`scripts/verify-rich-fixtures.py`) or a hand count recorded with the cell references it read.
An answer copied from a server response is never an oracle.

## Workspace

The lab copies every task's files into one workspace directory outside the repository, verifies
their digests and roots the server there. All tasks share that root, so a `K0` task has to find
its file among the others, as a user's agent would.

## Phases

### Phase 0 — task catalog

Pick the files, write the questions, compute the oracle answers and the ideal plans. The catalog
is complete when every case id in [Coverage](#coverage) is exercised by at least one task, every
one of the twelve tools appears in an ideal plan, every level and knowledge level appears, and
all four question/file language pairings appear.

Files are chosen from the corpus by the feature they carry, using the saved `describe_workbook`
and first-page `read_sheet` answers of the latest corpus run to find candidates, then reading
each candidate with the oracle before a question is written. Where the corpus has no real file
for a case, the case is listed under `uncovered` in the catalog with the reason, rather than
filled with an invented file; the catalog refuses an `uncovered` entry that a task exercises.

The catalog holds 83 tasks over 29 corpus files from Turkish, British and American open data
and three small CC0 CSV samples. By level: 3 `L1`, 14 `L2`, 31 `L3`, 26 `L4`, 9 `L5`; by
knowledge: 4 `K0`, 76 `K1`, 3 `K2`. The plans make 155 calls, 100 of them `answer` steps and 10
of those expected errors. Several files carry faults found while writing the oracles, and tasks keep them as they
are: a typed `TOPLAM` that is 1,000 above the sum of its rows, a grand total that disagrees with
its subtotals, headers that label the neighbouring column, a dashboard table whose cached
values cover one year of thirteen, and a row label repeated in the total, male and female blocks
of one sheet, with a value in the first and a suppression marker in the second. Two cases are
uncovered: `V9`, because the corpus's 1904-date-system workbooks hold no dates, and `R4`,
because no real file has a column the server reads as ambiguous.

A refusal answer has a reason: `notInFile` when the file has no such data, `suppressed` when the
file withholds the value with a marker such as `‡`, `ambiguous` when the file supports two
readings, `readOnly` for a change to the workbook and `limit` for a file over a server limit.

### Phase 1 — scripted runner (the baseline)

Run each plan through the real MCP SDK client against an in-process server, the way
`src/probe.ts` does, derive the answer from the responses and compare it with `answer` under the
grader's typed comparison. A task is `verified`, `planFailed` (an error other than the planned
one), `evidenceIncomplete` (the derivation's place is missing, not unique or truncated) or
`answerMismatch`. A mismatch is a server defect or a wrong task, never assumed to be either:
the oracle and the plan disagree, and one of them is wrong. The totals are the baseline the
model runs are compared with.

### Phase 2 — model runner

A model answers the same questions with nothing but the tool list. The runner is written
against a small model-host interface; its first implementation is Ollama's native `/api/chat`,
because that is the protocol that accepts a context window (`num_ctx`) and reports exact token
counts. Base URL, model name and an optional key come from the environment, never from the
repository.

- Tools are offered exactly as the server's `tools/list` returns them: name, description,
  input schema. The system prompt is short, fixed and identical for every task.
- The agent submits its answer through a lab-side `submit_answer` tool whose flat arguments
  follow the task's answer: `value`, `items` or `fields` typed as the answer is, an
  `explanation` that is never graded, or a `refusal` reason. Each grade has two axes. `protocol`
  says whether the value came in the form the tool asked for: a JSON number, a date as
  `yyyy-MM-dd`. `semantic` says whether it means the answer: a numeric literal is read whole and
  never pulled out of words, a decimal comma reads as a decimal, one separator before exactly
  three digits is ambiguous, text folds case under both Turkish and root rules, a zone on a
  local time is a different value, and a tolerance is the declared one. A run is correct when
  both hold.
- Each task runs several times at a fixed temperature, because one run says little about a
  sampled model. A call budget stops a run that loops.
- The full trace is kept: every request, tool call, tool response and the final answer.

One run is a cell of the matrix **task × question language × model × context window**. The
window axis asks how small a context still solves a task, and where an answer degrades.

#### Context accounting

Context is measured the same way on every request, before and after it is sent:

- **Estimate before sending.** The whole serialized request (system prompt, tool schemas,
  every message and tool response) is counted as `ceil(bytes / 3) + 256` tokens, and a reply
  reserve of `min(4096, window / 4)` is added. A request whose estimate exceeds the window is
  not sent and the run ends as `preflightRefused`. Ollama drops the head of an oversized prompt
  without an error, so a request it would truncate is never measured as an answer.
- **Count after the reply.** Input, cached input and output tokens are Ollama's
  `prompt_eval_count`, `prompt_eval_cached_count` and `eval_count`. A reply without them is
  unknown, never zero: a run's totals are unknown when any of its requests lacks them.
- **Check the window the host used.** `/api/ps` reports the context length the model is
  actually loaded with; a run on a host holding a different window does not count toward
  accuracy.

Metrics per run:

| Metric                 | Definition                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `correct`              | The submitted value means `answer` and comes in the form the tool asks for                      |
| `grade`                | The two axes apart: `protocol` (form) and `semantic` (meaning)                                  |
| `outcome`              | `answered`, `noAnswer`, `callBudget`, `preflightRefused`, `providerContextError` or `hostError` |
| `budgetReached`        | The run spent its call budget and was offered `submit_answer` alone                             |
| `calls`                | Tool calls made; `tools/list`, initialization and `submit_answer` are excluded                  |
| `excessCalls`          | `calls` minus the plan's calls, discovery included                                              |
| `responseBytes`        | UTF-8 bytes of tool responses that entered the model's context                                  |
| `toolErrors`           | Calls that returned an error envelope, by error code                                            |
| `invalidArgs`          | Calls the schema refused                                                                        |
| `recoveryCalls`        | Calls between the first error and the next successful call                                      |
| `requests`             | Model requests in the run                                                                       |
| `failedRequests`       | Request attempts the host failed, retried or not                                                |
| `toolSchemaTokens`     | Estimated tokens of the tool list alone, paid on every request                                  |
| `peakInputTokens`      | Largest `prompt_eval_count` of the run: how full the window got                                 |
| `peakEstimatedTokens`  | Largest pre-send estimate, to compare the estimate with the count                               |
| `inputTokens`          | Sum of `prompt_eval_count` over the run                                                         |
| `cachedInputTokens`    | Sum of `prompt_eval_cached_count`: the share the host did not recompute                         |
| `requestsWithoutUsage` | Requests whose reply carried no token counts                                                    |
| `outputTokens`         | Sum of `eval_count`                                                                             |
| `windowUse`            | `peakInputTokens / window`                                                                      |

#### Scenarios a run went through

A tag says a task is meant to meet a scenario; the run's trace says whether it did. The error
and recovery scenarios are read from the server's answers (`src/agent/exercised.ts`): `R1`,
`R2`, `R3`, `R6` and `Z3` from the error code of a call, `R4` from an ambiguity warning and `R5`
from a truncated answer. Each is an episode of one file, judged by its first occurrence on that
file: a later successful call on the same file (the same sheet for `R1` and `R3`, the same tool
for `R6`), `columns` naming the warned column after `R4`, that response's cursor or an aggregate
of the file after `R5`, and for `Z3` a `limit` refusal with no further call to the file. A call
on another file never counts as recovery. The report lists, per scenario, the tagged runs, how
many of them met it, how many untagged runs met it and how many episodes recovered, because an
agent that reads the headers first never meets `unknown_column`, and a tag alone would count
that run as coverage.

These are natural encounters: how often a run meets a problem and what it does next. Whether an
agent recovers once a given problem has happened is a separate, forced measurement, where a real
file's real error is handed to the agent as the result of a first call it did not choose; such
tasks are kept apart from the natural ones.

### Phase 3 — root causes and fixes

Every wrong answer and every excess call is tagged with one cause:

| Cause            | Example                                                                        |
| ---------------- | ------------------------------------------------------------------------------ |
| `server`         | The tool returned a wrong value; phase 1 should already have caught it         |
| `description`    | The description sent the model to an unnecessary discovery call                |
| `schema`         | An argument the model needed was missing, unclear or refused                   |
| `error-message`  | An error did not say how to recover, so the model guessed                      |
| `response-shape` | The answer was in the response but hard to find, or the response was too large |
| `model`          | The tools and texts were adequate and the model still went wrong               |

Fixes go to `@sezzlee/excel-mcp` as ordinary pull requests, each re-measured with the same
tasks and models before and after. A fix is kept when it improves the metric it targets
without making another task worse.

### Phase 4 — more languages

Turkish and English are part of the catalog from phase 0. This phase asks the same tasks in
Hindi, Chinese and Russian. The files and answers do not change, so a difference isolates how
the question's language affects the model's choice of tool, column and locale.

## Coverage

### Levels

| Level | Name     | What makes it this hard                                                                             |
| ----- | -------- | --------------------------------------------------------------------------------------------------- |
| `L1`  | Direct   | File, sheet and columns are known and clean; one call answers it                                    |
| `L2`  | Navigate | The file, sheet or feature has to be found first, or a structure tool is needed                     |
| `L3`  | Trap     | One property of the file makes the obvious call wrong: a title band, a totals row, a decimal comma  |
| `L4`  | Compound | Several traps, several steps, a language mismatch, an error to recover from or a large file at once |
| `L5`  | Beyond   | Today's tools cannot answer it in one place, or the honest answer is that the file does not say     |

`L5` tasks measure the gap the next capabilities are meant to close: the agent's path and
answer are recorded today, so the same task shows the effect of a new tool later.

### Case ids

**Discovery**

| Id   | Case                                                                      |
| ---- | ------------------------------------------------------------------------- |
| `D1` | The file has to be found by topic among unrelated files                   |
| `D2` | The file has to be told apart from near-identical names (month, district) |
| `D3` | The answer is on a sheet other than the first                             |
| `D4` | The data sits on a hidden or very hidden sheet                            |
| `D5` | Chart sheets, or more sheets than a page of listing shows                 |
| `D6` | An Excel table or a defined name addresses the data                       |

**Layout**

| Id   | Case                                                 |
| ---- | ---------------------------------------------------- |
| `S1` | A title band or notes above the header row           |
| `S2` | A header spread over several rows or merged cells    |
| `S3` | Totals or subtotal rows inside the data              |
| `S4` | Footnotes or source lines below the data             |
| `S5` | Years or months as columns instead of rows           |
| `S6` | Duplicate header names                               |
| `S7` | Labels merged down a column, so rows below are blank |
| `S8` | Several blocks or tables on one sheet                |
| `S9` | A header that does not describe its column's content |

**Values**

| Id    | Case                                                                   |
| ----- | ---------------------------------------------------------------------- |
| `V1`  | Numbers stored as text with a decimal comma or a dotted thousands mark |
| `V2`  | Identifiers that look numeric: leading zeros, long digit runs          |
| `V3`  | Missing-value markers such as `-`, `..`, `x`, `c`, `n/a`               |
| `V4`  | Dates stored as text, with a day/month order to infer                  |
| `V5`  | Turkish month names in the data                                        |
| `V6`  | Currency, percent and parenthesized negative amounts                   |
| `V7`  | Formulas with and without cached values                                |
| `V8`  | Formula errors such as `#DIV/0!` and `#N/A`                            |
| `V9`  | The 1904 date system                                                   |
| `V10` | Long or multi-line text cells                                          |

**Encoding and CSV**

| Id   | Case                                                                |
| ---- | ------------------------------------------------------------------- |
| `E1` | Windows-1254 Turkish text that fails as UTF-8                       |
| `E2` | UTF-16 or a byte order mark                                         |
| `E3` | Semicolon, tab or pipe separators                                   |
| `E4` | A `sep=` declaration line                                           |
| `E5` | Text that a spreadsheet would run as a formula (`=`, `+`, `-`, `@`) |

**Scale and limits**

| Id   | Case                                                                       |
| ---- | -------------------------------------------------------------------------- |
| `Z1` | More rows than a page; paging instead of aggregating is the expensive path |
| `Z2` | More groups than one answer returns                                        |
| `Z3` | A file over a size or resource limit; the honest answer names the limit    |

**Question shape**

| Id    | Case                                                                                            |
| ----- | ----------------------------------------------------------------------------------------------- |
| `Q1`  | One value of one record                                                                         |
| `Q2`  | A total or a count                                                                              |
| `Q3`  | Several filter conditions at once                                                               |
| `Q4`  | A ranking, including ties                                                                       |
| `Q5`  | A median or a percentile                                                                        |
| `Q6`  | A breakdown by month or year                                                                    |
| `Q7`  | A two-way breakdown (pivot)                                                                     |
| `Q8`  | A distinct count                                                                                |
| `Q9`  | Absence or negation: which items have none                                                      |
| `Q10` | A comparison across sheets of one workbook                                                      |
| `Q11` | A comparison across files with the same layout                                                  |
| `Q12` | A structure question: validation lists, formatting rules, images, charts, merges, tables, names |
| `Q13` | The file does not contain the answer                                                            |

**Beyond today's tools**

| Id   | Case                                                                   |
| ---- | ---------------------------------------------------------------------- |
| `X1` | A derived column: quantity × price, per capita, a share                |
| `X2` | A join of two files on a key                                           |
| `X3` | A what-if scenario                                                     |
| `X4` | Recalculating a formula whose inputs changed or whose cache is missing |
| `X5` | A change to the workbook; the server is read-only                      |

**Language**

| Id   | Case                                                                        |
| ---- | --------------------------------------------------------------------------- |
| `T1` | Turkish question, Turkish file                                              |
| `T2` | Turkish question, English file: the agent maps `tedarikçi` to `Supplier`    |
| `T3` | English question, Turkish file: the agent maps `subsidy` to `Destek Tutarı` |
| `T4` | English question, English file                                              |
| `T5` | Turkish case folding in a search: `İSTANBUL`, `istanbul`, `ı`, `I`          |
| `T6` | A data value named in the other language: `March` asked, `Mart` stored      |

**Recovery**

| Id   | Case                                                                    |
| ---- | ----------------------------------------------------------------------- |
| `R1` | `unknown_column` from a wrong header row, recovered with `headerRow`    |
| `R2` | `undecodable_text`, recovered with an explicit `encoding`               |
| `R3` | `ambiguous_header_row`, recovered by naming the row                     |
| `R4` | An ambiguous number or date warning, recovered with `columns`           |
| `R5` | A truncated answer, continued with a cursor or replaced by an aggregate |
| `R6` | Arguments the schema refuses, corrected from the validation message     |

## Scope

The lab measures the server's own tool surface. A product that narrows schemas or renames
tools in front of the server has a different surface and needs its own measurement.

No corpus file, workspace, trace or result is committed. Task definitions, the oracle scripts
and the runners are. Results are kept outside this repository, because traces grow with
every run, and conclusions are recorded in
[FINDINGS.md](FINDINGS.md).

## Running

The catalog is `src/agent/catalog.json`; `src/agent/task.ts` validates it, including every
planned call against the tool's own input schema. Run from the repository root:

```bash
node packages/lab/excel-lab/src/agent/catalog-cli.ts --coverage
node packages/lab/excel-lab/src/agent/catalog-cli.ts --workspace /path/outside/repo --corpus "$SEZZLEE_CORPUS"
python3 -I packages/lab/excel-lab/scripts/agent-oracle.py verify --corpus "$SEZZLEE_CORPUS"
python3 -I packages/lab/excel-lab/scripts/agent-oracle.py dump "$SEZZLEE_CORPUS/<source>/<file>" --rows 20
node packages/lab/excel-lab/src/agent/baseline-cli.ts --out /path/outside/repo --corpus "$SEZZLEE_CORPUS" [--only <task,...>]
```

`baseline-cli.ts` builds the workspace, runs every plan against the built server (build
`@sezzlee/excel-mcp` first) and derives each answer; every task must be `verified` before a model
run means anything. `derive-proposal-cli.ts` helps write a new task's derivation: it runs the
plan and lists every place in the responses that holds the answer, which is a list of candidates
to choose from, not a derivation. The full report is `baseline.json` in the output directory.

```bash
SEZZLEE_AGENT_LAB_OLLAMA_URL=http://host:11434 node packages/lab/excel-lab/src/agent/agent-cli.ts \
  --out /path/outside/repo --corpus "$SEZZLEE_CORPUS" --model qwen3.8:latest \
  [--window 65536] [--thinking product|field|drop] [--languages tr,en] [--runs 3] \
  [--levels L1,L2] [--only <task,...>] [--budget 15] [--resume]
```

`agent-cli.ts` runs one condition, one model and one window, against the built server. It first
writes `manifest.json`: the digests of the catalog, the oracle, the lab sources and the server
build, the server's tool list, the system prompt, the grader version, the host's model digest and
Ollama version, and the generation settings. A directory holds one manifest; `--resume`
continues it only while every field matches, and names the fields that changed otherwise. Each
trial is a task revision, a language and a repetition; `runs.jsonl` gets one record per trial and
`events.jsonl` every request, failed attempt, tool result and submission as it happens. A failed
request is retried on its own, up to three times, and only for a transport failure; a request
the host refuses for its window ends the trial as `providerContextError`. The call budget holds
within a batch, and a run that spends it gets one last request offering `submit_answer` alone.
The model's thinking is carried as the product's provider carries it, appended to the reply's
text (`--thinking product`); `field` sends it in Ollama's `thinking` field and `drop` leaves it
out. `SEZZLEE_AGENT_LAB_OLLAMA_KEY` adds a bearer token. Requests carry `keep_alive` and the
window as `num_ctx`, as the product's do. The user message lists the task's files for `K1` and
`K2` under "Attached files"; `K0` gets the question alone. The grading rules are pinned by
[test/agent-grade.spec.ts](test/agent-grade.spec.ts).

A run counts toward accuracy unless the host failed it, the preflight refused it, the host
refused the window, or the host held the model with another window (`src/agent/eligibility.ts`);
reports count those apart.

```bash
node packages/lab/excel-lab/src/agent/regrade-cli.ts <run directory>
node packages/lab/excel-lab/src/agent/report-cli.ts <run directory> --out <report.md>
node packages/lab/excel-lab/src/agent/compare-cli.ts <before directory> <after directory> \
  --out <compare.md> [--spec packages/lab/excel-lab/experiments/<id>.json]
```

`regrade-cli.ts` grades saved runs again under the current catalog and grader and writes
`grades-<version>.jsonl` beside them, leaving the runs as they were. `report-cli.ts` writes the
readable report: accuracy, meaning and form by language, level, knowledge and outcome, the
scenarios each run went through, and every run with its calls, wrong answers first. Both read
directories saved before the manifest existed.

`compare-cli.ts` pairs two directories one to one by task, language and repetition, refuses a
duplicate, and lists every run it leaves out with the reason: a changed task, a changed question,
a run either side cannot count. Every metric is computed on the same pairs. Accuracy is reported
with the runs only one side got right, an exact McNemar test and a 90% interval from resampling
whole file families. With `--spec`, the comparison follows a pre-registered experiment
(`src/agent/experiment.ts`): it refuses a manifest difference the experiment does not declare as
its treatment, and applies its rule, superiority, or not worse within a margin while cheaper,
and its expected mechanism. An experiment is committed under `experiments/` before its runs.

```bash
node packages/lab/excel-lab/src/agent/replay-cli.ts <run directory> --out /path/outside/repo --corpus "$SEZZLEE_CORPUS"
```

`replay-cli.ts` replays a run's recorded tool calls, in order and with their recorded arguments,
against the current server build, without a model, and reports each call as the same, changed
at a JSON pointer, or blocked. The modification time, the workspace root and cursor tokens are
not compared; a cursor is followed instead, bound to the token the replayed server returned for
the call that produced the recorded one, and a continuation whose source no longer pages is
blocked by that change rather than counted as a new one. Replay answers what a new build returns
for calls an agent already made; it does not say what a model would do with the new answers,
which takes a model run.

`--coverage` lists the case ids, tools, levels, knowledge levels and language pairings no task
exercises yet. `verify` recomputes every answer from the corpus bytes with a per-task oracle
function and fails on a mismatch, a task without an oracle or an oracle without a task.
`dump` prints a file's sheets and cells as the oracle reads them, for writing questions.

## Status

| Phase | State       |
| ----- | ----------- |
| 0     | Done        |
| 1     | Done        |
| 2     | Done        |
| 3     | Running     |
| 4     | Not started |
