# Tools

> Generated from the `tools/list` answer (server name `sezzlee-excel`) of `@sezzlee/excel-mcp` 0.7.1.

The descriptions are the text the server publishes to every client, so your agent reads exactly what this page shows. Every input schema is closed: an argument a tool does not list here, or a value of the wrong type, is refused with `invalid_argument` and never silently ignored.

10 tools: `list_workbooks`, `describe_workbook`, `read_sheet`, `get_merged_ranges`, `get_data_validations`, `get_tables`, `get_conditional_formats`, `get_images`, `aggregate_sheet`, `find_in_sheet`.

## `list_workbooks`

List readable .xlsx, .xlsm and .csv files under the server root. Returns filePath values that other tools accept verbatim. totalExact distinguishes complete totals; scanTruncated is separate from the result page limit.

Annotations: read-only, idempotent, closed world.

| Argument       | Type            | Required | Description                                                                 |
| -------------- | --------------- | -------- | --------------------------------------------------------------------------- |
| `subdirectory` | string          |          | Folder under the root to list.                                              |
| `pattern`      | string          |          | Glob over the relative path, for example q1/*.xlsx.                         |
| `maxResults`   | integer (1–200) |          | Maximum returned files, default 50. Does not increase the traversal budget. |

## `describe_workbook`

Summarise a workbook: sheets, used ranges, merge and validation counts, formula cache coverage and defined names. Call this before reading data.

Annotations: read-only, idempotent, closed world.

| Argument              | Type                                                                                                | Required | Description                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `filePath`            | string                                                                                              | yes      | Workbook path relative to the server root, as returned by list_workbooks.                                                 |
| `includeDefinedNames` | boolean                                                                                             |          | Include the defined-name list, default true. The list is partial: sheet-local scopes may be missing; inspect limitations. |
| `delimiter`           | `"comma"` \| `"semicolon"` \| `"tab"` \| `"pipe"`                                                   |          | CSV field separator. Sniffed and echoed back when omitted.                                                                |
| `encoding`            | `"utf-8"` \| `"utf-16le"` \| `"utf-16be"` \| `"windows-1254"` \| `"iso-8859-9"` \| `"windows-1252"` |          | CSV text encoding. Detected from the byte-order mark, else utf-8.                                                         |

## `read_sheet`

Read a rectangular cell range as a compact grid: hoisted column headers plus row arrays. Pass nextCursor back to continue a truncated read.

Annotations: read-only, idempotent, closed world.

| Argument            | Type                                                                                                | Required | Description                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filePath`          | string                                                                                              | yes      | Workbook path relative to the server root, as returned by list_workbooks.                                                                                                                                   |
| `sheetName`         | string                                                                                              |          | Case-sensitive worksheet name with NFC equivalence; no case-insensitive fallback. Defaults to the first visible sheet. Unknown names return available names.                                                |
| `range`             | string                                                                                              |          | A1 range such as B2:D40, B:D or 2:40. Defaults to the used range.                                                                                                                                           |
| `cursor`            | string                                                                                              |          | Opaque v2 token from a previous response. Cannot be combined with sheetName or range. Omitted interpretation and CSV options are inherited; explicit values must match the first page. maxCells may change. |
| `maxCells`          | integer (1–10000)                                                                                   |          | Cells per response, default 2000. May change between cursor pages.                                                                                                                                          |
| `valueMode`         | `"values"` \| `"formulas"` \| `"both"`                                                              |          | Values, formulas, or values with formula notes; default values. Cursor-bound: conflicts are rejected. XLSX only.                                                                                            |
| `mergedCells`       | `"master"` \| `"repeat"`                                                                            |          | Master-only or repeated merged values, default master. Applies to headers too. Cursor-bound; XLSX only.                                                                                                     |
| `headerRow`         | integer (≥ 0)                                                                                       |          | Explicit header row. New reads default to 1; 0 disables headers. Cursor-bound: omit to inherit. Cannot be combined with headerScan=true.                                                                    |
| `headerScan`        | boolean                                                                                             |          | Detect a provable header row, default false. Cannot be combined with headerRow on a new read. Cursor-bound: omit to inherit. Ambiguity fails rather than guessing.                                          |
| `includeHyperlinks` | boolean                                                                                             |          | Include hyperlink notes, default false. Cursor-bound; true requires XLSX.                                                                                                                                   |
| `delimiter`         | `"comma"` \| `"semicolon"` \| `"tab"` \| `"pipe"`                                                   |          | CSV field separator. Sniffed and echoed back when omitted.                                                                                                                                                  |
| `encoding`          | `"utf-8"` \| `"utf-16le"` \| `"utf-16be"` \| `"windows-1254"` \| `"iso-8859-9"` \| `"windows-1252"` |          | CSV text encoding. Detected from the byte-order mark, else utf-8.                                                                                                                                           |

## `get_merged_ranges`

List the merged cell ranges of a worksheet.

Annotations: read-only, idempotent, closed world.

| Argument    | Type   | Required | Description                                                                                                                                                  |
| ----------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `filePath`  | string | yes      | Workbook path relative to the server root, as returned by list_workbooks.                                                                                    |
| `sheetName` | string |          | Case-sensitive worksheet name with NFC equivalence; no case-insensitive fallback. Defaults to the first visible sheet. Unknown names return available names. |

## `get_data_validations`

List the data validation rules of a worksheet, grouped back into rectangular ranges.

Annotations: read-only, idempotent, closed world.

| Argument    | Type   | Required | Description                                                                                                                                                  |
| ----------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `filePath`  | string | yes      | Workbook path relative to the server root, as returned by list_workbooks.                                                                                    |
| `sheetName` | string |          | Case-sensitive worksheet name with NFC equivalence; no case-insensitive fallback. Defaults to the first visible sheet. Unknown names return available names. |

## `get_tables`

List the Excel Tables (ListObjects) a worksheet declares: range, header and totals rows, and column names with their A1 letters.

Annotations: read-only, idempotent, closed world.

| Argument    | Type   | Required | Description                                                                                                                                                  |
| ----------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `filePath`  | string | yes      | Workbook path relative to the server root, as returned by list_workbooks.                                                                                    |
| `sheetName` | string |          | Case-sensitive worksheet name with NFC equivalence; no case-insensitive fallback. Defaults to the first visible sheet. Unknown names return available names. |

## `get_conditional_formats`

List the conditional formatting rules of a worksheet as predicates: target ranges, rule kind, operator, formulae and thresholds. Fill colours, icons and bar geometry are not reported.

Annotations: read-only, idempotent, closed world.

| Argument    | Type   | Required | Description                                                                                                                                                  |
| ----------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `filePath`  | string | yes      | Workbook path relative to the server root, as returned by list_workbooks.                                                                                    |
| `sheetName` | string |          | Case-sensitive worksheet name with NFC equivalence; no case-insensitive fallback. Defaults to the first visible sheet. Unknown names return available names. |

## `get_images`

List the pictures embedded in a worksheet: anchor range, byte size and file extension. Charts, pivot tables and sparklines cannot be read and are refused rather than reported as absent.

Annotations: read-only, idempotent, closed world.

| Argument    | Type                                                        | Required | Description                                                                                                                                                  |
| ----------- | ----------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `filePath`  | string                                                      | yes      | Workbook path relative to the server root, as returned by list_workbooks.                                                                                    |
| `sheetName` | string                                                      |          | Case-sensitive worksheet name with NFC equivalence; no case-insensitive fallback. Defaults to the first visible sheet. Unknown names return available names. |
| `kind`      | `"picture"` \| `"chart"` \| `"pivotTable"` \| `"sparkline"` |          | Drawing kind. Only 'picture' can be read; the other kinds are refused rather than reported as absent.                                                        |

## `aggregate_sheet`

Group rows and compute totals, averages, extremes and counts over a sheet in one call. Use this instead of paging a large sheet. Columns are named by header text or by A1 letter.

Annotations: read-only, idempotent, closed world.

| Argument           | Type                                                                                                                                                                                                                | Required | Description                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filePath`         | string                                                                                                                                                                                                              | yes      | Workbook path relative to the server root, as returned by list_workbooks.                                                                                                                                                                                                    |
| `sheetName`        | string                                                                                                                                                                                                              |          | Case-sensitive worksheet name with NFC equivalence; no case-insensitive fallback. Defaults to the first visible sheet. Unknown names return available names.                                                                                                                 |
| `range`            | string                                                                                                                                                                                                              |          | A1 range such as A1:H500, B:D or 2:40, including the header row. Defaults to the used range.                                                                                                                                                                                 |
| `groupBy`          | array of string (≤ 8 items)                                                                                                                                                                                         |          | Columns to group by. Omit for a single whole-range total.                                                                                                                                                                                                                    |
| `metrics`          | array of object (1–8 items)                                                                                                                                                                                         | yes      | Values to compute. Each metric becomes one output column after the groupBy columns, labelled fn(column).                                                                                                                                                                     |
| `metrics[].fn`     | `"count"` \| `"countValues"` \| `"countDistinct"` \| `"sum"` \| `"avg"` \| `"min"` \| `"max"` \| `"stddev"`                                                                                                         | yes      | count counts matched rows and needs no column. countValues counts the column's non-empty cells, countDistinct its distinct values. sum, avg and stddev read numeric cells; min and max read numbers, dates or text, one kind per column. Other cells are counted as skipped. |
| `metrics[].column` | string                                                                                                                                                                                                              |          | Header text of the column, or its A1 letter such as C. Header text is matched case- and accent-insensitively.                                                                                                                                                                |
| `where`            | array of object (≤ 16 items)                                                                                                                                                                                        |          | Row filter. A cell of a different kind from the operand never matches and is counted as skipped.                                                                                                                                                                             |
| `where[].column`   | string                                                                                                                                                                                                              | yes      | Header text of the column, or its A1 letter such as C. Header text is matched case- and accent-insensitively.                                                                                                                                                                |
| `where[].op`       | `"eq"` \| `"ne"` \| `"lt"` \| `"lte"` \| `"gt"` \| `"gte"` \| `"contains"` \| `"startsWith"` \| `"endsWith"` \| `"in"` \| `"between"` \| `"isEmpty"` \| `"isNotEmpty"` \| `"isError"` \| `"isNumber"` \| `"isText"` | yes      | Comparison and text operators take value; in takes values; between takes values as [low, high], both inclusive and of one kind; isEmpty, isNotEmpty, isError, isNumber and isText take neither.                                                                              |
| `where[].value`    | string \| number \| boolean                                                                                                                                                                                         |          | Operand of eq, ne, lt, lte, gt, gte, contains, startsWith and endsWith.                                                                                                                                                                                                      |
| `where[].values`   | array of string \| number \| boolean (1–64 items)                                                                                                                                                                   |          | Operands of in (any of them) and between (exactly two: low and high).                                                                                                                                                                                                        |
| `match`            | `"all"` \| `"any"`                                                                                                                                                                                                  |          | Combine predicates with all (default) or any.                                                                                                                                                                                                                                |
| `headerRow`        | integer (≥ 0)                                                                                                                                                                                                       |          | Row treated as headers, never detected. Defaults to 1; 0 disables.                                                                                                                                                                                                           |
| `headerScan`       | boolean                                                                                                                                                                                                             |          | Prove the header row from the sheet instead of assuming row 1. Cannot be combined with headerRow. Fails rather than guessing.                                                                                                                                                |
| `columnMode`       | `"auto"` \| `"header"` \| `"letter"`                                                                                                                                                                                |          | Automatic resolution (default), header text, or A1 letter. Letter mode ignores duplicate headers.                                                                                                                                                                            |
| `caseSensitive`    | boolean                                                                                                                                                                                                             |          | Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.                                                                                                                                                                                     |
| `coerceText`       | boolean                                                                                                                                                                                                             |          | Treat numeric text such as "1234.50" as a number. Off by default.                                                                                                                                                                                                            |
| `mergedCells`      | `"master"` \| `"repeat"`                                                                                                                                                                                            |          | Merged values and header detection policy, default master.                                                                                                                                                                                                                   |
| `orderBy`          | `"group"` \| `"metric"`                                                                                                                                                                                             |          | Sort by group key (default) or selected metric.                                                                                                                                                                                                                              |
| `orderByMetric`    | integer (1–8)                                                                                                                                                                                                       |          | One-based index into metrics, default 1. Cannot exceed the actual metrics count.                                                                                                                                                                                             |
| `descending`       | boolean                                                                                                                                                                                                             |          | Descending sort, default false.                                                                                                                                                                                                                                              |
| `maxGroups`        | integer (1–500)                                                                                                                                                                                                     |          | Maximum groups returned, default 50. matchedRows covers all groups; metric counted/skipped covers returnedMatchedRows.                                                                                                                                                       |
| `delimiter`        | `"comma"` \| `"semicolon"` \| `"tab"` \| `"pipe"`                                                                                                                                                                   |          | CSV field separator. Sniffed and echoed back when omitted.                                                                                                                                                                                                                   |
| `encoding`         | `"utf-8"` \| `"utf-16le"` \| `"utf-16be"` \| `"windows-1254"` \| `"iso-8859-9"` \| `"windows-1252"`                                                                                                                 |          | CSV text encoding. Detected from the byte-order mark, else utf-8.                                                                                                                                                                                                            |

## `find_in_sheet`

Find cells whose value or formula matches a query. Use this instead of paging a large sheet.

Annotations: read-only, idempotent, closed world.

| Argument        | Type                                                                                                | Required | Description                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `filePath`      | string                                                                                              | yes      | Workbook path relative to the server root, as returned by list_workbooks.                                                                                    |
| `query`         | string (≥ 1 chars)                                                                                  | yes      | Text to find, or a JavaScript regular expression of at most 256 characters when matchMode is regex.                                                          |
| `sheetName`     | string                                                                                              |          | Case-sensitive worksheet name with NFC equivalence; no case-insensitive fallback. Defaults to the first visible sheet. Unknown names return available names. |
| `matchMode`     | `"contains"` \| `"exact"` \| `"regex"`                                                              |          | Contains (default), exact text or JavaScript regex. Regex runs in an isolated worker with a two-second deadline.                                             |
| `caseSensitive` | boolean                                                                                             |          | Case-sensitive matching, default false. Literal search uses NFC/folding; regex retains JavaScript semantics.                                                 |
| `searchIn`      | `"values"` \| `"formulas"` \| `"both"`                                                              |          | Search values (default), formulas or both. CSV supports values only.                                                                                         |
| `range`         | string                                                                                              |          | A1 range to search, such as B2:D40, B:D or 2:40. Defaults to the used range.                                                                                 |
| `maxResults`    | integer (1–200)                                                                                     |          | Maximum returned matches, default 50. Does not increase the regex deadline.                                                                                  |
| `delimiter`     | `"comma"` \| `"semicolon"` \| `"tab"` \| `"pipe"`                                                   |          | CSV field separator. Sniffed and echoed back when omitted.                                                                                                   |
| `encoding`      | `"utf-8"` \| `"utf-16le"` \| `"utf-16be"` \| `"windows-1254"` \| `"iso-8859-9"` \| `"windows-1252"` |          | CSV text encoding. Detected from the byte-order mark, else utf-8.                                                                                            |
