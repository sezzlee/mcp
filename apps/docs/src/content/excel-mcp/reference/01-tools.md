# Tools

> Generated from the `tools/list` answer (server name `sezzlee-excel`) of `@sezzlee/excel-mcp` 0.11.0.

The descriptions are the text the server publishes to every client, so your agent reads exactly what this page shows. Every input schema is closed: an argument a tool does not list here, or a value of the wrong type, is refused with `invalid_argument` and never silently ignored.

22 tools: `list_workbooks`, `describe_workbook`, `read_sheet`, `profile_sheet`, `get_merged_ranges`, `get_data_validations`, `get_tables`, `get_conditional_formats`, `get_images`, `get_charts`, `aggregate_sheet`, `find_in_sheet`, `prepare_bulk_job`, `run_bulk_job`, `get_bulk_job`, `prepare_bulk`, `prepare_edit`, `prepare_transfer`, `transfer_data`, `create_workbook`, `edit_workbook`, `create_workbook_version`.

## `list_workbooks`

List readable .xlsx, .xlsm and .csv files under the server root, as filePath values the other tools accept.

Annotations: read-only, idempotent, closed world.

| Argument       | Type            | Required | Description                                                                 |
| -------------- | --------------- | -------- | --------------------------------------------------------------------------- |
| `subdirectory` | string          |          | Folder under the root to list.                                              |
| `pattern`      | string          |          | Glob over the relative path, for example q1/*.xlsx.                         |
| `maxResults`   | integer (1–200) |          | Maximum returned files, default 50. Does not increase the traversal budget. |

## `describe_workbook`

Discover sheets, used ranges, each sheet's header row and first column names (the row reads use by default), merge and validation counts, formula cache coverage and defined names. A known file and columns can be read or aggregated directly.

Annotations: read-only, idempotent, closed world.

| Argument              | Type                                                                                                                                                                                                  | Required | Description                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------- |
| `filePath`            | string                                                                                                                                                                                                | yes      | Path under the server root, as list_workbooks returns it. |
| `includeDefinedNames` | boolean                                                                                                                                                                                               |          | Include defined names, default true.                      |
| `delimiter`           | `"comma"` \| `"semicolon"` \| `"tab"` \| `"pipe"`                                                                                                                                                     |          | CSV separator; sniffed when omitted.                      |
| `encoding`            | `"utf-8"` \| `"utf-16le"` \| `"utf-16be"` \| `"windows-1254"` \| `"iso-8859-9"` \| `"windows-1252"` \| `"windows-1251"` \| `"windows-1256"` \| `"shift_jis"` \| `"gb18030"` \| `"big5"` \| `"euc-kr"` |          | CSV encoding; BOM or utf-8 when omitted.                  |

## `read_sheet`

Read a rectangular cell range as a compact grid: hoisted column headers plus row arrays, with rowNumbers giving the sheet row of each array. Pass nextCursor back to continue a truncated read. A date and time stored without a zone is returned without one, as a local wall clock; a written offset is kept.

Annotations: read-only, idempotent, closed world.

| Argument                    | Type                                                                                                                                                                                                  | Required | Description                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filePath`                  | string                                                                                                                                                                                                | yes      | Path under the server root, as list_workbooks returns it.                                                                                                                                                               |
| `sheetName`                 | string                                                                                                                                                                                                |          | Exact worksheet name; defaults to the first visible sheet.                                                                                                                                                              |
| `table`                     | string (1–255 chars)                                                                                                                                                                                  |          | Declared table name; selects its data rows. Not with range. XLSX only.                                                                                                                                                  |
| `visibleOnly`               | boolean                                                                                                                                                                                               |          | Skip saved hidden rows, AutoFilter's included. XLSX only.                                                                                                                                                               |
| `range`                     | string                                                                                                                                                                                                |          | A1 range such as B2:D40, B:D or 2:40. Defaults to the used range.                                                                                                                                                       |
| `columns`                   | array of object (1–64 items)                                                                                                                                                                          |          | How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues. |
| `columns[].column`          | string                                                                                                                                                                                                | yes      | Header text or A1 letter.                                                                                                                                                                                               |
| `columns[].type`            | `"number"` \| `"date"` \| `"boolean"` \| `"time"` \| `"duration"` \| `"text"`                                                                                                                         | yes      | How to read the column.                                                                                                                                                                                                 |
| `columns[].missingValues`   | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | Missing-text tokens.                                                                                                                                                                                                    |
| `columns[].decimal`         | `"."` \| `","`                                                                                                                                                                                        |          | Decimal separator, for number.                                                                                                                                                                                          |
| `columns[].group`           | `"none"` \| `"."` \| `","` \| `" "` \| `"'"`                                                                                                                                                          |          | Thousands separator, for number.                                                                                                                                                                                        |
| `columns[].locale`          | string (2–64 chars)                                                                                                                                                                                   |          | File locale, for number or date.                                                                                                                                                                                        |
| `columns[].numberingSystem` | string (3–32 chars)                                                                                                                                                                                   |          | Numbering system, for number.                                                                                                                                                                                           |
| `columns[].identifiers`     | `"refuse"` \| `"read"`                                                                                                                                                                                |          | Whether to read digit identifiers, for number.                                                                                                                                                                          |
| `columns[].format`          | string (1–64 chars)                                                                                                                                                                                   |          | Date pattern such as dd.MM.yyyy, for date.                                                                                                                                                                              |
| `columns[].order`           | `"dmy"` \| `"mdy"`                                                                                                                                                                                    |          | Day/month order without a format, for date.                                                                                                                                                                             |
| `columns[].trueValues`      | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | True-text tokens, for boolean.                                                                                                                                                                                          |
| `columns[].falseValues`     | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | False-text tokens, for boolean.                                                                                                                                                                                         |
| `locale`                    | string (2–64 chars)                                                                                                                                                                                   |          | BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.                                                                                                        |
| `numberingSystem`           | string (3–32 chars)                                                                                                                                                                                   |          | Numbering system such as arab; needs locale.                                                                                                                                                                            |
| `missingValues`             | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | Missing-text tokens; default N/A, NULL, -, —, #N/A.                                                                                                                                                                     |
| `trueValues`                | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | True-text tokens; default true, yes, y, Evet, E.                                                                                                                                                                        |
| `falseValues`               | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | False-text tokens; default false, no, n, Hayır, H.                                                                                                                                                                      |
| `columnMode`                | `"auto"` \| `"header"` \| `"letter"`                                                                                                                                                                  |          | Columns are named by header text or A1 letter: auto (default), header or letter.                                                                                                                                        |
| `includeTyped`              | boolean                                                                                                                                                                                               |          | Add a typedValues grid read by columns, which it requires.                                                                                                                                                              |
| `cursor`                    | string                                                                                                                                                                                                |          | nextCursor of the previous page; not with sheetName or range. Options are inherited.                                                                                                                                    |
| `maxCells`                  | integer (1–10000)                                                                                                                                                                                     |          | Cells per response, default 2000. May change between cursor pages.                                                                                                                                                      |
| `valueMode`                 | `"values"` \| `"formulas"` \| `"both"`                                                                                                                                                                |          | values (default), formulas, or values with formula notes. XLSX only.                                                                                                                                                    |
| `mergedCells`               | `"master"` \| `"repeat"`                                                                                                                                                                              |          | Merged cells: master value only (default) or repeated. XLSX only.                                                                                                                                                       |
| `headerRow`                 | integer (≥ 0)                                                                                                                                                                                         |          | Header row, 0 for none. Omitted: a table or autofilter header, else the first top row naming its columns in text above any data, else row 1.                                                                            |
| `headerScan`                | boolean                                                                                                                                                                                               |          | Strict header detection: refuse when two rows or none qualify. Cannot be combined with headerRow on a new read. Cursor-bound: omit to inherit.                                                                          |
| `includeHyperlinks`         | boolean                                                                                                                                                                                               |          | Include hyperlink notes, default false. Cursor-bound; true requires XLSX.                                                                                                                                               |
| `delimiter`                 | `"comma"` \| `"semicolon"` \| `"tab"` \| `"pipe"`                                                                                                                                                     |          | CSV separator; sniffed when omitted.                                                                                                                                                                                    |
| `encoding`                  | `"utf-8"` \| `"utf-16le"` \| `"utf-16be"` \| `"windows-1254"` \| `"iso-8859-9"` \| `"windows-1252"` \| `"windows-1251"` \| `"windows-1256"` \| `"shift_jis"` \| `"gb18030"` \| `"big5"` \| `"euc-kr"` |          | CSV encoding; BOM or utf-8 when omitted.                                                                                                                                                                                |

## `profile_sheet`

Profile a bounded rectangular prefix: types and confidence, formats, missing and distinct values, extrema, frequent values, unreadable examples and identifier signals. Returns reusable columns plus explicit sampling limits. This inspects cell contents.

Annotations: read-only, idempotent, closed world.

| Argument                    | Type                                                                                                                                                                                                  | Required | Description                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filePath`                  | string                                                                                                                                                                                                | yes      | Path under the server root, as list_workbooks returns it.                                                                                                                                                               |
| `sheetName`                 | string                                                                                                                                                                                                |          | Exact worksheet name; defaults to the first visible sheet.                                                                                                                                                              |
| `table`                     | string (1–255 chars)                                                                                                                                                                                  |          | Declared table name; selects its data rows. Not with range. XLSX only.                                                                                                                                                  |
| `visibleOnly`               | boolean                                                                                                                                                                                               |          | Skip saved hidden rows, AutoFilter's included. XLSX only.                                                                                                                                                               |
| `range`                     | string                                                                                                                                                                                                |          | A1 range including any header row, default used range.                                                                                                                                                                  |
| `headerRow`                 | integer (0–1048576)                                                                                                                                                                                   |          | Header row, 0 for none. Omitted: a table or autofilter header, else the first top row naming its columns in text above any data, else row 1.                                                                            |
| `headerScan`                | boolean                                                                                                                                                                                               |          | Strict header detection: refuse when two rows or none qualify.                                                                                                                                                          |
| `columns`                   | array of object (1–64 items)                                                                                                                                                                          |          | How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues. |
| `columns[].column`          | string                                                                                                                                                                                                | yes      | Header text or A1 letter.                                                                                                                                                                                               |
| `columns[].type`            | `"number"` \| `"date"` \| `"boolean"` \| `"time"` \| `"duration"` \| `"text"`                                                                                                                         | yes      | How to read the column.                                                                                                                                                                                                 |
| `columns[].missingValues`   | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | Missing-text tokens.                                                                                                                                                                                                    |
| `columns[].decimal`         | `"."` \| `","`                                                                                                                                                                                        |          | Decimal separator, for number.                                                                                                                                                                                          |
| `columns[].group`           | `"none"` \| `"."` \| `","` \| `" "` \| `"'"`                                                                                                                                                          |          | Thousands separator, for number.                                                                                                                                                                                        |
| `columns[].locale`          | string (2–64 chars)                                                                                                                                                                                   |          | File locale, for number or date.                                                                                                                                                                                        |
| `columns[].numberingSystem` | string (3–32 chars)                                                                                                                                                                                   |          | Numbering system, for number.                                                                                                                                                                                           |
| `columns[].identifiers`     | `"refuse"` \| `"read"`                                                                                                                                                                                |          | Whether to read digit identifiers, for number.                                                                                                                                                                          |
| `columns[].format`          | string (1–64 chars)                                                                                                                                                                                   |          | Date pattern such as dd.MM.yyyy, for date.                                                                                                                                                                              |
| `columns[].order`           | `"dmy"` \| `"mdy"`                                                                                                                                                                                    |          | Day/month order without a format, for date.                                                                                                                                                                             |
| `columns[].trueValues`      | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | True-text tokens, for boolean.                                                                                                                                                                                          |
| `columns[].falseValues`     | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | False-text tokens, for boolean.                                                                                                                                                                                         |
| `locale`                    | string (2–64 chars)                                                                                                                                                                                   |          | BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.                                                                                                        |
| `numberingSystem`           | string (3–32 chars)                                                                                                                                                                                   |          | Numbering system such as arab; needs locale.                                                                                                                                                                            |
| `missingValues`             | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | Missing-text tokens; default N/A, NULL, -, —, #N/A.                                                                                                                                                                     |
| `trueValues`                | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | True-text tokens; default true, yes, y, Evet, E.                                                                                                                                                                        |
| `falseValues`               | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | False-text tokens; default false, no, n, Hayır, H.                                                                                                                                                                      |
| `columnMode`                | `"auto"` \| `"header"` \| `"letter"`                                                                                                                                                                  |          | Columns are named by header text or A1 letter: auto (default), header or letter.                                                                                                                                        |
| `mergedCells`               | `"master"` \| `"repeat"`                                                                                                                                                                              |          | Merged cell policy, default master.                                                                                                                                                                                     |
| `maxRows`                   | integer (1–5000)                                                                                                                                                                                      |          | Sampled rows, default 1000.                                                                                                                                                                                             |
| `maxColumns`                | integer (1–64)                                                                                                                                                                                        |          | Profiled columns, default 16.                                                                                                                                                                                           |
| `delimiter`                 | `"comma"` \| `"semicolon"` \| `"tab"` \| `"pipe"`                                                                                                                                                     |          | CSV separator; sniffed when omitted.                                                                                                                                                                                    |
| `encoding`                  | `"utf-8"` \| `"utf-16le"` \| `"utf-16be"` \| `"windows-1254"` \| `"iso-8859-9"` \| `"windows-1252"` \| `"windows-1251"` \| `"windows-1256"` \| `"shift_jis"` \| `"gb18030"` \| `"big5"` \| `"euc-kr"` |          | CSV encoding; BOM or utf-8 when omitted.                                                                                                                                                                                |

## `get_merged_ranges`

List the merged cell ranges of a worksheet.

Annotations: read-only, idempotent, closed world.

| Argument    | Type   | Required | Description                                                |
| ----------- | ------ | -------- | ---------------------------------------------------------- |
| `filePath`  | string | yes      | Path under the server root, as list_workbooks returns it.  |
| `sheetName` | string |          | Exact worksheet name; defaults to the first visible sheet. |

## `get_data_validations`

List the data validation rules of a worksheet, grouped back into rectangular ranges.

Annotations: read-only, idempotent, closed world.

| Argument    | Type   | Required | Description                                                |
| ----------- | ------ | -------- | ---------------------------------------------------------- |
| `filePath`  | string | yes      | Path under the server root, as list_workbooks returns it.  |
| `sheetName` | string |          | Exact worksheet name; defaults to the first visible sheet. |

## `get_tables`

List the Excel Tables (ListObjects) a worksheet declares: range, header and totals rows, and column names with their A1 letters.

Annotations: read-only, idempotent, closed world.

| Argument    | Type   | Required | Description                                                |
| ----------- | ------ | -------- | ---------------------------------------------------------- |
| `filePath`  | string | yes      | Path under the server root, as list_workbooks returns it.  |
| `sheetName` | string |          | Exact worksheet name; defaults to the first visible sheet. |

## `get_conditional_formats`

List the conditional formatting rules of a worksheet as predicates: target ranges, rule kind, operator, formulae and thresholds. Fill colours, icons and bar geometry are not reported.

Annotations: read-only, idempotent, closed world.

| Argument    | Type   | Required | Description                                                |
| ----------- | ------ | -------- | ---------------------------------------------------------- |
| `filePath`  | string | yes      | Path under the server root, as list_workbooks returns it.  |
| `sheetName` | string |          | Exact worksheet name; defaults to the first visible sheet. |

## `get_images`

List worksheet pictures, in-cell images included: anchor, size, extension, alternative text and decorative flag. imageId matches read_sheet values. Pixels are not interpreted.

Annotations: read-only, idempotent, closed world.

| Argument    | Type                                                        | Required | Description                                                |
| ----------- | ----------------------------------------------------------- | -------- | ---------------------------------------------------------- |
| `filePath`  | string                                                      | yes      | Path under the server root, as list_workbooks returns it.  |
| `sheetName` | string                                                      |          | Exact worksheet name; defaults to the first visible sheet. |
| `kind`      | `"picture"` \| `"chart"` \| `"pivotTable"` \| `"sparkline"` |          | Only picture is read here; charts are get_charts'.         |

## `get_charts`

List charts on a worksheet or chart sheet: type, title, axes, series references with cached points, trendlines and pivot source. Cached values may be stale; read the ref for current cells.

Annotations: read-only, idempotent, closed world.

| Argument    | Type             | Required | Description                                                                         |
| ----------- | ---------------- | -------- | ----------------------------------------------------------------------------------- |
| `filePath`  | string           | yes      | Path under the server root, as list_workbooks returns it.                           |
| `sheetName` | string           |          | Exact worksheet name; defaults to the first visible sheet.                          |
| `chartId`   | integer (≥ 1)    |          | 1-based chart index on the sheet. Omit to list every chart up to the per-sheet cap. |
| `maxPoints` | integer (1–2000) |          | Cached points per series, default 200, at most 2000.                                |

## `aggregate_sheet`

Answer questions with filtered totals, conditional metrics, rankings, several breakdowns or a pivot in one call. Use this instead of paging rows for a calculation. Known files and columns need no prior discovery call. Columns are named by header text or by A1 letter. A date and time stored without a zone is returned without one, as a local wall clock.

Annotations: read-only, idempotent, closed world.

| Argument                             | Type                                                                                                                                                                                                                                                   | Required | Description                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filePath`                           | string                                                                                                                                                                                                                                                 | yes      | Path under the server root, as list_workbooks returns it.                                                                                                                                                                                                                                                                                                                        |
| `sheetName`                          | string                                                                                                                                                                                                                                                 |          | Exact worksheet name; defaults to the first visible sheet.                                                                                                                                                                                                                                                                                                                       |
| `table`                              | string (1–255 chars)                                                                                                                                                                                                                                   |          | Declared table name; selects its data rows. Not with range. XLSX only.                                                                                                                                                                                                                                                                                                           |
| `visibleOnly`                        | boolean                                                                                                                                                                                                                                                |          | Skip saved hidden rows, AutoFilter's included. XLSX only.                                                                                                                                                                                                                                                                                                                        |
| `range`                              | string                                                                                                                                                                                                                                                 |          | A1 range such as A1:H500, B:D or 2:40, including the header row. Defaults to the used range.                                                                                                                                                                                                                                                                                     |
| `groupBy`                            | array of any (≤ 8 items)                                                                                                                                                                                                                               |          | Row grouping keys; omit for a whole-range total. A key is a column, {column, by} for a UTC date part (month includes the year, week is ISO, weekday Monday=1), or {column, bins} or {column, width, origin?} for [lower, upper) bins.                                                                                                                                            |
| `pivotBy`                            | array of any (≤ 8 items)                                                                                                                                                                                                                               |          | Column axis of a dense pivot, in groupBy's key forms. Missing combinations have count 0, other metrics null.                                                                                                                                                                                                                                                                     |
| `groupingSets`                       | array of object (1–8 items)                                                                                                                                                                                                                            |          | More breakdowns [{groupBy}] in groupBy's key forms over the same scan, returned in groupingSets; [] gives a grand total.                                                                                                                                                                                                                                                         |
| `groupingSets[].groupBy`             | array of any (≤ 8 items)                                                                                                                                                                                                                               | yes      | Keys in groupBy's forms.                                                                                                                                                                                                                                                                                                                                                         |
| `compact`                            | boolean                                                                                                                                                                                                                                                |          | Omit repeated CSV and mode metadata; diagnostics remain.                                                                                                                                                                                                                                                                                                                         |
| `metrics`                            | array of object (1–8 items)                                                                                                                                                                                                                            | yes      | Values to compute [{fn, column?, percentile?, round?, where?}], one output column each after the group keys. A metric's where has the top-level where's form and applies after it.                                                                                                                                                                                               |
| `metrics[].fn`                       | `"count"` \| `"countValues"` \| `"countDistinct"` \| `"countTrue"` \| `"countFalse"` \| `"trueRatio"` \| `"sum"` \| `"avg"` \| `"min"` \| `"max"` \| `"stddev"` \| `"median"` \| `"p50"` \| `"p90"` \| `"percentile"`                                  | yes      | count counts matched rows, countValues non-empty cells, countDistinct distinct values; trueRatio is true over valid booleans. Numeric functions read numeric text and skip identifiers; percentiles are PERCENTILE.INC; stddev is the sample deviation.                                                                                                                          |
| `metrics[].column`                   | string                                                                                                                                                                                                                                                 |          | Header text or A1 letter.                                                                                                                                                                                                                                                                                                                                                        |
| `metrics[].percentile`               | number (0–1)                                                                                                                                                                                                                                           |          | Fraction 0 to 1, for fn percentile.                                                                                                                                                                                                                                                                                                                                              |
| `metrics[].round`                    | integer (0–10)                                                                                                                                                                                                                                         |          | Decimal places, half away from zero as ROUND.                                                                                                                                                                                                                                                                                                                                    |
| `metrics[].where`                    | array of object (≤ 16 items)                                                                                                                                                                                                                           |          | Filter for this metric, in where's form.                                                                                                                                                                                                                                                                                                                                         |
| `metrics[].where[].column`           | string                                                                                                                                                                                                                                                 | yes      | Header text or A1 letter.                                                                                                                                                                                                                                                                                                                                                        |
| `metrics[].where[].op`               | `"eq"` \| `"ne"` \| `"lt"` \| `"lte"` \| `"gt"` \| `"gte"` \| `"contains"` \| `"startsWith"` \| `"endsWith"` \| `"in"` \| `"between"` \| `"isEmpty"` \| `"isNotEmpty"` \| `"isError"` \| `"isNumber"` \| `"isText"` \| `"inColumn"` \| `"notInColumn"` | yes      | Operator.                                                                                                                                                                                                                                                                                                                                                                        |
| `metrics[].where[].value`            | string \| number \| boolean                                                                                                                                                                                                                            |          | Operand.                                                                                                                                                                                                                                                                                                                                                                         |
| `metrics[].where[].values`           | array of string \| number \| boolean (1–64 items)                                                                                                                                                                                                      |          | Operands of in, or [low, high] of between.                                                                                                                                                                                                                                                                                                                                       |
| `metrics[].where[].source`           | object                                                                                                                                                                                                                                                 |          | Column inColumn and notInColumn test against.                                                                                                                                                                                                                                                                                                                                    |
| `metrics[].where[].source.filePath`  | string                                                                                                                                                                                                                                                 |          | Defaults to this file.                                                                                                                                                                                                                                                                                                                                                           |
| `metrics[].where[].source.sheetName` | string                                                                                                                                                                                                                                                 |          | Source sheet.                                                                                                                                                                                                                                                                                                                                                                    |
| `metrics[].where[].source.column`    | string                                                                                                                                                                                                                                                 | yes      | Header text or A1 letter.                                                                                                                                                                                                                                                                                                                                                        |
| `metrics[].where[].source.range`     | string                                                                                                                                                                                                                                                 |          | Source range.                                                                                                                                                                                                                                                                                                                                                                    |
| `metrics[].where[].source.headerRow` | integer (≥ 0)                                                                                                                                                                                                                                          |          | Source header row.                                                                                                                                                                                                                                                                                                                                                               |
| `where`                              | array of object (≤ 16 items)                                                                                                                                                                                                                           |          | Row filter. Conditions {column, op, value?, values?, source?}. Comparison, text and isError ops take value; in takes values; between takes [low, high]; isEmpty, isNotEmpty, isNumber and isText take neither. inColumn and notInColumn take source {filePath?, sheetName?, column, range?, headerRow?}, another column matched as eq compares. Incomparable cells are reported. |
| `where[].column`                     | string                                                                                                                                                                                                                                                 | yes      | Header text or A1 letter.                                                                                                                                                                                                                                                                                                                                                        |
| `where[].op`                         | `"eq"` \| `"ne"` \| `"lt"` \| `"lte"` \| `"gt"` \| `"gte"` \| `"contains"` \| `"startsWith"` \| `"endsWith"` \| `"in"` \| `"between"` \| `"isEmpty"` \| `"isNotEmpty"` \| `"isError"` \| `"isNumber"` \| `"isText"` \| `"inColumn"` \| `"notInColumn"` | yes      | Operator.                                                                                                                                                                                                                                                                                                                                                                        |
| `where[].value`                      | string \| number \| boolean                                                                                                                                                                                                                            |          | Operand.                                                                                                                                                                                                                                                                                                                                                                         |
| `where[].values`                     | array of string \| number \| boolean (1–64 items)                                                                                                                                                                                                      |          | Operands of in, or [low, high] of between.                                                                                                                                                                                                                                                                                                                                       |
| `where[].source`                     | object                                                                                                                                                                                                                                                 |          | Column inColumn and notInColumn test against.                                                                                                                                                                                                                                                                                                                                    |
| `where[].source.filePath`            | string                                                                                                                                                                                                                                                 |          | Defaults to this file.                                                                                                                                                                                                                                                                                                                                                           |
| `where[].source.sheetName`           | string                                                                                                                                                                                                                                                 |          | Source sheet.                                                                                                                                                                                                                                                                                                                                                                    |
| `where[].source.column`              | string                                                                                                                                                                                                                                                 | yes      | Header text or A1 letter.                                                                                                                                                                                                                                                                                                                                                        |
| `where[].source.range`               | string                                                                                                                                                                                                                                                 |          | Source range.                                                                                                                                                                                                                                                                                                                                                                    |
| `where[].source.headerRow`           | integer (≥ 0)                                                                                                                                                                                                                                          |          | Source header row.                                                                                                                                                                                                                                                                                                                                                               |
| `match`                              | `"all"` \| `"any"`                                                                                                                                                                                                                                     |          | Combine predicates with all (default) or any.                                                                                                                                                                                                                                                                                                                                    |
| `headerRow`                          | integer (≥ 0)                                                                                                                                                                                                                                          |          | Header row, 0 for none. Omitted: a table or autofilter header, else the first top row naming its columns in text above any data, else row 1.                                                                                                                                                                                                                                     |
| `headerScan`                         | boolean                                                                                                                                                                                                                                                |          | Strict header detection: refuse when two rows or none qualify.                                                                                                                                                                                                                                                                                                                   |
| `columnMode`                         | `"auto"` \| `"header"` \| `"letter"`                                                                                                                                                                                                                   |          | Columns are named by header text or A1 letter: auto (default), header or letter.                                                                                                                                                                                                                                                                                                 |
| `caseSensitive`                      | boolean                                                                                                                                                                                                                                                |          | Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.                                                                                                                                                                                                                                                                                         |
| `columns`                            | array of object (1–64 items)                                                                                                                                                                                                                           |          | How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues.                                                                                                                                                          |
| `columns[].column`                   | string                                                                                                                                                                                                                                                 | yes      | Header text or A1 letter.                                                                                                                                                                                                                                                                                                                                                        |
| `columns[].type`                     | `"number"` \| `"date"` \| `"boolean"` \| `"time"` \| `"duration"` \| `"text"`                                                                                                                                                                          | yes      | How to read the column.                                                                                                                                                                                                                                                                                                                                                          |
| `columns[].missingValues`            | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                                                                             |          | Missing-text tokens.                                                                                                                                                                                                                                                                                                                                                             |
| `columns[].decimal`                  | `"."` \| `","`                                                                                                                                                                                                                                         |          | Decimal separator, for number.                                                                                                                                                                                                                                                                                                                                                   |
| `columns[].group`                    | `"none"` \| `"."` \| `","` \| `" "` \| `"'"`                                                                                                                                                                                                           |          | Thousands separator, for number.                                                                                                                                                                                                                                                                                                                                                 |
| `columns[].locale`                   | string (2–64 chars)                                                                                                                                                                                                                                    |          | File locale, for number or date.                                                                                                                                                                                                                                                                                                                                                 |
| `columns[].numberingSystem`          | string (3–32 chars)                                                                                                                                                                                                                                    |          | Numbering system, for number.                                                                                                                                                                                                                                                                                                                                                    |
| `columns[].identifiers`              | `"refuse"` \| `"read"`                                                                                                                                                                                                                                 |          | Whether to read digit identifiers, for number.                                                                                                                                                                                                                                                                                                                                   |
| `columns[].format`                   | string (1–64 chars)                                                                                                                                                                                                                                    |          | Date pattern such as dd.MM.yyyy, for date.                                                                                                                                                                                                                                                                                                                                       |
| `columns[].order`                    | `"dmy"` \| `"mdy"`                                                                                                                                                                                                                                     |          | Day/month order without a format, for date.                                                                                                                                                                                                                                                                                                                                      |
| `columns[].trueValues`               | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                                                                             |          | True-text tokens, for boolean.                                                                                                                                                                                                                                                                                                                                                   |
| `columns[].falseValues`              | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                                                                             |          | False-text tokens, for boolean.                                                                                                                                                                                                                                                                                                                                                  |
| `locale`                             | string (2–64 chars)                                                                                                                                                                                                                                    |          | BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.                                                                                                                                                                                                                                                                 |
| `numberingSystem`                    | string (3–32 chars)                                                                                                                                                                                                                                    |          | Numbering system such as arab; needs locale.                                                                                                                                                                                                                                                                                                                                     |
| `missingValues`                      | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                                                                             |          | Missing-text tokens; default N/A, NULL, -, —, #N/A.                                                                                                                                                                                                                                                                                                                              |
| `trueValues`                         | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                                                                             |          | True-text tokens; default true, yes, y, Evet, E.                                                                                                                                                                                                                                                                                                                                 |
| `falseValues`                        | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                                                                             |          | False-text tokens; default false, no, n, Hayır, H.                                                                                                                                                                                                                                                                                                                               |
| `mergedCells`                        | `"master"` \| `"repeat"`                                                                                                                                                                                                                               |          | Merged values and header detection policy, default master.                                                                                                                                                                                                                                                                                                                       |
| `orderBy`                            | `"group"` \| `"metric"`                                                                                                                                                                                                                                |          | Sort by group key (default) or selected metric.                                                                                                                                                                                                                                                                                                                                  |
| `orderByMetric`                      | integer (1–8)                                                                                                                                                                                                                                          |          | One-based index into metrics, default 1. Cannot exceed the actual metrics count.                                                                                                                                                                                                                                                                                                 |
| `orderByDerived`                     | string                                                                                                                                                                                                                                                 |          | Derived metric to sort by with orderBy metric.                                                                                                                                                                                                                                                                                                                                   |
| `derived`                            | array of object (1–4 items)                                                                                                                                                                                                                            |          | Per-group values from the metrics: ratios, shares, differences, adjusted totals; appended after the metrics. Not with pivotBy.                                                                                                                                                                                                                                                   |
| `derived[].name`                     | string (1–64 chars)                                                                                                                                                                                                                                    | yes      | Output column label.                                                                                                                                                                                                                                                                                                                                                             |
| `derived[].numerator`                | array of object (1–8 items)                                                                                                                                                                                                                            | yes      | Terms added together: factor (default 1) × metric.                                                                                                                                                                                                                                                                                                                               |
| `derived[].numerator[].metric`       | integer (1–8)                                                                                                                                                                                                                                          | yes      | One-based index into metrics.                                                                                                                                                                                                                                                                                                                                                    |
| `derived[].numerator[].factor`       | number                                                                                                                                                                                                                                                 |          | Multiplier, default 1.                                                                                                                                                                                                                                                                                                                                                           |
| `derived[].numerator[].scope`        | `"group"` \| `"total"`                                                                                                                                                                                                                                 |          | group (default) or total: the metric summed over every group, for a share; counts and sum only.                                                                                                                                                                                                                                                                                  |
| `derived[].denominator`              | array of object (1–8 items)                                                                                                                                                                                                                            |          | Terms added together; a zero denominator gives null.                                                                                                                                                                                                                                                                                                                             |
| `derived[].denominator[].metric`     | integer (1–8)                                                                                                                                                                                                                                          | yes      | One-based index into metrics.                                                                                                                                                                                                                                                                                                                                                    |
| `derived[].denominator[].factor`     | number                                                                                                                                                                                                                                                 |          | Multiplier, default 1.                                                                                                                                                                                                                                                                                                                                                           |
| `derived[].denominator[].scope`      | `"group"` \| `"total"`                                                                                                                                                                                                                                 |          | group (default) or total: the metric summed over every group, for a share; counts and sum only.                                                                                                                                                                                                                                                                                  |
| `derived[].scale`                    | number                                                                                                                                                                                                                                                 |          | Final multiplier, such as 100.                                                                                                                                                                                                                                                                                                                                                   |
| `derived[].round`                    | integer (0–10)                                                                                                                                                                                                                                         |          | Decimal places, half away from zero.                                                                                                                                                                                                                                                                                                                                             |
| `descending`                         | boolean                                                                                                                                                                                                                                                |          | Descending sort, default false.                                                                                                                                                                                                                                                                                                                                                  |
| `maxGroups`                          | integer (1–500)                                                                                                                                                                                                                                        |          | Groups returned, default 50.                                                                                                                                                                                                                                                                                                                                                     |
| `delimiter`                          | `"comma"` \| `"semicolon"` \| `"tab"` \| `"pipe"`                                                                                                                                                                                                      |          | CSV separator; sniffed when omitted.                                                                                                                                                                                                                                                                                                                                             |
| `encoding`                           | `"utf-8"` \| `"utf-16le"` \| `"utf-16be"` \| `"windows-1254"` \| `"iso-8859-9"` \| `"windows-1252"` \| `"windows-1251"` \| `"windows-1256"` \| `"shift_jis"` \| `"gb18030"` \| `"big5"` \| `"euc-kr"`                                                  |          | CSV encoding; BOM or utf-8 when omitted.                                                                                                                                                                                                                                                                                                                                         |

## `find_in_sheet`

Find cells whose value or formula matches a query. Use this instead of paging a large sheet.

Annotations: read-only, idempotent, closed world.

| Argument                    | Type                                                                                                                                                                                                  | Required | Description                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filePath`                  | string                                                                                                                                                                                                | yes      | Path under the server root, as list_workbooks returns it.                                                                                                                                                               |
| `query`                     | string (≥ 1 chars)                                                                                                                                                                                    | yes      | Text to find, or a JavaScript regular expression of at most 256 characters when matchMode is regex.                                                                                                                     |
| `sheetName`                 | string                                                                                                                                                                                                |          | Exact worksheet name; defaults to the first visible sheet.                                                                                                                                                              |
| `table`                     | string (1–255 chars)                                                                                                                                                                                  |          | Declared table name; selects its data rows. Not with range. XLSX only.                                                                                                                                                  |
| `visibleOnly`               | boolean                                                                                                                                                                                               |          | Skip saved hidden rows, AutoFilter's included. XLSX only.                                                                                                                                                               |
| `headerRow`                 | integer (0–1048576)                                                                                                                                                                                   |          | Header row, 0 for none. Omitted: a table or autofilter header, else the first top row naming its columns in text above any data, else row 1.                                                                            |
| `headerScan`                | boolean                                                                                                                                                                                               |          | Strict header detection: refuse when two rows or none qualify.                                                                                                                                                          |
| `columns`                   | array of object (1–64 items)                                                                                                                                                                          |          | How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues. |
| `columns[].column`          | string                                                                                                                                                                                                | yes      | Header text or A1 letter.                                                                                                                                                                                               |
| `columns[].type`            | `"number"` \| `"date"` \| `"boolean"` \| `"time"` \| `"duration"` \| `"text"`                                                                                                                         | yes      | How to read the column.                                                                                                                                                                                                 |
| `columns[].missingValues`   | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | Missing-text tokens.                                                                                                                                                                                                    |
| `columns[].decimal`         | `"."` \| `","`                                                                                                                                                                                        |          | Decimal separator, for number.                                                                                                                                                                                          |
| `columns[].group`           | `"none"` \| `"."` \| `","` \| `" "` \| `"'"`                                                                                                                                                          |          | Thousands separator, for number.                                                                                                                                                                                        |
| `columns[].locale`          | string (2–64 chars)                                                                                                                                                                                   |          | File locale, for number or date.                                                                                                                                                                                        |
| `columns[].numberingSystem` | string (3–32 chars)                                                                                                                                                                                   |          | Numbering system, for number.                                                                                                                                                                                           |
| `columns[].identifiers`     | `"refuse"` \| `"read"`                                                                                                                                                                                |          | Whether to read digit identifiers, for number.                                                                                                                                                                          |
| `columns[].format`          | string (1–64 chars)                                                                                                                                                                                   |          | Date pattern such as dd.MM.yyyy, for date.                                                                                                                                                                              |
| `columns[].order`           | `"dmy"` \| `"mdy"`                                                                                                                                                                                    |          | Day/month order without a format, for date.                                                                                                                                                                             |
| `columns[].trueValues`      | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | True-text tokens, for boolean.                                                                                                                                                                                          |
| `columns[].falseValues`     | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | False-text tokens, for boolean.                                                                                                                                                                                         |
| `locale`                    | string (2–64 chars)                                                                                                                                                                                   |          | BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.                                                                                                        |
| `numberingSystem`           | string (3–32 chars)                                                                                                                                                                                   |          | Numbering system such as arab; needs locale.                                                                                                                                                                            |
| `missingValues`             | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | Missing-text tokens; default N/A, NULL, -, —, #N/A.                                                                                                                                                                     |
| `trueValues`                | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | True-text tokens; default true, yes, y, Evet, E.                                                                                                                                                                        |
| `falseValues`               | array of string (1–128 chars) (≤ 64 items)                                                                                                                                                            |          | False-text tokens; default false, no, n, Hayır, H.                                                                                                                                                                      |
| `columnMode`                | `"auto"` \| `"header"` \| `"letter"`                                                                                                                                                                  |          | Columns are named by header text or A1 letter: auto (default), header or letter.                                                                                                                                        |
| `matchMode`                 | `"contains"` \| `"exact"` \| `"regex"`                                                                                                                                                                |          | Contains (default), exact text or JavaScript regex. Regex runs in an isolated worker with a two-second deadline.                                                                                                        |
| `caseSensitive`             | boolean                                                                                                                                                                                               |          | Case-sensitive matching, default false. Literal search uses NFC/folding; regex retains JavaScript semantics.                                                                                                            |
| `searchIn`                  | `"values"` \| `"formulas"` \| `"both"`                                                                                                                                                                |          | Search values (default), formulas or both. CSV supports values only.                                                                                                                                                    |
| `range`                     | string                                                                                                                                                                                                |          | A1 range to search, such as B2:D40, B:D or 2:40. Defaults to the used range.                                                                                                                                            |
| `maxResults`                | integer (1–200)                                                                                                                                                                                       |          | Maximum returned matches, default 50. Does not increase the regex deadline.                                                                                                                                             |
| `delimiter`                 | `"comma"` \| `"semicolon"` \| `"tab"` \| `"pipe"`                                                                                                                                                     |          | CSV separator; sniffed when omitted.                                                                                                                                                                                    |
| `encoding`                  | `"utf-8"` \| `"utf-16le"` \| `"utf-16be"` \| `"windows-1254"` \| `"iso-8859-9"` \| `"windows-1252"` \| `"windows-1251"` \| `"windows-1256"` \| `"shift_jis"` \| `"gb18030"` \| `"big5"` \| `"euc-kr"` |          | CSV encoding; BOM or utf-8 when omitted.                                                                                                                                                                                |

## `prepare_bulk_job`

Optional job.finish is at the job root, never inside group: [{"output":"report","changes":[{"kind":"format_cells","sheetName":"S","range":"C2:C4","style":{"numberFormat":"0.00"}}]}]. For independent jobs each finish entry additionally names job. Changes use edit_workbook authoring kinds and run after data rendering, before the existing atomic publication. Formula changes require formula text and never calculate results. Every step and output uses kind, never op or type. A read step is {kind:read,id:rows,source:{filePath,versionId},selection:{kind:records,sheetName,range,headerRow:1}}; selection is a nested object, never flattened onto the step. update.set is [{column:Flag,value:{kind:boolean,value:true}}], never a bare scalar or a {type:...} cell. CSV fields stay text unless selection.columns explicitly requests reading, e.g. [{column:Total,type:number,decimal:"."}]. keys is an array of {sourceColumn,targetColumn}. A join uses join:left and columns:[{side:left,column:Ticket,as:Ticket}], never joinType or from. For editing an existing workbook choose output kind edit; kind new creates a data-only report and does not preserve unrelated source package parts. Dry-run a complete dependent group or independent batch without writing files. job kind dependent has group {steps,outputs}; independent has jobs [{id,group}]. Steps have unique IDs and reference only earlier IDs. read pins source {filePath,versionId} and a complete records selection with positive headerRow and closed range or table. Conditions use where:[{column:State,op:eq,value:open}], an array of {column,op,value}, never a single object or a string. update.set uses typed cells, for example [{column:Total,value:{kind:number,value:99}}]. Set edit output overwrite:true when replacing occupied values. Operators: update/remove/filter with these where conditions; keyed_update/upsert with source/target step IDs, keys/set column mappings and explicit duplicates/missingKeys policies; replace uses {kind:replace,id:next,input:old,source:fresh}, where old and fresh are dataset IDs; append uses inputs, an array of dataset IDs; join inner/left/full with explicit output column mappings and bounded manyToMany; deduplicate with keep policy; stable sort with directions, blanks and mixedTypes; project; transform constants/trim/locale case/explicit typed conversions. Output new uses sheets [{name,input}]; edit uses target read ID, input dataset ID, mode changed_values or replace_values and overwrite; edit_workbook combines distinct-sheet changes from one exact source. changed_values preserves untouched formulas and row identities; sorting/replacement needs explicit replace_values. Physical delete_rows refuses other content in the same rows. Full editor preservation, budgets, expansion and every ordered step/output are checked. Ready is not publication or authorization. No calculation. Writing mode only.

Annotations: read-only, idempotent, closed world.

Available only with `--write <relative-output-directory>`. The registered JSON Schema below is the exact wire contract; nested operation variants are validated by the server.

:::details[Input JSON Schema]

```json
{
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "job": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "dependent",
            "independent"
          ]
        },
        "group": {
          "type": "object",
          "properties": {
            "steps": {
              "minItems": 1,
              "maxItems": 32,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "enum": [
                      "read",
                      "update",
                      "remove",
                      "filter",
                      "keyed_update",
                      "upsert",
                      "replace",
                      "append",
                      "join",
                      "deduplicate",
                      "sort",
                      "project",
                      "transform"
                    ]
                  },
                  "id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "input": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "source": {
                    "anyOf": [
                      {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 48,
                        "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                      },
                      {
                        "type": "object",
                        "properties": {
                          "filePath": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 32768
                          },
                          "versionId": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$"
                          }
                        },
                        "required": [
                          "filePath",
                          "versionId"
                        ],
                        "additionalProperties": false
                      }
                    ]
                  },
                  "target": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "selection": {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "type": "string",
                        "const": "records"
                      },
                      "sheetName": {
                        "description": "Exact worksheet name; defaults to the first visible sheet.",
                        "type": "string"
                      },
                      "range": {
                        "type": "string",
                        "maxLength": 21,
                        "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}:[A-Za-z]{1,3}[1-9][0-9]{0,6}$"
                      },
                      "table": {
                        "description": "Declared table name; selects its data rows. Not with range. XLSX only.",
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 255
                      },
                      "visibleOnly": {
                        "description": "Skip saved hidden rows, AutoFilter's included. XLSX only.",
                        "type": "boolean"
                      },
                      "headerRow": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 1048576
                      },
                      "columnMode": {
                        "description": "Columns are named by header text or A1 letter: auto (default), header or letter.",
                        "type": "string",
                        "enum": [
                          "auto",
                          "header",
                          "letter"
                        ]
                      },
                      "caseSensitive": {
                        "description": "Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.",
                        "type": "boolean"
                      },
                      "columns": {
                        "description": "How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues.",
                        "minItems": 1,
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "column": {
                              "type": "string",
                              "description": "Header text or A1 letter."
                            },
                            "type": {
                              "type": "string",
                              "enum": [
                                "number",
                                "date",
                                "boolean",
                                "time",
                                "duration",
                                "text"
                              ],
                              "description": "How to read the column."
                            },
                            "missingValues": {
                              "description": "Missing-text tokens.",
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 128
                              }
                            },
                            "decimal": {
                              "description": "Decimal separator, for number.",
                              "type": "string",
                              "enum": [
                                ".",
                                ","
                              ]
                            },
                            "group": {
                              "description": "Thousands separator, for number.",
                              "type": "string",
                              "enum": [
                                "none",
                                ".",
                                ",",
                                " ",
                                "'"
                              ]
                            },
                            "locale": {
                              "description": "File locale, for number or date.",
                              "type": "string",
                              "minLength": 2,
                              "maxLength": 64
                            },
                            "numberingSystem": {
                              "description": "Numbering system, for number.",
                              "type": "string",
                              "minLength": 3,
                              "maxLength": 32
                            },
                            "identifiers": {
                              "description": "Whether to read digit identifiers, for number.",
                              "type": "string",
                              "enum": [
                                "refuse",
                                "read"
                              ]
                            },
                            "format": {
                              "description": "Date pattern such as dd.MM.yyyy, for date.",
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 64
                            },
                            "order": {
                              "description": "Day/month order without a format, for date.",
                              "type": "string",
                              "enum": [
                                "dmy",
                                "mdy"
                              ]
                            },
                            "trueValues": {
                              "description": "True-text tokens, for boolean.",
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 128
                              }
                            },
                            "falseValues": {
                              "description": "False-text tokens, for boolean.",
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 128
                              }
                            }
                          },
                          "required": [
                            "column",
                            "type"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "mergedCells": {
                        "description": "Merged values and header detection policy, default master.",
                        "type": "string",
                        "enum": [
                          "master",
                          "repeat"
                        ]
                      },
                      "delimiter": {
                        "description": "CSV separator; sniffed when omitted.",
                        "type": "string",
                        "enum": [
                          "comma",
                          "semicolon",
                          "tab",
                          "pipe"
                        ]
                      },
                      "encoding": {
                        "description": "CSV encoding; BOM or utf-8 when omitted.",
                        "type": "string",
                        "enum": [
                          "utf-8",
                          "utf-16le",
                          "utf-16be",
                          "windows-1254",
                          "iso-8859-9",
                          "windows-1252",
                          "windows-1251",
                          "windows-1256",
                          "shift_jis",
                          "gb18030",
                          "big5",
                          "euc-kr"
                        ]
                      },
                      "locale": {
                        "description": "BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.",
                        "type": "string",
                        "minLength": 2,
                        "maxLength": 64
                      },
                      "numberingSystem": {
                        "description": "Numbering system such as arab; needs locale.",
                        "type": "string",
                        "minLength": 3,
                        "maxLength": 32
                      },
                      "missingValues": {
                        "description": "Missing-text tokens; default N/A, NULL, -, —, #N/A.",
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        }
                      },
                      "trueValues": {
                        "description": "True-text tokens; default true, yes, y, Evet, E.",
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        }
                      },
                      "falseValues": {
                        "description": "False-text tokens; default false, no, n, Hayır, H.",
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        }
                      },
                      "selectColumns": {
                        "minItems": 1,
                        "maxItems": 16384,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 32767
                        }
                      },
                      "where": {
                        "maxItems": 16,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "column": {
                              "type": "string",
                              "description": "Header text or A1 letter."
                            },
                            "op": {
                              "type": "string",
                              "enum": [
                                "eq",
                                "ne",
                                "lt",
                                "lte",
                                "gt",
                                "gte",
                                "contains",
                                "startsWith",
                                "endsWith",
                                "in",
                                "between",
                                "isEmpty",
                                "isNotEmpty",
                                "isError",
                                "isNumber",
                                "isText"
                              ]
                            },
                            "value": {
                              "description": "Operand.",
                              "type": [
                                "string",
                                "number",
                                "boolean"
                              ]
                            },
                            "values": {
                              "description": "Operands of in, or [low, high] of between.",
                              "minItems": 1,
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": [
                                  "string",
                                  "number",
                                  "boolean"
                                ]
                              }
                            }
                          },
                          "required": [
                            "column",
                            "op"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "match": {
                        "default": "all",
                        "type": "string",
                        "enum": [
                          "all",
                          "any"
                        ]
                      },
                      "scope": {
                        "default": {
                          "kind": "all"
                        },
                        "oneOf": [
                          {
                            "type": "object",
                            "properties": {
                              "kind": {
                                "type": "string",
                                "const": "all"
                              }
                            },
                            "required": [
                              "kind"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "kind": {
                                "type": "string",
                                "const": "rows"
                              },
                              "rows": {
                                "minItems": 1,
                                "maxItems": 10000,
                                "type": "array",
                                "items": {
                                  "type": "integer",
                                  "minimum": 1,
                                  "maximum": 1048576
                                }
                              }
                            },
                            "required": [
                              "kind",
                              "rows"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "includeHeaders": {
                        "default": false,
                        "type": "boolean",
                        "const": false
                      }
                    },
                    "required": [
                      "kind",
                      "headerRow"
                    ],
                    "additionalProperties": false
                  },
                  "where": {
                    "maxItems": 16,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "column": {
                          "type": "string",
                          "description": "Header text or A1 letter."
                        },
                        "op": {
                          "type": "string",
                          "enum": [
                            "eq",
                            "ne",
                            "lt",
                            "lte",
                            "gt",
                            "gte",
                            "contains",
                            "startsWith",
                            "endsWith",
                            "in",
                            "between",
                            "isEmpty",
                            "isNotEmpty",
                            "isError",
                            "isNumber",
                            "isText"
                          ]
                        },
                        "value": {
                          "description": "Operand.",
                          "type": [
                            "string",
                            "number",
                            "boolean"
                          ]
                        },
                        "values": {
                          "description": "Operands of in, or [low, high] of between.",
                          "minItems": 1,
                          "maxItems": 64,
                          "type": "array",
                          "items": {
                            "type": [
                              "string",
                              "number",
                              "boolean"
                            ]
                          }
                        }
                      },
                      "required": [
                        "column",
                        "op"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "match": {
                    "type": "string",
                    "enum": [
                      "all",
                      "any"
                    ]
                  },
                  "caseSensitive": {
                    "type": "boolean"
                  },
                  "set": {
                    "anyOf": [
                      {
                        "minItems": 1,
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            },
                            "value": {
                              "oneOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "text"
                                    },
                                    "value": {
                                      "type": "string",
                                      "maxLength": 32767
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "number"
                                    },
                                    "value": {
                                      "type": "number"
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "boolean"
                                    },
                                    "value": {
                                      "type": "boolean"
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "blank"
                                    }
                                  },
                                  "required": [
                                    "kind"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "date"
                                    },
                                    "value": {
                                      "type": "string",
                                      "minLength": 10,
                                      "format": "date",
                                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "datetime"
                                    },
                                    "value": {
                                      "type": "string",
                                      "allOf": [
                                        {
                                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z)|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"
                                        },
                                        {
                                          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?$"
                                        }
                                      ]
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                }
                              ]
                            }
                          },
                          "required": [
                            "column",
                            "value"
                          ],
                          "additionalProperties": false
                        }
                      },
                      {
                        "minItems": 1,
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "sourceColumn": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            },
                            "targetColumn": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            }
                          },
                          "required": [
                            "sourceColumn",
                            "targetColumn"
                          ],
                          "additionalProperties": false
                        }
                      }
                    ],
                    "type": "array"
                  },
                  "mode": {
                    "type": "string",
                    "enum": [
                      "clear",
                      "delete_rows"
                    ]
                  },
                  "keys": {
                    "anyOf": [
                      {
                        "minItems": 1,
                        "maxItems": 16,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "sourceColumn": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            },
                            "targetColumn": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            }
                          },
                          "required": [
                            "sourceColumn",
                            "targetColumn"
                          ],
                          "additionalProperties": false
                        }
                      },
                      {
                        "minItems": 1,
                        "maxItems": 256,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 32767
                        }
                      }
                    ],
                    "type": "array"
                  },
                  "duplicates": {
                    "type": "string",
                    "enum": [
                      "error",
                      "first",
                      "last"
                    ]
                  },
                  "missingKeys": {
                    "anyOf": [
                      {
                        "type": "string",
                        "enum": [
                          "error",
                          "skip"
                        ]
                      },
                      {
                        "type": "string",
                        "enum": [
                          "error",
                          "keep",
                          "group"
                        ]
                      }
                    ]
                  },
                  "inputs": {
                    "minItems": 1,
                    "maxItems": 8,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 48,
                      "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                    }
                  },
                  "columns": {
                    "anyOf": [
                      {
                        "minItems": 1,
                        "maxItems": 256,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 32767
                        }
                      },
                      {
                        "minItems": 1,
                        "maxItems": 256,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "side": {
                              "type": "string",
                              "enum": [
                                "left",
                                "right"
                              ]
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            },
                            "as": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            }
                          },
                          "required": [
                            "side",
                            "column",
                            "as"
                          ],
                          "additionalProperties": false
                        }
                      },
                      {
                        "minItems": 1,
                        "maxItems": 256,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            },
                            "as": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            }
                          },
                          "required": [
                            "column",
                            "as"
                          ],
                          "additionalProperties": false
                        }
                      }
                    ],
                    "type": "array"
                  },
                  "missingColumns": {
                    "type": "string",
                    "enum": [
                      "error",
                      "blank"
                    ]
                  },
                  "left": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "right": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "join": {
                    "type": "string",
                    "enum": [
                      "inner",
                      "left",
                      "full"
                    ]
                  },
                  "manyToMany": {
                    "type": "boolean"
                  },
                  "keep": {
                    "type": "string",
                    "enum": [
                      "report",
                      "duplicates_only",
                      "first",
                      "last",
                      "drop_all"
                    ]
                  },
                  "by": {
                    "minItems": 1,
                    "maxItems": 16,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "column": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 32767
                        },
                        "direction": {
                          "type": "string",
                          "enum": [
                            "asc",
                            "desc"
                          ]
                        },
                        "blanks": {
                          "type": "string",
                          "enum": [
                            "first",
                            "last"
                          ]
                        }
                      },
                      "required": [
                        "column",
                        "direction",
                        "blanks"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "mixedTypes": {
                    "type": "string",
                    "enum": [
                      "error",
                      "type_order"
                    ]
                  },
                  "locale": {
                    "type": "string",
                    "minLength": 2,
                    "maxLength": 64
                  },
                  "transformations": {
                    "minItems": 1,
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "constant"
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            },
                            "value": {
                              "oneOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "text"
                                    },
                                    "value": {
                                      "type": "string",
                                      "maxLength": 32767
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "number"
                                    },
                                    "value": {
                                      "type": "number"
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "boolean"
                                    },
                                    "value": {
                                      "type": "boolean"
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "blank"
                                    }
                                  },
                                  "required": [
                                    "kind"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "date"
                                    },
                                    "value": {
                                      "type": "string",
                                      "minLength": 10,
                                      "format": "date",
                                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "datetime"
                                    },
                                    "value": {
                                      "type": "string",
                                      "allOf": [
                                        {
                                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z)|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"
                                        },
                                        {
                                          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?$"
                                        }
                                      ]
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                }
                              ]
                            }
                          },
                          "required": [
                            "kind",
                            "column",
                            "value"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "trim"
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            }
                          },
                          "required": [
                            "kind",
                            "column"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "case"
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            },
                            "direction": {
                              "type": "string",
                              "enum": [
                                "upper",
                                "lower"
                              ]
                            },
                            "locale": {
                              "type": "string",
                              "minLength": 2,
                              "maxLength": 64
                            }
                          },
                          "required": [
                            "kind",
                            "column",
                            "direction",
                            "locale"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "convert"
                            },
                            "spec": {
                              "oneOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "column": {
                                      "type": "string",
                                      "description": "Header text or A1 letter."
                                    },
                                    "missingValues": {
                                      "description": "Missing-text tokens.",
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    },
                                    "type": {
                                      "type": "string",
                                      "const": "number"
                                    },
                                    "decimal": {
                                      "type": "string",
                                      "enum": [
                                        ".",
                                        ","
                                      ]
                                    },
                                    "group": {
                                      "type": "string",
                                      "enum": [
                                        "none",
                                        ".",
                                        ",",
                                        " ",
                                        "'"
                                      ]
                                    },
                                    "locale": {
                                      "type": "string",
                                      "minLength": 2,
                                      "maxLength": 64
                                    },
                                    "numberingSystem": {
                                      "type": "string",
                                      "minLength": 3,
                                      "maxLength": 32
                                    },
                                    "identifiers": {
                                      "type": "string",
                                      "enum": [
                                        "refuse",
                                        "read"
                                      ]
                                    }
                                  },
                                  "required": [
                                    "column",
                                    "type"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "column": {
                                      "type": "string",
                                      "description": "Header text or A1 letter."
                                    },
                                    "missingValues": {
                                      "description": "Missing-text tokens.",
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    },
                                    "type": {
                                      "type": "string",
                                      "const": "date"
                                    },
                                    "format": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 64
                                    },
                                    "order": {
                                      "type": "string",
                                      "enum": [
                                        "dmy",
                                        "mdy"
                                      ]
                                    },
                                    "locale": {
                                      "type": "string",
                                      "minLength": 2,
                                      "maxLength": 64
                                    }
                                  },
                                  "required": [
                                    "column",
                                    "type"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "column": {
                                      "type": "string",
                                      "description": "Header text or A1 letter."
                                    },
                                    "missingValues": {
                                      "description": "Missing-text tokens.",
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    },
                                    "type": {
                                      "type": "string",
                                      "const": "boolean"
                                    },
                                    "trueValues": {
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    },
                                    "falseValues": {
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    }
                                  },
                                  "required": [
                                    "column",
                                    "type"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "column": {
                                      "type": "string",
                                      "description": "Header text or A1 letter."
                                    },
                                    "missingValues": {
                                      "description": "Missing-text tokens.",
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    },
                                    "type": {
                                      "type": "string",
                                      "const": "time"
                                    }
                                  },
                                  "required": [
                                    "column",
                                    "type"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "column": {
                                      "type": "string",
                                      "description": "Header text or A1 letter."
                                    },
                                    "missingValues": {
                                      "description": "Missing-text tokens.",
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    },
                                    "type": {
                                      "type": "string",
                                      "const": "duration"
                                    }
                                  },
                                  "required": [
                                    "column",
                                    "type"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "column": {
                                      "type": "string",
                                      "description": "Header text or A1 letter."
                                    },
                                    "missingValues": {
                                      "description": "Missing-text tokens.",
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    },
                                    "type": {
                                      "type": "string",
                                      "const": "text"
                                    }
                                  },
                                  "required": [
                                    "column",
                                    "type"
                                  ],
                                  "additionalProperties": false
                                }
                              ]
                            }
                          },
                          "required": [
                            "kind",
                            "spec"
                          ],
                          "additionalProperties": false
                        }
                      ],
                      "type": "object"
                    }
                  },
                  "onError": {
                    "type": "string",
                    "enum": [
                      "error",
                      "blank",
                      "keep"
                    ]
                  }
                },
                "required": [
                  "kind",
                  "id"
                ],
                "additionalProperties": false
              }
            },
            "outputs": {
              "minItems": 1,
              "maxItems": 16,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "enum": [
                      "new",
                      "edit",
                      "edit_workbook"
                    ]
                  },
                  "id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "sheets": {
                    "minItems": 1,
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "name": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 31
                        },
                        "input": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        }
                      },
                      "required": [
                        "name",
                        "input"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "target": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "input": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "mode": {
                    "type": "string",
                    "enum": [
                      "changed_values",
                      "replace_values"
                    ]
                  },
                  "overwrite": {
                    "type": "boolean"
                  },
                  "changes": {
                    "minItems": 1,
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "target": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "input": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "mode": {
                          "type": "string",
                          "enum": [
                            "changed_values",
                            "replace_values"
                          ]
                        },
                        "overwrite": {
                          "default": false,
                          "type": "boolean"
                        }
                      },
                      "required": [
                        "target",
                        "input",
                        "mode"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "kind",
                  "id"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "steps",
            "outputs"
          ],
          "additionalProperties": false
        },
        "jobs": {
          "minItems": 1,
          "maxItems": 16,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
              },
              "group": {
                "type": "object",
                "properties": {
                  "steps": {
                    "minItems": 1,
                    "maxItems": 32,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "enum": [
                            "read",
                            "update",
                            "remove",
                            "filter",
                            "keyed_update",
                            "upsert",
                            "replace",
                            "append",
                            "join",
                            "deduplicate",
                            "sort",
                            "project",
                            "transform"
                          ]
                        },
                        "id": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "input": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "source": {
                          "anyOf": [
                            {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 48,
                              "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                            },
                            {
                              "type": "object",
                              "properties": {
                                "filePath": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 32768
                                },
                                "versionId": {
                                  "type": "string",
                                  "pattern": "^[a-f0-9]{64}$"
                                }
                              },
                              "required": [
                                "filePath",
                                "versionId"
                              ],
                              "additionalProperties": false
                            }
                          ]
                        },
                        "target": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "selection": {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "records"
                            },
                            "sheetName": {
                              "description": "Exact worksheet name; defaults to the first visible sheet.",
                              "type": "string"
                            },
                            "range": {
                              "type": "string",
                              "maxLength": 21,
                              "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}:[A-Za-z]{1,3}[1-9][0-9]{0,6}$"
                            },
                            "table": {
                              "description": "Declared table name; selects its data rows. Not with range. XLSX only.",
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 255
                            },
                            "visibleOnly": {
                              "description": "Skip saved hidden rows, AutoFilter's included. XLSX only.",
                              "type": "boolean"
                            },
                            "headerRow": {
                              "type": "integer",
                              "minimum": 1,
                              "maximum": 1048576
                            },
                            "columnMode": {
                              "description": "Columns are named by header text or A1 letter: auto (default), header or letter.",
                              "type": "string",
                              "enum": [
                                "auto",
                                "header",
                                "letter"
                              ]
                            },
                            "caseSensitive": {
                              "description": "Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.",
                              "type": "boolean"
                            },
                            "columns": {
                              "description": "How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues.",
                              "minItems": 1,
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "column": {
                                    "type": "string",
                                    "description": "Header text or A1 letter."
                                  },
                                  "type": {
                                    "type": "string",
                                    "enum": [
                                      "number",
                                      "date",
                                      "boolean",
                                      "time",
                                      "duration",
                                      "text"
                                    ],
                                    "description": "How to read the column."
                                  },
                                  "missingValues": {
                                    "description": "Missing-text tokens.",
                                    "maxItems": 64,
                                    "type": "array",
                                    "items": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 128
                                    }
                                  },
                                  "decimal": {
                                    "description": "Decimal separator, for number.",
                                    "type": "string",
                                    "enum": [
                                      ".",
                                      ","
                                    ]
                                  },
                                  "group": {
                                    "description": "Thousands separator, for number.",
                                    "type": "string",
                                    "enum": [
                                      "none",
                                      ".",
                                      ",",
                                      " ",
                                      "'"
                                    ]
                                  },
                                  "locale": {
                                    "description": "File locale, for number or date.",
                                    "type": "string",
                                    "minLength": 2,
                                    "maxLength": 64
                                  },
                                  "numberingSystem": {
                                    "description": "Numbering system, for number.",
                                    "type": "string",
                                    "minLength": 3,
                                    "maxLength": 32
                                  },
                                  "identifiers": {
                                    "description": "Whether to read digit identifiers, for number.",
                                    "type": "string",
                                    "enum": [
                                      "refuse",
                                      "read"
                                    ]
                                  },
                                  "format": {
                                    "description": "Date pattern such as dd.MM.yyyy, for date.",
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 64
                                  },
                                  "order": {
                                    "description": "Day/month order without a format, for date.",
                                    "type": "string",
                                    "enum": [
                                      "dmy",
                                      "mdy"
                                    ]
                                  },
                                  "trueValues": {
                                    "description": "True-text tokens, for boolean.",
                                    "maxItems": 64,
                                    "type": "array",
                                    "items": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 128
                                    }
                                  },
                                  "falseValues": {
                                    "description": "False-text tokens, for boolean.",
                                    "maxItems": 64,
                                    "type": "array",
                                    "items": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 128
                                    }
                                  }
                                },
                                "required": [
                                  "column",
                                  "type"
                                ],
                                "additionalProperties": false
                              }
                            },
                            "mergedCells": {
                              "description": "Merged values and header detection policy, default master.",
                              "type": "string",
                              "enum": [
                                "master",
                                "repeat"
                              ]
                            },
                            "delimiter": {
                              "description": "CSV separator; sniffed when omitted.",
                              "type": "string",
                              "enum": [
                                "comma",
                                "semicolon",
                                "tab",
                                "pipe"
                              ]
                            },
                            "encoding": {
                              "description": "CSV encoding; BOM or utf-8 when omitted.",
                              "type": "string",
                              "enum": [
                                "utf-8",
                                "utf-16le",
                                "utf-16be",
                                "windows-1254",
                                "iso-8859-9",
                                "windows-1252",
                                "windows-1251",
                                "windows-1256",
                                "shift_jis",
                                "gb18030",
                                "big5",
                                "euc-kr"
                              ]
                            },
                            "locale": {
                              "description": "BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.",
                              "type": "string",
                              "minLength": 2,
                              "maxLength": 64
                            },
                            "numberingSystem": {
                              "description": "Numbering system such as arab; needs locale.",
                              "type": "string",
                              "minLength": 3,
                              "maxLength": 32
                            },
                            "missingValues": {
                              "description": "Missing-text tokens; default N/A, NULL, -, —, #N/A.",
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 128
                              }
                            },
                            "trueValues": {
                              "description": "True-text tokens; default true, yes, y, Evet, E.",
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 128
                              }
                            },
                            "falseValues": {
                              "description": "False-text tokens; default false, no, n, Hayır, H.",
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 128
                              }
                            },
                            "selectColumns": {
                              "minItems": 1,
                              "maxItems": 16384,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 32767
                              }
                            },
                            "where": {
                              "maxItems": 16,
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "column": {
                                    "type": "string",
                                    "description": "Header text or A1 letter."
                                  },
                                  "op": {
                                    "type": "string",
                                    "enum": [
                                      "eq",
                                      "ne",
                                      "lt",
                                      "lte",
                                      "gt",
                                      "gte",
                                      "contains",
                                      "startsWith",
                                      "endsWith",
                                      "in",
                                      "between",
                                      "isEmpty",
                                      "isNotEmpty",
                                      "isError",
                                      "isNumber",
                                      "isText"
                                    ]
                                  },
                                  "value": {
                                    "description": "Operand.",
                                    "type": [
                                      "string",
                                      "number",
                                      "boolean"
                                    ]
                                  },
                                  "values": {
                                    "description": "Operands of in, or [low, high] of between.",
                                    "minItems": 1,
                                    "maxItems": 64,
                                    "type": "array",
                                    "items": {
                                      "type": [
                                        "string",
                                        "number",
                                        "boolean"
                                      ]
                                    }
                                  }
                                },
                                "required": [
                                  "column",
                                  "op"
                                ],
                                "additionalProperties": false
                              }
                            },
                            "match": {
                              "default": "all",
                              "type": "string",
                              "enum": [
                                "all",
                                "any"
                              ]
                            },
                            "scope": {
                              "default": {
                                "kind": "all"
                              },
                              "oneOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "all"
                                    }
                                  },
                                  "required": [
                                    "kind"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "rows"
                                    },
                                    "rows": {
                                      "minItems": 1,
                                      "maxItems": 10000,
                                      "type": "array",
                                      "items": {
                                        "type": "integer",
                                        "minimum": 1,
                                        "maximum": 1048576
                                      }
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "rows"
                                  ],
                                  "additionalProperties": false
                                }
                              ]
                            },
                            "includeHeaders": {
                              "default": false,
                              "type": "boolean",
                              "const": false
                            }
                          },
                          "required": [
                            "kind",
                            "headerRow"
                          ],
                          "additionalProperties": false
                        },
                        "where": {
                          "maxItems": 16,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "column": {
                                "type": "string",
                                "description": "Header text or A1 letter."
                              },
                              "op": {
                                "type": "string",
                                "enum": [
                                  "eq",
                                  "ne",
                                  "lt",
                                  "lte",
                                  "gt",
                                  "gte",
                                  "contains",
                                  "startsWith",
                                  "endsWith",
                                  "in",
                                  "between",
                                  "isEmpty",
                                  "isNotEmpty",
                                  "isError",
                                  "isNumber",
                                  "isText"
                                ]
                              },
                              "value": {
                                "description": "Operand.",
                                "type": [
                                  "string",
                                  "number",
                                  "boolean"
                                ]
                              },
                              "values": {
                                "description": "Operands of in, or [low, high] of between.",
                                "minItems": 1,
                                "maxItems": 64,
                                "type": "array",
                                "items": {
                                  "type": [
                                    "string",
                                    "number",
                                    "boolean"
                                  ]
                                }
                              }
                            },
                            "required": [
                              "column",
                              "op"
                            ],
                            "additionalProperties": false
                          }
                        },
                        "match": {
                          "type": "string",
                          "enum": [
                            "all",
                            "any"
                          ]
                        },
                        "caseSensitive": {
                          "type": "boolean"
                        },
                        "set": {
                          "anyOf": [
                            {
                              "minItems": 1,
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  },
                                  "value": {
                                    "oneOf": [
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "text"
                                          },
                                          "value": {
                                            "type": "string",
                                            "maxLength": 32767
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "number"
                                          },
                                          "value": {
                                            "type": "number"
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "boolean"
                                          },
                                          "value": {
                                            "type": "boolean"
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "blank"
                                          }
                                        },
                                        "required": [
                                          "kind"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "date"
                                          },
                                          "value": {
                                            "type": "string",
                                            "minLength": 10,
                                            "format": "date",
                                            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "datetime"
                                          },
                                          "value": {
                                            "type": "string",
                                            "allOf": [
                                              {
                                                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z)|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"
                                              },
                                              {
                                                "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?$"
                                              }
                                            ]
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      }
                                    ]
                                  }
                                },
                                "required": [
                                  "column",
                                  "value"
                                ],
                                "additionalProperties": false
                              }
                            },
                            {
                              "minItems": 1,
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "sourceColumn": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  },
                                  "targetColumn": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  }
                                },
                                "required": [
                                  "sourceColumn",
                                  "targetColumn"
                                ],
                                "additionalProperties": false
                              }
                            }
                          ],
                          "type": "array"
                        },
                        "mode": {
                          "type": "string",
                          "enum": [
                            "clear",
                            "delete_rows"
                          ]
                        },
                        "keys": {
                          "anyOf": [
                            {
                              "minItems": 1,
                              "maxItems": 16,
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "sourceColumn": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  },
                                  "targetColumn": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  }
                                },
                                "required": [
                                  "sourceColumn",
                                  "targetColumn"
                                ],
                                "additionalProperties": false
                              }
                            },
                            {
                              "minItems": 1,
                              "maxItems": 256,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 32767
                              }
                            }
                          ],
                          "type": "array"
                        },
                        "duplicates": {
                          "type": "string",
                          "enum": [
                            "error",
                            "first",
                            "last"
                          ]
                        },
                        "missingKeys": {
                          "anyOf": [
                            {
                              "type": "string",
                              "enum": [
                                "error",
                                "skip"
                              ]
                            },
                            {
                              "type": "string",
                              "enum": [
                                "error",
                                "keep",
                                "group"
                              ]
                            }
                          ]
                        },
                        "inputs": {
                          "minItems": 1,
                          "maxItems": 8,
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 48,
                            "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                          }
                        },
                        "columns": {
                          "anyOf": [
                            {
                              "minItems": 1,
                              "maxItems": 256,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 32767
                              }
                            },
                            {
                              "minItems": 1,
                              "maxItems": 256,
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "side": {
                                    "type": "string",
                                    "enum": [
                                      "left",
                                      "right"
                                    ]
                                  },
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  },
                                  "as": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  }
                                },
                                "required": [
                                  "side",
                                  "column",
                                  "as"
                                ],
                                "additionalProperties": false
                              }
                            },
                            {
                              "minItems": 1,
                              "maxItems": 256,
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  },
                                  "as": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  }
                                },
                                "required": [
                                  "column",
                                  "as"
                                ],
                                "additionalProperties": false
                              }
                            }
                          ],
                          "type": "array"
                        },
                        "missingColumns": {
                          "type": "string",
                          "enum": [
                            "error",
                            "blank"
                          ]
                        },
                        "left": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "right": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "join": {
                          "type": "string",
                          "enum": [
                            "inner",
                            "left",
                            "full"
                          ]
                        },
                        "manyToMany": {
                          "type": "boolean"
                        },
                        "keep": {
                          "type": "string",
                          "enum": [
                            "report",
                            "duplicates_only",
                            "first",
                            "last",
                            "drop_all"
                          ]
                        },
                        "by": {
                          "minItems": 1,
                          "maxItems": 16,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "column": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 32767
                              },
                              "direction": {
                                "type": "string",
                                "enum": [
                                  "asc",
                                  "desc"
                                ]
                              },
                              "blanks": {
                                "type": "string",
                                "enum": [
                                  "first",
                                  "last"
                                ]
                              }
                            },
                            "required": [
                              "column",
                              "direction",
                              "blanks"
                            ],
                            "additionalProperties": false
                          }
                        },
                        "mixedTypes": {
                          "type": "string",
                          "enum": [
                            "error",
                            "type_order"
                          ]
                        },
                        "locale": {
                          "type": "string",
                          "minLength": 2,
                          "maxLength": 64
                        },
                        "transformations": {
                          "minItems": 1,
                          "maxItems": 64,
                          "type": "array",
                          "items": {
                            "oneOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "constant"
                                  },
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  },
                                  "value": {
                                    "oneOf": [
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "text"
                                          },
                                          "value": {
                                            "type": "string",
                                            "maxLength": 32767
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "number"
                                          },
                                          "value": {
                                            "type": "number"
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "boolean"
                                          },
                                          "value": {
                                            "type": "boolean"
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "blank"
                                          }
                                        },
                                        "required": [
                                          "kind"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "date"
                                          },
                                          "value": {
                                            "type": "string",
                                            "minLength": 10,
                                            "format": "date",
                                            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "datetime"
                                          },
                                          "value": {
                                            "type": "string",
                                            "allOf": [
                                              {
                                                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z)|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"
                                              },
                                              {
                                                "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?$"
                                              }
                                            ]
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      }
                                    ]
                                  }
                                },
                                "required": [
                                  "kind",
                                  "column",
                                  "value"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "trim"
                                  },
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  }
                                },
                                "required": [
                                  "kind",
                                  "column"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "case"
                                  },
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  },
                                  "direction": {
                                    "type": "string",
                                    "enum": [
                                      "upper",
                                      "lower"
                                    ]
                                  },
                                  "locale": {
                                    "type": "string",
                                    "minLength": 2,
                                    "maxLength": 64
                                  }
                                },
                                "required": [
                                  "kind",
                                  "column",
                                  "direction",
                                  "locale"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "convert"
                                  },
                                  "spec": {
                                    "oneOf": [
                                      {
                                        "type": "object",
                                        "properties": {
                                          "column": {
                                            "type": "string",
                                            "description": "Header text or A1 letter."
                                          },
                                          "missingValues": {
                                            "description": "Missing-text tokens.",
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          },
                                          "type": {
                                            "type": "string",
                                            "const": "number"
                                          },
                                          "decimal": {
                                            "type": "string",
                                            "enum": [
                                              ".",
                                              ","
                                            ]
                                          },
                                          "group": {
                                            "type": "string",
                                            "enum": [
                                              "none",
                                              ".",
                                              ",",
                                              " ",
                                              "'"
                                            ]
                                          },
                                          "locale": {
                                            "type": "string",
                                            "minLength": 2,
                                            "maxLength": 64
                                          },
                                          "numberingSystem": {
                                            "type": "string",
                                            "minLength": 3,
                                            "maxLength": 32
                                          },
                                          "identifiers": {
                                            "type": "string",
                                            "enum": [
                                              "refuse",
                                              "read"
                                            ]
                                          }
                                        },
                                        "required": [
                                          "column",
                                          "type"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "column": {
                                            "type": "string",
                                            "description": "Header text or A1 letter."
                                          },
                                          "missingValues": {
                                            "description": "Missing-text tokens.",
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          },
                                          "type": {
                                            "type": "string",
                                            "const": "date"
                                          },
                                          "format": {
                                            "type": "string",
                                            "minLength": 1,
                                            "maxLength": 64
                                          },
                                          "order": {
                                            "type": "string",
                                            "enum": [
                                              "dmy",
                                              "mdy"
                                            ]
                                          },
                                          "locale": {
                                            "type": "string",
                                            "minLength": 2,
                                            "maxLength": 64
                                          }
                                        },
                                        "required": [
                                          "column",
                                          "type"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "column": {
                                            "type": "string",
                                            "description": "Header text or A1 letter."
                                          },
                                          "missingValues": {
                                            "description": "Missing-text tokens.",
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          },
                                          "type": {
                                            "type": "string",
                                            "const": "boolean"
                                          },
                                          "trueValues": {
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          },
                                          "falseValues": {
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          }
                                        },
                                        "required": [
                                          "column",
                                          "type"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "column": {
                                            "type": "string",
                                            "description": "Header text or A1 letter."
                                          },
                                          "missingValues": {
                                            "description": "Missing-text tokens.",
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          },
                                          "type": {
                                            "type": "string",
                                            "const": "time"
                                          }
                                        },
                                        "required": [
                                          "column",
                                          "type"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "column": {
                                            "type": "string",
                                            "description": "Header text or A1 letter."
                                          },
                                          "missingValues": {
                                            "description": "Missing-text tokens.",
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          },
                                          "type": {
                                            "type": "string",
                                            "const": "duration"
                                          }
                                        },
                                        "required": [
                                          "column",
                                          "type"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "column": {
                                            "type": "string",
                                            "description": "Header text or A1 letter."
                                          },
                                          "missingValues": {
                                            "description": "Missing-text tokens.",
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          },
                                          "type": {
                                            "type": "string",
                                            "const": "text"
                                          }
                                        },
                                        "required": [
                                          "column",
                                          "type"
                                        ],
                                        "additionalProperties": false
                                      }
                                    ]
                                  }
                                },
                                "required": [
                                  "kind",
                                  "spec"
                                ],
                                "additionalProperties": false
                              }
                            ],
                            "type": "object"
                          }
                        },
                        "onError": {
                          "type": "string",
                          "enum": [
                            "error",
                            "blank",
                            "keep"
                          ]
                        }
                      },
                      "required": [
                        "kind",
                        "id"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "outputs": {
                    "minItems": 1,
                    "maxItems": 16,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "enum": [
                            "new",
                            "edit",
                            "edit_workbook"
                          ]
                        },
                        "id": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "sheets": {
                          "minItems": 1,
                          "maxItems": 64,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "name": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 31
                              },
                              "input": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 48,
                                "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                              }
                            },
                            "required": [
                              "name",
                              "input"
                            ],
                            "additionalProperties": false
                          }
                        },
                        "target": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "input": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "mode": {
                          "type": "string",
                          "enum": [
                            "changed_values",
                            "replace_values"
                          ]
                        },
                        "overwrite": {
                          "type": "boolean"
                        },
                        "changes": {
                          "minItems": 1,
                          "maxItems": 64,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "target": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 48,
                                "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                              },
                              "input": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 48,
                                "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                              },
                              "mode": {
                                "type": "string",
                                "enum": [
                                  "changed_values",
                                  "replace_values"
                                ]
                              },
                              "overwrite": {
                                "default": false,
                                "type": "boolean"
                              }
                            },
                            "required": [
                              "target",
                              "input",
                              "mode"
                            ],
                            "additionalProperties": false
                          }
                        }
                      },
                      "required": [
                        "kind",
                        "id"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "steps",
                  "outputs"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "id",
              "group"
            ],
            "additionalProperties": false
          }
        },
        "finish": {
          "maxItems": 256,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "job": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
              },
              "output": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
              },
              "changes": {
                "minItems": 1,
                "maxItems": 128,
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "format_cells",
                        "set_columns",
                        "set_rows",
                        "freeze_panes",
                        "set_sheet_visibility",
                        "set_print_layout",
                        "merge_cells",
                        "unmerge_cells",
                        "write_formula",
                        "fill_formula",
                        "create_table",
                        "edit_table",
                        "convert_table"
                      ]
                    },
                    "sheetName": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 31
                    },
                    "range": {
                      "type": "string",
                      "maxLength": 21,
                      "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
                    },
                    "style": {
                      "anyOf": [
                        {
                          "type": "object",
                          "properties": {
                            "numberFormat": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 255
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            },
                            "font": {
                              "anyOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "name": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 128
                                    },
                                    "size": {
                                      "type": "number",
                                      "minimum": 1,
                                      "maximum": 409
                                    },
                                    "bold": {
                                      "type": "boolean"
                                    },
                                    "italic": {
                                      "type": "boolean"
                                    },
                                    "underline": {
                                      "type": "boolean"
                                    },
                                    "strike": {
                                      "type": "boolean"
                                    },
                                    "color": {
                                      "type": "string",
                                      "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                                    }
                                  },
                                  "additionalProperties": false
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            },
                            "fill": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            },
                            "border": {
                              "anyOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "left": {
                                      "type": "object",
                                      "properties": {
                                        "style": {
                                          "type": "string",
                                          "enum": [
                                            "thin",
                                            "medium",
                                            "thick",
                                            "dashed",
                                            "dotted",
                                            "double",
                                            "hair",
                                            "none"
                                          ]
                                        },
                                        "color": {
                                          "type": "string",
                                          "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                                        }
                                      },
                                      "required": [
                                        "style"
                                      ],
                                      "additionalProperties": false
                                    },
                                    "right": {
                                      "type": "object",
                                      "properties": {
                                        "style": {
                                          "type": "string",
                                          "enum": [
                                            "thin",
                                            "medium",
                                            "thick",
                                            "dashed",
                                            "dotted",
                                            "double",
                                            "hair",
                                            "none"
                                          ]
                                        },
                                        "color": {
                                          "type": "string",
                                          "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                                        }
                                      },
                                      "required": [
                                        "style"
                                      ],
                                      "additionalProperties": false
                                    },
                                    "top": {
                                      "type": "object",
                                      "properties": {
                                        "style": {
                                          "type": "string",
                                          "enum": [
                                            "thin",
                                            "medium",
                                            "thick",
                                            "dashed",
                                            "dotted",
                                            "double",
                                            "hair",
                                            "none"
                                          ]
                                        },
                                        "color": {
                                          "type": "string",
                                          "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                                        }
                                      },
                                      "required": [
                                        "style"
                                      ],
                                      "additionalProperties": false
                                    },
                                    "bottom": {
                                      "type": "object",
                                      "properties": {
                                        "style": {
                                          "type": "string",
                                          "enum": [
                                            "thin",
                                            "medium",
                                            "thick",
                                            "dashed",
                                            "dotted",
                                            "double",
                                            "hair",
                                            "none"
                                          ]
                                        },
                                        "color": {
                                          "type": "string",
                                          "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                                        }
                                      },
                                      "required": [
                                        "style"
                                      ],
                                      "additionalProperties": false
                                    }
                                  },
                                  "additionalProperties": false
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            },
                            "alignment": {
                              "anyOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "horizontal": {
                                      "type": "string",
                                      "enum": [
                                        "general",
                                        "left",
                                        "center",
                                        "right",
                                        "fill",
                                        "justify",
                                        "centerContinuous",
                                        "distributed"
                                      ]
                                    },
                                    "vertical": {
                                      "type": "string",
                                      "enum": [
                                        "top",
                                        "center",
                                        "bottom",
                                        "justify",
                                        "distributed"
                                      ]
                                    },
                                    "wrapText": {
                                      "type": "boolean"
                                    }
                                  },
                                  "additionalProperties": false
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            }
                          },
                          "additionalProperties": false
                        },
                        {
                          "type": "string",
                          "enum": [
                            "SezzleeBlue",
                            "none"
                          ]
                        }
                      ]
                    },
                    "first": {
                      "anyOf": [
                        {
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 16384
                        },
                        {
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 1048576
                        }
                      ]
                    },
                    "last": {
                      "anyOf": [
                        {
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 16384
                        },
                        {
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 1048576
                        }
                      ]
                    },
                    "width": {
                      "anyOf": [
                        {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 255
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "hidden": {
                      "type": "boolean"
                    },
                    "height": {
                      "anyOf": [
                        {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 409
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "rows": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 1048575
                    },
                    "columns": {
                      "anyOf": [
                        {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 16383
                        },
                        {
                          "maxItems": 1024,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "column": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 255
                              },
                              "name": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 255
                              }
                            },
                            "required": [
                              "column",
                              "name"
                            ],
                            "additionalProperties": false
                          }
                        }
                      ]
                    },
                    "state": {
                      "type": "string",
                      "enum": [
                        "visible",
                        "hidden",
                        "veryHidden"
                      ]
                    },
                    "orientation": {
                      "type": "string",
                      "enum": [
                        "portrait",
                        "landscape"
                      ]
                    },
                    "paper": {
                      "type": "string",
                      "enum": [
                        "A4",
                        "letter",
                        "legal"
                      ]
                    },
                    "margins": {
                      "type": "object",
                      "properties": {
                        "left": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 10
                        },
                        "right": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 10
                        },
                        "top": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 10
                        },
                        "bottom": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 10
                        },
                        "header": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 10
                        },
                        "footer": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 10
                        }
                      },
                      "required": [
                        "left",
                        "right",
                        "top",
                        "bottom",
                        "header",
                        "footer"
                      ],
                      "additionalProperties": false
                    },
                    "fitWidth": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 32767
                    },
                    "fitHeight": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 32767
                    },
                    "scale": {
                      "type": "integer",
                      "minimum": 10,
                      "maximum": 400
                    },
                    "printArea": {
                      "anyOf": [
                        {
                          "type": "string",
                          "maxLength": 21,
                          "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "titleRows": {
                      "anyOf": [
                        {
                          "type": "object",
                          "properties": {
                            "first": {
                              "type": "integer",
                              "minimum": 1,
                              "maximum": 1048576
                            },
                            "last": {
                              "type": "integer",
                              "minimum": 1,
                              "maximum": 1048576
                            }
                          },
                          "required": [
                            "first",
                            "last"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "titleColumns": {
                      "anyOf": [
                        {
                          "type": "object",
                          "properties": {
                            "first": {
                              "type": "integer",
                              "minimum": 1,
                              "maximum": 16384
                            },
                            "last": {
                              "type": "integer",
                              "minimum": 1,
                              "maximum": 16384
                            }
                          },
                          "required": [
                            "first",
                            "last"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "loss": {
                      "type": "string",
                      "enum": [
                        "reject",
                        "discard_non_anchor"
                      ]
                    },
                    "cell": {
                      "type": "string",
                      "maxLength": 21,
                      "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
                    },
                    "formula": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 8192
                    },
                    "overwrite": {
                      "type": "boolean"
                    },
                    "anchor": {
                      "type": "string",
                      "maxLength": 21,
                      "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
                    },
                    "name": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 255,
                      "pattern": "^[\\p{L}_\\\\][\\p{L}\\p{N}_.\\\\]*$"
                    },
                    "filter": {
                      "type": "boolean"
                    },
                    "totals": {
                      "anyOf": [
                        {
                          "maxItems": 1024,
                          "type": "array",
                          "items": {
                            "oneOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "label"
                                  },
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 255
                                  },
                                  "text": {
                                    "type": "string",
                                    "maxLength": 255
                                  }
                                },
                                "required": [
                                  "kind",
                                  "column",
                                  "text"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "function"
                                  },
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 255
                                  },
                                  "function": {
                                    "type": "string",
                                    "enum": [
                                      "sum",
                                      "average",
                                      "count",
                                      "countNums",
                                      "min",
                                      "max",
                                      "stdDev",
                                      "var"
                                    ]
                                  }
                                },
                                "required": [
                                  "kind",
                                  "column",
                                  "function"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "formula"
                                  },
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 255
                                  },
                                  "formula": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 8192
                                  }
                                },
                                "required": [
                                  "kind",
                                  "column",
                                  "formula"
                                ],
                                "additionalProperties": false
                              }
                            ]
                          }
                        },
                        {
                          "anyOf": [
                            {
                              "maxItems": 1024,
                              "type": "array",
                              "items": {
                                "oneOf": [
                                  {
                                    "type": "object",
                                    "properties": {
                                      "kind": {
                                        "type": "string",
                                        "const": "label"
                                      },
                                      "column": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 255
                                      },
                                      "text": {
                                        "type": "string",
                                        "maxLength": 255
                                      }
                                    },
                                    "required": [
                                      "kind",
                                      "column",
                                      "text"
                                    ],
                                    "additionalProperties": false
                                  },
                                  {
                                    "type": "object",
                                    "properties": {
                                      "kind": {
                                        "type": "string",
                                        "const": "function"
                                      },
                                      "column": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 255
                                      },
                                      "function": {
                                        "type": "string",
                                        "enum": [
                                          "sum",
                                          "average",
                                          "count",
                                          "countNums",
                                          "min",
                                          "max",
                                          "stdDev",
                                          "var"
                                        ]
                                      }
                                    },
                                    "required": [
                                      "kind",
                                      "column",
                                      "function"
                                    ],
                                    "additionalProperties": false
                                  },
                                  {
                                    "type": "object",
                                    "properties": {
                                      "kind": {
                                        "type": "string",
                                        "const": "formula"
                                      },
                                      "column": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 255
                                      },
                                      "formula": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 8192
                                      }
                                    },
                                    "required": [
                                      "kind",
                                      "column",
                                      "formula"
                                    ],
                                    "additionalProperties": false
                                  }
                                ]
                              }
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      ]
                    },
                    "calculatedColumns": {
                      "maxItems": 1024,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "column": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 255
                          },
                          "formula": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 8192
                          }
                        },
                        "required": [
                          "column",
                          "formula"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "tableName": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 255,
                      "pattern": "^[\\p{L}_\\\\][\\p{L}\\p{N}_.\\\\]*$"
                    },
                    "clearRemovedValues": {
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "kind",
                    "sheetName"
                  ],
                  "additionalProperties": false
                }
              }
            },
            "required": [
              "output",
              "changes"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "job"
  ],
  "additionalProperties": false
}
```

:::

## `run_bulk_job`

Optional job.finish is at the job root, never inside group: [{"output":"report","changes":[{"kind":"format_cells","sheetName":"S","range":"C2:C4","style":{"numberFormat":"0.00"}}]}]. For independent jobs each finish entry additionally names job. Changes use edit_workbook authoring kinds and run after data rendering, before the existing atomic publication. Formula changes require formula text and never calculate results. Execute the same job descriptor used by prepare_bulk_job. All dependent outputs are fully validated in memory, then their files and completion manifest are atomically published as one immutable job directory. Original files and earlier versions never change. Independent jobs commit separately and report complete/partial/failed/pending with per-job status; retry the same descriptor to reuse completed jobs and attempt only unfinished ones. Exact source versions and normalized operations identify each group. A retained result is verified and returned before source rereads, allowing recovery after a lost response or process restart even if an original later changed. Stale sources before first commit refuse. Outputs have exact readable .xlsx versions. Dependent failure publishes no completed group. No formula calculation; explicit value pipelines report saved-cache use. Use get_bulk_job with returned jobId for durable status. Read the prepare_bulk_job description for step/output syntax.

Annotations: non-destructive, closed world.

Available only with `--write <relative-output-directory>`. The registered JSON Schema below is the exact wire contract; nested operation variants are validated by the server.

:::details[Input JSON Schema]

```json
{
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "job": {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "dependent",
            "independent"
          ]
        },
        "group": {
          "type": "object",
          "properties": {
            "steps": {
              "minItems": 1,
              "maxItems": 32,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "enum": [
                      "read",
                      "update",
                      "remove",
                      "filter",
                      "keyed_update",
                      "upsert",
                      "replace",
                      "append",
                      "join",
                      "deduplicate",
                      "sort",
                      "project",
                      "transform"
                    ]
                  },
                  "id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "input": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "source": {
                    "anyOf": [
                      {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 48,
                        "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                      },
                      {
                        "type": "object",
                        "properties": {
                          "filePath": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 32768
                          },
                          "versionId": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$"
                          }
                        },
                        "required": [
                          "filePath",
                          "versionId"
                        ],
                        "additionalProperties": false
                      }
                    ]
                  },
                  "target": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "selection": {
                    "type": "object",
                    "properties": {
                      "kind": {
                        "type": "string",
                        "const": "records"
                      },
                      "sheetName": {
                        "description": "Exact worksheet name; defaults to the first visible sheet.",
                        "type": "string"
                      },
                      "range": {
                        "type": "string",
                        "maxLength": 21,
                        "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}:[A-Za-z]{1,3}[1-9][0-9]{0,6}$"
                      },
                      "table": {
                        "description": "Declared table name; selects its data rows. Not with range. XLSX only.",
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 255
                      },
                      "visibleOnly": {
                        "description": "Skip saved hidden rows, AutoFilter's included. XLSX only.",
                        "type": "boolean"
                      },
                      "headerRow": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 1048576
                      },
                      "columnMode": {
                        "description": "Columns are named by header text or A1 letter: auto (default), header or letter.",
                        "type": "string",
                        "enum": [
                          "auto",
                          "header",
                          "letter"
                        ]
                      },
                      "caseSensitive": {
                        "description": "Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.",
                        "type": "boolean"
                      },
                      "columns": {
                        "description": "How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues.",
                        "minItems": 1,
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "column": {
                              "type": "string",
                              "description": "Header text or A1 letter."
                            },
                            "type": {
                              "type": "string",
                              "enum": [
                                "number",
                                "date",
                                "boolean",
                                "time",
                                "duration",
                                "text"
                              ],
                              "description": "How to read the column."
                            },
                            "missingValues": {
                              "description": "Missing-text tokens.",
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 128
                              }
                            },
                            "decimal": {
                              "description": "Decimal separator, for number.",
                              "type": "string",
                              "enum": [
                                ".",
                                ","
                              ]
                            },
                            "group": {
                              "description": "Thousands separator, for number.",
                              "type": "string",
                              "enum": [
                                "none",
                                ".",
                                ",",
                                " ",
                                "'"
                              ]
                            },
                            "locale": {
                              "description": "File locale, for number or date.",
                              "type": "string",
                              "minLength": 2,
                              "maxLength": 64
                            },
                            "numberingSystem": {
                              "description": "Numbering system, for number.",
                              "type": "string",
                              "minLength": 3,
                              "maxLength": 32
                            },
                            "identifiers": {
                              "description": "Whether to read digit identifiers, for number.",
                              "type": "string",
                              "enum": [
                                "refuse",
                                "read"
                              ]
                            },
                            "format": {
                              "description": "Date pattern such as dd.MM.yyyy, for date.",
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 64
                            },
                            "order": {
                              "description": "Day/month order without a format, for date.",
                              "type": "string",
                              "enum": [
                                "dmy",
                                "mdy"
                              ]
                            },
                            "trueValues": {
                              "description": "True-text tokens, for boolean.",
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 128
                              }
                            },
                            "falseValues": {
                              "description": "False-text tokens, for boolean.",
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 128
                              }
                            }
                          },
                          "required": [
                            "column",
                            "type"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "mergedCells": {
                        "description": "Merged values and header detection policy, default master.",
                        "type": "string",
                        "enum": [
                          "master",
                          "repeat"
                        ]
                      },
                      "delimiter": {
                        "description": "CSV separator; sniffed when omitted.",
                        "type": "string",
                        "enum": [
                          "comma",
                          "semicolon",
                          "tab",
                          "pipe"
                        ]
                      },
                      "encoding": {
                        "description": "CSV encoding; BOM or utf-8 when omitted.",
                        "type": "string",
                        "enum": [
                          "utf-8",
                          "utf-16le",
                          "utf-16be",
                          "windows-1254",
                          "iso-8859-9",
                          "windows-1252",
                          "windows-1251",
                          "windows-1256",
                          "shift_jis",
                          "gb18030",
                          "big5",
                          "euc-kr"
                        ]
                      },
                      "locale": {
                        "description": "BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.",
                        "type": "string",
                        "minLength": 2,
                        "maxLength": 64
                      },
                      "numberingSystem": {
                        "description": "Numbering system such as arab; needs locale.",
                        "type": "string",
                        "minLength": 3,
                        "maxLength": 32
                      },
                      "missingValues": {
                        "description": "Missing-text tokens; default N/A, NULL, -, —, #N/A.",
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        }
                      },
                      "trueValues": {
                        "description": "True-text tokens; default true, yes, y, Evet, E.",
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        }
                      },
                      "falseValues": {
                        "description": "False-text tokens; default false, no, n, Hayır, H.",
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        }
                      },
                      "selectColumns": {
                        "minItems": 1,
                        "maxItems": 16384,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 32767
                        }
                      },
                      "where": {
                        "maxItems": 16,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "column": {
                              "type": "string",
                              "description": "Header text or A1 letter."
                            },
                            "op": {
                              "type": "string",
                              "enum": [
                                "eq",
                                "ne",
                                "lt",
                                "lte",
                                "gt",
                                "gte",
                                "contains",
                                "startsWith",
                                "endsWith",
                                "in",
                                "between",
                                "isEmpty",
                                "isNotEmpty",
                                "isError",
                                "isNumber",
                                "isText"
                              ]
                            },
                            "value": {
                              "description": "Operand.",
                              "type": [
                                "string",
                                "number",
                                "boolean"
                              ]
                            },
                            "values": {
                              "description": "Operands of in, or [low, high] of between.",
                              "minItems": 1,
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": [
                                  "string",
                                  "number",
                                  "boolean"
                                ]
                              }
                            }
                          },
                          "required": [
                            "column",
                            "op"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "match": {
                        "default": "all",
                        "type": "string",
                        "enum": [
                          "all",
                          "any"
                        ]
                      },
                      "scope": {
                        "default": {
                          "kind": "all"
                        },
                        "oneOf": [
                          {
                            "type": "object",
                            "properties": {
                              "kind": {
                                "type": "string",
                                "const": "all"
                              }
                            },
                            "required": [
                              "kind"
                            ],
                            "additionalProperties": false
                          },
                          {
                            "type": "object",
                            "properties": {
                              "kind": {
                                "type": "string",
                                "const": "rows"
                              },
                              "rows": {
                                "minItems": 1,
                                "maxItems": 10000,
                                "type": "array",
                                "items": {
                                  "type": "integer",
                                  "minimum": 1,
                                  "maximum": 1048576
                                }
                              }
                            },
                            "required": [
                              "kind",
                              "rows"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      },
                      "includeHeaders": {
                        "default": false,
                        "type": "boolean",
                        "const": false
                      }
                    },
                    "required": [
                      "kind",
                      "headerRow"
                    ],
                    "additionalProperties": false
                  },
                  "where": {
                    "maxItems": 16,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "column": {
                          "type": "string",
                          "description": "Header text or A1 letter."
                        },
                        "op": {
                          "type": "string",
                          "enum": [
                            "eq",
                            "ne",
                            "lt",
                            "lte",
                            "gt",
                            "gte",
                            "contains",
                            "startsWith",
                            "endsWith",
                            "in",
                            "between",
                            "isEmpty",
                            "isNotEmpty",
                            "isError",
                            "isNumber",
                            "isText"
                          ]
                        },
                        "value": {
                          "description": "Operand.",
                          "type": [
                            "string",
                            "number",
                            "boolean"
                          ]
                        },
                        "values": {
                          "description": "Operands of in, or [low, high] of between.",
                          "minItems": 1,
                          "maxItems": 64,
                          "type": "array",
                          "items": {
                            "type": [
                              "string",
                              "number",
                              "boolean"
                            ]
                          }
                        }
                      },
                      "required": [
                        "column",
                        "op"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "match": {
                    "type": "string",
                    "enum": [
                      "all",
                      "any"
                    ]
                  },
                  "caseSensitive": {
                    "type": "boolean"
                  },
                  "set": {
                    "anyOf": [
                      {
                        "minItems": 1,
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            },
                            "value": {
                              "oneOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "text"
                                    },
                                    "value": {
                                      "type": "string",
                                      "maxLength": 32767
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "number"
                                    },
                                    "value": {
                                      "type": "number"
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "boolean"
                                    },
                                    "value": {
                                      "type": "boolean"
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "blank"
                                    }
                                  },
                                  "required": [
                                    "kind"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "date"
                                    },
                                    "value": {
                                      "type": "string",
                                      "minLength": 10,
                                      "format": "date",
                                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "datetime"
                                    },
                                    "value": {
                                      "type": "string",
                                      "allOf": [
                                        {
                                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z)|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"
                                        },
                                        {
                                          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?$"
                                        }
                                      ]
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                }
                              ]
                            }
                          },
                          "required": [
                            "column",
                            "value"
                          ],
                          "additionalProperties": false
                        }
                      },
                      {
                        "minItems": 1,
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "sourceColumn": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            },
                            "targetColumn": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            }
                          },
                          "required": [
                            "sourceColumn",
                            "targetColumn"
                          ],
                          "additionalProperties": false
                        }
                      }
                    ],
                    "type": "array"
                  },
                  "mode": {
                    "type": "string",
                    "enum": [
                      "clear",
                      "delete_rows"
                    ]
                  },
                  "keys": {
                    "anyOf": [
                      {
                        "minItems": 1,
                        "maxItems": 16,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "sourceColumn": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            },
                            "targetColumn": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            }
                          },
                          "required": [
                            "sourceColumn",
                            "targetColumn"
                          ],
                          "additionalProperties": false
                        }
                      },
                      {
                        "minItems": 1,
                        "maxItems": 256,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 32767
                        }
                      }
                    ],
                    "type": "array"
                  },
                  "duplicates": {
                    "type": "string",
                    "enum": [
                      "error",
                      "first",
                      "last"
                    ]
                  },
                  "missingKeys": {
                    "anyOf": [
                      {
                        "type": "string",
                        "enum": [
                          "error",
                          "skip"
                        ]
                      },
                      {
                        "type": "string",
                        "enum": [
                          "error",
                          "keep",
                          "group"
                        ]
                      }
                    ]
                  },
                  "inputs": {
                    "minItems": 1,
                    "maxItems": 8,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 48,
                      "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                    }
                  },
                  "columns": {
                    "anyOf": [
                      {
                        "minItems": 1,
                        "maxItems": 256,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 32767
                        }
                      },
                      {
                        "minItems": 1,
                        "maxItems": 256,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "side": {
                              "type": "string",
                              "enum": [
                                "left",
                                "right"
                              ]
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            },
                            "as": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            }
                          },
                          "required": [
                            "side",
                            "column",
                            "as"
                          ],
                          "additionalProperties": false
                        }
                      },
                      {
                        "minItems": 1,
                        "maxItems": 256,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            },
                            "as": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            }
                          },
                          "required": [
                            "column",
                            "as"
                          ],
                          "additionalProperties": false
                        }
                      }
                    ],
                    "type": "array"
                  },
                  "missingColumns": {
                    "type": "string",
                    "enum": [
                      "error",
                      "blank"
                    ]
                  },
                  "left": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "right": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "join": {
                    "type": "string",
                    "enum": [
                      "inner",
                      "left",
                      "full"
                    ]
                  },
                  "manyToMany": {
                    "type": "boolean"
                  },
                  "keep": {
                    "type": "string",
                    "enum": [
                      "report",
                      "duplicates_only",
                      "first",
                      "last",
                      "drop_all"
                    ]
                  },
                  "by": {
                    "minItems": 1,
                    "maxItems": 16,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "column": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 32767
                        },
                        "direction": {
                          "type": "string",
                          "enum": [
                            "asc",
                            "desc"
                          ]
                        },
                        "blanks": {
                          "type": "string",
                          "enum": [
                            "first",
                            "last"
                          ]
                        }
                      },
                      "required": [
                        "column",
                        "direction",
                        "blanks"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "mixedTypes": {
                    "type": "string",
                    "enum": [
                      "error",
                      "type_order"
                    ]
                  },
                  "locale": {
                    "type": "string",
                    "minLength": 2,
                    "maxLength": 64
                  },
                  "transformations": {
                    "minItems": 1,
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "constant"
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            },
                            "value": {
                              "oneOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "text"
                                    },
                                    "value": {
                                      "type": "string",
                                      "maxLength": 32767
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "number"
                                    },
                                    "value": {
                                      "type": "number"
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "boolean"
                                    },
                                    "value": {
                                      "type": "boolean"
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "blank"
                                    }
                                  },
                                  "required": [
                                    "kind"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "date"
                                    },
                                    "value": {
                                      "type": "string",
                                      "minLength": 10,
                                      "format": "date",
                                      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "datetime"
                                    },
                                    "value": {
                                      "type": "string",
                                      "allOf": [
                                        {
                                          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z)|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"
                                        },
                                        {
                                          "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?$"
                                        }
                                      ]
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "value"
                                  ],
                                  "additionalProperties": false
                                }
                              ]
                            }
                          },
                          "required": [
                            "kind",
                            "column",
                            "value"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "trim"
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            }
                          },
                          "required": [
                            "kind",
                            "column"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "case"
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 32767
                            },
                            "direction": {
                              "type": "string",
                              "enum": [
                                "upper",
                                "lower"
                              ]
                            },
                            "locale": {
                              "type": "string",
                              "minLength": 2,
                              "maxLength": 64
                            }
                          },
                          "required": [
                            "kind",
                            "column",
                            "direction",
                            "locale"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "convert"
                            },
                            "spec": {
                              "oneOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "column": {
                                      "type": "string",
                                      "description": "Header text or A1 letter."
                                    },
                                    "missingValues": {
                                      "description": "Missing-text tokens.",
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    },
                                    "type": {
                                      "type": "string",
                                      "const": "number"
                                    },
                                    "decimal": {
                                      "type": "string",
                                      "enum": [
                                        ".",
                                        ","
                                      ]
                                    },
                                    "group": {
                                      "type": "string",
                                      "enum": [
                                        "none",
                                        ".",
                                        ",",
                                        " ",
                                        "'"
                                      ]
                                    },
                                    "locale": {
                                      "type": "string",
                                      "minLength": 2,
                                      "maxLength": 64
                                    },
                                    "numberingSystem": {
                                      "type": "string",
                                      "minLength": 3,
                                      "maxLength": 32
                                    },
                                    "identifiers": {
                                      "type": "string",
                                      "enum": [
                                        "refuse",
                                        "read"
                                      ]
                                    }
                                  },
                                  "required": [
                                    "column",
                                    "type"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "column": {
                                      "type": "string",
                                      "description": "Header text or A1 letter."
                                    },
                                    "missingValues": {
                                      "description": "Missing-text tokens.",
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    },
                                    "type": {
                                      "type": "string",
                                      "const": "date"
                                    },
                                    "format": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 64
                                    },
                                    "order": {
                                      "type": "string",
                                      "enum": [
                                        "dmy",
                                        "mdy"
                                      ]
                                    },
                                    "locale": {
                                      "type": "string",
                                      "minLength": 2,
                                      "maxLength": 64
                                    }
                                  },
                                  "required": [
                                    "column",
                                    "type"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "column": {
                                      "type": "string",
                                      "description": "Header text or A1 letter."
                                    },
                                    "missingValues": {
                                      "description": "Missing-text tokens.",
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    },
                                    "type": {
                                      "type": "string",
                                      "const": "boolean"
                                    },
                                    "trueValues": {
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    },
                                    "falseValues": {
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    }
                                  },
                                  "required": [
                                    "column",
                                    "type"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "column": {
                                      "type": "string",
                                      "description": "Header text or A1 letter."
                                    },
                                    "missingValues": {
                                      "description": "Missing-text tokens.",
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    },
                                    "type": {
                                      "type": "string",
                                      "const": "time"
                                    }
                                  },
                                  "required": [
                                    "column",
                                    "type"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "column": {
                                      "type": "string",
                                      "description": "Header text or A1 letter."
                                    },
                                    "missingValues": {
                                      "description": "Missing-text tokens.",
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    },
                                    "type": {
                                      "type": "string",
                                      "const": "duration"
                                    }
                                  },
                                  "required": [
                                    "column",
                                    "type"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "column": {
                                      "type": "string",
                                      "description": "Header text or A1 letter."
                                    },
                                    "missingValues": {
                                      "description": "Missing-text tokens.",
                                      "maxItems": 64,
                                      "type": "array",
                                      "items": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 128
                                      }
                                    },
                                    "type": {
                                      "type": "string",
                                      "const": "text"
                                    }
                                  },
                                  "required": [
                                    "column",
                                    "type"
                                  ],
                                  "additionalProperties": false
                                }
                              ]
                            }
                          },
                          "required": [
                            "kind",
                            "spec"
                          ],
                          "additionalProperties": false
                        }
                      ],
                      "type": "object"
                    }
                  },
                  "onError": {
                    "type": "string",
                    "enum": [
                      "error",
                      "blank",
                      "keep"
                    ]
                  }
                },
                "required": [
                  "kind",
                  "id"
                ],
                "additionalProperties": false
              }
            },
            "outputs": {
              "minItems": 1,
              "maxItems": 16,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "enum": [
                      "new",
                      "edit",
                      "edit_workbook"
                    ]
                  },
                  "id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "sheets": {
                    "minItems": 1,
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "name": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 31
                        },
                        "input": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        }
                      },
                      "required": [
                        "name",
                        "input"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "target": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "input": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 48,
                    "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                  },
                  "mode": {
                    "type": "string",
                    "enum": [
                      "changed_values",
                      "replace_values"
                    ]
                  },
                  "overwrite": {
                    "type": "boolean"
                  },
                  "changes": {
                    "minItems": 1,
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "target": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "input": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "mode": {
                          "type": "string",
                          "enum": [
                            "changed_values",
                            "replace_values"
                          ]
                        },
                        "overwrite": {
                          "default": false,
                          "type": "boolean"
                        }
                      },
                      "required": [
                        "target",
                        "input",
                        "mode"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "kind",
                  "id"
                ],
                "additionalProperties": false
              }
            }
          },
          "required": [
            "steps",
            "outputs"
          ],
          "additionalProperties": false
        },
        "jobs": {
          "minItems": 1,
          "maxItems": 16,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
              },
              "group": {
                "type": "object",
                "properties": {
                  "steps": {
                    "minItems": 1,
                    "maxItems": 32,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "enum": [
                            "read",
                            "update",
                            "remove",
                            "filter",
                            "keyed_update",
                            "upsert",
                            "replace",
                            "append",
                            "join",
                            "deduplicate",
                            "sort",
                            "project",
                            "transform"
                          ]
                        },
                        "id": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "input": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "source": {
                          "anyOf": [
                            {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 48,
                              "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                            },
                            {
                              "type": "object",
                              "properties": {
                                "filePath": {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 32768
                                },
                                "versionId": {
                                  "type": "string",
                                  "pattern": "^[a-f0-9]{64}$"
                                }
                              },
                              "required": [
                                "filePath",
                                "versionId"
                              ],
                              "additionalProperties": false
                            }
                          ]
                        },
                        "target": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "selection": {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "records"
                            },
                            "sheetName": {
                              "description": "Exact worksheet name; defaults to the first visible sheet.",
                              "type": "string"
                            },
                            "range": {
                              "type": "string",
                              "maxLength": 21,
                              "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}:[A-Za-z]{1,3}[1-9][0-9]{0,6}$"
                            },
                            "table": {
                              "description": "Declared table name; selects its data rows. Not with range. XLSX only.",
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 255
                            },
                            "visibleOnly": {
                              "description": "Skip saved hidden rows, AutoFilter's included. XLSX only.",
                              "type": "boolean"
                            },
                            "headerRow": {
                              "type": "integer",
                              "minimum": 1,
                              "maximum": 1048576
                            },
                            "columnMode": {
                              "description": "Columns are named by header text or A1 letter: auto (default), header or letter.",
                              "type": "string",
                              "enum": [
                                "auto",
                                "header",
                                "letter"
                              ]
                            },
                            "caseSensitive": {
                              "description": "Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.",
                              "type": "boolean"
                            },
                            "columns": {
                              "description": "How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues.",
                              "minItems": 1,
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "column": {
                                    "type": "string",
                                    "description": "Header text or A1 letter."
                                  },
                                  "type": {
                                    "type": "string",
                                    "enum": [
                                      "number",
                                      "date",
                                      "boolean",
                                      "time",
                                      "duration",
                                      "text"
                                    ],
                                    "description": "How to read the column."
                                  },
                                  "missingValues": {
                                    "description": "Missing-text tokens.",
                                    "maxItems": 64,
                                    "type": "array",
                                    "items": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 128
                                    }
                                  },
                                  "decimal": {
                                    "description": "Decimal separator, for number.",
                                    "type": "string",
                                    "enum": [
                                      ".",
                                      ","
                                    ]
                                  },
                                  "group": {
                                    "description": "Thousands separator, for number.",
                                    "type": "string",
                                    "enum": [
                                      "none",
                                      ".",
                                      ",",
                                      " ",
                                      "'"
                                    ]
                                  },
                                  "locale": {
                                    "description": "File locale, for number or date.",
                                    "type": "string",
                                    "minLength": 2,
                                    "maxLength": 64
                                  },
                                  "numberingSystem": {
                                    "description": "Numbering system, for number.",
                                    "type": "string",
                                    "minLength": 3,
                                    "maxLength": 32
                                  },
                                  "identifiers": {
                                    "description": "Whether to read digit identifiers, for number.",
                                    "type": "string",
                                    "enum": [
                                      "refuse",
                                      "read"
                                    ]
                                  },
                                  "format": {
                                    "description": "Date pattern such as dd.MM.yyyy, for date.",
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 64
                                  },
                                  "order": {
                                    "description": "Day/month order without a format, for date.",
                                    "type": "string",
                                    "enum": [
                                      "dmy",
                                      "mdy"
                                    ]
                                  },
                                  "trueValues": {
                                    "description": "True-text tokens, for boolean.",
                                    "maxItems": 64,
                                    "type": "array",
                                    "items": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 128
                                    }
                                  },
                                  "falseValues": {
                                    "description": "False-text tokens, for boolean.",
                                    "maxItems": 64,
                                    "type": "array",
                                    "items": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 128
                                    }
                                  }
                                },
                                "required": [
                                  "column",
                                  "type"
                                ],
                                "additionalProperties": false
                              }
                            },
                            "mergedCells": {
                              "description": "Merged values and header detection policy, default master.",
                              "type": "string",
                              "enum": [
                                "master",
                                "repeat"
                              ]
                            },
                            "delimiter": {
                              "description": "CSV separator; sniffed when omitted.",
                              "type": "string",
                              "enum": [
                                "comma",
                                "semicolon",
                                "tab",
                                "pipe"
                              ]
                            },
                            "encoding": {
                              "description": "CSV encoding; BOM or utf-8 when omitted.",
                              "type": "string",
                              "enum": [
                                "utf-8",
                                "utf-16le",
                                "utf-16be",
                                "windows-1254",
                                "iso-8859-9",
                                "windows-1252",
                                "windows-1251",
                                "windows-1256",
                                "shift_jis",
                                "gb18030",
                                "big5",
                                "euc-kr"
                              ]
                            },
                            "locale": {
                              "description": "BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.",
                              "type": "string",
                              "minLength": 2,
                              "maxLength": 64
                            },
                            "numberingSystem": {
                              "description": "Numbering system such as arab; needs locale.",
                              "type": "string",
                              "minLength": 3,
                              "maxLength": 32
                            },
                            "missingValues": {
                              "description": "Missing-text tokens; default N/A, NULL, -, —, #N/A.",
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 128
                              }
                            },
                            "trueValues": {
                              "description": "True-text tokens; default true, yes, y, Evet, E.",
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 128
                              }
                            },
                            "falseValues": {
                              "description": "False-text tokens; default false, no, n, Hayır, H.",
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 128
                              }
                            },
                            "selectColumns": {
                              "minItems": 1,
                              "maxItems": 16384,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 32767
                              }
                            },
                            "where": {
                              "maxItems": 16,
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "column": {
                                    "type": "string",
                                    "description": "Header text or A1 letter."
                                  },
                                  "op": {
                                    "type": "string",
                                    "enum": [
                                      "eq",
                                      "ne",
                                      "lt",
                                      "lte",
                                      "gt",
                                      "gte",
                                      "contains",
                                      "startsWith",
                                      "endsWith",
                                      "in",
                                      "between",
                                      "isEmpty",
                                      "isNotEmpty",
                                      "isError",
                                      "isNumber",
                                      "isText"
                                    ]
                                  },
                                  "value": {
                                    "description": "Operand.",
                                    "type": [
                                      "string",
                                      "number",
                                      "boolean"
                                    ]
                                  },
                                  "values": {
                                    "description": "Operands of in, or [low, high] of between.",
                                    "minItems": 1,
                                    "maxItems": 64,
                                    "type": "array",
                                    "items": {
                                      "type": [
                                        "string",
                                        "number",
                                        "boolean"
                                      ]
                                    }
                                  }
                                },
                                "required": [
                                  "column",
                                  "op"
                                ],
                                "additionalProperties": false
                              }
                            },
                            "match": {
                              "default": "all",
                              "type": "string",
                              "enum": [
                                "all",
                                "any"
                              ]
                            },
                            "scope": {
                              "default": {
                                "kind": "all"
                              },
                              "oneOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "all"
                                    }
                                  },
                                  "required": [
                                    "kind"
                                  ],
                                  "additionalProperties": false
                                },
                                {
                                  "type": "object",
                                  "properties": {
                                    "kind": {
                                      "type": "string",
                                      "const": "rows"
                                    },
                                    "rows": {
                                      "minItems": 1,
                                      "maxItems": 10000,
                                      "type": "array",
                                      "items": {
                                        "type": "integer",
                                        "minimum": 1,
                                        "maximum": 1048576
                                      }
                                    }
                                  },
                                  "required": [
                                    "kind",
                                    "rows"
                                  ],
                                  "additionalProperties": false
                                }
                              ]
                            },
                            "includeHeaders": {
                              "default": false,
                              "type": "boolean",
                              "const": false
                            }
                          },
                          "required": [
                            "kind",
                            "headerRow"
                          ],
                          "additionalProperties": false
                        },
                        "where": {
                          "maxItems": 16,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "column": {
                                "type": "string",
                                "description": "Header text or A1 letter."
                              },
                              "op": {
                                "type": "string",
                                "enum": [
                                  "eq",
                                  "ne",
                                  "lt",
                                  "lte",
                                  "gt",
                                  "gte",
                                  "contains",
                                  "startsWith",
                                  "endsWith",
                                  "in",
                                  "between",
                                  "isEmpty",
                                  "isNotEmpty",
                                  "isError",
                                  "isNumber",
                                  "isText"
                                ]
                              },
                              "value": {
                                "description": "Operand.",
                                "type": [
                                  "string",
                                  "number",
                                  "boolean"
                                ]
                              },
                              "values": {
                                "description": "Operands of in, or [low, high] of between.",
                                "minItems": 1,
                                "maxItems": 64,
                                "type": "array",
                                "items": {
                                  "type": [
                                    "string",
                                    "number",
                                    "boolean"
                                  ]
                                }
                              }
                            },
                            "required": [
                              "column",
                              "op"
                            ],
                            "additionalProperties": false
                          }
                        },
                        "match": {
                          "type": "string",
                          "enum": [
                            "all",
                            "any"
                          ]
                        },
                        "caseSensitive": {
                          "type": "boolean"
                        },
                        "set": {
                          "anyOf": [
                            {
                              "minItems": 1,
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  },
                                  "value": {
                                    "oneOf": [
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "text"
                                          },
                                          "value": {
                                            "type": "string",
                                            "maxLength": 32767
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "number"
                                          },
                                          "value": {
                                            "type": "number"
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "boolean"
                                          },
                                          "value": {
                                            "type": "boolean"
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "blank"
                                          }
                                        },
                                        "required": [
                                          "kind"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "date"
                                          },
                                          "value": {
                                            "type": "string",
                                            "minLength": 10,
                                            "format": "date",
                                            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "datetime"
                                          },
                                          "value": {
                                            "type": "string",
                                            "allOf": [
                                              {
                                                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z)|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"
                                              },
                                              {
                                                "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?$"
                                              }
                                            ]
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      }
                                    ]
                                  }
                                },
                                "required": [
                                  "column",
                                  "value"
                                ],
                                "additionalProperties": false
                              }
                            },
                            {
                              "minItems": 1,
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "sourceColumn": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  },
                                  "targetColumn": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  }
                                },
                                "required": [
                                  "sourceColumn",
                                  "targetColumn"
                                ],
                                "additionalProperties": false
                              }
                            }
                          ],
                          "type": "array"
                        },
                        "mode": {
                          "type": "string",
                          "enum": [
                            "clear",
                            "delete_rows"
                          ]
                        },
                        "keys": {
                          "anyOf": [
                            {
                              "minItems": 1,
                              "maxItems": 16,
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "sourceColumn": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  },
                                  "targetColumn": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  }
                                },
                                "required": [
                                  "sourceColumn",
                                  "targetColumn"
                                ],
                                "additionalProperties": false
                              }
                            },
                            {
                              "minItems": 1,
                              "maxItems": 256,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 32767
                              }
                            }
                          ],
                          "type": "array"
                        },
                        "duplicates": {
                          "type": "string",
                          "enum": [
                            "error",
                            "first",
                            "last"
                          ]
                        },
                        "missingKeys": {
                          "anyOf": [
                            {
                              "type": "string",
                              "enum": [
                                "error",
                                "skip"
                              ]
                            },
                            {
                              "type": "string",
                              "enum": [
                                "error",
                                "keep",
                                "group"
                              ]
                            }
                          ]
                        },
                        "inputs": {
                          "minItems": 1,
                          "maxItems": 8,
                          "type": "array",
                          "items": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 48,
                            "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                          }
                        },
                        "columns": {
                          "anyOf": [
                            {
                              "minItems": 1,
                              "maxItems": 256,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 32767
                              }
                            },
                            {
                              "minItems": 1,
                              "maxItems": 256,
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "side": {
                                    "type": "string",
                                    "enum": [
                                      "left",
                                      "right"
                                    ]
                                  },
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  },
                                  "as": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  }
                                },
                                "required": [
                                  "side",
                                  "column",
                                  "as"
                                ],
                                "additionalProperties": false
                              }
                            },
                            {
                              "minItems": 1,
                              "maxItems": 256,
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  },
                                  "as": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  }
                                },
                                "required": [
                                  "column",
                                  "as"
                                ],
                                "additionalProperties": false
                              }
                            }
                          ],
                          "type": "array"
                        },
                        "missingColumns": {
                          "type": "string",
                          "enum": [
                            "error",
                            "blank"
                          ]
                        },
                        "left": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "right": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "join": {
                          "type": "string",
                          "enum": [
                            "inner",
                            "left",
                            "full"
                          ]
                        },
                        "manyToMany": {
                          "type": "boolean"
                        },
                        "keep": {
                          "type": "string",
                          "enum": [
                            "report",
                            "duplicates_only",
                            "first",
                            "last",
                            "drop_all"
                          ]
                        },
                        "by": {
                          "minItems": 1,
                          "maxItems": 16,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "column": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 32767
                              },
                              "direction": {
                                "type": "string",
                                "enum": [
                                  "asc",
                                  "desc"
                                ]
                              },
                              "blanks": {
                                "type": "string",
                                "enum": [
                                  "first",
                                  "last"
                                ]
                              }
                            },
                            "required": [
                              "column",
                              "direction",
                              "blanks"
                            ],
                            "additionalProperties": false
                          }
                        },
                        "mixedTypes": {
                          "type": "string",
                          "enum": [
                            "error",
                            "type_order"
                          ]
                        },
                        "locale": {
                          "type": "string",
                          "minLength": 2,
                          "maxLength": 64
                        },
                        "transformations": {
                          "minItems": 1,
                          "maxItems": 64,
                          "type": "array",
                          "items": {
                            "oneOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "constant"
                                  },
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  },
                                  "value": {
                                    "oneOf": [
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "text"
                                          },
                                          "value": {
                                            "type": "string",
                                            "maxLength": 32767
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "number"
                                          },
                                          "value": {
                                            "type": "number"
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "boolean"
                                          },
                                          "value": {
                                            "type": "boolean"
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "blank"
                                          }
                                        },
                                        "required": [
                                          "kind"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "date"
                                          },
                                          "value": {
                                            "type": "string",
                                            "minLength": 10,
                                            "format": "date",
                                            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "kind": {
                                            "type": "string",
                                            "const": "datetime"
                                          },
                                          "value": {
                                            "type": "string",
                                            "allOf": [
                                              {
                                                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z)|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"
                                              },
                                              {
                                                "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?$"
                                              }
                                            ]
                                          }
                                        },
                                        "required": [
                                          "kind",
                                          "value"
                                        ],
                                        "additionalProperties": false
                                      }
                                    ]
                                  }
                                },
                                "required": [
                                  "kind",
                                  "column",
                                  "value"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "trim"
                                  },
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  }
                                },
                                "required": [
                                  "kind",
                                  "column"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "case"
                                  },
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 32767
                                  },
                                  "direction": {
                                    "type": "string",
                                    "enum": [
                                      "upper",
                                      "lower"
                                    ]
                                  },
                                  "locale": {
                                    "type": "string",
                                    "minLength": 2,
                                    "maxLength": 64
                                  }
                                },
                                "required": [
                                  "kind",
                                  "column",
                                  "direction",
                                  "locale"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "convert"
                                  },
                                  "spec": {
                                    "oneOf": [
                                      {
                                        "type": "object",
                                        "properties": {
                                          "column": {
                                            "type": "string",
                                            "description": "Header text or A1 letter."
                                          },
                                          "missingValues": {
                                            "description": "Missing-text tokens.",
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          },
                                          "type": {
                                            "type": "string",
                                            "const": "number"
                                          },
                                          "decimal": {
                                            "type": "string",
                                            "enum": [
                                              ".",
                                              ","
                                            ]
                                          },
                                          "group": {
                                            "type": "string",
                                            "enum": [
                                              "none",
                                              ".",
                                              ",",
                                              " ",
                                              "'"
                                            ]
                                          },
                                          "locale": {
                                            "type": "string",
                                            "minLength": 2,
                                            "maxLength": 64
                                          },
                                          "numberingSystem": {
                                            "type": "string",
                                            "minLength": 3,
                                            "maxLength": 32
                                          },
                                          "identifiers": {
                                            "type": "string",
                                            "enum": [
                                              "refuse",
                                              "read"
                                            ]
                                          }
                                        },
                                        "required": [
                                          "column",
                                          "type"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "column": {
                                            "type": "string",
                                            "description": "Header text or A1 letter."
                                          },
                                          "missingValues": {
                                            "description": "Missing-text tokens.",
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          },
                                          "type": {
                                            "type": "string",
                                            "const": "date"
                                          },
                                          "format": {
                                            "type": "string",
                                            "minLength": 1,
                                            "maxLength": 64
                                          },
                                          "order": {
                                            "type": "string",
                                            "enum": [
                                              "dmy",
                                              "mdy"
                                            ]
                                          },
                                          "locale": {
                                            "type": "string",
                                            "minLength": 2,
                                            "maxLength": 64
                                          }
                                        },
                                        "required": [
                                          "column",
                                          "type"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "column": {
                                            "type": "string",
                                            "description": "Header text or A1 letter."
                                          },
                                          "missingValues": {
                                            "description": "Missing-text tokens.",
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          },
                                          "type": {
                                            "type": "string",
                                            "const": "boolean"
                                          },
                                          "trueValues": {
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          },
                                          "falseValues": {
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          }
                                        },
                                        "required": [
                                          "column",
                                          "type"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "column": {
                                            "type": "string",
                                            "description": "Header text or A1 letter."
                                          },
                                          "missingValues": {
                                            "description": "Missing-text tokens.",
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          },
                                          "type": {
                                            "type": "string",
                                            "const": "time"
                                          }
                                        },
                                        "required": [
                                          "column",
                                          "type"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "column": {
                                            "type": "string",
                                            "description": "Header text or A1 letter."
                                          },
                                          "missingValues": {
                                            "description": "Missing-text tokens.",
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          },
                                          "type": {
                                            "type": "string",
                                            "const": "duration"
                                          }
                                        },
                                        "required": [
                                          "column",
                                          "type"
                                        ],
                                        "additionalProperties": false
                                      },
                                      {
                                        "type": "object",
                                        "properties": {
                                          "column": {
                                            "type": "string",
                                            "description": "Header text or A1 letter."
                                          },
                                          "missingValues": {
                                            "description": "Missing-text tokens.",
                                            "maxItems": 64,
                                            "type": "array",
                                            "items": {
                                              "type": "string",
                                              "minLength": 1,
                                              "maxLength": 128
                                            }
                                          },
                                          "type": {
                                            "type": "string",
                                            "const": "text"
                                          }
                                        },
                                        "required": [
                                          "column",
                                          "type"
                                        ],
                                        "additionalProperties": false
                                      }
                                    ]
                                  }
                                },
                                "required": [
                                  "kind",
                                  "spec"
                                ],
                                "additionalProperties": false
                              }
                            ],
                            "type": "object"
                          }
                        },
                        "onError": {
                          "type": "string",
                          "enum": [
                            "error",
                            "blank",
                            "keep"
                          ]
                        }
                      },
                      "required": [
                        "kind",
                        "id"
                      ],
                      "additionalProperties": false
                    }
                  },
                  "outputs": {
                    "minItems": 1,
                    "maxItems": 16,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "enum": [
                            "new",
                            "edit",
                            "edit_workbook"
                          ]
                        },
                        "id": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "sheets": {
                          "minItems": 1,
                          "maxItems": 64,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "name": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 31
                              },
                              "input": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 48,
                                "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                              }
                            },
                            "required": [
                              "name",
                              "input"
                            ],
                            "additionalProperties": false
                          }
                        },
                        "target": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "input": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 48,
                          "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                        },
                        "mode": {
                          "type": "string",
                          "enum": [
                            "changed_values",
                            "replace_values"
                          ]
                        },
                        "overwrite": {
                          "type": "boolean"
                        },
                        "changes": {
                          "minItems": 1,
                          "maxItems": 64,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "target": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 48,
                                "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                              },
                              "input": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 48,
                                "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
                              },
                              "mode": {
                                "type": "string",
                                "enum": [
                                  "changed_values",
                                  "replace_values"
                                ]
                              },
                              "overwrite": {
                                "default": false,
                                "type": "boolean"
                              }
                            },
                            "required": [
                              "target",
                              "input",
                              "mode"
                            ],
                            "additionalProperties": false
                          }
                        }
                      },
                      "required": [
                        "kind",
                        "id"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "steps",
                  "outputs"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "id",
              "group"
            ],
            "additionalProperties": false
          }
        },
        "finish": {
          "maxItems": 256,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "job": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
              },
              "output": {
                "type": "string",
                "minLength": 1,
                "maxLength": 48,
                "pattern": "^[A-Za-z][A-Za-z0-9_-]*$"
              },
              "changes": {
                "minItems": 1,
                "maxItems": 128,
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "enum": [
                        "format_cells",
                        "set_columns",
                        "set_rows",
                        "freeze_panes",
                        "set_sheet_visibility",
                        "set_print_layout",
                        "merge_cells",
                        "unmerge_cells",
                        "write_formula",
                        "fill_formula",
                        "create_table",
                        "edit_table",
                        "convert_table"
                      ]
                    },
                    "sheetName": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 31
                    },
                    "range": {
                      "type": "string",
                      "maxLength": 21,
                      "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
                    },
                    "style": {
                      "anyOf": [
                        {
                          "type": "object",
                          "properties": {
                            "numberFormat": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "minLength": 1,
                                  "maxLength": 255
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            },
                            "font": {
                              "anyOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "name": {
                                      "type": "string",
                                      "minLength": 1,
                                      "maxLength": 128
                                    },
                                    "size": {
                                      "type": "number",
                                      "minimum": 1,
                                      "maximum": 409
                                    },
                                    "bold": {
                                      "type": "boolean"
                                    },
                                    "italic": {
                                      "type": "boolean"
                                    },
                                    "underline": {
                                      "type": "boolean"
                                    },
                                    "strike": {
                                      "type": "boolean"
                                    },
                                    "color": {
                                      "type": "string",
                                      "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                                    }
                                  },
                                  "additionalProperties": false
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            },
                            "fill": {
                              "anyOf": [
                                {
                                  "type": "string",
                                  "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            },
                            "border": {
                              "anyOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "left": {
                                      "type": "object",
                                      "properties": {
                                        "style": {
                                          "type": "string",
                                          "enum": [
                                            "thin",
                                            "medium",
                                            "thick",
                                            "dashed",
                                            "dotted",
                                            "double",
                                            "hair",
                                            "none"
                                          ]
                                        },
                                        "color": {
                                          "type": "string",
                                          "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                                        }
                                      },
                                      "required": [
                                        "style"
                                      ],
                                      "additionalProperties": false
                                    },
                                    "right": {
                                      "type": "object",
                                      "properties": {
                                        "style": {
                                          "type": "string",
                                          "enum": [
                                            "thin",
                                            "medium",
                                            "thick",
                                            "dashed",
                                            "dotted",
                                            "double",
                                            "hair",
                                            "none"
                                          ]
                                        },
                                        "color": {
                                          "type": "string",
                                          "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                                        }
                                      },
                                      "required": [
                                        "style"
                                      ],
                                      "additionalProperties": false
                                    },
                                    "top": {
                                      "type": "object",
                                      "properties": {
                                        "style": {
                                          "type": "string",
                                          "enum": [
                                            "thin",
                                            "medium",
                                            "thick",
                                            "dashed",
                                            "dotted",
                                            "double",
                                            "hair",
                                            "none"
                                          ]
                                        },
                                        "color": {
                                          "type": "string",
                                          "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                                        }
                                      },
                                      "required": [
                                        "style"
                                      ],
                                      "additionalProperties": false
                                    },
                                    "bottom": {
                                      "type": "object",
                                      "properties": {
                                        "style": {
                                          "type": "string",
                                          "enum": [
                                            "thin",
                                            "medium",
                                            "thick",
                                            "dashed",
                                            "dotted",
                                            "double",
                                            "hair",
                                            "none"
                                          ]
                                        },
                                        "color": {
                                          "type": "string",
                                          "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                                        }
                                      },
                                      "required": [
                                        "style"
                                      ],
                                      "additionalProperties": false
                                    }
                                  },
                                  "additionalProperties": false
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            },
                            "alignment": {
                              "anyOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "horizontal": {
                                      "type": "string",
                                      "enum": [
                                        "general",
                                        "left",
                                        "center",
                                        "right",
                                        "fill",
                                        "justify",
                                        "centerContinuous",
                                        "distributed"
                                      ]
                                    },
                                    "vertical": {
                                      "type": "string",
                                      "enum": [
                                        "top",
                                        "center",
                                        "bottom",
                                        "justify",
                                        "distributed"
                                      ]
                                    },
                                    "wrapText": {
                                      "type": "boolean"
                                    }
                                  },
                                  "additionalProperties": false
                                },
                                {
                                  "type": "null"
                                }
                              ]
                            }
                          },
                          "additionalProperties": false
                        },
                        {
                          "type": "string",
                          "enum": [
                            "SezzleeBlue",
                            "none"
                          ]
                        }
                      ]
                    },
                    "first": {
                      "anyOf": [
                        {
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 16384
                        },
                        {
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 1048576
                        }
                      ]
                    },
                    "last": {
                      "anyOf": [
                        {
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 16384
                        },
                        {
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 1048576
                        }
                      ]
                    },
                    "width": {
                      "anyOf": [
                        {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 255
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "hidden": {
                      "type": "boolean"
                    },
                    "height": {
                      "anyOf": [
                        {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 409
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "rows": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 1048575
                    },
                    "columns": {
                      "anyOf": [
                        {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 16383
                        },
                        {
                          "maxItems": 1024,
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "column": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 255
                              },
                              "name": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": 255
                              }
                            },
                            "required": [
                              "column",
                              "name"
                            ],
                            "additionalProperties": false
                          }
                        }
                      ]
                    },
                    "state": {
                      "type": "string",
                      "enum": [
                        "visible",
                        "hidden",
                        "veryHidden"
                      ]
                    },
                    "orientation": {
                      "type": "string",
                      "enum": [
                        "portrait",
                        "landscape"
                      ]
                    },
                    "paper": {
                      "type": "string",
                      "enum": [
                        "A4",
                        "letter",
                        "legal"
                      ]
                    },
                    "margins": {
                      "type": "object",
                      "properties": {
                        "left": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 10
                        },
                        "right": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 10
                        },
                        "top": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 10
                        },
                        "bottom": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 10
                        },
                        "header": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 10
                        },
                        "footer": {
                          "type": "number",
                          "minimum": 0,
                          "maximum": 10
                        }
                      },
                      "required": [
                        "left",
                        "right",
                        "top",
                        "bottom",
                        "header",
                        "footer"
                      ],
                      "additionalProperties": false
                    },
                    "fitWidth": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 32767
                    },
                    "fitHeight": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 32767
                    },
                    "scale": {
                      "type": "integer",
                      "minimum": 10,
                      "maximum": 400
                    },
                    "printArea": {
                      "anyOf": [
                        {
                          "type": "string",
                          "maxLength": 21,
                          "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "titleRows": {
                      "anyOf": [
                        {
                          "type": "object",
                          "properties": {
                            "first": {
                              "type": "integer",
                              "minimum": 1,
                              "maximum": 1048576
                            },
                            "last": {
                              "type": "integer",
                              "minimum": 1,
                              "maximum": 1048576
                            }
                          },
                          "required": [
                            "first",
                            "last"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "titleColumns": {
                      "anyOf": [
                        {
                          "type": "object",
                          "properties": {
                            "first": {
                              "type": "integer",
                              "minimum": 1,
                              "maximum": 16384
                            },
                            "last": {
                              "type": "integer",
                              "minimum": 1,
                              "maximum": 16384
                            }
                          },
                          "required": [
                            "first",
                            "last"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "loss": {
                      "type": "string",
                      "enum": [
                        "reject",
                        "discard_non_anchor"
                      ]
                    },
                    "cell": {
                      "type": "string",
                      "maxLength": 21,
                      "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
                    },
                    "formula": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 8192
                    },
                    "overwrite": {
                      "type": "boolean"
                    },
                    "anchor": {
                      "type": "string",
                      "maxLength": 21,
                      "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
                    },
                    "name": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 255,
                      "pattern": "^[\\p{L}_\\\\][\\p{L}\\p{N}_.\\\\]*$"
                    },
                    "filter": {
                      "type": "boolean"
                    },
                    "totals": {
                      "anyOf": [
                        {
                          "maxItems": 1024,
                          "type": "array",
                          "items": {
                            "oneOf": [
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "label"
                                  },
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 255
                                  },
                                  "text": {
                                    "type": "string",
                                    "maxLength": 255
                                  }
                                },
                                "required": [
                                  "kind",
                                  "column",
                                  "text"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "function"
                                  },
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 255
                                  },
                                  "function": {
                                    "type": "string",
                                    "enum": [
                                      "sum",
                                      "average",
                                      "count",
                                      "countNums",
                                      "min",
                                      "max",
                                      "stdDev",
                                      "var"
                                    ]
                                  }
                                },
                                "required": [
                                  "kind",
                                  "column",
                                  "function"
                                ],
                                "additionalProperties": false
                              },
                              {
                                "type": "object",
                                "properties": {
                                  "kind": {
                                    "type": "string",
                                    "const": "formula"
                                  },
                                  "column": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 255
                                  },
                                  "formula": {
                                    "type": "string",
                                    "minLength": 1,
                                    "maxLength": 8192
                                  }
                                },
                                "required": [
                                  "kind",
                                  "column",
                                  "formula"
                                ],
                                "additionalProperties": false
                              }
                            ]
                          }
                        },
                        {
                          "anyOf": [
                            {
                              "maxItems": 1024,
                              "type": "array",
                              "items": {
                                "oneOf": [
                                  {
                                    "type": "object",
                                    "properties": {
                                      "kind": {
                                        "type": "string",
                                        "const": "label"
                                      },
                                      "column": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 255
                                      },
                                      "text": {
                                        "type": "string",
                                        "maxLength": 255
                                      }
                                    },
                                    "required": [
                                      "kind",
                                      "column",
                                      "text"
                                    ],
                                    "additionalProperties": false
                                  },
                                  {
                                    "type": "object",
                                    "properties": {
                                      "kind": {
                                        "type": "string",
                                        "const": "function"
                                      },
                                      "column": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 255
                                      },
                                      "function": {
                                        "type": "string",
                                        "enum": [
                                          "sum",
                                          "average",
                                          "count",
                                          "countNums",
                                          "min",
                                          "max",
                                          "stdDev",
                                          "var"
                                        ]
                                      }
                                    },
                                    "required": [
                                      "kind",
                                      "column",
                                      "function"
                                    ],
                                    "additionalProperties": false
                                  },
                                  {
                                    "type": "object",
                                    "properties": {
                                      "kind": {
                                        "type": "string",
                                        "const": "formula"
                                      },
                                      "column": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 255
                                      },
                                      "formula": {
                                        "type": "string",
                                        "minLength": 1,
                                        "maxLength": 8192
                                      }
                                    },
                                    "required": [
                                      "kind",
                                      "column",
                                      "formula"
                                    ],
                                    "additionalProperties": false
                                  }
                                ]
                              }
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      ]
                    },
                    "calculatedColumns": {
                      "maxItems": 1024,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "column": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 255
                          },
                          "formula": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 8192
                          }
                        },
                        "required": [
                          "column",
                          "formula"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "tableName": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 255,
                      "pattern": "^[\\p{L}_\\\\][\\p{L}\\p{N}_.\\\\]*$"
                    },
                    "clearRemovedValues": {
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "kind",
                    "sheetName"
                  ],
                  "additionalProperties": false
                }
              }
            },
            "required": [
              "output",
              "changes"
            ],
            "additionalProperties": false
          }
        }
      },
      "required": [
        "kind"
      ],
      "additionalProperties": false
    }
  },
  "required": [
    "job"
  ],
  "additionalProperties": false
}
```

:::

## `get_bulk_job`

Read durable bulk completion by jobId without rerunning operations. Verifies the retained manifest and every completed output hash. Returns a complete dependent result, independent batch statuses, or not_found. Missing/changed retained output bytes are an error rather than a successful replay. Writing mode only; no source writes or recalculation.

Annotations: read-only, idempotent, closed world.

Available only with `--write <relative-output-directory>`. The registered JSON Schema below is the exact wire contract; nested operation variants are validated by the server.

:::details[Input JSON Schema]

```json
{
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "jobId": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    }
  },
  "required": [
    "jobId"
  ],
  "additionalProperties": false
}
```

:::

## `prepare_bulk`

Analyze complete version-pinned record selections for keyed_update or upsert without writing files. source and target contain filePath, versionId and selection {kind:records, sheetName, range or table, headerRow}; obtain versions from prepare_transfer or prior receipts. Select exactly one closed A1 range or named table, with an explicit positive headerRow. Target is an unfiltered complete .xlsx list; source can be .xlsx, .xlsm or CSV and use record filters/projection. operation has kind, keys and set arrays of {sourceColumn,targetColumn} using exact selected header names. Keys preserve types and case; no implicit trim/coercion. Empty or duplicate keys block; conflictPolicy currently only error. Key columns cannot be reassigned. Set overwrite:true to replace occupied target values. Upsert requires mapping every target column when inserting. Returns bounded counts/conflicts, exact versions and requestFingerprint, never records. Conflict record numbers are one-based positions in the selected records, not worksheet rows. Validation covers keys and target package policy only; executionAvailable:false describes this focused analysis. Use prepare_bulk_job/run_bulk_job for fully validated execution. Preparation never means a completed update or grants permission for changed sources. Writing mode only; no recalculation.

Annotations: read-only, idempotent, closed world.

Available only with `--write <relative-output-directory>`. The registered JSON Schema below is the exact wire contract; nested operation variants are validated by the server.

:::details[Input JSON Schema]

```json
{
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "source": {
      "type": "object",
      "properties": {
        "filePath": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32768
        },
        "versionId": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "selection": {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "records"
            },
            "sheetName": {
              "description": "Exact worksheet name; defaults to the first visible sheet.",
              "type": "string"
            },
            "range": {
              "type": "string",
              "maxLength": 21,
              "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}:[A-Za-z]{1,3}[1-9][0-9]{0,6}$"
            },
            "table": {
              "description": "Declared table name; selects its data rows. Not with range. XLSX only.",
              "type": "string",
              "minLength": 1,
              "maxLength": 255
            },
            "visibleOnly": {
              "description": "Skip saved hidden rows, AutoFilter's included. XLSX only.",
              "type": "boolean"
            },
            "headerRow": {
              "type": "integer",
              "minimum": 1,
              "maximum": 1048576
            },
            "columnMode": {
              "description": "Columns are named by header text or A1 letter: auto (default), header or letter.",
              "type": "string",
              "enum": [
                "auto",
                "header",
                "letter"
              ]
            },
            "caseSensitive": {
              "description": "Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.",
              "type": "boolean"
            },
            "columns": {
              "description": "How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues.",
              "minItems": 1,
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "column": {
                    "type": "string",
                    "description": "Header text or A1 letter."
                  },
                  "type": {
                    "type": "string",
                    "enum": [
                      "number",
                      "date",
                      "boolean",
                      "time",
                      "duration",
                      "text"
                    ],
                    "description": "How to read the column."
                  },
                  "missingValues": {
                    "description": "Missing-text tokens.",
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  },
                  "decimal": {
                    "description": "Decimal separator, for number.",
                    "type": "string",
                    "enum": [
                      ".",
                      ","
                    ]
                  },
                  "group": {
                    "description": "Thousands separator, for number.",
                    "type": "string",
                    "enum": [
                      "none",
                      ".",
                      ",",
                      " ",
                      "'"
                    ]
                  },
                  "locale": {
                    "description": "File locale, for number or date.",
                    "type": "string",
                    "minLength": 2,
                    "maxLength": 64
                  },
                  "numberingSystem": {
                    "description": "Numbering system, for number.",
                    "type": "string",
                    "minLength": 3,
                    "maxLength": 32
                  },
                  "identifiers": {
                    "description": "Whether to read digit identifiers, for number.",
                    "type": "string",
                    "enum": [
                      "refuse",
                      "read"
                    ]
                  },
                  "format": {
                    "description": "Date pattern such as dd.MM.yyyy, for date.",
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 64
                  },
                  "order": {
                    "description": "Day/month order without a format, for date.",
                    "type": "string",
                    "enum": [
                      "dmy",
                      "mdy"
                    ]
                  },
                  "trueValues": {
                    "description": "True-text tokens, for boolean.",
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  },
                  "falseValues": {
                    "description": "False-text tokens, for boolean.",
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  }
                },
                "required": [
                  "column",
                  "type"
                ],
                "additionalProperties": false
              }
            },
            "mergedCells": {
              "description": "Merged values and header detection policy, default master.",
              "type": "string",
              "enum": [
                "master",
                "repeat"
              ]
            },
            "delimiter": {
              "description": "CSV separator; sniffed when omitted.",
              "type": "string",
              "enum": [
                "comma",
                "semicolon",
                "tab",
                "pipe"
              ]
            },
            "encoding": {
              "description": "CSV encoding; BOM or utf-8 when omitted.",
              "type": "string",
              "enum": [
                "utf-8",
                "utf-16le",
                "utf-16be",
                "windows-1254",
                "iso-8859-9",
                "windows-1252",
                "windows-1251",
                "windows-1256",
                "shift_jis",
                "gb18030",
                "big5",
                "euc-kr"
              ]
            },
            "locale": {
              "description": "BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.",
              "type": "string",
              "minLength": 2,
              "maxLength": 64
            },
            "numberingSystem": {
              "description": "Numbering system such as arab; needs locale.",
              "type": "string",
              "minLength": 3,
              "maxLength": 32
            },
            "missingValues": {
              "description": "Missing-text tokens; default N/A, NULL, -, —, #N/A.",
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "trueValues": {
              "description": "True-text tokens; default true, yes, y, Evet, E.",
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "falseValues": {
              "description": "False-text tokens; default false, no, n, Hayır, H.",
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "selectColumns": {
              "minItems": 1,
              "maxItems": 16384,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 32767
              }
            },
            "where": {
              "maxItems": 16,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "column": {
                    "type": "string",
                    "description": "Header text or A1 letter."
                  },
                  "op": {
                    "type": "string",
                    "enum": [
                      "eq",
                      "ne",
                      "lt",
                      "lte",
                      "gt",
                      "gte",
                      "contains",
                      "startsWith",
                      "endsWith",
                      "in",
                      "between",
                      "isEmpty",
                      "isNotEmpty",
                      "isError",
                      "isNumber",
                      "isText"
                    ]
                  },
                  "value": {
                    "description": "Operand.",
                    "type": [
                      "string",
                      "number",
                      "boolean"
                    ]
                  },
                  "values": {
                    "description": "Operands of in, or [low, high] of between.",
                    "minItems": 1,
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": [
                        "string",
                        "number",
                        "boolean"
                      ]
                    }
                  }
                },
                "required": [
                  "column",
                  "op"
                ],
                "additionalProperties": false
              }
            },
            "match": {
              "default": "all",
              "type": "string",
              "enum": [
                "all",
                "any"
              ]
            },
            "scope": {
              "default": {
                "kind": "all"
              },
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "all"
                    }
                  },
                  "required": [
                    "kind"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "rows"
                    },
                    "rows": {
                      "minItems": 1,
                      "maxItems": 10000,
                      "type": "array",
                      "items": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 1048576
                      }
                    }
                  },
                  "required": [
                    "kind",
                    "rows"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "includeHeaders": {
              "default": false,
              "type": "boolean",
              "const": false
            }
          },
          "required": [
            "kind",
            "headerRow"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "filePath",
        "versionId",
        "selection"
      ],
      "additionalProperties": false
    },
    "target": {
      "type": "object",
      "properties": {
        "filePath": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32768
        },
        "versionId": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "selection": {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "records"
            },
            "sheetName": {
              "description": "Exact worksheet name; defaults to the first visible sheet.",
              "type": "string"
            },
            "range": {
              "type": "string",
              "maxLength": 21,
              "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}:[A-Za-z]{1,3}[1-9][0-9]{0,6}$"
            },
            "table": {
              "description": "Declared table name; selects its data rows. Not with range. XLSX only.",
              "type": "string",
              "minLength": 1,
              "maxLength": 255
            },
            "headerRow": {
              "type": "integer",
              "minimum": 1,
              "maximum": 1048576
            },
            "columnMode": {
              "description": "Columns are named by header text or A1 letter: auto (default), header or letter.",
              "type": "string",
              "enum": [
                "auto",
                "header",
                "letter"
              ]
            },
            "caseSensitive": {
              "description": "Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.",
              "type": "boolean"
            },
            "columns": {
              "description": "How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues.",
              "minItems": 1,
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "column": {
                    "type": "string",
                    "description": "Header text or A1 letter."
                  },
                  "type": {
                    "type": "string",
                    "enum": [
                      "number",
                      "date",
                      "boolean",
                      "time",
                      "duration",
                      "text"
                    ],
                    "description": "How to read the column."
                  },
                  "missingValues": {
                    "description": "Missing-text tokens.",
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  },
                  "decimal": {
                    "description": "Decimal separator, for number.",
                    "type": "string",
                    "enum": [
                      ".",
                      ","
                    ]
                  },
                  "group": {
                    "description": "Thousands separator, for number.",
                    "type": "string",
                    "enum": [
                      "none",
                      ".",
                      ",",
                      " ",
                      "'"
                    ]
                  },
                  "locale": {
                    "description": "File locale, for number or date.",
                    "type": "string",
                    "minLength": 2,
                    "maxLength": 64
                  },
                  "numberingSystem": {
                    "description": "Numbering system, for number.",
                    "type": "string",
                    "minLength": 3,
                    "maxLength": 32
                  },
                  "identifiers": {
                    "description": "Whether to read digit identifiers, for number.",
                    "type": "string",
                    "enum": [
                      "refuse",
                      "read"
                    ]
                  },
                  "format": {
                    "description": "Date pattern such as dd.MM.yyyy, for date.",
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 64
                  },
                  "order": {
                    "description": "Day/month order without a format, for date.",
                    "type": "string",
                    "enum": [
                      "dmy",
                      "mdy"
                    ]
                  },
                  "trueValues": {
                    "description": "True-text tokens, for boolean.",
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  },
                  "falseValues": {
                    "description": "False-text tokens, for boolean.",
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  }
                },
                "required": [
                  "column",
                  "type"
                ],
                "additionalProperties": false
              }
            },
            "mergedCells": {
              "description": "Merged values and header detection policy, default master.",
              "type": "string",
              "enum": [
                "master",
                "repeat"
              ]
            },
            "delimiter": {
              "description": "CSV separator; sniffed when omitted.",
              "type": "string",
              "enum": [
                "comma",
                "semicolon",
                "tab",
                "pipe"
              ]
            },
            "encoding": {
              "description": "CSV encoding; BOM or utf-8 when omitted.",
              "type": "string",
              "enum": [
                "utf-8",
                "utf-16le",
                "utf-16be",
                "windows-1254",
                "iso-8859-9",
                "windows-1252",
                "windows-1251",
                "windows-1256",
                "shift_jis",
                "gb18030",
                "big5",
                "euc-kr"
              ]
            },
            "locale": {
              "description": "BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.",
              "type": "string",
              "minLength": 2,
              "maxLength": 64
            },
            "numberingSystem": {
              "description": "Numbering system such as arab; needs locale.",
              "type": "string",
              "minLength": 3,
              "maxLength": 32
            },
            "missingValues": {
              "description": "Missing-text tokens; default N/A, NULL, -, —, #N/A.",
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "trueValues": {
              "description": "True-text tokens; default true, yes, y, Evet, E.",
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "falseValues": {
              "description": "False-text tokens; default false, no, n, Hayır, H.",
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "includeHeaders": {
              "default": false,
              "type": "boolean",
              "const": false
            },
            "match": {
              "default": "all",
              "type": "string",
              "const": "all"
            },
            "scope": {
              "default": {
                "kind": "all"
              },
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "all"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            }
          },
          "required": [
            "kind",
            "headerRow"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "filePath",
        "versionId",
        "selection"
      ],
      "additionalProperties": false
    },
    "operation": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "keyed_update"
            },
            "keys": {
              "minItems": 1,
              "maxItems": 16,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "sourceColumn": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 32767
                  },
                  "targetColumn": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 32767
                  }
                },
                "required": [
                  "sourceColumn",
                  "targetColumn"
                ],
                "additionalProperties": false
              }
            },
            "set": {
              "minItems": 1,
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "sourceColumn": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 32767
                  },
                  "targetColumn": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 32767
                  }
                },
                "required": [
                  "sourceColumn",
                  "targetColumn"
                ],
                "additionalProperties": false
              }
            },
            "conflictPolicy": {
              "default": "error",
              "type": "string",
              "const": "error"
            },
            "overwrite": {
              "default": false,
              "type": "boolean"
            }
          },
          "required": [
            "kind",
            "keys",
            "set"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "upsert"
            },
            "keys": {
              "minItems": 1,
              "maxItems": 16,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "sourceColumn": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 32767
                  },
                  "targetColumn": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 32767
                  }
                },
                "required": [
                  "sourceColumn",
                  "targetColumn"
                ],
                "additionalProperties": false
              }
            },
            "set": {
              "minItems": 1,
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "sourceColumn": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 32767
                  },
                  "targetColumn": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 32767
                  }
                },
                "required": [
                  "sourceColumn",
                  "targetColumn"
                ],
                "additionalProperties": false
              }
            },
            "conflictPolicy": {
              "default": "error",
              "type": "string",
              "const": "error"
            },
            "overwrite": {
              "default": false,
              "type": "boolean"
            }
          },
          "required": [
            "kind",
            "keys",
            "set"
          ],
          "additionalProperties": false
        }
      ],
      "type": "object"
    }
  },
  "required": [
    "source",
    "target",
    "operation"
  ],
  "additionalProperties": false
}
```

:::

## `prepare_edit`

Inspect an ordered edit request without publishing an output. Accept .xlsx filePath, optional expectedVersion, and changes. Returns exact source {filePath, versionId}, a fingerprint binding normalized changes, source feature counts, and ready or blocked with policy reasons. Pass source and the same changes to edit_workbook. Canonical and preservation-supported external workbooks can be ready. Supports scalar, sheet, copy/move and row/column edits, plus edit_workbook formatting/layout/formula/table authoring. Copy requires explicit values/formulas/formatting/all mode. No source file is changed. Enabled protection, macros, signatures, Strict markup or unsupported affected dependencies refuse editing. Preparation is not permission to edit changed bytes. No recalculation occurs. Table ranges include the header and requested totals row. A real calculated column uses calculatedColumns:[{column:"Amount",formula:"[@Qty]*[@Price]"}]; filling cells alone does not define table calculated-column metadata. Bare Qty*Price refers to defined names. Totals labels are explicit, for example totals:[{kind:"label",column:"Item",text:"Total"},{kind:"function",column:"Amount",function:"sum"}]; a sum function does not create a Total label automatically.

Annotations: read-only, idempotent, closed world.

Available only with `--write <relative-output-directory>`. The registered JSON Schema below is the exact wire contract; nested operation variants are validated by the server.

:::details[Input JSON Schema]

```json
{
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "maxLength": 32768
    },
    "expectedVersion": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    },
    "changes": {
      "minItems": 1,
      "maxItems": 128,
      "type": "array",
      "items": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "add_sheet"
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              }
            },
            "required": [
              "kind",
              "name"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "startCell": {
                "type": "string",
                "minLength": 2,
                "maxLength": 10,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}$"
              },
              "values": {
                "minItems": 1,
                "maxItems": 1000000,
                "type": "array",
                "items": {
                  "minItems": 1,
                  "maxItems": 16384,
                  "type": "array",
                  "items": {
                    "oneOf": [
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "text"
                          },
                          "value": {
                            "type": "string",
                            "maxLength": 32767
                          }
                        },
                        "required": [
                          "kind",
                          "value"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "number"
                          },
                          "value": {
                            "type": "number"
                          }
                        },
                        "required": [
                          "kind",
                          "value"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "boolean"
                          },
                          "value": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "kind",
                          "value"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "blank"
                          }
                        },
                        "required": [
                          "kind"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "date"
                          },
                          "value": {
                            "type": "string",
                            "minLength": 10,
                            "format": "date",
                            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
                          }
                        },
                        "required": [
                          "kind",
                          "value"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "datetime"
                          },
                          "value": {
                            "type": "string",
                            "allOf": [
                              {
                                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z)|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"
                              },
                              {
                                "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?$"
                              }
                            ]
                          }
                        },
                        "required": [
                          "kind",
                          "value"
                        ],
                        "additionalProperties": false
                      }
                    ]
                  }
                }
              },
              "kind": {
                "type": "string",
                "const": "write_cells"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "overwrite": {
                "default": false,
                "type": "boolean"
              }
            },
            "required": [
              "startCell",
              "values",
              "kind",
              "sheetName"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "format_cells"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "range": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "style": {
                "type": "object",
                "properties": {
                  "numberFormat": {
                    "anyOf": [
                      {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 255
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "font": {
                    "anyOf": [
                      {
                        "type": "object",
                        "properties": {
                          "name": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 128
                          },
                          "size": {
                            "type": "number",
                            "minimum": 1,
                            "maximum": 409
                          },
                          "bold": {
                            "type": "boolean"
                          },
                          "italic": {
                            "type": "boolean"
                          },
                          "underline": {
                            "type": "boolean"
                          },
                          "strike": {
                            "type": "boolean"
                          },
                          "color": {
                            "type": "string",
                            "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                          }
                        },
                        "additionalProperties": false
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "fill": {
                    "anyOf": [
                      {
                        "type": "string",
                        "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "border": {
                    "anyOf": [
                      {
                        "type": "object",
                        "properties": {
                          "left": {
                            "type": "object",
                            "properties": {
                              "style": {
                                "type": "string",
                                "enum": [
                                  "thin",
                                  "medium",
                                  "thick",
                                  "dashed",
                                  "dotted",
                                  "double",
                                  "hair",
                                  "none"
                                ]
                              },
                              "color": {
                                "type": "string",
                                "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                              }
                            },
                            "required": [
                              "style"
                            ],
                            "additionalProperties": false
                          },
                          "right": {
                            "type": "object",
                            "properties": {
                              "style": {
                                "type": "string",
                                "enum": [
                                  "thin",
                                  "medium",
                                  "thick",
                                  "dashed",
                                  "dotted",
                                  "double",
                                  "hair",
                                  "none"
                                ]
                              },
                              "color": {
                                "type": "string",
                                "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                              }
                            },
                            "required": [
                              "style"
                            ],
                            "additionalProperties": false
                          },
                          "top": {
                            "type": "object",
                            "properties": {
                              "style": {
                                "type": "string",
                                "enum": [
                                  "thin",
                                  "medium",
                                  "thick",
                                  "dashed",
                                  "dotted",
                                  "double",
                                  "hair",
                                  "none"
                                ]
                              },
                              "color": {
                                "type": "string",
                                "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                              }
                            },
                            "required": [
                              "style"
                            ],
                            "additionalProperties": false
                          },
                          "bottom": {
                            "type": "object",
                            "properties": {
                              "style": {
                                "type": "string",
                                "enum": [
                                  "thin",
                                  "medium",
                                  "thick",
                                  "dashed",
                                  "dotted",
                                  "double",
                                  "hair",
                                  "none"
                                ]
                              },
                              "color": {
                                "type": "string",
                                "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                              }
                            },
                            "required": [
                              "style"
                            ],
                            "additionalProperties": false
                          }
                        },
                        "additionalProperties": false
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "alignment": {
                    "anyOf": [
                      {
                        "type": "object",
                        "properties": {
                          "horizontal": {
                            "type": "string",
                            "enum": [
                              "general",
                              "left",
                              "center",
                              "right",
                              "fill",
                              "justify",
                              "centerContinuous",
                              "distributed"
                            ]
                          },
                          "vertical": {
                            "type": "string",
                            "enum": [
                              "top",
                              "center",
                              "bottom",
                              "justify",
                              "distributed"
                            ]
                          },
                          "wrapText": {
                            "type": "boolean"
                          }
                        },
                        "additionalProperties": false
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "additionalProperties": false
              }
            },
            "required": [
              "kind",
              "sheetName",
              "range",
              "style"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "set_columns"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "first": {
                "type": "integer",
                "minimum": 1,
                "maximum": 16384
              },
              "last": {
                "type": "integer",
                "minimum": 1,
                "maximum": 16384
              },
              "width": {
                "anyOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 255
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "hidden": {
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "first",
              "last"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "set_rows"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "first": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1048576
              },
              "last": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1048576
              },
              "height": {
                "anyOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 409
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "hidden": {
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "first",
              "last"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "freeze_panes"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "rows": {
                "type": "integer",
                "minimum": 0,
                "maximum": 1048575
              },
              "columns": {
                "type": "integer",
                "minimum": 0,
                "maximum": 16383
              }
            },
            "required": [
              "kind",
              "sheetName",
              "rows",
              "columns"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "set_sheet_visibility"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "state": {
                "type": "string",
                "enum": [
                  "visible",
                  "hidden",
                  "veryHidden"
                ]
              }
            },
            "required": [
              "kind",
              "sheetName",
              "state"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "set_print_layout"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "orientation": {
                "type": "string",
                "enum": [
                  "portrait",
                  "landscape"
                ]
              },
              "paper": {
                "type": "string",
                "enum": [
                  "A4",
                  "letter",
                  "legal"
                ]
              },
              "margins": {
                "type": "object",
                "properties": {
                  "left": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 10
                  },
                  "right": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 10
                  },
                  "top": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 10
                  },
                  "bottom": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 10
                  },
                  "header": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 10
                  },
                  "footer": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 10
                  }
                },
                "required": [
                  "left",
                  "right",
                  "top",
                  "bottom",
                  "header",
                  "footer"
                ],
                "additionalProperties": false
              },
              "fitWidth": {
                "type": "integer",
                "minimum": 0,
                "maximum": 32767
              },
              "fitHeight": {
                "type": "integer",
                "minimum": 0,
                "maximum": 32767
              },
              "scale": {
                "type": "integer",
                "minimum": 10,
                "maximum": 400
              },
              "printArea": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 21,
                    "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "titleRows": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "first": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 1048576
                      },
                      "last": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 1048576
                      }
                    },
                    "required": [
                      "first",
                      "last"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "titleColumns": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "first": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 16384
                      },
                      "last": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 16384
                      }
                    },
                    "required": [
                      "first",
                      "last"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "kind",
              "sheetName"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "merge_cells"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "range": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "loss": {
                "default": "reject",
                "type": "string",
                "enum": [
                  "reject",
                  "discard_non_anchor"
                ]
              }
            },
            "required": [
              "kind",
              "sheetName",
              "range"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "unmerge_cells"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "range": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "range"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "write_formula"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "cell": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "formula": {
                "type": "string",
                "minLength": 1,
                "maxLength": 8192
              },
              "overwrite": {
                "default": false,
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "cell",
              "formula"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "fill_formula"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "anchor": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "range": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "formula": {
                "type": "string",
                "minLength": 1,
                "maxLength": 8192
              },
              "overwrite": {
                "default": false,
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "anchor",
              "range",
              "formula"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "create_table"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "range": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255,
                "pattern": "^[\\p{L}_\\\\][\\p{L}\\p{N}_.\\\\]*$"
              },
              "style": {
                "default": "SezzleeBlue",
                "type": "string",
                "enum": [
                  "SezzleeBlue",
                  "none"
                ]
              },
              "filter": {
                "default": true,
                "type": "boolean"
              },
              "totals": {
                "maxItems": 1024,
                "type": "array",
                "items": {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "label"
                        },
                        "column": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 255
                        },
                        "text": {
                          "type": "string",
                          "maxLength": 255
                        }
                      },
                      "required": [
                        "kind",
                        "column",
                        "text"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "function"
                        },
                        "column": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 255
                        },
                        "function": {
                          "type": "string",
                          "enum": [
                            "sum",
                            "average",
                            "count",
                            "countNums",
                            "min",
                            "max",
                            "stdDev",
                            "var"
                          ]
                        }
                      },
                      "required": [
                        "kind",
                        "column",
                        "function"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "formula"
                        },
                        "column": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 255
                        },
                        "formula": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 8192
                        }
                      },
                      "required": [
                        "kind",
                        "column",
                        "formula"
                      ],
                      "additionalProperties": false
                    }
                  ]
                }
              },
              "calculatedColumns": {
                "maxItems": 1024,
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 255
                    },
                    "formula": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 8192
                    }
                  },
                  "required": [
                    "column",
                    "formula"
                  ],
                  "additionalProperties": false
                }
              },
              "overwrite": {
                "default": false,
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "range",
              "name"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "edit_table"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "tableName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255,
                "pattern": "^[\\p{L}_\\\\][\\p{L}\\p{N}_.\\\\]*$"
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255,
                "pattern": "^[\\p{L}_\\\\][\\p{L}\\p{N}_.\\\\]*$"
              },
              "range": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "columns": {
                "maxItems": 1024,
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 255
                    },
                    "name": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 255
                    }
                  },
                  "required": [
                    "column",
                    "name"
                  ],
                  "additionalProperties": false
                }
              },
              "totals": {
                "anyOf": [
                  {
                    "maxItems": 1024,
                    "type": "array",
                    "items": {
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "label"
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 255
                            },
                            "text": {
                              "type": "string",
                              "maxLength": 255
                            }
                          },
                          "required": [
                            "kind",
                            "column",
                            "text"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "function"
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 255
                            },
                            "function": {
                              "type": "string",
                              "enum": [
                                "sum",
                                "average",
                                "count",
                                "countNums",
                                "min",
                                "max",
                                "stdDev",
                                "var"
                              ]
                            }
                          },
                          "required": [
                            "kind",
                            "column",
                            "function"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "formula"
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 255
                            },
                            "formula": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 8192
                            }
                          },
                          "required": [
                            "kind",
                            "column",
                            "formula"
                          ],
                          "additionalProperties": false
                        }
                      ]
                    }
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "style": {
                "type": "string",
                "enum": [
                  "SezzleeBlue",
                  "none"
                ]
              },
              "filter": {
                "type": "boolean"
              },
              "calculatedColumns": {
                "maxItems": 1024,
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 255
                    },
                    "formula": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 8192
                    }
                  },
                  "required": [
                    "column",
                    "formula"
                  ],
                  "additionalProperties": false
                }
              },
              "clearRemovedValues": {
                "default": false,
                "type": "boolean"
              },
              "overwrite": {
                "default": false,
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "tableName"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "convert_table"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "tableName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255,
                "pattern": "^[\\p{L}_\\\\][\\p{L}\\p{N}_.\\\\]*$"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "tableName"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "clear_contents"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "range": {
                "type": "string",
                "minLength": 2,
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "range"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "rename_sheet"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              }
            },
            "required": [
              "kind",
              "sheetName",
              "name"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "reorder_sheet"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "position": {
                "type": "integer",
                "minimum": 1,
                "maximum": 64
              }
            },
            "required": [
              "kind",
              "sheetName",
              "position"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "delete_sheet"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              }
            },
            "required": [
              "kind",
              "sheetName"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "copy_sheet"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "mode": {
                "type": "string",
                "enum": [
                  "values",
                  "formulas",
                  "formatting",
                  "all"
                ]
              },
              "from": {
                "type": "object",
                "properties": {
                  "filePath": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 32768
                  },
                  "versionId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "filePath",
                  "versionId"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "kind",
              "sheetName",
              "name",
              "mode"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "copy_range"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "range": {
                "type": "string",
                "minLength": 2,
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "targetSheet": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "startCell": {
                "type": "string",
                "minLength": 2,
                "maxLength": 10
              },
              "mode": {
                "type": "string",
                "enum": [
                  "values",
                  "formulas",
                  "formatting",
                  "all"
                ]
              },
              "overwrite": {
                "default": false,
                "type": "boolean"
              },
              "from": {
                "type": "object",
                "properties": {
                  "filePath": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 32768
                  },
                  "versionId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "filePath",
                  "versionId"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "kind",
              "sheetName",
              "range",
              "targetSheet",
              "startCell",
              "mode"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "move_range"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "range": {
                "type": "string",
                "minLength": 2,
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "targetSheet": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "startCell": {
                "type": "string",
                "minLength": 2,
                "maxLength": 10
              },
              "overwrite": {
                "default": false,
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "range",
              "targetSheet",
              "startCell"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "insert_rows"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "at": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1048576
              },
              "count": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1000000
              }
            },
            "required": [
              "kind",
              "sheetName",
              "at",
              "count"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "delete_rows"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "at": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1048576
              },
              "count": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1000000
              }
            },
            "required": [
              "kind",
              "sheetName",
              "at",
              "count"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "insert_columns"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "at": {
                "type": "integer",
                "minimum": 1,
                "maximum": 16384
              },
              "count": {
                "type": "integer",
                "minimum": 1,
                "maximum": 16384
              }
            },
            "required": [
              "kind",
              "sheetName",
              "at",
              "count"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "delete_columns"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "at": {
                "type": "integer",
                "minimum": 1,
                "maximum": 16384
              },
              "count": {
                "type": "integer",
                "minimum": 1,
                "maximum": 16384
              }
            },
            "required": [
              "kind",
              "sheetName",
              "at",
              "count"
            ],
            "additionalProperties": false
          }
        ]
      }
    }
  },
  "required": [
    "filePath",
    "changes"
  ],
  "additionalProperties": false
}
```

:::

## `prepare_transfer`

Prepare a complete version-pinned value selection from an .xlsx, .xlsm or CSV without returning its cells. selection must be a JSON object, never a JSON-encoded string: for example {"kind":"range","sheetName":"Sheet1","range":"A1:C5","headerRow":0}. Returns transfer {source, selection} and exact scope/counts; pass transfer unchanged to transfer_data. range preserves its rectangle; records filters complete data rows and can project/reorder selectColumns, includeHeaders or select explicit physical rows with scope {kind: rows, rows: [...]}. Default scope all includes every matching record even if a previous read showed only a preview. Set headerRow: 0 explicitly when there is no header row, so the first record is retained. Record filters use where as an array of {column, op, value}, for example [{column: Amount, op: gte, value: 100}]. For boolean equality use op: eq and a boolean true/false value; filter and equals are not argument names. scope rows contains one-based physical rows, not zero-based indexes. aggregate uses metrics such as [{fn: count}]; omit groupBy for one total and use where for record conditions. aggregate exports a complete grouped summary with headers. Columns are interpreted only when explicit columns specifications request it. Values only: formulas contribute saved results, never recalculated; missing formula caches and unsupported/lossy values fail. No formula/style copying. Available only in explicit writing mode. The source is unchanged.

Annotations: read-only, idempotent, closed world.

Available only with `--write <relative-output-directory>`. The registered JSON Schema below is the exact wire contract; nested operation variants are validated by the server.

:::details[Input JSON Schema]

```json
{
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "maxLength": 32768
    },
    "selection": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "range"
            },
            "sheetName": {
              "description": "Exact worksheet name; defaults to the first visible sheet.",
              "type": "string"
            },
            "range": {
              "description": "A1 range such as A1:H500, B:D or 2:40, including the header row. Defaults to the used range.",
              "type": "string"
            },
            "table": {
              "description": "Declared table name; selects its data rows. Not with range. XLSX only.",
              "type": "string",
              "minLength": 1,
              "maxLength": 255
            },
            "visibleOnly": {
              "description": "Skip saved hidden rows, AutoFilter's included. XLSX only.",
              "type": "boolean"
            },
            "headerRow": {
              "description": "Header row, 0 for none. Omitted: a table or autofilter header, else the first top row naming its columns in text above any data, else row 1.",
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "columnMode": {
              "description": "Columns are named by header text or A1 letter: auto (default), header or letter.",
              "type": "string",
              "enum": [
                "auto",
                "header",
                "letter"
              ]
            },
            "caseSensitive": {
              "description": "Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.",
              "type": "boolean"
            },
            "columns": {
              "description": "How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues.",
              "minItems": 1,
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "column": {
                    "type": "string",
                    "description": "Header text or A1 letter."
                  },
                  "type": {
                    "type": "string",
                    "enum": [
                      "number",
                      "date",
                      "boolean",
                      "time",
                      "duration",
                      "text"
                    ],
                    "description": "How to read the column."
                  },
                  "missingValues": {
                    "description": "Missing-text tokens.",
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  },
                  "decimal": {
                    "description": "Decimal separator, for number.",
                    "type": "string",
                    "enum": [
                      ".",
                      ","
                    ]
                  },
                  "group": {
                    "description": "Thousands separator, for number.",
                    "type": "string",
                    "enum": [
                      "none",
                      ".",
                      ",",
                      " ",
                      "'"
                    ]
                  },
                  "locale": {
                    "description": "File locale, for number or date.",
                    "type": "string",
                    "minLength": 2,
                    "maxLength": 64
                  },
                  "numberingSystem": {
                    "description": "Numbering system, for number.",
                    "type": "string",
                    "minLength": 3,
                    "maxLength": 32
                  },
                  "identifiers": {
                    "description": "Whether to read digit identifiers, for number.",
                    "type": "string",
                    "enum": [
                      "refuse",
                      "read"
                    ]
                  },
                  "format": {
                    "description": "Date pattern such as dd.MM.yyyy, for date.",
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 64
                  },
                  "order": {
                    "description": "Day/month order without a format, for date.",
                    "type": "string",
                    "enum": [
                      "dmy",
                      "mdy"
                    ]
                  },
                  "trueValues": {
                    "description": "True-text tokens, for boolean.",
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  },
                  "falseValues": {
                    "description": "False-text tokens, for boolean.",
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  }
                },
                "required": [
                  "column",
                  "type"
                ],
                "additionalProperties": false
              }
            },
            "mergedCells": {
              "description": "Merged values and header detection policy, default master.",
              "type": "string",
              "enum": [
                "master",
                "repeat"
              ]
            },
            "delimiter": {
              "description": "CSV separator; sniffed when omitted.",
              "type": "string",
              "enum": [
                "comma",
                "semicolon",
                "tab",
                "pipe"
              ]
            },
            "encoding": {
              "description": "CSV encoding; BOM or utf-8 when omitted.",
              "type": "string",
              "enum": [
                "utf-8",
                "utf-16le",
                "utf-16be",
                "windows-1254",
                "iso-8859-9",
                "windows-1252",
                "windows-1251",
                "windows-1256",
                "shift_jis",
                "gb18030",
                "big5",
                "euc-kr"
              ]
            },
            "locale": {
              "description": "BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.",
              "type": "string",
              "minLength": 2,
              "maxLength": 64
            },
            "numberingSystem": {
              "description": "Numbering system such as arab; needs locale.",
              "type": "string",
              "minLength": 3,
              "maxLength": 32
            },
            "missingValues": {
              "description": "Missing-text tokens; default N/A, NULL, -, —, #N/A.",
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "trueValues": {
              "description": "True-text tokens; default true, yes, y, Evet, E.",
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "falseValues": {
              "description": "False-text tokens; default false, no, n, Hayır, H.",
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "selectColumns": {
              "minItems": 1,
              "maxItems": 16384,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 32767
              }
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "records"
            },
            "sheetName": {
              "description": "Exact worksheet name; defaults to the first visible sheet.",
              "type": "string"
            },
            "range": {
              "description": "A1 range such as A1:H500, B:D or 2:40, including the header row. Defaults to the used range.",
              "type": "string"
            },
            "table": {
              "description": "Declared table name; selects its data rows. Not with range. XLSX only.",
              "type": "string",
              "minLength": 1,
              "maxLength": 255
            },
            "visibleOnly": {
              "description": "Skip saved hidden rows, AutoFilter's included. XLSX only.",
              "type": "boolean"
            },
            "headerRow": {
              "description": "Header row, 0 for none. Omitted: a table or autofilter header, else the first top row naming its columns in text above any data, else row 1.",
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "columnMode": {
              "description": "Columns are named by header text or A1 letter: auto (default), header or letter.",
              "type": "string",
              "enum": [
                "auto",
                "header",
                "letter"
              ]
            },
            "caseSensitive": {
              "description": "Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.",
              "type": "boolean"
            },
            "columns": {
              "description": "How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues.",
              "minItems": 1,
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "column": {
                    "type": "string",
                    "description": "Header text or A1 letter."
                  },
                  "type": {
                    "type": "string",
                    "enum": [
                      "number",
                      "date",
                      "boolean",
                      "time",
                      "duration",
                      "text"
                    ],
                    "description": "How to read the column."
                  },
                  "missingValues": {
                    "description": "Missing-text tokens.",
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  },
                  "decimal": {
                    "description": "Decimal separator, for number.",
                    "type": "string",
                    "enum": [
                      ".",
                      ","
                    ]
                  },
                  "group": {
                    "description": "Thousands separator, for number.",
                    "type": "string",
                    "enum": [
                      "none",
                      ".",
                      ",",
                      " ",
                      "'"
                    ]
                  },
                  "locale": {
                    "description": "File locale, for number or date.",
                    "type": "string",
                    "minLength": 2,
                    "maxLength": 64
                  },
                  "numberingSystem": {
                    "description": "Numbering system, for number.",
                    "type": "string",
                    "minLength": 3,
                    "maxLength": 32
                  },
                  "identifiers": {
                    "description": "Whether to read digit identifiers, for number.",
                    "type": "string",
                    "enum": [
                      "refuse",
                      "read"
                    ]
                  },
                  "format": {
                    "description": "Date pattern such as dd.MM.yyyy, for date.",
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 64
                  },
                  "order": {
                    "description": "Day/month order without a format, for date.",
                    "type": "string",
                    "enum": [
                      "dmy",
                      "mdy"
                    ]
                  },
                  "trueValues": {
                    "description": "True-text tokens, for boolean.",
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  },
                  "falseValues": {
                    "description": "False-text tokens, for boolean.",
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  }
                },
                "required": [
                  "column",
                  "type"
                ],
                "additionalProperties": false
              }
            },
            "mergedCells": {
              "description": "Merged values and header detection policy, default master.",
              "type": "string",
              "enum": [
                "master",
                "repeat"
              ]
            },
            "delimiter": {
              "description": "CSV separator; sniffed when omitted.",
              "type": "string",
              "enum": [
                "comma",
                "semicolon",
                "tab",
                "pipe"
              ]
            },
            "encoding": {
              "description": "CSV encoding; BOM or utf-8 when omitted.",
              "type": "string",
              "enum": [
                "utf-8",
                "utf-16le",
                "utf-16be",
                "windows-1254",
                "iso-8859-9",
                "windows-1252",
                "windows-1251",
                "windows-1256",
                "shift_jis",
                "gb18030",
                "big5",
                "euc-kr"
              ]
            },
            "locale": {
              "description": "BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.",
              "type": "string",
              "minLength": 2,
              "maxLength": 64
            },
            "numberingSystem": {
              "description": "Numbering system such as arab; needs locale.",
              "type": "string",
              "minLength": 3,
              "maxLength": 32
            },
            "missingValues": {
              "description": "Missing-text tokens; default N/A, NULL, -, —, #N/A.",
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "trueValues": {
              "description": "True-text tokens; default true, yes, y, Evet, E.",
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "falseValues": {
              "description": "False-text tokens; default false, no, n, Hayır, H.",
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "selectColumns": {
              "minItems": 1,
              "maxItems": 16384,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 32767
              }
            },
            "where": {
              "maxItems": 16,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "column": {
                    "type": "string",
                    "description": "Header text or A1 letter."
                  },
                  "op": {
                    "type": "string",
                    "enum": [
                      "eq",
                      "ne",
                      "lt",
                      "lte",
                      "gt",
                      "gte",
                      "contains",
                      "startsWith",
                      "endsWith",
                      "in",
                      "between",
                      "isEmpty",
                      "isNotEmpty",
                      "isError",
                      "isNumber",
                      "isText"
                    ]
                  },
                  "value": {
                    "description": "Operand.",
                    "type": [
                      "string",
                      "number",
                      "boolean"
                    ]
                  },
                  "values": {
                    "description": "Operands of in, or [low, high] of between.",
                    "minItems": 1,
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": [
                        "string",
                        "number",
                        "boolean"
                      ]
                    }
                  }
                },
                "required": [
                  "column",
                  "op"
                ],
                "additionalProperties": false
              }
            },
            "match": {
              "default": "all",
              "type": "string",
              "enum": [
                "all",
                "any"
              ]
            },
            "scope": {
              "default": {
                "kind": "all"
              },
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "all"
                    }
                  },
                  "required": [
                    "kind"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "rows"
                    },
                    "rows": {
                      "minItems": 1,
                      "maxItems": 10000,
                      "type": "array",
                      "items": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 1048576
                      }
                    }
                  },
                  "required": [
                    "kind",
                    "rows"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "includeHeaders": {
              "default": true,
              "type": "boolean"
            }
          },
          "required": [
            "kind"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "aggregate"
            },
            "sheetName": {
              "description": "Exact worksheet name; defaults to the first visible sheet.",
              "type": "string"
            },
            "range": {
              "description": "A1 range such as A1:H500, B:D or 2:40, including the header row. Defaults to the used range.",
              "type": "string"
            },
            "table": {
              "description": "Declared table name; selects its data rows. Not with range. XLSX only.",
              "type": "string",
              "minLength": 1,
              "maxLength": 255
            },
            "visibleOnly": {
              "description": "Skip saved hidden rows, AutoFilter's included. XLSX only.",
              "type": "boolean"
            },
            "headerRow": {
              "description": "Header row, 0 for none. Omitted: a table or autofilter header, else the first top row naming its columns in text above any data, else row 1.",
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "columnMode": {
              "description": "Columns are named by header text or A1 letter: auto (default), header or letter.",
              "type": "string",
              "enum": [
                "auto",
                "header",
                "letter"
              ]
            },
            "caseSensitive": {
              "description": "Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.",
              "type": "boolean"
            },
            "columns": {
              "description": "How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues.",
              "minItems": 1,
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "column": {
                    "type": "string",
                    "description": "Header text or A1 letter."
                  },
                  "type": {
                    "type": "string",
                    "enum": [
                      "number",
                      "date",
                      "boolean",
                      "time",
                      "duration",
                      "text"
                    ],
                    "description": "How to read the column."
                  },
                  "missingValues": {
                    "description": "Missing-text tokens.",
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  },
                  "decimal": {
                    "description": "Decimal separator, for number.",
                    "type": "string",
                    "enum": [
                      ".",
                      ","
                    ]
                  },
                  "group": {
                    "description": "Thousands separator, for number.",
                    "type": "string",
                    "enum": [
                      "none",
                      ".",
                      ",",
                      " ",
                      "'"
                    ]
                  },
                  "locale": {
                    "description": "File locale, for number or date.",
                    "type": "string",
                    "minLength": 2,
                    "maxLength": 64
                  },
                  "numberingSystem": {
                    "description": "Numbering system, for number.",
                    "type": "string",
                    "minLength": 3,
                    "maxLength": 32
                  },
                  "identifiers": {
                    "description": "Whether to read digit identifiers, for number.",
                    "type": "string",
                    "enum": [
                      "refuse",
                      "read"
                    ]
                  },
                  "format": {
                    "description": "Date pattern such as dd.MM.yyyy, for date.",
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 64
                  },
                  "order": {
                    "description": "Day/month order without a format, for date.",
                    "type": "string",
                    "enum": [
                      "dmy",
                      "mdy"
                    ]
                  },
                  "trueValues": {
                    "description": "True-text tokens, for boolean.",
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  },
                  "falseValues": {
                    "description": "False-text tokens, for boolean.",
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 128
                    }
                  }
                },
                "required": [
                  "column",
                  "type"
                ],
                "additionalProperties": false
              }
            },
            "mergedCells": {
              "description": "Merged values and header detection policy, default master.",
              "type": "string",
              "enum": [
                "master",
                "repeat"
              ]
            },
            "delimiter": {
              "description": "CSV separator; sniffed when omitted.",
              "type": "string",
              "enum": [
                "comma",
                "semicolon",
                "tab",
                "pipe"
              ]
            },
            "encoding": {
              "description": "CSV encoding; BOM or utf-8 when omitted.",
              "type": "string",
              "enum": [
                "utf-8",
                "utf-16le",
                "utf-16be",
                "windows-1254",
                "iso-8859-9",
                "windows-1252",
                "windows-1251",
                "windows-1256",
                "shift_jis",
                "gb18030",
                "big5",
                "euc-kr"
              ]
            },
            "locale": {
              "description": "BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.",
              "type": "string",
              "minLength": 2,
              "maxLength": 64
            },
            "numberingSystem": {
              "description": "Numbering system such as arab; needs locale.",
              "type": "string",
              "minLength": 3,
              "maxLength": 32
            },
            "missingValues": {
              "description": "Missing-text tokens; default N/A, NULL, -, —, #N/A.",
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "trueValues": {
              "description": "True-text tokens; default true, yes, y, Evet, E.",
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "falseValues": {
              "description": "False-text tokens; default false, no, n, Hayır, H.",
              "maxItems": 64,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              }
            },
            "groupBy": {
              "description": "Row grouping keys; omit for a whole-range total. A key is a column, {column, by} for a UTC date part (month includes the year, week is ISO, weekday Monday=1), or {column, bins} or {column, width, origin?} for [lower, upper) bins.",
              "maxItems": 8,
              "type": "array",
              "items": {
                "anyOf": [
                  {
                    "type": "string",
                    "description": "Header text or A1 letter."
                  },
                  {
                    "type": "object",
                    "properties": {
                      "column": {
                        "type": "string",
                        "description": "Header text or A1 letter."
                      },
                      "by": {
                        "type": "string",
                        "enum": [
                          "year",
                          "quarter",
                          "month",
                          "week",
                          "day",
                          "weekday",
                          "hour"
                        ]
                      }
                    },
                    "required": [
                      "column",
                      "by"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "column": {
                        "type": "string",
                        "description": "Header text or A1 letter."
                      },
                      "bins": {
                        "minItems": 1,
                        "maxItems": 128,
                        "type": "array",
                        "items": {
                          "type": "number"
                        }
                      }
                    },
                    "required": [
                      "column",
                      "bins"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "object",
                    "properties": {
                      "column": {
                        "type": "string",
                        "description": "Header text or A1 letter."
                      },
                      "width": {
                        "type": "number",
                        "minimum": 5e-324
                      },
                      "origin": {
                        "type": "number"
                      }
                    },
                    "required": [
                      "column",
                      "width"
                    ],
                    "additionalProperties": false
                  }
                ]
              }
            },
            "orderBy": {
              "description": "Sort by group key (default) or selected metric.",
              "type": "string",
              "enum": [
                "group",
                "metric"
              ]
            },
            "orderByMetric": {
              "description": "One-based index into metrics, default 1. Cannot exceed the actual metrics count.",
              "type": "integer",
              "minimum": 1,
              "maximum": 8
            },
            "descending": {
              "description": "Descending sort, default false.",
              "type": "boolean"
            },
            "metrics": {
              "minItems": 1,
              "maxItems": 8,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "fn": {
                    "type": "string",
                    "enum": [
                      "count",
                      "countValues",
                      "countDistinct",
                      "countTrue",
                      "countFalse",
                      "trueRatio",
                      "sum",
                      "avg",
                      "min",
                      "max",
                      "stddev",
                      "median",
                      "p50",
                      "p90",
                      "percentile"
                    ],
                    "description": "count counts matched rows, countValues non-empty cells, countDistinct distinct values; trueRatio is true over valid booleans. Numeric functions read numeric text and skip identifiers; percentiles are PERCENTILE.INC; stddev is the sample deviation."
                  },
                  "column": {
                    "type": "string",
                    "description": "Header text or A1 letter."
                  },
                  "percentile": {
                    "description": "Fraction 0 to 1, for fn percentile.",
                    "type": "number",
                    "minimum": 0,
                    "maximum": 1
                  },
                  "round": {
                    "description": "Decimal places, half away from zero as ROUND.",
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 10
                  },
                  "where": {
                    "maxItems": 16,
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "column": {
                          "type": "string",
                          "description": "Header text or A1 letter."
                        },
                        "op": {
                          "type": "string",
                          "enum": [
                            "eq",
                            "ne",
                            "lt",
                            "lte",
                            "gt",
                            "gte",
                            "contains",
                            "startsWith",
                            "endsWith",
                            "in",
                            "between",
                            "isEmpty",
                            "isNotEmpty",
                            "isError",
                            "isNumber",
                            "isText"
                          ]
                        },
                        "value": {
                          "description": "Operand.",
                          "type": [
                            "string",
                            "number",
                            "boolean"
                          ]
                        },
                        "values": {
                          "description": "Operands of in, or [low, high] of between.",
                          "minItems": 1,
                          "maxItems": 64,
                          "type": "array",
                          "items": {
                            "type": [
                              "string",
                              "number",
                              "boolean"
                            ]
                          }
                        }
                      },
                      "required": [
                        "column",
                        "op"
                      ],
                      "additionalProperties": false
                    }
                  }
                },
                "required": [
                  "fn"
                ],
                "additionalProperties": false
              }
            },
            "where": {
              "maxItems": 16,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "column": {
                    "type": "string",
                    "description": "Header text or A1 letter."
                  },
                  "op": {
                    "type": "string",
                    "enum": [
                      "eq",
                      "ne",
                      "lt",
                      "lte",
                      "gt",
                      "gte",
                      "contains",
                      "startsWith",
                      "endsWith",
                      "in",
                      "between",
                      "isEmpty",
                      "isNotEmpty",
                      "isError",
                      "isNumber",
                      "isText"
                    ]
                  },
                  "value": {
                    "description": "Operand.",
                    "type": [
                      "string",
                      "number",
                      "boolean"
                    ]
                  },
                  "values": {
                    "description": "Operands of in, or [low, high] of between.",
                    "minItems": 1,
                    "maxItems": 64,
                    "type": "array",
                    "items": {
                      "type": [
                        "string",
                        "number",
                        "boolean"
                      ]
                    }
                  }
                },
                "required": [
                  "column",
                  "op"
                ],
                "additionalProperties": false
              }
            },
            "match": {
              "default": "all",
              "type": "string",
              "enum": [
                "all",
                "any"
              ]
            }
          },
          "required": [
            "kind",
            "metrics"
          ],
          "additionalProperties": false
        }
      ],
      "type": "object"
    }
  },
  "required": [
    "filePath",
    "selection"
  ],
  "additionalProperties": false
}
```

:::

## `transfer_data`

transfer and target must be JSON objects, never JSON-encoded strings; preserve the nested source and selection objects in the returned transfer reference. Transfer the complete version-pinned value selection from prepare_transfer into a new immutable .xlsx or an existing selected .xlsx target, preserving supported unrelated package content. target new creates a workbook; add_sheet or sheet requires source {filePath,versionId}. sheet uses startCell and optional mapping {kind:headers,headerRow}; choose includeHeaders false when appending. Occupied targets require overwrite true; blank source cells then clear contents. All matching records are transferred, not just an earlier preview. Source and target version changes, unsupported values or preservation failures stop the whole operation. Values only; use explicit edit copy operations for existing formulas and formatting. Nothing is recalculated. Returns provenance/counts, not cell data.

Annotations: non-destructive, closed world.

Available only with `--write <relative-output-directory>`. The registered JSON Schema below is the exact wire contract; nested operation variants are validated by the server.

:::details[Input JSON Schema]

```json
{
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "transfer": {
      "type": "object",
      "properties": {
        "source": {
          "type": "object",
          "properties": {
            "filePath": {
              "type": "string",
              "minLength": 1,
              "maxLength": 32768
            },
            "versionId": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            }
          },
          "required": [
            "filePath",
            "versionId"
          ],
          "additionalProperties": false
        },
        "selection": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "range"
                },
                "sheetName": {
                  "description": "Exact worksheet name; defaults to the first visible sheet.",
                  "type": "string"
                },
                "range": {
                  "description": "A1 range such as A1:H500, B:D or 2:40, including the header row. Defaults to the used range.",
                  "type": "string"
                },
                "table": {
                  "description": "Declared table name; selects its data rows. Not with range. XLSX only.",
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 255
                },
                "visibleOnly": {
                  "description": "Skip saved hidden rows, AutoFilter's included. XLSX only.",
                  "type": "boolean"
                },
                "headerRow": {
                  "description": "Header row, 0 for none. Omitted: a table or autofilter header, else the first top row naming its columns in text above any data, else row 1.",
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "columnMode": {
                  "description": "Columns are named by header text or A1 letter: auto (default), header or letter.",
                  "type": "string",
                  "enum": [
                    "auto",
                    "header",
                    "letter"
                  ]
                },
                "caseSensitive": {
                  "description": "Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.",
                  "type": "boolean"
                },
                "columns": {
                  "description": "How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues.",
                  "minItems": 1,
                  "maxItems": 64,
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "column": {
                        "type": "string",
                        "description": "Header text or A1 letter."
                      },
                      "type": {
                        "type": "string",
                        "enum": [
                          "number",
                          "date",
                          "boolean",
                          "time",
                          "duration",
                          "text"
                        ],
                        "description": "How to read the column."
                      },
                      "missingValues": {
                        "description": "Missing-text tokens.",
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        }
                      },
                      "decimal": {
                        "description": "Decimal separator, for number.",
                        "type": "string",
                        "enum": [
                          ".",
                          ","
                        ]
                      },
                      "group": {
                        "description": "Thousands separator, for number.",
                        "type": "string",
                        "enum": [
                          "none",
                          ".",
                          ",",
                          " ",
                          "'"
                        ]
                      },
                      "locale": {
                        "description": "File locale, for number or date.",
                        "type": "string",
                        "minLength": 2,
                        "maxLength": 64
                      },
                      "numberingSystem": {
                        "description": "Numbering system, for number.",
                        "type": "string",
                        "minLength": 3,
                        "maxLength": 32
                      },
                      "identifiers": {
                        "description": "Whether to read digit identifiers, for number.",
                        "type": "string",
                        "enum": [
                          "refuse",
                          "read"
                        ]
                      },
                      "format": {
                        "description": "Date pattern such as dd.MM.yyyy, for date.",
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 64
                      },
                      "order": {
                        "description": "Day/month order without a format, for date.",
                        "type": "string",
                        "enum": [
                          "dmy",
                          "mdy"
                        ]
                      },
                      "trueValues": {
                        "description": "True-text tokens, for boolean.",
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        }
                      },
                      "falseValues": {
                        "description": "False-text tokens, for boolean.",
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        }
                      }
                    },
                    "required": [
                      "column",
                      "type"
                    ],
                    "additionalProperties": false
                  }
                },
                "mergedCells": {
                  "description": "Merged values and header detection policy, default master.",
                  "type": "string",
                  "enum": [
                    "master",
                    "repeat"
                  ]
                },
                "delimiter": {
                  "description": "CSV separator; sniffed when omitted.",
                  "type": "string",
                  "enum": [
                    "comma",
                    "semicolon",
                    "tab",
                    "pipe"
                  ]
                },
                "encoding": {
                  "description": "CSV encoding; BOM or utf-8 when omitted.",
                  "type": "string",
                  "enum": [
                    "utf-8",
                    "utf-16le",
                    "utf-16be",
                    "windows-1254",
                    "iso-8859-9",
                    "windows-1252",
                    "windows-1251",
                    "windows-1256",
                    "shift_jis",
                    "gb18030",
                    "big5",
                    "euc-kr"
                  ]
                },
                "locale": {
                  "description": "BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.",
                  "type": "string",
                  "minLength": 2,
                  "maxLength": 64
                },
                "numberingSystem": {
                  "description": "Numbering system such as arab; needs locale.",
                  "type": "string",
                  "minLength": 3,
                  "maxLength": 32
                },
                "missingValues": {
                  "description": "Missing-text tokens; default N/A, NULL, -, —, #N/A.",
                  "maxItems": 64,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  }
                },
                "trueValues": {
                  "description": "True-text tokens; default true, yes, y, Evet, E.",
                  "maxItems": 64,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  }
                },
                "falseValues": {
                  "description": "False-text tokens; default false, no, n, Hayır, H.",
                  "maxItems": 64,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  }
                },
                "selectColumns": {
                  "minItems": 1,
                  "maxItems": 16384,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 32767
                  }
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "records"
                },
                "sheetName": {
                  "description": "Exact worksheet name; defaults to the first visible sheet.",
                  "type": "string"
                },
                "range": {
                  "description": "A1 range such as A1:H500, B:D or 2:40, including the header row. Defaults to the used range.",
                  "type": "string"
                },
                "table": {
                  "description": "Declared table name; selects its data rows. Not with range. XLSX only.",
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 255
                },
                "visibleOnly": {
                  "description": "Skip saved hidden rows, AutoFilter's included. XLSX only.",
                  "type": "boolean"
                },
                "headerRow": {
                  "description": "Header row, 0 for none. Omitted: a table or autofilter header, else the first top row naming its columns in text above any data, else row 1.",
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "columnMode": {
                  "description": "Columns are named by header text or A1 letter: auto (default), header or letter.",
                  "type": "string",
                  "enum": [
                    "auto",
                    "header",
                    "letter"
                  ]
                },
                "caseSensitive": {
                  "description": "Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.",
                  "type": "boolean"
                },
                "columns": {
                  "description": "How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues.",
                  "minItems": 1,
                  "maxItems": 64,
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "column": {
                        "type": "string",
                        "description": "Header text or A1 letter."
                      },
                      "type": {
                        "type": "string",
                        "enum": [
                          "number",
                          "date",
                          "boolean",
                          "time",
                          "duration",
                          "text"
                        ],
                        "description": "How to read the column."
                      },
                      "missingValues": {
                        "description": "Missing-text tokens.",
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        }
                      },
                      "decimal": {
                        "description": "Decimal separator, for number.",
                        "type": "string",
                        "enum": [
                          ".",
                          ","
                        ]
                      },
                      "group": {
                        "description": "Thousands separator, for number.",
                        "type": "string",
                        "enum": [
                          "none",
                          ".",
                          ",",
                          " ",
                          "'"
                        ]
                      },
                      "locale": {
                        "description": "File locale, for number or date.",
                        "type": "string",
                        "minLength": 2,
                        "maxLength": 64
                      },
                      "numberingSystem": {
                        "description": "Numbering system, for number.",
                        "type": "string",
                        "minLength": 3,
                        "maxLength": 32
                      },
                      "identifiers": {
                        "description": "Whether to read digit identifiers, for number.",
                        "type": "string",
                        "enum": [
                          "refuse",
                          "read"
                        ]
                      },
                      "format": {
                        "description": "Date pattern such as dd.MM.yyyy, for date.",
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 64
                      },
                      "order": {
                        "description": "Day/month order without a format, for date.",
                        "type": "string",
                        "enum": [
                          "dmy",
                          "mdy"
                        ]
                      },
                      "trueValues": {
                        "description": "True-text tokens, for boolean.",
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        }
                      },
                      "falseValues": {
                        "description": "False-text tokens, for boolean.",
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        }
                      }
                    },
                    "required": [
                      "column",
                      "type"
                    ],
                    "additionalProperties": false
                  }
                },
                "mergedCells": {
                  "description": "Merged values and header detection policy, default master.",
                  "type": "string",
                  "enum": [
                    "master",
                    "repeat"
                  ]
                },
                "delimiter": {
                  "description": "CSV separator; sniffed when omitted.",
                  "type": "string",
                  "enum": [
                    "comma",
                    "semicolon",
                    "tab",
                    "pipe"
                  ]
                },
                "encoding": {
                  "description": "CSV encoding; BOM or utf-8 when omitted.",
                  "type": "string",
                  "enum": [
                    "utf-8",
                    "utf-16le",
                    "utf-16be",
                    "windows-1254",
                    "iso-8859-9",
                    "windows-1252",
                    "windows-1251",
                    "windows-1256",
                    "shift_jis",
                    "gb18030",
                    "big5",
                    "euc-kr"
                  ]
                },
                "locale": {
                  "description": "BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.",
                  "type": "string",
                  "minLength": 2,
                  "maxLength": 64
                },
                "numberingSystem": {
                  "description": "Numbering system such as arab; needs locale.",
                  "type": "string",
                  "minLength": 3,
                  "maxLength": 32
                },
                "missingValues": {
                  "description": "Missing-text tokens; default N/A, NULL, -, —, #N/A.",
                  "maxItems": 64,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  }
                },
                "trueValues": {
                  "description": "True-text tokens; default true, yes, y, Evet, E.",
                  "maxItems": 64,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  }
                },
                "falseValues": {
                  "description": "False-text tokens; default false, no, n, Hayır, H.",
                  "maxItems": 64,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  }
                },
                "selectColumns": {
                  "minItems": 1,
                  "maxItems": 16384,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 32767
                  }
                },
                "where": {
                  "maxItems": 16,
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "column": {
                        "type": "string",
                        "description": "Header text or A1 letter."
                      },
                      "op": {
                        "type": "string",
                        "enum": [
                          "eq",
                          "ne",
                          "lt",
                          "lte",
                          "gt",
                          "gte",
                          "contains",
                          "startsWith",
                          "endsWith",
                          "in",
                          "between",
                          "isEmpty",
                          "isNotEmpty",
                          "isError",
                          "isNumber",
                          "isText"
                        ]
                      },
                      "value": {
                        "description": "Operand.",
                        "type": [
                          "string",
                          "number",
                          "boolean"
                        ]
                      },
                      "values": {
                        "description": "Operands of in, or [low, high] of between.",
                        "minItems": 1,
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": [
                            "string",
                            "number",
                            "boolean"
                          ]
                        }
                      }
                    },
                    "required": [
                      "column",
                      "op"
                    ],
                    "additionalProperties": false
                  }
                },
                "match": {
                  "default": "all",
                  "type": "string",
                  "enum": [
                    "all",
                    "any"
                  ]
                },
                "scope": {
                  "default": {
                    "kind": "all"
                  },
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "all"
                        }
                      },
                      "required": [
                        "kind"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "rows"
                        },
                        "rows": {
                          "minItems": 1,
                          "maxItems": 10000,
                          "type": "array",
                          "items": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 1048576
                          }
                        }
                      },
                      "required": [
                        "kind",
                        "rows"
                      ],
                      "additionalProperties": false
                    }
                  ]
                },
                "includeHeaders": {
                  "default": true,
                  "type": "boolean"
                }
              },
              "required": [
                "kind"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "aggregate"
                },
                "sheetName": {
                  "description": "Exact worksheet name; defaults to the first visible sheet.",
                  "type": "string"
                },
                "range": {
                  "description": "A1 range such as A1:H500, B:D or 2:40, including the header row. Defaults to the used range.",
                  "type": "string"
                },
                "table": {
                  "description": "Declared table name; selects its data rows. Not with range. XLSX only.",
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 255
                },
                "visibleOnly": {
                  "description": "Skip saved hidden rows, AutoFilter's included. XLSX only.",
                  "type": "boolean"
                },
                "headerRow": {
                  "description": "Header row, 0 for none. Omitted: a table or autofilter header, else the first top row naming its columns in text above any data, else row 1.",
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "columnMode": {
                  "description": "Columns are named by header text or A1 letter: auto (default), header or letter.",
                  "type": "string",
                  "enum": [
                    "auto",
                    "header",
                    "letter"
                  ]
                },
                "caseSensitive": {
                  "description": "Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.",
                  "type": "boolean"
                },
                "columns": {
                  "description": "How to read columns, as profile_sheet returns it: [{column, type, ...}]. number takes decimal, group, locale or identifiers; date takes format (such as dd.MM.yyyy) or order; boolean takes trueValues and falseValues.",
                  "minItems": 1,
                  "maxItems": 64,
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "column": {
                        "type": "string",
                        "description": "Header text or A1 letter."
                      },
                      "type": {
                        "type": "string",
                        "enum": [
                          "number",
                          "date",
                          "boolean",
                          "time",
                          "duration",
                          "text"
                        ],
                        "description": "How to read the column."
                      },
                      "missingValues": {
                        "description": "Missing-text tokens.",
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        }
                      },
                      "decimal": {
                        "description": "Decimal separator, for number.",
                        "type": "string",
                        "enum": [
                          ".",
                          ","
                        ]
                      },
                      "group": {
                        "description": "Thousands separator, for number.",
                        "type": "string",
                        "enum": [
                          "none",
                          ".",
                          ",",
                          " ",
                          "'"
                        ]
                      },
                      "locale": {
                        "description": "File locale, for number or date.",
                        "type": "string",
                        "minLength": 2,
                        "maxLength": 64
                      },
                      "numberingSystem": {
                        "description": "Numbering system, for number.",
                        "type": "string",
                        "minLength": 3,
                        "maxLength": 32
                      },
                      "identifiers": {
                        "description": "Whether to read digit identifiers, for number.",
                        "type": "string",
                        "enum": [
                          "refuse",
                          "read"
                        ]
                      },
                      "format": {
                        "description": "Date pattern such as dd.MM.yyyy, for date.",
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 64
                      },
                      "order": {
                        "description": "Day/month order without a format, for date.",
                        "type": "string",
                        "enum": [
                          "dmy",
                          "mdy"
                        ]
                      },
                      "trueValues": {
                        "description": "True-text tokens, for boolean.",
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        }
                      },
                      "falseValues": {
                        "description": "False-text tokens, for boolean.",
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 128
                        }
                      }
                    },
                    "required": [
                      "column",
                      "type"
                    ],
                    "additionalProperties": false
                  }
                },
                "mergedCells": {
                  "description": "Merged values and header detection policy, default master.",
                  "type": "string",
                  "enum": [
                    "master",
                    "repeat"
                  ]
                },
                "delimiter": {
                  "description": "CSV separator; sniffed when omitted.",
                  "type": "string",
                  "enum": [
                    "comma",
                    "semicolon",
                    "tab",
                    "pipe"
                  ]
                },
                "encoding": {
                  "description": "CSV encoding; BOM or utf-8 when omitted.",
                  "type": "string",
                  "enum": [
                    "utf-8",
                    "utf-16le",
                    "utf-16be",
                    "windows-1254",
                    "iso-8859-9",
                    "windows-1252",
                    "windows-1251",
                    "windows-1256",
                    "shift_jis",
                    "gb18030",
                    "big5",
                    "euc-kr"
                  ]
                },
                "locale": {
                  "description": "BCP 47 locale the file was written in, for separators and month names, never day/month order. Omit when unknown.",
                  "type": "string",
                  "minLength": 2,
                  "maxLength": 64
                },
                "numberingSystem": {
                  "description": "Numbering system such as arab; needs locale.",
                  "type": "string",
                  "minLength": 3,
                  "maxLength": 32
                },
                "missingValues": {
                  "description": "Missing-text tokens; default N/A, NULL, -, —, #N/A.",
                  "maxItems": 64,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  }
                },
                "trueValues": {
                  "description": "True-text tokens; default true, yes, y, Evet, E.",
                  "maxItems": 64,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  }
                },
                "falseValues": {
                  "description": "False-text tokens; default false, no, n, Hayır, H.",
                  "maxItems": 64,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128
                  }
                },
                "groupBy": {
                  "description": "Row grouping keys; omit for a whole-range total. A key is a column, {column, by} for a UTC date part (month includes the year, week is ISO, weekday Monday=1), or {column, bins} or {column, width, origin?} for [lower, upper) bins.",
                  "maxItems": 8,
                  "type": "array",
                  "items": {
                    "anyOf": [
                      {
                        "type": "string",
                        "description": "Header text or A1 letter."
                      },
                      {
                        "type": "object",
                        "properties": {
                          "column": {
                            "type": "string",
                            "description": "Header text or A1 letter."
                          },
                          "by": {
                            "type": "string",
                            "enum": [
                              "year",
                              "quarter",
                              "month",
                              "week",
                              "day",
                              "weekday",
                              "hour"
                            ]
                          }
                        },
                        "required": [
                          "column",
                          "by"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "column": {
                            "type": "string",
                            "description": "Header text or A1 letter."
                          },
                          "bins": {
                            "minItems": 1,
                            "maxItems": 128,
                            "type": "array",
                            "items": {
                              "type": "number"
                            }
                          }
                        },
                        "required": [
                          "column",
                          "bins"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "column": {
                            "type": "string",
                            "description": "Header text or A1 letter."
                          },
                          "width": {
                            "type": "number",
                            "minimum": 5e-324
                          },
                          "origin": {
                            "type": "number"
                          }
                        },
                        "required": [
                          "column",
                          "width"
                        ],
                        "additionalProperties": false
                      }
                    ]
                  }
                },
                "orderBy": {
                  "description": "Sort by group key (default) or selected metric.",
                  "type": "string",
                  "enum": [
                    "group",
                    "metric"
                  ]
                },
                "orderByMetric": {
                  "description": "One-based index into metrics, default 1. Cannot exceed the actual metrics count.",
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 8
                },
                "descending": {
                  "description": "Descending sort, default false.",
                  "type": "boolean"
                },
                "metrics": {
                  "minItems": 1,
                  "maxItems": 8,
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "fn": {
                        "type": "string",
                        "enum": [
                          "count",
                          "countValues",
                          "countDistinct",
                          "countTrue",
                          "countFalse",
                          "trueRatio",
                          "sum",
                          "avg",
                          "min",
                          "max",
                          "stddev",
                          "median",
                          "p50",
                          "p90",
                          "percentile"
                        ],
                        "description": "count counts matched rows, countValues non-empty cells, countDistinct distinct values; trueRatio is true over valid booleans. Numeric functions read numeric text and skip identifiers; percentiles are PERCENTILE.INC; stddev is the sample deviation."
                      },
                      "column": {
                        "type": "string",
                        "description": "Header text or A1 letter."
                      },
                      "percentile": {
                        "description": "Fraction 0 to 1, for fn percentile.",
                        "type": "number",
                        "minimum": 0,
                        "maximum": 1
                      },
                      "round": {
                        "description": "Decimal places, half away from zero as ROUND.",
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 10
                      },
                      "where": {
                        "maxItems": 16,
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "column": {
                              "type": "string",
                              "description": "Header text or A1 letter."
                            },
                            "op": {
                              "type": "string",
                              "enum": [
                                "eq",
                                "ne",
                                "lt",
                                "lte",
                                "gt",
                                "gte",
                                "contains",
                                "startsWith",
                                "endsWith",
                                "in",
                                "between",
                                "isEmpty",
                                "isNotEmpty",
                                "isError",
                                "isNumber",
                                "isText"
                              ]
                            },
                            "value": {
                              "description": "Operand.",
                              "type": [
                                "string",
                                "number",
                                "boolean"
                              ]
                            },
                            "values": {
                              "description": "Operands of in, or [low, high] of between.",
                              "minItems": 1,
                              "maxItems": 64,
                              "type": "array",
                              "items": {
                                "type": [
                                  "string",
                                  "number",
                                  "boolean"
                                ]
                              }
                            }
                          },
                          "required": [
                            "column",
                            "op"
                          ],
                          "additionalProperties": false
                        }
                      }
                    },
                    "required": [
                      "fn"
                    ],
                    "additionalProperties": false
                  }
                },
                "where": {
                  "maxItems": 16,
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "column": {
                        "type": "string",
                        "description": "Header text or A1 letter."
                      },
                      "op": {
                        "type": "string",
                        "enum": [
                          "eq",
                          "ne",
                          "lt",
                          "lte",
                          "gt",
                          "gte",
                          "contains",
                          "startsWith",
                          "endsWith",
                          "in",
                          "between",
                          "isEmpty",
                          "isNotEmpty",
                          "isError",
                          "isNumber",
                          "isText"
                        ]
                      },
                      "value": {
                        "description": "Operand.",
                        "type": [
                          "string",
                          "number",
                          "boolean"
                        ]
                      },
                      "values": {
                        "description": "Operands of in, or [low, high] of between.",
                        "minItems": 1,
                        "maxItems": 64,
                        "type": "array",
                        "items": {
                          "type": [
                            "string",
                            "number",
                            "boolean"
                          ]
                        }
                      }
                    },
                    "required": [
                      "column",
                      "op"
                    ],
                    "additionalProperties": false
                  }
                },
                "match": {
                  "default": "all",
                  "type": "string",
                  "enum": [
                    "all",
                    "any"
                  ]
                }
              },
              "required": [
                "kind",
                "metrics"
              ],
              "additionalProperties": false
            }
          ],
          "type": "object"
        }
      },
      "required": [
        "source",
        "selection"
      ],
      "additionalProperties": false
    },
    "target": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "new"
            },
            "sheetName": {
              "type": "string",
              "minLength": 1,
              "maxLength": 31
            },
            "startCell": {
              "default": "A1",
              "type": "string",
              "minLength": 2,
              "maxLength": 10,
              "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}$"
            }
          },
          "required": [
            "kind",
            "sheetName"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "add_sheet"
            },
            "source": {
              "type": "object",
              "properties": {
                "filePath": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 32768
                },
                "versionId": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              },
              "required": [
                "filePath",
                "versionId"
              ],
              "additionalProperties": false
            },
            "sheetName": {
              "type": "string",
              "minLength": 1,
              "maxLength": 31
            },
            "startCell": {
              "default": "A1",
              "type": "string",
              "minLength": 2,
              "maxLength": 10,
              "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}$"
            }
          },
          "required": [
            "kind",
            "source",
            "sheetName"
          ],
          "additionalProperties": false
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "sheet"
            },
            "source": {
              "type": "object",
              "properties": {
                "filePath": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 32768
                },
                "versionId": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              },
              "required": [
                "filePath",
                "versionId"
              ],
              "additionalProperties": false
            },
            "sheetName": {
              "type": "string",
              "minLength": 1,
              "maxLength": 31
            },
            "startCell": {
              "type": "string",
              "minLength": 2,
              "maxLength": 10,
              "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}$"
            },
            "overwrite": {
              "default": false,
              "type": "boolean"
            },
            "mapping": {
              "default": {
                "kind": "position"
              },
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "position"
                    }
                  },
                  "required": [
                    "kind"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "headers"
                    },
                    "headerRow": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 1048576
                    }
                  },
                  "required": [
                    "kind",
                    "headerRow"
                  ],
                  "additionalProperties": false
                }
              ]
            }
          },
          "required": [
            "kind",
            "source",
            "sheetName",
            "startCell"
          ],
          "additionalProperties": false
        }
      ],
      "type": "object"
    }
  },
  "required": [
    "transfer",
    "target"
  ],
  "additionalProperties": false
}
```

:::

## `create_workbook`

Create one immutable .xlsx from named sheets and rectangular typed value blocks. Each scalar has kind text/number/boolean/blank/date/datetime; text beginning with = stays literal. Optional changes finish the workbook atomically with formatting, layout, merges, formulas and tables before publication. Formula operations write explicit formula text without calculating it. Table range includes its header and optional totals row; use literal unique headers. At least one sheet, up to 1,000,000 touched/stored cells, 64 sheets and 128 changes. Identical requests retain identical outputs; originals never change. Table ranges include the header and requested totals row. A real calculated column uses calculatedColumns:[{column:"Amount",formula:"[@Qty]*[@Price]"}]; filling cells alone does not define table calculated-column metadata. Bare Qty*Price refers to defined names. Totals labels are explicit, for example totals:[{kind:"label",column:"Item",text:"Total"},{kind:"function",column:"Amount",function:"sum"}]; a sum function does not create a Total label automatically.

Annotations: non-destructive, closed world.

Available only with `--write <relative-output-directory>`. The registered JSON Schema below is the exact wire contract; nested operation variants are validated by the server.

:::details[Input JSON Schema]

```json
{
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "sheets": {
      "minItems": 1,
      "maxItems": 64,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 31
          },
          "blocks": {
            "default": [],
            "maxItems": 128,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "startCell": {
                  "type": "string",
                  "minLength": 2,
                  "maxLength": 10,
                  "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}$"
                },
                "values": {
                  "minItems": 1,
                  "maxItems": 1000000,
                  "type": "array",
                  "items": {
                    "minItems": 1,
                    "maxItems": 16384,
                    "type": "array",
                    "items": {
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "text"
                            },
                            "value": {
                              "type": "string",
                              "maxLength": 32767
                            }
                          },
                          "required": [
                            "kind",
                            "value"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "number"
                            },
                            "value": {
                              "type": "number"
                            }
                          },
                          "required": [
                            "kind",
                            "value"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "boolean"
                            },
                            "value": {
                              "type": "boolean"
                            }
                          },
                          "required": [
                            "kind",
                            "value"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "blank"
                            }
                          },
                          "required": [
                            "kind"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "date"
                            },
                            "value": {
                              "type": "string",
                              "minLength": 10,
                              "format": "date",
                              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
                            }
                          },
                          "required": [
                            "kind",
                            "value"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "datetime"
                            },
                            "value": {
                              "type": "string",
                              "allOf": [
                                {
                                  "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z)|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"
                                },
                                {
                                  "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?$"
                                }
                              ]
                            }
                          },
                          "required": [
                            "kind",
                            "value"
                          ],
                          "additionalProperties": false
                        }
                      ]
                    }
                  }
                }
              },
              "required": [
                "startCell",
                "values"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "name"
        ],
        "additionalProperties": false
      }
    },
    "changes": {
      "maxItems": 128,
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "format_cells",
              "set_columns",
              "set_rows",
              "freeze_panes",
              "set_sheet_visibility",
              "set_print_layout",
              "merge_cells",
              "unmerge_cells",
              "write_formula",
              "fill_formula",
              "create_table",
              "edit_table",
              "convert_table"
            ]
          },
          "sheetName": {
            "type": "string",
            "minLength": 1,
            "maxLength": 31
          },
          "range": {
            "type": "string",
            "maxLength": 21,
            "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
          },
          "style": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "numberFormat": {
                    "anyOf": [
                      {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 255
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "font": {
                    "anyOf": [
                      {
                        "type": "object",
                        "properties": {
                          "name": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 128
                          },
                          "size": {
                            "type": "number",
                            "minimum": 1,
                            "maximum": 409
                          },
                          "bold": {
                            "type": "boolean"
                          },
                          "italic": {
                            "type": "boolean"
                          },
                          "underline": {
                            "type": "boolean"
                          },
                          "strike": {
                            "type": "boolean"
                          },
                          "color": {
                            "type": "string",
                            "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                          }
                        },
                        "additionalProperties": false
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "fill": {
                    "anyOf": [
                      {
                        "type": "string",
                        "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "border": {
                    "anyOf": [
                      {
                        "type": "object",
                        "properties": {
                          "left": {
                            "type": "object",
                            "properties": {
                              "style": {
                                "type": "string",
                                "enum": [
                                  "thin",
                                  "medium",
                                  "thick",
                                  "dashed",
                                  "dotted",
                                  "double",
                                  "hair",
                                  "none"
                                ]
                              },
                              "color": {
                                "type": "string",
                                "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                              }
                            },
                            "required": [
                              "style"
                            ],
                            "additionalProperties": false
                          },
                          "right": {
                            "type": "object",
                            "properties": {
                              "style": {
                                "type": "string",
                                "enum": [
                                  "thin",
                                  "medium",
                                  "thick",
                                  "dashed",
                                  "dotted",
                                  "double",
                                  "hair",
                                  "none"
                                ]
                              },
                              "color": {
                                "type": "string",
                                "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                              }
                            },
                            "required": [
                              "style"
                            ],
                            "additionalProperties": false
                          },
                          "top": {
                            "type": "object",
                            "properties": {
                              "style": {
                                "type": "string",
                                "enum": [
                                  "thin",
                                  "medium",
                                  "thick",
                                  "dashed",
                                  "dotted",
                                  "double",
                                  "hair",
                                  "none"
                                ]
                              },
                              "color": {
                                "type": "string",
                                "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                              }
                            },
                            "required": [
                              "style"
                            ],
                            "additionalProperties": false
                          },
                          "bottom": {
                            "type": "object",
                            "properties": {
                              "style": {
                                "type": "string",
                                "enum": [
                                  "thin",
                                  "medium",
                                  "thick",
                                  "dashed",
                                  "dotted",
                                  "double",
                                  "hair",
                                  "none"
                                ]
                              },
                              "color": {
                                "type": "string",
                                "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                              }
                            },
                            "required": [
                              "style"
                            ],
                            "additionalProperties": false
                          }
                        },
                        "additionalProperties": false
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "alignment": {
                    "anyOf": [
                      {
                        "type": "object",
                        "properties": {
                          "horizontal": {
                            "type": "string",
                            "enum": [
                              "general",
                              "left",
                              "center",
                              "right",
                              "fill",
                              "justify",
                              "centerContinuous",
                              "distributed"
                            ]
                          },
                          "vertical": {
                            "type": "string",
                            "enum": [
                              "top",
                              "center",
                              "bottom",
                              "justify",
                              "distributed"
                            ]
                          },
                          "wrapText": {
                            "type": "boolean"
                          }
                        },
                        "additionalProperties": false
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "additionalProperties": false
              },
              {
                "type": "string",
                "enum": [
                  "SezzleeBlue",
                  "none"
                ]
              }
            ]
          },
          "first": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 1,
                "maximum": 16384
              },
              {
                "type": "integer",
                "minimum": 1,
                "maximum": 1048576
              }
            ]
          },
          "last": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 1,
                "maximum": 16384
              },
              {
                "type": "integer",
                "minimum": 1,
                "maximum": 1048576
              }
            ]
          },
          "width": {
            "anyOf": [
              {
                "type": "number",
                "minimum": 0,
                "maximum": 255
              },
              {
                "type": "null"
              }
            ]
          },
          "hidden": {
            "type": "boolean"
          },
          "height": {
            "anyOf": [
              {
                "type": "number",
                "minimum": 0,
                "maximum": 409
              },
              {
                "type": "null"
              }
            ]
          },
          "rows": {
            "type": "integer",
            "minimum": 0,
            "maximum": 1048575
          },
          "columns": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 16383
              },
              {
                "maxItems": 1024,
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 255
                    },
                    "name": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 255
                    }
                  },
                  "required": [
                    "column",
                    "name"
                  ],
                  "additionalProperties": false
                }
              }
            ]
          },
          "state": {
            "type": "string",
            "enum": [
              "visible",
              "hidden",
              "veryHidden"
            ]
          },
          "orientation": {
            "type": "string",
            "enum": [
              "portrait",
              "landscape"
            ]
          },
          "paper": {
            "type": "string",
            "enum": [
              "A4",
              "letter",
              "legal"
            ]
          },
          "margins": {
            "type": "object",
            "properties": {
              "left": {
                "type": "number",
                "minimum": 0,
                "maximum": 10
              },
              "right": {
                "type": "number",
                "minimum": 0,
                "maximum": 10
              },
              "top": {
                "type": "number",
                "minimum": 0,
                "maximum": 10
              },
              "bottom": {
                "type": "number",
                "minimum": 0,
                "maximum": 10
              },
              "header": {
                "type": "number",
                "minimum": 0,
                "maximum": 10
              },
              "footer": {
                "type": "number",
                "minimum": 0,
                "maximum": 10
              }
            },
            "required": [
              "left",
              "right",
              "top",
              "bottom",
              "header",
              "footer"
            ],
            "additionalProperties": false
          },
          "fitWidth": {
            "type": "integer",
            "minimum": 0,
            "maximum": 32767
          },
          "fitHeight": {
            "type": "integer",
            "minimum": 0,
            "maximum": 32767
          },
          "scale": {
            "type": "integer",
            "minimum": 10,
            "maximum": 400
          },
          "printArea": {
            "anyOf": [
              {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              {
                "type": "null"
              }
            ]
          },
          "titleRows": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "first": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 1048576
                  },
                  "last": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 1048576
                  }
                },
                "required": [
                  "first",
                  "last"
                ],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          },
          "titleColumns": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "first": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 16384
                  },
                  "last": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 16384
                  }
                },
                "required": [
                  "first",
                  "last"
                ],
                "additionalProperties": false
              },
              {
                "type": "null"
              }
            ]
          },
          "loss": {
            "type": "string",
            "enum": [
              "reject",
              "discard_non_anchor"
            ]
          },
          "cell": {
            "type": "string",
            "maxLength": 21,
            "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
          },
          "formula": {
            "type": "string",
            "minLength": 1,
            "maxLength": 8192
          },
          "overwrite": {
            "type": "boolean"
          },
          "anchor": {
            "type": "string",
            "maxLength": 21,
            "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 255,
            "pattern": "^[\\p{L}_\\\\][\\p{L}\\p{N}_.\\\\]*$"
          },
          "filter": {
            "type": "boolean"
          },
          "totals": {
            "anyOf": [
              {
                "maxItems": 1024,
                "type": "array",
                "items": {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "label"
                        },
                        "column": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 255
                        },
                        "text": {
                          "type": "string",
                          "maxLength": 255
                        }
                      },
                      "required": [
                        "kind",
                        "column",
                        "text"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "function"
                        },
                        "column": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 255
                        },
                        "function": {
                          "type": "string",
                          "enum": [
                            "sum",
                            "average",
                            "count",
                            "countNums",
                            "min",
                            "max",
                            "stdDev",
                            "var"
                          ]
                        }
                      },
                      "required": [
                        "kind",
                        "column",
                        "function"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "formula"
                        },
                        "column": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 255
                        },
                        "formula": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 8192
                        }
                      },
                      "required": [
                        "kind",
                        "column",
                        "formula"
                      ],
                      "additionalProperties": false
                    }
                  ]
                }
              },
              {
                "anyOf": [
                  {
                    "maxItems": 1024,
                    "type": "array",
                    "items": {
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "label"
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 255
                            },
                            "text": {
                              "type": "string",
                              "maxLength": 255
                            }
                          },
                          "required": [
                            "kind",
                            "column",
                            "text"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "function"
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 255
                            },
                            "function": {
                              "type": "string",
                              "enum": [
                                "sum",
                                "average",
                                "count",
                                "countNums",
                                "min",
                                "max",
                                "stdDev",
                                "var"
                              ]
                            }
                          },
                          "required": [
                            "kind",
                            "column",
                            "function"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "formula"
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 255
                            },
                            "formula": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 8192
                            }
                          },
                          "required": [
                            "kind",
                            "column",
                            "formula"
                          ],
                          "additionalProperties": false
                        }
                      ]
                    }
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            ]
          },
          "calculatedColumns": {
            "maxItems": 1024,
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "column": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 255
                },
                "formula": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 8192
                }
              },
              "required": [
                "column",
                "formula"
              ],
              "additionalProperties": false
            }
          },
          "tableName": {
            "type": "string",
            "minLength": 1,
            "maxLength": 255,
            "pattern": "^[\\p{L}_\\\\][\\p{L}\\p{N}_.\\\\]*$"
          },
          "clearRemovedValues": {
            "type": "boolean"
          }
        },
        "required": [
          "kind",
          "sheetName"
        ],
        "additionalProperties": false
      }
    }
  },
  "required": [
    "sheets"
  ],
  "additionalProperties": false
}
```

:::

## `edit_workbook`

Apply ordered atomic changes to source {filePath,versionId}; originals/retained outputs never change. write_cells uses typed literal values; occupied data/formula targets require overwrite:true. clear_contents preserves styles. copy_range/move_range use range,targetSheet,startCell; copy requires mode values/formulas/formatting/all. copy_sheet uses name/mode; copy operations optionally accept from {filePath,versionId}, subject to dependency/style compatibility. Sheet rename/reorder/delete and row/column insert/delete preserve supported references or refuse. format_cells patches only specified style fields; null resets a component. set_columns/set_rows use one-based first/last, width in character units/height in points, hidden; freeze_panes uses row/column counts. set_print_layout margins are inches; choose scale or fitWidth/fitHeight. merge_cells defaults to loss:reject; loss:discard_non_anchor explicitly clears other contents; unmerge_cells retains only the anchor. write_formula uses cell/formula; fill_formula uses anchor/range/formula and relative A1/table references. New formulas have no calculated cache; report recalculation required. create_table range includes header/data/optional totals; headers are unique literal text. edit_table can rename name/columns, resize range, set calculatedColumns/totals/style/filter; shrink preserves excluded values unless clearRemovedValues:true. convert_table preserves supported references/appearance or refuses. Table style is SezzleeBlue or none; filter toggles dropdowns, not dataset filtering. Dynamic arrays/external formula links and unsupported affected preservation refuse the whole request. Use prepare_edit first for scope/effects. Retry the same source/changes for the same result; select an earlier source to undo/branch. Table ranges include the header and requested totals row. A real calculated column uses calculatedColumns:[{column:"Amount",formula:"[@Qty]*[@Price]"}]; filling cells alone does not define table calculated-column metadata. Bare Qty*Price refers to defined names. Totals labels are explicit, for example totals:[{kind:"label",column:"Item",text:"Total"},{kind:"function",column:"Amount",function:"sum"}]; a sum function does not create a Total label automatically.

Annotations: non-destructive, closed world.

Available only with `--write <relative-output-directory>`. The registered JSON Schema below is the exact wire contract; nested operation variants are validated by the server.

:::details[Input JSON Schema]

```json
{
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "source": {
      "type": "object",
      "properties": {
        "filePath": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32768
        },
        "versionId": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        }
      },
      "required": [
        "filePath",
        "versionId"
      ],
      "additionalProperties": false
    },
    "changes": {
      "minItems": 1,
      "maxItems": 128,
      "type": "array",
      "items": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "add_sheet"
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              }
            },
            "required": [
              "kind",
              "name"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "startCell": {
                "type": "string",
                "minLength": 2,
                "maxLength": 10,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}$"
              },
              "values": {
                "minItems": 1,
                "maxItems": 1000000,
                "type": "array",
                "items": {
                  "minItems": 1,
                  "maxItems": 16384,
                  "type": "array",
                  "items": {
                    "oneOf": [
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "text"
                          },
                          "value": {
                            "type": "string",
                            "maxLength": 32767
                          }
                        },
                        "required": [
                          "kind",
                          "value"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "number"
                          },
                          "value": {
                            "type": "number"
                          }
                        },
                        "required": [
                          "kind",
                          "value"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "boolean"
                          },
                          "value": {
                            "type": "boolean"
                          }
                        },
                        "required": [
                          "kind",
                          "value"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "blank"
                          }
                        },
                        "required": [
                          "kind"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "date"
                          },
                          "value": {
                            "type": "string",
                            "minLength": 10,
                            "format": "date",
                            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
                          }
                        },
                        "required": [
                          "kind",
                          "value"
                        ],
                        "additionalProperties": false
                      },
                      {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "const": "datetime"
                          },
                          "value": {
                            "type": "string",
                            "allOf": [
                              {
                                "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z)|(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?)$"
                              },
                              {
                                "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?$"
                              }
                            ]
                          }
                        },
                        "required": [
                          "kind",
                          "value"
                        ],
                        "additionalProperties": false
                      }
                    ]
                  }
                }
              },
              "kind": {
                "type": "string",
                "const": "write_cells"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "overwrite": {
                "default": false,
                "type": "boolean"
              }
            },
            "required": [
              "startCell",
              "values",
              "kind",
              "sheetName"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "format_cells"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "range": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "style": {
                "type": "object",
                "properties": {
                  "numberFormat": {
                    "anyOf": [
                      {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 255
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "font": {
                    "anyOf": [
                      {
                        "type": "object",
                        "properties": {
                          "name": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 128
                          },
                          "size": {
                            "type": "number",
                            "minimum": 1,
                            "maximum": 409
                          },
                          "bold": {
                            "type": "boolean"
                          },
                          "italic": {
                            "type": "boolean"
                          },
                          "underline": {
                            "type": "boolean"
                          },
                          "strike": {
                            "type": "boolean"
                          },
                          "color": {
                            "type": "string",
                            "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                          }
                        },
                        "additionalProperties": false
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "fill": {
                    "anyOf": [
                      {
                        "type": "string",
                        "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "border": {
                    "anyOf": [
                      {
                        "type": "object",
                        "properties": {
                          "left": {
                            "type": "object",
                            "properties": {
                              "style": {
                                "type": "string",
                                "enum": [
                                  "thin",
                                  "medium",
                                  "thick",
                                  "dashed",
                                  "dotted",
                                  "double",
                                  "hair",
                                  "none"
                                ]
                              },
                              "color": {
                                "type": "string",
                                "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                              }
                            },
                            "required": [
                              "style"
                            ],
                            "additionalProperties": false
                          },
                          "right": {
                            "type": "object",
                            "properties": {
                              "style": {
                                "type": "string",
                                "enum": [
                                  "thin",
                                  "medium",
                                  "thick",
                                  "dashed",
                                  "dotted",
                                  "double",
                                  "hair",
                                  "none"
                                ]
                              },
                              "color": {
                                "type": "string",
                                "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                              }
                            },
                            "required": [
                              "style"
                            ],
                            "additionalProperties": false
                          },
                          "top": {
                            "type": "object",
                            "properties": {
                              "style": {
                                "type": "string",
                                "enum": [
                                  "thin",
                                  "medium",
                                  "thick",
                                  "dashed",
                                  "dotted",
                                  "double",
                                  "hair",
                                  "none"
                                ]
                              },
                              "color": {
                                "type": "string",
                                "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                              }
                            },
                            "required": [
                              "style"
                            ],
                            "additionalProperties": false
                          },
                          "bottom": {
                            "type": "object",
                            "properties": {
                              "style": {
                                "type": "string",
                                "enum": [
                                  "thin",
                                  "medium",
                                  "thick",
                                  "dashed",
                                  "dotted",
                                  "double",
                                  "hair",
                                  "none"
                                ]
                              },
                              "color": {
                                "type": "string",
                                "pattern": "^[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$"
                              }
                            },
                            "required": [
                              "style"
                            ],
                            "additionalProperties": false
                          }
                        },
                        "additionalProperties": false
                      },
                      {
                        "type": "null"
                      }
                    ]
                  },
                  "alignment": {
                    "anyOf": [
                      {
                        "type": "object",
                        "properties": {
                          "horizontal": {
                            "type": "string",
                            "enum": [
                              "general",
                              "left",
                              "center",
                              "right",
                              "fill",
                              "justify",
                              "centerContinuous",
                              "distributed"
                            ]
                          },
                          "vertical": {
                            "type": "string",
                            "enum": [
                              "top",
                              "center",
                              "bottom",
                              "justify",
                              "distributed"
                            ]
                          },
                          "wrapText": {
                            "type": "boolean"
                          }
                        },
                        "additionalProperties": false
                      },
                      {
                        "type": "null"
                      }
                    ]
                  }
                },
                "additionalProperties": false
              }
            },
            "required": [
              "kind",
              "sheetName",
              "range",
              "style"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "set_columns"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "first": {
                "type": "integer",
                "minimum": 1,
                "maximum": 16384
              },
              "last": {
                "type": "integer",
                "minimum": 1,
                "maximum": 16384
              },
              "width": {
                "anyOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 255
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "hidden": {
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "first",
              "last"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "set_rows"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "first": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1048576
              },
              "last": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1048576
              },
              "height": {
                "anyOf": [
                  {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 409
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "hidden": {
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "first",
              "last"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "freeze_panes"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "rows": {
                "type": "integer",
                "minimum": 0,
                "maximum": 1048575
              },
              "columns": {
                "type": "integer",
                "minimum": 0,
                "maximum": 16383
              }
            },
            "required": [
              "kind",
              "sheetName",
              "rows",
              "columns"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "set_sheet_visibility"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "state": {
                "type": "string",
                "enum": [
                  "visible",
                  "hidden",
                  "veryHidden"
                ]
              }
            },
            "required": [
              "kind",
              "sheetName",
              "state"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "set_print_layout"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "orientation": {
                "type": "string",
                "enum": [
                  "portrait",
                  "landscape"
                ]
              },
              "paper": {
                "type": "string",
                "enum": [
                  "A4",
                  "letter",
                  "legal"
                ]
              },
              "margins": {
                "type": "object",
                "properties": {
                  "left": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 10
                  },
                  "right": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 10
                  },
                  "top": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 10
                  },
                  "bottom": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 10
                  },
                  "header": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 10
                  },
                  "footer": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 10
                  }
                },
                "required": [
                  "left",
                  "right",
                  "top",
                  "bottom",
                  "header",
                  "footer"
                ],
                "additionalProperties": false
              },
              "fitWidth": {
                "type": "integer",
                "minimum": 0,
                "maximum": 32767
              },
              "fitHeight": {
                "type": "integer",
                "minimum": 0,
                "maximum": 32767
              },
              "scale": {
                "type": "integer",
                "minimum": 10,
                "maximum": 400
              },
              "printArea": {
                "anyOf": [
                  {
                    "type": "string",
                    "maxLength": 21,
                    "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "titleRows": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "first": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 1048576
                      },
                      "last": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 1048576
                      }
                    },
                    "required": [
                      "first",
                      "last"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "titleColumns": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "first": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 16384
                      },
                      "last": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 16384
                      }
                    },
                    "required": [
                      "first",
                      "last"
                    ],
                    "additionalProperties": false
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "kind",
              "sheetName"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "merge_cells"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "range": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "loss": {
                "default": "reject",
                "type": "string",
                "enum": [
                  "reject",
                  "discard_non_anchor"
                ]
              }
            },
            "required": [
              "kind",
              "sheetName",
              "range"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "unmerge_cells"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "range": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "range"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "write_formula"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "cell": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "formula": {
                "type": "string",
                "minLength": 1,
                "maxLength": 8192
              },
              "overwrite": {
                "default": false,
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "cell",
              "formula"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "fill_formula"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "anchor": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "range": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "formula": {
                "type": "string",
                "minLength": 1,
                "maxLength": 8192
              },
              "overwrite": {
                "default": false,
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "anchor",
              "range",
              "formula"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "create_table"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "range": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255,
                "pattern": "^[\\p{L}_\\\\][\\p{L}\\p{N}_.\\\\]*$"
              },
              "style": {
                "default": "SezzleeBlue",
                "type": "string",
                "enum": [
                  "SezzleeBlue",
                  "none"
                ]
              },
              "filter": {
                "default": true,
                "type": "boolean"
              },
              "totals": {
                "maxItems": 1024,
                "type": "array",
                "items": {
                  "oneOf": [
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "label"
                        },
                        "column": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 255
                        },
                        "text": {
                          "type": "string",
                          "maxLength": 255
                        }
                      },
                      "required": [
                        "kind",
                        "column",
                        "text"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "function"
                        },
                        "column": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 255
                        },
                        "function": {
                          "type": "string",
                          "enum": [
                            "sum",
                            "average",
                            "count",
                            "countNums",
                            "min",
                            "max",
                            "stdDev",
                            "var"
                          ]
                        }
                      },
                      "required": [
                        "kind",
                        "column",
                        "function"
                      ],
                      "additionalProperties": false
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "formula"
                        },
                        "column": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 255
                        },
                        "formula": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 8192
                        }
                      },
                      "required": [
                        "kind",
                        "column",
                        "formula"
                      ],
                      "additionalProperties": false
                    }
                  ]
                }
              },
              "calculatedColumns": {
                "maxItems": 1024,
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 255
                    },
                    "formula": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 8192
                    }
                  },
                  "required": [
                    "column",
                    "formula"
                  ],
                  "additionalProperties": false
                }
              },
              "overwrite": {
                "default": false,
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "range",
              "name"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "edit_table"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "tableName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255,
                "pattern": "^[\\p{L}_\\\\][\\p{L}\\p{N}_.\\\\]*$"
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255,
                "pattern": "^[\\p{L}_\\\\][\\p{L}\\p{N}_.\\\\]*$"
              },
              "range": {
                "type": "string",
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "columns": {
                "maxItems": 1024,
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 255
                    },
                    "name": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 255
                    }
                  },
                  "required": [
                    "column",
                    "name"
                  ],
                  "additionalProperties": false
                }
              },
              "totals": {
                "anyOf": [
                  {
                    "maxItems": 1024,
                    "type": "array",
                    "items": {
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "label"
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 255
                            },
                            "text": {
                              "type": "string",
                              "maxLength": 255
                            }
                          },
                          "required": [
                            "kind",
                            "column",
                            "text"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "function"
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 255
                            },
                            "function": {
                              "type": "string",
                              "enum": [
                                "sum",
                                "average",
                                "count",
                                "countNums",
                                "min",
                                "max",
                                "stdDev",
                                "var"
                              ]
                            }
                          },
                          "required": [
                            "kind",
                            "column",
                            "function"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "formula"
                            },
                            "column": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 255
                            },
                            "formula": {
                              "type": "string",
                              "minLength": 1,
                              "maxLength": 8192
                            }
                          },
                          "required": [
                            "kind",
                            "column",
                            "formula"
                          ],
                          "additionalProperties": false
                        }
                      ]
                    }
                  },
                  {
                    "type": "null"
                  }
                ]
              },
              "style": {
                "type": "string",
                "enum": [
                  "SezzleeBlue",
                  "none"
                ]
              },
              "filter": {
                "type": "boolean"
              },
              "calculatedColumns": {
                "maxItems": 1024,
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "column": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 255
                    },
                    "formula": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 8192
                    }
                  },
                  "required": [
                    "column",
                    "formula"
                  ],
                  "additionalProperties": false
                }
              },
              "clearRemovedValues": {
                "default": false,
                "type": "boolean"
              },
              "overwrite": {
                "default": false,
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "tableName"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "convert_table"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "tableName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 255,
                "pattern": "^[\\p{L}_\\\\][\\p{L}\\p{N}_.\\\\]*$"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "tableName"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "clear_contents"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "range": {
                "type": "string",
                "minLength": 2,
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "range"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "rename_sheet"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              }
            },
            "required": [
              "kind",
              "sheetName",
              "name"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "reorder_sheet"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "position": {
                "type": "integer",
                "minimum": 1,
                "maximum": 64
              }
            },
            "required": [
              "kind",
              "sheetName",
              "position"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "delete_sheet"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              }
            },
            "required": [
              "kind",
              "sheetName"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "copy_sheet"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "mode": {
                "type": "string",
                "enum": [
                  "values",
                  "formulas",
                  "formatting",
                  "all"
                ]
              },
              "from": {
                "type": "object",
                "properties": {
                  "filePath": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 32768
                  },
                  "versionId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "filePath",
                  "versionId"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "kind",
              "sheetName",
              "name",
              "mode"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "copy_range"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "range": {
                "type": "string",
                "minLength": 2,
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "targetSheet": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "startCell": {
                "type": "string",
                "minLength": 2,
                "maxLength": 10
              },
              "mode": {
                "type": "string",
                "enum": [
                  "values",
                  "formulas",
                  "formatting",
                  "all"
                ]
              },
              "overwrite": {
                "default": false,
                "type": "boolean"
              },
              "from": {
                "type": "object",
                "properties": {
                  "filePath": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 32768
                  },
                  "versionId": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "filePath",
                  "versionId"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "kind",
              "sheetName",
              "range",
              "targetSheet",
              "startCell",
              "mode"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "move_range"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "range": {
                "type": "string",
                "minLength": 2,
                "maxLength": 21,
                "pattern": "^[A-Za-z]{1,3}[1-9][0-9]{0,6}(?::[A-Za-z]{1,3}[1-9][0-9]{0,6})?$"
              },
              "targetSheet": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "startCell": {
                "type": "string",
                "minLength": 2,
                "maxLength": 10
              },
              "overwrite": {
                "default": false,
                "type": "boolean"
              }
            },
            "required": [
              "kind",
              "sheetName",
              "range",
              "targetSheet",
              "startCell"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "insert_rows"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "at": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1048576
              },
              "count": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1000000
              }
            },
            "required": [
              "kind",
              "sheetName",
              "at",
              "count"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "delete_rows"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "at": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1048576
              },
              "count": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1000000
              }
            },
            "required": [
              "kind",
              "sheetName",
              "at",
              "count"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "insert_columns"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "at": {
                "type": "integer",
                "minimum": 1,
                "maximum": 16384
              },
              "count": {
                "type": "integer",
                "minimum": 1,
                "maximum": 16384
              }
            },
            "required": [
              "kind",
              "sheetName",
              "at",
              "count"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "delete_columns"
              },
              "sheetName": {
                "type": "string",
                "minLength": 1,
                "maxLength": 31
              },
              "at": {
                "type": "integer",
                "minimum": 1,
                "maximum": 16384
              },
              "count": {
                "type": "integer",
                "minimum": 1,
                "maximum": 16384
              }
            },
            "required": [
              "kind",
              "sheetName",
              "at",
              "count"
            ],
            "additionalProperties": false
          }
        ]
      }
    }
  },
  "required": [
    "source",
    "changes"
  ],
  "additionalProperties": false
}
```

:::

## `create_workbook_version`

Prepare an immutable .xlsx output version from an existing source. The source is unchanged. Returns its content version and relative output path, not its cells. Repeating the same content reuses the output. This prepares a version; it does not create a new workbook or edit cells.

Annotations: non-destructive, closed world.

Available only with `--write <relative-output-directory>`. The registered JSON Schema below is the exact wire contract; nested operation variants are validated by the server.

:::details[Input JSON Schema]

```json
{
  "type": "object",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "properties": {
    "filePath": {
      "type": "string",
      "minLength": 1,
      "maxLength": 32768
    },
    "expectedVersion": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    }
  },
  "required": [
    "filePath"
  ],
  "additionalProperties": false
}
```

:::
