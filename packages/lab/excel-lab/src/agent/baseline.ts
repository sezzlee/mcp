import { performance } from "node:perf_hooks";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createExcelMcpServer, createWorkbookRoot } from "@sezzlee/excel-mcp";
import type { Answer, Catalog, Task } from "./task.ts";

export interface StepRecord {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly expectError: string | null;
  readonly error: string | null;
  readonly bytes: number;
  readonly ms: number;
  readonly text: string;
}

export type BaselineOutcome =
  | "answered"
  | "needsCompute"
  | "answerMissing"
  | "refusalPlan"
  | "unexpectedError"
  | "missingError";

export interface TaskBaseline {
  readonly id: string;
  readonly level: Task["level"];
  readonly knowledge: Task["knowledge"];
  readonly outcome: BaselineOutcome;
  readonly calls: number;
  readonly bytes: number;
  readonly ms: number;
  readonly missing: readonly string[];
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

function fold(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleLowerCase("tr")
    .replace(/(\d)t(\d)/g, "$1 $2")
    .replace(/\s+/g, " ");
}

function numbersIn(value: unknown, out: number[]): void {
  if (typeof value === "number") out.push(value);
  else if (typeof value === "string")
    for (const match of value.matchAll(/-?\d+(?:[.,]\d+)?/g))
      out.push(Number(match[0].replace(",", ".")));
  else if (Array.isArray(value)) for (const item of value) numbersIn(item, out);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) numbersIn(item, out);
}

class Evidence {
  readonly #numbers: number[] = [];
  readonly #text: string;

  constructor(texts: readonly string[]) {
    for (const text of texts) {
      try {
        numbersIn(JSON.parse(text), this.#numbers);
      } catch {
        numbersIn(text, this.#numbers);
      }
    }
    this.#text = fold(texts.join("\n"));
  }

  number(value: number, tolerance: number): boolean {
    const allowed = Math.max(tolerance, 1e-9 * Math.max(1, Math.abs(value)));
    return this.#numbers.some((seen) => Math.abs(seen - value) <= allowed);
  }

  text(value: string): number {
    return this.#text.indexOf(fold(value));
  }

  scalar(value: string | number, tolerance: number): boolean {
    return typeof value === "number"
      ? this.number(value, tolerance)
      : this.text(value) >= 0;
  }
}

function missingFrom(answer: Answer, evidence: Evidence): readonly string[] {
  switch (answer.kind) {
    case "number":
      return evidence.number(answer.value, answer.tolerance)
        ? []
        : [String(answer.value)];
    case "text":
      return evidence.text(answer.value) >= 0 ? [] : [answer.value];
    case "set":
      return answer.items
        .filter((item) => !evidence.scalar(item, 0))
        .map(String);
    case "list": {
      const missing = answer.items
        .filter((item) => !evidence.scalar(item, 0))
        .map(String);
      if (missing.length > 0) return missing;
      const positions = answer.items.map((item) => evidence.text(String(item)));
      return positions.every(
        (at, index) => index === 0 || at > (positions[index - 1] ?? -1),
      )
        ? []
        : ["order"];
    }
    case "record":
      return Object.entries(answer.fields)
        .filter(([, value]) => !evidence.scalar(value, answer.tolerance))
        .map(([key]) => key);
    case "refusal":
      return [];
    default: {
      const exhaustive: never = answer;
      return exhaustive;
    }
  }
}

/**
 * Runs every task's plan against one in-process server rooted at the workspace
 * and checks that the planned calls behave as declared and expose the answer.
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
    for (const planned of task.plan) {
      if (!("tool" in planned)) continue;
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
        args: planned.args,
        expectError: planned.expectError ?? null,
        error: errorCodeOf(result.isError === true, text),
        bytes: Buffer.byteLength(text, "utf8"),
        ms,
        text,
      });
    }
    const unexpected = steps.some(
      (step) => step.error !== null && step.error !== step.expectError,
    );
    const absent = steps.some(
      (step) => step.expectError !== null && step.error !== step.expectError,
    );
    const evidence = new Evidence(
      steps.filter((step) => step.error === null).map((step) => step.text),
    );
    const missing = missingFrom(task.answer, evidence);
    const computes = task.plan.some((planned) => "compute" in planned);
    const outcome: BaselineOutcome = unexpected
      ? "unexpectedError"
      : absent
        ? "missingError"
        : task.answer.kind === "refusal"
          ? "refusalPlan"
          : missing.length === 0
            ? "answered"
            : computes
              ? "needsCompute"
              : "answerMissing";
    const result: TaskBaseline = {
      id: task.id,
      level: task.level,
      knowledge: task.knowledge,
      outcome,
      calls: steps.length,
      bytes: steps.reduce((sum, step) => sum + step.bytes, 0),
      ms: steps.reduce((sum, step) => sum + step.ms, 0),
      missing,
      steps,
    };
    results.push(result);
    onTask?.(result);
  }
  await client.close();
  await server.close();
  return results;
}
