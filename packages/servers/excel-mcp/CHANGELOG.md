# Changelog

## Unreleased

### Compatibility changes

- **csv-parse is no longer a runtime dependency.** CSV records are split by the server's own RFC 4180 tokenizer, which enforces the 16,384-field and 2,000,000-cell budgets in the same pass. `csv-parse` stays as a dev dependency: the test suite compares the tokenizer against it on generated text and on every corpus CSV.
- **CRLF, LF and CR each end a record outside quotes, wherever they mix.** csv-parse kept the first form it met and read the others as field data, so a file that switched from CRLF to LF lost records without an error, and one that switched from LF to CRLF left a carriage return at the end of a field. Line breaks inside quoted fields are data, as before.
- A `corrupt_workbook` refusal for malformed quoting names the fault and its line (`a quote inside an unquoted field on line 3`) instead of quoting csv-parse's message and error code. A NUL right after a closing quote is refused like any other text there; csv-parse appended it to the field.

### Reading

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
