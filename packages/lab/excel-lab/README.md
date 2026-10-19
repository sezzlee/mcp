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
corpus. The 19 locale/system configurations cover European, Indian, Arabic, Persian, Bengali,
Thai, Myanmar, Japanese, Chinese and Korean data. Each file includes localized numeric text,
twelve Gregorian month names, explicit custom boolean/missing words, signed durations and
leading-zero identifiers.

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

Every raw cell and typed value is checked across cursor pages. Additional calls check grouped
numeric/duration sums, true-token predicates, month buckets and reuse of the profiler's
emitted column plans. An identifier appears after its 32-row sample and must stay out of the
reused numeric total. Amounts are exact quarter units chosen before Intl serialization;
expected sums never come from the server under test.

The saved directory contains `run.json` with seed, row count and Node/ICU/CLDR/Unicode
versions, a standard `typed-global-v1/manifest.jsonl`, CSV files, separate expected-answer
JSON files and `typed-results.json`. Input and oracle files each have SHA-256 digests.
Verification replaces the last result report and retains the input/oracle bytes. Failed
verification saves its message and completed counts, and prints the seed and replay path.
Generated bytes are repeatable for the same seed and Intl data version; replaying the saved
bytes also supports comparisons after an ICU upgrade.

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
