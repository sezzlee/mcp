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

| Tool · code                                          | Count                  | Where                                | Reading                                                               |
| ---------------------------------------------------- | ---------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `read_sheet` · `empty_sheet`                         | 181 sheets in 55 files | mostly `us-datagov` (119)            | 78 truly empty, 103 chart sheets (see Correctness check)              |
| `describe_workbook` · `undecodable_text`             | 13                     | all CSV: uk 5, eu 4, tr-ckan 3, us 1 | probably Windows-1254 or Latin-1; not yet examined                    |
| `describe_workbook` · `corrupt_workbook`             | 5                      | `apache-testdata`                    | damaged on purpose upstream; the diagnosis itself is not yet verified |
| `describe_workbook` · `file_too_large`               | 2                      | `us-datagov` CSV                     | over the size limit                                                   |
| `read_sheet` · `ambiguous_header_row`                | 2                      | `uk-datagov`                         | the header row is unclear; the server refuses rather than guesses     |
| `read_sheet`, `get_merged_ranges` · `resource_limit` | 1 + 1                  | one `tr-ckan` file                   | over a resource limit                                                 |
| `describe_workbook` · `encrypted_workbook`           | 1                      | `apache-testdata`                    | encrypted, as expected                                                |

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
- **CSV encodings**: 13 files are refused as undecodable; whether they are readable in a
  single-byte encoding has not been checked.

## What we know and what we do not

| Known                                   | Not yet known                                        |
| --------------------------------------- | ---------------------------------------------------- |
| No file crashes or hangs the server     | Whether the cell values it returns are right         |
| Memory is the limit on large files      | Whether the 5 `corrupt_workbook` diagnoses are right |
| No sheet with data is reported as empty | What encoding the 13 refused CSV files use           |
| 103 chart sheets are reported as empty  | Sheets 26 and later of 11 workbooks                  |

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

## Next steps

1. Performance, measured by this harness on the five large files: choose the XML parser from a
   benchmark (ROADMAP), scan each sheet part once, stream inflation and parsing, and store cells
   compactly. SheetJS is now a dev dependency only, the oracle the reader is compared against.
2. Report chart sheets honestly, then read charts. A chart stores both the cell ranges it plots
   and a cached copy of their values, so every chart is a built-in check against the cells.
3. Examine the 13 CSV files and decide on single-byte encodings.
4. Extend the oracle beyond empty sheets to cell values, and keep a small hand-checked gold set for
   the cells where the readers disagree.
