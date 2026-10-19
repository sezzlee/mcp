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

| Field         | Meaning                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`          | Stable name, e.g. `uk-spend-top-supplier`                                                                      |
| `files`       | Corpus entries by `source`, `file` and `sha256`; a byte mismatch refuses the task                              |
| `knowledge`   | How the file reaches the agent: `K0` not attached, `K1` attached, `K2` attached and named as the user sees it  |
| `level`       | Difficulty, `L1` to `L5` (see [Coverage](#coverage))                                                           |
| `cases`       | The corner-case ids the task exercises                                                                         |
| `question`    | The question as a user types it, in Turkish and in English                                                     |
| `answerShape` | What the agent must submit: a number, an ordered list, a set, text, or a refusal                               |
| `answer`      | The expected answer and how to compare it (exact, numeric tolerance, set equality)                             |
| `oracle`      | How the answer was obtained, independently of `@sezzlee/excel-mcp`                                             |
| `plan`        | The shortest call sequence we believe answers the question at this knowledge level; a step may expect an error |

Questions are written the way a person types them in a chat. They never carry a file path, a
cell range, a column letter, an encoding or a separator; finding those is the agent's work and
what the lab measures. The file reaches the agent the way the product delivers it:

| Level | What the agent gets                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------- |
| `K0`  | No attachment. The question names a topic; the agent finds the file in the workspace                                      |
| `K1`  | The task's files are attached: the request carries their paths, as an upload does. The question names nothing inside them |
| `K2`  | Attached, and the question uses a name the user sees in Excel: a sheet tab or a column header as written                  |

`plan` is a hypothesis until phase 1 runs it and it returns `answer`. The knowledge level
matters because the same question has different shortest paths: with `K0`, `list_workbooks` is
necessary; with an attachment, it is a wasted call. A plan step with `expectError` is a call the
agent cannot avoid with what it was given, such as the first read of a Windows-1254 file; the
recovery after it is part of the shortest path.

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
knowledge: 4 `K0`, 76 `K1`, 3 `K2`. The ideal plans make 112 calls, 10 of them expected
errors. Several files carry faults found while writing the oracles, and tasks keep them as they
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

Run each `idealPlan` through the real MCP SDK client against an in-process server, the way
`src/probe.ts` does. Record per call: tool, arguments, response bytes, duration and outcome;
per task: whether the plan's answer equals `answer`. A wrong answer here is a server defect,
because no model was involved. The totals are the baseline the model runs are compared with.

### Phase 2 — model runner

A model answers the same questions with nothing but the tool list. The runner is written
against a small model-host interface; its first implementation is Ollama's native `/api/chat`,
because that is the protocol that accepts a context window (`num_ctx`) and reports exact token
counts. Base URL, model name and an optional key come from the environment, never from the
repository.

- Tools are offered exactly as the server's `tools/list` returns them: name, description,
  input schema. The system prompt is short, fixed and identical for every task.
- The agent submits its answer through a lab-side `submit_answer` tool whose schema follows the
  task's answer shape, so grading never parses prose. The value holds only what was asked, in a
  stated form (a bare number, a date as `yyyy-MM-dd`, a month as `yyyy-MM`); how it was found,
  units and assumptions go in a separate `explanation`, which is never graded.
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
  not sent and the run ends as `contextExceeded`. Ollama drops the head of an oversized prompt
  without an error, so a request it would truncate is never measured as an answer.
- **Count after the reply.** Input, cached input and output tokens are Ollama's
  `prompt_eval_count`, `prompt_eval_cached_count` and `eval_count`.
- **Check the window the host used.** `/api/ps` reports the context length the model is
  actually loaded with; a run on a host holding a different window is marked and excluded.

Metrics per run:

| Metric                | Definition                                                                     |
| --------------------- | ------------------------------------------------------------------------------ |
| `correct`             | The submitted answer matches `answer` under the task's comparison              |
| `outcome`             | `answered`, `wrongAnswer`, `noAnswer`, `callBudget` or `contextExceeded`       |
| `calls`               | Tool calls made; `tools/list`, initialization and `submit_answer` are excluded |
| `excessCalls`         | `calls` minus the ideal plan's calls                                           |
| `responseBytes`       | UTF-8 bytes of tool responses that entered the model's context                 |
| `toolErrors`          | Calls that returned an error envelope, by error code                           |
| `invalidArgs`         | Calls the schema refused                                                       |
| `recoveryCalls`       | Calls between the first error and the next successful call                     |
| `requests`            | Model requests in the run                                                      |
| `toolSchemaTokens`    | Estimated tokens of the tool list alone, paid on every request                 |
| `peakInputTokens`     | Largest `prompt_eval_count` of the run: how full the window got                |
| `peakEstimatedTokens` | Largest pre-send estimate, to compare the estimate with the count              |
| `inputTokens`         | Sum of `prompt_eval_count` over the run                                        |
| `cachedInputTokens`   | Sum of `prompt_eval_cached_count`: the share the host did not recompute        |
| `outputTokens`        | Sum of `eval_count`                                                            |
| `windowUse`           | `peakInputTokens / window`                                                     |

#### Scenarios a run went through

A tag says a task is meant to meet a scenario; the run's trace says whether it did. The error
and recovery scenarios are read from the server's answers (`src/agent/exercised.ts`): `R1`,
`R2`, `R3`, `R6` and `Z3` from the error code of a call, `R4` from an ambiguity warning and `R5`
from a truncated answer. Each one found is marked recovered or not by its first occurrence: a
later call to the same tool without the error, `columns` passed after the warning, a cursor or
an aggregate after the truncation, and for `Z3` no further call to the refused file. The report
lists, per scenario, the tagged runs, how many of them met it, how many untagged runs met it
and how many recovered, because an agent that reads the headers first never meets
`unknown_column`, and a tag alone would count that run as coverage.

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
and the runners are. Results are kept outside this repository, because traces quote corpus
files whose licences do not all allow redistribution, and conclusions are recorded in
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

`baseline-cli.ts` builds the workspace and runs every plan against the built server (build
`@sezzlee/excel-mcp` first). A task is `answered` when the planned responses contain the oracle
answer, `needsCompute` when the plan's own computation step is still required, `refusalPlan` for
a refusal task whose calls behaved, and `unexpectedError`, `missingError` or `answerMissing`
when the plan or the server is wrong. The full report is `baseline.json` in the output
directory.

```bash
SEZZLEE_AGENT_LAB_OLLAMA_URL=http://host:11434 node packages/lab/excel-lab/src/agent/agent-cli.ts \
  --out /path/outside/repo --corpus "$SEZZLEE_CORPUS" --models qwen3.8:latest \
  [--windows 65536,16384] [--languages tr,en] [--runs 3] [--levels L1,L2] [--only <task,...>]
```

`agent-cli.ts` runs the matrix against the built server, appends one record per run to
`runs.jsonl` (metrics, the submitted answer, its grade, the call log and the full message trace)
and writes `summary.json` per model, window and language. `SEZZLEE_AGENT_LAB_OLLAMA_KEY` adds a
bearer token. Requests carry `keep_alive: 10m` and the window as `num_ctx`, as the product's do.
The user message lists the task's files for `K1` and `K2` under "Attached files"; `K0` gets the
question alone. Grading folds Turkish case, accepts a date and time with or without seconds and
separator, and needs the right reason for a refusal ([test/agent-grade.spec.ts](test/agent-grade.spec.ts)).

```bash
node packages/lab/excel-lab/src/agent/regrade-cli.ts <runs.jsonl>
node packages/lab/excel-lab/src/agent/report-cli.ts <runs.jsonl> --out <report.md>
node packages/lab/excel-lab/src/agent/compare-cli.ts <before/runs.jsonl> <after/runs.jsonl> --out <compare.md>
```

`regrade-cli.ts` grades saved runs again under the current catalog and grader, in place.
`report-cli.ts` writes the readable report: accuracy by language, level, knowledge and outcome,
the scenarios each run went through, and every run with its calls, wrong answers first.
`compare-cli.ts` grades two runs against the current catalog and lists what changed: accuracy
on the tasks whose question is the same on both sides, calls per tool, scenarios met, and every
run that was fixed, broke, is new or was asked a different question.

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
