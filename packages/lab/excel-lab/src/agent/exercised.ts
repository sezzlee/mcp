import type { CallMetric } from "./agent-run.ts";
import { readSubmission } from "./grade.ts";
import type { ChatMessage } from "./host.ts";
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
  readonly file: string | null;
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

const ambiguityWarning =
  /^([A-Z]+): (?:dates such as .* read either day first or month first|values such as .* read differently with a decimal point and with a decimal comma)/;

function recordOf(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function responseOf(message: ChatMessage): Readonly<Record<string, unknown>> {
  if (message.role !== "tool") return {};
  try {
    return recordOf(JSON.parse(message.content));
  } catch {
    return {};
  }
}

function fileOf(call: CallMetric): string | null {
  const path = recordOf(call.args)["filePath"];
  return typeof path === "string" ? path : null;
}

function sheetOf(call: CallMetric): unknown {
  return recordOf(call.args)["sheetName"];
}

function namesColumn(call: CallMetric, letter: string): boolean {
  const columns = recordOf(call.args)["columns"];
  return (
    Array.isArray(columns) &&
    columns.some((entry) => recordOf(entry)["column"] === letter)
  );
}

/**
 * The scenarios a run went through, one per file, read from the server's
 * answers rather than the task's tags. `recovered` judges the first
 * occurrence on that file: for an error, a later successful call on the same
 * file (and sheet, for R1 and R3; with the same tool, for R6); for an
 * ambiguity warning, a later call naming the warned column in `columns`; for
 * a truncated answer, its cursor or an aggregate of the same file; for Z3, a
 * `limit` refusal and no further call to the refused file.
 */
export function exercisedCases(run: {
  readonly callLog: readonly CallMetric[];
  readonly trace: readonly ChatMessage[];
  readonly submission: unknown;
}): readonly Exercised[] {
  const responses = run.trace
    .filter((message) => message.role === "tool")
    .map(responseOf);
  const refusal = readSubmission(run.submission);
  const found = new Map<string, Exercised>();
  const mark = (id: TraceableCase, file: string | null, recovered: boolean) => {
    const key = `${id} ${file ?? ""}`;
    if (!found.has(key)) found.set(key, { id, file, recovered });
  };
  run.callLog.forEach((call, at) => {
    const file = fileOf(call);
    const later = run.callLog
      .slice(at + 1)
      .filter((next) => file === null || fileOf(next) === file);
    const succeeded = later.filter((next) => next.error === null);
    const id = call.error === null ? undefined : errorCases[call.error];
    if (id === "Z3")
      mark(
        id,
        file,
        later.length === 0 &&
          refusal?.kind === "refusal" &&
          refusal.reason === "limit",
      );
    else if (id === "R1" || id === "R3")
      mark(
        id,
        file,
        succeeded.some((next) => sheetOf(next) === sheetOf(call)),
      );
    else if (id === "R6")
      mark(
        id,
        file,
        succeeded.some((next) => next.tool === call.tool),
      );
    else if (id !== undefined) mark(id, file, succeeded.length > 0);
    const response = responses[at] ?? {};
    const warnings = response["warnings"];
    if (Array.isArray(warnings))
      for (const warning of warnings) {
        const match = ambiguityWarning.exec(String(warning));
        if (match?.[1] !== undefined) {
          const letter = match[1];
          mark(
            "R4",
            file,
            succeeded.some((next) => namesColumn(next, letter)),
          );
        }
      }
    if (response["truncated"] === true) {
      const cursor = response["nextCursor"];
      mark(
        "R5",
        file,
        succeeded.some(
          (next) =>
            (typeof cursor === "string" &&
              recordOf(next.args)["cursor"] === cursor) ||
            next.tool === "aggregate_sheet",
        ),
      );
    }
  });
  return [...found.values()].sort(
    (left, right) =>
      traceableCases.indexOf(left.id) - traceableCases.indexOf(right.id),
  );
}
