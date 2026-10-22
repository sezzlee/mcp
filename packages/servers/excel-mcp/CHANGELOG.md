# Changelog

## Unreleased

### Reading fixes

- A text cell is read as a date only when it is ISO 8601 with a real calendar day and clock. `2026-02-30Z` no longer rolls into 1 March, `0001-01-01` no longer reads as 2001, and `1/15/2026` stays the text the cell holds.
- A date serial whose year falls outside 1 to 9999 stays a number instead of reading as `+010000-01` or `01T00:00`.
- A grouped sum whose group holds no number no longer turns the total, and with it every group's share, into `null`; that group adds nothing to the total.
- A derived metric rounded at 1e21 or above comes back as a number instead of `null`.
- A data validation rule on a whole column (`A:A`) or whole rows (`1:1`), as openpyxl writes it, no longer fails every cell read of its sheet with `invalid_range`.
- A conditional format threshold whose `val` is not one number literal, such as `$B$1` or `10*2`, is reported as formula text instead of being dropped or read as `10`.
- `get_charts` reports `truncated` with `maxPointsPerResponse` when the shared point budget runs out with less than a point left for each level of a series; the answer was cut without saying so.
- An unnumbered cell outside any row, past column `XFD`, or an unnumbered row past row 1,048,576 is refused with `corrupt_workbook` instead of being placed outside the grid, such as a used range of `A0:…`.
- A workbook with an encrypted zip entry is refused with a message naming the encrypted part instead of one describing damage.

## 0.10.0

### Analysis tools

- Aggregate calls support derived metrics and membership filters against another file.
- Sheet descriptions preview headers, and every `read_sheet` page identifies its original row numbers.
- The tool catalog is smaller so each request carries fewer tool definitions.

### Breaking

- `warnings` in every response, `csv.warnings` and `profiles[].warnings` included, is a list of `{ code, message, column? }` instead of strings. The README lists the codes; a caller branches on `code`, never on the message.
- A call that names no `headerRow` no longer assumes row 1 of a workbook sheet. It reads by the header row a table or the autofilter declares, else the first of the top 20 used rows that names its columns by text alone with no row of data above it, else row 1, and reports which as `headerRowSource` (`declared`, `scanned` or `default`). Totals and counts over a sheet with a title band above its columns change accordingly: the title and the header row no longer count as data. A CSV still reads row 1, and `headerScan: true` keeps refusing an ambiguous or missing header.

### Reading fixes

- A header cell holding a number or a boolean names its column by its text instead of being `null`, so a year heading is addressable as `"2008"`.
- A `read_sheet` range holding only the header row reports that range, with no values and a warning, instead of the row below it.

- A data validation bound is a number only when the whole formula is one numeric literal. A reference such as `$B$1` was reported as `null` and an expression such as `45000+1` as `45000`; both now come back as the formula text, as does a `whole` bound that is not an integer.
- A `date` bound reads its serial by the rule a cell does: serials before March 1900 no longer land one day early, and serial 60, the 29 February 1900 Excel invents, stays the formula text. A `time` bound reads as `HH:mm:ss`.
- A date-formatted cell or bound whose serial is past the range a date can hold stays a number instead of failing the call.

## 0.9.1

### Breaking

- `majorityKind` is no longer exported. `aggregate_sheet` decides how a column compares from its typed reading, so the census vote has no caller.

### Day and month order

- A caller's `locale` names month words, digits and separators, never the day/month order. Slash and dash dates take their order from the column's values under any locale, so a locale that names the reader's language instead of the file's cannot move `03/04/2026` between months.
- A dotted date is read day first everywhere, explicit `columns` and `locale` included: no CLDR locale writes numeric dates month first with dots. A column holding a dotted value only month first can read is reported ambiguous with a `MM.dd.yyyy` suggestion instead of being read either way. The plan `profile_sheet` emits for a dotted column now reads that column.
- A `locale` whose separators read a value as a different number than the column's own marks do is named in a warning.

### Reading fixes

- One value no longer re-reads a whole column: a column turns into durations or booleans only when such values outnumber the values that read otherwise, so a stray `100:30` in an amount column or a grade `E` keeps the rest of the column.
- Text comparisons (`eq`, `ne`, `in`, `contains`, `startsWith`, `endsWith`) match a cell whose text is a missing token, so `eq "N/A"` finds `N/A`; `isEmpty` still treats it as missing.
- A caller's `missingValues`, `trueValues` or `falseValues` takes its words from the defaults of the other lists; only two lists the caller wrote may not overlap.
- A complete `read_sheet` page is no longer refused because the cursor it would have emitted exceeds the cursor budget.
- `omittedMatchedRows` no longer counts ungrouped rows, which no `maxGroups` value returns.
- An elapsed duration keeps Excel's 15 significant digits, so one second reads as `1`, not `0.9999999999999997`, and an exactly stored fraction of a second is unchanged.
- Numeric format sections, time-only checks and compiled locales are cached instead of being parsed again for every cell or column.

### CSV delimiter declarations

- An exact first decoded physical line `sep=X` or `"sep=X"` selects comma, semicolon, tab or pipe and is excluded from headers and record diagnostics. The ASCII keyword is case-insensitive. BOM validation remains strict, and syntax errors retain physical file line numbers.
- `csv.delimiterSource` adds `"sep"`. An explicit `delimiter` takes precedence, retains `"explicit"` and warns on a conflicting declaration. Paging retains the same parsing choice. Lookalikes with extra text, whitespace, unsupported separators or a later position remain data.

### Rich workbook values

- In-cell images resolve their rich-value metadata into image IDs, alternative text and decorative flags instead of `#VALUE!` compatibility errors. `get_images` lists their source cells and retains saved alt text for drawing images too.
- A verified Microsoft Open XML SDK fixture establishes support for cached `_linkedentity2` labels and closed entity metadata. Unsupported rich types retain their scalar and an explicit note; malformed referenced metadata is refused. External refresh and arbitrary entity property expansion remain unsupported.
- Array formulas expose their anchor, declared spill range and dynamic/collapsed metadata. Cached spill children preserve their values. Native and rich `#SPILL!`/`#CALC!` errors carry bounded explanations.
- Aggregate results expose a bounded, deduplicated `errorDistribution` over participating metric inputs. Numeric, boolean and extreme metrics report `skippedErrors`; images and supported linked values do not inflate error counts.

### Workbook selection

- `read_sheet`, `profile_sheet`, `find_in_sheet` and `aggregate_sheet` accept a declared `table` name. They select its data body, retain declared column names, exclude header/totals rows and refuse ambiguous names or conflicting ranges and headers.
- `visibleOnly` excludes saved hidden rows, including saved AutoFilter exclusions. It reports the skipped count and states that filter criteria are not reevaluated. Filtered reads retain original `rowNumbers`; table and visibility choices are bound to the cursor.

### Compatibility changes

- Low-level `SheetView` adapters now expose saved `hiddenRows`, and `SheetSource` adapters enumerate declared tables. Cell scalar and note unions include rich values and array metadata.
- **Native elapsed formats now return seconds.** `[h]`, `[m]` and `[s]` values return `{durationSeconds}` instead of calendar dates and can be summed. Negative durations, fractional precision and either date system are preserved.
- Native percentage and currency meaning now reaches aggregate descriptors. Stored fractions are not scaled again. Only the active number-format section contributes semantic tokens; quoted and escaped literals are ignored, and ambiguous currency symbols are not assigned a country.

- Missing literals N/A, NULL, -, — and #N/A now count as missing during typed operations, as do blank strings. Raw reads remain unchanged, and stored Excel errors remain errors. Literal lists are configurable, including an empty missing-token override.
- Invalid ISO offset hours/minutes and impossible canonical dates or clocks are no longer accepted by typed comparisons.

- **`coerceText` is removed from `aggregate_sheet`.** Text is always read as a number or a date where a metric or a `where` operand needs one, so a CSV sums and filters without any option. A call that still passes `coerceText` is refused as `invalid_argument`. `columnStats` no longer has `numericTexts`; it has `textNumbers` (text read as a number), `identifiers` and `times`.
- **Separators are decided per column.** `1.234,50`, `1,234.50`, `1 234,50` and `1'234.50` are read, as are accounting parentheses, `%` before or after the digits (as a ratio) and a currency symbol or code. A column whose values read differently under the winning separators is not read, and a warning names the `columns` entry to pass. Before, only `1234.50` was read and `1.234,50` summed to `null` without a warning.
- **Dates written as text match ISO operands.** `02.01.2023`, `2.1.2023`, `25/12/2023`, `12/25/2023`, `2023/01/02`, `18 Ekim 2026` and `October 18, 2026`, with or without a time, compare against `2023-01-02`. Slash and dash dates are read day first or month first from the column's values, and an undecidable column is reported, never guessed.
- **A time-only number format is a time of day.** `h:mm`, `hh:mm;@`, `mm:ss` and their AM/PM forms are returned as `HH:mm:ss` by every tool instead of an instant on 31 December 1899, and compare as times in `where` (`lt "12:00:00"`).
- **`where` counts what it could not compare.** A non-empty cell whose kind still differs from the operand's is reported in `warnings` with the count and examples; before it was a silent non-match although the tool description said it was counted.
- **Mixed currencies are reported.** A column whose amounts name more than one currency (`₺100` and `€50`) still sums as written, and a warning lists the currencies.
- **Identifiers are never summed.** Text with a leading zero or more than 15 digits is left out of `sum`, `avg` and `stddev` and reported, unless `columns` declares the column a number.
- **Empty count results are zero.** `countValues` and `countDistinct` now return zero when no rows match, consistently with `count` and empty pivot combinations. The old whole-range fallback returned null for those two count functions.
- **Column statistics count cells once.** Repeated metrics over the same column no longer multiply `columnStats` or uncached-formula diagnostics by the number of metrics.

### Tool surface

- The served tool list is 36 KB instead of 67 KB, and every request carries it. A nested schema carries a few words instead of repeating its parent's description, a column specification is published as one flat object, and long descriptions are shorter. Every input accepted before is accepted now, and every input refused before is refused.
- `aggregate_sheet` metrics take `round`, and `derived` computes ratios, shares of the total, differences and weighted totals from each group's metrics, with `orderByDerived` to rank by one. A zero denominator gives null and a warning.
- `where` takes `inColumn` and `notInColumn` with a `source` column in this or another file under the root, so one call lists the keys one list has and the other lacks. The source is bounded by `maxSourceValues` distinct values.
- `describe_workbook` reports each worksheet's `header`: the row a read that names no `headerRow` uses, where it came from, and its first 12 named columns with their letters (`maxHeaderPreviewColumns`), so columns can be named before any row is read.
- CSV encoding selection adds Windows-1251, Windows-1256, Shift_JIS, GB18030, Big5 and EUC-KR. Every selected decoder is strict; invalid sequences are refused and decoding is never guessed from replacement characters.

- New `profile_sheet` returns bounded statistical profiles, confidence, sampling scope, unreadable examples, identifier signals and reusable `columns`. Profile-generated numeric plans refuse identifiers even outside the sampled prefix.
- Shared closed `columns` support text, number, date, boolean, time and duration in profile, aggregate, read and find. Explicit locales and numbering systems extend number/date reading globally; unrecognized locales and ambiguous interpretations are refused.
- `read_sheet` optionally adds `typedValues` without changing raw values; column interpretation and token lists remain fixed across cursor pages. `find_in_sheet` optionally searches canonical values while returning raw values and conversion diagnostics.
- `countTrue`, `countFalse` and `trueRatio` count valid booleans. CSV clock and fixed elapsed-duration text are readable; duration metrics use seconds, while percent/per-mille metrics retain fraction units.

- `aggregate_sheet` takes `columns`, a list of entries such as `{"column":"Tutar","type":"number","decimal":",","group":"."}`, `{"column":"Tarih","type":"date","format":"dd.MM.yyyy"}` or `{"column":"Hesap","type":"text"}`. A date `format` is built from a closed token set and is never run as a regular expression.
- `aggregate_sheet` answers with `readAs`, how each column's text was read, when any was.
- `min` and `max` compare text read as numbers or dates in their own kind, and times as times.
- `groupBy` accepts calendar parts, explicit numeric boundaries and fixed decimal widths. Calendar keys use UTC and ISO week-years; unreadable keys are counted separately from missing keys. A plain key follows an explicitly declared or already-required column reading.
- `pivotBy` produces bounded dense pivot columns. `groupingSets` returns several breakdowns beside the primary result from one scan, and `compact` reduces repeated provenance while keeping diagnostics.
- `median`, `p50`, `p90` and `percentile` use exact inclusive linear interpolation. Each metric accepts its own `where` and reports `filtered` separately from `counted` and `skipped`.

### Resource bounds

- Native error distributions retain at most 32 named codes, three addresses per bucket and 128 characters per code. Overflow and overlong codes remain counted in `other`. Rich metadata has bounded records, fields and values; image and linked-label output participates in the existing response and string budgets.

- Column profiles retain at most 64,000 sampled cells, 64 columns and 1,000 distinct values per column, with explicit omissions and lower-bound flags. Shared column lists accept at most 64 entries. Typed reads and searches include their added values and diagnostics in the response budget; cursor interpretation is bounded to the existing token limit.

- Dense pivot output is limited to 10,000 metric cells before allocation. Percentiles share samples for identical selections and refuse more than 1,000,000 retained values across the call. Exact distinct counts have their own global 1,000,000-value bound; all grouping sets share the group and metric-state budgets.

## 0.9.0

### Compatibility changes

- **csv-parse is no longer a runtime dependency.** CSV records are split by the server's own RFC 4180 tokenizer, which enforces the 16,384-field and 2,000,000-cell budgets in the same pass. `csv-parse` stays as a dev dependency: the test suite compares the tokenizer against it on generated text and on every corpus CSV.
- **CRLF, LF and CR each end a record outside quotes, wherever they mix.** csv-parse kept the first form it met and read the others as field data, so a file that switched from CRLF to LF lost records without an error, and one that switched from LF to CRLF left a carriage return at the end of a field. Line breaks inside quoted fields are data, as before.
- A `corrupt_workbook` refusal for malformed quoting names the fault and its line (`a quote inside an unquoted field on line 3`) instead of quoting csv-parse's message and error code. A NUL right after a closing quote is refused like any other text there; csv-parse appended it to the field.

### Reading

- `csv.formulaLikeCellCount` counts a cell that starts with `=` and has more after it, the cells LibreOffice runs as formulas when it opens a CSV. A cell holding only `=` is no longer counted.
- `csv.lineBreak` reports the line breaks that end records. A CRLF file whose quoted fields hold Excel's Alt+Enter line breaks was reported `mixed`; it is now `crlf`.
- `encoding: "windows-1252"` decodes the bytes 0x80 to 0x9F as the WHATWG index does (€, curly quotes, en and em dashes, …, ™). Node 24's decoder returned them as C1 control characters.

## 0.8.0

### Tool surface

- `describe_workbook` reports each sheet's `kind` (`worksheet` or `chartsheet`) and `chartCount`. A chart sheet is no longer described as an empty grid.
- `read_sheet`, `aggregate_sheet` and `find_in_sheet` refuse a chart sheet with `chart_sheet` instead of `empty_sheet`, and `get_merged_ranges` refuses it instead of answering with no merges; recovery points at `get_charts`.
- New tool `get_charts`: type, title, axes, series cell references and cached points. `capabilities.charts` is `true` for `.xlsx`. `get_images` with `kind: "chart"` still refuses and names `get_charts`.
- `get_charts` also reports secondary axes (the axes the first plot does not use), axis min/max/logBase and number format, series trendline types, series filtered out in Excel (`c15:filtered*Series`) as `hidden`, and `pivotSource` when the chart is pivot-backed. Cached points keep the cache's `numberFormat`, multi-level categories keep their outer `levels`, and series past the per-chart cap are counted in `omittedSeries`. A one-cell anchored chart reports its top-left `cell` and size instead of a range, and a `chartId` the sheet does not have is refused as `invalid_argument`.
- A tool called without `sheetName` lands on the first visible worksheet, skipping chart sheets; `get_charts` may land on a chart sheet.
- Markup Compatibility (`mc:AlternateContent`) is applied when reading drawings, so a chartEx frame is reported once rather than as its placeholder shape.

### Compatibility changes

- **SheetJS is no longer a runtime dependency.** Cells, number formats, dates, formulas, hyperlinks, merges, the auto filter, the declared range, sheet states and defined names are read from the OOXML parts by the server's own reader over `@sezzlee/ooxml-core`, so a workbook is unzipped once instead of twice. `@e965/xlsx` stays as a dev dependency: the test suite compares the reader against it, cell by cell, over every fixture workbook. Parts of the reader derive from SheetJS (Apache-2.0); `THIRD-PARTY-NOTICES.md` lists them and ships in the tarball.
- **`get_images` no longer reports a one-cell range for a one-cell anchor.** Such a picture is anchored by its top-left cell and a size, so it now carries `cell` and `widthPx`/`heightPx` instead of a `range` naming that single cell, which read as if the picture fitted in it (49 of 797 corpus pictures). `widthPx` and `heightPx` are whole pixels now, in `get_images` and `get_charts`.
- `parseSheetJs`, `describeSheetJs`, `sheetjsSheetView` and the `SheetJsWorkbook` type are replaced by `parseOoxml`, `describeOoxml`, `ooxmlSheetView` and `OoxmlWorkbook`. `selectSheetName` takes an `OoxmlWorkbook`.
- A damaged archive is refused with `corrupt_workbook`: every part is checked against its CRC-32, and every part's local header must agree with the central directory, so two zip readers cannot see two different files in the same bytes. A truncated workbook that still starts with a zip header is `corrupt_workbook`; bytes that are not a zip at all stay `not_a_workbook`, whose `recovery` now says the file is probably not a spreadsheet.
- A shared string table that declares a DOCTYPE, and a cell in row 0, are refused with `corrupt_workbook`. ECMA-376 forbids both; SheetJS read through them.
- Two merged ranges that overlap are refused with `corrupt_workbook` when a row they share is read. Excel repairs such a file; no corpus workbook has one.
- A sheet listing more than 66,530 hyperlinks, the most Excel keeps on one sheet, is refused with `file_too_large`.
- A malformed worksheet is refused with `corrupt_workbook` by the calls that read that sheet instead of when the workbook opens, so the workbook's other sheets stay readable. `describe_workbook` reads every sheet and still refuses. `OoxmlWorkbook` reads a sheet's validations, tables, conditional formats, images and panes through `facts(sheetName)`.

- The OOXML parts are read by `@sezzlee/ooxml-core`'s own XML tokenizer instead of `saxes`, 2.2 times faster on the largest corpus parts. Text in a CDATA section, which the `saxes` reader dropped, is now read. A part that is not valid UTF-8, or that names UTF-16 without a byte order mark, is refused with `corrupt_workbook` instead of being read with replacement characters.

### Resource bounds

- A cell's hyperlink is looked up in a per-sheet index instead of a scan over every link, and building the index visits at most 1,000,000 covered cells. A link anchored on a huge range no longer costs a loop over every row it names.
- A row's merged ranges are found through an interval tree instead of a scan over every merge; a sheet with 100,000 merges read row by row went from 14 s to under half a second.
- A shared formula's later cells keep a reference to their group and are expanded when read. Expanding them up front let 40,000 cells of one 8,000-character formula hold 760 MB.

### Memory

- A sheet's cells are kept as typed arrays, one per field, instead of an object per cell with a value object of its own: about 21 bytes a cell where it took 120 to 300. A described workbook retains 61–75% less memory on the four largest corpus files (the largest from 1.2 GiB to 0.3 GiB) and peak memory while reading falls by a third or more, at the same speed.

- Every worksheet, the shared string table, the styles and each table and drawing part are inflated, decoded and scanned a chunk at a time, and their text is not kept. On three of the four largest corpus files a described workbook retains 19–27% less heap, and the largest reads in a 1.3 GiB heap where it needed 1.6 GiB. Files under 1 MB read up to 5% slower.
- A damaged part is still refused, but a fault met while scanning it can be reported before its CRC-32 mismatch, and a part that inflates past its declared size is stopped at the first byte over, so the refusal no longer states how far it expands.

### Speed

- A worksheet part is scanned once, when a tool first needs that sheet, with every part reader fed from that one pass. Opening a workbook scanned every sheet five times and reading a sheet's cells three more, so `describe_workbook` scanned each sheet eight times and `read_sheet` scanned every sheet of the workbook. Measured A/B against the build before the shared pass on the corpus, with the same answers on every file, the four largest files and files of 1–10 MB read 2.7 times faster, and files of 0.1–1 MB 2.2 times faster.

### Reading

- Strict OOXML workbooks (`purl.oclc.org` namespaces) are read like Transitional ones.
- A cell with no `s` attribute takes cell format 0, as ECMA-376 says, instead of `General`.
- A chart sheet declares no rows or columns; SheetJS reported a range drawn from the chart's series.
- Raw carriage returns in cell text are normalised to line feeds, as XML 1.0 end-of-line handling requires.
- A relationships part that is not well-formed is named in the `corrupt_workbook` message; the part it belongs to was named instead.

## 0.7.1

- The package declares its MCP Registry name, `io.github.sezzlee/excel` (`mcpName`). No code changed.

## 0.7.0

### Compatibility changes

- `limits.maxValidationCountEntries` is removed. No code path read it since validation ranges are taken from `sqref` as written.
- `find_in_sheet` enforces the regex length through `limits.maxRegexSource` instead of a literal; the value is still 256 and the message is unchanged.

### Tool surface

- An argument a tool does not declare, a value of the wrong type and a missing required argument are refused with `invalid_argument` in the error envelope, whose `recovery` lists the accepted arguments (`@sezzlee/mcp-core` 0.2.0). Before, an unknown key was dropped — a misspelt `caseSensitiv` succeeded with the default — and a shape failure was plain text with no `error` code. Every input schema is published with `additionalProperties: false`.
- Every argument now carries a description, so an agent no longer sees `aggregate_sheet`'s `range`, `metrics`, `metrics[].fn`, `where[].op`, `where[].value`, `where[].values`, or `find_in_sheet`'s `query` and `range` as a bare name and type.
- `describe_workbook`'s `includeDefinedNames` no longer mentions ExcelJS, which is not present at runtime.
- `aggregate_sheet`'s truncation `hint` no longer tells a caller that already passed `orderBy: "metric"` to set it; it suggests raising `maxGroups` or adding a `where` clause instead.

## Before 0.7.0 — Excel/file-core hardening

Everything in this section first shipped in 0.7.0, the first published version.

### Compatibility changes

- The grid is read by SheetJS (`@e965/xlsx`, exact-pinned), not exceljs. This fixes two classes of real-world workbook that exceljs rejects as corrupt although Excel opens them and the bytes are valid OPC: SpreadsheetML written with a namespace prefix (`<x:workbook>`, emitted by every .NET `DocumentFormat.OpenXml`/`System.IO.Packaging` writer) and a worksheet part with no ordinal in its name (`xl/worksheets/sheet.xml`). `parseXlsx`, `describeWorkbook`, `selectWorksheet` and `xlsxSnapshot` are replaced by `parseSheetJs`, `describeSheetJs`, `selectSheetName` and `sheetjsSnapshot`.
- exceljs remains a dependency and backs only `get_data_validations`, `get_tables`, `get_conditional_formats`, `get_images` and the frozen-pane counts. When it cannot open a workbook those tools return `unsupported_for_format`, `describe_workbook` reports the corresponding counts as `null` rather than `0`, `capabilities` turns `dataValidations`/`tables`/`conditionalFormats`/`images`/`frozenPanes` to `false`, and `limitations` carries `rich_metadata_unavailable`. Reading cells, ranges, merges, formulas and defined names is unaffected.
- **exceljs is no longer a runtime dependency.** All four metadata tools read the OOXML parts directly through a namespace-aware SAX reader (`saxes`), matching on `(namespace uri, local name)` so a part written with a prefix is indistinguishable from an unprefixed one at the call site. Parts are reached through SheetJS's own zip (`bookFiles`), so no second unzip implementation entered the tree. `collectTables`, `collectConditionalFormats` and `collectImages` take a sheet name and the parsed structures instead of an exceljs `Worksheet`; `loadExcelJs`, `richFactsFrom`, `requireRichBook`, `richWorksheet`, `imageCountOf`, `tableCountOf`, `autoFilterRefOf` and `conditionalFormatsOf` are gone.
- Every capability is now available for every `.xlsx` layout. `capabilitiesFor` no longer degrades per document and the `rich_metadata_unavailable` limitation is removed, because no workbook layout costs a capability any more.
- Coverage gained along the way: absolute-anchor images are reported (`anchor: "absolute"`, with no fabricated `range`) instead of being dropped, which retires EXCEL-META-009; a `cfvo type="formula"` threshold keeps its expression in a new `formula` field instead of being marked unreadable; frozen panes are read from the worksheet's `pane` element, which exceljs could not see on a prefixed part.
- `get_data_validations` no longer goes through exceljs. Rules are read straight from the worksheet part with a namespace-aware SAX reader (`saxes`), matching on `(namespace uri, local name)` so a prefixed part is indistinguishable from an unprefixed one at the call site. `collectValidations(sheet, validations)` replaces `collectValidations(worksheet)`.
- Validation ranges come from `sqref` as written instead of being expanded to one entry per cell and recompressed. The 5,000-entry visit budget and the resulting `dataValidationRuleCount: null` degradation are gone: the count is always exact, `dataValidationRuleCountExact` is always `true`, and a rule covering a whole column costs nothing to report.
- `capabilities` is no longer a static per-format record. `capabilitiesFor(document)` reports what the loaded document can actually answer, and gains a `frozenPanes` field.
- `corrupt_workbook` no longer covers three unrelated conditions. Bytes with no zip header, and a valid zip carrying no workbook part, are now `not_a_workbook`; `corrupt_workbook` is reserved for a workbook the parser genuinely could not decode and its message carries the parser's own explanation instead of discarding it.
- Secure file access now requires the bundled Node-API binary. Supported targets: glibc Linux x64/arm64 (kernel 5.6+), macOS x64/arm64, Windows x64. Unsupported or incomplete installs fail closed. No compiler is needed when installing the complete release tarball.
- Cursors are v2. Restart reads carrying a v1 cursor. Explicit conflicting interpretation options return `invalid_argument`; omitted options inherit the first page. `maxCells` may change. `sheetName` and `range` remain prohibited with a cursor. CSV auto detection versus an explicit encoding/delimiter is part of the locked parser configuration.
- `findInSheet` returns a Promise. Await it. JavaScript regex features are preserved except the existing Unicode-property-escape restriction; searches have a two-second worker deadline, two active workers, eight queued requests and 64 KiB message batches. Cancellation and shutdown await worker termination.
- `parseCsv` and `parseXlsx` now accept snapshot bytes, not FileHandle. file-core `ParseContext` exposes `bytes`, `displayPath` and content identity. Load documents through a pinned sandbox root; forging a SandboxedPath does not grant access.
- Cache hits and cursor continuation re-read and hash the file bytes. This increases I/O while avoiding repeat parsing of unchanged content. Concurrent writing is checked before/after reading; no atomic OS snapshot is promised.
- CSV UTF decoding is strict even with explicit UTF encoding. Maximum record width is 16,384 fields; existing 16 MiB and 2,000,000-cell budgets remain. Blank physical records remain in place.
- `numeric_overflow` reports non-finite inputs and arithmetic. Mixed-type min/max and incompatible between bounds return `invalid_argument`. Empty sum remains null; a real zero remains zero.
- Listing adds `totalExact`, `scanTruncated` and `scanTruncationReason`. `truncated` describes returned-result slicing only. At the visit budget, totals are conservatively inexact even if the unseen next operation would have reached EOF.
- Aggregation adds `returnedMatchedRows` and `omittedMatchedRows`. Metric counted/skipped counts apply to returned groups; `matchedRows` still covers every matching group.
- Validation counts may be null after 5,000 inspected entries; check `dataValidationRuleCountExact`. Image counts are not exhaustive; check `imageCountExact`. Metadata tools expose structured `limitations` and `complete`/`definedNamesComplete` markers.
- Raw internal exception text is logged only to stderr. MCP error messages/recovery redact absolute paths, including sibling roots and Windows paths.

### Deliberate metadata limitations

Absolute-anchor images (EXCEL-META-009), formula conditional-format thresholds (EXCEL-META-010), sheet-local defined names (EXCEL-META-025), and rich metadata unreadable for a given workbook layout (EXCEL-META-030) remain explicit, tested limitations. Missing parser metadata is never presented as an exhaustive absence claim.
