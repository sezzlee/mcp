import { describe, expect, it } from "vitest";
import type { CallMetric } from "../src/agent/agent-run.ts";
import { exercisedCases } from "../src/agent/exercised.ts";
import type { ChatMessage } from "../src/agent/host.ts";

function run(
  steps: readonly {
    readonly tool: string;
    readonly file?: string;
    readonly args?: Record<string, unknown>;
    readonly error?: string;
    readonly response: unknown;
  }[],
  submission: unknown = null,
) {
  const callLog: CallMetric[] = [];
  const trace: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "q" },
  ];
  steps.forEach((step, at) => {
    callLog.push({
      tool: step.tool,
      args: { filePath: step.file ?? "a.csv", ...step.args },
      error: step.error ?? null,
      bytes: 0,
      ms: 0,
    });
    trace.push({ role: "assistant", content: "" });
    if (at === 0) trace.push({ role: "user", content: "Submit your answer." });
    trace.push({
      role: "tool",
      content: JSON.stringify(step.response),
      tool_name: step.tool,
    });
  });
  return { callLog, trace, submission };
}

const undecodable = { error: "undecodable_text" };

describe("scenarios read from a run's trace", () => {
  it("counts a recovery only on the file that failed, with whatever tool", () => {
    expect(
      exercisedCases(
        run([
          {
            tool: "describe_workbook",
            error: "undecodable_text",
            response: undecodable,
          },
          { tool: "read_sheet", file: "b.csv", response: { values: [] } },
        ]),
      ),
    ).toEqual([{ id: "R2", file: "a.csv", recovered: false }]);
    expect(
      exercisedCases(
        run([
          {
            tool: "describe_workbook",
            error: "undecodable_text",
            response: undecodable,
          },
          {
            tool: "aggregate_sheet",
            args: { encoding: "windows-1254" },
            response: { rows: [] },
          },
        ]),
      ),
    ).toEqual([{ id: "R2", file: "a.csv", recovered: true }]);
  });

  it("counts a refused oversized file as handled only by a limit refusal with no retry of that file", () => {
    const tooLarge = { error: "file_too_large" };
    expect(
      exercisedCases(
        run(
          [
            {
              tool: "describe_workbook",
              error: "file_too_large",
              response: tooLarge,
            },
            {
              tool: "aggregate_sheet",
              error: "file_too_large",
              response: tooLarge,
            },
          ],
          { refusal: "limit" },
        ),
      ),
    ).toEqual([{ id: "Z3", file: "a.csv", recovered: false }]);
    expect(
      exercisedCases(
        run(
          [
            {
              tool: "describe_workbook",
              error: "file_too_large",
              response: tooLarge,
            },
          ],
          {
            refusal: "limit",
          },
        ),
      ),
    ).toEqual([{ id: "Z3", file: "a.csv", recovered: true }]);
    expect(
      exercisedCases(
        run([
          {
            tool: "describe_workbook",
            error: "file_too_large",
            response: tooLarge,
          },
        ]),
      ),
    ).toEqual([{ id: "Z3", file: "a.csv", recovered: false }]);
  });

  it("reads a coded ambiguity warning by its code and column", () => {
    expect(
      exercisedCases(
        run([
          {
            tool: "aggregate_sheet",
            response: {
              truncated: false,
              warnings: [
                {
                  code: "ambiguous_day_order",
                  message: "A: dates such as '05/01/2015' read either way.",
                  column: "A",
                },
                { code: "unread_numbers", message: "B: 2 cells", column: "B" },
              ],
            },
          },
          {
            tool: "aggregate_sheet",
            args: {
              columns: [{ column: "A", type: "date", format: "dd/MM/yyyy" }],
            },
            response: { truncated: false },
          },
        ]),
      ),
    ).toEqual([{ id: "R4", file: "a.csv", recovered: true }]);
  });

  it("counts an ambiguity warning as recovered only by naming the warned column, and a truncated answer by its own cursor", () => {
    const warned = {
      truncated: false,
      warnings: [
        'A: dates such as \'05/01/2015\' read either day first or month first, so they were not read as dates. Pass columns [{"column":"A","type":"date","format":"dd/MM/yyyy"}].',
      ],
    };
    expect(
      exercisedCases(
        run([
          { tool: "aggregate_sheet", response: warned },
          {
            tool: "aggregate_sheet",
            args: {
              columns: [{ column: "B", type: "date", format: "dd/MM/yyyy" }],
            },
            response: { truncated: false },
          },
        ]),
      ),
    ).toEqual([{ id: "R4", file: "a.csv", recovered: false }]);
    expect(
      exercisedCases(
        run([
          {
            tool: "read_sheet",
            response: { truncated: true, nextCursor: "c1" },
          },
          {
            tool: "read_sheet",
            args: { cursor: "c1" },
            response: { truncated: false },
          },
        ]),
      ),
    ).toEqual([{ id: "R5", file: "a.csv", recovered: true }]);
  });
});
