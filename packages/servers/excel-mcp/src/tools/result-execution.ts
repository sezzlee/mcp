import type {
  DataExecutor,
  ExecutionFailureReason,
  ExecutionLimits,
} from "@sezzlee/compute-core";
import { json, measureJson } from "@sezzlee/file-core";
import { limits } from "../platform/limits.js";
import { SezzleeExcelError } from "../platform/errors.js";
import type { ResultStore } from "./retained-results.js";

const recovery: Record<ExecutionFailureReason, string> = {
  invalid_input:
    "The complete JSON input could not be parsed within the execution memory budget. Use a smaller retained result.",
  code_limit: "Shorten code to fit the program UTF-8 byte budget.",
  input_limit:
    "Retain a narrower aggregate with fewer groups or metrics. Reading a page does not make it the complete input.",
  output_limit:
    "Return fewer fields or rows, or an aggregate. No partial result or identifier was published.",
  invalid_program:
    "Use a valid synchronous JavaScript function body and return a JSON value.",
  program_failed:
    "Inspect the input with query_result or read_result, then simplify code or narrow the input. Guest exceptions and guest memory/stack exhaustion are not disclosed.",
  invalid_result:
    "Return finite JSON: no undefined, functions, symbols, bigint, promises, cycles, NaN, infinity or non-plain objects without a JSON conversion.",
  memory_limit: "Reduce intermediate allocations or retain a narrower input.",
  timeout:
    "Simplify the program or retain a smaller input. The wall-clock budget includes worker startup, execution and serialization.",
  cancelled: "The call was cancelled; no partial result was published.",
  busy: "Wait for a running execution to finish before trying again. There is no execution queue.",
  unavailable:
    "Check the installed compute-core worker and its WASM dependency; no source data was changed.",
};

export function resultExecutionDescription(budgets: ExecutionLimits): string {
  return `Compute a retained resultId with synchronous JS. data: aggregate metadata, columns, exact rows, rowSourceCounts; or computed source/value. Return finite JSON, e.g. return data.rows.length; No Node, I/O, imports or tools. Scope: retained aggregate, not raw sheet rows. Large outputs get a resultId for read_result. Numbers are binary64; keep exact digits as text. Limits: ${JSON.stringify(budgets)}.`;
}

export async function executeExcelResult(input: {
  readonly resultId: string;
  readonly code: string;
  readonly results: ResultStore;
  readonly executor: DataExecutor;
  readonly signal: AbortSignal;
}) {
  const captured = input.results.program(input.resultId);
  const execution = await input.executor.execute({
    json: captured.json,
    code: input.code,
    signal: input.signal,
  });
  if (execution.kind === "failure")
    return json(
      {
        error: "result_execution_failed",
        reason: execution.reason,
        message: `The result program failed: ${execution.reason}.`,
        recovery: recovery[execution.reason],
        limits: input.executor.limits,
        retryable: execution.reason === "busy",
      },
      { isError: true },
    );
  if (input.signal.aborted)
    throw new SezzleeExcelError(
      "result_unavailable",
      "The execution or its server instance has closed.",
      "Use a live server instance and its own retained result identifiers.",
    );
  const value: unknown = JSON.parse(execution.json);
  const payload = { source: captured.source, value };
  const inline = json(payload);
  if (measureJson(inline) <= limits.maxResultPageBytes) return inline;
  const stored = input.results.retainJson(JSON.stringify(payload));
  return json(stored);
}
