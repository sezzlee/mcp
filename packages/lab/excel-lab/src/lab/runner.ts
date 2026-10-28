import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelHost } from "../agent/host.ts";
import type {
  Condition,
  Fixtures,
  LabScenario,
  Language,
  TrialInput,
  TrialRecord,
} from "./trial.ts";

export interface LabRun {
  readonly gate: "passed" | "failed";
  readonly modelTrials: boolean;
  readonly records: readonly TrialRecord[];
}

export interface TrialKey {
  readonly id: string;
  readonly language: Language;
  readonly repetition: number;
}

type Shared = Pick<TrialInput, "manifestHash" | "onRunRecord" | "onEvent">;

/**
 * Guard: a resumed run reuses trial directories, and a fixture written at a
 * content-addressed path collides with the file a previous run left there, so
 * every trial starts from an emptied directory.
 */
async function directoryOf(
  out: string,
  mode: string,
  scenario: LabScenario,
  language: Language,
  repetition = 0,
): Promise<string> {
  const directory = join(
    out,
    mode,
    `${scenario.id.replace("/", "-")}-${language}${repetition === 0 ? "" : `-r${repetition}`}`,
  );
  await rm(directory, { recursive: true, force: true });
  return directory;
}

/** Runs every selected scenario's scripted baseline once per scripted language. */
export async function runScripted(input: {
  readonly out: string;
  readonly scenarios: readonly LabScenario[];
  readonly fixtures: Fixtures;
  readonly onRecord: (trial: TrialRecord) => Promise<void>;
  readonly trial?: Shared;
}): Promise<readonly TrialRecord[]> {
  const records: TrialRecord[] = [];
  for (const scenario of input.scenarios)
    for (const language of scenario.scriptedLanguages) {
      const trial = await scenario.run({
        mode: "scripted",
        language,
        directory: await directoryOf(input.out, "scripted", scenario, language),
        fixtures: input.fixtures,
        ...input.trial,
      });
      records.push(trial);
      await input.onRecord(trial);
    }
  return records;
}

/**
 * Runs the model trials of every scenario, language and repetition in order.
 * @param input.skip says a trial already finished, for a resumed run
 * @param input.expired says the run's time is up; no trial starts after it
 * returns true
 * @returns the trials run and whether the time limit stopped the run
 */
export async function runModel(input: {
  readonly out: string;
  readonly scenarios: readonly LabScenario[];
  readonly languages: readonly Language[];
  readonly repetitions?: number;
  readonly fixtures: Fixtures;
  readonly think?: boolean | string;
  readonly answerThink?: boolean | string;
  readonly hostOf: (think: boolean | string | undefined) => ModelHost;
  readonly skip?: (key: TrialKey) => boolean;
  readonly expired?: () => boolean;
  readonly onRecord: (trial: TrialRecord, key: TrialKey) => Promise<void>;
  readonly trial?: Shared;
  readonly condition?: Condition;
}): Promise<{
  readonly records: readonly TrialRecord[];
  readonly stopped: boolean;
}> {
  const records: TrialRecord[] = [];
  for (
    let repetition = 0;
    repetition < (input.repetitions ?? 1);
    repetition += 1
  )
    for (const scenario of input.scenarios)
      for (const language of input.languages) {
        const key = { id: scenario.id, language, repetition };
        if (input.skip?.(key) === true) continue;
        if (input.expired?.() === true) return { records, stopped: true };
        const trial = await scenario.run({
          mode: "model",
          language,
          directory: await directoryOf(
            input.out,
            "model",
            scenario,
            language,
            repetition,
          ),
          fixtures: input.fixtures,
          repetition,
          ...(input.condition === undefined
            ? {}
            : { condition: input.condition }),
          ...input.trial,
          host: input.hostOf(input.think ?? scenario.policy.think),
          ...(input.answerThink === undefined
            ? {}
            : { answerHost: input.hostOf(input.answerThink) }),
        });
        records.push(trial);
        await input.onRecord(trial, key);
      }
  return { records, stopped: false };
}

/**
 * Runs every selected scenario's scripted baseline, then, only when all of
 * them passed and a model was asked for, the model trials in each language.
 * @param input.hostOf builds the host for one Ollama `think` setting; it is
 * not called at all while the baseline is failing
 */
export async function runLab(input: {
  readonly out: string;
  readonly scenarios: readonly LabScenario[];
  readonly languages: readonly Language[];
  readonly fixtures: Fixtures;
  readonly model: boolean;
  readonly think?: boolean | string;
  readonly answerThink?: boolean | string;
  readonly hostOf: (think: boolean | string | undefined) => ModelHost;
  readonly onRecord: (trial: TrialRecord) => Promise<void>;
  readonly trial?: Shared;
}): Promise<LabRun> {
  const scripted = await runScripted(input);
  /**
   * Guard: model trials start only after every selected scripted baseline
   * passed, and no host is built before that, so a failing baseline sends the
   * model host no request at all, identity included. A trial scored against a
   * broken fixture or oracle would otherwise count as a model failure.
   */
  const gate = scripted.every((trial) => trial.passed);
  const model =
    input.model && gate
      ? (
          await runModel({
            ...input,
            onRecord: (trial) => input.onRecord(trial),
          })
        ).records
      : [];
  return {
    gate: gate ? "passed" : "failed",
    modelTrials: input.model && gate,
    records: [...scripted, ...model],
  };
}
