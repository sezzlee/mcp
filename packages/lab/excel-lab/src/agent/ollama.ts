import { z } from "zod";
import {
  HostRequestError,
  type HostFailure,
  type ChatRequest,
  type ChatResult,
  type HostIdentity,
  type ModelHost,
  type ToolCall,
} from "./host.ts";

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
  load_duration: z.int().optional(),
  prompt_eval_duration: z.int().optional(),
  eval_duration: z.int().optional(),
  done_reason: z.string().optional(),
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

const tagsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      model: z.string().optional(),
      digest: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

const versionSchema = z.object({ version: z.string() });

/** Estimated tokens of a serialized request, the same preflight the product applies. */
export function estimateTokens(body: string): number {
  return Math.ceil(Buffer.byteLength(body, "utf8") / 3) + templateReserve;
}

function modelName(name: string): string {
  const tail = name.slice(name.lastIndexOf("/") + 1);
  return tail.includes(":") ? name : `${name}:latest`;
}

function contextMessage(text: string): boolean {
  return /context|num_ctx|too long|exceeds/i.test(text);
}

/**
 * Guard: Ollama reports a tool call it could not parse as an error, yet the
 * unparsable text is the model's own output. At temperature 0 a retry repeats
 * it, and calling it a host failure would rerun the trial on every resume, so
 * it is told apart before the raw call text can match the context test.
 */
function errorFailure(text: string, otherwise: HostFailure): HostFailure {
  if (/error parsing tool call/i.test(text)) return "malformed";
  return contextMessage(text) ? "context" : otherwise;
}

/**
 * Guard: at temperature 0 a request that timed out repeats the same long
 * generation, so a timeout is retried once and a dropped connection more.
 */
function failureOf(error: unknown): HostFailure {
  return error instanceof Error && error.name === "TimeoutError"
    ? "timeout"
    : "retryable";
}

/**
 * Ollama's native chat endpoint: the one protocol that takes `num_ctx` and
 * reports exact prompt, cached and output token counts.
 */
export class OllamaHost implements ModelHost {
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #apiKey: string | undefined;
  readonly #keepAlive: string;
  readonly #think: boolean | string | undefined;

  constructor(options: {
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey?: string;
    readonly keepAlive?: string;
    readonly think?: boolean | string;
  }) {
    this.#baseUrl = options.baseUrl.endsWith("/")
      ? options.baseUrl
      : `${options.baseUrl}/`;
    this.#model = options.model;
    this.#apiKey = options.apiKey;
    this.#keepAlive = options.keepAlive ?? "10m";
    this.#think = options.think;
  }

  get model(): string {
    return this.#model;
  }

  get endpoint(): string {
    return new URL(this.#baseUrl).origin;
  }

  #headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.#apiKey === undefined
        ? {}
        : { authorization: `Bearer ${this.#apiKey}` }),
    };
  }

  async #get(path: string): Promise<unknown> {
    const response = await fetch(new URL(path, this.#baseUrl), {
      headers: this.#headers(),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? response.json() : null;
  }

  /** The host's version and the digest of the model this name resolves to, where the host reports them. */
  async identity(): Promise<HostIdentity> {
    const [tags, version] = await Promise.all([
      this.#get("api/tags").then((body) => tagsSchema.safeParse(body)),
      this.#get("api/version").then((body) => versionSchema.safeParse(body)),
    ]);
    const wanted = modelName(this.#model);
    const entry = tags.success
      ? tags.data.models.find(
          (model) => modelName(model.model ?? model.name) === wanted,
        )
      : undefined;
    return {
      provider: "ollama",
      model: this.#model,
      digest: entry?.digest ?? null,
      version: version.success ? version.data.version : null,
      details: entry?.details ?? null,
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
  async chat(request: ChatRequest): Promise<ChatResult> {
    const body = JSON.stringify({
      model: this.#model,
      messages: request.messages,
      tools: request.tools,
      stream: true,
      keep_alive: this.#keepAlive,
      ...(this.#think === undefined ? {} : { think: this.#think }),
      options: {
        num_ctx: request.window,
        temperature: request.temperature,
        ...(request.numPredict === null
          ? {}
          : { num_predict: request.numPredict }),
      },
    });
    const estimatedTokens = estimateTokens(body);
    const reserve = Math.min(4096, Math.floor(request.window / 4));
    if (estimatedTokens + reserve > request.window)
      return { kind: "preflightRefused", estimatedTokens };
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(new URL("api/chat", this.#baseUrl), {
        method: "POST",
        headers: this.#headers(),
        body,
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (error) {
      throw new HostRequestError(String(error), failureOf(error));
    }
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      throw new HostRequestError(
        `Ollama answered ${response.status}: ${text}`,
        errorFailure(text, response.status >= 500 ? "retryable" : "fatal"),
      );
    }
    if (response.body === null)
      throw new HostRequestError("Ollama sent no body.", "retryable");
    let content = "";
    let thinking = "";
    const toolCalls: ToolCall[] = [];
    let last: z.infer<typeof chatChunkSchema> | undefined;
    let pending = "";
    const decoder = new TextDecoder();
    const take = (line: string): void => {
      if (line.trim() === "") return;
      const chunk = chatChunkSchema.parse(JSON.parse(line));
      if (chunk.error !== undefined)
        throw new HostRequestError(
          `Ollama: ${chunk.error}`,
          errorFailure(chunk.error, "retryable"),
        );
      content += chunk.message?.content ?? "";
      thinking += chunk.message?.thinking ?? "";
      toolCalls.push(...(chunk.message?.tool_calls ?? []));
      if (chunk.done) last = chunk;
    };
    try {
      for await (const part of response.body) {
        pending += decoder.decode(part, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) take(line);
      }
      take(pending + decoder.decode());
    } catch (error) {
      if (error instanceof HostRequestError) throw error;
      throw new HostRequestError(String(error), failureOf(error));
    }
    if (last === undefined)
      throw new HostRequestError("Ollama ended the stream early.", "retryable");
    return {
      kind: "reply",
      content,
      thinking,
      toolCalls,
      estimatedTokens,
      usage:
        last.prompt_eval_count === undefined || last.eval_count === undefined
          ? null
          : {
              input: last.prompt_eval_count,
              cachedInput: last.prompt_eval_cached_count ?? 0,
              output: last.eval_count,
            },
      timing:
        last.load_duration === undefined ||
        last.prompt_eval_duration === undefined ||
        last.eval_duration === undefined
          ? null
          : {
              loadMs: last.load_duration / 1e6,
              promptEvalMs: last.prompt_eval_duration / 1e6,
              evalMs: last.eval_duration / 1e6,
            },
      doneReason: last.done_reason ?? null,
      ms: performance.now() - started,
    };
  }

  /** The context length the host has this model loaded with, if it is loaded. */
  async loadedWindow(): Promise<number | null> {
    const running = runningSchema.safeParse(await this.#get("api/ps"));
    if (!running.success) return null;
    const wanted = modelName(this.#model);
    const match = running.data.models.find(
      (entry) => modelName(entry.model ?? entry.name) === wanted,
    );
    return match?.context_length ?? null;
  }
}
