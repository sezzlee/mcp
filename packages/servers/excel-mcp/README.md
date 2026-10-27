# @sezzlee/excel-mcp

A standalone MCP server that reads local Excel files by default. Opt-in writing creates immutable output versions without changing the source.

Reads `.xlsx`, `.xlsm` and `.csv`, sandboxed to one folder. Sandboxing, the document cache, the error envelope, the cursor codec and the tool registration layer come from [@sezzlee/file-core](../../cores/file-core).

**Documentation: <https://docs.sezzlee.app/docs/excel-mcp/introduction>** — a tutorial, task guides, and the tool, error-code and limit reference generated from this package.

## Quick start

The server takes the folder it is allowed to read as its only argument, as an absolute path. Nothing outside that folder can be read.

```json
{
  "mcpServers": {
    "excel": {
      "command": "npx",
      "args": ["-y", "@sezzlee/excel-mcp", "/Users/me/sheets"]
    }
  }
}
```

With Claude Code:

```bash
claude mcp add excel -- npx -y @sezzlee/excel-mcp /Users/me/sheets
```

Requires Node.js 22 or 24 on macOS (x64, arm64), glibc Linux (x64, arm64) or Windows x64; file access goes through a native module with no JavaScript fallback.

## Author reports

Append `--write <relative-output-directory>` to enable writing inside the workbook root. Select a source with `prepare_edit`, then use the exact version in `edit_workbook`. `create_workbook` can publish values and ordered presentation changes together. Continue from a returned version or branch from an older retained one.

Authoring supports composable number/date/time/currency/percentage formats, font/fill/border/alignment changes, dimensions, frozen panes, visibility, basic print layout and safe merge/unmerge. Merging rejects non-anchor contents unless discarding them is explicitly requested. Scalar writes remain typed; formula-looking text stays text.

Explicit formula write/fill supports ordinary A1, mixed/absolute, sheet and structured table references. Table operations cover creation, renaming, header changes, growth/shrink, calculated columns, totals, filters and conversion to a range. New table styles are `SezzleeBlue` or `none`; conversion refuses unsupported affected styles and dependencies. Shrink preserves excluded values unless clearing is explicitly requested.

Table range resizing changes the row extent while retaining header position and width. Structural width changes use the explicit worksheet column operations first. Saved filter/sort criteria that need an unsupported transformation cause a refusal.

Bulk jobs can finish each selected output with ordered presentation/formula changes before atomic publication. A failed group leaves no partially finished report. Independent groups retain their successful outputs and report partial status; identical retries reuse durable results.

Authoring writes formulas without fabricated cached results and reports required recalculation. Use the separate `calculate_workbook` tool to evaluate the explicitly supported formula subset and save typed caches in a new version. Dynamic spilling arrays and new external workbook formula links remain outside this authoring profile. See [Phase 5 acceptance](docs/phase-5/implementation-status.md) and the [Phase 6 contract](docs/phase-6/implementation-plan.md).

### Explicit formula calculation

In writing mode, `calculate_workbook({source: {filePath, versionId}})` recalculates the selected workbook from its actual inputs. It returns a new immutable version, a calculation summary and up to 20 cell results. Longer string results and additional cells remain available in the saved workbook; the response reports omissions. Formula text, supported formatting, tables and unrelated package parts are preserved.

The `bounded-excel-v1` engine supports ordinary arithmetic, percent, concatenation and comparisons; SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, COUNTBLANK, IF, IFERROR, AND, OR, NOT, SUMIF, COUNTIF, ABS, ROUND, ROUNDUP, ROUNDDOWN, exact VLOOKUP, exact MATCH and scalar INDEX. References include rectangular A1 ranges, quoted/cross-sheet references, absolute static names with sheet scope and supported Phase 5 structured table references. Dates retain the workbook's numeric 1900/1904 serial system. Literal formula-looking text stays text.

`calculation.complete` describes whether every formula was evaluated within this subset; typed Excel errors count as evaluated results. Unsupported formulas, cycles and unavailable dependencies have distinct diagnostics and no retained stale caches. `cacheStatus` is `current` or `partial`. The saved file conservatively requests full recalculation when opened by a spreadsheet application; `recalculationRequired: true` describes that file setting, not a claim that successful server results came from an old cache. A later ordinary edit invalidates formula caches again.

Shared formulas are reported unavailable with caches cleared. Array/data-table groups, iterative calculation, precision-as-displayed, R1C1 formulas and unsupported preservation profiles are refused without publishing. Volatile functions, external workbooks, UDFs, dynamic arrays, approximate lookups, wildcard lookups, formula-defined names and relative name anchors are unsupported. SUMIF requires equally shaped ranges. Localized date/currency text coercion is outside the numeric-text subset.

Calculation is bounded to 128 sheets, 100,000 stored cells, 10,000 formula cells, 10,000 names, 8,192 formula characters, 100,000 cells per expanded range, combined depth 128 and 1,000,000 work steps. Limit exhaustion preserves the source and all retained outputs. Calculation is a separate version operation after a bulk job; it does not change that job's atomic publication boundary. No Excel installation or additional runtime package is required.

### Expert report authoring

The Phase 7 profile composes the operations below through `create_workbook`, `prepare_edit`, `edit_workbook` and bulk finishing. Every change produces a new immutable `.xlsx`; a failure publishes no partial version. The [implementation plan](docs/phase-7/implementation-plan.md) and [acceptance status](docs/phase-7/implementation-status.md) distinguish implementation from verification.

| Family              | Operations and support                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Names and templates | `define_name`, `delete_name`, `write_named_range`. Static rectangular A1 targets, workbook or sheet scope, quoted sheet names and exact typed input dimensions. Replacement requires `overwrite:true`; deleting a potentially referenced name refuses. Built-in names and table/cell-name collisions refuse.                                                                                                                                                                                  |
| Validation          | `set_validation`, `remove_validation`. Inline lists, whole/decimal/date/text-length comparisons and custom formulas. Date bounds are workbook serials. These are interactive Excel rules; the server does not enforce them on every later value write. Removal selects one stored rule by its complete range or by the ranges `get_data_validations` reports for it; replacement selects its complete single range.                                                                           |
| Conditional formats | `set_conditional_format`, `remove_conditional_format`. Comparison/expression rules, differential font/fill appearance, explicit priority and `stopIfTrue`. Replace an occupied priority explicitly. Unsupported extension rules are retained by unrelated edits, not silently converted.                                                                                                                                                                                                      |
| Content             | `set_hyperlink`, `set_note`, `set_image` and their matching `remove_*` operations. Existing internal A1/name links or HTTPS links without credentials; plain legacy notes; embedded PNG/JPEG with cell anchors. Existing cell values survive hyperlink changes unless `display` explicitly replaces them; an empty hyperlink cell gets its target as a text label. Removing an unshared image/chart also removes its unreferenced package content.                                            |
| Charts              | `set_chart`, `remove_chart`. Column, bar, line and pie charts; title, placement and explicit category/value ranges. Replacement rebuilds the selected object. Literal-source caches are checked against their dependencies; formula sources omit invented caches and report refresh. Unsupported outgoing object dependencies refuse removal/replacement.                                                                                                                                     |
| Pivots              | `set_pivot` creates or explicitly refreshes/replaces a real PivotTable, its private cache/records and saved results. One categorical row field; up to eight sum/count/min/max measures. Count counts nonblank values; numeric measures ignore nonnumeric values. Source range includes unique text headers. Formula and ISO-date cells require an explicit value/text/serial conversion first. Shared caches, advanced pivot extensions and external sources are outside the refresh profile. |
| Protection          | `format_cells` accepts `style.protection`; `protect_sheet` and `protect_workbook` author sheet/structure protection. Optional legacy protection passwords are printable ASCII, one to 15 characters. This is not file encryption. Start continuation with authenticated `unprotect_workbook`/`unprotect_sheet` operations for every locked target. Strong-hash, revision/window protection, encrypted, signed and macro-enabled editing remain refused.                                       |
| Recurring reports   | Use the existing version-pinned bulk job with `replace_values` and expert finishing. Shorter datasets clear the old tail; the period belongs in an explicit named text target. Identical jobs reuse durable completion. Formula calculation remains a separate immutable operation before final protection.                                                                                                                                                                                   |

Advanced object sources are bounded to 100,000 cells. A chart has at most 16 series and 10,000 points per series; pie charts have one series. A sheet has at most 64 pivots with 10,000 row groups per pivot, 256 validation rules, 256 conditional rules and 4,096 notes or authored links. Named targets are bounded to 4,096 per workbook. Drawings have at most 256 anchored objects. An embedded image has at most 5 MiB, 16,777,216 pixels and an 8,192-pixel side; total embedded media is bounded to 20 MiB. Existing transaction, input, output and cell budgets also apply.

Data/source changes invalidate affected chart caches and mark affected pivot caches invalid with refresh requested. Unrelated literal-source caches remain intact. Copy/move, sheet operations and row/column changes update supported references, ranges and anchors; affected pivot, VML, extension and other unsupported dependency profiles refuse atomically. Unknown retained parts are not a promise of arbitrary structural editing.

Reading is a separate capability: the existing tools inspect names, validations, conditional formats, images and charts, and read saved pivot result cells. Dedicated pivot-definition and legacy-note reader tools are not added by this authoring profile. Macros are never executed.

Independent Calc checks cover values, pivot/cache consistency, chart types/series, effective conditional fills and rule order, links, notes, images and protection. Calc does not retain `stopIfTrue` on export; this consumer limitation is reported separately. The original `.xlsx` flag is independently inspected and schema-validated. No desktop Excel UI acceptance is claimed.

## Tools

Numeric text coercion is limited to plain decimal/scientific strings. Formatted numeric, percentage, currency and date text that requires another conversion profile is reported unsupported, including in direct COUNT arguments and numeric criteria. It is not reported as an invented Excel error or hidden by IFERROR. Ordinary nonnumeric text retains the documented Excel error behavior.

| Tool                      | What it does                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_workbooks`          | Lists readable files under the root; the `filePath` it returns is passed to other tools verbatim                                                 |
| `describe_workbook`       | Sheets and their kind (worksheet or chart sheet), used ranges, counts of merges, validations, tables, formulas, images and charts, defined names |
| `profile_sheet`           | Bounded type and quality profiles with reusable column specifications                                                                            |
| `read_sheet`              | A cell range as a compact grid: hoisted column headers plus row arrays                                                                           |
| `aggregate_sheet`         | Grouped summaries, calendar and numeric buckets, bounded pivots, conditional metrics and exact percentiles                                       |
| `query_result`            | Exact filtering, column selection and stable paging over a retained complete aggregate snapshot                                                  |
| `find_in_sheet`           | Cells whose value or formula matches a query; without a sheet, in every worksheet                                                                |
| `get_tables`              | Excel Tables: range, header and totals rows, column names and letters                                                                            |
| `get_data_validations`    | Validation rules, one entry per stored rule with its ranges                                                                                      |
| `get_conditional_formats` | Conditional formatting rules as predicates                                                                                                       |
| `get_merged_ranges`       | Merged cell ranges                                                                                                                               |
| `get_images`              | Drawing and in-cell pictures: drawing name, anchor, alt text, size and extension. Charts belong to `get_charts`                                  |
| `get_charts`              | Charts: type, title, axes (incl. secondary, scale, format), series refs/points, trendlines, hidden series, pivot source. Chart sheets included   |

Every argument, error code and limit is listed in the [reference](https://docs.sezzlee.app/docs/excel-mcp/tools).

## How text is read as numbers and dates

A CSV holds only text, and a workbook may store numbers and dates as text too. `read_sheet` and default `find_in_sheet` return that text as written. `aggregate_sheet` reads it as a number or a date only where a metric or a `where` operand needs one, and decides the format per column from every value in the range: the decimal and thousands separators (`1.234,50`, `1,234.50`, `1 234,50`, `1'234.50`), and whether slash dates put the day or the month first. The marks or order that read the most values win. When the winners read some value differently (`1.234`, `01/02/2023`) the column is ambiguous: none of those values is read, and a warning names the `columns` entry that settles it. Accounting parentheses, a leading or trailing `%` (read as a ratio) and a currency symbol or code are understood; dotted dates are day first, and Turkish and English month names are read.

A digit run with a leading zero or more than 15 digits is an identifier and is never summed unless `columns` declares the column a number. A column whose amounts name more than one currency is summed as written and reported. Every value a call could not read, compare or sum is counted in `warnings` with examples, and `readAs` reports how each column's text was read. A time-only number format (`h:mm`, `hh:mm:ss AM/PM`) is returned as `HH:mm:ss`; elapsed `[h]`, `[m]` and `[s]` formats return `{"durationSeconds": number}` and can be summed in seconds.

## Which row is the header row

A call that names no `headerRow` reads by the row a declared table or the autofilter heads; failing
those, by the first of the top 20 rows of the used range whose filled cells are all text, at least
two of them and none merged across columns, provided no row above it holds a number, a date or
another non-text cell; failing that, by row 1. A header sits above its data, so a text-only data
row lower down, such as a row of `---` placeholders, is never taken for one. The response says which
(`headerRowSource`: `declared`, `scanned` or `default`). The scan always covers the whole used
range, so a call reading a few rows or a single column gets the same header row as one reading the
sheet, and a title band above the columns is skipped without the caller knowing it is there. A CSV
always reads row 1. `headerScan: true` asks for a strict detection: it refuses when two rows
qualify or none does. A header cell holding a number or a boolean names its column by its text, so
a year heading is addressable as `"2008"`.

## Warnings

A response's `warnings` is a list of `{ code, message, column? }`. Branch on `code`; `message` is
for a person and its wording may change. `column` is the letter a warning is about, when it is
about one.

| Code                        | Raised when                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| `csv_preamble_ignored`      | A `sep=` line names another delimiter than the one passed           |
| `csv_blank_first_record`    | The first CSV record is blank and stays the header                  |
| `table_missing_names`       | A declared table has columns without names                          |
| `header_row_mismatch`       | `headerRow` differs from the row a table or the autofilter declares |
| `header_row_unnamed`        | `headerRow` names no column while another top row does              |
| `header_only_range`         | A `read_sheet` range holds only the header row                      |
| `uncached_formulas`         | Formula cells carry no cached value                                 |
| `ambiguous_decimal`         | Values read differently with a decimal point and a decimal comma    |
| `locale_separator_conflict` | `locale` reads values as other numbers than the column's own marks  |
| `ambiguous_day_order`       | Dates read either day first or month first                          |
| `mixed_date_order`          | Slash dates read month first while dotted dates read day first      |
| `distinct_lower_bound`      | A profiled column has more distinct values than are counted         |
| `no_majority_type`          | No type holds a strict majority of a profiled column                |
| `identifier_text`           | A profiled column looks like identifiers and stays text             |
| `no_reusable_date_format`   | No single date format reads a profiled column's dates               |
| `prefix_sample`             | A profile describes only the first rows                             |
| `columns_not_profiled`      | Columns past `maxColumns` were not profiled                         |
| `mixed_units`               | A metric adds plain numbers, fractions or durations                 |
| `mixed_currencies`          | A metric adds different or unlabelled currencies                    |
| `case_variant_groups`       | Groups differ only by case or accent                                |
| `uncomparable_cells`        | `where` cells could not be compared with the operand                |
| `ungrouped_cells`           | Cells could not be read for a grouping key                          |
| `currencies_added`          | A column's amounts are written in more than one currency            |
| `unread_numbers`            | Text cells do not read as numbers and are left out of totals        |
| `identifier_cells`          | Cells look like identifiers and are left out of totals              |
| `unread_booleans`           | Cells do not read as booleans and are left out of boolean metrics   |
| `derived_division_by_zero`  | A derived metric divided by zero in a group and is null there       |

## Grouped analysis

A date is returned as `yyyy-MM-dd`. A date and time is returned as `yyyy-MM-ddTHH:mm:ss.SSS` with no
zone when the source stores none, which is every Excel date cell and every CSV value written
without an offset: it is a local wall clock, and a `Z` would claim UTC. A value written with an
offset keeps its wall clock and offset (`2019-12-31T23:40:00.000+03:00`) and is ordered by its
instant.

`groupBy` accepts a column name or a closed transformation. Calendar groups use UTC after applying
an explicit timestamp offset. Month and quarter keys include their year, weeks use the ISO
week-year, weekdays run from Monday 1 to Sunday 7, and hours run from 0 to 23. A plain column
keeps its stored key unless `columns` explicitly types it or a metric or condition already needs
a typed reading of that same column. Reading the cells still returns their original values.

Numeric `bins` are strictly increasing boundaries with a separate underflow and overflow group.
Intervals include their lower boundary and exclude their upper boundary. A fixed `width` uses
an optional `origin` (zero by default); canonical decimal arithmetic places `0.3` exactly on a
`0.1` boundary without moving the preceding representable value into that bucket. Boundaries
that cannot be represented as distinct finite numbers are refused. A missing key forms the
null group; an unreadable derived key is counted in `ungroupedRows` with examples in `warnings`.

`pivotBy` turns bounded grouping keys into output columns, one column for each key and metric.
Missing combinations return zero for counts and null for numeric metrics. The complete row-key
count × pivot-key count × metric count is checked before a dense result is allocated, even when
the input contains only a few of those combinations. The cap is 10,000 metric cells.

`median`, `p50`, `p90` and `percentile` use exact inclusive linear interpolation (R7), matching
[Excel's PERCENTILE.INC](https://support.microsoft.com/en-us/excel/functions/percentile-inc-function).
The percentile argument is between zero and one, inclusive. Samples shared by identical metric
selections are retained once, with a one-million-value budget across the call. A request that
exceeds the budget is refused, never silently changed to an approximation. Each metric may
have its own `where`; these conditions are combined with AND after the call's top-level filter.
`counted`, `skipped` and `filtered` distinguish usable values, unreadable or missing values, and
rows excluded by that metric's conditions.

`groupingSets` adds independent breakdowns beside the primary result in one scan. Each set has
its own grouping keys and diagnostics, while column readings and global resource budgets are
shared. `compact` reduces repeated provenance while retaining loss and ambiguity diagnostics.
The 2,000-row, 15-column commerce regression in `test/aggregate-analysis.spec.ts` checks an
overall total, country, category, payment and 36 monthly breakdowns in one response under 8 KiB.

A metric's `round` rounds its numeric result half away from zero, as Excel's `ROUND` does;
sorting uses the unrounded value. `derived` computes up to four values from each group's metrics
after aggregation: a numerator and an optional denominator, each a sum of `factor × metric`
terms, then `scale` and `round`. A term with `scope: "total"` uses the metric summed over every
group before `maxGroups`, which gives a group's share of the total; it accepts only metrics that
add up (`count`, `countValues`, `countTrue`, `countFalse`, `sum`). A zero denominator gives null
and a `derived_division_by_zero` warning. `orderByDerived` sorts by one of them. Derived values
are not offered with `pivotBy`.

Requested total-scope metrics use checked compensated summation over the groups. A non-finite
total or intermediate derived calculation refuses the call with `numeric_overflow`, in both
inline and retained modes; no retained identifier is published. Missing inputs and zero
denominators keep their null behavior. Cross-group totals are calculated only for metrics
referenced with `scope: "total"`, so an unrequested total cannot reject valid finite groups.

`inColumn` and `notInColumn` keep the rows whose cell is, or is not, among the values of another
column, named by `source`: a sheet and column of the same file or of another file under the
root, opened through the same gates. Values match as `eq` compares them, never trimmed; the
source holds at most 100,000 distinct values (`maxSourceValues`). Two calls, one in each
direction, answer which keys one list has and the other lacks. This is a filter, not a join:
no columns of the source are returned.

## Continue on a complete aggregate result

`aggregate_sheet` already computes over the complete selected range under its existing
processing budgets. The default `resultMode: "inline"` keeps the existing response: `maxGroups`
bounds the groups shown after calculation. For a large breakdown that needs another operation,
pass `resultMode: "retained"`. This explicit choice is deterministic; even a small retained
result gets an identifier, while ordinary small calls allocate no retained-result entry.

Retained mode accepts every aggregate shape inline mode accepts. A pivot is stored one row per
group, in the inline pivot's columns: group keys, then each pivot key's metrics with its
`pivotKey`, then derived metrics. Each `groupingSets` entry is a separate result with its own
`resultId`, listed under `groupingSets` in the response beside its columns, counts and preview
rows. The primary result and its grouping sets are admitted together or not at all.
`inColumn`/`notInColumn` members are read once before the calculation; when they come from
another file, `memberSourceVersions` lists that file's captured fingerprint. The complete
calculation still uses the existing `SheetView`, typed interpretations and aggregate state/visit
budgets. A failure publishes no partial result or identifier. No workbook is changed and there
is no code execution API.

The returned `resultId` identifies all finalized result rows, captured before response string
truncation and independently of `maxGroups`. `query_result` can select original result columns
by one-based position, apply AND-combined exact scalar equality filters, and read pages in the
original aggregate order. Filtering visits the complete retained result. It does not reopen,
hash or parse the source. Equality is case-sensitive and performs no trimming, normalization,
coercion or ranked text retrieval. The stored numeric values include requested metric rounding;
the original aggregate order was determined before that rounding, as in inline mode. There is
no follow-up sorting or reaggregation in this slice.

The response distinguishes these scopes:

| Field                                                       | Meaning                                                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `sourceVersion`, `sourcePolicy`                             | Captured content fingerprint and `snapshot` policy; source edits do not change this result                        |
| `sheet`, `range`, `headerRow`, `scannedRows`, `matchedRows` | Original source selection and completed scan/filter counts                                                        |
| `resultComplete`, `sampled`                                 | `true` and `false`: the selected calculation completed without sampling; these do not claim every cell was usable |
| `totalRows`                                                 | Complete stored result row count, independent of the preview                                                      |
| `matchingRows`, `matchingSourceRows`                        | All result rows matching the follow-up query and the original matched source rows they represent                  |
| `returnedRows`, `returnedMatchedRows`                       | Result rows actually displayed and their represented original source rows                                         |
| `offset`, `hasMore`, `nextOffset`                           | Page position and continuation among matching result rows                                                         |
| `preview`                                                   | `true` on the initial retained response; `false` on a follow-up page                                              |
| `totalColumns`                                              | Present when a preview shows only the leading columns; select the rest with `query_result` `columns`              |
| `valueTruncation`                                           | Count of displayed cells shortened by the existing presentation rules and their string limit                      |

`columnNumbers` maps projected output columns back to their original one-based positions.
Repeat the same `resultId`, `where` and `columns` with `nextOffset` until `hasMore` is false.
Offsets are deterministic within this immutable result and the same query. Changing filters
defines a new query and should start at offset zero. Result columns' `counted`, `skipped`,
`filtered` and unit/currency diagnostics describe the complete stored calculation, including
when a page projects fewer columns or filters fewer rows. Existing `warnings`, `readAs`,
`columnStats`, error distribution and ungrouped counts remain available; completion does not
erase exclusions, ambiguity or missing formula caches.

### Ownership, lifetime and admission

Each `createHandlers(root)` owns its store. Opaque random identifiers work only in that handler
instance and the configured root authority it already has. Another server instance, even with
the same root, cannot read them. There is no tenant, user or session authorization layer beyond
this existing instance scope; a host sharing one server instance shares its retained results.
The metadata carries the root-relative `version.filePath` every read reports, never an absolute path. Source changes or deletion leave an admitted
snapshot readable until expiry; a new aggregate captures the current source independently.

| Budget             | Bound and behavior                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Complete result    | 100,000 rows, 1,000,000 cells and 8 MiB of accounted serialized data; every bound must pass                                                      |
| Per-instance store | Four live results and 16 MiB total accounted serialized data                                                                                     |
| Lifetime           | Absolute 15 minutes from admission; reads do not refresh it                                                                                      |
| Preview and page   | 16 KiB of serialized `CallToolResult`, including metadata, envelope and JSON escaping; at most `maxGroups`/`maxRows`, default 50 and maximum 500 |
| Equality input     | At most 16 conditions and 4,096 characters per string value                                                                                      |

Row values and represented-source counts are admitted incrementally, with metadata counted
before publication. These serialized-byte limits are accounting limits, not exact JavaScript
heap or process RSS guarantees. Row/cell/entry limits also bound object overhead and query work.
Source workbook/cache memory remains subject to its existing separate limits.

Expired entries are removed on store access or admission, and closing the server clears the
store. Idle expired allocations can remain until the next access, always within store bounds.
There is no disk storage, service or background timer. Capacity exhaustion returns
`resource_limit` and preserves live results; wait for expiry, request fewer/smaller results or
restart the instance. Unknown, expired, cleared and foreign identifiers all return
`result_unavailable`, with recovery to run a new retained aggregate. A preview that cannot fit
its required metadata and one row fails before admission. Every result in a preview first keeps
one column and, when it has rows, one row; each then widens to all its columns in order, and only
then takes more rows in order, so a wide pivot or a large primary breakdown cannot crowd out a
grouping set. A follow-up row that cannot fit
fails with projection guidance instead of returning a non-progressing page. Every response
still goes through the existing `json()` constructor and mandatory `guard()` payload gate and
root-redacted error envelope. Retained allocation makes `aggregate_sheet` non-idempotent in its
MCP annotation; all tools remain read-only with respect to source files.

### Why existing limits stay in place

Classification follows the enforcement point, rather than the name of a constant:

| Purpose                      | Existing examples and enforcement                                                                                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Processing/resources         | Native 50 MiB workbook and 16 MiB CSV input gates; CSV's two-million-cell tokenizer cap; four-entry parsed-file cache; OOXML expansion limits; aggregate's 20-million cell visits, 100,000 groups, 200,000 metric states, one-million exact samples/distinct values, and 10,000 dense pivot cells |
| Responses/context            | `maxGroups` slices already completed groups; search-result limits bound displayed matches while counting the full search; 512-character cell presentation and the 512 KiB emitted text-payload guard                                                                                              |
| Both work and response/scope | Read-page cell limits bound presentation work and output; profile row/column/cell caps intentionally sample a prefix; diagnostic/example and chart-point caps bound retained reporting state and displayed detail                                                                                 |

Aggregate execution is synchronous and bounded by visits and state, not by a new wall-clock
deadline. Regex has its own worker, concurrency and timeout limits, which this change does not
alter. The retained-result budgets are additional limits, not replacements for processing
guards. The distinction follows [context-mode's retain-before-emission principle](https://github.com/mksglu/context-mode),
but uses structured complete numeric results: text snippets cannot establish a full sum, and
KV-cache reuse does not remove new response bytes from context.

The repeatable MCP payment scenario, independent expectations, external corpus entry and
commands live in [the Excel lab README](../../lab/excel-lab/README.md). It measures exact counts
and serialized responses without a model; it does not claim agent success or token savings.
Future result operations and write capabilities are tracked in the root [roadmap](../../../ROADMAP.md).
The [architecture recommendations](ARCHITECTURE_RECOMMENDATIONS.md) map the current layers to
Excel's package, dataset and analytical schemas, identify a reproduced derived-total overflow
defect, and prioritize existing-tool improvements and possible new operations. They distinguish
review findings from proposed behavior; the recommendations are not an implemented contract.

## Profile and reuse a column interpretation

`profile_sheet` samples a rectangular prefix (1,000 data rows and 16 columns by default), with
hard limits of 5,000 rows, 64 columns and 64,000 cells. It reports sampled and omitted rows and
columns. Confidence is the dominant readable kind divided by non-missing sampled values; it is
not a probability about unseen data. Each profile reports formats, missing counts, a distinct
count, extrema, frequent values, unreadable examples and identifier signals. Distinct tracking
stops at 1,000 values per column; the count becomes a lower bound and the reported frequencies
are explicitly incomplete. Tied or ambiguous kinds remain mixed.

The result's `columns` array and `columnMode: "letter"` can be passed directly to the other grid
tools. A recommended number column always includes `identifiers: "refuse"`, so leading-zero
or long digit identifiers beyond the sampled prefix are still excluded and counted. An explicit
number column supplied by the caller keeps the earlier default `identifiers: "read"`.

A recommended date plan is checked against every sampled date using the explicit reader. When
an order-free plan cannot preserve the sample, a day-first column takes `order: "dmy"`, which
reads dotted dates day first as well. A month-first column is pinned by a fixed numeric pattern
instead, because an explicit order would also reorder dotted dates after the sample.
If one explicit plan cannot represent the observed mixture, the recommendation keeps text and
adds a warning. A later value outside a fixed pattern remains raw and is counted as unreadable
in typed output. Date specifications explicitly supplied by the caller retain their format/order.
For those explicit dates, `readAs` and unreadable diagnostics describe the requested conversion;
the inferred type, confidence and value distribution still describe the observed sample.

`read_sheet` preserves its raw `values`. With explicit `columns` and `includeTyped: true`, it adds
a parallel `typedValues` grid. Missing and unreadable cells become null only in this added grid;
the `typed` diagnostics distinguish them and include bounded examples. Columns left unspecified
keep their original type. The interpretation, locale and literal lists travel in the cursor;
conflicting options are refused. `find_in_sheet` with `columns` searches canonical values in those
columns, returns raw `value` plus `typedValue`, and counts conversion failures over the scanned
populated cells. Without `columns`, searches keep their existing raw-text behavior.

The `typedValues` capability in `describe_workbook` describes native stored cell types. CSV reports
false because its cells are text; explicit typed reading is still available. A known file and
columns can be read or aggregated directly. Listing, workbook description and profiling are
discovery steps for information the caller does not yet have.

### Locales, missing values, booleans and durations

CSV decoding accepts explicit UTF-8/UTF-16, Windows-1251/1252/1254/1256, ISO-8859-9,
Shift_JIS, GB18030, Big5 and EUC-KR. Legacy encodings are never guessed, and malformed multibyte
sequences are refused. The same encoding selection is retained in paging cursors.

A first decoded physical line consisting exactly of `sep=X` or `"sep=X"` declares a comma,
semicolon, tab or pipe separator. The `sep` keyword accepts ASCII case variants; whitespace,
other separators and later lookalikes remain ordinary data. A tab must be the actual character,
not the two-character spelling `\t`. The recognized line is removed before header selection
and record, ragged, blank and formula-like counts. The first remaining record is sheet row 1;
syntax faults still report physical file lines, and `csv.lineBreak` includes the declaration's
line ending. With no explicit delimiter, `csv.delimiterSource` is `"sep"`. An explicit
`delimiter` wins and keeps source `"explicit"`; a conflicting declaration adds a warning but
is still removed. BOM and strict decoding checks run first. See the
[CSV profile recipe](../../../apps/docs/src/content/excel-mcp/recipes/07-profile-and-read-global-data.md).

An explicit number column may provide `locale` and `numberingSystem` instead of decimal/group
marks, for example `{"column":"Amount","type":"number","locale":"ar-EG","numberingSystem":"arab"}`.
Decimal digit systems, local separators, signs and grouping sizes are compiled from the runtime's
Intl data, including Indian 3+2 grouping. Unsupported locales or numbering systems are refused.
A date column accepts a fixed `format`, an explicit `order`, or unambiguous dates. An explicit
locale supplies Gregorian month names, including format and standalone forms, but never the
day/month order: inferred slash and dash dates take it from the column's values, while inferred
dotted dates use a day-first convention under every locale. A dotted value that can only be read
month first makes the inference ambiguous; slash dates that read both ways leave dotted dates
day first. An inferred month-first order is left out of `readAs` when the column also holds a
dotted date it would move, with a warning. An explicit date `order` also applies to dotted dates;
`format` pins the separators as well. A locale names the file's language, not the reader's; when
its separators read a value as a different number than the column's own marks, a warning names
the value. Non-Gregorian calendar
requests are refused. Omitting the locale retains deterministic existing numeric/date inference;
it never selects the host locale. Unicode decimal digits are normalized without
turning circled digits, Roman numerals or arbitrary compatibility characters into quantities.

The closed date grammar accepts literal Chinese/Japanese `年 月 日`, Korean `년 월 일`, and Russian
`г` markers in an explicit pattern, such as `yyyy년 M월 d일` or `d MMMM yyyy г.` with `ru-RU`.
These full marker forms are not automatically inferred. Weekday prefixes, eras and arbitrary
quoted literals are outside the supported grammar.

`missingValues`, `trueValues` and `falseValues` are configurable lists, with per-column overrides.
Default missing tokens are N/A, NULL, -, — and #N/A. Null and blank strings are always missing;
`missingValues: []` preserves the other tokens as literal text. A stored Excel error is still an
error. True tokens are true, yes, y, Evet and E; false tokens are false, no, n, Hayır and H.
A caller's list takes its words from the defaults of the other two lists. A column is read as
booleans, or as durations, only when such values outnumber the values that read otherwise, so a
grade `E` or a stray `100:30` does not re-read the rest of the column. A text comparison still
matches a cell whose text is a missing token: `eq "N/A"` finds `N/A`.
Matching folds case and accents, accepts configured tokens in any script, and rejects overlapping
lists. Numeric zero and one are not automatically treated as booleans. `countTrue`, `countFalse`
and `trueRatio` operate on valid booleans; the ratio is null when none are readable.

A `time` column reads a clock such as `8:15` as `08:15:00`. A `duration` column reads elapsed
hours or fixed ISO day/time durations, for example `25:30` or `P1DT2H`, into
`{"durationSeconds":91800}` or `{"durationSeconds":93600}`. Calendar years/months and leap seconds
are refused. Numeric duration metrics use seconds and report the unit. Automatic duration
reading requires a duration cue in the column; pure clocks are not summed as durations.
Percent and per-mille quantities are fractions, with unit metadata; currency labels are retained
without exchange-rate conversion. See the [CSV profile recipe](../../../apps/docs/src/content/excel-mcp/recipes/07-profile-and-read-global-data.md)
and the reproducible generator/fuzz instructions in the repository's lab.

## Named tables and saved row visibility

`read_sheet`, `profile_sheet`, `find_in_sheet` and `aggregate_sheet` accept `table: "Orders"`.
The name selects a declared table across the workbook; `sheetName` restricts the lookup.
Names use Unicode folding and ambiguous matches are refused. The selected range is the table's
data body, excluding its header and totals row. Column references use the table's declared names,
including when its header row is hidden. A table cannot be combined with `range` or a conflicting
`headerRow`. Tables with no declared data rows and unsupported header/totals row counts are explicitly refused. A declared body containing only blank cells remains readable.

Pass `visibleOnly: true` to omit saved hidden rows. This covers manually hidden rows and the
rows an author saved as hidden after applying AutoFilter. The reader uses those saved flags;
it does not reevaluate filter criteria. Every such answer includes `visibility` with
`basis: "savedHiddenRows"`, `hiddenRowsSkipped` and `filterCriteriaReevaluated: false`, plus the
relevant AutoFilter range when one is declared. Conditions saved without matching hidden flags
do not remove rows. Excel's saved row visibility and its filter definition are separate data.

Filtered reads add `rowNumbers` beside `values`, preserving each row's original worksheet address.
The cursor binds both `table` and `visibleOnly`; omitted options are inherited and conflicts are
refused. `hiddenRowsSkipped` covers the visited page for reads, the full selected range for search
and aggregation, and the selected data rows for profiles. Profile totals and sampling limits count
eligible visible rows; hidden omissions are reported separately. CSV supports neither table
metadata nor hidden-row flags, so `table` and `visibleOnly: true` are refused for CSV.

## Native number formats and rich cell values

Native numeric cells retain the meaning of their active number-format section. Elapsed `[h]`,
`[m]` and `[s]` tokens return seconds, including negative values and durations beyond 24 hours,
independently of the workbook's date system. Percentage formatting adds `unit: "fraction"`
without scaling an already stored fraction: 0.25 stays 0.25. Explicit currency tokens flow into
aggregate metric descriptors; ambiguous currency symbols keep their symbol label. Conditional
sections are selected before interpreting tokens, and quoted or escaped literals cannot turn an
ordinary number into a date or percentage. This is a bounded semantic reader, not a full display
renderer; unsupported format syntax preserves the native numeric value. The rules follow
[Microsoft's number-format specification](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/17d11129-219b-4e2c-88db-45844d21e528).

An in-cell image returns an `imageId` with optional `altText` and `decorative` fields
instead of its `#VALUE!` compatibility cache. `get_images` also lists it with `anchor: "inCell"`,
its source `cell` and the same media ID. Verified rich-image relationships may target other
internal package paths; IDs stay stable across worksheets and call order, preserving existing
media IDs. Drawing images now retain their saved alternative text.
The supported linked-data shape is `_linkedentity2`: a closed `linkedValue` object contains the
saved `displayText` and, when present, its entity ID, culture and numeric service ID. No linked
provider is refreshed, no external image is downloaded, and nested property bags are not expanded.
Search matches the complete saved alt text or linked label before presentation limits are applied.
Unknown rich types retain their stored scalar and an explicit unsupported `richValue` note;
malformed referenced indices or relationship chains are refused as `corrupt_workbook`.

Array-formula notes retain the anchor, declared `ref`, `dynamic` flag and optional `collapsed`
flag. Cached spill members retain their values and refer to the same array anchor. The reader
never recalculates formulas or fills missing caches. Native and metadata-backed `#SPILL!` and
`#CALC!` errors carry an explanation without guessing the obstructing cell or calculation cause.
The fixed original XlsxWriter and Microsoft Open XML SDK fixtures, independent XML verifiers,
licenses and verified coverage boundaries are recorded in
[RICH_VALUE_SOURCES.md](../../lab/excel-lab/RICH_VALUE_SOURCES.md).

`aggregate_sheet.errorDistribution` counts distinct participating native-error cells after
call-level and metric-level filtering. Repeated metrics, grouping sets and pivots do not multiply
a physical cell's count. Up to 32 codes have three example addresses each; extra or overlong codes
enter an explicit `other` bucket. Numeric, boolean and extreme metrics report `skippedErrors`
as a subset of `skipped`. Stored errors still count for `countValues` and `countDistinct`.
Images and supported linked values are not classified as errors.

## How the metadata is read

Every tool reads the OOXML parts directly through `@sezzlee/ooxml-core`: cells, number formats, formulas, hyperlinks, merges and defined names as much as data validation, Excel Tables, conditional formatting, images and frozen panes. No spreadsheet library is present at runtime. SheetJS and exceljs are dev dependencies: exceljs writes the test fixtures, and SheetJS is the reference the cell reader is compared against.

The OOXML parts are read namespace-aware by `@sezzlee/ooxml-core`'s own XML tokenizer. Matching is done on `(namespace uri, local name)` — the prefix the file happens to write is never consulted — so `<x:dataValidation>` and `<dataValidation>` are indistinguishable at the call site. Relationships resolve supported worksheet, style and shared-string parts, including prefixed .NET output and a worksheet part named `sheet.xml`. The workbook root is currently required at `xl/workbook.xml`; arbitrary OPC workbook-root layouts are not supported.

| tool                      | source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_data_validations`    | worksheet part, `dataValidations/dataValidation`. Each stored rule is one entry, never merged with an equal one. Ranges are taken verbatim from `sqref`, not opened cell by cell — a rule covering an entire column still counts as exact, so `dataValidationRuleCountExact` is always `true`                                                                                                                                                                                                                                                                                                                                                                             |
| `get_tables`              | worksheet `tableParts` → sheet rels → `xl/tables/*.xml`. `filterButton` is matched by `colId`, not by position                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `get_conditional_formats` | worksheet `conditionalFormatting/cfRule`. The `containsText` family is parsed into type + operator. A `cfvo type="formula"` threshold's expression is preserved in the `formula` field                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `get_images`              | Cell `vm` → workbook sheet metadata → rich-value structures and relationships → media for in-cell images. Drawing pictures use worksheet `drawing` → sheet rels → `xl/drawings/*.xml` → `a:blip r:embed` → drawing rels → `xl/media/*`. `twoCell`, `oneCell` and `absolute` anchors are all reported. Only a two-cell anchor gets a `range`; a one-cell anchor gets its top-left `cell` and its size in whole pixels, because the cells that size covers depend on column widths, and an absolute anchor gets the size alone. `get_charts` places a chart the same way                                                                                                    |
| `get_charts`              | worksheet or chart sheet `drawing` → chart / chartEx frames → `xl/charts/*.xml` for type, title, axes (min/max/log, number format), series refs and cached points, trendlines and `pivotSource`. Every element is matched under its parent, so a data label's `c:tx` is never a series name. A number cache is returned as numbers and a text cache as text, with the cache's `numberFormat`; a multi-level category keeps its outer `levels`. An axis is `secondary` when the first plot does not use it. A series under `c15:filtered*Series` is listed as `hidden`. Markup Compatibility chooses one `AlternateContent` branch. `chartEx` is reported as `unsupported` |

`describe_workbook` marks each sheet's `kind` as `worksheet` or `chartsheet` and reports `chartCount`. A chart sheet is refused by `read_sheet`, `profile_sheet`, `aggregate_sheet`, `find_in_sheet` and `get_merged_ranges` as `chart_sheet`, with recovery pointing at `get_charts`. A call without `sheetName` lands on the first visible worksheet, never on a chart sheet, except `get_charts`, which takes the first visible sheet of either kind. Pivot tables and sparklines remain unread. `get_images` with `kind: "chart"` still returns `unsupported_object_kind` and points at `get_charts`.

A corrupt-file claim is split into three codes, and none substitutes for another: `not_a_workbook` (not a zip archive, or a zip with no workbook part or no worksheet), `encrypted_workbook` (an OLE2/CFB header — password-protected or legacy binary) and `corrupt_workbook` (a damaged archive: a part that fails its CRC-32 check, a local header that disagrees with the central directory, or a part that is not well-formed XML or valid UTF-8). A damaged worksheet is refused only by the calls that read that sheet, so the workbook's other sheets stay readable. A CSV is split into records by the server's own RFC 4180 tokenizer, where CRLF, LF and CR each end a record outside quotes; malformed quoting is `corrupt_workbook` with the fault and its line, and is never repaired. `internal_error` carries no `recovery`: there is no known next call, and pretending there is one sends the agent off to repair a file that is fine.

## Development

```bash
pnpm turbo run build --filter=@sezzlee/excel-mcp
pnpm turbo run test --filter=@sezzlee/excel-mcp
pnpm turbo run check-types --filter=@sezzlee/excel-mcp
```

Run tests through Turbo, not `pnpm --filter @sezzlee/excel-mcp test`: the bare filter skips `dependsOn: ["^build"]`, and this package resolves `@sezzlee/file-core` through `exports.default → ./dist/index.js`, so a bare filter can test against a stale `dist`.

A change to a tool's arguments, an error code or a limit changes the generated reference in `apps/docs`; run `pnpm --filter @sezzlee/docs gen` and commit the result, or `pnpm turbo run validate --filter=@sezzlee/docs` fails.

## Bulk job contract

Bulk tools require the explicit writing mode described below. prepare_bulk_job and run_bulk_job take the same job descriptor. kind dependent contains one group {steps, outputs}; kind independent contains jobs [{id, group}]. Steps execute in declaration order and may reference only earlier step IDs. Missing/duplicate IDs, invalid later steps and unsafe output dependencies refuse before publication. Preparation dry-runs the actual editor, revalidates every original source and returns exact group identities; it never grants authorization or freezes a mutable file.

Every step uses kind. A read step selects an exact source {filePath, versionId}, obtained from prepare_transfer or a retained receipt, and a nested selection {kind: records, sheetName, range, headerRow}. A range is closed and starts at its positive headerRow; a named table uses its declared header. CSV values remain text unless selection.columns explicitly requests readings such as {column: Total, type: number, decimal: "."}. The existing complete-selection, saved-cache and explicit-row-subset rules apply. All bulk operators work on typed values; they do not evaluate formulas or create styles.

Supported steps:

- update sets explicit cells using set [{column, value: {kind, value}}] and transfer-style where conditions. remove requires clear or delete_rows; filter produces a dataset rather than hiding/deleting source rows.
- keyed_update and upsert name source and target step IDs, keys/set arrays of {sourceColumn, targetColumn}. Keys preserve type, case, whitespace and Unicode normalization. Missing keys and duplicates block by default. Explicit missingKeys: skip and duplicates: first/last change those rules and are counted. Upsert requires mappings for every inserted target field. Key reassignment is refused.
- replace combines a target list and replacement dataset. With an edit/replace_values output it clears the complete old tail, retains formatting and preserves outside content. Headers and record count are explicit, including empty replacement.
- append follows the declared input order and an explicit output column list; differing names require prior projection/renaming. Missing fields require explicit missingColumns: blank. No automatic type widening occurs.
- join supports inner/left/full, explicit left/right key mappings and explicit output columns {side, column, as}. Duplicates require a rule; manyToMany must be explicit and expansion is bounded before publication. Unmatched outer fields are typed blanks.
- deduplicate requires keys and keep: first/last/drop_all/report/duplicates_only. report retains the dataset and reports counts; duplicates_only produces the actual duplicate records. Missing keys require explicit keep/group behavior; they block by default.
- sort is stable and requires per-column direction and blank placement. Mixed types require explicit type_order or cause refusal. Default text comparison is deterministic UTF-16 order; locale collation requires an available explicit locale.
- project selects, renames and orders fields, refusing duplicate output names. transform supports typed constants, trim, case with explicit locale, and the existing explicit number/date/boolean/text reading contracts. Conversion errors block unless onError explicitly selects blank or keep; failures are counted. Time-only/duration output and arbitrary scripts are excluded.

Outputs are new, edit or edit_workbook. A new output builds named sheets from dataset step IDs; it is a data-only report and does not carry unrelated source parts. An edit names the original target read ID and the final input dataset ID. changed_values preserves untouched cells, formulas and supported package content; physical row identity is retained. Equal saved values leave an existing formula intact. Reordering, filtering away records, deduplication that removes records, header changes and whole-list replacement require explicit replace_values. That mode intentionally writes values, including saved formula results, across the declared list while retaining styles. No formula-preserving copy silently falls back to values. edit_workbook combines distinct-sheet edits from one exact original workbook; same-sheet changes are combined in a single dataset pipeline before writing.

Occupied changes require explicit overwrite. Expanding a list into occupied content beyond its declared extent refuses. Physical row removal refuses when the same rows contain content outside the selected columns, and still passes the Phase 3 structural dependency guards. Basic named tables keep names/columns and update their range/filter metadata on row replacement or growth. Resizing totals-bearing tables, changing table column names/width and unsupported affected dependencies refuse; use an explicit supported structural edit instead. Formula caches and chart/pivot refresh facts retain Phase 3 behavior, with no recalculation claim.

One dependent group is fully prepared in memory, including every output, then the generic native capability publishes its entire directory with no replacement. The final job directory appears with every workbook and its completion manifest together. Internal .pending-* directories may remain after process/system failure; they are never completion records or returned output versions. Originals and retained outputs stay immutable. No per-file rename sequence is presented as an atomic group. A committed result is verified before rereading originals on retry, so a lost response/process restart does not cause a second append or upsert even if an original subsequently changed. Changed sources before a first commit require a new exact selection.

Independent jobs have separate commit boundaries and return complete/partial/failed/pending with exact per-job outputs and counts. Retrying reuses completed children and attempts only unfinished children. Durable status gives a verified completion priority over a retained failure. Failure diagnostics identify current_attempt versus first_failed_attempt and whether that diagnostic was retained; a diagnostic-write failure does not discard successful independent outputs. get_bulk_job verifies each output hash and refuses corrupt completion records. Counts describe each operator's input/output population; join expansion and duplicate skipping are not one global sum equation. Detailed step counts are retained in the manifest, not full source records.

Receipts are limited to 128 KiB per group. A large batch returns completed children with details: summary, their group jobId and output/step counts; call get_bulk_job with that child jobId for its full verified receipt. Smaller batches use details: full. Completion inventory is verified against the stored request before a retry is accepted.

The job guard profile is explicit: 32 steps/group, 16 independent jobs, 16 outputs/group, eight source snapshots, 100,000 records/dataset, 256 columns, 1,000,000 cells/dataset, 2,000,000 combined intermediate cells, 64 MiB combined snapshot/text budgets, 16 MiB serialized key candidates, 20,000,000 predicate/join/sort visits, 256 expanded editor changes, a 64 KiB descriptor and a 50 MiB output group including its manifest. The legacy 128-operation editing API is unchanged; the separate bulk expansion bound is enforced internally. These are refusal bounds, not throughput guarantees. Measured correctness, scale and acceptance scope are in the [Phase 4 plan](docs/phase-4/implementation-plan.md).

## Optional writing mode

Reading remains the default. Enable writing explicitly with an existing output directory below the workbook root:

```sh
mkdir -p /absolute/workbooks/out
sezzlee-excel /absolute/workbooks --write out
```

This adds six own-output tools, four read-only preparation tools and one read-only status tool. They never overwrite a source or an existing output. Single-version names use SHA-256 content versions; bulk groups use an immutable job directory containing content-addressed workbooks and a completion manifest. Identical requests reuse verified outputs. All writing-mode tools share one admission slot per server.

| Tool                    | Behavior                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| create_workbook         | Create an immutable .xlsx from a non-empty ordered list of named sheets. Each sheet may contain rectangular blocks with an explicit A1 startCell. Omit blocks for an empty sheet.                                                    |
| calculate_workbook      | Evaluate the supported formula subset from an exact source version, return bounded results and diagnostics, and save typed caches in a new immutable .xlsx.                                                                          |
| edit_workbook           | Atomically edit an exact .xlsx version: values, clear, sheets, ranges and rows/columns, preserving supported existing content and dependencies.                                                                                      |
| create_workbook_version | Validate and prepare an immutable copy of an existing .xlsx, without changing sheets or cells. Its optional expectedVersion rejects a changed source. Copying an external workbook does not make it eligible for Phase 1 editing.    |
| prepare_transfer        | Select complete range values, filtered/projected records or a grouped summary from .xlsx/.xlsm/CSV. Returns a version-pinned transfer reference and counts, without returning the dataset or writing a file.                         |
| prepare_edit            | Dry-run the complete edit against an exact source, returning policy blockers or a ready preservation profile without publishing.                                                                                                     |
| transfer_data           | Materialize that selection internally and publish it to a new workbook, new sheet or selected authored sheet. Rejects changed sources and occupied targets without explicit overwrite; supports positional or unique-header mapping. |
| prepare_bulk            | Analyze exact source/target record versions for keyed update or upsert, returning bounded key conflicts and projected effects without writing. Full execution uses the bulk job tools.                                               |

Bulk job tools use the same explicit writing mode:

| Tool             | Behavior                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| prepare_bulk_job | Validate all ordered steps and dry-run every output without publishing.                                                  |
| run_bulk_job     | Commit a dependent output group atomically, or run independent groups with explicit partial success and resumable retry. |
| get_bulk_job     | Read durable completion and verify output hashes without rerunning the job.                                              |

A create_workbook input:

```json
{
  "sheets": [
    {
      "name": "Expenses",
      "blocks": [
        {
          "startCell": "A1",
          "values": [
            [
              { "kind": "text", "value": "Item" },
              { "kind": "text", "value": "Amount" }
            ],
            [
              { "kind": "text", "value": "00123" },
              { "kind": "number", "value": 12.25 }
            ]
          ]
        }
      ]
    }
  ]
}
```

The result carries kind: complete, version: { filePath, versionId }, source and sizeBytes. Create/edit results also carry changes: { sheetsAdded, blocksWritten, cellsWritten }. They never echo all cells. For edit_workbook, pass the returned version as source, then a changes array, for example:

```json
{
  "source": { "filePath": "out/<sha256>.xlsx", "versionId": "<sha256>" },
  "changes": [
    { "kind": "add_sheet", "name": "Income" },
    {
      "kind": "write_cells",
      "sheetName": "Expenses",
      "startCell": "B2",
      "overwrite": true,
      "values": [[{ "kind": "number", "value": 20 }]]
    },
    {
      "kind": "write_cells",
      "sheetName": "Expenses",
      "startCell": "A3",
      "values": [
        [
          { "kind": "text", "value": "Next" },
          { "kind": "number", "value": 30 }
        ]
      ]
    }
  ]
}
```

Every operation in that request must succeed before a version is published. Without overwrite: true, populated target cells, including empty text, cause failure. blank explicitly clears a cell when replacement is authorized; it is distinct from text with an empty value. Duplicate sheet names are rejected. Appending writes to an explicit start cell; it does not insert rows or move totals. Retry an identical edit against the same source version for the same output. There is no implicit latest-version lookup.

Cell kinds are text, number, boolean, blank, date and datetime. Text stays literal, including leading zeroes and formula-looking strings. Numbers that would lose Excel precision, unsafe integers, non-finite values and unsupported magnitudes are rejected; choose text explicitly for long identifiers. Dates span 1900-01-01 through 9999-12-31. Datetimes are local wall-clock values with seconds and optional millisecond precision, without a timezone. ISO date cells require Office 2010 or later. Existing formulas and formatting can be copied through the explicit Phase 3 modes below. Formula/style authoring, expert report operations and bounded calculation are described in the authoring sections above.

Initial limits are 1,000,000 touched cells per request, 1,000,000 stored cells per workbook, 64 sheets, 128 blocks/changes, 32 MiB stored text and 64 MiB serialized input. The existing 50 MiB file ceiling and OOXML package budgets also apply. Writing uses the separate native output capability and source reads retain their existing native sandbox. Details and verification evidence: [Phase 1](docs/phase-1/README.md), [execution plan](docs/phase-1/implementation-plan.md), [Phase 0](docs/phase-0/README.md).

For bulk key analysis, call prepare_bulk with source and target containing exact filePath/versionId references and selection objects, plus operation with kind keyed_update or upsert, keys and set mappings. Obtain version references from prepare_transfer or retained receipts. Every mapping uses sourceColumn/targetColumn with exact selected header names. Select exactly one closed range starting at headerRow, or a named table with its declared headerRow. Source filters, explicit physical-row subsets, column projection and reading hints reuse transfer semantics; the target must select its entire declared list without filters, visibility restriction, subsets or projection. Blank rows contain no records; conflict record numbers refer to one-based positions in the selected nonempty records, not worksheet rows.

Key identity preserves cell types, case, whitespace and Unicode normalization. Blank/empty-text keys and duplicate keys block either input, with at most eight examples and a full conflict count. Explicit reading hints may convert source values; there is no implicit key normalization. Key columns cannot be reassigned. Changing occupied values requires overwrite: true; equal assignments count as unchanged. Upsert requires mappings for every target column when there are unmatched source records. This focused tool accepts conflictPolicy: error only; full bulk jobs support explicit first/last rules. Existing source-value transfer refusals for errors, unsupported values and missing formula caches also apply.

prepare_bulk remains a focused key-analysis tool: validation is keys_and_target_policy and executionAvailable is false. It does not itself validate every mutation dependency or publish files. Full execution is provided by prepare_bulk_job/run_bulk_job below. Both source versions are checked again before returning. A blocked result identifies target policy blockers or bounded record/header/mapping conflicts. The requestFingerprint binds exact sources and normalized operations; it grants no authorization. This focused preparation permits 100,000 records per input, 1,000,000 combined selected cells, 32 MiB combined text, 16 MiB serialized key candidates and a 64 KiB descriptor.

Every read result carries `version: {filePath, versionId}`, the SHA-256 of the exact bytes that were parsed. Pass it to edit_workbook as source, or to prepare_edit as expectedVersion, so an edit applies to the bytes that were read; a file changed since the read is refused as file_changed. Read results also name their targets in the shape the edits take: describe_workbook definedNames give name, scope, sheetName and, for a single plain area, range for define_name/delete_name; get_charts series data give sheetName and range for set_chart; get_images gives the drawing name remove_image selects; get_data_validations ranges go to remove_validation ranges; get_conditional_formats priority goes to remove_conditional_format.

For edit preparation, call prepare_edit with filePath, optional expectedVersion and the complete changes array. It dry-runs the same editor used by edit_workbook, including occupancy, references and budgets, without publishing. A ready result returns source, requestFingerprint and profile (canonical_values or preserved_package). Send source and the same changes to edit_workbook; execution rechecks all selected source versions. The fingerprint is diagnostic identity, not a retained authorization token.

Every sheet name and A1 address in an edit request names the source workbook as it was read; no change sees the result of another. The editor runs unprotection first, then sheet additions and copies (a copy reads the source as it was read), then content and presentation changes at their source coordinates, then row and column insertions and deletions from the bottom up, then the contents of inserted rows, and finally renames, sheet deletions, reorders and protection. insert_rows takes either count or values with an optional startColumn; a formula cell in values writes {row} for its own inserted row (B{row}*C{row}) and addresses everything else at source coordinates. A combination whose result would depend on the order of its changes is blocked, and prepare_edit names each blocked change: a change touching cells another change deletes (target_deleted), copies or moves (overlapping_writes), insertions at one position or inside a deleted band (conflicting_structure), and a new or renamed sheet taking a name a source sheet or another new sheet uses (name_conflict). A sheet addressed by the name a rename in the same request gives it is unknown_sheet. prepare_edit and the edit receipt return placements: the output sheet and range of every target that moved or was renamed.

The preservation profile supports write_cells and clear_contents; add_sheet, rename_sheet, reorder_sheet, copy_sheet and delete_sheet; copy_range and move_range; insert_rows, delete_rows, insert_columns and delete_columns. Sheet operations identify sheetName (add uses name); rename/copy also require name, reorder requires a one-based position, and structural row/column operations require a one-based at and a count, except that insert_rows may carry values instead. Ranges use an explicit closed A1 range; copy/move also specify targetSheet and startCell. Occupied destinations require overwrite: true. Clear preserves cell styles and does not shift cells. At least one visible sheet must remain.

Copies require mode values, formulas, formatting or all. Values copies literal/saved values, formulas copies existing formulas and constants without source styling, formatting preserves destination contents, and all combines supported contents and formatting. Full-sheet all copies its supported tables/drawings/charts relationship graph; range copies do not duplicate those sheet-level objects. Full merged ranges can be copied; partial merges, overlapping ranges and partially intersecting incoming move references fail explicitly. An optional from: {filePath, versionId} on copy_range/copy_sheet selects another immutable workbook. Cross-workbook copies require matching style/theme profiles and compatible numeric calendar systems; unsupported profiles or external named/sheet bindings are refused. There is no values-only fallback.

Supported normal A1 formulas, mixed/absolute axes, scoped names and dependent ranges are transformed together with structural edits. Unsupported impacted structured/external/3D/spill references, shared/array group edits, rich metadata or unknown dependencies refuse the whole transaction. Formulas are never calculated: changed workbooks invalidate stale caches/calculation chains and report editing.recalculationRequired, recalculated: false and refreshRequired. Values-mode saved results are counted explicitly. Select an earlier retained version to undo the entire combined request or branch; source and prior outputs remain unchanged.

Editing accepts Transitional .xlsx, including supported noncanonical part paths. Macros, encryption, enabled workbook/sheet protection, write reservations, signatures and Strict markup are excluded. Unrelated part payloads retain their exact bytes; ZIP container bytes may change. The [Phase 3 plan](docs/phase-3/implementation-plan.md) records operation-specific limits and acceptance scope.

For value transfer, call prepare_transfer with filePath and selection, then pass its returned transfer object unchanged to transfer_data. For example, selection {"kind":"records","headerRow":1,"selectColumns":["ID","Amount"]} selects every data record in that column order, even if an earlier read showed a preview. An explicit subset uses scope {"kind":"rows","rows":[2,4]}. Target {"kind":"new","sheetName":"Export"} creates a new workbook; target kind add_sheet or sheet also requires source with the exact selected destination version. For header mapping into an existing list, select includeHeaders false and use target mapping {"kind":"headers","headerRow":1}; startCell supplies the destination row.

Range transfer preserves explicitly requested blank cells instead of clipping to usedRange. CSV and literal date/formula-looking text remain text unless columns explicitly request interpretation. Formula cells contribute saved results only; the compact receipt reports cachedFormulas and recalculated: false. Missing formula caches, errors, rich values, durations, time-only values and numbers the existing writer cannot represent safely fail explicitly. Existing .xlsx transfer targets now use the preservation editor; transfer_data continues to transfer values, while edit_workbook provides formula/style copying. Descriptor size, scan and output budgets apply before publication. See the [Phase 2 implementation and verification plan](docs/phase-2/implementation-plan.md) for the full support boundary and evidence.
