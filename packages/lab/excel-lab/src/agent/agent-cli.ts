import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createExcelMcpServer, createWorkbookRoot } from "@sezzlee/excel-mcp";
import { z } from "zod";
import {
  runTask,
  taskRevision,
  toolSpecsOf,
  trialIdOf,
  type RunRecord,
} from "./agent-run.ts";
import { eligibilityOf } from "./eligibility.ts";
import { describeGrade } from "./grade.ts";
import { thinkingPolicies } from "./host.ts";
import {
  buildManifest,
  canonicalHash,
  manifestDifferences,
  manifestSchema,
} from "./manifest.ts";
import { OllamaHost } from "./ollama.ts";
import { languages, levels, readCatalog } from "./task.ts";
import { buildWorkspace } from "./workspace.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    corpus: { type: "string" },
    model: { type: "string" },
    window: { type: "string", default: "65536" },
    languages: { type: "string", default: "tr,en" },
    runs: { type: "string", default: "1" },
    only: { type: "string" },
    levels: { type: "string" },
    temperature: { type: "string", default: "0" },
    thinking: { type: "string", default: "product" },
    budget: { type: "string", default: "15" },
    "timeout-ms": { type: "string", default: "600000" },
    "retry-delay-ms": { type: "string", default: "30000" },
    "keep-alive": { type: "string", default: "10m" },
    resume: { type: "boolean", default: false },
  },
  strict: true,
});

const positive = z.coerce.number().int().positive();
const list = z.string().transform((text) => text.split(","));
const options = z
  .object({
    out: z.string().min(1),
    corpus: z.string().min(1),
    model: z.string().min(1),
    window: positive,
    languages: list.pipe(z.array(z.enum(languages)).min(1)),
    runs: positive,
    only: list.optional(),
    levels: list.pipe(z.array(z.enum(levels))).optional(),
    temperature: z.coerce.number().min(0),
    thinking: z.enum(thinkingPolicies),
    budget: positive,
    timeoutMs: positive,
    retryDelayMs: z.coerce.number().int().nonnegative(),
    keepAlive: z.string().min(1),
    resume: z.boolean(),
    baseUrl: z.url(),
  })
  .parse({
    ...values,
    corpus: values.corpus ?? process.env["SEZZLEE_CORPUS"],
    timeoutMs: values["timeout-ms"],
    retryDelayMs: values["retry-delay-ms"],
    keepAlive: values["keep-alive"],
    baseUrl: process.env["SEZZLEE_AGENT_LAB_OLLAMA_URL"],
  });

const full = await readCatalog();
const tasks = full.tasks.filter(
  (task) =>
    (options.only === undefined || options.only.includes(task.id)) &&
    (options.levels === undefined || options.levels.includes(task.level)),
);
const workspace = await buildWorkspace({
  files: full.files,
  corpusRoot: options.corpus,
  outRoot: options.out,
});
const server = createExcelMcpServer(await createWorkbookRoot(workspace));
const client = new Client({ name: "excel-agent-lab", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([
  client.connect(clientTransport),
  server.connect(serverTransport),
]);
const tools = await toolSpecsOf(client);
const host = new OllamaHost({
  baseUrl: options.baseUrl,
  model: options.model,
  apiKey: process.env["SEZZLEE_AGENT_LAB_OLLAMA_KEY"],
  keepAlive: options.keepAlive,
});
const manifest = await buildManifest({
  host: await host.identity(),
  tools,
  generation: {
    window: options.window,
    temperature: options.temperature,
    thinking: options.thinking,
    keepAlive: options.keepAlive,
    callBudget: options.budget,
    timeoutMs: options.timeoutMs,
  },
});
const manifestHash = canonicalHash(manifest);
const manifestPath = join(options.out, "manifest.json");
const runsPath = join(options.out, "runs.jsonl");
const eventsPath = join(options.out, "events.jsonl");
const saved = await readFile(manifestPath, "utf8").catch(() => null);

/**
 * Guard: a directory holds one condition. Resuming under a manifest that
 * differs in any field (a rebuilt server, a changed task, another model
 * digest) would mix two conditions in one file, so it is refused with the
 * fields that changed.
 */
if (saved !== null) {
  const changed = manifestDifferences(
    manifestSchema.parse(JSON.parse(saved)),
    manifest,
  );
  if (changed.length > 0)
    throw new Error(
      `${options.out} holds runs of another condition; changed: ${changed.join(", ")}`,
    );
  if (!options.resume)
    throw new Error(
      `${options.out} already holds runs; pass --resume to continue them`,
    );
} else await writeFile(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);

const records = new Map<string, RunRecord>();
if (options.resume)
  for (const line of (await readFile(runsPath, "utf8").catch(() => "")).split(
    "\n",
  )) {
    if (line.trim() === "") continue;
    const record: RunRecord = JSON.parse(line);
    if (record.outcome !== "hostError") records.set(record.trialId, record);
  }

for (const task of tasks)
  for (const language of options.languages)
    for (let repetition = 0; repetition < options.runs; repetition += 1) {
      const key = {
        task: task.id,
        taskRevision: taskRevision(task),
        language,
        repetition,
      };
      const trialId = trialIdOf(manifestHash, key);
      if (records.has(trialId)) continue;
      const record = await runTask({
        task,
        key,
        trialId,
        manifestHash,
        language,
        catalog: full,
        host,
        client,
        tools,
        window: options.window,
        temperature: options.temperature,
        thinking: options.thinking,
        callBudget: options.budget,
        timeoutMs: options.timeoutMs,
        retryDelayMs: options.retryDelayMs,
        onEvent: (event) =>
          appendFile(eventsPath, `${JSON.stringify(event)}\n`),
      });
      records.set(trialId, record);
      await appendFile(runsPath, `${JSON.stringify(record)}\n`);
      process.stdout.write(
        `${record.correct ? "✓" : "✗"} ${record.outcome.padEnd(20)} ${language} r${repetition} ${task.id} calls ${record.calls}/${record.idealCalls} bytes ${record.responseBytes} peak ${record.peakInputTokens ?? "-"} ${record.grade === null ? (record.failure ?? "") : describeGrade(record.grade)}\n`,
      );
    }
await client.close();
await server.close();

const all = [...records.values()];
const eligible = all.filter((record) => eligibilityOf(record).eligible);
const excluded: Record<string, number> = {};
for (const record of all) {
  const eligibility = eligibilityOf(record);
  if (!eligibility.eligible)
    excluded[eligibility.reason] = (excluded[eligibility.reason] ?? 0) + 1;
}
const mean = (
  group: readonly RunRecord[],
  pick: (record: RunRecord) => number,
): number | null =>
  group.length === 0
    ? null
    : group.reduce((sum, record) => sum + pick(record), 0) / group.length;
const summary = {
  manifestHash,
  runs: all.length,
  eligible: eligible.length,
  excluded,
  byLanguage: Object.fromEntries(
    options.languages.map((language) => {
      const group = eligible.filter((record) => record.language === language);
      return [
        language,
        {
          runs: group.length,
          correct: group.filter((record) => record.correct).length,
          semanticCorrect: group.filter(
            (record) => record.grade?.semantic.correct === true,
          ).length,
          meanCalls: mean(group, (record) => record.calls),
          meanExcessCalls: mean(group, (record) => record.excessCalls),
          meanSeconds: mean(group, (record) => record.ms / 1000),
        },
      ];
    }),
  ),
};
await writeFile(
  join(options.out, "summary.json"),
  `${JSON.stringify(summary, null, 1)}\n`,
);
process.stdout.write(`${JSON.stringify(summary)}\n`);
