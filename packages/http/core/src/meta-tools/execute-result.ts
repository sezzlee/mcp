import type { DataExecutor } from "../results/executor.js";
import type {
  ExecutedResult,
  ExecutionFailure,
} from "../generated/result-execution.js";
import { recordOf } from "../results/reading.js";
import { handlePattern, type ResultShelf } from "../results/store.js";
import {
  errorResult,
  missingArgument,
  textResult,
  type MetaResponse,
} from "./meta-tools.js";

export const executeResultDescription =
  "Compute over the complete stored body behind a handle without returning it to the model. First use the stored outline or read_result to inspect its shape. code is a synchronous JavaScript function body: data is the stored body; use return to produce one finite JSON value. Example: return data.items.filter(x => x.paid).map(x => ({id: x.id, total: x.total})); No Node.js, filesystem, network, tool calls, imports, console or async work. A stored body can itself be an upstream page or sample; computing over it does not fetch missing source data. Large computed answers can be stored for read_result. Never repeat an applied backend operation merely to inspect its result.";

export const executeCodeDescription =
  "A synchronous JavaScript function body receiving data. Return JSON; do not print it. Prefer selecting, filtering or aggregating over returning the input unchanged. Ordinary JavaScript numbers use binary64; preserve exact identifiers and decimal text unless explicitly converting them.";

const recovery: Record<ExecutionFailure["reason"], string> = {
  invalid_input:
    "The supplied input could not be read as JSON within the execution memory budget. Select a smaller stored result.",
  code_limit: "The program exceeds the code byte budget. Shorten the program.",
  input_limit:
    "The complete stored body exceeds the execution input byte budget. Narrow the source operation; read_result pages are not a complete replacement for it.",
  output_limit:
    "The computed JSON exceeds the execution output byte budget. Return fewer fields, fewer rows or an aggregate. No partial value was returned or stored.",
  invalid_program:
    "The code is not a valid synchronous JavaScript function body. Use return to produce a JSON value.",
  program_failed:
    "The program threw an exception or exhausted its execution memory or stack budget. Inspect the shape with read_result, simplify the program or narrow the input. Exception details were withheld.",
  invalid_result:
    "The program did not return a finite JSON value. Return JSON without undefined, functions, symbols, bigint, promises, cycles, NaN or infinity.",
  memory_limit:
    "The execution exhausted its memory budget. Simplify the program or narrow the input.",
  timeout:
    "The execution exceeded its wall-clock budget, including worker startup. Simplify the program or narrow the input; no partial result was returned.",
  cancelled: "The execution was cancelled; no partial result was returned.",
  busy: "All execution slots are in use. Wait for an active execution to finish before trying again.",
  unavailable:
    "The execution worker is unavailable. Ask the host to check the installed compute-core worker and WASM dependencies.",
};

/** Executes against one caller's stored body after checking the producing tool's visibility. */
export async function executeStoredResult(input: {
  readonly handle: unknown;
  readonly code: unknown;
  readonly shelf: ResultShelf;
  readonly executor: DataExecutor;
  readonly visible: (tool: string) => Promise<boolean>;
  readonly signal?: AbortSignal;
}): Promise<MetaResponse<never>> {
  const { handle, code } = input;
  if (handle === undefined || handle === null) {
    return missingArgument("execute_result", "handle");
  }
  if (typeof handle !== "string") {
    return errorResult(
      "invalid_selection",
      "Tool 'execute_result' takes 'handle' as a string.",
    );
  }
  if (code === undefined || code === null) {
    return missingArgument("execute_result", "code");
  }
  if (typeof code !== "string") {
    return errorResult(
      "invalid_selection",
      "Tool 'execute_result' takes 'code' as a string.",
    );
  }
  const unavailable = () =>
    errorResult(
      "result_unavailable",
      "No stored result is available to this caller and tool. It may have expired, been evicted or lost visibility. A non-read-only source operation must not be repeated automatically.",
    );
  if (!handlePattern.test(handle)) {
    return unavailable();
  }
  const stored = await input.shelf.store.get(input.shelf.partition, handle);
  const record = stored === undefined ? undefined : recordOf(stored);
  if (record === undefined || !(await input.visible(record.tool))) {
    return unavailable();
  }
  const result = await input.executor.execute({
    json: JSON.stringify(record.body) ?? "null",
    code,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (result.kind === "failure") {
    const payload: ExecutionFailure = {
      error: "result_execution_failed",
      message: recovery[result.reason],
      reason: result.reason,
      limits: input.executor.limits,
      retryable: result.reason === "busy",
    };
    return textResult(payload, true);
  }
  if (!(await input.visible(record.tool))) {
    return unavailable();
  }
  const value: unknown = JSON.parse(result.json);
  const payload: ExecutedResult = {
    source: { handle, tool: record.tool, scope: "stored_body" },
    value,
  };
  return textResult(payload, false, {
    summaryOf: value,
    narrowing: [
      {
        name: "code",
        message: "Return fewer fields, fewer rows or an aggregate.",
      },
    ],
    storable: { tool: record.tool, success: { body: payload } },
  });
}
