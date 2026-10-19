import { z } from "zod";

const templateReserve = 256;

const toolCallSchema = z.object({
  function: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  }),
});

const chatChunkSchema = z.object({
  message: z
    .object({
      content: z.string().default(""),
      thinking: z.string().optional(),
      tool_calls: z.array(toolCallSchema).optional(),
    })
    .optional(),
  done: z.boolean().default(false),
  error: z.string().optional(),
  prompt_eval_count: z.int().optional(),
  prompt_eval_cached_count: z.int().optional(),
  eval_count: z.int().optional(),
  total_duration: z.int().optional(),
});

const runningSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      model: z.string().optional(),
      context_length: z.int().optional(),
    }),
  ),
});

export type ToolCall = z.infer<typeof toolCallSchema>;

export type ChatMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
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

export type ChatResult =
  | {
      readonly kind: "reply";
      readonly content: string;
      readonly toolCalls: readonly ToolCall[];
      readonly estimatedTokens: number;
      readonly inputTokens: number | null;
      readonly cachedInputTokens: number | null;
      readonly outputTokens: number | null;
      readonly ms: number;
    }
  | { readonly kind: "contextExceeded"; readonly estimatedTokens: number };

/** Estimated tokens of a serialized request, the same preflight the product applies. */
export function estimateTokens(body: string): number {
  return Math.ceil(Buffer.byteLength(body, "utf8") / 3) + templateReserve;
}

function modelName(name: string): string {
  const tail = name.slice(name.lastIndexOf("/") + 1);
  return tail.includes(":") ? name : `${name}:latest`;
}

/**
 * Ollama's native chat endpoint: the one protocol that takes `num_ctx` and
 * reports exact prompt, cached and output token counts.
 */
export class OllamaHost {
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #apiKey: string | undefined;
  readonly #keepAlive: string;

  constructor(options: {
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey?: string;
    readonly keepAlive?: string;
  }) {
    this.#baseUrl = options.baseUrl.endsWith("/")
      ? options.baseUrl
      : `${options.baseUrl}/`;
    this.#model = options.model;
    this.#apiKey = options.apiKey;
    this.#keepAlive = options.keepAlive ?? "10m";
  }

  get model(): string {
    return this.#model;
  }

  #headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.#apiKey === undefined
        ? {}
        : { authorization: `Bearer ${this.#apiKey}` }),
    };
  }

  /**
   * Guard: the reply is streamed. A non-streamed reply sends its headers only
   * when generation ends, and Node's fetch gives up on headers after 300 s
   * whatever the abort signal says; a long turn on a shared GPU passed that.
   *
   * Guard: a request whose estimate and reply reserve exceed the window is
   * not sent. Ollama drops the head of an oversized prompt without an error,
   * so an answer to a truncated conversation would be measured as an answer.
   */
  async chat(request: {
    readonly messages: readonly ChatMessage[];
    readonly tools: readonly ToolSpec[];
    readonly window: number;
    readonly temperature: number;
    readonly timeoutMs: number;
  }): Promise<ChatResult> {
    const body = JSON.stringify({
      model: this.#model,
      messages: request.messages,
      tools: request.tools,
      stream: true,
      keep_alive: this.#keepAlive,
      options: { num_ctx: request.window, temperature: request.temperature },
    });
    const estimatedTokens = estimateTokens(body);
    const reserve = Math.min(4096, Math.floor(request.window / 4));
    if (estimatedTokens + reserve > request.window)
      return { kind: "contextExceeded", estimatedTokens };
    const started = performance.now();
    const response = await fetch(new URL("api/chat", this.#baseUrl), {
      method: "POST",
      headers: this.#headers(),
      body,
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    if (!response.ok)
      throw new Error(
        `Ollama answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    if (response.body === null) throw new Error("Ollama sent no body.");
    let content = "";
    const toolCalls: ToolCall[] = [];
    let last: z.infer<typeof chatChunkSchema> | undefined;
    let pending = "";
    const decoder = new TextDecoder();
    const take = (line: string): void => {
      if (line.trim() === "") return;
      const chunk = chatChunkSchema.parse(JSON.parse(line));
      if (chunk.error !== undefined) throw new Error(`Ollama: ${chunk.error}`);
      content += chunk.message?.content ?? "";
      toolCalls.push(...(chunk.message?.tool_calls ?? []));
      if (chunk.done) last = chunk;
    };
    for await (const part of response.body) {
      pending += decoder.decode(part, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) take(line);
    }
    take(pending + decoder.decode());
    if (last === undefined) throw new Error("Ollama ended the stream early.");
    return {
      kind: "reply",
      content,
      toolCalls,
      estimatedTokens,
      inputTokens: last.prompt_eval_count ?? null,
      cachedInputTokens: last.prompt_eval_cached_count ?? null,
      outputTokens: last.eval_count ?? null,
      ms: performance.now() - started,
    };
  }

  /** The context length the host has this model loaded with, if it is loaded. */
  async loadedWindow(): Promise<number | null> {
    const response = await fetch(new URL("api/ps", this.#baseUrl), {
      headers: this.#headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const running = runningSchema.parse(await response.json());
    const wanted = modelName(this.#model);
    const match = running.models.find(
      (entry) => modelName(entry.model ?? entry.name) === wanted,
    );
    return match?.context_length ?? null;
  }
}
