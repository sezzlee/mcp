# Tools

> Generated from the `tools/list` answer (server name `sezzlee-pdf`) of `@sezzlee/pdf-mcp` 0.1.2.

The descriptions are the text the server publishes to every client, so your agent reads exactly what this page shows. Every input schema is closed: an argument a tool does not list here, or a value of the wrong type, is refused with `invalid_argument` and never silently ignored.

4 tools: `list_documents`, `describe_document`, `read_pages`, `find_in_document`.

## `list_documents`

List readable PDF documents under the server root. Returns filePath values that other tools accept verbatim. The listing never opens a file, so a listed path is a candidate, not a guarantee that the document parses. totalExact distinguishes a complete total; scanTruncated is separate from the result page limit.

Annotations: read-only, idempotent, closed world.

| Argument       | Type            | Required | Description                                                                 |
| -------------- | --------------- | -------- | --------------------------------------------------------------------------- |
| `subdirectory` | string          |          | Folder under the root to list.                                              |
| `pattern`      | string          |          | Glob over the relative path, for example invoices/*.pdf.                    |
| `maxResults`   | integer (1–200) |          | Maximum returned files, default 50. Does not increase the traversal budget. |

## `describe_document`

Summarise one PDF: page count, document type, which pages carry no trustworthy text, and what this server can do with it. pagesNeedingOcr is determined per page from the extracted text. documentType and classificationConfidence come from a separate document-level classifier: the confidence scores that verdict, NOT the accuracy of any extracted text, and the classifier reports a whole document as image-based when a single page is a scan. Calling this first is optional; read_pages and find_in_document work from filePath alone.

Annotations: read-only, idempotent, closed world.

| Argument   | Type               | Required | Description                                          |
| ---------- | ------------------ | -------- | ---------------------------------------------------- |
| `filePath` | string (≥ 1 chars) | yes      | Path to a PDF document, relative to the server root. |

## `read_pages`

Read selected pages as Markdown, one entry per page, with page numbers counted from 1. A page whose text the engine could not trust is returned with needsOcr true rather than omitted, so a scanned page is never presented as an empty one; empty distinguishes a genuinely blank page from an unreadable one. Each page reports source: text when the PDF's own text layer was used, ocr when a provider transcribed it. A page whose Markdown does not fit the response budget is clamped and marked truncatedMarkdown; nextCursor then resumes inside that page. With an explicit pages selection, nextCursor stays within the selected pages.

Annotations: read-only, idempotent, closed world.

| Argument   | Type                                | Required | Description                                                                                                                                                                                                                      |
| ---------- | ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filePath` | string (≥ 1 chars)                  | yes      | Path to a PDF document, relative to the server root.                                                                                                                                                                             |
| `pages`    | array of integer (≥ 1) (1–50 items) |          | Page numbers to read, counted from 1. Omit to read from the first page.                                                                                                                                                          |
| `maxPages` | integer (1–50)                      |          | Maximum pages in one response, default 10. The response byte budget may stop the page earlier.                                                                                                                                   |
| `ocr`      | boolean                             |          | Transcribe pages the text layer cannot answer, default false. Requires an OCR provider: describe_document reports whether one is configured. Sends those page images to that provider, which is slow and may leave this machine. |
| `cursor`   | string                              |          | nextCursor from a previous read_pages response. It carries the selection it was produced for, so it cannot be combined with pages.                                                                                               |

## `find_in_document`

Find literal text in the extracted page text. The query is matched literally, never as a regular expression or a query language. Pages that need OCR carry no searchable text and are counted in unsearchablePages: when coverageComplete is false, an empty match list means the text was not found in the pages that could be read, NOT that it is absent from the document. Pass ocr to transcribe those pages first and search them too. Case-insensitive matching folds ASCII letters only.

Annotations: read-only, idempotent, closed world.

| Argument        | Type                      | Required | Description                                                                                                                           |
| --------------- | ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `filePath`      | string (≥ 1 chars)        | yes      | Path to a PDF document, relative to the server root.                                                                                  |
| `query`         | string (1–256 chars)      | yes      | Literal text to look for. Never treated as a regular expression.                                                                      |
| `matchMode`     | `"contains"` \| `"exact"` |          | Substring match within a line (default), or whole-line equality after trimming.                                                       |
| `caseSensitive` | boolean                   |          | Default true. When false, only ASCII letters are folded.                                                                              |
| `maxResults`    | integer (1–200)           |          | Maximum matches in one page of results, default 50.                                                                                   |
| `ocr`           | boolean                   |          | Transcribe unsearchable pages before searching, default false. Requires an OCR provider; slow, and the page images leave this server. |
| `cursor`        | string                    |          | nextCursor from a previous find_in_document response.                                                                                 |
