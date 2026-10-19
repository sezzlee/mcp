import type { CallMetric } from "./agent-run.ts";
import type { ChatMessage } from "./ollama.ts";
import type { CaseId } from "./task.ts";

export const traceableCases = [
  "R1",
  "R2",
  "R3",
  "R4",
  "R5",
  "R6",
  "Z3",
] as const satisfies readonly CaseId[];
export type TraceableCase = (typeof traceableCases)[number];

export interface Exercised {
  readonly id: TraceableCase;
  readonly recovered: boolean;
}

const errorCases: Readonly<Record<string, TraceableCase>> = {
  unknown_column: "R1",
  undecodable_text: "R2",
  ambiguous_header_row: "R3",
  invalid_argument: "R6",
  invalid_arguments: "R6",
  file_too_large: "Z3",
};

const ambiguityWarnings = [
  "read either day first or month first",
  "read differently with a decimal point and with a decimal comma",
];

function responseOf(message: ChatMessage): Record<string, unknown> | null {
  if (message.role !== "tool") return null;
  try {
    const parsed: unknown = JSON.parse(message.content);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function warnsAmbiguity(response: Record<string, unknown>): boolean {
  const warnings = response["warnings"];
  return (
    Array.isArray(warnings) &&
    warnings.some(
      (warning) =>
        typeof warning === "string" &&
        ambiguityWarnings.some((text) => warning.includes(text)),
    )
  );
}

function argsOf(call: CallMetric): Record<string, unknown> {
  return typeof call.args === "object" && call.args !== null
    ? (call.args as Record<string, unknown>)
    : {};
}

/**
 * The scenarios a run went through, read from the server's answers rather
 * than the task's tags. `recovered` judges the first occurrence: a later call
 * to the same tool without the error, `columns` after an ambiguity warning, a
 * cursor or an aggregate after a truncated answer, and for Z3 no further call
 * to the refused file.
 */
export function exercisedCases(run: {
  readonly callLog: readonly CallMetric[];
  readonly trace: readonly ChatMessage[];
}): readonly Exercised[] {
  const responses = run.trace
    .filter((message) => message.role === "tool")
    .map(responseOf);
  const found = new Map<TraceableCase, boolean>();
  const mark = (id: TraceableCase, recovered: boolean): void => {
    if (!found.has(id)) found.set(id, recovered);
  };
  run.callLog.forEach((call, at) => {
    const later = run.callLog.slice(at + 1);
    const id = call.error === null ? undefined : errorCases[call.error];
    if (id === "Z3")
      mark(
        id,
        !later.some(
          (next) => argsOf(next)["filePath"] === argsOf(call)["filePath"],
        ),
      );
    else if (id !== undefined)
      mark(
        id,
        later.some((next) => next.tool === call.tool && next.error === null),
      );
    const response = responses[at];
    if (response === null || response === undefined) return;
    if (warnsAmbiguity(response))
      mark(
        "R4",
        later.some((next) => next.error === null && "columns" in argsOf(next)),
      );
    if (response["truncated"] === true)
      mark(
        "R5",
        later.some(
          (next) =>
            next.error === null &&
            ("cursor" in argsOf(next) || next.tool === "aggregate_sheet"),
        ),
      );
  });
  return traceableCases.flatMap((id) =>
    found.has(id) ? [{ id, recovered: found.get(id) ?? false }] : [],
  );
}
