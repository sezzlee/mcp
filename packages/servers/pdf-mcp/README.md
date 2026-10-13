# @sezzlee/pdf-mcp

A read-only, sandboxed MCP server for local PDF documents. It builds on `@sezzlee/file-core`,
which supplies sandbox path resolution, the response budget, the error envelope, cursors and the
document cache. Text extraction uses `@firecrawl/pdf-inspector`. The server **never reaches the
network**: OCR is optional, and when it is enabled, the connection decision belongs entirely to
whoever supplies the two injected ports.

## Quick start

```json
{
  "mcpServers": {
    "pdf": {
      "command": "npx",
      "args": ["-y", "@sezzlee/pdf-mcp", "/path/to/documents"]
    }
  }
}
```

To enable OCR, point `--ocr` at a module whose default export is an `OcrBinding` (see
[Configuration](#configuration) and [OCR](#ocr)):

```json
{
  "mcpServers": {
    "pdf": {
      "command": "npx",
      "args": [
        "-y",
        "@sezzlee/pdf-mcp",
        "/path/to/documents",
        "--ocr",
        "/path/to/ollama-binding.js"
      ]
    }
  }
}
```

## Tools

| Tool                | What it does                                                           | Key arguments                                                      |
| ------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `list_documents`    | Lists readable PDF candidates under the root; never opens a file       | `subdirectory`, `pattern`, `maxResults`                            |
| `describe_document` | Page count, document type, per-page OCR need, server capabilities      | `filePath`                                                         |
| `read_pages`        | Reads selected pages as Markdown, page numbers 1-based                 | `filePath`, `pages`, `maxPages`, `ocr`, `cursor`                   |
| `find_in_document`  | Literal search over extracted text, with page number and match context | `filePath`, `query`, `matchMode`, `caseSensitive`, `ocr`, `cursor` |

If the file path is already known, `describe_document` is optional: `read_pages` and
`find_in_document` work from `filePath` alone.

## Configuration

CLI (`sezzlee-pdf <pdf-source-root> [--ocr <module>]`):

| Argument            | Default  | Meaning                                                                                                                                                                                                                      |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<pdf-source-root>` | required | Sandbox root; every readable path is resolved and checked against it.                                                                                                                                                        |
| `--ocr <module>`    | none     | Path or package specifier to a module whose default export is `{ rasterizer, provider }`. Absent means no OCR: `read_pages`/`find_in_document` refuse `ocr: true` and `describe_document` reports `capabilities.ocr: false`. |

Programmatic (`createPdfMcpServer(root, options)`):

| Option                     | Default | Meaning                                                                                                                                |
| -------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `documentCacheSize`        | `2`     | Extracted documents held in memory at once, 1–16. A budget, not a guard: each cached document holds every page's Markdown on the heap. |
| `maxConcurrentListings`    | `4`     | Concurrent `list_documents` calls before a request is refused.                                                                         |
| `maxConcurrentExtractions` | `2`     | Concurrent PDF extractions before a request is refused.                                                                                |
| `ocr`                      | none    | An `OcrBinding` (`{ rasterizer, provider, dpi?, maxPagesPerCall?, timeoutMs? }`). Neither port is a dependency of this package.        |

## OCR

The server does not perform OCR; it supports it. Two ports are injected — neither the raster
library nor the model client is a dependency of this package.

```ts
interface PageRasterizer {
  render(job: {
    bytes: Buffer;
    pages: readonly number[];
    dpi: number;
    signal?: AbortSignal;
  }): Promise<readonly RenderedPage[]>; // { page, image, mediaType }
}

interface OcrProvider {
  readonly name: string;
  recognize(job: {
    pages: readonly RenderedPage[];
    signal?: AbortSignal;
  }): Promise<readonly RecognizedPage[]>; // { page, markdown, confidence? }
}
```

The server does exactly this: it `render`s the pages the text layer could not answer, `recognize`s
the resulting images, substitutes the result for that page, and marks it `source: "ocr"`.

Programmatic binding:

```ts
createPdfMcpServer(root, {
  ocr: { rasterizer: pdfjsRasterizer, provider: ollamaProvider, dpi: 200 },
});
```

CLI binding — a module whose default export matches `OcrBinding`, loaded with `--ocr <module>`
(see `examples/ollama-binding.ts` in this package for a working example built from
`@sezzlee/pdf-raster-pdfjs` and `@sezzlee/ocr-ollama`):

```ts
import { createPdfjsRasterizer } from "@sezzlee/pdf-raster-pdfjs";
import { createOllamaOcrProvider } from "@sezzlee/ocr-ollama";
import type { OcrBinding } from "@sezzlee/pdf-mcp";

const binding: OcrBinding = {
  rasterizer: createPdfjsRasterizer(),
  provider: createOllamaOcrProvider({
    baseUrl: process.env["SEZZLEE_PDF_OCR_URL"] ?? "http://127.0.0.1:11434",
    model: process.env["SEZZLEE_PDF_OCR_MODEL"] ?? "deepseek-ocr:3b",
  }),
  dpi: 200,
};

export default binding;
```

### OCR rules

- **`ocr: true` with no provider bound is an error** (`ocr_unavailable`), never a silent fall back
  to the text layer. Otherwise an agent that asked for OCR could mistake "nobody transcribed this
  document" for "no match". `describe_document` → `capabilities.ocr` reports whether one is bound.
- **An empty transcription does not count as an answer.** If the provider returns empty text, the
  page stays `needsOcr` — "the model returned nothing" is not the same as "this page is blank".
- **An unrequested page is ignored.** The ports may reorder, skip, or invent pages; results are
  matched to the page number that was requested, so a provider cannot overwrite a page the text
  layer already trusted.
- **Bytes leave the process.** Binding a provider means those pages' pixels go somewhere else. OCR
  therefore defaults to off and is requested explicitly on every call.
- **A page is not re-transcribed on every call.** Transcriptions are cached by document fingerprint
  plus page number. The cache is not a progress log: a search sends only the pages after the cursor
  to OCR and carries coverage forward in the cursor, so even a large document is eventually walked
  to the end from cache.
- **An expired job does not release its slot.** Neither the engine nor an injected port can cancel
  work that has already started; the slot stays held until the work actually finishes. A provider
  that never returns can only be recovered by restarting the server — reclaiming the slot on a
  timer would only postpone the limit.

## Rules

- **Every page number on the public surface is 1-based.** The underlying library returns some
  fields 0-based and others 1-based within the same result object. The whole conversion lives in
  `src/engine/`, and lint bans importing `@firecrawl/pdf-inspector` outside that folder — a second
  import site would reintroduce the bug (measured on 1.23.0: `PageMarkdownResult.page` is
  0-based, sibling `pagesNeedingOcr` is 1-based).
- **Page selection is validated before it reaches the library.** An out-of-range index otherwise
  comes back as a phantom page marked `needsOcr`; a negative index wraps through u32. Both would
  look like a real page to the agent.
- **`describe_document` never builds its OCR page list from the classifier.** `classifyPdf` marks
  every page of a document that contains a single scanned page. The list comes from the
  per-page extraction instead. `classificationConfidence` is confidence in the classifier's own
  verdict, not in any extracted text's accuracy.
- **An unreadable page is never presented as an empty one.** A scanned page returns `needsOcr:
true`; `empty` is `true` only for a page the engine trusted and found genuinely blank.
- **Search coverage is reported on every response.** When any page needs OCR, `coverageComplete`
  is `false`, and an empty match list is not proof the query is absent from the whole document.
- **A document is extracted once, in full; the response is paginated.** Measurement showed that
  requesting a single page cuts extraction cost by a third, not 200-fold — the fixed cost
  dominates. Cursor identity depends on document content and OCR mode, not page size. An explicit
  `pages` selection is preserved across a cursor: it carries forward the rest of that selection
  and never wanders into unselected pages. A cursor resuming inside a page carries that page's
  text fingerprint; if the text changed since transcription, the response is `stale_cursor` rather
  than silently skipping content.
- **The server never reaches the network.** `fetch`, `node:http`, `node:net` and their siblings
  are lint-banned inside `src/`, and the ban is repeated in every layer's override — a later
  oxlint override replaces `no-restricted-imports` rather than merging with it, so a single
  top-level ban would not apply everywhere.
- **Platform support is narrow.** The engine ships no `darwin-x64` binary and its wasm fallback is
  unpublished. On an unsupported host the server stops at startup with a one-line message (exit
  code 3).

## Development

```sh
pnpm turbo run build --filter=@sezzlee/pdf-mcp
node packages/servers/pdf-mcp/dist/cli.js /path/to/documents
```

Tests: `pnpm turbo run test --filter=@sezzlee/pdf-mcp` (Vitest). A live-Ollama suite
(`test/ocr-live.spec.ts`) is skipped unless `SEZZLEE_PDF_OCR_URL` is set; it also reads
`SEZZLEE_PDF_OCR_MODEL` (default `deepseek-ocr:3b`). Everything else in `test/ocr.spec.ts` runs
against fake ports; the live suite only proves the two real adapters compose.
