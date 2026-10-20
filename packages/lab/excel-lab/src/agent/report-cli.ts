import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { prepareOutRoot } from "../run.ts";
import { exercisedCases, traceableCases } from "./exercised.ts";
import { describeAnswer, describeGrade } from "./grade.ts";
import { readRunSet, type Run } from "./runs.ts";
import { readCatalog } from "./task.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" } },
  strict: true,
});
const [directory] = positionals;
if (directory === undefined || values.out === undefined)
  throw new Error(
    "Usage: node src/agent/report-cli.ts <run directory> --out <report.md>",
  );
const catalog = await readCatalog();
const set = await readRunSet(directory, catalog);
const runs = set.runs;
const eligible = runs.filter((run) => run.eligibility.eligible);

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

function rate(group: readonly Run[], pass: (run: Run) => boolean): string {
  const count = group.filter(pass).length;
  return group.length === 0
    ? "-"
    : `${count}/${group.length} (${Math.round((100 * count) / group.length)}%)`;
}

function mean(
  group: readonly Run[],
  pick: (run: Run) => number | null,
): string {
  const values = group.map(pick);
  if (group.length === 0) return "-";
  if (values.some((value) => value === null)) return "unknown";
  return (
    values.reduce((sum: number, value) => sum + (value ?? 0), 0) / group.length
  ).toFixed(1);
}

function breakdown(label: string, key: (run: Run) => string): string {
  const keys = [...new Set(eligible.map(key))].sort();
  return table(
    [
      label,
      "correct",
      "meaning correct",
      "form valid",
      "mean calls",
      "mean excess calls",
      "mean input tokens, all requests",
      "mean seconds",
    ],
    keys.map((value) => {
      const group = eligible.filter((run) => key(run) === value);
      return [
        value,
        rate(group, (run) => run.correct),
        rate(group, (run) => run.grade?.semantic.correct === true),
        rate(group, (run) => run.grade?.protocol.valid === true),
        mean(group, (run) => run.calls),
        mean(group, (run) => run.excessCalls),
        mean(group, (run) => run.inputTokens),
        mean(group, (run) => run.ms / 1000),
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
      "met in tagged",
      "met untagged",
      "episodes recovered",
      "correct when met",
    ],
    traceableCases.map((id) => {
      const tagged = runs.filter((run) => run.definition?.cases.includes(id));
      const met = runs.filter((run) =>
        exercised.get(run)?.some((entry) => entry.id === id),
      );
      const episodes = met.flatMap(
        (run) => exercised.get(run)?.filter((entry) => entry.id === id) ?? [],
      );
      return [
        id,
        String(tagged.length),
        String(met.filter((run) => tagged.includes(run)).length),
        String(met.filter((run) => !tagged.includes(run)).length),
        `${episodes.filter((entry) => entry.recovered).length}/${episodes.length}`,
        rate(met, (run) => run.correct),
      ];
    }),
  );
}

function repeatAgreement(): readonly string[] {
  const groups = new Map<string, Run[]>();
  for (const run of eligible) {
    const key = `${run.task} ${run.language}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const repeated = [...groups.values()].filter((group) => group.length > 1);
  if (repeated.length === 0) return [];
  const same = (group: readonly Run[], pick: (run: Run) => string): boolean =>
    new Set(group.map(pick)).size === 1;
  const calls = (run: Run): string =>
    JSON.stringify(run.callLog.map((call) => [call.tool, call.args]));
  const submitted = (run: Run): string =>
    JSON.stringify(
      typeof run.submission === "object" && run.submission !== null
        ? Object.fromEntries(
            Object.entries(run.submission).filter(
              ([key]) => key !== "explanation",
            ),
          )
        : run.submission,
    );
  const graded = (run: Run): string => String(run.correct);
  const count = (pick: (run: Run) => string): string =>
    `${repeated.filter((group) => same(group, pick)).length}/${repeated.length}`;
  return [
    "## Repeat agreement",
    "",
    "Task and language groups with more than one repetition, and how many agree across all of them.",
    "",
    table(
      ["same calls", "same submitted value", "same grade"],
      [[count(calls), count(submitted), count(graded)]],
    ),
    "",
  ];
}

function argsOf(args: unknown): string {
  if (typeof args !== "object" || args === null) return String(args);
  const rest = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== "filePath"),
  );
  const text = JSON.stringify(rest);
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

function detail(run: Run): string {
  const question = run.definition?.question[run.language] ?? run.task;
  const calls = run.callLog
    .map(
      (call, at) =>
        `${at + 1}. \`${call.tool}\` ${argsOf(call.args)}${call.error === null ? "" : ` → **${call.error}**`} (${call.bytes} B)`,
    )
    .join("\n");
  const exercised = exercisedCases(run)
    .map((entry) => `${entry.id}${entry.recovered ? "" : " (not recovered)"}`)
    .join(", ");
  return [
    `### ${run.correct ? "✓" : "✗"} ${run.task} · ${run.language} · r${run.repetition}`,
    "",
    `> ${question}`,
    "",
    `- Expected: ${run.definition === undefined ? "?" : describeAnswer(run.definition.answer)}`,
    `- Submitted: \`${run.outcome === "answered" ? JSON.stringify(run.submission) : `(${run.outcome})`}\``,
    `- Grade: ${run.grade === null ? run.outcome : describeGrade(run.grade)}${run.eligibility.eligible ? "" : ` · not counted: ${run.eligibility.reason}`}`,
    `- Exercised: ${exercised === "" ? "-" : exercised}`,
    `- Calls ${run.calls} (plan ${run.idealCalls}), ${run.responseBytes} response bytes, peak prompt ${run.peakInputTokens ?? "-"} tokens, ${(run.ms / 1000).toFixed(0)} s`,
    "",
    calls === "" ? "_No tool calls._" : calls,
    "",
  ].join("\n");
}

const ordered = [...runs].sort((left, right) =>
  left.correct === right.correct
    ? left.task.localeCompare(right.task) ||
      left.language.localeCompare(right.language) ||
      left.repetition - right.repetition
    : left.correct
      ? 1
      : -1,
);
const excluded = runs.length - eligible.length;
const report = [
  "# Agent lab report",
  "",
  `${runs.length} runs of ${new Set(runs.map((run) => run.task)).size} tasks; ${eligible.length} count toward accuracy${excluded > 0 ? `, ${excluded} do not (host failures, refused preflights, another loaded window)` : ""}.`,
  set.manifest === null
    ? "No readable manifest: this directory predates the current experiment record, so its condition is not known."
    : `Model ${set.manifest.host.model} (${set.manifest.host.digest?.slice(0, 12) ?? "digest unknown"}), Ollama ${set.manifest.host.version ?? "unknown"}, window ${set.manifest.generation.window}, thinking ${set.manifest.generation.thinking}, server ${set.manifest.server.version}.`,
  "",
  "A run is correct when its value means the answer and comes in the form the tool asks for; the two columns after it count each alone.",
  "",
  "## Overall",
  "",
  breakdown("language", (run) => run.language),
  "",
  "## By level",
  "",
  breakdown("level", (run) => run.definition?.level ?? "?"),
  "",
  "## By knowledge",
  "",
  breakdown("knowledge", (run) => run.definition?.knowledge ?? "?"),
  "",
  "## By outcome",
  "",
  breakdown("outcome", (run) => run.outcome),
  "",
  ...repeatAgreement(),
  "## Scenarios",
  "",
  "Read from the server's answers, one episode per file, not from the tags: a tagged task can pass without meeting its scenario, and an untagged one can meet it.",
  "",
  scenarios(),
  "",
  "## Tasks",
  "",
  table(
    ["task", "level", "tr", "en", "calls tr/en (plan)", "expected"],
    catalog.tasks
      .filter((task) => runs.some((run) => run.task === task.id))
      .map((task) => {
        const of = (language: string) =>
          runs.filter(
            (run) => run.task === task.id && run.language === language,
          );
        const mark = (group: readonly Run[]) =>
          group.length === 0
            ? "-"
            : group.map((run) => (run.correct ? "✓" : "✗")).join("");
        const callsOf = (group: readonly Run[]) =>
          group.length === 0 ? "-" : group.map((run) => run.calls).join(",");
        return [
          task.id,
          `${task.level} ${task.knowledge}`,
          mark(of("tr")),
          mark(of("en")),
          `${callsOf(of("tr"))}/${callsOf(of("en"))} (${task.plan.steps.length})`,
          describeAnswer(task.answer),
        ];
      }),
  ),
  "",
  "## Runs",
  "",
  "Wrong answers first.",
  "",
  ...ordered.map(detail),
].join("\n");
const out = join(
  await prepareOutRoot(dirname(values.out)),
  basename(values.out),
);
await writeFile(out, report);
process.stdout.write(`${JSON.stringify({ runs: runs.length, out })}\n`);
