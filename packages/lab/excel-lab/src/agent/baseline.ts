import { performance } from "node:perf_hooks";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createExcelMcpServer, createWorkbookRoot } from "@sezzlee/excel-mcp";
import { derive, type StepResponse } from "./derive.ts";
import { matchesAnswer } from "./grade.ts";
import type { Catalog, Task } from "./task.ts";

export interface StepRecord {
  readonly tool: string;
  readonly role: "discover" | "answer";
  readonly args: Readonly<Record<string, unknown>>;
  readonly expectError: string | null;
  readonly error: string | null;
  readonly bytes: number;
  readonly ms: number;
  readonly text: string;
}

export type BaselineOutcome =
  | { readonly kind: "verified" }
  | { readonly kind: "planFailed"; readonly detail: string }
  | { readonly kind: "evidenceIncomplete"; readonly detail: string }
  | { readonly kind: "answerMismatch"; readonly detail: string };

export interface TaskBaseline {
  readonly id: string;
  readonly level: Task["level"];
  readonly knowledge: Task["knowledge"];
  readonly outcome: BaselineOutcome;
  readonly calls: number;
  readonly answerCalls: number;
  readonly bytes: number;
  readonly ms: number;
  readonly derived: unknown;
  readonly steps: readonly StepRecord[];
}

function errorCodeOf(isError: boolean, text: string): string | null {
  if (!isError) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string"
    )
      return parsed.error;
  } catch {
    return "unparsable_error";
  }
  return "unparsable_error";
}

function responseOf(step: StepRecord): StepResponse {
  if (step.error !== null) return { kind: "error", code: step.error };
  try {
    return { kind: "ok", body: JSON.parse(step.text) };
  } catch {
    return { kind: "ok", body: step.text };
  }
}

function fold(value: unknown): unknown {
  if (typeof value === "string")
    return value.normalize("NFC").trim().toLocaleLowerCase("tr");
  if (Array.isArray(value)) return value.map(fold);
  return value;
}

function judge(
  task: Task,
  steps: readonly StepRecord[],
): { readonly outcome: BaselineOutcome; readonly derived: unknown } {
  const wrong = steps.find((step) => step.error !== step.expectError);
  if (wrong !== undefined)
    return {
      outcome: {
        kind: "planFailed",
        detail: `${wrong.tool} returned ${wrong.error ?? "no error"}, planned ${wrong.expectError ?? "no error"}`,
      },
      derived: null,
    };
  const responses = steps.map(responseOf);
  const { answer, plan } = task;
  if (answer.kind === "refusal") {
    if (plan.confirm === undefined)
      return { outcome: { kind: "verified" }, derived: null };
    const confirmed = derive(plan.confirm.value, responses);
    if (confirmed.kind === "incomplete")
      return {
        outcome: { kind: "evidenceIncomplete", detail: confirmed.detail },
        derived: null,
      };
    return JSON.stringify(fold(confirmed.value)) ===
      JSON.stringify(fold(plan.confirm.equals))
      ? { outcome: { kind: "verified" }, derived: confirmed.value }
      : {
          outcome: {
            kind: "answerMismatch",
            detail: `confirmation read ${JSON.stringify(confirmed.value)}`,
          },
          derived: confirmed.value,
        };
  }
  if (plan.derive === undefined)
    return {
      outcome: { kind: "planFailed", detail: "no derivation" },
      derived: null,
    };
  const derived = derive(plan.derive, responses);
  if (derived.kind === "incomplete")
    return {
      outcome: { kind: "evidenceIncomplete", detail: derived.detail },
      derived: null,
    };
  const match = matchesAnswer(answer, derived.value);
  return {
    outcome: match.same
      ? { kind: "verified" }
      : { kind: "answerMismatch", detail: match.detail },
    derived: derived.value,
  };
}

/**
 * Runs every task's plan against one in-process server rooted at the
 * workspace, derives the answer from named places in the responses, and
 * compares it with the task's answer.
 */
export async function runBaseline({
  catalog,
  workspace,
  onTask,
}: {
  readonly catalog: Catalog;
  readonly workspace: string;
  readonly onTask?: (result: TaskBaseline) => void;
}): Promise<readonly TaskBaseline[]> {
  const server = createExcelMcpServer(await createWorkbookRoot(workspace));
  const client = new Client({ name: "excel-agent-lab", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  const results: TaskBaseline[] = [];
  for (const task of catalog.tasks) {
    const steps: StepRecord[] = [];
    for (const planned of task.plan.steps) {
      const before = performance.now();
      const result = await client.callTool({
        name: planned.tool,
        arguments: planned.args,
      });
      const ms = performance.now() - before;
      const text = result.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      steps.push({
        tool: planned.tool,
        role: planned.role,
        args: planned.args,
        expectError: planned.expectError ?? null,
        error: errorCodeOf(result.isError === true, text),
        bytes: Buffer.byteLength(text, "utf8"),
        ms,
        text,
      });
    }
    const { outcome, derived } = judge(task, steps);
    const result: TaskBaseline = {
      id: task.id,
      level: task.level,
      knowledge: task.knowledge,
      outcome,
      calls: steps.length,
      answerCalls: steps.filter((step) => step.role === "answer").length,
      bytes: steps.reduce((sum, step) => sum + step.bytes, 0),
      ms: steps.reduce((sum, step) => sum + step.ms, 0),
      derived,
      steps,
    };
    results.push(result);
    onTask?.(result);
  }
  await client.close();
  await server.close();
  return results;
}
