import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { readCorpus } from "../manifest.ts";
import type { CorpusEntry } from "../record.ts";
import { prepareOutRoot } from "../run.ts";
import { parserNames } from "./events.ts";

const usage = `Usage: node src/parser-bench/cli.ts --mode verify|time [--corpus <dir>] [--out <dir>] [--largest <n>] [--repeat <n>]

  verify   every xlsx/xlsm part through every parser; the event streams must agree
  time     the largest files, each parser in a fresh process per run
`;

const optionsSchema = z.object({
  mode: z.enum(["verify", "time"]),
  corpus: z.string().min(1),
  out: z.string().min(1).optional(),
  largest: z.coerce.number().int().positive().default(5),
  repeat: z.coerce.number().int().positive().default(3),
  heapMiB: z.coerce.number().int().positive().default(4096),
  timeoutMs: z.coerce.number().int().positive().default(600_000),
});

const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    parser: z.string(),
    kind: z.literal("read"),
    sha256: z.string(),
    events: z.number(),
  }),
  z.object({
    parser: z.string(),
    kind: z.literal("refused"),
    reason: z.string(),
  }),
]);
const verifySchema = z.object({
  parts: z.array(
    z.object({
      part: z.string(),
      bytes: z.number(),
      outcomes: z.array(outcomeSchema),
    }),
  ),
});
const timeSchema = z.object({
  ms: z.number(),
  cells: z.number(),
  refused: z.number(),
  partChars: z.number(),
  baseRssKiB: z.number(),
  maxRssKiB: z.number(),
});

const runOne = fileURLToPath(new URL("./run-one.ts", import.meta.url));

function child(
  args: readonly string[],
  heapMiB: number,
  timeoutMs: number,
): Promise<
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly why: string }
> {
  return new Promise((resolve) => {
    const process_ = spawn(
      process.execPath,
      [`--max-old-space-size=${String(heapMiB)}`, runOne, ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    process_.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    process_.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    const timer = setTimeout(() => process_.kill("SIGKILL"), timeoutMs);
    process_.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve(
        code === 0
          ? { ok: true, stdout }
          : {
              ok: false,
              why: `exit=${String(code)} signal=${String(signal)} ${stderr.trim().split("\n").at(-1) ?? ""}`,
            },
      );
    });
  });
}

function lastLine(stdout: string): unknown {
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function workbooks(entries: readonly CorpusEntry[]): CorpusEntry[] {
  return entries.filter(
    (entry) => entry.format === "xlsx" || entry.format === "xlsm",
  );
}

async function verify(
  entries: readonly CorpusEntry[],
  outDir: string,
  heapMiB: number,
  timeoutMs: number,
) {
  const lines: string[] = [];
  const patterns: Record<string, number> = {};
  let parts = 0;
  let agreeing = 0;
  const failures: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const result = await child(
      ["--mode", "verify", "--file", entry.path],
      heapMiB,
      timeoutMs,
    );
    const file = `${entry.source}/${entry.file}`;
    if (!result.ok) {
      failures.push(`${file}: ${result.why}`);
      process.stderr.write(
        `[${String(index + 1)}/${String(entries.length)}] ${file} failed: ${result.why}\n`,
      );
      continue;
    }
    const report = verifySchema.parse(lastLine(result.stdout));
    for (const part of report.parts) {
      parts += 1;
      const first = part.outcomes[0];
      const same = part.outcomes.every((outcome) =>
        first === undefined
          ? false
          : outcome.kind === first.kind &&
            (outcome.kind === "refused" ||
              (first.kind === "read" && outcome.sha256 === first.sha256)),
      );
      if (same) {
        agreeing += 1;
        continue;
      }
      const pattern = part.outcomes
        .map(
          (outcome) =>
            `${outcome.parser}=${outcome.kind === "read" ? outcome.sha256.slice(0, 8) : "refused"}`,
        )
        .join(" ");
      patterns[pattern] = (patterns[pattern] ?? 0) + 1;
      lines.push(JSON.stringify({ file, ...part }));
    }
    process.stderr.write(
      `[${String(index + 1)}/${String(entries.length)}] ${file}\n`,
    );
  }
  await writeFile(
    join(outDir, "verify-disagreements.jsonl"),
    lines.map((line) => `${line}\n`).join(""),
  );
  const summary = {
    files: entries.length,
    parts,
    agreeing,
    disagreeing: parts - agreeing,
    failures,
    patterns,
  };
  await writeFile(
    join(outDir, "verify.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}

async function time(
  entries: readonly CorpusEntry[],
  outDir: string,
  largest: number,
  repeat: number,
  heapMiB: number,
  timeoutMs: number,
) {
  const chosen = [...entries]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, largest);
  const contenders = ["none", ...parserNames, "core"] as const;
  const samples = new Map<string, z.infer<typeof timeSchema>[]>();
  const failures: string[] = [];
  for (let round = 0; round < repeat; round += 1) {
    for (const entry of chosen) {
      for (const parser of contenders) {
        const key = `${entry.source}/${entry.file}\u0000${parser}`;
        const result = await child(
          ["--mode", "time", "--file", entry.path, "--parser", parser],
          heapMiB,
          timeoutMs,
        );
        if (!result.ok) {
          failures.push(`${entry.file} ${parser}: ${result.why}`);
          continue;
        }
        const sample = timeSchema.parse(lastLine(result.stdout));
        samples.set(key, [...(samples.get(key) ?? []), sample]);
        process.stderr.write(
          `round ${String(round + 1)} ${entry.file} ${parser} ${String(Math.round(sample.ms))}ms ${String(Math.round(sample.maxRssKiB / 1024))}MiB\n`,
        );
      }
    }
  }
  const files = chosen.map((entry) => {
    const of = (parser: string) =>
      samples.get(`${entry.source}/${entry.file}\u0000${parser}`) ?? [];
    const baseline = median(of("none").map((sample) => sample.maxRssKiB));
    return {
      file: `${entry.source}/${entry.file}`,
      bytes: entry.bytes,
      partChars: of("none")[0]?.partChars ?? null,
      decodedRssMiB: Math.round(baseline / 1024),
      parsers: Object.fromEntries(
        [...parserNames, "core"].map((parser) => {
          const runs = of(parser);
          return [
            parser,
            {
              runs: runs.length,
              medianMs: Math.round(median(runs.map((sample) => sample.ms))),
              medianPeakMiB: Math.round(
                median(runs.map((sample) => sample.maxRssKiB)) / 1024,
              ),
              overDecodedMiB: Math.round(
                (median(runs.map((sample) => sample.maxRssKiB)) - baseline) /
                  1024,
              ),
              cells: runs[0]?.cells ?? null,
              refusedParts: runs[0]?.refused ?? null,
            },
          ];
        }),
      ),
    };
  });
  const summary = { repeat, node: process.version, files, failures };
  await writeFile(
    join(outDir, "time.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    corpus: { type: "string", default: process.env.SEZZLEE_CORPUS },
    out: { type: "string" },
    largest: { type: "string" },
    repeat: { type: "string" },
    "heap-mib": { type: "string" },
    "timeout-ms": { type: "string" },
  },
});
const parsed = optionsSchema.safeParse({
  mode: values.mode,
  corpus: values.corpus,
  out: values.out,
  largest: values.largest,
  repeat: values.repeat,
  heapMiB: values["heap-mib"],
  timeoutMs: values["timeout-ms"],
});
if (!parsed.success) {
  process.stderr.write(usage);
  process.exit(2);
}
const options = parsed.data;
const outRoot = await prepareOutRoot(
  options.out ?? join(options.corpus, "_eval", "excel-lab", "parser-bench"),
);
const outDir = join(outRoot, new Date().toISOString().replaceAll(":", "-"));
await mkdir(outDir, { recursive: true });
const scan = await readCorpus({ root: options.corpus });
const entries = workbooks(scan.entries);
const summary =
  options.mode === "verify"
    ? await verify(entries, outDir, options.heapMiB, options.timeoutMs)
    : await time(
        entries,
        outDir,
        options.largest,
        options.repeat,
        options.heapMiB,
        options.timeoutMs,
      );
process.stdout.write(`${JSON.stringify({ outDir, ...summary }, null, 2)}\n`);
