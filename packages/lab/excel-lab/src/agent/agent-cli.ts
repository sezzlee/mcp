import { appendFile, readFile, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createExcelMcpServer, createWorkbookRoot } from "@sezzlee/excel-mcp";
import { runTask, toolSpecsOf, type RunRecord } from "./agent-run.ts";
import { OllamaHost } from "./ollama.ts";
import { languages, readCatalog, type Language } from "./task.ts";
import { buildWorkspace } from "./workspace.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    corpus: { type: "string" },
    models: { type: "string" },
    windows: { type: "string", default: "65536" },
    languages: { type: "string", default: "tr,en" },
    runs: { type: "string", default: "1" },
    only: { type: "string" },
    levels: { type: "string" },
    temperature: { type: "string", default: "0" },
    budget: { type: "string", default: "15" },
    "timeout-ms": { type: "string", default: "600000" },
    resume: { type: "boolean", default: false },
  },
  strict: true,
});
const baseUrl = process.env["SEZZLEE_AGENT_LAB_OLLAMA_URL"];
const corpusRoot = values.corpus ?? process.env["SEZZLEE_CORPUS"];
if (
  values.out === undefined ||
  corpusRoot === undefined ||
  values.models === undefined ||
  baseUrl === undefined
)
  throw new Error(
    "Pass --out <directory outside the repository>, --corpus <root> (or SEZZLEE_CORPUS), --models <name,...> and set SEZZLEE_AGENT_LAB_OLLAMA_URL.",
  );
const chosenLanguages = values.languages.split(",").map((code) => {
  const language = languages.find((known) => known === code);
  if (language === undefined) throw new Error(`unknown language ${code}`);
  return language;
});
const windows = values.windows.split(",").map(Number);
const only = values.only?.split(",");
const levels = values.levels?.split(",");
const full = await readCatalog();
const tasks = full.tasks.filter(
  (task) =>
    (only === undefined || only.includes(task.id)) &&
    (levels === undefined || levels.includes(task.level)),
);
const workspace = await buildWorkspace({
  catalog: full,
  corpusRoot,
  outRoot: values.out,
});
const server = createExcelMcpServer(await createWorkbookRoot(workspace));
const client = new Client({ name: "excel-agent-lab", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([
  client.connect(clientTransport),
  server.connect(serverTransport),
]);
const tools = await toolSpecsOf(client);

/**
 * Guard: a host that drops one request (a shared GPU, a restart) is retried
 * twice before the run is recorded as `hostError`, so one bad minute does
 * not end a matrix of hours.
 */
async function attempt<T>(run: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await run();
    } catch (error) {
      if (tries >= 3) throw error;
      process.stdout.write(`retrying after ${String(error)}\n`);
      await wait(30_000);
    }
  }
}

function hostFailure(input: {
  readonly model: string;
  readonly window: number;
  readonly task: (typeof tasks)[number];
  readonly language: Language;
  readonly error: unknown;
}): RunRecord {
  return {
    task: input.task.id,
    level: input.task.level,
    knowledge: input.task.knowledge,
    language: input.language,
    model: input.model,
    window: input.window,
    loadedWindow: null,
    outcome: "hostError",
    correct: false,
    grade: { correct: false, detail: String(input.error) },
    submission: null,
    calls: 0,
    idealCalls: input.task.plan.filter((step) => "tool" in step).length,
    excessCalls: 0,
    responseBytes: 0,
    toolErrors: {},
    invalidArgs: 0,
    recoveryCalls: 0,
    requests: 0,
    toolSchemaTokens: 0,
    peakInputTokens: null,
    peakEstimatedTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    windowUse: null,
    ms: 0,
    trace: [],
    callLog: [],
  };
}
const runsPath = join(values.out, "runs.jsonl");
const records: RunRecord[] = [];
const keyOf = (record: {
  readonly model: string;
  readonly window: number;
  readonly task: string;
  readonly language: string;
}): string =>
  `${record.model} ${record.window} ${record.task} ${record.language}`;
const completed = new Map<string, number>();
if (values.resume) {
  const saved = await readFile(runsPath, "utf8").catch(() => "");
  for (const line of saved.split("\n")) {
    if (line.trim() === "") continue;
    const record: RunRecord = JSON.parse(line);
    if (record.outcome === "hostError") continue;
    records.push(record);
    completed.set(keyOf(record), (completed.get(keyOf(record)) ?? 0) + 1);
  }
}

for (const model of values.models.split(",")) {
  const host = new OllamaHost({
    baseUrl,
    model,
    apiKey: process.env["SEZZLEE_AGENT_LAB_OLLAMA_KEY"],
  });
  for (const window of windows)
    for (const task of tasks)
      for (const language of chosenLanguages as readonly Language[])
        for (
          let run =
            completed.get(keyOf({ model, window, task: task.id, language })) ??
            0;
          run < Number(values.runs);
          run += 1
        ) {
          const record = await attempt(() =>
            runTask({
              task,
              language,
              catalog: full,
              host,
              client,
              tools,
              window,
              temperature: Number(values.temperature),
              callBudget: Number(values.budget),
              timeoutMs: Number(values["timeout-ms"]),
            }),
          ).catch((error: unknown) =>
            hostFailure({ model, window, task, language, error }),
          );
          records.push(record);
          await appendFile(runsPath, `${JSON.stringify(record)}\n`);
          process.stdout.write(
            `${record.correct ? "✓" : "✗"} ${record.outcome.padEnd(15)} ${model} ${window} ${language} ${task.id} calls ${record.calls}/${record.idealCalls} bytes ${record.responseBytes} peak ${record.peakInputTokens ?? "-"} ${record.grade?.detail ?? ""}\n`,
          );
        }
}
await client.close();
await server.close();

function summarize(group: readonly RunRecord[]) {
  const mean = (pick: (record: RunRecord) => number) =>
    group.length === 0
      ? 0
      : group.reduce((sum, record) => sum + pick(record), 0) / group.length;
  return {
    runs: group.length,
    correct: group.filter((record) => record.correct).length,
    accuracy:
      group.length === 0
        ? 0
        : group.filter((record) => record.correct).length / group.length,
    meanCalls: mean((record) => record.calls),
    meanExcessCalls: mean((record) => record.excessCalls),
    meanResponseBytes: mean((record) => record.responseBytes),
    meanPeakInputTokens: mean((record) => record.peakInputTokens ?? 0),
    contextExceeded: group.filter(
      (record) => record.outcome === "contextExceeded",
    ).length,
    windowMismatch: group.filter(
      (record) =>
        record.loadedWindow !== null && record.loadedWindow !== record.window,
    ).length,
  };
}
const keys = [
  ...new Set(
    records.map(
      (record) => `${record.model} ${record.window} ${record.language}`,
    ),
  ),
];
const summary = Object.fromEntries(
  keys.map((key) => [
    key,
    summarize(
      records.filter(
        (record) =>
          `${record.model} ${record.window} ${record.language}` === key,
      ),
    ),
  ]),
);
await writeFile(
  join(values.out, "summary.json"),
  `${JSON.stringify(summary, null, 1)}\n`,
);
process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
