import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readCorpus, type ManifestRejection } from "./manifest.ts";
import {
  probeReportSchema,
  type CorpusEntry,
  type EntryRef,
  type FileResult,
  type FileResultKind,
  type ProbeFormat,
  type Sha256,
  isSha256,
} from "./record.ts";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const probeEntry = fileURLToPath(new URL("./probe.ts", import.meta.url));
const maxReportBytes = 64 * 1024 * 1024;
const stderrTailBytes = 4096;

export interface RunOptions {
  readonly corpusRoot: string;
  readonly outRoot: string;
  readonly sources?: readonly string[];
  readonly formats?: readonly ProbeFormat[];
  readonly limit?: number;
  readonly timeoutMs: number;
  readonly heapMiB: number;
  readonly onResult?: (progress: {
    readonly index: number;
    readonly total: number;
    readonly result: FileResult;
  }) => void;
}

export interface RunSummary {
  readonly runDir: string;
  readonly files: number;
  readonly counts: Readonly<Record<FileResultKind, number>>;
  readonly toolErrors: Readonly<Record<string, number>>;
  readonly slowest: readonly { readonly file: string; readonly ms: number }[];
  readonly largestRss: readonly {
    readonly file: string;
    readonly maxRssKiB: number;
  }[];
  readonly rejected: readonly ManifestRejection[];
  readonly unsupported: number;
}

function isInside(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/**
 * Guard: the run directory holds verbatim cell text from corpus files, and
 * several corpus licenses forbid redistribution. This repository is public,
 * so an output root inside it is refused — checked on the resolved path before
 * anything is created and again on the real path once it exists, so a symlink
 * into the tree does not get past it.
 */
export async function prepareOutRoot(outRoot: string): Promise<string> {
  const repository = await realpath(repositoryRoot);
  const refuse = (): never => {
    throw new Error(
      `output directory is inside the repository (${repository}); corpus content must stay out of it`,
    );
  };
  if (isInside(repository, resolve(outRoot))) refuse();
  await mkdir(outRoot, { recursive: true });
  const real = await realpath(outRoot);
  if (isInside(repository, real)) refuse();
  return real;
}

async function sha256OfFile(path: string): Promise<Sha256> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  const digest = hash.digest("hex");
  if (!isSha256(digest)) throw new Error(`unexpected sha256 digest: ${digest}`);
  return digest;
}

function refOf({
  source,
  file,
  sha256,
  bytes,
  format,
  license,
}: CorpusEntry): EntryRef {
  return { source, file, sha256, bytes, format, license };
}

type ProbeExit =
  | {
      readonly kind: "exited";
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly kind: "failed";
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly stderr: string;
    }
  | { readonly kind: "timed_out"; readonly ms: number }
  | { readonly kind: "oversized"; readonly stderr: string };

function runProbe({
  entry,
  timeoutMs,
  heapMiB,
}: {
  readonly entry: CorpusEntry;
  readonly timeoutMs: number;
  readonly heapMiB: number;
}): Promise<ProbeExit> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${heapMiB}`,
        probeEntry,
        dirname(entry.path),
        basename(entry.path),
        entry.format,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let verdict: ProbeExit | undefined;
    const started = Date.now();
    const timer = setTimeout(() => {
      verdict = { kind: "timed_out", ms: Date.now() - started };
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxReportBytes) {
        verdict ??= { kind: "oversized", stderr };
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-stderrTailBytes);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (verdict !== undefined) {
        resolvePromise(verdict);
        return;
      }
      if (exitCode !== 0) {
        resolvePromise({ kind: "failed", exitCode, signal, stderr });
        return;
      }
      resolvePromise({
        kind: "exited",
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr,
      });
    });
  });
}

function parseReport(
  stdout: string,
): z.infer<typeof probeReportSchema> | undefined {
  const last = stdout.trimEnd().split("\n").at(-1) ?? "";
  try {
    const parsed = probeReportSchema.safeParse(JSON.parse(last));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function probeFile({
  entry,
  timeoutMs,
  heapMiB,
  responsesDir,
}: {
  readonly entry: CorpusEntry;
  readonly timeoutMs: number;
  readonly heapMiB: number;
  readonly responsesDir: string;
}): Promise<FileResult> {
  const ref = refOf(entry);
  const actual = await sha256OfFile(entry.path).catch(() => undefined);
  if (actual === undefined) return { kind: "missing", entry: ref };
  if (actual !== entry.sha256)
    return { kind: "sha_mismatch", entry: ref, actual };

  const exit = await runProbe({ entry, timeoutMs, heapMiB });
  switch (exit.kind) {
    case "timed_out":
      return { kind: "timed_out", entry: ref, ms: exit.ms };
    case "failed":
      return {
        kind: "crashed",
        entry: ref,
        exitCode: exit.exitCode,
        signal: exit.signal,
        stderrTail: exit.stderr,
      };
    case "oversized":
      return { kind: "bad_report", entry: ref, stderrTail: exit.stderr };
    case "exited": {
      const report = parseReport(exit.stdout);
      if (report === undefined) {
        return { kind: "bad_report", entry: ref, stderrTail: exit.stderr };
      }
      await writeFile(
        join(responsesDir, `${entry.sha256}.json`),
        `${JSON.stringify({
          source: entry.source,
          file: entry.file,
          calls: report.calls.map(({ tool, args, text }) => ({
            tool,
            args,
            text,
          })),
        })}\n`,
      );
      return {
        kind: "probed",
        entry: ref,
        calls: report.calls.map(({ text: _text, ...summary }) => summary),
        sheetsTotal: report.sheetsTotal,
        sheetsProbed: report.sheetsProbed,
        ms: report.ms,
        maxRssKiB: report.maxRssKiB,
      };
    }
    default: {
      const _exhaustive: never = exit;
      return _exhaustive;
    }
  }
}

function commitOf(directory: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function excelMcpVersion(): Promise<string> {
  const entry = createRequire(import.meta.url).resolve("@sezzlee/excel-mcp");
  const manifest = z
    .object({ version: z.string() })
    .parse(
      JSON.parse(
        await readFile(join(dirname(entry), "..", "package.json"), "utf8"),
      ),
    );
  return manifest.version;
}

function emptyCounts(): Record<FileResultKind, number> {
  return {
    probed: 0,
    missing: 0,
    sha_mismatch: 0,
    timed_out: 0,
    crashed: 0,
    bad_report: 0,
  };
}

function summarize({
  runDir,
  results,
  rejected,
  unsupported,
}: {
  readonly runDir: string;
  readonly results: readonly FileResult[];
  readonly rejected: readonly ManifestRejection[];
  readonly unsupported: number;
}): RunSummary {
  const counts = emptyCounts();
  const toolErrors: Record<string, number> = {};
  const probed: Extract<FileResult, { readonly kind: "probed" }>[] = [];
  for (const result of results) {
    counts[result.kind] += 1;
    if (result.kind !== "probed") continue;
    probed.push(result);
    for (const call of result.calls) {
      if (call.outcome.kind !== "error") continue;
      const key = `${call.tool}:${call.outcome.code}`;
      toolErrors[key] = (toolErrors[key] ?? 0) + 1;
    }
  }
  const label = (result: { readonly entry: EntryRef }): string =>
    `${result.entry.source}/${result.entry.file}`;
  return {
    runDir,
    files: results.length,
    counts,
    toolErrors,
    slowest: [...probed]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 10)
      .map((result) => ({ file: label(result), ms: Math.round(result.ms) })),
    largestRss: [...probed]
      .sort((a, b) => b.maxRssKiB - a.maxRssKiB)
      .slice(0, 10)
      .map((result) => ({ file: label(result), maxRssKiB: result.maxRssKiB })),
    rejected,
    unsupported,
  };
}

/**
 * Probes every supported corpus file in its own process, one at a time, and
 * writes `run.json`, `results.jsonl`, `responses/<sha256>.json` and
 * `summary.json` under a fresh run directory.
 */
export async function runCorpus(options: RunOptions): Promise<RunSummary> {
  const outRoot = await prepareOutRoot(options.outRoot);
  const scan = await readCorpus({
    root: options.corpusRoot,
    ...(options.sources === undefined ? {} : { sources: options.sources }),
  });
  const formats = options.formats;
  const selected =
    formats === undefined || formats.length === 0
      ? scan.entries
      : scan.entries.filter((entry) => formats.includes(entry.format));
  const entries =
    options.limit === undefined ? selected : selected.slice(0, options.limit);

  const runId = new Date().toISOString().replaceAll(":", "-");
  const runDir = join(outRoot, runId);
  const responsesDir = join(runDir, "responses");
  await mkdir(responsesDir, { recursive: true });
  await writeFile(
    join(runDir, "run.json"),
    `${JSON.stringify(
      {
        runId,
        node: process.version,
        excelMcp: await excelMcpVersion(),
        commit: commitOf(repositoryRoot),
        corpusRoot: options.corpusRoot,
        sources: options.sources ?? null,
        formats: options.formats ?? null,
        limit: options.limit ?? null,
        timeoutMs: options.timeoutMs,
        heapMiB: options.heapMiB,
        files: entries.length,
      },
      null,
      2,
    )}\n`,
  );

  const results: FileResult[] = [];
  const resultsPath = join(runDir, "results.jsonl");
  await writeFile(resultsPath, "");
  for (const [index, entry] of entries.entries()) {
    const result = await probeFile({
      entry,
      timeoutMs: options.timeoutMs,
      heapMiB: options.heapMiB,
      responsesDir,
    });
    results.push(result);
    await appendFile(resultsPath, `${JSON.stringify(result)}\n`);
    options.onResult?.({ index, total: entries.length, result });
  }

  const summary = summarize({
    runDir,
    results,
    rejected: scan.rejected,
    unsupported: scan.unsupported,
  });
  await writeFile(
    join(runDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}
