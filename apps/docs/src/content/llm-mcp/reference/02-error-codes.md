# Error codes

> Generated from the error-code union types of `@sezzlee/llm-mcp` 0.1.3.

A tool that fails answers with `isError: true` and one text item holding a JSON object with three fields: `error`, a stable machine code from this page; `message`, what went wrong; and `recovery`, what the next call should do differently. Branch on `error`, never on `message`.

This is the answer to `local_task {"kind":"free","instruction":"Say hello."}` from a server whose model host is not running:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"error\":\"backend_unavailable\",\"message\":\"The local model host did not answer: fetch failed\",\"recovery\":\"Retry once; if the local model is still unreachable, do the work yourself.\"}"
    }
  ],
  "isError": true
}
```

The text item, parsed:

```json
{
  "error": "backend_unavailable",
  "message": "The local model host did not answer: fetch failed",
  "recovery": "Retry once; if the local model is still unreachable, do the work yourself."
}
```

The server has 12 codes.

## Arguments

| Code               | Meaning                                                                                                                                                                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_argument` | An argument the tool does not declare, a value of the wrong type or a missing required argument, or a combination the tool refuses: a label listed twice, a CSV file with no data rows, or a `labelColumn` the file already has. For an undeclared or mistyped argument the recovery lists the arguments the tool accepts. |
| `invalid_cursor`   | Not raised by this server. No tool returns a cursor.                                                                                                                                                                                                                                                                       |
| `stale_cursor`     | Not raised by this server. No tool returns a cursor.                                                                                                                                                                                                                                                                       |
| `resource_limit`   | The answer would be larger than 512 KiB. The model's answer is capped far below that, so this is rare; calls that arrive while the model is busy wait in its queue instead of being refused.                                                                                                                               |

## Files

| Code                | Meaning                                                                                                                                                                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outside_workspace` | A path resolves outside the working directory, directly or through a symbolic link. Paths are relative to the workspace, and `..` cannot leave it.                                                                                                                                                                                     |
| `file_not_found`    | No file exists at the given path. Paths are relative to the workspace, which is the server's working directory unless `SEZZLEE_LLM_ROOT` says otherwise.                                                                                                                                                                               |
| `not_text`          | The file is not UTF-8 text. `local_task` reads plain text and `local_map` reads CSV; convert other formats first.                                                                                                                                                                                                                      |
| `input_too_large`   | The input would not fit the model's context window, so it was not sent: the text or files are over the input budget for a kind other than `summarize` or `extract`, a long input needs more than 32 chunks or 1 MiB, a CSV has more than 2,000 rows or is over 8 MiB, or one row alone is over the budget. Nothing is ever cut to fit. |

## The model

| Code                  | Meaning                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend_unavailable` | The model host did not answer, or did not answer within `SEZZLEE_LLM_TIMEOUT_MS`. `local_status` reports `reachable`; start Ollama or fix `SEZZLEE_LLM_BASE_URL`. |
| `backend_refused`     | The model host answered with an error, most often because `SEZZLEE_LLM_MODEL` names a model it has not pulled. The message carries the host's own text.           |
| `unparsable_output`   | `jsonSchema` was given and the model's answer was not valid JSON for it. Retry once with a simpler schema, or do the work without the local model.                |

## Server

| Code             | Meaning                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `internal_error` | A defect in the server, not in your input or your call. This is the one code with no `recovery`, because there is no next call that fixes it. The detail is written to the server's stderr. |
