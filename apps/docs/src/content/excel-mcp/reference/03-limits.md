# Limits

> Generated from the exported `limits` object of `@sezzlee/excel-mcp` 0.12.0.

These bounds are exported by the server. Tool arguments can request smaller pages or samples within them. Truncation and continuation are tool-specific: follow a cursor only when the response supplies one. An operation that cannot stay within its resource budget can fail with `resource_limit`.

## Files

| Limit                                                                       | Value     |
| --------------------------------------------------------------------------- | --------- |
| Largest `.xlsx` or `.xlsm` file the server opens                            | 50 MB     |
| Largest `.csv` file the server opens                                        | 16 MB     |
| Most cells a CSV may hold                                                   | 2,000,000 |
| Most fields one CSV record may hold                                         | 16,384    |
| Bytes at the start of a CSV checked for NUL bytes, which mark a binary file | 8 KB      |
| Bytes of a CSV read to detect the delimiter                                 | 64 KB     |
| Lines of a CSV compared to detect the delimiter                             | 20        |
| Parsed files kept in memory between calls                                   | 4         |
| Directory entries `list_workbooks` walks before it reports `scanTruncated`  | 5,000     |
| Files `list_workbooks` returns when `maxResults` is omitted                 | 50        |
| Largest `maxResults` for `list_workbooks`                                   | 200       |

## Responses

| Limit                                                                                                                                                                                                                   | Value  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Largest total UTF-8 text payload in a tool result; every tool passes the mandatory response guard. read_sheet continues with nextCursor; retained aggregate results continue with resultId and query_result nextOffset. | 512 KB |
| Longest text, in characters, returned for one cell or one formula                                                                                                                                                       | 512    |
| Cells `read_sheet` returns when `maxCells` is omitted                                                                                                                                                                   | 2,000  |
| Largest `maxCells` for `read_sheet`                                                                                                                                                                                     | 10,000 |
| Rows above which `describe_workbook` and `read_sheet` suggest `aggregate_sheet` or `find_in_sheet` instead of paging                                                                                                    | 5,000  |
| Named columns `describe_workbook` lists in each sheet's header preview; the rest are counted in `moreColumns`                                                                                                           | 12     |

## Search and aggregation

| Limit                                                                                                                                                 | Value      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Matches `find_in_sheet` returns when `maxResults` is omitted                                                                                          | 50         |
| Largest `maxResults` for `find_in_sheet`                                                                                                              | 200        |
| Longest `regex` query for `find_in_sheet`, in characters                                                                                              | 256        |
| Groups `aggregate_sheet` returns when `maxGroups` is omitted                                                                                          | 50         |
| Largest `maxGroups` for `aggregate_sheet`                                                                                                             | 500        |
| Distinct groups one `aggregate_sheet` scan may form before it is refused with `resource_limit`                                                        | 100,000    |
| Metric states retained across primary groups, pivots and grouping sets before `resource_limit`                                                        | 200,000    |
| Exact percentile samples retained across all groups and grouping sets before `resource_limit`                                                         | 1,000,000  |
| Distinct metric values retained across all groups and grouping sets before `resource_limit`                                                           | 1,000,000  |
| Additional grouping sets in one `aggregate_sheet` call                                                                                                | 8          |
| Explicit numeric boundaries in one grouping specification                                                                                             | 128        |
| Metric cells in the complete dense row-key by pivot-key result before allocation                                                                      | 10,000     |
| Cells one `aggregate_sheet` call may read before it is refused with `resource_limit`                                                                  | 20,000,000 |
| Metrics in one `aggregate_sheet` call                                                                                                                 | 8          |
| Named native-error code buckets in one aggregate result; further codes are counted in other                                                           | 32         |
| Example source addresses retained per native-error bucket                                                                                             | 3          |
| Maximum named native-error code length; longer codes are counted in other                                                                             | 128        |
| Conditions in one `where` filter                                                                                                                      | 16         |
| Shared column specifications accepted by profile_sheet, read_sheet, find_in_sheet and aggregate_sheet                                                 | 64         |
| Characters in a `read_sheet` continuation cursor, which carries the column specifications; an oversized cursor is refused only when more pages remain | 16,384     |
| Values in one `in` condition                                                                                                                          | 64         |
| Rows at the top of the used range examined to find the header row a call names none for, and the rows `headerScan` examines                           | 20         |
| Derived metrics in one `aggregate_sheet` call                                                                                                         | 4          |
| Distinct values the `source` column of an `inColumn` or `notInColumn` condition may hold before `resource_limit`                                      | 100,000    |

## Retained results

| Limit                                                                                                                                    | Value     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Serialized UTF-8 row values, source-row counts and metadata admitted for one complete retained result; not an exact heap measurement     | 8 MB      |
| Total accounted serialized bytes across retained results in one handler instance; excess refuses admission without evicting live results | 16 MB     |
| Live retained results per handler instance; expired entries are removed before access or admission                                       | 4         |
| Absolute result lifetime in milliseconds; reads do not extend it and closing the server clears all results                               | 900 s     |
| Rows retained for one complete result; excess refuses the calculation without a partial handle                                           | 100,000   |
| Cells retained for one complete result, independently of the byte and row budgets                                                        | 1,000,000 |
| Maximum serialized CallToolResult bytes for a retained preview or query page, including metadata and JSON text escaping                  | 16 KB     |
| Characters allowed in one exact query_result equality string; matching uses complete values before display truncation                    | 4,096     |

## Column profiles

| Limit                                                                                                              | Value  |
| ------------------------------------------------------------------------------------------------------------------ | ------ |
| Data rows sampled by profile_sheet when maxRows is omitted                                                         | 1,000  |
| Largest maxRows for profile_sheet                                                                                  | 5,000  |
| Columns profiled when maxColumns is omitted                                                                        | 16     |
| Largest maxColumns for profile_sheet                                                                               | 64     |
| Cells in one rectangular profile sample; a prefix is returned with omitted rows counted                            | 64,000 |
| Distinct values retained per profiled column; larger cardinalities are lower bounds and topValuesComplete is false | 1,000  |

## Sheet metadata

| Limit                                                                                  | Value |
| -------------------------------------------------------------------------------------- | ----- |
| Excel Tables `get_tables` reports for one sheet                                        | 64    |
| Columns `get_tables` reports for one table                                             | 256   |
| Rules `get_conditional_formats` reports for one sheet                                  | 200   |
| Pictures `get_images` reports for one sheet                                            | 200   |
| Charts `get_charts` reports for one sheet                                              | 200   |
| Cached series points `get_charts` returns per series when `maxPoints` is omitted       | 200   |
| Largest `maxPoints` for `get_charts`                                                   | 2,000 |
| Cached series points one `get_charts` answer may return across every series            | 5,000 |
| Series one chart may declare before further series are dropped                         | 255   |
| Ranges reported for one validation or conditional-format rule before `rangesTruncated` | 64    |
