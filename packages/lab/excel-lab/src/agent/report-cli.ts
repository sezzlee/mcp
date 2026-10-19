import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { RunRecord } from "./agent-run.ts";
import { exercisedCases, traceableCases } from "./exercised.ts";
import { describeAnswer, describeGrade } from "./grade.ts";
import { readCatalog, type Task } from "./task.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" } },
  strict: true,
});
const [runsPath] = positionals;
if (runsPath === undefined || values.out === undefined)
  throw new Error(
    "Usage: node src/agent/report-cli.ts <runs.jsonl> --out <report.md>",
  );
const catalog = await readCatalog();
const tasks = new Map(catalog.tasks.map((task) => [task.id, task]));
const runs: RunRecord[] = (await readFile(runsPath, "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function submitted(run: RunRecord): string {
  if (run.outcome !== "answered") return `(${run.outcome})`;
  return JSON.stringify(run.submission);
}

function rate(group: readonly RunRecord[]): string {
  const correct = group.filter((run) => run.correct).length;
  return group.length === 0
    ? "-"
    : `${correct}/${group.length} (${Math.round((100 * correct) / group.length)}%)`;
}

function mean(
  group: readonly RunRecord[],
  pick: (run: RunRecord) => number,
): string {
  if (group.length === 0) return "-";
  return (
    group.reduce((sum, run) => sum + pick(run), 0) / group.length
  ).toFixed(1);
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

function breakdown(label: string, key: (run: RunRecord) => string): string {
  const keys = [...new Set(runs.map(key))].sort();
  return table(
    [
      label,
      "correct",
      "mean calls",
      "mean excess calls",
      "mean response bytes",
      "mean peak prompt tokens",
    ],
    keys.map((value) => {
      const group = runs.filter((run) => key(run) === value);
      return [
        value,
        rate(group),
        mean(group, (run) => run.calls),
        mean(group, (run) => run.excessCalls),
        mean(group, (run) => run.responseBytes),
        mean(group, (run) => run.peakInputTokens ?? 0),
      ];
    }),
  );
}

function scenarios(): string {
  const exercised = new Map(runs.map((run) => [run, exercisedCases(run)]));
  return table(
    [
      "case",
      "tagged runs",
      "exercised in tagged",
      "exercised untagged",
      "recovered",
      "correct when exercised",
    ],
    traceableCases.map((id) => {
      const tagged = runs.filter((run) =>
        tasks.get(run.task)?.cases.includes(id),
      );
      const hit = runs.filter((run) =>
        exercised.get(run)?.some((entry) => entry.id === id),
      );
      const recovered = hit.filter((run) =>
        exercised.get(run)?.some((entry) => entry.id === id && entry.recovered),
      );
      return [
        id,
        String(tagged.length),
        String(hit.filter((run) => tagged.includes(run)).length),
        String(hit.filter((run) => !tagged.includes(run)).length),
        `${recovered.length}/${hit.length}`,
        rate(hit),
      ];
    }),
  );
}

function argsOf(args: unknown): string {
  if (typeof args !== "object" || args === null) return String(args);
  const { filePath: _filePath, ...rest } = args as Record<string, unknown>;
  const text = JSON.stringify(rest);
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

function detail(run: RunRecord, task: Task | undefined): string {
  const question = task?.question[run.language] ?? run.task;
  const calls = run.callLog
    .map(
      (call, at) =>
        `${at + 1}. \`${call.tool}\` ${argsOf(call.args)}${call.error === null ? "" : ` → **${call.error}**`} (${call.bytes} B)`,
    )
    .join("\n");
  return [
    `### ${run.correct ? "✓" : "✗"} ${run.task} · ${run.language} · ${run.level} ${run.knowledge}`,
    "",
    `> ${question}`,
    "",
    `- Expected: ${task === undefined ? "?" : describeAnswer(task.answer)}`,
    `- Submitted: \`${submitted(run)}\``,
    `- Grade: ${run.grade === null ? run.outcome : describeGrade(run.grade)}`,
    `- Exercised: ${
      exercisedCases(run)
        .map(
          (entry) => `${entry.id}${entry.recovered ? "" : " (not recovered)"}`,
        )
        .join(", ") || "-"
    }`,
    `- Calls ${run.calls} (ideal ${run.idealCalls}), ${run.responseBytes} response bytes, peak prompt ${run.peakInputTokens ?? "-"} tokens, ${run.requests} requests, ${(run.ms / 1000).toFixed(0)} s`,
    "",
    calls === "" ? "_No tool calls._" : calls,
    "",
  ].join("\n");
}

const models = [...new Set(runs.map((run) => `${run.model} @ ${run.window}`))];
const ordered = [...runs].sort((left, right) =>
  left.correct === right.correct
    ? left.task.localeCompare(right.task) ||
      left.language.localeCompare(right.language)
    : left.correct
      ? 1
      : -1,
);
const report = [
  "# Agent lab report",
  "",
  `${runs.length} runs of ${new Set(runs.map((run) => run.task)).size} tasks. Model and window: ${models.join(", ")}.`,
  "",
  "## Overall",
  "",
  breakdown("language", (run) => run.language),
  "",
  "## By level",
  "",
  breakdown("level", (run) => run.level),
  "",
  "## By knowledge",
  "",
  breakdown("knowledge", (run) => run.knowledge),
  "",
  "## By outcome",
  "",
  breakdown("outcome", (run) => run.outcome),
  "",
  "## Scenarios",
  "",
  "Read from the server's answers, not from the tags: a tagged task can pass without meeting its scenario, and an untagged one can meet it.",
  "",
  scenarios(),
  "",
  "## Tasks",
  "",
  table(
    ["task", "level", "tr", "en", "calls tr/en (ideal)", "expected"],
    [...tasks.values()]
      .filter((task) => runs.some((run) => run.task === task.id))
      .map((task) => {
        const of = (language: string) =>
          runs.find((run) => run.task === task.id && run.language === language);
        const mark = (run: RunRecord | undefined) =>
          run === undefined ? "-" : run.correct ? "✓" : "✗";
        return [
          task.id,
          `${task.level} ${task.knowledge}`,
          mark(of("tr")),
          mark(of("en")),
          `${of("tr")?.calls ?? "-"}/${of("en")?.calls ?? "-"} (${task.plan.steps.length})`,
          describeAnswer(task.answer),
        ];
      }),
  ),
  "",
  "## Runs",
  "",
  "Wrong answers first.",
  "",
  ...ordered.map((run) => detail(run, tasks.get(run.task))),
].join("\n");
await writeFile(values.out, report);
process.stdout.write(
  `${JSON.stringify({ runs: runs.length, out: values.out })}\n`,
);
