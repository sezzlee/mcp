# Excel MCP corpus findings

Run `2026-10-16T09-49-24.100Z` · `@sezzlee/excel-mcp` 0.7.1 at `b8c184e` · Node v24.12.0

## Summary

The Excel server read 480 real-world files without a single crash or hang. Its biggest problem is
memory: a 42 MB workbook needed 2.9 GB. A second, independent reader found no data hidden behind
the 181 sheets the server called empty, but 103 of them are chart sheets that the server reports
as if they were blank.

These results record **what today's server answers**, not what is correct. They are the reference
the new reader will be compared against when SheetJS is replaced.

## What was measured

The harness in this package (README) runs the built server through its MCP interface, one file per
process, one file at a time, with a 2 GB heap limit and a 2 minute time limit per file. For each
file it calls `describe_workbook`, then `read_sheet` (first page, values and formulas) and
`get_merged_ranges` for each of the first 25 sheets. It records every answer, its duration, the
process's peak memory and any error code.

The corpus is open-licensed public data, grouped by source:

| Source            | Content                                           | Files |
| ----------------- | ------------------------------------------------- | ----- |
| `tr-ckan`         | Izmir open data                                   | 184   |
| `uk-datagov`      | UK government data                                | 85    |
| `us-datagov`      | US government data                                | 85    |
| `tr-tuik`         | Turkish Statistical Institute tables              | 60    |
| `apache-testdata` | Apache POI and Tika's deliberately odd test files | 36    |
| `eu-dataeuropa`   | EU open data                                      | 30    |

388 files are `.xlsx`, 4 `.xlsm` and 88 `.csv`. Another 2921 files in other formats (`.xls`,
`.ods`, PDF, Word, …) were counted and skipped.

## Results

All 480 files were probed: no timeouts, crashes, unreadable reports, missing files or digest
mismatches. The 459 workbooks that opened hold 1860 sheets.

Coverage gap: 11 workbooks have more than 25 sheets, so only their first 25 were read. The largest
has 191 (`uk-datagov/files/xlsx/FHSPOIAdultswithFHSbaseline2025-c92829b9.xlsx`).

## Memory and speed

Peak memory grows far faster than file size. The smallest file in the run already costs 113 MB, so
the multiplier below is measured above that floor.

| File                                                                     | On disk | Peak memory | Time | Memory per MB on disk |
| ------------------------------------------------------------------------ | ------- | ----------- | ---- | --------------------- |
| `tr-ckan` · Izmir water use by district (`yillik-ilce-ve-mahalle-…`)     | 41.7 MB | 2914 MB     | 40 s | 67×                   |
| `tr-ckan` · Izmir social aid (`yapilan-sosyal-yardimlar__683857fd`)      | 21.7 MB | 1831 MB     | 21 s | 79×                   |
| `us-datagov` · genome samples (`SF06_chip_and_genome_samples_v05`)       | 25.7 MB | 1519 MB     | 18 s | 55×                   |
| `us-datagov` · 15-minute weather (`2023_15-min_weather_SWMRU_CPRL`)      | 14.0 MB | 818 MB      | 8 s  | 50×                   |
| `tr-ckan` · Izmir hot meals (`ihtiyac-sahiplerine-gunluk-sicak-yemek-…`) | 8.1 MB  | 772 MB      | 6 s  | 81×                   |

SheetJS parses the whole workbook into memory before the first tool answers. The largest file
fitted under the 2 GB heap limit only just; with a lower limit, as a reader process in the product
would have, it would fail. These five files are the yardstick for the new reader.

## Error codes

The server answered 206 calls with an error. These are deliberate answers, not crashes.

| Tool · code                                          | Count                  | Where                                | Reading                                                                 |
| ---------------------------------------------------- | ---------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `read_sheet` · `empty_sheet`                         | 181 sheets in 55 files | mostly `us-datagov` (119)            | 78 truly empty, 103 chart sheets (see Correctness check)                |
| `describe_workbook` · `undecodable_text`             | 13                     | all CSV: uk 5, eu 4, tr-ckan 3, us 1 | no BOM; 3 Turkish files are windows-1254, the other 10 are windows-1252 |
| `describe_workbook` · `corrupt_workbook`             | 5                      | `apache-testdata`                    | damaged on purpose upstream; the diagnosis itself is not yet verified   |
| `describe_workbook` · `file_too_large`               | 2                      | `us-datagov` CSV                     | over the size limit                                                     |
| `read_sheet` · `ambiguous_header_row`                | 2                      | `uk-datagov`                         | the header row is unclear; the server refuses rather than guesses       |
| `read_sheet`, `get_merged_ranges` · `resource_limit` | 1 + 1                  | one `tr-ckan` file                   | over a resource limit                                                   |
| `describe_workbook` · `encrypted_workbook`           | 1                      | `apache-testdata`                    | encrypted, as expected                                                  |

## Correctness check

A run like this one can show that a change altered an answer. It cannot show that an answer is
right: if SheetJS misreads a cell, the record keeps the mistake as the expected value. Correctness
needs a reader that shares no code with SheetJS.

The first check used openpyxl 3.1.5 (with defusedxml), kept outside this repository, on the 181
sheets the server called empty. It applies the server's own definition: a cell counts when it holds
a formula or any value. It ignores the declared dimension, as the server does. A control on a sheet
the server read as full (TÜİK, 1848 cells) confirmed that the oracle does report cells.

| openpyxl's verdict | Sheets | Meaning                                                 |
| ------------------ | ------ | ------------------------------------------------------- |
| empty as well      | 78     | two independent readers agree: almost certainly correct |
| chart sheet        | 103    | the sheet is a chart, not an empty grid                 |
| holds cells        | **0**  | no sheet with data was reported as empty                |

## Capability gaps

- **Chart sheets look blank.** `describe_workbook` lists them as ordinary visible sheets with no
  used range, and `read_sheet` says the sheet "has no cells with values" and points the agent to
  other sheets. An agent concludes the sheet is empty, while it holds a chart. `get_images` already
  follows the opposite rule: charts are refused, never reported as absent.
- **Charts are not read.** The corpus has 207 chart parts in 21 workbooks (one holds 51), 103 chart
  sheets in 9 workbooks and 571 drawing parts in 98 workbooks. No `chartEx` part (waterfall,
  treemap and the other newer chart types) appears.
- **Pivot tables are not read.** Only 3 pivot tables in 2 workbooks: too few to build on, so pivot
  samples have to be added or generated.
- **Formulas are read, not computed.** 126 workbooks hold 1,947,940 formula cells. Every workbook
  but one stores a cached result for every formula, so today's answers rely on Excel's own results.
  Computing formulas matters for that one file and for files written by tools that store no cached
  value.
- **Defined names** appear in 149 workbooks; `describe_workbook` already marks its list as partial
  for sheet-local names.
- **CSV encodings**: 13 files have no byte-order mark and are not UTF-8, so the default
  decode refuses them. The reader already accepts `windows-1254`, `iso-8859-9` and
  `windows-1252` when the caller passes `encoding`. Three `tr-ckan` files are Turkish
  (İ/ı, byte `0xDD`/`0xFD`): windows-1252 turns those into Ý/ý. The other ten are Western
  European punctuation and accents (£, é, µ, en dash), which windows-1252 reads correctly.
  A single-byte encoding never fails to decode, so guessing one silently is the hazard.

## What we know and what we do not

| Known                                   | Not yet known                                                        |
| --------------------------------------- | -------------------------------------------------------------------- |
| No file crashes or hangs the server     | Whether cell values agree across the corpus                          |
| Memory is the limit on large files      | Whether the 5 `corrupt_workbook` diagnoses are right                 |
| No sheet with data is reported as empty | Whether a CSV without a BOM should guess windows-1252 / windows-1254 |
| 103 chart sheets are reported as empty  | Sheets 26 and later of 11 workbooks                                  |

The cell check is openpyxl 3.1.5 against a run's `read_sheet` pages (formula text and cached value, returned range only). It lives outside this repository, beside the empty-sheet check. A date serial against a datetime is recorded as `date_format`, not as a wrong value.

Run `2026-10-17T17-45-25.837Z`, the 392 xlsx and xlsm files (1,326 sheets, no oracle error): 1,238,677 cells agree. Every other cell falls in a class that is not a wrong value. 1,644 are a time of day written as an instant on 1899-12-31. 617 are the same instant within a millisecond, where the serial lands on `.999` and openpyxl rounds up to the next second. 288 strings are cut at 512 characters. 1,356 empty strings are cells openpyxl does not return, and 270 cached blanks come from a formula whose text matches. 61 covered cells of a merge are empty here and filled by openpyxl. 43 texts contain a carriage return that openpyxl still shows as `_x000D_`. 224 formulas differ only by the `_xlfn.` compatibility prefix, and the cached value matches; 6 more differ in formula text with the same displayed value. Two dates, `bug60858.xlsx` N2 and one cell in a contracts register, are one day apart: the adjustment for the phantom 29 February 1900, which openpyxl does not apply the same way. Run `2026-10-17T17-50-54.240Z`, all 557 chart workbooks: 8,891 agree and 7 differ, the same time and blank cases. Reports: `oracle/cells.jsonl` beside each run.

## Replacing SheetJS

Run `2026-10-16T12-32-47.983Z` reads cells through the in-repo reader over `@sezzlee/ooxml-core`
instead of SheetJS. Compared with the run above, file by file and call by call:

| Result                                       | Files | Why                                                                        |
| -------------------------------------------- | ----- | -------------------------------------------------------------------------- |
| Every answer identical                       | 460   |                                                                            |
| Now refused as `corrupt_workbook`            | 2     | an entity-expansion DOCTYPE, and a row numbered 0; both refused on purpose |
| Same error code, more specific message       | 5     | Apache fuzzer files                                                        |
| Number format `GENERAL` instead of `General` | 3     | a cell without `s` takes cell format 0, as ECMA-376 says; SheetJS skips it |
| Chart sheets declare no rows or columns      | 9     | SheetJS reported a range drawn from the chart's series                     |
| Raw line breaks normalised to LF             | 1     | XML 1.0 §2.11 end-of-line handling, which SheetJS skips                    |

No other answer changed. Every deliberate difference is listed, with its reason, in
`packages/servers/excel-mcp/test/corpus-cells-parity.spec.ts`, which compares both readers cell
by cell on every corpus workbook up to 10 MB (388 files, all agreeing).

The switch also closed two gaps SheetJS had been covering: `ooxml-core` now checks every part's
CRC-32, and checks each local header against the central directory before reading the part.

Memory and time have not improved yet: 195 s for the corpus became 230 s, the largest file went
from 2914 MB to 1944 MB, and the genome file from 1520 MB to 1683 MB. The reader still scans each
sheet part once per part reader and keeps every cell as an object; that is the next step.

## Choosing the XML parser

`src/parser-bench/` runs three parsers behind the part reader's contract: `saxes` (today's), `sax`
1.6.1 and an in-repo prototype tokenizer for the OOXML subset (no DTD, the five predefined entities
and character references). `test/parser-bench.spec.ts` holds the XML 1.0 rules each must keep.

**Conformance.** `sax` breaks four of them even in strict mode: it keeps raw line ends, accepts
`&nbsp;`, keeps the last of two repeated attributes without complaint, and accepts a second root
element. The repeated attribute is the dangerous one: two readers of the same part see different
values. `saxes` and the prototype keep every rule.

**Agreement.** Over 392 corpus workbooks, 2,057 worksheet and shared string parts, `saxes` and the
prototype report the same event stream for every part (`verify` mode, events hashed after joining
adjacent text). `sax` differs on 126 parts. Two files never reach a parser: a fuzzed zip and an
encrypted workbook.

**Time and memory**, median of three runs, each in a fresh process, on the five largest files. The
workload is the cell reader's: three attribute lookups per cell and the text of every value.

| File (characters decoded) | `saxes` | `sax`  | prototype | Process with parts decoded |
| ------------------------- | ------- | ------ | --------- | -------------------------- |
| Izmir water use (365 M)   | 7.6 s   | 15.0 s | 3.4 s     | 864 MiB                    |
| Genome samples (252 M)    | 2.5 s   | 4.8 s  | 1.2 s     | 635 MiB                    |
| Izmir social aid (205 M)  | 4.0 s   | 8.0 s  | 1.8 s     | 538 MiB                    |
| 15-minute weather (69 M)  | 1.0 s   | 2.2 s  | 0.6 s     | 257 MiB                    |
| Weather summary (30 M)    | 0.5 s   | 1.1 s  | 0.2 s     | 171 MiB                    |

The prototype is 2.2 times faster than `saxes`; `sax` is twice as slow. No parser adds more than
120 MiB over the decoded parts. **The memory is the decoded parts themselves, not the parser**: the
largest file holds 864 MiB before a single event. Choosing a parser cannot fix memory; reading a
part in inflated chunks instead of one decoded string can, and both `saxes` and a tokenizer can be
fed chunks.

A side finding: today's `saxes` reader listens for `text` but not `cdata`, so text inside a CDATA
section is lost. Excel does not write CDATA, and no corpus part differs because of it.

## After the switch

The production tokenizer (`ooxml-core/src/xml/tokenizer.ts`) adds the checks the prototype lacked
(name characters, excluded characters, namespace rules, repeated attributes) and stays twice as
fast as `saxes` on the largest part: 4.1 s against 8.1 s for the Izmir water sheet.

**Whole runs taken hours apart do not compare.** The run after the switch took 261 s against 230 s
the run before, slower on every size of file and on CSV files that never reach the tokenizer. The
same old build took 64 s on the Izmir file in the afternoon against 52 s in the morning: the machine
was slower, not the code. Speed is therefore measured A/B: the old build (a worktree at the previous
commit) and the new one run the same files alternately, three times each, median taken.

| Files                   | Before | After  | Change                            |
| ----------------------- | ------ | ------ | --------------------------------- |
| Four largest (15–44 MB) | 139 s  | 103 s  | 26% faster                        |
| Ten of 1–10 MB          | 36 s   | 30 s   | 18% faster                        |
| Eight of 0.1–1 MB       | 3.5 s  | 2.9 s  | 17% faster                        |
| Twelve under 100 KB     | 0.72 s | 0.75 s | the same; process start dominates |

Answers are unchanged on 478 of 480 files; the other two differ only in error message wording. Peak
memory did not move, as the parser benchmark predicted.

A profile put a fifth of the time in the start tag scanner, so its four passes over each attribute
value were merged into one loop. Measured A/B the change made no difference (3.8 s against 3.7–3.9
s) and was reverted: V8's `indexOf` and regular expressions were never the cost.

The parser is now the largest share of a profile because `excel-mcp` scans each sheet part once per
reader: cells, hyperlinks, layout, validations, tables, images and panes. Reading every sheet part
once is the next speed step; reading parts as they inflate is the memory step.

## One pass per sheet, when it is needed

Every part reader of a worksheet (cells, hyperlinks, layout, validations, tables, conditional
formats, images, panes) now runs as a visitor on one shared scan, taken when a tool first needs the
sheet. Opening a workbook scanned every sheet five times for its facts, and reading a sheet's cells
scanned it three more; a probe's `describe_workbook` and `read_sheet` scanned each sheet eight
times and now scan it once, and `read_sheet` alone scans only the sheet it reads.

| Files                   | Before | After  | Change           |
| ----------------------- | ------ | ------ | ---------------- |
| Four largest (14–42 MB) | 84 s   | 31 s   | 2.7 times faster |
| Ten of 1–9 MB           | 19 s   | 7.0 s  | 2.7 times faster |
| Eight of 0.1–1 MB       | 2.5 s  | 1.1 s  | 2.2 times faster |
| Twelve under 100 KB     | 0.52 s | 0.41 s | 1.3 times faster |

A/B against the commit before the shared pass, three runs each, alternated, median taken. Every call
answered byte for byte the same on all 34 files in every run, and a full corpus run matched the
previous one on all 480 files, refusals included. Peak memory did not improve and moved by up to 16%
either way per file: it is the decoded parts and the cell objects, not the scans.

The one change a caller can see: a malformed worksheet is refused by the calls that read that sheet
instead of when the workbook opens, so the other sheets stay readable. A first cut kept the opening
scan to keep the old refusal, at 2.2 times faster; the refusal was judged not worth the scans.
`test/ooxml-sheet-faults.spec.ts` pins where each fault surfaces, including the order the hyperlink
reader's faults keep behind the cell reader's.

The shared pass is held to each reader's own pass: the parity comparison checks every sheet's
validations, tables, conditional formats, images and panes against a reference that scans the part
once per reader, over the fixtures and the 388 corpus files SheetJS reads.

## Reading parts as they inflate

`ooxml-core` now inflates a part from its offset in the archive, checks its length and CRC-32 as it
goes, decodes it and tokenizes it a chunk at a time, and keeps none of its text; every worksheet,
the shared string table, the styles and each table and drawing part are read this way. Peak RSS is
the wrong measure here: with an 8 GiB heap allowed, V8 collects late and RSS moves with when it did.
Two measures that do not depend on it:

| File (four largest) | Heap retained after `describe_workbook`, before → after | Smallest heap that reads it, before → after |
| ------------------- | ------------------------------------------------------- | ------------------------------------------- |
| Izmir water use     | 1492 → 1144 MiB                                         | 1537–1792 → 1281–1344 MiB                   |
| Genome samples      | 868 → 630 MiB                                           | 833–960 → 577–704 MiB                       |
| Izmir social aid    | 851 → 656 MiB                                           | 833–960 → 833–960 MiB                       |
| 15-minute weather   | 308 → 249 MiB                                           | 321–448 → under 321 MiB                     |

Streaming alone barely moved the genome and weather files. V8 cuts a substring of 13 or more
characters as a view that keeps its parent alive, so every shared string and formula a sheet kept
pinned the chunk it was read from, and the chunks together were the whole text again. The tokenizer
now copies the long values it hands on, which is what freed them.

Speed is unchanged within noise on the large files and up to 5% slower on files under 1 MB (30–50
ms a call), measured A/B against the previous commit with every answer the same on all 34 files.
What a read workbook still retains is its cells, each an object with a value object of its own.

## Cells as typed arrays

A sheet's cells were an object each, with a value object of its own, and a row array per row: 120
to 300 bytes a cell, and most of what a read workbook retained. They are now typed arrays, one per
field (column, style, kind, a number or an index into a text pool, a formula reference), with a row
index for lookups: about 21 bytes a cell. Typed arrays live outside the V8 heap, so the retained
measure below counts heap and array buffers together; the heap floor no longer means much.

| File (four largest) | Retained after `describe_workbook`, before → after | Peak RSS, before → after |
| ------------------- | -------------------------------------------------- | ------------------------ |
| Izmir water use     | 1186 → 302 MiB                                     | 1715 → 1154 MiB          |
| Genome samples      | 656 → 259 MiB                                      | 1226 → 679 MiB           |
| Izmir social aid    | 678 → 183 MiB                                      | 1133 → 753 MiB           |
| 15-minute weather   | 263 → 80 MiB                                       | 660 → 425 MiB            |

Speed is unchanged (A/B, three runs, every answer the same on all 34 files), and a full corpus run
matches the previous one on all 480 files. A cell the part stores twice keeps the later one, cells
stored out of order are sorted once, and the counts still include both, as before;
`test/ooxml-cells.spec.ts` pins these and passes on the commit before the change too.

What the peak still holds is transient: the reader builds a cell object per cell before storing it,
and V8 collects them late.

## Charts

`get_charts` reads DrawingML chart parts (`xl/charts`). Chart sheets report
`kind: "chartsheet"` and `chartCount` from `describe_workbook`, and `read_sheet` refuses them with
`chart_sheet` pointing at `get_charts`. Markup Compatibility picks one `AlternateContent` branch so
a chartEx frame is not counted twice. Layer 1 covers type, title, legend, axes, series refs and
cached points (capped). Layer 2 adds secondary axes, axis min/max/logBase and number format, series
trendline types, filtered series as `hidden`, and `pivotSource`. The rules for secondary axes and
hidden series changed after review; see "After review" below.

Run `2026-10-17T17-42-39.464Z` · `chart-testdata` only · 557 files, all probed, no crash or
timeout. `get_charts` answered 651 times with 0 errors. Frames reported: 584 (`describe` chartCount
sum matches). Plots: bar 298, line 136, scatter 57, pie 47, area 17, stock 14, doughnut 13, radar 7,
ofPie 4, bubble 2 (595 plot areas; combos add more than one). `unsupported: chartEx` on 19 frames.
24 chart sheets refused as `chart_sheet` by `read_sheet` / `get_merged_ranges`. Largest
`get_charts` answer was 13 KiB; none hit the 512 KiB budget and none truncated.

Run `2026-10-17T17-45-25.837Z` · the six original sources · 480 files, compared to
`2026-10-17T16-42-58.907Z`. Every outcome change is either the new `get_charts` probe call (375
files) or `empty_sheet` → `chart_sheet` on the 9 chart-sheet workbooks (103 sheet refusals). The 73
response diffs are only `describe_workbook` adding `kind` and `chartCount`. Truly empty sheets stay
at 78 `empty_sheet` answers.

Run `2026-10-17T17-50-54.240Z` · `chart-testdata` after layer 2 · 557 files, 0 outcome changes vs
layer 1; 537 `get_charts` response diffs are additive fields. On that source: secondary axes 32,
logBase 1, min/max 11, numberFormat on 724 axes, trendlines 19, pivotSource 1, external refs 11.
That run reported 10 of 58 series on `us-datagov/…/WeatherStationDataSummary-9-16-24…xlsx` as
hidden; they are not (see below).

openpyxl 3.1.5 census on that run (type + series count per sheet): 618 sheet agreements, 33
mismatches. Series-count gaps are dual-plot / secondary-axis files where openpyxl exposes fewer
series than the DrawingML plots; the 4 type gaps are `ofPie` vs openpyxl's `ProjectedPieChart`.
Report: `openpyxl-chart-parity.json` beside the run.

LibreOffice 26.8.1 (temporary cask) converted all 557 `chart-testdata` xlsx files to ods with 0
failures. ODF `chart:class` counts: bar 1039, line 465, scatter 157, circle 119, area 47, radar 22,
add-in 18, stock 13, ring 13, histogram 7, bubble 6, filled-radar 4; `chart:surface` 0. Compared to
`get_charts` on the same run (`libreoffice-odf-parity.json`): types agree 540, LO-only 8 (chartEx /
histogram / funnel / pareto frames we mark `unsupported` and LO emits as bar), ours-only 5
(combo/doughnut branches LO drops), hard conflict 4 — all `ofPie` vs LO `circle`/`pie` (same charts;
treating ofPie ≡ pie leaves 0 conflicts). Ranges: 426 equal, 94 partial (subset or A1 vs A1:A1
normalization), 37 mismatch (named ranges, external `[n]` refs LO rewrites to file URLs, chartEx
data we do not expose). A hand-built ODS with `chart:surface` exported back to xlsx as `c:barChart`,
so LibreOffice cannot supply a DrawingML surface fixture; surface remains absent from the corpus.

### After review

The first reader tracked its place in a chart part with flags, and a review found answers that were
wrong on corpus files. The reader now matches every element under its parent (ECMA-376 Part 1,
§21.2), which removed these at the root:

- **Cached numbers came back as strings.** A value was a number only when it equalled its shortest
  spelling, but Excel writes 17 significant digits (`68.599999999999994`). 93 of 778 charts and
  316,450 of 1,009,198 cached numbers were returned as strings. A number cache is now numbers and a
  text cache stays text, with the cache's `numberFormat`.
- **A title linked to a cell was empty.** `title/tx/strRef` was read as series data, so the title
  came back as `{ text: "" }` with no ref (12 titles in the corpus).
- **A label could become the series name.** Any `c:tx` inside a series, including a data label's
  or a trendline label's, was taken as the name of a series that had none.
- **Hidden series were wrong both ways.** Any `filtered*` element inside a series marked it hidden.
  The 10 "hidden" series in `WeatherStationDataSummary` carry `c15:filteredSeriesTitle` and
  `c15:filteredCategoryTitle` and are plotted like any other. The series Excel filters out sit as
  `c15:ser` under `c15:filtered*Series` (MS-ODRAWXML, `CT_FilteredBubbleSer` and its siblings) and
  were never read. Only those are `hidden` now; the corpus has none.
- **Multi-level categories were dropped** (`multiLvlStrRef`, 14 series); they now keep their outer
  `levels`.
- **Secondary axes came from `axPos`.** An axis is now secondary when the first plot does not use
  it; 56 axes, against 32 before.
- Series past the per-chart cap are counted in `omittedSeries` and mark the answer truncated; a
  chart part that is absent is `unsupported: "missing"` instead of an empty chart; a one-cell anchor reports its top-left `cell` and size instead of a one-cell range, in `get_images` too (49 of 797 corpus pictures), and sizes are whole pixels; an unknown `chartId` is
  `invalid_argument`; a call without `sheetName` skips chart sheets except in `get_charts`.

The validation runs compared types, series counts and ranges, never cached values or title text,
which is why the first two went through. The missing check is now done: every cached point of a
single-area reference is compared with the cell the reader returns for it. 40,671 points agree
(35,722 numbers, 3,411 texts, 116 text caches of numeric cells, 989 errors, 433 blanks). 1,554
number points are 0 where the cell holds an error and 6 where it holds text, which is how Excel
plots both. 9 points differ, all in LibreOffice test files built for the case: `hidden_cells` and
`plotVisOnly` (a hidden row is left out of the cache), `barchart_totalsrow` and `tdf81396`. 61
references were not checked (unions, external workbooks, names) and 14 span two dimensions.

Run `2026-10-17T21-12-10.995Z` · all 1,037 files, compared to `2026-10-17T17-50-54.240Z` and
`2026-10-17T17-45-25.837Z`: 0 outcome changes, and every response that changed is a `get_charts`
answer. The 559 strings left in value series are `#N/A` (394) and text X values of scatter
charts, both written as text by Excel.

## Replacing csv-parse

### A corpus for CSV

The 88 CSV files above are well-formed: none has a stray, unclosed or misplaced quote, none is
tab or pipe separated, and only 4 hold a line break inside quotes. They say nothing about
malformed or hostile input, so six sources were added (`SOURCE.md` in each records the commit,
license and what was left out):

| Source             | Files | What it holds                                                                                                                                                                | Ground truth                                             |
| ------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `csv-pollock`      | 2,289 | Pollock (PVLDB 16(8)): one clean table with one pollution each: extra or missing delimiters, stray quotes, changed delimiters, quote or escape characters, record delimiters | clean table and dialect per file                         |
| `csv-duckdb`       | 794   | DuckDB's CSV reader test inputs, 278 of them from fuzzers                                                                                                                    | none                                                     |
| `csv-w3c`          | 137   | W3C CSV on the Web test inputs                                                                                                                                               | none                                                     |
| `csv-synthetic`    | 63    | generated here: dialects, quoting, encodings, line endings, malformed quoting, limits, quote bombs, injection payloads                                                       | records built before serializing, or the chosen contract |
| `csv-spectrum`     | 12    | the csv-spectrum acid test                                                                                                                                                   | expected records                                         |
| `csv-wrangling-uk` | 600   | UK public-sector files from the CSV Wrangling study, 18 of them tab separated; the license is presumed OGL                                                                   | the dialect people annotated                             |

A third reader, Python 3.9's `csv` with `strict=True`, kept outside this repository, agrees with
every synthetic table it can read; it cannot read a NUL byte.

### What csv-parse did

csv-parse 7 keeps the first line break form it meets. A file that switches from CRLF to LF reads
the LF as field data, so records merge without an error: DuckDB's `afl/ignore_errors/47.csv` is
3 records to csv-parse and 50 to Python and to the tokenizer. A switch from LF to CRLF leaves a
carriage return at the end of a field. The first 88 real-world files never hit this, because
their bare LFs are Excel line breaks inside quotes; 4 of the 600 UK files do. One of them ends one
record with CRLF and 181 with CR: csv-parse reported 183 records, one of them ragged, where Python
and the tokenizer read 182.

csv-parse also appends a NUL that follows a closing quote to the field, while any other character
there is refused. No corpus file has one; the fuzzer found it.

### The tokenizer

`src/format/csv-tokenizer.ts` is one RFC 4180 state machine: a field is quoted only when it starts
with a quote, anything after a closing quote but a delimiter or line break is a fault, and CRLF,
LF and CR each end a record outside quotes. The field and cell budgets are checked in the same
pass, so the separate width scan before csv-parse is gone. It is checked three ways:

- **Known answers** from RFC 4180 and the contract above (`test/csv-tokenizer.spec.ts`).
- **csv-parse as oracle**, configured with `record_delimiter: ["\r\n", "\n", "\r"]`, which is
  the tokenizer's contract written by a second implementation: 20,000 generated texts in the
  test (300,000 in a longer run) and all 3,983 corpus CSV files
  (`test/corpus-csv-parity.spec.ts`) read the same, refusals included and with the same reason.
  The only departure is the NUL after a closing quote.
- **The server, file by file**, against csv-parse's runs (`2026-10-18T12-15-16.462Z`,
  `2026-10-18T12-30-40.176Z`, and for the UK files the A/B rounds below):

| Result                         | Files | Why                                                                  |
| ------------------------------ | ----- | -------------------------------------------------------------------- |
| Every answer identical         | 2,957 | including all 88 first real-world files and 596 of the 600 UK files  |
| Same refusal, new message      | 1,011 | the message names the fault and line instead of csv-parse's wording  |
| Records differ                 | 13    | line breaks mix outside quotes, 4 of them UK files                   |
| Refused by csv-parse, now read | 2     | CRLF records with a last LF record: csv-parse saw text after a quote |

Speed and memory, A/B: the build before the change (a worktree at `main`) and the new one ran
the same sources alternately, three times each, median taken per file.

| Files                         | Before | After  | Change                                                                                       |
| ----------------------------- | ------ | ------ | -------------------------------------------------------------------------------------------- |
| `csv-synthetic`, 63 files     | 5.3 s  | 2.3 s  | the 16 MiB single field: 2348 ms to 100 ms, 253 to 175 MiB                                   |
| `csv-wrangling-uk`, 600 files | 13.5 s | 14.4 s | process start dominates; the three largest files it parses (4–10 MB) 1.9 to 2.6 times faster |

One case got worse: 8M doubled quotes in one 16 MiB field take 244 ms against 208 ms and peak at
281 MiB against 194 MiB, the cost of unescaping one 16 MiB string. The 31 s that
`hardening.spec.ts` records for 16 MiB on the darwin-x64 runner was csv-parse; that runner has
not measured the tokenizer yet.

### The delimiter sniffer needs no change

Measured against every annotated dialect in the corpus, the sniffer (unchanged by this work)
names the delimiter right for all 600 UK files, all 134 annotated W3C files, all 42 synthetic
tables and 2,287 of 2,289 Pollock files. The two Pollock files use a space and `, ` as their
delimiter, which the server does not offer.

### Found on the way

`encoding: "windows-1252"` returned the bytes 0x80 to 0x9F as C1 control characters: Node 24.12's
`TextDecoder` decodes that label as ISO-8859-1. Four of the ten real-world windows-1252 files hold
such bytes (curly quotes, dashes). They are now mapped through the WHATWG index; the claim above
that windows-1252 reads those ten files correctly held only for their accented letters.

csv-spectrum's `location_coordinates.csv` expects `37°36'37.8"N` to be read with its quote as
data. RFC 4180 forbids a quote in an unquoted field; the server refuses it, as csv-parse did.

### What formulaLikeCellCount counts

LibreOffice 26.8.1, opening a CSV with formula evaluation on, runs a cell only when it starts with
`=` and has more after it: `+cmd|…`, `-2+3+cmd|…`, `-A1` and `@SUM(1+9)` stay text, `-5` and
`-1e5` become numbers, a lone `=` stays text, and a leading tab or space is dropped without
evaluating. The count now follows that: a lone `=` is no longer counted. OWASP's `+`, `-` and `@`
prefixes describe Excel, which was not available to measure; 256,000 corpus cells start with `-`
and are numbers or a dash, so counting the prefix alone would bury the signal. The cases and
LibreOffice's answers are kept beside the corpus in `_tools/csv/formula-like`.

## Typed-text aggregate cost

Measured on 2026-10-18 with `src/aggregate-bench.ts`, using Node v24.19.0 on Linux x64,
an AMD EPYC 9V74 80-Core Processor and a 512 MiB V8 heap limit. These are new synthetic
measurements; the previous machine's external corpus was not available or rerun.

The fixture has exactly 2,000,000 cells (200,000 rows including its header, ten columns) and
16,000,000 UTF-8 bytes, just below the 16 MiB file limit. Its SHA-256 is
`1834ad5838fbeb9c3ca47a2c7534642b91829dacef9907671d715c1fa097d00d`.
Two text dimensions make eight groups; eight numeric text columns contain exact quarter-unit
amounts. Seven groups have 25,000 data rows and one has 24,999. Every measured call checks all
eight groups, 64 independently specified sums, scanned and matched row counts, and metric
counted/skipped totals. A successful response digest alone is not the correctness oracle.

### Before and after phase 1

The pre-phase-1 build at `1cc88fedfba83dd9c1d73542edaa0b583ccdbb61` and the typed-text build at
`ddeced64c1978cc0760b2c0104f2e62ee3ad0579` ran alternately, three fresh workers each. Each
worker made the same `aggregate_sheet` call twice. The old build needed `coerceText: true`;
the new build read the numeric text automatically. Both produced the expected numbers.

| Median of three trials | Before phase 1 |        Phase 1 |             Change |
| ---------------------- | -------------: | -------------: | -----------------: |
| First call             |  644.793419 ms | 4255.648355 ms | 6.60 times as long |
| Cached call            |  410.449058 ms | 4099.916487 ms | 9.99 times as long |
| First-call peak RSS    |     330324 KiB |     374668 KiB |       13.4% higher |
| Whole-worker peak RSS  |     367140 KiB |     472580 KiB |       28.7% higher |

First-call trials in milliseconds were `626.679189, 877.275277, 644.793419` before and
`4255.648355, 4378.779728, 4211.162647` after. Cached-call trials were
`410.449058, 636.252540, 399.887833` before and `4099.916487, 4276.567782, 4008.620263` after.
Whole-worker RSS trials in KiB were `367140, 366804, 369056` before and
`473864, 472580, 462616` after.

Responses grew from 2580 to 3007 bytes because phase 1 adds reading and diagnostic metadata.
Their numeric answers agree, but the old and new complete payloads are intentionally different.
Within each build, first and cached responses had identical digests in every trial.

### Bounded follow-up

`typedCell.number()` now retains its numeric reading for that cell, so multiple metrics reuse
it. Ordinary ASCII decimals with at most 15 integer and 15 fractional digits use a narrow
validation path when the column has already selected a decimal point. Signs and a single zero
are allowed; grouping marks, leading-zero identifiers, long digit-only identifiers, exponent
notation, surrounding whitespace, percent and currency forms still reach the general parser.
The memoization stores one result per live cell wrapper and retains no column or workbook map.

A second paired experiment compared the unchanged phase-1 build with that same build plus only
the `column-reading.ts` performance change. Three fresh workers of each build ran alternately.
The benchmark's five-module implementation hashes distinguish the original build
(`0e4318e9aa756db3c53d7ecc272e2e7a8ef408f5090c420ea7845782945b122e`) from the optimized build
(`f003d77054c77eacb763f91196d4596126d2dd3ee0bbfed71cb8addb7d2d01c9`).

| Median of three trials | Unchanged phase 1 | Phase 1 with follow-up |      Change |
| ---------------------- | ----------------: | ---------------------: | ----------: |
| First call             |    4429.410809 ms |         1813.679267 ms | 59.1% lower |
| Cached call            |    4208.984288 ms |         1482.819535 ms | 64.8% lower |
| First-call peak RSS    |        375444 KiB |             373544 KiB |  0.5% lower |
| Whole-worker peak RSS  |        469916 KiB |             464408 KiB |  1.2% lower |

First-call trials in milliseconds were `4429.410809, 4383.772509, 5028.649198` before and
`1941.661050, 1630.332992, 1813.679267` after. Cached-call trials were
`4148.906556, 4208.984288, 4241.059586` before and `1435.938287, 1482.819535, 1484.193055` after.
Whole-worker RSS trials in KiB were `469916, 467304, 473908` before and
`464408, 462152, 468260` after. The tables report medians of per-worker peaks,
not the largest observed trial. The whole-worker worst observed peaks were 473908 and
468260 KiB; first-call worst observed peaks were 375736 and 376708 KiB. The small median
RSS difference does not establish a memory improvement.

All twelve responses in this second experiment were 3007 bytes and had SHA-256
`0c3efa7abbfdd3dbaf0cf6f302d43fdfa9e7df80bb7b6dd123ee3238a11e0bdc`.
The additional handler-level compatibility case in `test/typed-text.spec.ts` also passes on
both builds: it checks repeated metrics and an `isNumber` predicate across ordinary decimals,
15- and 16-digit integers, leading zeroes, percentages, currency, exponents and grouped text.
This test preserves existing semantics; it is not evidence of a previously wrong answer.
The complete Excel package gate on the isolated follow-up build passed through Turbo:
43 test files and 789 tests passed; the two external-corpus test files were skipped. Build,
lint and type checking also passed for the Excel server and lab.

The follow-up recovers much of the added time but does not remove the regression. Against the
earlier pre-phase-1 medians it is still about 2.8 times as long for the first call and 3.6 times
as long for the cached call. Those ratios span two paired experiments and are indicative,
not another controlled comparison. Peak memory remains materially above the old baseline.
This high-repetition ASCII fixture does not establish performance for every locale, mixed
column or wide workbook. The first call is cold only with respect to the server cache;
operating-system disk caches were not flushed.

### Reproducing the comparison

Build each isolated checkout through Turbo, then run the same benchmark source in each
checkout so its static package imports use that build. The before-phase-1 checkout needs a
copy of this lab file because that commit predates it. For each of three rounds, run these
commands once in the respective checkout roots (do not use `--runs 3` for alternation):

```bash
node packages/lab/excel-lab/src/aggregate-bench.ts --out /tmp/excel-aggregate-phase1-pair --revision 1cc88fedfba83dd9c1d73542edaa0b583ccdbb61 --legacy-coerce-text
node packages/lab/excel-lab/src/aggregate-bench.ts --out /tmp/excel-aggregate-phase1-pair --revision ddeced64c1978cc0760b2c0104f2e62ee3ad0579
```

For the follow-up experiment, use another output directory and two checkouts at `ddeced6`,
applying only the `column-reading.ts` performance change to one. Run the second command
above once in each checkout per round without `--legacy-coerce-text`. The `revision` field
then matches and the implementation hashes distinguish the builds. Generation happens in
the parent, outside the measured worker; no downloaded corpus bytes are needed.

### Phase-2 combined characterization

One fresh worker measured the phase-2 implementation with the same 2,000,000-cell fixture
after the independent phase-1 comparison. The first call took 2458.200012 ms and the cached
call 2174.960371 ms. First-call peak RSS was 379520 KiB; the worker's peak was 401676 KiB.
Both replies were 3007 UTF-8 bytes, and all eight groups and 64 independently specified
metric sums and counts passed. This is one characterization sample, not a paired performance
comparison or evidence that the remaining regression has been eliminated.

The checkout was based on `1e5790cd4f5a026af0e76421b6d4bbd838bb2d9e` with the phase-2 changes.
The benchmark's five-module implementation hash was
`e88813cc4e1131c48d9d2a1877d40581823d7917aeea3da17fdd531a6eb66bbf`; that fingerprint
covers the aggregate entry and phase-1 readers, not every new phase-2 helper. Both replies
had SHA-256 `23e5590c9d6c2c763606af1d18ad1bea0b983fda04fd7b6c7a532d05451a2fd8`.
Future measurements should identify the complete committed revision as well as this fingerprint.

The separate public-handler commerce regression returns an overall total and country,
category, payment and 36-month breakdowns from 2,000 rows and 15 columns in one call.
It returned 50 aggregate rows in 2973 UTF-8 bytes of JSON text, excluding the MCP envelope.
Every expected total is specified independently in `test/aggregate-analysis.spec.ts`.

### Phase-3 combined characterization

One invocation of the same benchmark worker characterized the uncommitted phase-3 tree
based on `d071a1ef2e185e6d1525514701f253125898452b`. First call: 2703.629124 ms; cached call:
2658.669570 ms. First-call peak RSS: 397696 KiB; process peak RSS: 427480 KiB. Both responses
were 3007 bytes and had SHA-256
`23e5590c9d6c2c763606af1d18ad1bea0b983fda04fd7b6c7a532d05451a2fd8`.
All eight groups, 64 known sums and the row/metric counts passed. The five-module
implementation fingerprint was
`f98655f7e6f9b9447e1fda0dead7af2874fff8189d834305490d0ce26984de5b`.

The parent runner received empty child stdout in the workspace sandbox, so this sample ran
the same worker directly with `--max-old-space-size=512`; fixture generation had already
finished. It therefore has a different launch method from the controlled phase-1 pairs and
must not be presented as a new paired experiment. The exact executed command was:

```bash
node --max-old-space-size=512 packages/lab/excel-lab/src/aggregate-bench.ts --worker --out /workspace/scratch/9419ca03a883/excel-benchmark-phase3-current --revision d071a1ef2e185e6d1525514701f253125898452b
```

The original JSON line and methodology note are in that external output directory. This
single sample still shows material cost above the old pre-phase-1 baseline. It predates the
corpus-discovered Myanmar month-alias correction and does not measure localized column
performance or establish the final phase-3 performance distribution. No further optimization
or performance rerun was made on the strength of this one sample.

## Global typed corpus evidence

The new original corpus generator and verifier ran on 2026-10-18 with Node v24.19.0,
ICU 78.3, CLDR 48.0 and Unicode 17.0. It exercises 19 locale/numbering-system configurations
through real MCP calls. The independent oracle chooses exact quarter-unit amounts, dates,
booleans and elapsed seconds before Intl formats the input text. Fixture and oracle digests
are checked before each file is opened. No external private corpus was available or counted.

The first 64-row/configuration test exposed a real bug in the draft global reader: accent
folding merged Myanmar January abbreviation `ဇန်` with June `ဇွန်`, making the locale fail
compilation. A fixed regression with independently specified January/June dates failed before
the change and passed after exact NFC and Unicode case aliases were preserved ahead of
unambiguous folded aliases. The ambiguous stripped spelling `ဇန` is still refused. The
same generated suite covers Bengali and Thai month names, not just Latin-script accents.
The primary Unicode chart and other sources are in [TYPED_TEXT_SOURCES.md](TYPED_TEXT_SOURCES.md).

After that correction the focused lab gate passed all three tests: deterministic fixture/oracle
digests; every raw and typed cell plus grouped totals, predicates, month buckets and reusable
profile plans; and rejection of changed input bytes before tool invocation with a saved replay
failure. Its 19 files contain 1,216 data rows, so it checks 7,296 raw and 7,296 typed cells across
171 MCP calls. All 19 profile plans are reused successfully, including identifiers appearing
after the profile sample. Lab lint and type checking also passed through Turbo.

The standalone corpus run used:

```bash
node packages/lab/excel-lab/src/typed-corpus-cli.ts --out /workspace/scratch/9419ca03a883/excel-global-corpus --seed 1804289383 --rows 250 --revision d071a1ef2e185e6d1525514701f253125898452b
```

It wrote `/workspace/scratch/9419ca03a883/excel-global-corpus/typed-M4YLku` and passed all
19 files: 4,750 data rows, 28,500 raw and 28,500 typed cells, 342 MCP calls and 19 reused
profile plans. Verification took 1069.236280 ms in that process; peak RSS was 201832 KiB.
These timings characterize a small correctness corpus, not a large-file benchmark. The built
twelve-module fingerprint was
`f78fd1d1186fdbd8fa81cb2a001159dd72c668e8f0f2736ae24a0b74abca829b`.
The revision labels the phase-2 parent; the measured implementation includes uncommitted
phase-3 changes. The output records generator and verifier runtime versions separately.

The saved `typed-M4YLku` directory was then replayed with `--verify`, without regenerating
either inputs or expected answers. The same 342 calls and all cell/aggregate checks passed
with the same implementation fingerprint. That verification took 1238.536673 ms and peaked
at 197496 KiB. The first report is retained as `typed-results-initial.json`; the latest replay
is `typed-results.json`. Final lab lint/type checking passed all twelve Turbo tasks.

The focused global parser suite has 40 cases. Its deterministic fuzz case checks 3,000 exact
number round-trips, 6,000 invalid grouping/control mutations and 3,000 leading-zero identifier
spellings under both refusal and explicit-read policies per seed. Invalid locale, numbering
system, calendar, currency and long-text regressions are fixed cases. The six public MCP
global-locale regressions went from six genuine failures on `ddeced6` to six passes: Arabic
digits, Indian grouping, French month filtering and three impossible offset components.
Both the default seed `1804289383` and alternate seed `3435973836` passed the focused
40-case parser suite. The alternate seed was supplied through Turbo with
`SEZZLEE_TYPED_FUZZ_SEED`; the package task passes it through and includes it in the cache key.

Six independent legacy-byte fixtures also pass through the public MCP interface, preserving
their raw identifier strings: windows-1251, windows-1256, Shift_JIS, GB18030, Big5 and EUC-KR.
Four malformed fixtures ending in known multibyte lead bytes produce `undecodable_text`.
The focused encoding plus existing CSV gate passed 38 tests. This is bounded evidence for
those vectors, not proof of complete codec-index conformance or automatic encoding detection.

## Native and rich-value fixture evidence

Phase-4 research resolved the missing linked-data example with the MIT-licensed Microsoft
Open XML SDK `RichData` sample, pinned at `431ab05cf160248cc3885a4a766026d4f8243792`.
The exact upstream source generated an 8,544-byte workbook with SHA-256
`537a61c16e9c09a33d405e5f828d0e17b9462a69396e42203cc77706e63c6a12`.
The SDK's Microsoft365 validator reported zero errors, and an independent Python ZIP/XML
oracle verified `Linked!A1` through `vm`, metadata type, future block, rich value and structure
to `_linkedentity2` and the literal display string `Seattle`. Its metadata relationship targets
`/xl/metadata1.xml`, so this also exercises relationship-based part discovery.

A separate original XlsxWriter 3.2.9 workbook contains in-cell images, explicit dynamic caches,
elapsed times, ordinary errors, native booleans, percentages, identifiers, a table with a totals
row, saved filtered rows and a hidden sheet. A controlled variant adds specification-defined
`_error` records for `#SPILL!` and `#CALC!`, plus separate direct-error cache cases. The rich-error
variant also passed Microsoft365 schema validation with zero errors. The independent verifier
passed all three committed base64 CI snapshots with fixed digests and literal expected values:

```bash
python3 packages/lab/excel-lab/scripts/verify-rich-fixtures.py
```

These checks verify saved bytes and their format meaning. None of the files was recalculated
in Excel, no linked provider or external image was fetched, and no private corpus was used.
The three small fixtures have explicit MIT provenance and are separate from the optional
external corpus. The complete source manifest, exact cell/format matrix, generation commands
and unsupported linked-data scope are in [RICH_VALUE_SOURCES.md](RICH_VALUE_SOURCES.md).
Schema and XML results are not counted as public MCP test passes.

## Phase-4 public-handler and regression evidence

The immutable pre-phase-4 snapshot is `991bc5654de73494d8d1ceeb70ddc8762c485796`.
The external `phase4-red-evidence/baseline-manifests.json` records matching package manifests
and lockfile bytes. The saved RED logs distinguish missing behavior from passing controls:

| Capability                                                      | Baseline result                                                 | Saved evidence and committed regression                                                                                                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native numeric meaning and error distributions                  | 45 failures, 9 passing controls across 54 cases                 | `native-expanded-red.log`; [number-format-meaning.spec.ts](../../servers/excel-mcp/test/number-format-meaning.spec.ts), [native-format-meaning.spec.ts](../../servers/excel-mcp/test/native-format-meaning.spec.ts) |
| Named table bodies and saved row visibility                     | 5 missing-capability failures, 1 passing control across 6 cases | Table subset of `native-and-table-red.log`; [table-visibility.spec.ts](../../servers/excel-mcp/test/table-visibility.spec.ts)                                                                                       |
| In-cell images, dynamic metadata, linked labels and rich errors | 7 failures, 1 passing ordinary-error control across 8 cases     | `rich-expanded-red.log`; [rich-values.spec.ts](../../servers/excel-mcp/test/rich-values.spec.ts), [rich-linked-errors.spec.ts](../../servers/excel-mcp/test/rich-linked-errors.spec.ts)                             |

The first native GREEN log records 135 passing tests across five files, including existing
calendar, temporal-metric and aggregate-analysis tests. Two additional integration defects
were then reproduced against the phase-4 working tree. A headerless table declaring `D5:E6`
with two entirely absent data rows returned `empty_sheet`; the table rectangle now supplies
finite range evidence, and [table-empty-body.spec.ts](../../servers/excel-mcp/test/table-empty-body.spec.ts)
checks the two null rows, both empty profiles, count 2 and nonempty count 0. A 10,000-row
single-column workbook passed its ordinary read control but `visibleOnly` produced 532,986
bytes, exceeding the 524,288-byte response limit because the parallel array's separators were
not fully budgeted. [visible-row-budget.spec.ts](../../servers/excel-mcp/test/visible-row-budget.spec.ts)
now checks all four combinations of `visibleOnly` and `includeTyped`, exact parallel row
alignment, byte limits and continuation cursors. The subsequent root integration run passed
77 tests across eight files, including these two regressions and existing read, header,
profile, cursor and typed-I/O cases.

The independent [rich-differential.spec.ts](../../servers/excel-mcp/test/rich-differential.spec.ts)
passed all six tests through Turbo. It asserts the exact modern and historical adapter
snapshots for the three fixed original workbooks. Image and linked cells differ from the
stored `#VALUE!` compatibility fallback; elapsed seconds are checked against independent
literal day/second answers; metadata-backed `#SPILL!` and `#CALC!` differ while direct error
caches agree. SheetJS 0.20.3 itself retains the dynamic `F` and `D` fields in this fixture;
the historical adapter discards them. The test records that specific adapter loss and keeps
ordinary errors, booleans, identifiers and numeric caches as exact controls. It does not add
a blanket mismatch exclusion to the corpus comparator.

Three additional public regressions reproduced a composition loss: an unsupported rich type
lost its diagnostic when the same cell already had a formula, hyperlink or truncation note.
The closed `richValue` annotation now preserves both facts. Two further regressions moved
verified rich-image targets outside `xl/media/` and exposed colliding `imageId: -1` values.
Existing media IDs are preserved and sorted verified rich targets append deterministic IDs,
independently of worksheet and call order. Distinct decorative images remain distinct, and
unused invalid rich-value records are not eagerly interpreted.

The final whole-package phase-4 Turbo gate passed **1,076 tests**, with one optional external
CSV corpus test skipped: 64 test files passed and one was skipped. Lint and type checking also
passed, with 12 successful Turbo tasks. Documentation generation and validation passed, and
the actual formula/table recipe refreshed eight command outputs. The earlier final integration
fixture required a correct styles content-type declaration for the independent SheetJS reader;
that correction changed only the fixture. These checks use original generated fixtures and
saved values; they do not claim external corpus, Excel recalculation or phase-4 performance
coverage.

## Next steps

1. Keep legacy decoding explicit. The global typed-text work selected a closed encoding list
   with fatal decoding; no Turkish/Western or global encoding guess is made. Expand it only
   with independent byte fixtures and clear runtime support.
2. Measure what Excel runs when it opens a CSV, with the cases in `_tools/csv/formula-like`, and
   widen `formulaLikeCellCount` only for what it measures.
3. Then `xml-mcp` (`libxml2-wasm` is a separate decision).
