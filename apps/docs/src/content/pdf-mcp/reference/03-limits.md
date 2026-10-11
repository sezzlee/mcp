# Limits

> Generated from the exported `limits` object of `@sezzlee/pdf-mcp` 0.1.2.

Every limit is fixed at build time; none is configurable. A call that would cross one either answers with `truncated: true` and a way to continue, or fails with `resource_limit`.

## Files and extraction

| Limit                                                                                 | Value |
| ------------------------------------------------------------------------------------- | ----- |
| Largest document the server opens                                                     | 32 MB |
| Most pages a document may have; a longer one is refused before it is extracted        | 2,000 |
| Time one extraction may take before the call fails with `resource_limit`              | 20 s  |
| Documents that may be extracted at once before a new read fails with `resource_limit` | 2     |
| Extracted documents kept in memory between calls                                      | 2     |
| Directory entries `list_documents` walks before it reports `scanTruncated`            | 5,000 |
| Documents `list_documents` returns when `maxResults` is omitted                       | 50    |
| Largest `maxResults` for `list_documents`                                             | 200   |
| `list_documents` calls that may run at once                                           | 4     |

## Responses

| Limit                                                                                  | Value  |
| -------------------------------------------------------------------------------------- | ------ |
| Largest serialized answer; a longer page is clamped and continues through `nextCursor` | 512 KB |
| Pages `read_pages` returns when `maxPages` is omitted                                  | 10     |
| Largest `maxPages` for `read_pages`, and the most page numbers `pages` may name        | 50     |

## Search

| Limit                                                           | Value |
| --------------------------------------------------------------- | ----- |
| Matches `find_in_document` returns when `maxResults` is omitted | 50    |
| Largest `maxResults` for `find_in_document`                     | 200   |
| Longest `context` returned around one match                     | 240   |
| Longest `query`, in characters                                  | 256   |

## OCR

| Limit                                                                                              | Value |
| -------------------------------------------------------------------------------------------------- | ----- |
| Resolution pages are rendered at when the binding sets no `dpi`                                    | 200   |
| Pages sent to the provider in one call; a binding's `maxPagesPerCall` can lower it, never raise it | 10    |
| Time one OCR run may take; a binding's `timeoutMs` can lower it, never raise it                    | 120 s |
| OCR runs that may be in progress at once before a new one fails with `resource_limit`              | 1     |
| Transcribed pages kept in memory, keyed by document content and page number                        | 256   |
