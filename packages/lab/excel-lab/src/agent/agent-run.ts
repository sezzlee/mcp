import type { Client } from "@modelcontextprotocol/client";
import { gradeSubmission, submitTool, type Grade } from "./grade.ts";
import {
  estimateTokens,
  type ChatMessage,
  type OllamaHost,
  type ToolSpec,
} from "./ollama.ts";
import type { Catalog, Language, Task } from "./task.ts";

export const systemPrompt = [
  "You answer questions about spreadsheet and CSV files using the tools provided.",
  "Files the user attached are listed in their message; other files can be found with the tools.",
  "Use only the calls you need. Read values from the tools rather than guessing them.",
  "When you know the answer, call submit_answer exactly once with it. If the files cannot answer the question, call submit_answer with a refusal and its reason.",
].join(" ");

export type RunOutcome =
  "answered" | "noAnswer" | "callBudget" | "contextExceeded" | "hostError";

export interface CallMetric {
  readonly tool: string;
  readonly args: unknown;
  readonly error: string | null;
  readonly bytes: number;
}

export interface RunRecord {
  readonly task: string;
  readonly level: Task["level"];
  readonly knowledge: Task["knowledge"];
  readonly language: Language;
  readonly model: string;
  readonly window: number;
  readonly loadedWindow: number | null;
  readonly outcome: RunOutcome;
  readonly correct: boolean;
  readonly grade: Grade | null;
  readonly hostFailure?: string;
  readonly submission: unknown;
  readonly calls: number;
  readonly idealCalls: number;
  readonly excessCalls: number;
  readonly responseBytes: number;
  readonly toolErrors: Readonly<Record<string, number>>;
  readonly invalidArgs: number;
  readonly recoveryCalls: number;
  readonly requests: number;
  readonly toolSchemaTokens: number;
  readonly peakInputTokens: number | null;
  readonly peakEstimatedTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly windowUse: number | null;
  readonly ms: number;
  readonly trace: readonly ChatMessage[];
  readonly callLog: readonly CallMetric[];
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
    return "invalid_arguments";
  }
  return "invalid_arguments";
}

/** Converts the server's `tools/list` into the host's tool format, unchanged. */
export async function toolSpecsOf(
  client: Client,
): Promise<readonly ToolSpec[]> {
  const listed = await client.listTools();
  return listed.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema,
    },
  }));
}

function userMessage(task: Task, language: Language, catalog: Catalog): string {
  const question = task.question[language];
  if (task.knowledge === "K0") return question;
  const attached = task.files.map(
    (file) => `- ${catalog.files[file]?.as ?? file}`,
  );
  const label = language === "tr" ? "Ekli dosyalar" : "Attached files";
  return `${question}\n\n${label}:\n${attached.join("\n")}`;
}

/**
 * Runs one task once: the model sees the system prompt, the question with its
 * attachments and the server's tools, and ends by calling `submit_answer`.
 */
export async function runTask(input: {
  readonly task: Task;
  readonly language: Language;
  readonly catalog: Catalog;
  readonly host: OllamaHost;
  readonly client: Client;
  readonly tools: readonly ToolSpec[];
  readonly window: number;
  readonly temperature: number;
  readonly callBudget: number;
  readonly timeoutMs: number;
}): Promise<RunRecord> {
  const { task, language, host, client, window } = input;
  const tools = [...input.tools, submitTool(task.answer)];
  const toolSchemaTokens = estimateTokens(JSON.stringify(tools));
  const trace: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage(task, language, input.catalog) },
  ];
  const callLog: CallMetric[] = [];
  const toolErrors: Record<string, number> = {};
  let invalidArgs = 0;
  let requests = 0;
  let reminded = false;
  let peakInputTokens: number | null = null;
  let peakEstimatedTokens = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let loadedWindow: number | null = null;
  let submission: unknown = null;
  let outcome: RunOutcome = "noAnswer";
  const started = performance.now();

  while (outcome === "noAnswer" && submission === null) {
    if (callLog.length >= input.callBudget) {
      outcome = "callBudget";
      break;
    }
    const reply = await host.chat({
      messages: trace,
      tools,
      window,
      temperature: input.temperature,
      timeoutMs: input.timeoutMs,
    });
    if (reply.kind === "contextExceeded") {
      peakEstimatedTokens = Math.max(
        peakEstimatedTokens,
        reply.estimatedTokens,
      );
      outcome = "contextExceeded";
      break;
    }
    requests += 1;
    if (requests === 1) loadedWindow = await host.loadedWindow();
    peakEstimatedTokens = Math.max(peakEstimatedTokens, reply.estimatedTokens);
    if (reply.inputTokens !== null) {
      peakInputTokens = Math.max(peakInputTokens ?? 0, reply.inputTokens);
      inputTokens += reply.inputTokens;
    }
    cachedInputTokens += reply.cachedInputTokens ?? 0;
    outputTokens += reply.outputTokens ?? 0;
    trace.push({
      role: "assistant",
      content: reply.content,
      ...(reply.toolCalls.length === 0 ? {} : { tool_calls: reply.toolCalls }),
    });
    if (reply.toolCalls.length === 0) {
      if (reminded) break;
      reminded = true;
      trace.push({
        role: "user",
        content:
          language === "tr"
            ? "Cevabını submit_answer aracıyla gönder."
            : "Submit your answer with the submit_answer tool.",
      });
      continue;
    }
    for (const call of reply.toolCalls) {
      const name = call.function.name;
      if (name === "submit_answer") {
        submission = call.function.arguments;
        outcome = "answered";
        break;
      }
      let text: string;
      let error: string | null;
      if (!input.tools.some((tool) => tool.function.name === name)) {
        text = `Unknown tool ${name}.`;
        error = "unknown_tool";
      } else {
        const result = await client.callTool({
          name,
          arguments: call.function.arguments,
        });
        text = result.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n");
        error = errorCodeOf(result.isError === true, text);
      }
      if (error === "invalid_arguments" || error === "unknown_tool")
        invalidArgs += 1;
      else if (error !== null) toolErrors[error] = (toolErrors[error] ?? 0) + 1;
      callLog.push({
        tool: name,
        args: call.function.arguments,
        error,
        bytes: Buffer.byteLength(text, "utf8"),
      });
      trace.push({ role: "tool", content: text, tool_name: name });
    }
  }

  const graded = gradeSubmission(task.answer, submission);
  const firstError = callLog.findIndex((call) => call.error !== null);
  const recovered =
    firstError < 0
      ? -1
      : callLog.findIndex((call, at) => at > firstError && call.error === null);
  const idealCalls = task.plan.steps.length;
  return {
    task: task.id,
    level: task.level,
    knowledge: task.knowledge,
    language,
    model: host.model,
    window,
    loadedWindow,
    outcome,
    correct: graded?.correct ?? false,
    grade: graded,
    submission,
    calls: callLog.length,
    idealCalls,
    excessCalls: callLog.length - idealCalls,
    responseBytes: callLog.reduce((sum, call) => sum + call.bytes, 0),
    toolErrors,
    invalidArgs,
    recoveryCalls:
      firstError < 0
        ? 0
        : recovered < 0
          ? callLog.length - firstError
          : recovered - firstError,
    requests,
    toolSchemaTokens,
    peakInputTokens,
    peakEstimatedTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    windowUse: peakInputTokens === null ? null : peakInputTokens / window,
    ms: performance.now() - started,
    trace,
    callLog,
  };
}
