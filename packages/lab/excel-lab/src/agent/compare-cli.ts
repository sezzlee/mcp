import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { RunRecord } from "./agent-run.ts";
import { exercisedCases, traceableCases } from "./exercised.ts";
import { gradeSubmission } from "./grade.ts";
import { readCatalog } from "./task.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" } },
  strict: true,
});
const [beforePath, afterPath] = positionals;
if (
  beforePath === undefined ||
  afterPath === undefined ||
  values.out === undefined
)
  throw new Error(
    "Usage: node src/agent/compare-cli.ts <before runs.jsonl> <after runs.jsonl> --out <compare.md>",
  );
const catalog = await readCatalog();
const tasks = new Map(catalog.tasks.map((task) => [task.id, task]));

interface Run extends RunRecord {
  readonly sameQuestion: boolean;
}

/**
 * Guard: both sides are graded here against the current catalog, so a
 * corrected answer or grader moves both runs alike and the difference left
 * is the run's own.
 */
async function load(path: string): Promise<readonly Run[]> {
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  return lines.map((line) => {
    const run: RunRecord = JSON.parse(line);
    const task = tasks.get(run.task);
    const asked = run.trace[1];
    const sameQuestion =
      task !== undefined &&
      asked?.role === "user" &&
      asked.content.startsWith(task.question[run.language]);
    const graded =
      task === undefined ? null : gradeSubmission(task.answer, run.submission);
    return graded === null
      ? { ...run, sameQuestion }
      : { ...run, correct: graded.correct, grade: graded, sameQuestion };
  });
}

const before = await load(beforePath);
const after = await load(afterPath);
const keyOf = (run: Run): string => `${run.task} ${run.language}`;
const beforeByKey = new Map(before.map((run) => [keyOf(run), run]));
const afterByKey = new Map(after.map((run) => [keyOf(run), run]));
const paired = after.filter((run) => {
  const earlier = beforeByKey.get(keyOf(run));
  return earlier !== undefined && earlier.sameQuestion && run.sameQuestion;
});
const pairedKeys = new Set(paired.map(keyOf));
const pairedBefore = before.filter((run) => pairedKeys.has(keyOf(run)));

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function rate(group: readonly Run[]): string {
  const correct = group.filter((run) => run.correct).length;
  return group.length === 0
    ? "-"
    : `${correct}/${group.length} (${Math.round((100 * correct) / group.length)}%)`;
}

function mean(group: readonly Run[], pick: (run: Run) => number): string {
  if (group.length === 0) return "-";
  return (
    group.reduce((sum, run) => sum + pick(run), 0) / group.length
  ).toFixed(1);
}

function count(group: readonly Run[], pick: (run: Run) => number): string {
  return String(group.reduce((sum, run) => sum + pick(run), 0));
}

function overall(): string {
  const metrics: readonly (readonly [
    string,
    (group: readonly Run[]) => string,
  ])[] = [
    ["correct, all runs", rate],
    ["mean calls", (group) => mean(group, (run) => run.calls)],
    ["mean excess calls", (group) => mean(group, (run) => run.excessCalls)],
    [
      "failed calls",
      (group) =>
        count(
          group,
          (run) => run.callLog.filter((call) => call.error !== null).length,
        ),
    ],
    [
      "no answer",
      (group) =>
        String(group.filter((run) => run.outcome !== "answered").length),
    ],
    ["mean response bytes", (group) => mean(group, (run) => run.responseBytes)],
    [
      "mean peak prompt tokens",
      (group) => mean(group, (run) => run.peakInputTokens ?? 0),
    ],
    ["mean seconds", (group) => mean(group, (run) => run.ms / 1000)],
  ];
  return table(
    ["metric", "before", "after"],
    [
      ["runs", String(before.length), String(after.length)],
      [
        "correct, same question on both sides",
        rate(pairedBefore),
        rate(paired),
      ],
      ...metrics.map(([label, of]) => [label, of(before), of(after)]),
    ],
  );
}

function byLevel(): string {
  const levels = [...new Set(paired.map((run) => run.level))].sort();
  return table(
    ["level", "before", "after"],
    levels.map((level) => [
      level,
      rate(pairedBefore.filter((run) => run.level === level)),
      rate(paired.filter((run) => run.level === level)),
    ]),
  );
}

function toolUse(): string {
  const tools = [
    ...new Set(
      [...before, ...after].flatMap((run) =>
        run.callLog.map((call) => call.tool),
      ),
    ),
  ].sort();
  const of = (group: readonly Run[], tool: string): string => {
    const calls = group.flatMap((run) =>
      run.callLog.filter((call) => call.tool === tool),
    );
    const failed = calls.filter((call) => call.error !== null).length;
    return failed === 0
      ? String(calls.length)
      : `${calls.length} (${failed} failed)`;
  };
  return table(
    ["tool", "before", "after"],
    tools.map((tool) => [tool, of(before, tool), of(after, tool)]),
  );
}

function scenarios(): string {
  const of = (group: readonly Run[], id: string): string => {
    const hits = group.flatMap((run) =>
      exercisedCases(run).filter((entry) => entry.id === id),
    );
    return hits.length === 0
      ? "0"
      : `${hits.length} (${hits.filter((entry) => entry.recovered).length} recovered)`;
  };
  return table(
    ["case", "before", "after"],
    traceableCases.map((id) => [id, of(before, id), of(after, id)]),
  );
}

function mark(run: Run | undefined): string {
  if (run === undefined) return "-";
  return `${run.correct ? "✓" : "✗"} ${run.calls} calls`;
}

function submitted(run: Run | undefined): string {
  if (run === undefined) return "-";
  if (run.outcome !== "answered") return `(${run.outcome})`;
  const text = JSON.stringify(run.submission);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function changes(): string {
  const keys = [...new Set([...before, ...after].map(keyOf))].sort();
  const rows = keys.flatMap((key) => {
    const earlier = beforeByKey.get(key);
    const later = afterByKey.get(key);
    const note =
      earlier === undefined
        ? "new task"
        : later === undefined
          ? "not rerun"
          : !earlier.sameQuestion || !later.sameQuestion
            ? "question changed"
            : earlier.correct === later.correct
              ? null
              : later.correct
                ? "fixed"
                : "broke";
    return note === null
      ? []
      : [
          [
            key,
            note,
            mark(earlier),
            mark(later),
            submitted(earlier),
            submitted(later),
          ],
        ];
  });
  return table(
    ["task", "change", "before", "after", "before answer", "after answer"],
    rows,
  );
}

const report = [
  "# Agent lab comparison",
  "",
  `Before: \`${beforePath}\`. After: \`${afterPath}\`. Both are graded against the current catalog.`,
  "",
  "## Overall",
  "",
  overall(),
  "",
  "## By level, same question on both sides",
  "",
  byLevel(),
  "",
  "## Tool calls",
  "",
  toolUse(),
  "",
  "## Scenarios exercised",
  "",
  scenarios(),
  "",
  "## Changed runs",
  "",
  changes(),
  "",
].join("\n");
await writeFile(values.out, report);
process.stdout.write(
  `${JSON.stringify({ before: before.length, after: after.length, paired: paired.length, out: values.out })}\n`,
);
