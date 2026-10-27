import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createExcelMcpServer,
  createWorkbookRoot,
  toolNames,
} from "@sezzlee/excel-mcp";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runTask,
  taskRevision,
  toolSpecsOf,
  trialIdOf,
} from "../../agent/agent-run.ts";
import { runPlan } from "../../agent/baseline.ts";
import { readCatalog, type Task } from "../../agent/task.ts";
import {
  underCondition,
  type LabScenario,
  type ModelPolicy,
  type TrialRecord,
} from "../trial.ts";

const catalog = await readCatalog();

const policy: ModelPolicy = {
  catalog: toolNames,
  requests: 15,
  calls: 15,
  window: 65536,
  numPredict: null,
  timeoutMs: 600000,
  thinking: "product",
};

async function readingClient(
  workspace: string,
): Promise<{ client: Client; close(): Promise<void> }> {
  const server = createExcelMcpServer(await createWorkbookRoot(workspace));
  const client = new Client({ name: "excel-lab-read", version: "1.0.0" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(left), server.connect(right)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function scenario(task: Task): LabScenario {
  const id = `read/${task.id}`;
  return {
    id,
    scriptedLanguages: ["en"],
    policy,
    async run(input) {
      const started = performance.now();
      await mkdir(input.directory, { recursive: true });
      const workspace = input.fixtures.readingWorkspace;
      const base = {
        id,
        mode: input.mode,
        language: input.language,
        directory: input.directory,
        output: null,
      };
      if (workspace === undefined)
        return {
          ...base,
          passed: false,
          failure: "Reading tasks need the reading workspace.",
          turns: 0,
          calls: {
            requested: 0,
            dispatched: 0,
            refusedCatalog: 0,
            refusedBudget: 0,
          },
          final: "",
          ms: 0,
        };
      const session = await readingClient(workspace);
      try {
        if (input.mode === "scripted") {
          const result = await runPlan(session.client, task);
          await writeFile(
            join(input.directory, "baseline.json"),
            JSON.stringify(result, null, 1),
          );
          const verified = result.outcome.kind === "verified";
          return {
            ...base,
            passed: verified,
            failure: verified
              ? null
              : `${result.outcome.kind}: ${"detail" in result.outcome ? result.outcome.detail : ""}`,
            turns: 0,
            calls: {
              requested: result.calls,
              dispatched: result.calls,
              refusedCatalog: 0,
              refusedBudget: 0,
            },
            final: JSON.stringify(result.derived),
            ms: Math.round(performance.now() - started),
          } satisfies TrialRecord;
        }
        if (input.host === undefined)
          throw new Error("A model trial needs a host.");
        const key = {
          task: task.id,
          taskRevision: taskRevision(task),
          language: input.language,
          repetition: input.repetition ?? 0,
        };
        const manifestHash = input.manifestHash ?? "unpinned";
        const condition = underCondition(policy, input.condition);
        const record = await runTask({
          task,
          key,
          trialId: trialIdOf(manifestHash, key),
          attempt: 1,
          manifestHash,
          language: input.language,
          catalog,
          host: input.host,
          client: session.client,
          tools: (await toolSpecsOf(session.client)).filter((tool) =>
            condition.catalog.includes(tool.function.name),
          ),
          window: condition.window,
          temperature: input.temperature ?? 0,
          thinking: policy.thinking,
          callBudget: policy.calls,
          timeoutMs: policy.timeoutMs,
          numPredict: policy.numPredict,
          retryDelayMs: input.retryDelayMs ?? 30_000,
          onEvent: (event) => input.onEvent?.(event) ?? Promise.resolve(),
        });
        await input.onRunRecord?.(record);
        return {
          ...base,
          passed: record.correct,
          failure: record.correct
            ? null
            : `${record.outcome}${record.failure === null ? "" : `: ${record.failure}`}`,
          turns: record.requests,
          calls: {
            requested: record.calls,
            dispatched: record.calls,
            refusedCatalog: 0,
            refusedBudget: 0,
          },
          final: JSON.stringify(record.submission),
          ms: Math.round(performance.now() - started),
        };
      } catch (error) {
        return {
          ...base,
          passed: false,
          failure: error instanceof Error ? error.message : String(error),
          turns: 0,
          calls: {
            requested: 0,
            dispatched: 0,
            refusedCatalog: 0,
            refusedBudget: 0,
          },
          final: "",
          ms: Math.round(performance.now() - started),
        };
      } finally {
        await session.close();
      }
    },
  };
}

export const readCatalogFiles = catalog.files;

export const readScenarios: readonly LabScenario[] =
  catalog.tasks.map(scenario);
