import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { prepareOutRoot } from "../run.ts";
import { exercisedCases, traceableCases } from "./exercised.ts";
import { readExperiment, type CostMetric } from "./experiment.ts";
import { manifestDifferences } from "./manifest.ts";
import { pairRuns, readRunSet, type Run } from "./runs.ts";
import { clusterBootstrap, mcnemarExact } from "./stats.ts";
import { readCatalog } from "./task.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    spec: { type: "string" },
  },
  strict: true,
});
const [beforeDir, afterDir] = positionals;
if (
  beforeDir === undefined ||
  afterDir === undefined ||
  values.out === undefined
)
  throw new Error(
    "Usage: node src/agent/compare-cli.ts <before run directory> <after run directory> --out <compare.md> [--spec <experiment.json>]",
  );
const catalog = await readCatalog();
const before = await readRunSet(beforeDir, catalog);
const after = await readRunSet(afterDir, catalog);
const experiment =
  values.spec === undefined ? null : await readExperiment(values.spec);

const differences =
  before.manifest === null || after.manifest === null
    ? null
    : manifestDifferences(before.manifest, after.manifest);
const undeclared =
  differences === null || experiment === null
    ? []
    : differences.filter(
        (path) =>
          !experiment.treatment.some(
            (declared) => path === declared || path.startsWith(`${declared}.`),
          ),
      );
if (undeclared.length > 0)
  throw new Error(
    `the runs also differ in ${undeclared.join(", ")}, which ${experiment?.id ?? "the experiment"} does not declare`,
  );

const { pairs, excluded } = pairRuns(before.runs, after.runs);

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

function share(part: number, whole: number): string {
  return whole === 0
    ? "-"
    : `${part}/${whole} (${((100 * part) / whole).toFixed(1)}%)`;
}

function costOf(run: Run, metric: CostMetric): number | null {
  switch (metric) {
    case "calls":
      return run.calls;
    case "inputTokens":
      return run.inputTokens;
    case "outputTokens":
      return run.outputTokens;
    case "responseBytes":
      return run.responseBytes;
    case "seconds":
      return run.ms / 1000;
    default: {
      const exhaustive: never = metric;
      return exhaustive;
    }
  }
}

function meanOf(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 || known.length !== values.length
    ? null
    : known.reduce((sum, value) => sum + value, 0) / known.length;
}

function format(value: number | null, digits = 1): string {
  return value === null ? "unknown" : value.toFixed(digits);
}

function differenceInterval(
  pick: (run: Run) => number | null,
): { readonly low: number; readonly high: number } | null {
  const byFamily = new Map<string, number[]>();
  for (const [a, b] of pairs) {
    const left = pick(a);
    const right = pick(b);
    if (left === null || right === null) return null;
    byFamily.set(a.family, [...(byFamily.get(a.family) ?? []), right - left]);
  }
  return clusterBootstrap({
    clusters: [...byFamily.values()],
    resamples: 4000,
    seed: 20261019,
    level: 0.9,
  });
}

const onlyAfter = pairs.filter(([a, b]) => !a.correct && b.correct).length;
const onlyBefore = pairs.filter(([a, b]) => a.correct && !b.correct).length;
const accuracyDelta =
  pairs.length === 0 ? 0 : (onlyAfter - onlyBefore) / pairs.length;
const accuracyInterval = differenceInterval((run) => (run.correct ? 100 : 0));
const pValue = mcnemarExact(onlyAfter, onlyBefore);
const families = new Set(pairs.map(([a]) => a.family)).size;

const metrics: readonly (readonly [string, (run: Run) => number | null])[] = [
  ["correct (form and meaning)", (run) => (run.correct ? 1 : 0)],
  ["meaning correct", (run) => (run.grade?.semantic.correct === true ? 1 : 0)],
  ["form valid", (run) => (run.grade?.protocol.valid === true ? 1 : 0)],
  ["calls", (run) => run.calls],
  ["excess calls", (run) => run.excessCalls],
  [
    "failed calls",
    (run) => run.callLog.filter((call) => call.error !== null).length,
  ],
  ["input tokens, all requests", (run) => run.inputTokens],
  ["output tokens, all requests", (run) => run.outputTokens],
  ["peak prompt tokens", (run) => run.peakInputTokens],
  ["response bytes", (run) => run.responseBytes],
  ["seconds", (run) => run.ms / 1000],
  ["budget reached", (run) => (run.budgetReached ? 1 : 0)],
];

function decision(): readonly string[] {
  if (experiment === null) return [];
  const lines = [
    `Experiment \`${experiment.id}\`: ${experiment.hypothesis}`,
    "",
  ];
  const mechanism = experiment.mechanism;
  if (mechanism !== undefined) {
    const was = meanOf(pairs.map(([a]) => costOf(a, mechanism.metric)));
    const now = meanOf(pairs.map(([, b]) => costOf(b, mechanism.metric)));
    const change =
      was === null || now === null || was === 0 ? null : (now - was) / was;
    const met =
      change !== null &&
      (mechanism.direction === "decrease"
        ? -change >= mechanism.minRelativeChange
        : change >= mechanism.minRelativeChange);
    lines.push(
      `- Mechanism: mean ${mechanism.metric} ${format(was)} → ${format(now)} (${change === null ? "unknown" : `${(100 * change).toFixed(1)}%`}); expected a ${mechanism.direction} of at least ${(100 * mechanism.minRelativeChange).toFixed(0)}%: **${met ? "met" : "not met"}**.`,
    );
  }
  if (experiment.rule.kind === "superiority")
    lines.push(
      `- Better: accuracy ${(100 * accuracyDelta).toFixed(1)} points, exact McNemar p = ${pValue.toFixed(4)}: **${accuracyDelta > 0 && pValue < 0.05 ? "shown" : "not shown"}**.`,
    );
  else {
    const lower = accuracyInterval?.low ?? null;
    const cost = experiment.rule.cost;
    const costInterval = differenceInterval((run) => costOf(run, cost));
    lines.push(
      `- Not worse: the one-sided 95% lower bound of the accuracy change is ${format(lower)} points against a margin of −${experiment.rule.marginPoints}: **${lower !== null && lower > -experiment.rule.marginPoints ? "shown" : "not shown"}**.`,
      `- Cheaper (${cost}): the 90% interval of the change is ${costInterval === null ? "unknown" : `${format(costInterval.low, 2)} to ${format(costInterval.high, 2)}`}: **${costInterval !== null && costInterval.high < 0 ? "shown" : "not shown"}**.`,
    );
  }
  return [...lines, ""];
}

function scenarios(): string {
  const of = (side: 0 | 1, id: string): string => {
    const episodes = pairs.flatMap((pair) =>
      exercisedCases(pair[side]).filter((entry) => entry.id === id),
    );
    return episodes.length === 0
      ? "0"
      : `${episodes.length} (${episodes.filter((entry) => entry.recovered).length} recovered)`;
  };
  return table(
    ["case", "before", "after"],
    traceableCases.map((id) => [id, of(0, id), of(1, id)]),
  );
}

function toolUse(): string {
  const tools = [
    ...new Set(
      pairs.flatMap(([a, b]) =>
        [...a.callLog, ...b.callLog].map((call) => call.tool),
      ),
    ),
  ].sort();
  const of = (side: 0 | 1, tool: string): string => {
    const calls = pairs.flatMap((pair) =>
      pair[side].callLog.filter((call) => call.tool === tool),
    );
    const failed = calls.filter((call) => call.error !== null).length;
    return failed === 0
      ? String(calls.length)
      : `${calls.length} (${failed} failed)`;
  };
  return table(
    ["tool", "before", "after"],
    tools.map((tool) => [tool, of(0, tool), of(1, tool)]),
  );
}

const flipped = pairs.filter(([a, b]) => a.correct !== b.correct);
const report = [
  "# Agent lab comparison",
  "",
  `Before: \`${basename(beforeDir)}\`. After: \`${basename(afterDir)}\`. Both are graded against the current catalog.`,
  "",
  differences === null
    ? "One side has no manifest, so the conditions are not known to match; pairs rely on the question text."
    : differences.length === 0
      ? "The manifests are identical: this comparison measures run-to-run variation."
      : `The manifests differ in: ${differences.map((path) => `\`${path}\``).join(", ")}.`,
  "",
  "## Decision",
  "",
  ...decision(),
  `${pairs.length} pairs over ${families} file families; ${excluded.length} runs excluded.`,
  "",
  table(
    ["", "value"],
    [
      [
        "accuracy before",
        share(pairs.filter(([a]) => a.correct).length, pairs.length),
      ],
      [
        "accuracy after",
        share(pairs.filter(([, b]) => b.correct).length, pairs.length),
      ],
      ["only after correct (b)", String(onlyAfter)],
      ["only before correct (c)", String(onlyBefore)],
      ["change", `${(100 * accuracyDelta).toFixed(1)} points`],
      [
        "90% family-bootstrap interval",
        accuracyInterval === null
          ? "too few families"
          : `${accuracyInterval.low.toFixed(1)} to ${accuracyInterval.high.toFixed(1)} points`,
      ],
      ["exact McNemar p", pValue.toFixed(4)],
    ],
  ),
  "",
  "## Metrics on the same pairs",
  "",
  table(
    ["metric", "before", "after"],
    metrics.map(([label, pick]) => [
      label,
      format(meanOf(pairs.map(([a]) => pick(a))), 2),
      format(meanOf(pairs.map(([, b]) => pick(b))), 2),
    ]),
  ),
  "",
  "## Tool calls",
  "",
  toolUse(),
  "",
  "## Scenarios met",
  "",
  scenarios(),
  "",
  "## Changed answers",
  "",
  table(
    ["run", "before", "after", "before answer", "after answer"],
    flipped.map(([a, b]) => [
      `${a.task} ${a.language} r${a.repetition}`,
      `${a.correct ? "✓" : "✗"} ${a.calls} calls`,
      `${b.correct ? "✓" : "✗"} ${b.calls} calls`,
      JSON.stringify(a.submission).slice(0, 160),
      JSON.stringify(b.submission).slice(0, 160),
    ]),
  ),
  "",
  "## Excluded",
  "",
  table(
    ["run", "reason"],
    excluded.map((entry) => [entry.key, entry.reason]),
  ),
  "",
].join("\n");
const out = join(
  await prepareOutRoot(dirname(values.out)),
  basename(values.out),
);
await writeFile(out, report);
process.stdout.write(
  `${JSON.stringify({ pairs: pairs.length, excluded: excluded.length, onlyAfter, onlyBefore, p: pValue, out })}\n`,
);
