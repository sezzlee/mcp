import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { Client } from "@modelcontextprotocol/client";
import { gradeSubmission, submitTool, type Grade } from "./grade.ts";
import {
  assistantMessage,
  budgetNotice,
  HostRequestError,
  type ChatMessage,
  type ChatResult,
  type ModelHost,
  type ThinkingPolicy,
  type ToolSpec,
  type Usage,
} from "./host.ts";
import { estimateTokens } from "./ollama.ts";
import type { Catalog, Language, Task } from "./task.ts";

export const systemPrompt = [
  "You answer questions about spreadsheet and CSV files using the tools provided.",
  "Files the user attached are listed in their message; other files can be found with the tools.",
  "Use only the calls you need. Read values from the tools rather than guessing them.",
  "When you know the answer, call submit_answer exactly once with it. If the files cannot answer the question, call submit_answer with a refusal and its reason.",
].join(" ");

export type RunOutcome =
  | "answered"
  | "noAnswer"
  | "callBudget"
  | "preflightRefused"
  | "providerContextError"
  | "hostError"
  | "interrupted";

export interface CallMetric {
  readonly tool: string;
  readonly args: unknown;
  readonly error: string | null;
  readonly bytes: number;
  readonly ms: number;
}

export interface RunRecord {
  readonly trialId: string;
  readonly manifestHash: string;
  readonly taskRevision: string;
  readonly repetition: number;
  readonly task: string;
  readonly level: Task["level"];
  readonly knowledge: Task["knowledge"];
  readonly language: Language;
  readonly model: string;
  readonly window: number;
  readonly loadedWindow: number | null;
  readonly outcome: RunOutcome;
  readonly failure: string | null;
  readonly correct: boolean;
  readonly grade: Grade | null;
  readonly submission: unknown;
  readonly budgetReached: boolean;
  readonly calls: number;
  readonly idealCalls: number;
  readonly privilegedCalls: number;
  readonly excessCalls: number;
  readonly responseBytes: number;
  readonly toolErrors: Readonly<Record<string, number>>;
  readonly invalidArgs: number;
  readonly recoveryCalls: number;
  readonly requests: number;
  readonly failedRequests: number;
  readonly toolSchemaTokens: number;
  readonly peakInputTokens: number | null;
  readonly peakEstimatedTokens: number;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly requestsWithoutUsage: number;
  readonly windowUse: number | null;
  readonly ms: number;
  readonly trace: readonly ChatMessage[];
  readonly callLog: readonly CallMetric[];
}

export interface TrialKey {
  readonly task: string;
  readonly taskRevision: string;
  readonly language: Language;
  readonly repetition: number;
}

type EventBody =
  | { readonly kind: "trialStarted"; readonly key: TrialKey }
  | {
      readonly kind: "requestFinished";
      readonly request: number;
      readonly estimatedTokens: number;
      readonly usage: Usage | null;
      readonly toolCalls: number;
      readonly thinkingChars: number;
      readonly ms: number;
    }
  | {
      readonly kind: "requestFailed";
      readonly request: number;
      readonly attempt: number;
      readonly failure: string;
      readonly error: string;
    }
  | {
      readonly kind: "toolFinished";
      readonly call: number;
      readonly tool: string;
      readonly args: unknown;
      readonly result: unknown;
      readonly ms: number;
    }
  | { readonly kind: "submitted"; readonly raw: unknown }
  | { readonly kind: "trialFinished"; readonly outcome: RunOutcome };

export type TrialEvent = EventBody & {
  readonly trialId: string;
  readonly at: string;
  readonly elapsedMs: number;
};

/** A stable digest of a task's own definition, so a changed task is a different trial. */
export function taskRevision(task: Task): string {
  return createHash("sha256").update(JSON.stringify(task)).digest("hex");
}

/** The id a trial keeps across resumes: the manifest it ran under and its key. */
export function trialIdOf(manifestHash: string, key: TrialKey): string {
  return createHash("sha256")
    .update(JSON.stringify([manifestHash, key]))
    .digest("hex")
    .slice(0, 24);
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

const reminders: Readonly<
  Record<Language, { submit: string; budget: string }>
> = {
  tr: {
    submit: "Cevabını submit_answer aracıyla gönder.",
    budget:
      "Araç çağrısı hakkın bitti. Bildiklerinle cevabını şimdi submit_answer aracıyla gönder.",
  },
  en: {
    submit: "Submit your answer with the submit_answer tool.",
    budget:
      "Your tool calls are used up. Submit your answer now with the submit_answer tool, from what you know.",
  },
};

type Requested =
  | { readonly kind: "result"; readonly result: ChatResult }
  | {
      readonly kind: "failed";
      readonly failure: "context" | "host" | "interrupted";
      readonly error: string;
    };

/**
 * Runs one task once: the model sees the system prompt, the question with its
 * attachments and the server's tools, and ends by calling `submit_answer`.
 *
 * Guard: a failed request is retried on its own, never by restarting the
 * task, and every failed attempt is reported as an event, so a run's cost and
 * trace include what a flaky host consumed.
 *
 * Guard: the call budget is checked per call, inside a batch too, and a run
 * that spends it gets one last request offering `submit_answer` alone, so the
 * budget censors the run instead of discarding an answer it already has.
 */
export async function runTask(input: {
  readonly task: Task;
  readonly key: TrialKey;
  readonly trialId: string;
  readonly manifestHash: string;
  readonly language: Language;
  readonly catalog: Catalog;
  readonly host: ModelHost;
  readonly client: Client;
  readonly tools: readonly ToolSpec[];
  readonly window: number;
  readonly temperature: number;
  readonly thinking: ThinkingPolicy;
  readonly callBudget: number;
  readonly timeoutMs: number;
  readonly numPredict: number | null;
  readonly retryDelayMs: number;
  /** Wall-clock time a request may outlast its monotonic time before the machine is taken to have slept. */
  readonly sleepGapMs?: number;
  readonly onEvent: (event: TrialEvent) => Promise<void>;
}): Promise<RunRecord> {
  const { task, language, host, client, window } = input;
  const started = performance.now();
  const emit = (body: EventBody): Promise<void> =>
    input.onEvent({
      ...body,
      trialId: input.trialId,
      at: new Date().toISOString(),
      elapsedMs: performance.now() - started,
    });
  const submit = submitTool(task.answer);
  const tools = [...input.tools, submit];
  const toolSchemaTokens = estimateTokens(JSON.stringify(tools));
  const trace: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage(task, language, input.catalog) },
  ];
  const callLog: CallMetric[] = [];
  const toolErrors: Record<string, number> = {};
  const usages: (Usage | null)[] = [];
  let invalidArgs = 0;
  let failedRequests = 0;
  let reminded = false;
  let budgetReached = false;
  let finalTurn = false;
  let peakEstimatedTokens = 0;
  let loadedWindow: number | null = null;
  let submission: unknown = null;
  let outcome: RunOutcome = "noAnswer";
  let failure: string | null = null;
  await emit({ kind: "trialStarted", key: input.key });

  /**
   * Guard: the monotonic clock stops while the machine sleeps and the wall
   * clock does not, so a gap between them means the request overlapped a
   * sleep. Its failure says nothing about the host, and its retries would
   * spend themselves against a network that is not there, so the trial is
   * closed as interrupted for a resume to run again.
   */
  const slept = (wall: number, monotonic: number): boolean =>
    Date.now() - wall - (performance.now() - monotonic) >
    (input.sleepGapMs ?? 30_000);

  const request = async (offered: readonly ToolSpec[]): Promise<Requested> => {
    const index = usages.length + 1;
    let timeouts = 0;
    for (let attempt = 1; ; attempt += 1) {
      const wall = Date.now();
      const monotonic = performance.now();
      try {
        return {
          kind: "result",
          result: await host.chat({
            messages: trace,
            tools: offered,
            window,
            temperature: input.temperature,
            timeoutMs: input.timeoutMs,
            numPredict: input.numPredict,
          }),
        };
      } catch (error) {
        if (!(error instanceof HostRequestError)) throw error;
        failedRequests += 1;
        const interrupted = slept(wall, monotonic);
        await emit({
          kind: "requestFailed",
          request: index,
          attempt,
          failure: interrupted ? "interrupted" : error.failure,
          error: error.message,
        });
        if (interrupted)
          return {
            kind: "failed",
            failure: "interrupted",
            error: error.message,
          };
        if (error.failure === "context")
          return { kind: "failed", failure: "context", error: error.message };
        if (error.failure === "timeout") timeouts += 1;
        if (error.failure === "fatal" || attempt >= 3 || timeouts >= 2)
          return { kind: "failed", failure: "host", error: error.message };
        await wait(input.retryDelayMs);
      }
    }
  };

  while (submission === null) {
    const lastChance = finalTurn;
    const requested = await request(lastChance ? [submit] : tools);
    if (requested.kind === "failed") {
      outcome =
        requested.failure === "context"
          ? "providerContextError"
          : requested.failure === "interrupted"
            ? "interrupted"
            : "hostError";
      failure = requested.error;
      break;
    }
    const reply = requested.result;
    peakEstimatedTokens = Math.max(peakEstimatedTokens, reply.estimatedTokens);
    if (reply.kind === "preflightRefused") {
      outcome = "preflightRefused";
      break;
    }
    usages.push(reply.usage);
    if (usages.length === 1) loadedWindow = await host.loadedWindow();
    await emit({
      kind: "requestFinished",
      request: usages.length,
      estimatedTokens: reply.estimatedTokens,
      usage: reply.usage,
      toolCalls: reply.toolCalls.length,
      thinkingChars: reply.thinking.length,
      ms: reply.ms,
    });
    trace.push(
      assistantMessage({
        content: reply.content,
        thinking: reply.thinking,
        toolCalls: reply.toolCalls,
        policy: input.thinking,
      }),
    );
    if (reply.toolCalls.length === 0) {
      if (lastChance) {
        outcome = "callBudget";
        break;
      }
      if (reminded) break;
      reminded = true;
      trace.push({ role: "user", content: reminders[language].submit });
      continue;
    }
    for (const call of reply.toolCalls) {
      const name = call.function.name;
      if (name === "submit_answer") {
        submission = call.function.arguments;
        outcome = "answered";
        await emit({ kind: "submitted", raw: submission });
        break;
      }
      if (callLog.length >= input.callBudget) {
        budgetReached = true;
        trace.push({
          role: "tool",
          content: budgetNotice,
          tool_name: name,
        });
        continue;
      }
      const callStarted = performance.now();
      let text: string;
      let error: string | null;
      let result: unknown = null;
      if (!input.tools.some((tool) => tool.function.name === name)) {
        text = `Unknown tool ${name}.`;
        error = "unknown_tool";
      } else {
        const called = await client.callTool({
          name,
          arguments: call.function.arguments,
        });
        result = called;
        text = called.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n");
        error = errorCodeOf(called.isError === true, text);
      }
      const ms = performance.now() - callStarted;
      if (error === "invalid_arguments" || error === "unknown_tool")
        invalidArgs += 1;
      else if (error !== null) toolErrors[error] = (toolErrors[error] ?? 0) + 1;
      callLog.push({
        tool: name,
        args: call.function.arguments,
        error,
        bytes: Buffer.byteLength(text, "utf8"),
        ms,
      });
      await emit({
        kind: "toolFinished",
        call: callLog.length,
        tool: name,
        args: call.function.arguments,
        result,
        ms,
      });
      trace.push({ role: "tool", content: text, tool_name: name });
    }
    if (submission === null && lastChance) {
      outcome = "callBudget";
      break;
    }
    if (submission === null && budgetReached) {
      finalTurn = true;
      trace.push({ role: "user", content: reminders[language].budget });
    }
  }
  await emit({ kind: "trialFinished", outcome });

  const graded = gradeSubmission(task.answer, submission);
  const firstError = callLog.findIndex((call) => call.error !== null);
  const recovered =
    firstError < 0
      ? -1
      : callLog.findIndex((call, at) => at > firstError && call.error === null);
  const idealCalls = task.plan.steps.length;
  const known = usages.filter((usage): usage is Usage => usage !== null);
  const complete = known.length === usages.length && usages.length > 0;
  const peakInputTokens =
    known.length === 0 ? null : Math.max(...known.map((usage) => usage.input));
  const total = (pick: (usage: Usage) => number): number | null =>
    complete ? known.reduce((sum, usage) => sum + pick(usage), 0) : null;
  return {
    trialId: input.trialId,
    manifestHash: input.manifestHash,
    taskRevision: input.key.taskRevision,
    repetition: input.key.repetition,
    task: task.id,
    level: task.level,
    knowledge: task.knowledge,
    language,
    model: host.model,
    window,
    loadedWindow,
    outcome,
    failure,
    correct: graded?.correct ?? false,
    grade: graded,
    submission,
    budgetReached,
    calls: callLog.length,
    idealCalls,
    privilegedCalls: task.plan.steps.filter((step) => step.role === "answer")
      .length,
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
    requests: usages.length,
    failedRequests,
    toolSchemaTokens,
    peakInputTokens,
    peakEstimatedTokens,
    inputTokens: total((usage) => usage.input),
    cachedInputTokens: total((usage) => usage.cachedInput),
    outputTokens: total((usage) => usage.output),
    requestsWithoutUsage: usages.length - known.length,
    windowUse: peakInputTokens === null ? null : peakInputTokens / window,
    ms: performance.now() - started,
    trace,
    callLog,
  };
}
