import { mcnemarExact } from "../agent/stats.ts";

export interface NightTrial {
  readonly model: string;
  readonly id: string;
  readonly language: string;
  readonly repetition: number;
  readonly passed: boolean;
  readonly failure: string | null;
  readonly dispatched: number;
  readonly refusedCatalog: number;
  readonly refusedBudget: number;
  readonly tools: readonly {
    readonly tool: string;
    readonly error: string | null;
  }[];
  readonly writes: readonly {
    readonly tool: string;
    readonly sourced: boolean;
  }[];
}

export interface Rate {
  readonly passed: number;
  readonly total: number;
}

export interface Morning {
  readonly models: readonly {
    readonly model: string;
    readonly overall: Rate;
    readonly suites: Readonly<Record<string, Rate>>;
    readonly languages: Readonly<Record<string, Rate>>;
    readonly meanDispatched: number;
    readonly refusedCatalog: number;
    readonly refusedBudget: number;
    readonly writes: { readonly sourced: number; readonly literal: number };
  }[];
  readonly tools: Readonly<
    Record<
      string,
      {
        readonly calls: number;
        readonly errors: Readonly<Record<string, number>>;
      }
    >
  >;
  readonly failures: readonly {
    readonly failure: string;
    readonly count: number;
    readonly ids: readonly string[];
  }[];
  readonly scenarios: readonly {
    readonly id: string;
    readonly rates: Readonly<Record<string, Rate>>;
  }[];
}

export interface Comparison {
  readonly paired: number;
  readonly fixed: number;
  readonly broke: number;
  readonly pValue: number;
  readonly changes: readonly {
    readonly key: string;
    readonly change: "fixed" | "broke";
  }[];
}

function add(rates: Record<string, Rate>, key: string, passed: boolean): void {
  const rate = rates[key] ?? { passed: 0, total: 0 };
  rates[key] = {
    passed: rate.passed + Number(passed),
    total: rate.total + 1,
  };
}

/**
 * Guard: a resumed night appends a second record for every trial whose first
 * one ended on a host failure, so counting every record puts the superseded
 * failure in the denominator; only the last record of each trial counts.
 */
function latest(trials: readonly NightTrial[]): NightTrial[] {
  const byKey = new Map<string, NightTrial>();
  for (const trial of trials) byKey.set(keyOf(trial), trial);
  return [...byKey.values()];
}

/** Summarizes one night's model trials. */
export function summarize(recorded: readonly NightTrial[]): Morning {
  const trials = latest(recorded);
  const models = [...new Set(trials.map((trial) => trial.model))].map(
    (model) => {
      const own = trials.filter((trial) => trial.model === model);
      const suites: Record<string, Rate> = {};
      const languages: Record<string, Rate> = {};
      for (const trial of own) {
        add(suites, trial.id.split("/")[0] ?? trial.id, trial.passed);
        add(languages, trial.language, trial.passed);
      }
      const writes = own.flatMap((trial) => trial.writes);
      return {
        model,
        overall: {
          passed: own.filter((trial) => trial.passed).length,
          total: own.length,
        },
        suites,
        languages,
        meanDispatched:
          own.length === 0
            ? 0
            : own.reduce((sum, trial) => sum + trial.dispatched, 0) /
              own.length,
        refusedCatalog: own.reduce(
          (sum, trial) => sum + trial.refusedCatalog,
          0,
        ),
        refusedBudget: own.reduce((sum, trial) => sum + trial.refusedBudget, 0),
        writes: {
          sourced: writes.filter((write) => write.sourced).length,
          literal: writes.filter((write) => !write.sourced).length,
        },
      };
    },
  );
  const tools: Record<
    string,
    { calls: number; errors: Record<string, number> }
  > = {};
  for (const call of trials.flatMap((trial) => trial.tools)) {
    const entry = tools[call.tool] ?? { calls: 0, errors: {} };
    entry.calls += 1;
    if (call.error !== null)
      entry.errors[call.error] = (entry.errors[call.error] ?? 0) + 1;
    tools[call.tool] = entry;
  }
  const failures = new Map<string, { count: number; ids: Set<string> }>();
  for (const trial of trials) {
    if (trial.failure === null) continue;
    const key = trial.failure.split("\n")[0]?.slice(0, 120) ?? "";
    const entry = failures.get(key) ?? { count: 0, ids: new Set<string>() };
    entry.count += 1;
    entry.ids.add(trial.id);
    failures.set(key, entry);
  }
  const scenarios = [...new Set(trials.map((trial) => trial.id))].map((id) => {
    const rates: Record<string, Rate> = {};
    for (const trial of trials.filter((entry) => entry.id === id))
      add(rates, `${trial.model} ${trial.language}`, trial.passed);
    return { id, rates };
  });
  return {
    models,
    tools,
    failures: [...failures]
      .map(([failure, entry]) => ({
        failure,
        count: entry.count,
        ids: [...entry.ids].sort(),
      }))
      .sort((left, right) => right.count - left.count),
    scenarios,
  };
}

function keyOf(trial: NightTrial): string {
  return `${trial.model} ${trial.id} ${trial.language} r${trial.repetition}`;
}

/**
 * Pairs two nights' trials by model, scenario, language and repetition, and
 * tests whether the pass rate moved with McNemar's exact test.
 */
export function compare(
  before: readonly NightTrial[],
  after: readonly NightTrial[],
): Comparison {
  const earlier = new Map(
    latest(before).map((trial) => [keyOf(trial), trial.passed]),
  );
  const changes: { key: string; change: "fixed" | "broke" }[] = [];
  let paired = 0;
  for (const trial of latest(after)) {
    const key = keyOf(trial);
    const was = earlier.get(key);
    if (was === undefined) continue;
    paired += 1;
    if (was !== trial.passed)
      changes.push({ key, change: trial.passed ? "fixed" : "broke" });
  }
  const fixed = changes.filter((entry) => entry.change === "fixed").length;
  const broke = changes.length - fixed;
  return {
    paired,
    fixed,
    broke,
    pValue: mcnemarExact(fixed, broke),
    changes: changes.sort((left, right) => left.key.localeCompare(right.key)),
  };
}

function percent(rate: Rate): string {
  return rate.total === 0
    ? "-"
    : `${rate.passed}/${rate.total} (${Math.round((100 * rate.passed) / rate.total)}%)`;
}

/** Renders the morning report as Markdown. */
export function render(input: {
  readonly night: string;
  readonly gate: string;
  readonly stopped: boolean;
  readonly morning: Morning;
  readonly comparison?: Comparison;
}): string {
  const { morning } = input;
  const lines = [
    `# Excel lab night ${input.night}`,
    "",
    `Scripted gate: ${input.gate}. ${input.stopped ? "The time limit stopped the night before every trial ran." : "Every planned trial ran."}`,
    "",
    "## Models",
    "",
    "| Model | Passed | Mean calls | Catalog refusals | Budget refusals | Sourced / literal writes |",
    "| ----- | ------ | ---------- | ---------------- | --------------- | ------------------------ |",
    ...morning.models.map(
      (model) =>
        `| ${model.model} | ${percent(model.overall)} | ${model.meanDispatched.toFixed(1)} | ${model.refusedCatalog} | ${model.refusedBudget} | ${model.writes.sourced} / ${model.writes.literal} |`,
    ),
    "",
    "## Suites",
    "",
    ...morning.models.flatMap((model) => [
      `### ${model.model}`,
      "",
      "| Suite | Passed |",
      "| ----- | ------ |",
      ...Object.entries(model.suites).map(
        ([suite, rate]) => `| ${suite} | ${percent(rate)} |`,
      ),
      ...Object.entries(model.languages).map(
        ([language, rate]) => `| language ${language} | ${percent(rate)} |`,
      ),
      "",
    ]),
    "## Tools",
    "",
    "| Tool | Calls | Errors |",
    "| ---- | ----- | ------ |",
    ...Object.entries(morning.tools)
      .sort((left, right) => right[1].calls - left[1].calls)
      .map(
        ([tool, entry]) =>
          `| ${tool} | ${entry.calls} | ${Object.entries(entry.errors)
            .map(([code, count]) => `${code} ${count}`)
            .join(", ")} |`,
      ),
    "",
    "## Most common failures",
    "",
    ...morning.failures
      .slice(0, 15)
      .map(
        (entry) =>
          `- ${entry.count}× ${entry.failure.replaceAll("|", "\\|")} (${entry.ids.slice(0, 5).join(", ")}${entry.ids.length > 5 ? ", …" : ""})`,
      ),
    "",
  ];
  if (input.comparison !== undefined) {
    const { comparison } = input;
    lines.push(
      "## Against the previous night",
      "",
      `${comparison.paired} paired trials: ${comparison.fixed} now pass, ${comparison.broke} now fail; McNemar exact p = ${comparison.pValue.toFixed(3)}.`,
      "",
      ...comparison.changes
        .slice(0, 40)
        .map((entry) => `- ${entry.change}: ${entry.key}`),
      "",
    );
  }
  return lines.join("\n");
}
