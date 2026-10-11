# Tools

> Generated from the `tools/list` answer (server name `sezzlee-llm`) of `@sezzlee/llm-mcp` 0.1.3.

The descriptions are the text the server publishes to every client, so your agent reads exactly what this page shows. Every input schema is closed: an argument a tool does not list here, or a value of the wrong type, is refused with `invalid_argument` and never silently ignored.

3 tools: `local_status`, `local_task`, `local_map`.

## `local_status`

Report whether the free local model is reachable and loaded, its context window, the input budget one call may use, and how many local calls are waiting. Call it when you are unsure the local model is available before delegating to it.

Annotations: read-only, idempotent, closed world.

Takes no arguments.

## `local_task`

Run one bounded language task on the free local model: classify, extract, summarize, transform, or free. Pass file paths in `files` instead of pasting their contents; the server reads them itself, so their text never enters your context. With `jsonSchema` the answer is JSON matching that schema, returned as `result`; otherwise it is text, returned as `answer`. The local window is small: summarize and extract split a long input themselves and read all of it; the other kinds refuse an input over the budget as input_too_large. Nothing is ever truncated.

Annotations: read-only, idempotent, closed world.

| Argument      | Type                                                                      | Required | Description                                                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`        | `"classify"` \| `"extract"` \| `"summarize"` \| `"transform"` \| `"free"` | yes      | classify answers with labels, extract with the requested fields (null when absent), summarize with a headline and key facts, transform with the rewritten input, free with a direct answer. summarize and extract split an input that exceeds the budget; the others refuse it. |
| `instruction` | string (≥ 1 chars)                                                        | yes      | What to do with the input, stated precisely.                                                                                                                                                                                                                                    |
| `text`        | string                                                                    |          | Short input given inline.                                                                                                                                                                                                                                                       |
| `files`       | array of string (≥ 1 chars) (≤ 8 items)                                   |          | Paths relative to the working directory.                                                                                                                                                                                                                                        |
| `jsonSchema`  | object                                                                    |          | A JSON Schema the answer must match.                                                                                                                                                                                                                                            |

## `local_map`

Label every row of a CSV file with one of the given labels on the free local model, for row-wise judgement that needs language understanding. You never see the rows: pass the path, and the server writes a labelled copy (the original columns plus one label column) as a new file in its output directory and returns that file's path, the counts per label, and up to four sample rows per label. Check the samples before using the output. Rows a simple rule or keyword can decide are faster with a script.

Annotations: non-destructive, closed world.

| Argument      | Type                                      | Required | Description                                                                                                                         |
| ------------- | ----------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `file`        | string (≥ 1 chars)                        | yes      | CSV path relative to the working directory.                                                                                         |
| `instruction` | string (≥ 1 chars)                        | yes      | How to decide one row's label, naming the cues you saw in a sample.                                                                 |
| `labels`      | array of string (1–64 chars) (2–50 items) | yes      | The labels a row may receive: 2 to 50, none repeated. A row the model does not label is left unlabelled and counted, never guessed. |
| `labelColumn` | string (1–64 chars)                       |          | Name of the added column; defaults to label.                                                                                        |
