# Read a document a few pages at a time

`read_pages` returns ten pages per call. Read fewer, read chosen pages in the order you want, or
continue a read that stopped.

Uses the `pdf` helper from the [Quickstart](/docs/pdf-mcp/quickstart#see-what-the-agent-receives) on
`annual-report.pdf`, four pages.

## Read from the start

`maxPages` caps the pages in one answer, up to 50:

```sh
pdf read_pages --tool-arg filePath=annual-report.pdf maxPages=2 \
  | jq -c '{pages: [.pages[].page], truncated, truncationReason}'
```

```json
{"pages":[1,2],"truncated":true,"truncationReason":"maxPages"}
```

`truncated` is `true`: the call stopped at `maxPages`, not at the end of the document. The answer
also carries a `nextCursor`. Pass it back, with the same `filePath`, to get the next pages:

```sh
CURSOR=$(pdf read_pages --tool-arg filePath=annual-report.pdf maxPages=2 | jq -r .nextCursor)
pdf read_pages --tool-arg filePath=annual-report.pdf "cursor=$CURSOR" \
  | jq -c '{pages: [.pages[].page], truncated}'
```

```json
{"pages":[3,4],"truncated":false}
```

The cursor holds the position, not the page size, so you may change `maxPages` between calls. When
`truncated` is `false` there is no `nextCursor` and the read is complete.

## Read chosen pages

`pages` lists the page numbers to read, from 1, in the order you want them back:

```sh
pdf read_pages --tool-arg filePath=annual-report.pdf 'pages=[4,1]' \
  | jq -c '[.pages[] | {page, heading: (.markdown | split("\n")[0])}]'
```

```json
[{"page":4,"heading":"# 4. Outlook"},{"page":1,"heading":"# Northwind Supplies"}]
```

A page number the document does not have is refused rather than answered with an empty page:

```sh
pdf read_pages --tool-arg filePath=annual-report.pdf 'pages=[7]'
```

```text
{"error":{"code":"tool_is_error","message":"Tool 'read_pages' returned isError:true."}}
{
  "error": "invalid_argument",
  "message": "The document has 4 pages; page 7 does not exist.",
  "recovery": "Call describe_document to read pageCount."
}
```

The first line comes from the Inspector; the object under it is the server's answer. A `nextCursor`
on a chosen selection stays inside it, so a call that passes both `cursor` and `pages` is refused
with `invalid_argument`.

## When a page or a cursor does not fit

An answer has a budget of 512 KiB. If the next page would not fit, the call stops before it with
`truncationReason: "maxPayloadBytes"`. If the first page alone does not fit, its Markdown is cut,
the page is marked `truncatedMarkdown: true`, and `nextCursor` resumes inside it. Keep passing
`nextCursor` until `truncated` is `false`; joining the pieces gives the page whole.

A cursor lasts ten minutes. After that, or if the file changed on disk, the call fails with
`invalid_cursor` or `stale_cursor`: start again without a cursor. A cursor is tied to its `ocr`
setting, so passing it with a different `ocr` value is refused.

:::details[Why a document is extracted once and whole]

Selecting one page does not make extraction cheap. On the pinned engine, a synthetic 200-page
document took 21.1 ms to extract whole and 7.0 ms for one page, because most of the cost is parsing
the file's structure, fonts and cross-references.

So the first call extracts every page and keeps the result in memory; later pages and searches are
served from it. Two documents are kept by default, and a third evicts the least recently used. Calling
`describe_document` first costs nothing extra, and skipping it saves nothing.

A cursor therefore only records where to resume, plus the document's content fingerprint and the
options that decide the text. A changed file answers `stale_cursor` instead of pages of a different
document.

:::
