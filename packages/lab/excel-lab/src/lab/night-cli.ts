import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { thinkingPolicies } from "../agent/host.ts";
import { finalizationPolicies } from "./trial.ts";
import { lines } from "./jsonl.ts";
import { prepareOutRoot } from "../run.ts";
import { runModel, runScripted, type TrialKey } from "./runner.ts";
import { serverIdentity } from "./runtime.ts";
import {
  hostsFor,
  prepareFixtures,
  runManifest,
  selectScenarios,
  writersFor,
} from "./setup.ts";

const think = z.union([z.boolean(), z.string().min(1)]);
const matrixSchema = z.strictObject({
  suites: z.array(z.string().min(1)).min(1).optional(),
  only: z.array(z.string().min(1)).min(1).optional(),
  languages: z
    .array(z.enum(["tr", "en"]))
    .min(1)
    .default(["tr", "en"]),
  repetitions: z.int().min(1).max(20).default(1),
  conditions: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z0-9-]{1,40}$/),
        hide: z.array(z.string().min(1)).min(1).optional(),
        window: z.int().min(4096).max(1_048_576).optional(),
        thinking: z.enum(thinkingPolicies).optional(),
        finalization: z.enum(finalizationPolicies).optional(),
      }),
    )
    .min(1)
    .default([{ name: "full" }]),
  hours: z.number().positive().max(24),
  models: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        think: think.optional(),
        answerThink: think.optional(),
      }),
    )
    .min(1),
});

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    matrix: { type: "string" },
    corpus: { type: "string" },
  },
});
const options = z
  .object({
    out: z.string().min(1),
    matrix: z.string().min(1),
    corpus: z.string().optional(),
    baseUrl: z.url(),
    key: z.string().optional(),
  })
  .parse({
    ...values,
    corpus: values.corpus ?? process.env["SEZZLEE_CORPUS"],
    baseUrl: process.env["SEZZLEE_AGENT_LAB_OLLAMA_URL"],
    key: process.env["SEZZLEE_AGENT_LAB_OLLAMA_KEY"],
  });
const matrix = matrixSchema.parse(
  JSON.parse(await readFile(options.matrix, "utf8")),
);
const deadline = Date.now() + matrix.hours * 3_600_000;
const expired = (): boolean => Date.now() >= deadline;

const out = await prepareOutRoot(options.out);
const scenarios = selectScenarios(matrix.suites, matrix.only);
if (
  scenarios.some((scenario) => scenario.id.startsWith("read/")) &&
  matrix.conditions.some(
    (condition) => condition.finalization === "reserve_last",
  )
)
  throw new Error(
    "reserve_last finalization is supported only by the authoring runner, not read scenarios.",
  );
const fixtures = await prepareFixtures(out, scenarios, options.corpus);
const { manifest, server, hash } = await runManifest(scenarios, { matrix });
const manifestPath = join(out, "manifest.json");
const saved = await readFile(manifestPath, "utf8").catch(() => null);

/**
 * Guard: a night directory holds one condition. Resuming it under another
 * server build, lab source, oracle or matrix would mix two conditions in one
 * set of results, so a different manifest is refused with the fields that
 * changed.
 */
if (saved !== null) {
  const previous = z.record(z.string(), z.unknown()).parse(JSON.parse(saved));
  const differences = [
    ...new Set([...Object.keys(previous), ...Object.keys(manifest)]),
  ].filter(
    (key) => JSON.stringify(previous[key]) !== JSON.stringify(manifest[key]),
  );
  assert.equal(
    differences.length,
    0,
    `This directory belongs to another condition: ${differences.join(", ")}`,
  );
} else await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

const scriptedDirectory = join(out, "scripted");
await mkdir(scriptedDirectory, { recursive: true });
const scriptedWriters = writersFor(scriptedDirectory, hash);
await writeFile(join(scriptedDirectory, "results.jsonl"), "");
const scripted = await runScripted({
  out: scriptedDirectory,
  scenarios,
  fixtures,
  onRecord: scriptedWriters.onRecord,
});
const gate = scripted.every((trial) => trial.passed);

async function finished(path: string): Promise<Set<string>> {
  const keys = new Set<string>();
  for await (const line of lines(path)) {
    const record = z
      .object({
        key: z.object({
          id: z.string(),
          language: z.string(),
          repetition: z.number(),
        }),
        failure: z.string().nullable(),
      })
      .parse(JSON.parse(line));
    if (!/^(?:host:|hostError|interrupted)/.test(record.failure ?? ""))
      keys.add(JSON.stringify(record.key));
  }
  return keys;
}

const models: Record<string, unknown>[] = [];
let stopped = false;
if (gate)
  for (const model of matrix.models) {
    if (expired()) {
      stopped = true;
      break;
    }
    const modelDirectory = join(
      out,
      model.name.replace(/[^A-Za-z0-9._-]+/g, "_"),
    );
    await mkdir(modelDirectory, { recursive: true });
    const hostOf = hostsFor({
      baseUrl: options.baseUrl,
      model: model.name,
      key: options.key,
    });
    let identity: unknown = null;
    while (identity === null && !expired())
      identity = await hostOf(model.think)
        .identity()
        .catch(async () => {
          await wait(30_000);
          return null;
        });
    if (identity === null) {
      stopped = true;
      break;
    }
    await writeFile(
      join(modelDirectory, "host.json"),
      JSON.stringify(identity, null, 2),
    );
    for (const condition of matrix.conditions) {
      const directory = join(modelDirectory, condition.name);
      await mkdir(directory, { recursive: true });
      const done = await finished(join(directory, "trials.jsonl"));
      const writers = writersFor(directory, hash);
      const run = await runModel({
        out: directory,
        scenarios,
        languages: matrix.languages,
        repetitions: matrix.repetitions,
        fixtures,
        ...(model.think === undefined ? {} : { think: model.think }),
        ...(model.answerThink === undefined
          ? {}
          : { answerThink: model.answerThink }),
        hostOf,
        skip: (key: TrialKey) => done.has(JSON.stringify(key)),
        expired,
        trial: writers,
        condition: {
          ...(condition.hide === undefined ? {} : { hide: condition.hide }),
          ...(condition.window === undefined
            ? {}
            : { window: condition.window }),
          ...(condition.thinking === undefined
            ? {}
            : { thinking: condition.thinking }),
          ...(condition.finalization === undefined
            ? {}
            : { finalization: condition.finalization }),
        },
        async onRecord(trial, key) {
          await writers.onRecord(trial);
          await writeFile(
            join(directory, "trials.jsonl"),
            JSON.stringify({ key, failure: trial.failure }) + "\n",
            { flag: "a" },
          );
        },
      });
      stopped = stopped || run.stopped;
      models.push({
        model: model.name,
        condition: condition.name,
        trials: run.records.length,
        passed: run.records.filter((trial) => trial.passed).length,
        resumedPast: done.size,
      });
      if (run.stopped) break;
    }
    if (stopped) break;
  }
assert.deepEqual(
  await serverIdentity(),
  server,
  "The server build changed during the night.",
);
await writeFile(
  join(out, "night.json"),
  JSON.stringify(
    {
      gate: gate ? "passed" : "failed",
      scripted: {
        trials: scripted.length,
        passed: scripted.filter((trial) => trial.passed).length,
      },
      models,
      stopped,
      finishedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
process.exitCode = gate ? 0 : 1;
