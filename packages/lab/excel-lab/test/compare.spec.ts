import { describe, expect, it } from "vitest";
import { differencesOf } from "../src/compare.ts";

describe("differencesOf", () => {
  it("names each JSON path where two answers differ", () => {
    const baseline = {
      sheets: [
        { name: "Q1", rowCount: 4 },
        { name: "Q2", rowCount: 7 },
      ],
      dateSystem: "1900",
      guidance: "kept",
    };
    const candidate = {
      sheets: [
        { name: "Q1", rowCount: 4 },
        { name: "Q2", rowCount: 9 },
      ],
      dateSystem: "1904",
      extra: true,
    };

    expect(differencesOf(baseline, candidate)).toEqual([
      { path: "$.sheets[1].rowCount", baseline: 7, candidate: 9 },
      { path: "$.dateSystem", baseline: "1900", candidate: "1904" },
      { path: "$.guidance", baseline: "kept", candidate: undefined },
      { path: "$.extra", baseline: undefined, candidate: true },
    ]);
  });

  it("reports nothing for equal answers and stops at the limit", () => {
    expect(differencesOf({ a: [1, 2] }, { a: [1, 2] })).toEqual([]);
    expect(differencesOf([1, 2, 3], [4, 5, 6], 2)).toHaveLength(2);
  });
});
