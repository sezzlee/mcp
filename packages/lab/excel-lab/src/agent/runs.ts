import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { eligibilityOf, type Eligibility } from "./eligibility.ts";
import { gradeSubmission, type Grade } from "./grade.ts";
import type { ChatMessage } from "./host.ts";
import { manifestSchema, type Manifest } from "./manifest.ts";
import { languages, type Catalog, type Task } from "./task.ts";

const messageSchema: z.ZodType<ChatMessage> = z.union([
  z.object({ role: z.enum(["system", "user"]), content: z.string() }),
  z.object({
    role: z.literal("assistant"),
    content: z.string(),
    thinking: z.string().optional(),
    tool_calls: z
      .array(
        z.object({
          function: z.object({
            name: z.string(),
            arguments: z.record(z.string(), z.unknown()),
          }),
        }),
      )
      .optional(),
  }),
  z.object({
    role: z.literal("tool"),
    content: z.string(),
    tool_name: z.string(),
  }),
]);

/**
 * A saved run as reports read it. Runs saved before the experiment record
 * existed lack a trial id, a task revision and a repetition; they read as
 * repetition 0 of an unknown revision. Runs saved before attempts and hosts
 * were recorded read as a first attempt on an unknown endpoint.
 */
const storedRunSchema = z.looseObject({
  trialId: z.string().nullable().default(null),
  attempt: z.int().positive().default(1),
  endpoint: z.string().nullable().default(null),
  taskRevision: z.string().nullable().default(null),
  repetition: z.int().nonnegative().default(0),
  task: z.string(),
  language: z.enum(languages),
  outcome: z.string(),
  window: z.int(),
  loadedWindow: z.int().nullable(),
  submission: z.unknown(),
  budgetReached: z.boolean().default(false),
  calls: z.int(),
  idealCalls: z.int(),
  excessCalls: z.int(),
  responseBytes: z.int(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable().default(null),
  peakInputTokens: z.number().nullable(),
  failedRequests: z.int().default(0),
  ms: z.number(),
  trace: z.array(messageSchema),
  callLog: z.array(
    z.looseObject({
      tool: z.string(),
      args: z.unknown(),
      error: z.string().nullable(),
      bytes: z.int(),
      ms: z.number().default(0),
    }),
  ),
});
type StoredRun = z.infer<typeof storedRunSchema>;

export interface Run extends StoredRun {
  readonly correct: boolean;
  readonly grade: Grade | null;
  readonly eligibility: Eligibility;
  readonly family: string;
  readonly sameQuestion: boolean;
  readonly definition: Task | undefined;
}

export interface RunSet {
  readonly directory: string;
  readonly manifest: Manifest | null;
  readonly runs: readonly Run[];
}

/**
 * Reads a run directory and grades every run again under the current
 * catalog and grader, so two directories are judged by one rule.
 */
export async function readRunSet(
  directory: string,
  catalog: Catalog,
): Promise<RunSet> {
  const tasks = new Map(catalog.tasks.map((task) => [task.id, task]));
  const manifestText = await readFile(
    join(directory, "manifest.json"),
    "utf8",
  ).catch(() => null);
  const lines = (await readFile(join(directory, "runs.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "");
  const runs = lines.map((line): Run => {
    const stored = storedRunSchema.parse(JSON.parse(line));
    const definition = tasks.get(stored.task);
    const grade =
      definition === undefined
        ? null
        : gradeSubmission(definition.answer, stored.submission);
    const asked = stored.trace[1];
    return {
      ...stored,
      correct: grade?.correct ?? false,
      grade,
      eligibility: eligibilityOf(stored),
      family: definition?.files[0] ?? stored.task,
      sameQuestion:
        definition !== undefined &&
        asked?.role === "user" &&
        asked.content.startsWith(definition.question[stored.language]),
      definition,
    };
  });
  return {
    directory,
    manifest:
      manifestText === null
        ? null
        : (manifestSchema.safeParse(JSON.parse(manifestText)).data ?? null),
    runs,
  };
}

export interface Pairing {
  readonly pairs: readonly (readonly [Run, Run])[];
  readonly excluded: readonly {
    readonly key: string;
    readonly reason: string;
  }[];
}

function keyOf(run: Run): string {
  return `${run.task} ${run.language} r${run.repetition}`;
}

/**
 * Pairs two run sets one to one by task, language and repetition. A
 * duplicate key is an error rather than a silent overwrite; a run whose task
 * changed, whose question differs from the catalog's, or that either side
 * cannot count is listed as excluded with the reason.
 */
export function pairRuns(
  before: readonly Run[],
  after: readonly Run[],
): Pairing {
  const index = (runs: readonly Run[], side: string): Map<string, Run> => {
    const byKey = new Map<string, Run>();
    for (const run of runs) {
      if (byKey.has(keyOf(run)))
        throw new Error(`${side} holds ${keyOf(run)} twice`);
      byKey.set(keyOf(run), run);
    }
    return byKey;
  };
  const left = index(before, "before");
  const right = index(after, "after");
  const pairs: (readonly [Run, Run])[] = [];
  const excluded: { key: string; reason: string }[] = [];
  for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const a = left.get(key);
    const b = right.get(key);
    const reason =
      a === undefined
        ? "only after"
        : b === undefined
          ? "only before"
          : a.taskRevision !== null &&
              b.taskRevision !== null &&
              a.taskRevision !== b.taskRevision
            ? "task changed"
            : !a.sameQuestion || !b.sameQuestion
              ? "question changed"
              : !a.eligibility.eligible
                ? `before ${a.eligibility.reason}`
                : !b.eligibility.eligible
                  ? `after ${b.eligibility.reason}`
                  : null;
    if (reason !== null || a === undefined || b === undefined)
      excluded.push({ key, reason: reason ?? "unpaired" });
    else pairs.push([a, b]);
  }
  return { pairs, excluded };
}
