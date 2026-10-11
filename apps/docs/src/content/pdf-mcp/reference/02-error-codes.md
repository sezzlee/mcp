# Error codes

> Generated from the error-code union types of `@sezzlee/pdf-mcp` 0.1.2.

A tool that fails answers with `isError: true` and one text item holding a JSON object with three fields: `error`, a stable machine code from this page; `message`, what went wrong; and `recovery`, what the next call should do differently. Branch on `error`, never on `message`.

This is the answer to `describe_document {"filePath":"annual-report.pdf"}` in a folder that has no such file:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"error\":\"file_not_found\",\"message\":\"No source exists under the PDF source root.\",\"recovery\":\"Call list_documents to see readable files.\"}"
    }
  ],
  "isError": true
}
```

The text item, parsed:

```json
{
  "error": "file_not_found",
  "message": "No source exists under the PDF source root.",
  "recovery": "Call list_documents to see readable files."
}
```

The server has 18 codes.

## Arguments and paging

| Code               | Meaning                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_argument` | An argument the tool does not declare, a value of the wrong type, a missing required argument, or a combination the tool refuses: a page number the document does not have, `cursor` together with `pages`, or a cursor passed with different options than the call that produced it. The message names the problem. For an undeclared or mistyped argument the recovery lists the arguments the tool accepts. |
| `invalid_cursor`   | `cursor` is not a token this tool returned, belongs to a different tool, or is more than ten minutes old. Call the tool again without a cursor.                                                                                                                                                                                                                                                                |
| `stale_cursor`     | The document changed between two pages of the same read, or a page the cursor resumes inside was transcribed again and its text differs. Start again without a cursor.                                                                                                                                                                                                                                         |
| `resource_limit`   | The request would exceed a fixed budget: the document has more than 2,000 pages, extraction took longer than 20 seconds, too many documents are already being read, an OCR run is already in progress, too many `list_documents` calls are running, or not even part of one page fits the response. See [Limits](/docs/pdf-mcp/limits).                                                                        |

## Files and paths

| Code                     | Meaning                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `path_outside_root`      | `filePath` resolves outside the folder the server was started with. Paths are relative to that folder, and `..` cannot leave it.           |
| `file_not_found`         | No file exists at `filePath`. Call `list_documents` for the paths that do.                                                                 |
| `not_a_file`             | `filePath` names a directory or another entry that is not a regular file.                                                                  |
| `unsupported_extension`  | The file does not end in `.pdf`, the only extension this server reads.                                                                     |
| `file_too_large`         | The file is over 32 MiB. Every PDF is extracted whole, so there is no mode for a larger one; split the document.                           |
| `file_changed`           | The file was modified while it was being read. Retry the call.                                                                             |
| `unsupported_for_format` | Not raised by this server. Every readable PDF is extracted whole, so there is no reduced mode that refuses a tool.                         |
| `unsupported_platform`   | The native package that gives the server safe file access is missing for this operating system and CPU. Reinstall on a supported platform. |

## Document content

| Code                | Meaning                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `malformed_pdf`     | The file is not a readable PDF: it is truncated, or it is something else with a `.pdf` extension.                                                                      |
| `encrypted_pdf`     | The document is password-protected. The server never asks for a password; supply an unprotected copy.                                                                  |
| `extraction_failed` | The PDF engine could not read a document that is otherwise a PDF, usually because it uses a feature the engine does not support. Retrying the same call does not help. |

## OCR

| Code              | Meaning                                                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ocr_unavailable` | A call passed `ocr: true`, but the server was started without an OCR binding. `describe_document` reports `capabilities.ocr: false` in that case. Omit `ocr` to read the text layer alone, or start the server with `--ocr`. |
| `ocr_failed`      | The rasterizer or the OCR provider failed, or OCR took longer than its budget (two minutes at most). The pages keep their `needsOcr` marking; no text is invented for them.                                                  |

## Server

| Code             | Meaning                                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `internal_error` | A defect in the server, not in your document or your call. This is the one code with no `recovery`, because there is no next call that fixes it. The detail is written to the server's stderr. |
