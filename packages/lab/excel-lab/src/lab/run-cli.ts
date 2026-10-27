import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { prepareOutRoot } from "../run.ts";
import { runLab } from "./runner.ts";
import { serverIdentity } from "./runtime.ts";
import {
  hostsFor,
  prepareFixtures,
  runManifest,
  selectScenarios,
  thinkOption,
  writersFor,
} from "./setup.ts";

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
const options = z
  .object({
    out: z.string().min(1),
    suite: z.string().optional(),
    only: z.string().optional(),
    model: z.string().optional(),
    languages: z.string(),
    think: z.string().optional(),
    "final-think": z.string().optional(),
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
const think = thinkOption(options.think);
const answerThink = thinkOption(options["final-think"]);
const selected = selectScenarios(
  options.suite?.split(","),
  options.only?.split(","),
);
const languages = z
  .array(z.enum(["tr", "en"]))
  .parse(options.languages.split(","));

const out = await prepareOutRoot(options.out);
const fixtures = await prepareFixtures(out, selected, options.corpus);
const { manifest, server, hash } = await runManifest(selected, {
  model: options.model ?? null,
  think: think ?? null,
  finalThink: answerThink ?? null,
});
await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
const hostOf = hostsFor({
  baseUrl: options.baseUrl,
  model: options.model ?? "",
  key: options.key,
});
const { onRecord, ...trial } = writersFor(out, hash);
const run = await runLab({
  out,
  scenarios: selected,
  languages,
  fixtures,
  model: options.model !== undefined,
  ...(think === undefined ? {} : { think }),
  ...(answerThink === undefined ? {} : { answerThink }),
  hostOf,
  trial,
  onRecord,
});
if (run.modelTrials)
  await writeFile(
    join(out, "host.json"),
    JSON.stringify({ identity: await hostOf(think).identity() }, null, 2),
  );
assert.deepEqual(
  await serverIdentity(),
  server,
  "The server build changed during the run.",
);
const passed = run.records.filter((record) => record.passed).length;
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
