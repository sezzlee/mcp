import { describe, expect, it } from "vitest";
import { derive, type Expr, type StepResponse } from "../src/agent/derive.ts";

const table: StepResponse = {
  kind: "ok",
  body: {
    truncated: false,
    columns: [{ label: "count", counted: 451 }],
    values: [
      ["SIRA NO", "MAHALLE", "YAPI", "BAĞIMSIZ"],
      [1, "KAŞÜSTÜ", 1764, 15535],
      [2, "SANCAK", 1214, 10704],
      [3, "OCAK", 325, null],
      ["TOPLAM", null, 3303, 26239],
    ],
  },
};

function value(expr: Expr, responses: readonly StepResponse[] = [table]) {
  return derive(expr, responses);
}

describe("deriving an answer from named places in the responses", () => {
  it("reads the place it names, so the value appearing elsewhere in the response does not count", () => {
    expect(value({ at: [0, "/values/1/3"] })).toEqual({
      kind: "value",
      value: 15535,
    });
    expect(value({ at: [0, "/values/1/9"] })).toMatchObject({
      kind: "incomplete",
    });
  });

  it("finds a row by a key that must be unique", () => {
    expect(
      value({
        row: { step: 0, rows: "/values", key: 0, equals: "toplam", value: 2 },
      }),
    ).toEqual({
      kind: "value",
      value: 3303,
    });
    const twice: StepResponse = {
      kind: "ok",
      body: {
        values: [
          ["Yes", 1],
          ["Yes", 2],
        ],
      },
    };
    expect(
      value(
        { row: { step: 0, rows: "/values", key: 0, equals: "Yes", value: 1 } },
        [twice],
      ),
    ).toEqual({
      kind: "incomplete",
      detail: "2 rows of step 0 have Yes in column 0",
    });
  });

  it("refuses a table taken from a truncated response", () => {
    const cut: StepResponse = {
      kind: "ok",
      body: { truncated: true, values: [[1, 2]] },
    };
    expect(
      value({ column: { step: 0, rows: "/values", value: 1 } }, [cut]),
    ).toEqual({
      kind: "incomplete",
      detail: "step 0 is truncated",
    });
  });

  it("computes a per-row ratio and picks the largest, and refuses a tie", () => {
    expect(
      value({
        fn: "argmax",
        args: [
          {
            pairs: {
              step: 0,
              rows: "/values",
              label: 1,
              value: { op: "divide", columns: [3, 2] },
              where: { key: 0, number: true },
            },
          },
        ],
      }),
    ).toEqual({ kind: "incomplete", detail: "null is not a number" });
    const tied: StepResponse = {
      kind: "ok",
      body: {
        rows: [
          ["A", 2],
          ["B", 2],
        ],
      },
    };
    expect(
      value(
        {
          fn: "argmax",
          args: [{ pairs: { step: 0, rows: "/rows", label: 0, value: 1 } }],
        },
        [tied],
      ),
    ).toEqual({
      kind: "incomplete",
      detail: "2 labels share the largest value",
    });
  });

  it("skips blank cells in a sum, as a spreadsheet does", () => {
    expect(
      value({
        fn: "sum",
        args: [
          {
            column: {
              step: 0,
              rows: "/values",
              value: 3,
              where: { key: 0, number: true },
            },
          },
        ],
      }),
    ).toEqual({ kind: "value", value: 26239 });
  });

  it("reads an error code only from a call that failed", () => {
    expect(
      value({ error: 0 }, [{ kind: "error", code: "file_too_large" }]),
    ).toEqual({
      kind: "value",
      value: "file_too_large",
    });
    expect(value({ error: 0 })).toEqual({
      kind: "incomplete",
      detail: "step 0 did not fail",
    });
  });
});
