import { expect, it } from "vitest";
import { compare, summarize, type NightTrial } from "../src/lab/morning.ts";

function trial(overrides: Partial<NightTrial>): NightTrial {
  return {
    model: "m",
    id: "chain/a",
    language: "en",
    repetition: 0,
    passed: true,
    failure: null,
    dispatched: 2,
    refusedCatalog: 0,
    refusedBudget: 0,
    tools: [],
    writes: [],
    ...overrides,
  };
}

it("summarizes pass rates, sourced writes and tool errors per model", () => {
  const morning = summarize([
    trial({
      writes: [{ tool: "create_workbook", sourced: true }],
      tools: [{ tool: "read_sheet", error: null }],
    }),
    trial({
      id: "edit/write",
      language: "tr",
      passed: false,
      failure: "No output was saved.",
      dispatched: 4,
      refusedBudget: 1,
      writes: [{ tool: "edit_workbook", sourced: false }],
      tools: [
        { tool: "edit_workbook", error: "file_changed" },
        { tool: "read_sheet", error: null },
      ],
    }),
  ]);
  expect(morning.models).toEqual([
    {
      model: "m",
      overall: { passed: 1, total: 2 },
      suites: {
        chain: { passed: 1, total: 1 },
        edit: { passed: 0, total: 1 },
      },
      languages: {
        en: { passed: 1, total: 1 },
        tr: { passed: 0, total: 1 },
      },
      meanDispatched: 3,
      refusedCatalog: 0,
      refusedBudget: 1,
      writes: { sourced: 1, literal: 1 },
    },
  ]);
  expect(morning.tools).toEqual({
    read_sheet: { calls: 2, errors: {} },
    edit_workbook: { calls: 1, errors: { file_changed: 1 } },
  });
  expect(morning.failures).toEqual([
    { failure: "No output was saved.", count: 1, ids: ["edit/write"] },
  ]);
});

it("counts only the last record of a trial a resumed night ran again", () => {
  const resumed = [
    trial({
      passed: false,
      failure: "host: retryable: TypeError: fetch failed",
    }),
    trial({ id: "chain/b", passed: false, failure: "No output was saved." }),
    trial({ passed: true }),
  ];
  const morning = summarize(resumed);
  expect(morning.models[0]?.overall).toEqual({ passed: 1, total: 2 });
  expect(morning.failures).toEqual([
    { failure: "No output was saved.", count: 1, ids: ["chain/b"] },
  ]);
  expect(compare([trial({ passed: false })], resumed)).toMatchObject({
    paired: 1,
    fixed: 1,
    broke: 0,
  });
});

it("pairs two nights by trial and counts only the trials that changed", () => {
  const before = [
    trial({ id: "x/1", passed: false }),
    trial({ id: "x/2", passed: false }),
    trial({ id: "x/3", passed: false }),
    trial({ id: "x/4", passed: true }),
    trial({ id: "x/5", passed: true, repetition: 1 }),
  ];
  const after = [
    trial({ id: "x/1", passed: true }),
    trial({ id: "x/2", passed: true }),
    trial({ id: "x/3", passed: true }),
    trial({ id: "x/4", passed: true }),
    trial({ id: "x/5", passed: false }),
  ];
  const result = compare(before, after);
  expect(result).toMatchObject({ paired: 4, fixed: 3, broke: 0 });
  expect(result.pValue).toBeCloseTo(0.25, 10);
});
