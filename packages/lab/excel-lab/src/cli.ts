import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { FileResult } from "./record.ts";
import { runCorpus } from "./run.ts";

const usage = `Usage: node src/cli.ts [--corpus <dir>] [--out <dir>] [--source <name>]... [--limit <n>] [--timeout-ms <n>] [--heap-mib <n>]

  --corpus      corpus root; defaults to $SEZZLEE_CORPUS
  --out         output root; defaults to <corpus>/_eval/excel-lab
  --source      a source folder to include; repeatable; defaults to every source
  --limit       probe at most this many files
  --timeout-ms  per-file wall clock limit, default 120000
  --heap-mib    per-file V8 heap limit, default 2048
`;

const optionsSchema = z.object({
  corpus: z.string().min(1),
  out: z.string().min(1).optional(),
  source: z.array(z.string().min(1)).optional(),
  limit: z.coerce.number().int().positive().optional(),
  timeoutMs: z.coerce.number().int().positive().default(120_000),
  heapMiB: z.coerce.number().int().positive().default(2048),
});

function detail(result: FileResult): string {
  switch (result.kind) {
    case "probed": {
      const errors = result.calls.filter(
        (call) => call.outcome.kind === "error",
      );
      const first = errors[0]?.outcome;
      const code = first?.kind === "error" ? ` ${first.code}` : "";
      return `${errors.length === 0 ? "ok" : `errors=${errors.length}${code}`} ${Math.round(result.ms)}ms ${Math.round(result.maxRssKiB / 1024)}MiB`;
    }
    case "timed_out":
      return `timed out after ${result.ms}ms`;
    case "crashed":
      return `crashed exit=${result.exitCode} signal=${result.signal}`;
    case "missing":
    case "sha_mismatch":
    case "bad_report":
      return result.kind;
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

const { values } = parseArgs({
  options: {
    corpus: { type: "string" },
    out: { type: "string" },
    source: { type: "string", multiple: true },
    limit: { type: "string" },
    "timeout-ms": { type: "string" },
    "heap-mib": { type: "string" },
    help: { type: "boolean" },
  },
  strict: true,
});

if (values.help === true) {
  process.stdout.write(usage);
  process.exit(0);
}

const parsed = optionsSchema.safeParse({
  corpus: values.corpus ?? process.env["SEZZLEE_CORPUS"],
  out: values.out,
  source: values.source,
  limit: values.limit,
  timeoutMs: values["timeout-ms"],
  heapMiB: values["heap-mib"],
});
if (!parsed.success) {
  process.stderr.write(`${z.prettifyError(parsed.error)}\n\n${usage}`);
  process.exit(2);
}
const options = parsed.data;

const summary = await runCorpus({
  corpusRoot: options.corpus,
  outRoot: options.out ?? join(options.corpus, "_eval", "excel-lab"),
  ...(options.source === undefined ? {} : { sources: options.source }),
  ...(options.limit === undefined ? {} : { limit: options.limit }),
  timeoutMs: options.timeoutMs,
  heapMiB: options.heapMiB,
  onResult: ({ index, total, result }) => {
    process.stderr.write(
      `[${index + 1}/${total}] ${result.entry.source}/${result.entry.file} ${detail(result)}\n`,
    );
  },
});

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
