import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { OllamaHost } from "../agent/ollama.ts";
import { prepareOutRoot } from "../run.ts";
import { labIdentity, serverIdentity } from "./runtime.ts";
import { suites } from "./suites/index.ts";
import { readCatalogFiles } from "./suites/read.ts";
import { buildWorkspace } from "../agent/workspace.ts";
import { canonicalHash } from "../agent/manifest.ts";
import type { LabScenario } from "./trial.ts";
import { runLab } from "./runner.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    suite: { type: "string" },
    only: { type: "string" },
    model: { type: "string" },
    languages: { type: "string", default: "tr,en" },
    think: { type: "string" },
    "final-think": { type: "string" },
    corpus: { type: "string" },
  },
});
const think = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined
      ? undefined
      : value === "true"
        ? true
        : value === "false"
          ? false
          : value,
  );
const options = z
  .object({
    out: z.string().min(1),
    suite: z.string().optional(),
    only: z.string().optional(),
    model: z.string().optional(),
    languages: z.string(),
    think,
    "final-think": think,
    corpus: z.string().optional(),
    baseUrl: z.url().optional(),
    key: z.string().optional(),
  })
  .parse({
    ...values,
    corpus: values.corpus ?? process.env["SEZZLEE_CORPUS"],
    baseUrl: process.env["SEZZLEE_AGENT_LAB_OLLAMA_URL"],
    key: process.env["SEZZLEE_AGENT_LAB_OLLAMA_KEY"],
  });

const suiteNames = options.suite?.split(",") ?? Object.keys(suites);
const only = options.only?.split(",");
const selected: LabScenario[] = suiteNames.flatMap((name) => {
  const suite = suites[name];
  if (suite === undefined) throw new Error(`Unknown suite ${name}.`);
  return suite.filter(
    (scenario) => only === undefined || only.includes(scenario.id),
  );
});
assert(selected.length > 0, "No scenario matches the selection.");
const languages = z
  .array(z.enum(["tr", "en"]))
  .parse(options.languages.split(","));

const out = await prepareOutRoot(options.out);
const reading = selected.some((scenario) => scenario.id.startsWith("read/"));
if (reading)
  assert(
    options.corpus !== undefined,
    "Reading tasks need --corpus or SEZZLEE_CORPUS.",
  );
const fixtures = {
  corpus: options.corpus,
  ...(reading && options.corpus !== undefined
    ? {
        readingWorkspace: await buildWorkspace({
          files: readCatalogFiles,
          corpusRoot: options.corpus,
          outRoot: out,
        }),
      }
    : {}),
};
const server = await serverIdentity();
const manifest = {
  server,
  lab: await labIdentity(),
  node: process.version,
  model: options.model ?? null,
  think: options.think ?? null,
  finalThink: options["final-think"] ?? null,
  scenarios: selected.map(({ id, scriptedLanguages, policy }) => ({
    id,
    scriptedLanguages,
    policy,
  })),
};
await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
const manifestHash = canonicalHash(manifest);

const hosts = new Map<string, OllamaHost>();
const hostOf = (think: boolean | string | undefined): OllamaHost => {
  assert(
    options.baseUrl !== undefined,
    "Set SEZZLEE_AGENT_LAB_OLLAMA_URL for model trials.",
  );
  const key = String(think);
  const known = hosts.get(key);
  if (known !== undefined) return known;
  const host = new OllamaHost({
    baseUrl: options.baseUrl,
    model: options.model ?? "",
    ...(options.key === undefined ? {} : { apiKey: options.key }),
    ...(think === undefined ? {} : { think }),
  });
  hosts.set(key, host);
  return host;
};
const run = await runLab({
  out,
  scenarios: selected,
  languages,
  fixtures,
  model: options.model !== undefined,
  ...(options.think === undefined ? {} : { think: options.think }),
  ...(options["final-think"] === undefined
    ? {}
    : { answerThink: options["final-think"] }),
  hostOf,
  trial: {
    manifestHash,
    onRunRecord: (record) =>
      appendFile(join(out, "runs.jsonl"), JSON.stringify(record) + "\n"),
    onEvent: (event) =>
      appendFile(join(out, "events.jsonl"), JSON.stringify(event) + "\n"),
  },
  async onRecord(trial) {
    await appendFile(join(out, "results.jsonl"), JSON.stringify(trial) + "\n");
    process.stdout.write(
      `${trial.passed ? "passed" : "FAILED"} ${trial.mode} ${trial.id} ${trial.language}${trial.failure === null ? "" : `: ${trial.failure}`}\n`,
    );
  },
});
if (run.modelTrials)
  await writeFile(
    join(out, "host.json"),
    JSON.stringify(
      { identity: await hostOf(options.think).identity() },
      null,
      2,
    ),
  );
assert.deepEqual(
  await serverIdentity(),
  server,
  "The server build changed during the run.",
);
const passed = run.records.filter((trial) => trial.passed).length;
await writeFile(
  join(out, "summary.json"),
  JSON.stringify(
    {
      gate: run.gate,
      modelTrials: run.modelTrials,
      passed,
      total: run.records.length,
    },
    null,
    2,
  ),
);
process.exitCode =
  passed === run.records.length && run.gate === "passed" ? 0 : 1;
