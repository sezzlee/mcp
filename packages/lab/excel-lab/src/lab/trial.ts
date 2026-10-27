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

export type Language = "tr" | "en";
export type Mode = "scripted" | "model";

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
}

export interface LabScenario {
  readonly id: string;
  readonly scriptedLanguages: readonly Language[];
  readonly policy: ModelPolicy;
  run(input: TrialInput): Promise<TrialRecord>;
}

export const notOffered = "Not run: this tool is not offered in this task.";

/**
 * Requests one reply, retrying a dropped connection up to three attempts and
 * a timeout once, as the reading runner does; a context or fatal failure
 * ends the trial.
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

/**
 * Binds a scenario's own context and state types into one runnable trial.
 * @param spec the scenario's fixture, brief, scripted plan, model rules and grading
 */
export function defineScenario<Context, State>(
  spec: ScenarioSpec<Context, State>,
): LabScenario {
  return {
    id: spec.id,
    scriptedLanguages: spec.scriptedLanguages,
    policy: spec.policy,
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
      let failure: string | null = null;
      let output: Graded["output"] | null = null;
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
          spec.observe(state, outcome, context);
          return outcome;
        };
        if (input.mode === "scripted")
          final = await spec.scripted(
            (name, args) => {
              counts.requested += 1;
              counts.dispatched += 1;
              return call(name, args);
            },
            context,
            state,
            input.language,
          );
        else {
          if (input.host === undefined)
            throw new Error("A model trial needs a host.");
          const { policy } = spec;
          const offered = (await toolSpecsOf(session.client)).filter((tool) =>
            policy.catalog.includes(tool.function.name),
          );
          await session.trace({ offered: offered.map((t) => t.function.name) });
          const brief = spec.brief(context, input.language);
          const messages: ChatMessage[] = [
            { role: "system", content: brief.system },
            { role: "user", content: brief.user },
          ];
          while (turns < policy.requests) {
            turns += 1;
            const host =
              (spec.answering?.(state) === true
                ? input.answerHost
                : undefined) ?? input.host;
            const result = await reply(
              host,
              {
                messages,
                tools: offered,
                window: policy.window,
                temperature: input.temperature ?? 0,
                timeoutMs: policy.timeoutMs,
                numPredict: policy.numPredict,
              },
              input.retryDelayMs ?? 30_000,
            );
            await session.trace({ request: turns, result });
            if (result.kind !== "reply")
              throw new Error("Model preflight refused the request.");
            messages.push(
              assistantMessage({ ...result, policy: policy.thinking }),
            );
            if (result.toolCalls.length === 0) {
              final = result.content;
              const reminder = spec.remind?.(state, input.language);
              if (reminder === undefined) break;
              messages.push({ role: "user", content: reminder });
              continue;
            }
            for (const toolCall of result.toolCalls) {
              counts.requested += 1;
              const name = toolCall.function.name;
              let content: string;
              if (!policy.catalog.includes(name)) {
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
            if ((await spec.afterTurn?.(state, context, session)) === "stop")
              break;
          }
        }
        output =
          (
            await spec.grade({
              session,
              context,
              state,
              mode: input.mode,
              language: input.language,
              final,
            })
          ).output ?? null;
      } catch (error) {
        failure = message(error);
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
      };
    },
  };
}
