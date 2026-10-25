# @sezzlee/excel-lab

The corpus harness for `@sezzlee/excel-mcp`. It runs the built server over a local corpus of
real-world workbooks and records, per file, what every tool call answered, how long it took and
how much memory the process needed.

## What this is

This package is **not product code**. It exists to measure the Excel server on files nobody wrote
for a test, and to keep a record of those answers so a change to the reading engine can be
compared against the previous one, file by file.

## What this will never be

- No `build` script, so no `dist/`. The package cannot be imported.
- No `main`, `types`, `exports`, `files`, `bin` or `publishConfig`. `private: true`.
- Not listed in any package's `dependencies`, `devDependencies` or `peerDependencies`, and never
  added to the `pack` job's filter list.
- **No corpus file and no corpus output in this repository.** Several corpus licenses forbid
  redistribution. The harness reads the corpus where it lives and refuses an output directory
  inside the repository.

## Corpus layout

The harness reads any folder laid out as one directory per source:

```text
<corpus>/
  <source>/
    files/...        original bytes
    manifest.jsonl   one JSON object per file: file, sha256, bytes, format, license
```

Folders whose name starts with `_` or `.` are skipped. Lines whose `format` is not `xlsx`, `xlsm`
or `csv` are counted as unsupported and not probed. A line whose `file` is absolute or leaves its
source folder is rejected. A file whose bytes do not match `sha256` is recorded as
`sha_mismatch` and not probed, so two runs always compare the same bytes.

## What one file costs

Each file runs in its own `node` process (`src/probe.ts`), one at a time, with a V8 heap limit
and a wall clock limit. The probe connects an MCP client to an in-process server rooted at the
file's folder and calls, in order:

1. `describe_workbook`
2. for each of the first 25 sheets: `read_sheet` (first page, `valueMode: "both"` for xlsx and
   xlsm) and, for xlsx and xlsm, `get_merged_ranges`

It writes exactly one JSON line on stdout. A tool error is data: it is recorded with its error
code, and the run goes on.

## Output

```text
<out>/<run id>/
  run.json                 node version, excel-mcp version, commit, options
  results.jsonl            one line per file: outcome, timings, maxRSS, response digests
  responses/<sha256>.json  the verbatim tool responses for one file
  summary.json             counts per outcome, tool error codes, slowest and largest files
```

The default output root is `<corpus>/_eval/excel-lab`. What the runs found so far is in
[FINDINGS.md](FINDINGS.md).

## Running

```bash
pnpm turbo run check-types lint --filter=@sezzlee/excel-lab
pnpm turbo run test --filter=@sezzlee/excel-lab
SEZZLEE_CORPUS=/path/to/corpus pnpm turbo run corpus --filter=@sezzlee/excel-lab --ui=stream -- --source tr-tuik --limit 10
SEZZLEE_CORPUS=/path/to/corpus pnpm turbo run corpus --filter=@sezzlee/excel-lab --ui=stream -- --format csv
```

The `corpus` task builds `@sezzlee/excel-mcp` first, so the run always uses the current source.
`--help` lists every option.

## Typed aggregate benchmark

`src/aggregate-bench.ts` generates an original, MIT-licensed CSV outside the repository:
200,000 rows including the header, 10 columns, 2,000,000 cells and exactly 16,000,000 bytes.
It measures eight grouped sums through the MCP interface and checks every result against
hand-calculated answers. It does not need the external corpus.

```bash
pnpm turbo run build --filter=@sezzlee/excel-mcp --ui=stream
node packages/lab/excel-lab/src/aggregate-bench.ts --out /tmp/excel-aggregate-bench --revision "$(git rev-parse HEAD)" --runs 3
```

Run the command from the repository root. `--revision` labels the measured checkout with its
full commit hash; it does not check out that commit or build it. The report also hashes five
built grid modules, so a local performance change can be distinguished from its base commit.
`--legacy-coerce-text` adds `coerceText: true` for the pre-typed-text server at `1cc88fe`.

Each trial starts a fresh worker with a 512 MiB V8 heap limit (`--heap-mib` can change it).
The first call includes opening and parsing the CSV; the second uses the server's workbook
cache but still reads and hashes the file. Fixture generation and process startup are outside
the call timings. `maxRssKiB` is the worker's peak resident memory, including native allocations,
so it is not a measurement of V8 heap usage. A trial fails on a wrong answer, tool error or
120-second worker timeout.

The output root contains `aggregate-2000000-cells.csv`, `aggregate-fixture.json` with its digest
and license, and append-only `aggregate-results.jsonl` with timings, environment, peak memory
and response digests. For a comparison, build isolated checkouts and alternate one invocation
of each three times; a single `--runs 3` command does not alternate builds. Keep each paired
experiment in a separate output directory. The measured phase-1 comparison and its limits are
recorded in [FINDINGS.md](FINDINGS.md#typed-text-aggregate-cost).

## Global typed corpus and fuzz replay

`src/typed-corpus-cli.ts` generates original, MIT-licensed CSV files and independent known
answers outside the repository, then verifies them through the built MCP. It needs no private
corpus. The `typed-global-v2` generator creates 37 six-column fixtures. It retains the original
19 locale/system spelling recipes and adds nine complete `Intl.DateTimeFormat` long Gregorian
date outputs and nine numeric date shapes. The long dates cover Turkish, Hindi with Latin and
Devanagari digits, Chinese, Japanese, Korean, British English, American English and Russian.
Numeric dates exercise slash, dash and dot separators with Latin, Arabic, Persian, Devanagari,
Bengali, Myanmar, Thai and fullwidth digits. Every added fixture mixes days at most 12 with
days above 12; the DMY/MDY fixtures therefore exercise order decisions from column evidence.
Every file still includes
localized amounts, explicit custom boolean/missing words, signed durations and leading-zero
identifiers.

```bash
pnpm turbo run build --filter=@sezzlee/excel-mcp --ui=stream
node packages/lab/excel-lab/src/typed-corpus-cli.ts --out /tmp/excel-typed-corpus --seed 1804289383 --rows 250 --revision "$(git rev-parse HEAD)"
node packages/lab/excel-lab/src/typed-corpus-cli.ts --verify /tmp/excel-typed-corpus/typed-REPLACE --revision "$(git rev-parse HEAD)"
pnpm turbo run test --filter=@sezzlee/excel-lab --ui=stream -- test/typed-corpus.spec.ts
SEZZLEE_TYPED_FUZZ_SEED=3435973836 pnpm turbo run test --filter=@sezzlee/excel-mcp --ui=stream -- test/global-parser.spec.ts
```

Run the CLI from the repository root. Its first output line gives the actual fresh `typed-*`
directory to use for replay. `--out` generates and checks; `--verify` reuses saved bytes and
saved expected answers without reformatting them. `--rows` accepts 64–5000 rows per file and
defaults to 250; `--seed` is an unsigned 32-bit integer and defaults to 1804289383.
`--revision` is a caller-supplied source label. The report independently hashes the built
reader, profiler, aggregation and CSV modules; it does not build or check out that revision.

Every raw cell and explicitly typed value is checked across cursor pages. Additional calls
check grouped numeric/duration sums, true-token predicates and month buckets with explicit
formats and automatic inference. The profiler's emitted plan is reused for totals, month
buckets and a paged Date-column read whose complete civil dates must match the independent
answers. These date checks also cover the original 19 spelling recipes. An identifier appears
after the profiler's 32-row sample and must stay out of the reused numeric total. Amounts are
exact quarter units, and Gregorian civil dates are chosen before serialization; neither
expected dates nor sums come from the server under test.

Four long-date fixtures deliberately record an automatic-reading boundary: Chinese and
Japanese year/month/day markers, Korean year/month/day markers and the Russian year suffix.
Their explicit formats must recover every date. Without a format, month grouping must leave
all those rows ungrouped, and the profile must retain the Date column as text. This is a
checked capability boundary, not an ignored mismatch or a claim of automatic support for
every localized date string.

The saved directory contains `run.json` with seed, row count and Node/ICU/CLDR/Unicode
versions and the generator source digest, a standard `typed-global-v2/manifest.jsonl`, CSV
files, separate expected-answer JSON files and `typed-results.json`. Input and oracle files
each have SHA-256 digests. The manifest states each date shape, explicit format and expected
automatic-reading capability independently of the reader's result.
Verification replaces the last result report and retains the input/oracle bytes. Failed
verification saves its message and completed counts, and prints the seed and replay path.
Generated bytes are repeatable for the same seed and Intl data version; replaying the saved
bytes also supports comparisons after an ICU upgrade.

`--verify` still accepts saved `typed-global-v1` runs, including their original configuration
shape and directory name. It reads and hashes the saved CSV and oracle files without
regenerating or relabeling them. Old runs have no generator-source digest, so that report
field is `null`. Copy a historical run to a fresh external directory before verification
when its earlier `typed-results.json` must also be retained. A two-row, independently authored
v1 wire fixture exercises that compatibility in CI; it does not replace replay of the saved
19-file generated corpus.

The focused parser test accepts `SEZZLEE_TYPED_FUZZ_SEED`, which Turbo passes through and
includes in its test cache key. Per seed, it checks 3,000 valid locale-formatted numbers,
6,000 invalid grouping/control mutations, and 3,000 identifier spellings under both protective
and explicit-read policies. Fixed regressions add date ambiguity, combining scripts, malformed
offsets, currencies, ratios, legacy encodings and bounded hostile input. Primary sources,
redistribution choices and the precise supported scope are in
[TYPED_TEXT_SOURCES.md](TYPED_TEXT_SOURCES.md).

## Native and rich-value fixtures

The Excel package retains three small MIT-licensed CI snapshots: an original XlsxWriter
workbook, a linked-data workbook produced by Microsoft's pinned Open XML SDK example,
and an original specification-derived rich-error variant. They are distinct from the optional
external corpus. A fixed Python ZIP/XML oracle checks their decoded hashes and saved
meaning independently of the MCP reader:

```bash
python3 packages/lab/excel-lab/scripts/verify-rich-fixtures.py
```

The optional verifier requires only Python's standard library, performs no network access,
and writes JSON to stdout. MCP tests consume the same committed bytes without requiring
Python or .NET. The source manifest, independent cell/format matrix, licensing, schema
validation and limits are in [RICH_VALUE_SOURCES.md](RICH_VALUE_SOURCES.md). None of these
fixtures is presented as an Excel recalculation or a live linked-provider test.

## Phase 1 writing acceptance

Build the server, then run the isolated writing benchmark outside the repository:

```sh
pnpm turbo run build --filter=@sezzlee/excel-mcp
node packages/lab/excel-lab/src/write-bench.ts --out /tmp/excel-write-evidence --rows 50000 --columns 20 --heap-mib 1024 --dataset sequence
node packages/lab/excel-lab/src/write-bench.ts --out /tmp/excel-write-evidence --rows 50000 --columns 20 --heap-mib 1024 --dataset mixed
```

Each invocation creates a fresh write-* directory and starts one child process with a fixed V8 heap and a 180-second wall limit. It creates a million-cell block, corrects A1 from the exact selected version, repeats that correction against the same source and checks that the output version is reused while the original bytes remain unchanged. Results include call timings, serialized input and response sizes, output versions and sizes, platform, peak RSS, and hashes of the generator and built writing implementation. RSS includes native allocations and can exceed the V8 heap limit. These local measurements do not establish a service latency guarantee or other-platform support.

The sequence dataset contains the integers 0 through 999999. The mixed dataset covers leading-zero text identifiers, exact quarter-unit numbers, booleans, blank cells, empty text, ISO dates, local datetimes, Unicode, XML metacharacters, literal SpreadsheetML escape sequences and CRLF. Blank cells are omitted, so the million input cells produce 950000 stored cells in the 20-column mixed dataset.

The standard-library Python oracle verifies every stored value against independently specified coordinate-based answers, checks blank omission, package CRCs, sheet relationships and absence of formulas/external relationships. It performs no network access:

```sh
python3 packages/lab/excel-lab/scripts/verify-written-workbook.py /tmp/excel-write-evidence/write-REPLACE/out/CREATE-HASH.xlsx --sequence-rows 50000 --columns 20 --dataset mixed
python3 packages/lab/excel-lab/scripts/verify-written-workbook.py /tmp/excel-write-evidence/write-REPLACE/out/EDIT-HASH.xlsx --sequence-rows 50000 --columns 20 --dataset mixed --edited
```

Use --dataset sequence for numeric runs. The generic --expected input accepts an independently authored JSON object containing sheets: [{ name, cells: { A1: { kind, value } } }]; blank entries are expected to be omitted. Oracle success is distinct from the benchmark's in-house MCP checks. Neither claims live Excel execution, recalculation or an Open XML XSD validation.
