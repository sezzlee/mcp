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
```

The `corpus` task builds `@sezzlee/excel-mcp` first, so the run always uses the current source.
`--help` lists every option.
