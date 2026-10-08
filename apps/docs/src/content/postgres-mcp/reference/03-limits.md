# Limits

> Generated from the exported `limits` object of `@sezzlee/postgres-mcp` 0.2.0.

Every limit is fixed at build time; none is configurable. A call that would cross one either answers with `truncated: true` and a way to continue, or fails with `resource_limit`.

## Queries

| Limit                                                                                                       | Value  |
| ----------------------------------------------------------------------------------------------------------- | ------ |
| Rows `run_query` returns when `maxRows` is omitted                                                          | 100    |
| Largest `maxRows` for `run_query`                                                                           | 1,000  |
| Most columns `describe_table` reports for one table                                                         | 512    |
| Largest serialized answer; a longer result is cut at the last row that fits                                 | 512 KB |
| Longest text value returned for one cell, in characters; a longer one is cut                                | 4,096  |
| Longest binary value returned for one cell, before base64 encoding; a longer one is cut                     | 4 KB   |
| Deadline for a statement when the call sets no `timeoutMs`; `SEZZLEE_POSTGRES_QUERY_TIMEOUT_MS` replaces it | 30 s   |

## Catalogue search

| Limit                                                                                 | Value  |
| ------------------------------------------------------------------------------------- | ------ |
| Objects `search_catalog` returns when `maxResults` is omitted                         | 50     |
| Largest `maxResults` for `search_catalog`                                             | 200    |
| Tables and views the search index holds; past it the catalogue is reported incomplete | 5,000  |
| Columns the search index holds; past it the catalogue is reported incomplete          | 50,000 |
| Longest description kept for one object or column                                     | 160    |
| How long the search index is reused before the next search reads the catalogue again  | 900 s  |
| Words of one `query` that are searched; the rest are ignored                          | 16     |
| Index terms one query word may expand to by prefix                                    | 32     |
| Entries in one result's `matched` list                                                | 8      |
| Constraints `describe_table` lists for one table                                      | 256    |

## Connections

| Limit                                                                                                 | Value |
| ----------------------------------------------------------------------------------------------------- | ----- |
| Connections open to PostgreSQL at once                                                                | 4     |
| Calls that may wait for a free connection before a new one fails with `resource_limit`                | 32    |
| Longest wait for a cancelled statement to settle before its connection is discarded instead of reused | 5 s   |
