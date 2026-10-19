export interface ToolCall {
  readonly function: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  };
}

export type ChatMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly thinking?: string;
      readonly tool_calls?: readonly ToolCall[];
    }
  | {
      readonly role: "tool";
      readonly content: string;
      readonly tool_name: string;
    };

export interface ToolSpec {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolSpec[];
  readonly window: number;
  readonly temperature: number;
  readonly timeoutMs: number;
}

export interface Usage {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
}

export type ChatResult =
  | {
      readonly kind: "reply";
      readonly content: string;
      readonly thinking: string;
      readonly toolCalls: readonly ToolCall[];
      readonly estimatedTokens: number;
      readonly usage: Usage | null;
      readonly ms: number;
    }
  | { readonly kind: "preflightRefused"; readonly estimatedTokens: number };

export interface HostIdentity {
  readonly provider: string;
  readonly model: string;
  readonly digest: string | null;
  readonly version: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;
}

/** What a failed request means for the run: try again, the window was too small, or give up. */
export type HostFailure = "retryable" | "context" | "fatal";

export class HostRequestError extends Error {
  readonly failure: HostFailure;

  constructor(message: string, failure: HostFailure) {
    super(message);
    this.failure = failure;
  }
}

/** A model host the runner talks to; Ollama is the one implementation. */
export interface ModelHost {
  readonly model: string;
  identity(): Promise<HostIdentity>;
  chat(request: ChatRequest): Promise<ChatResult>;
  loadedWindow(): Promise<number | null>;
}

/** The tool message a call gets when the budget stopped it; it has no call log entry. */
export const budgetNotice = "Not run: the tool call budget is spent.";

/** The tool messages of a trace that answer a logged call, in call order. */
export function toolResponses(
  trace: readonly ChatMessage[],
): readonly string[] {
  return trace.flatMap((message) =>
    message.role === "tool" && message.content !== budgetNotice
      ? [message.content]
      : [],
  );
}

export const thinkingPolicies = ["product", "field", "drop"] as const;
export type ThinkingPolicy = (typeof thinkingPolicies)[number];

/**
 * The assistant message the next request carries for a reply.
 *
 * Guard: `product` is the default because the product's provider
 * (`ai-sdk-ollama` 4.3) sends reasoning back appended to the text with a
 * newline, never as Ollama's `thinking` field, and the lab measures what the
 * product does. `field` is Ollama's documented form and `drop` is what the
 * lab did before; both stay for an A/B.
 */
export function assistantMessage(input: {
  readonly content: string;
  readonly thinking: string;
  readonly toolCalls: readonly ToolCall[];
  readonly policy: ThinkingPolicy;
}): ChatMessage {
  const calls =
    input.toolCalls.length === 0 ? {} : { tool_calls: input.toolCalls };
  switch (input.policy) {
    case "product":
      return {
        role: "assistant",
        content: [input.content, input.thinking].filter(Boolean).join("\n"),
        ...calls,
      };
    case "field":
      return {
        role: "assistant",
        content: input.content,
        ...(input.thinking === "" ? {} : { thinking: input.thinking }),
        ...calls,
      };
    case "drop":
      return { role: "assistant", content: input.content, ...calls };
    default: {
      const exhaustive: never = input.policy;
      return exhaustive;
    }
  }
}
