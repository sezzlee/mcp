import { Worker } from "node:worker_threads";
import {
  dataExecutionSchema,
  executionFailure,
  executionRequestSchema,
  executionLimits,
  executionLimitsSchema,
  type DataExecution,
  type DataExecutor,
  type ExecutionInput,
  type ExecutionLimits,
} from "./protocol.js";

/** Executes a synchronous function body with `data` as its sole supplied capability. */
export class QuickJsExecutor implements DataExecutor {
  readonly limits: ExecutionLimits;
  private active = 0;

  constructor(options: Partial<ExecutionLimits> = {}) {
    this.limits = Object.freeze(
      executionLimitsSchema.parse({ ...executionLimits, ...options }),
    );
  }

  async execute(
    input: ExecutionInput & { readonly signal?: AbortSignal },
  ): Promise<DataExecution> {
    const parsed = executionRequestSchema.safeParse(input);
    if (!parsed.success) {
      return executionFailure("invalid_input");
    }
    if (
      Buffer.byteLength(parsed.data.code, "utf8") > this.limits.maxCodeBytes
    ) {
      return executionFailure("code_limit");
    }
    if (
      Buffer.byteLength(parsed.data.json, "utf8") > this.limits.maxInputBytes
    ) {
      return executionFailure("input_limit");
    }
    if (parsed.data.signal?.aborted === true) {
      return executionFailure("cancelled");
    }
    if (this.active >= this.limits.maxConcurrent) {
      return executionFailure("busy");
    }
    this.active++;
    try {
      const { code, json, signal } = parsed.data;
      return await this.run({ code, json }, signal);
    } finally {
      this.active--;
    }
  }

  private async run(
    input: ExecutionInput,
    signal: AbortSignal | undefined,
  ): Promise<DataExecution> {
    try {
      const worker = new Worker(new URL("./worker.js", import.meta.url), {
        workerData: { ...input, limits: this.limits },
        execArgv: [],
        env: {},
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      });
      return await new Promise<DataExecution>((resolve) => {
        let settled = false;
        const finish = (result: DataExecution): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          void worker.terminate().then(
            () => resolve(result),
            () => resolve(result),
          );
        };
        const abort = (): void => finish(executionFailure("cancelled"));
        const timer = setTimeout(
          () => finish(executionFailure("timeout")),
          this.limits.timeoutMs,
        );
        worker.once("message", (message: unknown) => {
          const parsed = dataExecutionSchema.safeParse(message);
          finish(
            parsed.success ? parsed.data : executionFailure("unavailable"),
          );
        });
        worker.once("error", (error: Error) =>
          finish(
            executionFailure(
              "code" in error && error.code === "ERR_WORKER_OUT_OF_MEMORY"
                ? "memory_limit"
                : "unavailable",
            ),
          ),
        );
        worker.once("exit", () => finish(executionFailure("unavailable")));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted === true) {
          abort();
        }
      });
    } catch {
      return executionFailure("unavailable");
    }
  }
}
