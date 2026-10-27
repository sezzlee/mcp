import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalHash } from "../agent/manifest.ts";
import { OllamaHost } from "../agent/ollama.ts";
import { buildWorkspace } from "../agent/workspace.ts";
import { labIdentity, serverIdentity, type Identity } from "./runtime.ts";
import { suites } from "./suites/index.ts";
import { readCatalogFiles } from "./suites/read.ts";
import type {
  Fixtures,
  LabScenario,
  TrialInput,
  TrialRecord,
} from "./trial.ts";

/** The scenarios of the named suites, narrowed to `only` when it is given. */
export function selectScenarios(
  suiteNames: readonly string[] | undefined,
  only: readonly string[] | undefined,
): readonly LabScenario[] {
  const selected = (suiteNames ?? Object.keys(suites)).flatMap((name) => {
    const suite = suites[name];
    if (suite === undefined) throw new Error(`Unknown suite ${name}.`);
    return suite.filter(
      (scenario) => only === undefined || only.includes(scenario.id),
    );
  });
  assert(selected.length > 0, "No scenario matches the selection.");
  return selected;
}

/** Fixtures for a run; reading tasks get one verified, shared workspace. */
export async function prepareFixtures(
  out: string,
  scenarios: readonly LabScenario[],
  corpus: string | undefined,
): Promise<Fixtures> {
  const reading = scenarios.some((scenario) => scenario.id.startsWith("read/"));
  if (!reading) return { corpus };
  assert(
    corpus !== undefined,
    "Reading tasks need --corpus or SEZZLEE_CORPUS.",
  );
  return {
    corpus,
    readingWorkspace: await buildWorkspace({
      files: readCatalogFiles,
      corpusRoot: corpus,
      outRoot: out,
    }),
  };
}

/** The identity a run's results are bound to, and its hash. */
export async function runManifest(
  scenarios: readonly LabScenario[],
  extra: Readonly<Record<string, unknown>>,
): Promise<{
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly server: Identity;
  readonly hash: string;
}> {
  const server = await serverIdentity();
  const manifest = {
    server,
    lab: await labIdentity(),
    node: process.version,
    ...extra,
    scenarios: scenarios.map(({ id, scriptedLanguages, policy }) => ({
      id,
      scriptedLanguages,
      policy,
    })),
  };
  return { manifest, server, hash: canonicalHash(manifest) };
}

/** One Ollama host per `think` setting, built only when first asked for. */
export function hostsFor(input: {
  readonly baseUrl: string | undefined;
  readonly model: string;
  readonly key: string | undefined;
}): (think: boolean | string | undefined) => OllamaHost {
  const hosts = new Map<string, OllamaHost>();
  return (think) => {
    assert(
      input.baseUrl !== undefined,
      "Set SEZZLEE_AGENT_LAB_OLLAMA_URL for model trials.",
    );
    const key = String(think);
    const known = hosts.get(key);
    if (known !== undefined) return known;
    const host = new OllamaHost({
      baseUrl: input.baseUrl,
      model: input.model,
      ...(input.key === undefined ? {} : { apiKey: input.key }),
      ...(think === undefined ? {} : { think }),
    });
    hosts.set(key, host);
    return host;
  };
}

/** Appenders for a directory's results, reading runs and events. */
export function writersFor(
  directory: string,
  manifestHash: string,
): Pick<TrialInput, "manifestHash" | "onRunRecord" | "onEvent"> & {
  readonly onRecord: (trial: TrialRecord) => Promise<void>;
} {
  return {
    manifestHash,
    onRunRecord: (record) =>
      appendFile(join(directory, "runs.jsonl"), JSON.stringify(record) + "\n"),
    onEvent: (event) =>
      appendFile(join(directory, "events.jsonl"), JSON.stringify(event) + "\n"),
    async onRecord(trial) {
      await appendFile(
        join(directory, "results.jsonl"),
        JSON.stringify(trial) + "\n",
      );
      process.stdout.write(
        `${trial.passed ? "passed" : "FAILED"} ${trial.mode} ${trial.id} ${trial.language}${trial.failure === null ? "" : `: ${trial.failure}`}\n`,
      );
    },
  };
}

export const thinkOption = (
  value: string | undefined,
): boolean | string | undefined =>
  value === undefined
    ? undefined
    : value === "true"
      ? true
      : value === "false"
        ? false
        : value;
