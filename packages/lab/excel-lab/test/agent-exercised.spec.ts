import { describe, expect, it } from "vitest";
import type { CallMetric } from "../src/agent/agent-run.ts";
import { exercisedCases } from "../src/agent/exercised.ts";
import type { ChatMessage } from "../src/agent/ollama.ts";

function run(
  steps: readonly {
    readonly tool: string;
    readonly args?: Record<string, unknown>;
    readonly error?: string;
    readonly response: unknown;
  }[],
) {
  const callLog: CallMetric[] = [];
  const trace: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "q" },
  ];
  steps.forEach((step, at) => {
    callLog.push({
      tool: step.tool,
      args: { filePath: "a.csv", ...step.args },
      error: step.error ?? null,
      bytes: 0,
    });
    trace.push({ role: "assistant", content: "" });
    if (at === 0) trace.push({ role: "user", content: "Submit your answer." });
    trace.push({
      role: "tool",
      content: JSON.stringify(step.response),
      tool_name: step.tool,
    });
  });
  return { callLog, trace };
}

describe("scenarios read from a run's trace", () => {
  it("counts an error as recovered only when the same tool later succeeds", () => {
    const exercised = exercisedCases(
      run([
        {
          tool: "describe_workbook",
          error: "undecodable_text",
          response: { error: "undecodable_text" },
        },
        {
          tool: "describe_workbook",
          args: { encoding: "windows-1254" },
          response: { sheets: [] },
        },
        {
          tool: "aggregate_sheet",
          error: "invalid_argument",
          response: { error: "invalid_argument" },
        },
        { tool: "read_sheet", response: { values: [] } },
      ]),
    );
    expect(exercised).toEqual([
      { id: "R2", recovered: true },
      { id: "R6", recovered: false },
    ]);
  });

  it("does not count a refused oversized file as recovered when the agent retries it with another tool", () => {
    const tooLarge = { error: "file_too_large" };
    const exercised = exercisedCases(
      run([
        {
          tool: "describe_workbook",
          error: "file_too_large",
          response: tooLarge,
        },
        { tool: "list_workbooks", args: { filePath: undefined }, response: {} },
        {
          tool: "aggregate_sheet",
          error: "file_too_large",
          response: tooLarge,
        },
      ]),
    );
    expect(exercised).toEqual([{ id: "Z3", recovered: false }]);
  });

  it("reads an ambiguity warning and a truncated answer from the responses", () => {
    const exercised = exercisedCases(
      run([
        {
          tool: "aggregate_sheet",
          response: {
            truncated: false,
            warnings: [
              'A: dates such as \'05/01/2015\' read either day first or month first, so they were not read as dates. Pass columns [{"column":"A","type":"date","format":"dd/MM/yyyy"}].',
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
        { tool: "read_sheet", response: { truncated: true } },
      ]),
    );
    expect(exercised).toEqual([
      { id: "R4", recovered: true },
      { id: "R5", recovered: false },
    ]);
  });
});
