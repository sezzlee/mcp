# Find text in a document

`find_in_document` finds literal text in one PDF and reports the page, the line and the text around
each match. Use it before reading, to know which pages to read.

Uses the `pdf` helper from the [Quickstart](/docs/pdf-mcp/quickstart#see-what-the-agent-receives).
Save [supply-agreement.pdf](/samples/pdf-mcp/supply-agreement.pdf) into `~/sezzlee-pdf` too: three
pages, the middle one a scan.

## Search for a phrase

```sh
pdf find_in_document --tool-arg filePath=annual-report.pdf query=Rotterdam \
  | jq -c '.matches[] | {page, line, context}'
```

```json
{"page":1,"line":7,"context":"er of orders rose to 11,245, and the average order value was EUR 350. Two warehouses were consolidated into one in Rotterdam in March."}
{"page":4,"line":3,"context":"For 2026 we expect revenue growth between 4% and 6%. A second carrier for the West region starts in April to reduce late delivery. Capital expenditure is planned at EUR 240,000, mostly for the Rotterdam site."}
```

`query` is matched as written. It is never a regular expression, so `.`, `*` and `(` are ordinary
characters. `line` is the line of the page's Markdown, and `context` is that line cut to at most 240
characters around the match.

## Match regardless of case

Matching is case-sensitive by default. `caseSensitive=false` folds the letters A to Z only:

```sh
pdf find_in_document --tool-arg filePath=annual-report.pdf query=WEST caseSensitive=false \
  | jq -c '[.matches[] | .page]'
```

```json
[2,2,3,4]
```

Letters outside A to Z are compared exactly, so `İ` and `i`, or `É` and `é`, do not match each
other. Search for each spelling when that matters.

## Match a whole line

`matchMode=exact` matches a line whose whole text, trimmed, equals the query. Headings are lines of
their own, so this finds a section title and nothing that only mentions it:

```sh
pdf find_in_document --tool-arg filePath=annual-report.pdf query="# 3. Risks" matchMode=exact \
  | jq -c '.matches[] | {page, line}'
```

```json
{"page":3,"line":1}
```

The query includes the `# ` because the text searched is the Markdown that `read_pages` returns.

## Page through many matches

`maxResults` caps the matches in one answer, 50 by default and 200 at most. When more remain,
`truncated` is `true` and `nextCursor` continues the search:

```sh
pdf find_in_document --tool-arg filePath=annual-report.pdf query=West maxResults=2 \
  | jq -c '{matches: [.matches[] | .page], truncated}'
```

```json
{"matches":[2,2],"truncated":true}
```

Pass `nextCursor` back with the same `filePath`, `query`, `matchMode` and `caseSensitive`; different
ones are refused with `invalid_argument`. You may change `maxResults` between calls.

## Know what the search could not see

A page without a text layer has nothing to search. It is counted in `unsearchablePages`, and
`coverageComplete` is `false`:

```sh
pdf find_in_document --tool-arg filePath=supply-agreement.pdf query="late delivery" \
  | jq -c '{matches: [.matches[] | .page], unsearchablePages, pagesNeedingOcr, coverageComplete}'
```

```json
{"matches":[1],"unsearchablePages":1,"pagesNeedingOcr":[2],"coverageComplete":false}
```

The phrase was found on page 1, but page 2 was not searched. Treat `coverageComplete: false` as
"found in the pages that could be read", never as "absent from the document". To search the scan as
well, see [Read scanned pages with OCR](/docs/pdf-mcp/read-scanned-pages-with-ocr).

:::details[Why a scanned page is never shown as empty]

A page with no extracted text is either blank or unreadable, and the two call for opposite
conclusions. An extractor that returns an empty string for both turns "the payment terms are on a
page I could not read" into "the contract has no payment terms".

So every page carries two flags. `needsOcr: true` means the engine found no text it could trust, and
`ocrReason` says why where it can, for example `scanned`. `empty: true` means the page was read and
is blank; it is never `true` for a page that needs OCR. The Markdown of a page that needs OCR is an
empty string, so an agent should read the flags, not the string.

Search follows the same rule, on every answer and not only on empty ones: a search that found three
matches on readable pages may have missed a fourth on a scanned one.

The page list in `describe_document` comes from each page's own extraction, not from the document
classifier. On the pinned engine a ten-page document with one scanned page was classified as
image-based with all ten flagged, which would send ten pages to a model to recover one.

:::
