import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { sha256Schema } from "./record.ts";

const callLine = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  digest: sha256Schema,
  outcome: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ok") }),
    z.object({ kind: z.literal("error"), code: z.string() }),
  ]),
});

const resultLine = z.object({
  kind: z.string(),
  entry: z.object({
    source: z.string(),
    file: z.string(),
    sha256: sha256Schema,
  }),
  calls: z.array(callLine).optional(),
  ms: z.number().optional(),
  maxRssKiB: z.number().optional(),
});
type ResultLine = z.infer<typeof resultLine>;

const responsesFile = z.object({
  calls: z.array(z.object({ tool: z.string(), text: z.string() })),
});

export interface FieldDifference {
  readonly path: string;
  readonly baseline: unknown;
  readonly candidate: unknown;
}

export type FileComparison =
  | { readonly kind: "same"; readonly file: string }
  | {
      readonly kind: "outcome";
      readonly file: string;
      readonly baseline: string;
      readonly candidate: string;
    }
  | {
      readonly kind: "responses";
      readonly file: string;
      readonly calls: readonly {
        readonly tool: string;
        readonly args: Readonly<Record<string, unknown>>;
        readonly differences: readonly FieldDifference[];
      }[];
    };

export interface RunComparison {
  readonly files: number;
  readonly same: number;
  readonly outcomeChanges: number;
  readonly responseChanges: number;
  readonly changedCallsByTool: Readonly<Record<string, number>>;
  readonly totalMs: { readonly baseline: number; readonly candidate: number };
  readonly largestRss: readonly {
    readonly file: string;
    readonly baselineMiB: number;
    readonly candidateMiB: number;
  }[];
  readonly comparisons: readonly FileComparison[];
}

async function readResults(runDir: string): Promise<Map<string, ResultLine>> {
  const text = await readFile(join(runDir, "results.jsonl"), "utf8");
  const results = new Map<string, ResultLine>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = resultLine.parse(JSON.parse(line));
    results.set(parsed.entry.sha256, parsed);
  }
  return results;
}

async function readTexts(
  runDir: string,
  sha256: string,
): Promise<readonly string[]> {
  const raw = await readFile(
    join(runDir, "responses", `${sha256}.json`),
    "utf8",
  );
  return responsesFile.parse(JSON.parse(raw)).calls.map((call) => call.text);
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lists the JSON paths where two answers differ, depth first, at most `limit`.
 */
export function differencesOf(
  baseline: unknown,
  candidate: unknown,
  limit = 8,
  path = "$",
): FieldDifference[] {
  if (isDeepStrictEqual(baseline, candidate)) return [];
  if (Array.isArray(baseline) && Array.isArray(candidate)) {
    const found: FieldDifference[] = [];
    const length = Math.max(baseline.length, candidate.length);
    for (let index = 0; index < length && found.length < limit; index += 1) {
      found.push(
        ...differencesOf(
          baseline.at(index),
          candidate.at(index),
          limit - found.length,
          `${path}[${index}]`,
        ),
      );
    }
    return found;
  }
  if (isRecord(baseline) && isRecord(candidate)) {
    const found: FieldDifference[] = [];
    const keys = [
      ...new Set([...Object.keys(baseline), ...Object.keys(candidate)]),
    ];
    for (const key of keys) {
      if (found.length >= limit) break;
      found.push(
        ...differencesOf(
          baseline[key],
          candidate[key],
          limit - found.length,
          `${path}.${key}`,
        ),
      );
    }
    return found;
  }
  return [{ path, baseline, candidate }];
}

function outcomeLabel(result: ResultLine): string {
  if (result.kind !== "probed") return result.kind;
  return (result.calls ?? [])
    .map(
      (call) =>
        `${call.tool}:${call.outcome.kind === "ok" ? "ok" : call.outcome.code}`,
    )
    .join(",");
}

/**
 * Compares two excel-lab runs file by file, matched by content digest: the
 * outcome of every tool call, and for calls whose answer changed, the JSON
 * paths that differ. Timing and peak memory are set side by side.
 */
export async function compareRuns({
  baselineDir,
  candidateDir,
}: {
  readonly baselineDir: string;
  readonly candidateDir: string;
}): Promise<RunComparison> {
  const baseline = await readResults(baselineDir);
  const candidate = await readResults(candidateDir);
  const comparisons: FileComparison[] = [];
  const changedCallsByTool: Record<string, number> = {};
  const totalMs = { baseline: 0, candidate: 0 };
  const rss: { file: string; baselineMiB: number; candidateMiB: number }[] = [];
  for (const [sha256, before] of baseline) {
    const after = candidate.get(sha256);
    if (after === undefined) continue;
    const file = `${before.entry.source}/${before.entry.file}`;
    totalMs.baseline += before.ms ?? 0;
    totalMs.candidate += after.ms ?? 0;
    if (before.maxRssKiB !== undefined && after.maxRssKiB !== undefined) {
      rss.push({
        file,
        baselineMiB: Math.round(before.maxRssKiB / 1024),
        candidateMiB: Math.round(after.maxRssKiB / 1024),
      });
    }
    const beforeLabel = outcomeLabel(before);
    const afterLabel = outcomeLabel(after);
    if (beforeLabel !== afterLabel) {
      comparisons.push({
        kind: "outcome",
        file,
        baseline: beforeLabel,
        candidate: afterLabel,
      });
      continue;
    }
    const beforeCalls = before.calls ?? [];
    const afterCalls = after.calls ?? [];
    const changed = beforeCalls
      .map((call, index) => ({ call, index }))
      .filter(
        ({ call, index }) => call.digest !== afterCalls.at(index)?.digest,
      );
    if (changed.length === 0) {
      comparisons.push({ kind: "same", file });
      continue;
    }
    const beforeTexts = await readTexts(baselineDir, sha256);
    const afterTexts = await readTexts(candidateDir, sha256);
    comparisons.push({
      kind: "responses",
      file,
      calls: changed.map(({ call, index }) => {
        changedCallsByTool[call.tool] =
          (changedCallsByTool[call.tool] ?? 0) + 1;
        return {
          tool: call.tool,
          args: call.args,
          differences: differencesOf(
            parsed(beforeTexts.at(index) ?? ""),
            parsed(afterTexts.at(index) ?? ""),
          ),
        };
      }),
    });
  }
  return {
    files: comparisons.length,
    same: comparisons.filter((entry) => entry.kind === "same").length,
    outcomeChanges: comparisons.filter((entry) => entry.kind === "outcome")
      .length,
    responseChanges: comparisons.filter((entry) => entry.kind === "responses")
      .length,
    changedCallsByTool,
    totalMs: {
      baseline: Math.round(totalMs.baseline),
      candidate: Math.round(totalMs.candidate),
    },
    largestRss: rss.sort((a, b) => b.baselineMiB - a.baselineMiB).slice(0, 10),
    comparisons,
  };
}
