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

## Next steps

1. Measure how long a read holds the main thread, and how many corpus files have more than one
   large sheet, to decide whether reading belongs in a worker.
2. Report chart sheets honestly, then read charts. A chart stores both the cell ranges it plots
   and a cached copy of their values, so every chart is a built-in check against the cells.
3. Examine the 13 CSV files and decide on single-byte encodings.
4. Extend the oracle beyond empty sheets to cell values, and keep a small hand-checked gold set for
   the cells where the readers disagree.
