import { join } from "node:path";
import type { ModelHost } from "../agent/host.ts";
import type {
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

/**
 * Runs every selected scenario's scripted baseline, then, only when all of
 * them passed and a host is available, the model trials in each language.
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
  readonly trial?: Pick<TrialInput, "manifestHash" | "onRunRecord" | "onEvent">;
}): Promise<LabRun> {
  const records: TrialRecord[] = [];
  const record = async (trial: TrialRecord): Promise<void> => {
    records.push(trial);
    await input.onRecord(trial);
  };
  const directoryOf = (
    mode: string,
    scenario: LabScenario,
    language: Language,
  ): string =>
    join(input.out, mode, `${scenario.id.replace("/", "-")}-${language}`);

  for (const scenario of input.scenarios)
    for (const language of scenario.scriptedLanguages)
      await record(
        await scenario.run({
          mode: "scripted",
          language,
          directory: directoryOf("scripted", scenario, language),
          fixtures: input.fixtures,
          ...input.trial,
        }),
      );

  /**
   * Guard: model trials start only after every selected scripted baseline
   * passed, and no host is built before that, so a failing baseline sends the
   * model host no request at all, identity included. A trial scored against a
   * broken fixture or oracle would otherwise count as a model failure.
   */
  const gate = records.every((trial) => trial.passed);
  if (input.model && gate)
    for (const scenario of input.scenarios)
      for (const language of input.languages)
        await record(
          await scenario.run({
            mode: "model",
            language,
            directory: directoryOf("model", scenario, language),
            fixtures: input.fixtures,
            ...input.trial,
            host: input.hostOf(input.think ?? scenario.policy.think),
            ...(input.answerThink === undefined
              ? {}
              : { answerHost: input.hostOf(input.answerThink) }),
          }),
        );
  return {
    gate: gate ? "passed" : "failed",
    modelTrials: input.model && gate,
    records,
  };
}
