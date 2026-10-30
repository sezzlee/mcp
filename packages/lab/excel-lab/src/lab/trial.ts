import { mkdir } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import {
  toolSpecsOf,
  type RunRecord,
  type TrialEvent,
} from "../agent/agent-run.ts";
import {
  assistantMessage,
  budgetNotice,
  HostRequestError,
  type ChatMessage,
  type ChatResult,
  type ModelHost,
  type ThinkingPolicy,
} from "../agent/host.ts";
import { openSession, type Session, type ToolOutcome } from "./session.ts";
import { scriptedEdit } from "./scripted-edit.ts";
import {
  type Termination,
  artifactSchema,
  type finalAnswerSchema,
  type repeatedErrorSchema,
} from "./diagnostics.ts";
import { z } from "zod";

export type Language = "tr" | "en";
export type Mode = "scripted" | "model";

export const finalizationPolicies = ["unchanged", "reserve_last"] as const;
export type FinalizationPolicy = (typeof finalizationPolicies)[number];

export interface ModelPolicy {
  readonly catalog: readonly string[];
  readonly requests: number;
  readonly calls: number;
  readonly window: number;
  readonly numPredict: number | null;
  readonly timeoutMs: number;
  readonly thinking: ThinkingPolicy;
  readonly think?: boolean | string;
}

export interface Fixtures {
  readonly corpus: string | undefined;
  readonly readingWorkspace?: string;
}

export interface Brief {
  readonly system: string;
  readonly user: string;
}

export interface Graded {
  readonly output?: { readonly filePath: string; readonly versionId: string };
}

export interface ScenarioSpec<Context, State> {
  readonly id: string;
  readonly scriptedLanguages: readonly Language[];
  readonly policy: ModelPolicy;
  setup(
    session: Session,
    language: Language,
    fixtures: Fixtures,
  ): Promise<Context>;
  brief(context: Context, language: Language): Brief;
  start(context: Context): State;
  observe(state: State, outcome: ToolOutcome, context: Context): void;
  scripted(
    call: (
      name: string,
      args: Readonly<Record<string, unknown>>,
    ) => Promise<ToolOutcome>,
    context: Context,
    state: State,
    language: Language,
  ): Promise<string>;
  afterTurn?(
    state: State,
    context: Context,
    session: Session,
  ): Promise<"continue" | "stop">;
  remind?(state: State, language: Language): string | undefined;
  answering?(state: State): boolean;
  grade(input: {
    readonly session: Session;
    readonly context: Context;
    readonly state: State;
    readonly mode: Mode;
    readonly language: Language;
    readonly final: string;
  }): Promise<Graded>;
}

export interface CallCounts {
  readonly requested: number;
  readonly dispatched: number;
  readonly refusedCatalog: number;
  readonly refusedBudget: number;
}

export interface TrialRecord {
  readonly id: string;
  readonly mode: Mode;
  readonly language: Language;
  readonly passed: boolean;
  readonly failure: string | null;
  readonly turns: number;
  readonly calls: CallCounts;
  readonly output: Graded["output"] | null;
  readonly final: string;
  readonly ms: number;
  readonly directory: string;
  readonly termination?: Termination;
  readonly artifact?: z.infer<typeof artifactSchema>;
  readonly finalAnswer?: z.infer<typeof finalAnswerSchema>;
  readonly repeatedErrors?: readonly z.infer<typeof repeatedErrorSchema>[];
}

export interface TrialInput {
  readonly mode: Mode;
  readonly language: Language;
  readonly directory: string;
  readonly fixtures: Fixtures;
  readonly host?: ModelHost;
  readonly answerHost?: ModelHost;
  readonly temperature?: number;
  readonly retryDelayMs?: number;
  readonly manifestHash?: string;
  readonly repetition?: number;
  readonly onRunRecord?: (record: RunRecord) => Promise<void>;
  readonly onEvent?: (event: TrialEvent) => Promise<void>;
  readonly condition?: Condition;
}

/** Run axes for catalog, context, reasoning history and finalization. */
export interface Condition {
  readonly hide?: readonly string[];
  readonly window?: number;
  readonly thinking?: ThinkingPolicy;
  readonly finalization?: FinalizationPolicy;
}

/** A scenario's catalog and window under a condition. */
export function underCondition(
  policy: ModelPolicy,
  condition: Condition | undefined,
): { readonly catalog: readonly string[]; readonly window: number } {
  return {
    catalog: policy.catalog.filter(
      (name) => !(condition?.hide ?? []).includes(name),
    ),
    window: condition?.window ?? policy.window,
  };
}

export interface LabScenario {
  readonly id: string;
  readonly scriptedLanguages: readonly Language[];
  readonly policy: ModelPolicy;
  run(input: TrialInput): Promise<TrialRecord>;
}

export const notOffered = "Not run: this tool is not offered in this task.";

const finalizationNotice =
  "The tool phase is finished within the original request budget. Use the tool results already in this conversation to provide the task's requested final answer now. No tools are available in this request. If work is incomplete, state the specific blocker and what remains unfinished; do not claim a missing result or disclosure was completed.";

/**
 * Requests one reply, retrying a dropped connection up to three attempts and
 * a timeout once, as the reading runner does; a context, malformed or fatal
 * failure ends the trial.
 */
async function reply(
  host: ModelHost,
  request: Parameters<ModelHost["chat"]>[0],
  retryDelayMs: number,
): Promise<ChatResult> {
  let timeouts = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await host.chat(request);
    } catch (error) {
      if (!(error instanceof HostRequestError)) throw error;
      if (error.failure === "timeout") timeouts += 1;
      if (
        error.failure === "context" ||
        error.failure === "malformed" ||
        error.failure === "fatal" ||
        attempt >= 3 ||
        timeouts >= 2
      )
        throw error;
      await wait(retryDelayMs);
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureOf(error: unknown): string {
  if (!(error instanceof HostRequestError)) return message(error);
  return error.failure === "malformed"
    ? `The model sent a malformed tool call: ${error.message}`
    : `host: ${error.failure}: ${error.message}`;
}

/**
 * Why a model trial ended with no final answer, or null when it has one or
 * the scenario stopped it on purpose. Guard: grading an empty answer reports
 * the first claim it lacks, which hides that the window, the request budget
 * or the output limit ended the trial.
 */
function silence(input: {
  readonly final: string;
  readonly last: ChatResult | null;
  readonly stopped: boolean;
  readonly spent: boolean;
}): string | null {
  if (input.final.trim() !== "" || input.stopped) return null;
  if (input.last?.kind === "reply" && input.last.doneReason === "length")
    return "the output limit ended the reply";
  return input.spent ? "every request was spent" : "the reply was empty";
}

/**
 * Binds a scenario's own context and state types into one runnable trial.
 * @param spec the scenario's fixture, brief, scripted plan, model rules and grading
 */
export function defineScenario<Context, State>(
  spec: ScenarioSpec<Context, State>,
): LabScenario {
  const policy = {
    ...spec.policy,
    catalog:
      spec.policy.catalog.includes("edit_workbook") &&
      !spec.policy.catalog.includes("prepare_edit")
        ? [...spec.policy.catalog, "prepare_edit"]
        : spec.policy.catalog,
  };
  return {
    id: spec.id,
    scriptedLanguages: spec.scriptedLanguages,
    policy,
    async run(input) {
      const started = performance.now();
      await mkdir(input.directory, { recursive: true });
      const session = await openSession(input.directory);
      let turns = 0;
      const counts = {
        requested: 0,
        dispatched: 0,
        refusedCatalog: 0,
        refusedBudget: 0,
      };
      let final = "";
      let last: ChatResult | null = null;
      let stopped = false;
      let failure: string | null = null;
      let output: Graded["output"] | null = null;
      let termination: Termination = "completed";
      let grading = false;
      let outputProduced = false;
      const outputReceipt = z.object({
        kind: z.literal("complete"),
        version: artifactSchema.options[0].shape.output.optional(),
        outputs: z
          .array(z.object({ version: artifactSchema.options[0].shape.output }))
          .optional(),
      });
      try {
        const context = await spec.setup(
          session,
          input.language,
          input.fixtures,
        );
        const state = spec.start(context);
        const call = async (
          name: string,
          args: Readonly<Record<string, unknown>>,
        ): Promise<ToolOutcome> => {
          const outcome = await session.call(name, args);
          const receipt = outputReceipt.safeParse(outcome.body);
          if (
            !outcome.isError &&
            receipt.success &&
            (receipt.data.version !== undefined ||
              (receipt.data.outputs?.length ?? 0) > 0)
          )
            outputProduced = true;
          spec.observe(state, outcome, context);
          return outcome;
        };
        if (input.mode === "scripted") {
          const scriptedCall = (
            name: string,
            args: Readonly<Record<string, unknown>>,
          ) => {
            counts.requested += 1;
            counts.dispatched += 1;
            return call(name, args);
          };
          final = await spec.scripted(
            (name, args) =>
              name === "edit_workbook" && args["preparationId"] === undefined
                ? scriptedEdit(scriptedCall, args)
                : scriptedCall(name, args),
            context,
            state,
            input.language,
          );
        } else {
          if (input.host === undefined)
            throw new Error("A model trial needs a host.");
          const { catalog, window } = underCondition(policy, input.condition);
          const offered = (await toolSpecsOf(session.client)).filter((tool) =>
            catalog.includes(tool.function.name),
          );
          await session.trace({ offered: offered.map((t) => t.function.name) });
          const brief = spec.brief(context, input.language);
          const messages: ChatMessage[] = [
            { role: "system", content: brief.system },
            { role: "user", content: brief.user },
          ];
          const reserveFinal = input.condition?.finalization === "reserve_last";
          let finalizationReason:
            "request_budget" | "call_budget" | "empty_reply" | undefined;
          while (turns < policy.requests) {
            turns += 1;
            if (reserveFinal && finalizationReason === undefined) {
              if (turns === policy.requests)
                finalizationReason = "request_budget";
              else if (counts.dispatched >= policy.calls)
                finalizationReason = "call_budget";
            }
            const finalizing = reserveFinal && finalizationReason !== undefined;
            if (finalizing) {
              messages.push({ role: "user", content: finalizationNotice });
              await session.trace({
                phase: "final_answer",
                request: turns,
                reason: finalizationReason,
                offered: [],
              });
            }
            const host =
              (spec.answering?.(state) === true
                ? input.answerHost
                : undefined) ?? input.host;
            const result = await reply(
              host,
              {
                messages,
                tools: finalizing ? [] : offered,
                window,
                temperature: input.temperature ?? 0,
                timeoutMs: policy.timeoutMs,
                numPredict: policy.numPredict,
              },
              input.retryDelayMs ?? 30_000,
            );
            await session.trace({ request: turns, result });
            last = result;
            if (result.kind !== "reply") {
              termination = "context_preflight";
              throw new Error("Model preflight refused the request.");
            }
            messages.push(
              assistantMessage({
                ...result,
                policy: input.condition?.thinking ?? policy.thinking,
              }),
            );
            if (result.toolCalls.length === 0) {
              final = result.content;
              if (finalizing) break;
              if (
                reserveFinal &&
                final.trim() === "" &&
                outputProduced &&
                turns < policy.requests
              ) {
                finalizationReason = "empty_reply";
                continue;
              }
              const reminder = spec.remind?.(state, input.language);
              if (reminder === undefined) break;
              messages.push({ role: "user", content: reminder });
              continue;
            }
            for (const toolCall of result.toolCalls) {
              counts.requested += 1;
              const name = toolCall.function.name;
              let content: string;
              if (finalizing || !catalog.includes(name)) {
                counts.refusedCatalog += 1;
                content = notOffered;
                await session.trace({ refused: "catalog", tool: name });
              } else if (counts.dispatched >= policy.calls) {
                counts.refusedBudget += 1;
                content = budgetNotice;
                await session.trace({ refused: "budget", tool: name });
              } else {
                counts.dispatched += 1;
                content = (await call(name, toolCall.function.arguments)).text;
              }
              messages.push({ role: "tool", tool_name: name, content });
            }
            if (finalizing) break;
            if ((await spec.afterTurn?.(state, context, session)) === "stop") {
              stopped = true;
              break;
            }
          }
        }
        grading = true;
        const graded = await spec
          .grade({
            session,
            context,
            state,
            mode: input.mode,
            language: input.language,
            final,
          })
          .catch((error: unknown) => {
            const why =
              input.mode === "model"
                ? silence({
                    final,
                    last,
                    stopped,
                    spent: turns >= spec.policy.requests,
                  })
                : null;
            throw why === null
              ? error
              : new Error(`No final answer: ${why}. ${message(error)}`);
          });
        output = graded.output ?? null;
      } catch (error) {
        failure = failureOf(error);
        if (error instanceof HostRequestError)
          termination =
            error.failure === "malformed"
              ? "malformed_tool_call"
              : error.failure === "context"
                ? "context_preflight"
                : error.failure === "timeout"
                  ? "timeout"
                  : "host_failure";
        else if (termination === "completed")
          termination =
            last?.kind === "reply" && last.doneReason === "length"
              ? "output_limit"
              : final.trim() === "" &&
                  (counts.refusedBudget > 0 ||
                    counts.dispatched >= policy.calls)
                ? "call_budget"
                : input.mode === "model" &&
                    final.trim() === "" &&
                    turns >= policy.requests
                  ? "request_budget"
                  : input.mode === "model" && final.trim() === ""
                    ? "empty_reply"
                    : grading && session.verifiedOutput !== undefined
                      ? "final_answer_failure"
                      : grading
                        ? "oracle_failure"
                        : "scenario_failure";
        output = session.verifiedOutput ?? output;
      } finally {
        await session.close();
      }
      return {
        id: spec.id,
        mode: input.mode,
        language: input.language,
        passed: failure === null,
        failure,
        turns,
        calls: counts,
        output,
        final,
        ms: Math.round(performance.now() - started),
        directory: input.directory,
        termination,
        artifact:
          session.verifiedOutput !== undefined
            ? { status: "passed", output: session.verifiedOutput }
            : output !== null
              ? { status: "passed", output }
              : grading && failure !== null
                ? { status: "failed" }
                : outputProduced
                  ? { status: "not_verified" }
                  : failure === null
                    ? { status: "not_applicable" }
                    : { status: "not_produced" },
        finalAnswer:
          input.mode === "scripted" || stopped
            ? "not_required"
            : final.trim() === ""
              ? "missing"
              : failure === null
                ? "passed"
                : session.verifiedOutput === undefined
                  ? "not_evaluated"
                  : "failed",
        repeatedErrors: session.repeatedErrors,
      };
    },
  };
}
