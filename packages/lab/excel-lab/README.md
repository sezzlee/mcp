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
