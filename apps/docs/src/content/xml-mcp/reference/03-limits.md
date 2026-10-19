# Limits

> Generated from the exported `limits` object of `@sezzlee/xml-mcp` 0.5.1.

These bounds are exported by the server. Tool arguments can request smaller pages or samples within them. Truncation and continuation are tool-specific: follow a cursor only when the response supplies one. An operation that cannot stay within its resource budget can fail with `resource_limit`.

## Files and parsing

| Limit                                                                                  | Value |
| -------------------------------------------------------------------------------------- | ----- |
| Largest document the server opens                                                      | 50 MB |
| Largest document read whole into memory; a larger one is read in chunked mode          | 8 MB  |
| Largest single record in chunked mode                                                  | 8 MB  |
| Records of a chunked document held parsed at once                                      | 1     |
| Time one parse may take before it fails with `resource_limit`                          | 2 s   |
| Deepest element nesting an address may reach                                           | 128   |
| Bytes at the start of a document scanned for its encoding and a DOCTYPE before parsing | 64 KB |
| Parse requests that may wait at once before a new one fails with `resource_limit`      | 5     |
| Parsed documents kept in memory between calls                                          | 4     |
| Documents the parse worker keeps alive, derived as twice `documentCacheSize`           | 8     |
| Directory entries `list_documents` walks before it reports `scanTruncated`             | 5,000 |
| Documents `list_documents` returns when `maxResults` is omitted                        | 50    |
| Largest `maxResults` for `list_documents`                                              | 200   |
| `list_documents` calls that may run at once                                            | 4     |

## Responses

| Limit                                                                                   | Value  |
| --------------------------------------------------------------------------------------- | ------ |
| Largest serialized answer; a longer one is cut short and continues through `nextCursor` | 512 KB |
| Longest text, in characters, returned for one node or value                             | 512    |
| Repeated-element candidates `describe_document` returns when `maxPaths` is omitted      | 20     |
| Largest `maxPaths` for `describe_document`                                              | 200    |
| Elements `describe_document` counts before it stops and reports the survey incomplete   | 5,000  |
| Nodes `read_node` returns when `maxNodes` is omitted                                    | 50     |
| Largest `maxNodes` for `read_node`                                                      | 200    |

## Search and XPath

| Limit                                                                               | Value  |
| ----------------------------------------------------------------------------------- | ------ |
| Matches `find_in_document` returns when `maxResults` is omitted                     | 50     |
| Largest `maxResults` for `find_in_document`                                         | 200    |
| Nodes `find_in_document` examines before it stops and reports the search incomplete | 50,000 |
| Longest `select_xpath` expression, in characters                                    | 4,096  |
| Prefix bindings one `select_xpath` call may pass                                    | 32     |
| Node-set members `select_xpath` returns when `maxResults` is omitted                | 50     |
| Largest `maxResults` for `select_xpath`                                             | 200    |

## Records and aggregation

| Limit                                                                                                               | Value  |
| ------------------------------------------------------------------------------------------------------------------- | ------ |
| Rows `project_records` returns when `maxRows` is omitted                                                            | 50     |
| Largest `maxRows` for `project_records`                                                                             | 200    |
| Columns one `project_records` or `aggregate_document` call may declare                                              | 32     |
| Steps in one column's `ancestors` path                                                                              | 16     |
| Values one cell returns under `onMultiple: "list"`                                                                  | 16     |
| Conditions in one `where` filter                                                                                    | 16     |
| Values in one `in` condition                                                                                        | 64     |
| Metrics in one `aggregate_document` call                                                                            | 16     |
| Groups `aggregate_document` returns when `maxGroups` is omitted                                                     | 50     |
| Largest `maxGroups` for `aggregate_document`                                                                        | 200    |
| Records one `project_records` or `aggregate_document` call examines before it stops and reports the scan incomplete | 50,000 |
