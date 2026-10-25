# @sezzlee/excel-mcp

A standalone MCP server that **reads** local Excel files for an agent. There is no write path.

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

## Tools

| Tool                      | What it does                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_workbooks`          | Lists readable files under the root; the `filePath` it returns is passed to other tools verbatim                                                 |
| `describe_workbook`       | Sheets and their kind (worksheet or chart sheet), used ranges, counts of merges, validations, tables, formulas, images and charts, defined names |
| `profile_sheet`           | Bounded type and quality profiles with reusable column specifications                                                                            |
| `read_sheet`              | A cell range as a compact grid: hoisted column headers plus row arrays                                                                           |
| `aggregate_sheet`         | Grouped summaries, calendar and numeric buckets, bounded pivots, conditional metrics and exact percentiles                                       |
| `find_in_sheet`           | Cells whose value or formula matches a query; without a sheet, in every worksheet                                                                |
| `get_tables`              | Excel Tables: range, header and totals rows, column names and letters                                                                            |
| `get_data_validations`    | Validation rules, regrouped into rectangular ranges                                                                                              |
| `get_conditional_formats` | Conditional formatting rules as predicates                                                                                                       |
| `get_merged_ranges`       | Merged cell ranges                                                                                                                               |
| `get_images`              | Drawing and in-cell pictures: anchor, alt text, size and extension. Charts belong to `get_charts`                                                |
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

`inColumn` and `notInColumn` keep the rows whose cell is, or is not, among the values of another
column, named by `source`: a sheet and column of the same file or of another file under the
root, opened through the same gates. Values match as `eq` compares them, never trimmed; the
source holds at most 100,000 distinct values (`maxSourceValues`). Two calls, one in each
direction, answer which keys one list has and the other lacks. This is a filter, not a join:
no columns of the source are returned.

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
[CSV profile recipe](../../../../apps/docs/src/content/excel-mcp/recipes/07-profile-and-read-global-data.md).

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
without exchange-rate conversion. See the [CSV profile recipe](../../../../apps/docs/src/content/excel-mcp/recipes/07-profile-and-read-global-data.md)
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

The OOXML parts are read namespace-aware by `@sezzlee/ooxml-core`'s own XML tokenizer. Matching is done on `(namespace uri, local name)` — the prefix the file happens to write is never consulted — so `<x:dataValidation>` and `<dataValidation>` are indistinguishable at the call site. These tools therefore work with any OPC layout, including prefixed .NET output and a worksheet part named `sheet.xml`.

| tool                      | source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_data_validations`    | worksheet part, `dataValidations/dataValidation`. Ranges are taken verbatim from `sqref`, not opened cell by cell — a rule covering an entire column still counts as exact, so `dataValidationRuleCountExact` is always `true`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
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
