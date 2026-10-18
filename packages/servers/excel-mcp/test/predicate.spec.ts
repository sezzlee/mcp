import { describe, expect, it } from "vitest";
import type { CellScalar } from "../src/grid/cell-value.js";
import type { SezzleeExcelError } from "../src/platform/errors.js";
import {
  explicitReading,
  rawReading,
  sniffedReading,
  typedCell,
  type ColumnReading,
} from "../src/grid/column-reading.js";
import {
  classify,
  compareWithin,
  emptyCensus,
  evaluate,
  majorityKind,
  record,
  validateCondition,
  type Condition,
  type Outcome,
  type PredicateOptions,
} from "../src/grid/predicate.js";

const loose: PredicateOptions = { caseSensitive: false };

function outcome(
  condition: Condition,
  cell: CellScalar,
  options = loose,
  reading: ColumnReading = rawReading,
): Outcome {
  return evaluate(condition, typedCell(cell, reading), options);
}

function hits(
  condition: Condition,
  cell: CellScalar,
  options = loose,
  reading: ColumnReading = rawReading,
): boolean {
  return outcome(condition, cell, options, reading) === "match";
}

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as SezzleeExcelError).code;
  }
  return "no-error";
}

describe("classify", () => {
  it("separates every kind", () => {
    expect(classify(5)).toBe("number");
    expect(classify("2026-01-15")).toBe("date");
    expect(classify("2026-01-15T09:30:00.000Z")).toBe("date");
    expect(classify("09:30:00")).toBe("time");
    expect(classify("9:30")).toBe("text");
    expect(classify("2026-01")).toBe("text");
    expect(classify("")).toBe("text");
    expect(classify(true)).toBe("boolean");
    expect(classify({ error: "#REF!" })).toBe("error");
    expect(classify(null)).toBe("empty");
  });
});

describe("kind is fixed by the operand", () => {
  it("does not cross number and text", () => {
    expect(hits({ column: "a", op: "eq", value: 5 }, "5")).toBe(false);
    expect(hits({ column: "a", op: "eq", value: "5" }, 5)).toBe(false);
    expect(hits({ column: "a", op: "eq", value: 5 }, 5)).toBe(true);
  });

  it("skips other kinds under an ordering operator", () => {
    for (const cell of [
      "text",
      true,
      { error: "#N/A" },
      null,
    ] as CellScalar[]) {
      expect(hits({ column: "a", op: "gt", value: 100 }, cell)).toBe(false);
    }
  });

  it("reports a non-empty cell of another kind as incomparable, never a blank", () => {
    expect(outcome({ column: "a", op: "gt", value: 100 }, "text")).toBe(
      "incomparable",
    );
    expect(outcome({ column: "a", op: "eq", value: 100 }, "text")).toBe(
      "incomparable",
    );
    expect(outcome({ column: "a", op: "gt", value: 100 }, null)).toBe("miss");
    expect(outcome({ column: "a", op: "gt", value: 100 }, 50)).toBe("miss");
    expect(outcome({ column: "a", op: "in", values: [1, 2] }, "text")).toBe(
      "incomparable",
    );
    expect(outcome({ column: "a", op: "ne", value: 100 }, "text")).toBe(
      "match",
    );
  });

  it("is not negation-complete across kinds", () => {
    const cell: CellScalar = "text";
    expect(hits({ column: "a", op: "gt", value: 5 }, cell)).toBe(false);
    expect(hits({ column: "a", op: "lte", value: 5 }, cell)).toBe(false);
  });
});

describe("dates", () => {
  it("compares lexically after expansion", () => {
    expect(
      hits(
        { column: "a", op: "gt", value: "2026-01-15" },
        "2026-01-16T09:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      compareWithin("date", "2026-01-15", "2026-01-15T00:00:00.000Z", true),
    ).toBe(0);
    expect(
      hits(
        { column: "a", op: "eq", value: "2026-01-15" },
        "2026-01-15T00:00:00.000Z",
      ),
    ).toBe(true);
  });
});

describe("text operators", () => {
  it("only look at text cells", () => {
    expect(hits({ column: "a", op: "contains", value: "1" }, 1234)).toBe(false);
    expect(hits({ column: "a", op: "contains", value: "23" }, "1234")).toBe(
      true,
    );
  });

  it("fold case and diacritics by default", () => {
    expect(
      hits({ column: "a", op: "contains", value: "istanbul" }, "İSTANBUL"),
    ).toBe(true);
    expect(hits({ column: "a", op: "eq", value: "sisli" }, "ŞİŞLİ")).toBe(true);
  });

  it("respect caseSensitive", () => {
    const strict = { caseSensitive: true };
    expect(
      hits(
        { column: "a", op: "contains", value: "istanbul" },
        "İSTANBUL",
        strict,
      ),
    ).toBe(false);
  });
});

describe("blank and error operators", () => {
  it("keeps empty and empty string apart", () => {
    expect(hits({ column: "a", op: "isEmpty" }, null)).toBe(true);
    expect(hits({ column: "a", op: "isEmpty" }, "")).toBe(false);
    expect(hits({ column: "a", op: "isNotEmpty" }, "")).toBe(true);
  });

  it("matches error cells but not error-looking text", () => {
    expect(hits({ column: "a", op: "isError" }, { error: "#REF!" })).toBe(true);
    expect(hits({ column: "a", op: "isError" }, "#REF!")).toBe(false);
    expect(
      hits(
        { column: "a", op: "isError", value: "#DIV/0!" },
        { error: "#REF!" },
      ),
    ).toBe(false);
  });

  it("probes kinds", () => {
    expect(hits({ column: "a", op: "isNumber" }, 1)).toBe(true);
    expect(hits({ column: "a", op: "isText" }, "x")).toBe(true);
    expect(hits({ column: "a", op: "isText" }, "2026-01-15")).toBe(false);
  });
});

describe("in and between", () => {
  it("compares element-wise within kind", () => {
    expect(
      hits({ column: "a", op: "in", values: ["EMEA", "APAC"] }, "emea"),
    ).toBe(true);
    expect(hits({ column: "a", op: "in", values: [1, 2] }, "1")).toBe(false);
  });

  it("is inclusive", () => {
    const condition: Condition = {
      column: "a",
      op: "between",
      values: [10, 20],
    };
    expect(hits(condition, 10)).toBe(true);
    expect(hits(condition, 20)).toBe(true);
    expect(hits(condition, 21)).toBe(false);
  });
});

describe("validation", () => {
  it("rejects an inverted between", () => {
    expect(
      codeOf(() =>
        validateCondition({ column: "a", op: "between", values: [20, 10] }),
      ),
    ).toBe("invalid_argument");
  });

  it("rejects an empty in list", () => {
    expect(
      codeOf(() => validateCondition({ column: "a", op: "in", values: [] })),
    ).toBe("invalid_argument");
  });

  it("rejects a boolean operand for an ordering operator", () => {
    expect(
      codeOf(() => validateCondition({ column: "a", op: "gt", value: true })),
    ).toBe("invalid_argument");
  });

  it("rejects a missing operand", () => {
    expect(codeOf(() => validateCondition({ column: "a", op: "eq" }))).toBe(
      "invalid_argument",
    );
  });

  it("rejects non-text for a text operator", () => {
    expect(
      codeOf(() =>
        validateCondition({ column: "a", op: "contains", value: 5 }),
      ),
    ).toBe("invalid_argument");
  });
});

describe("column readings", () => {
  const turkishNumbers = explicitReading({
    column: "a",
    type: "number",
    decimal: ",",
  });

  it("reads text as a number under the column's marks", () => {
    expect(
      hits(
        { column: "a", op: "gt", value: 1000 },
        "1.234,56",
        loose,
        turkishNumbers,
      ),
    ).toBe(true);
    expect(
      hits(
        { column: "a", op: "eq", value: 1234.56 },
        "1.234,56",
        loose,
        turkishNumbers,
      ),
    ).toBe(true);
    expect(
      outcome(
        { column: "a", op: "gt", value: 1 },
        "0x10",
        loose,
        turkishNumbers,
      ),
    ).toBe("incomparable");
  });

  it("reads sniffed numeric text and leaves identifiers alone", () => {
    const sniffed = sniffedReading(["1234.50", "99.5"], {
      number: true,
      date: false,
    });
    expect(
      hits({ column: "a", op: "gt", value: 1000 }, "1234.50", loose, sniffed),
    ).toBe(true);
    expect(
      outcome({ column: "a", op: "gt", value: 1 }, "00123", loose, sniffed),
    ).toBe("incomparable");
    expect(
      hits({ column: "a", op: "eq", value: "007" }, "007", loose, sniffed),
    ).toBe(true);
  });

  it("does not read text a column was never sniffed for", () => {
    expect(hits({ column: "a", op: "gt", value: 1000 }, "1234.50")).toBe(false);
  });

  it("matches a day-first date against an ISO operand", () => {
    const dotted = sniffedReading(["02.01.2023", "25.12.2023"], {
      number: false,
      date: true,
    });
    expect(
      hits(
        { column: "a", op: "between", values: ["2023-01-01", "2023-01-31"] },
        "02.01.2023",
        loose,
        dotted,
      ),
    ).toBe(true);
    expect(
      hits(
        { column: "a", op: "eq", value: "2023-12-25" },
        "25.12.2023",
        loose,
        dotted,
      ),
    ).toBe(true);
  });

  it("refuses to place an ambiguous slash date but reads the ones both orders agree on", () => {
    const ambiguous = sniffedReading(
      ["01/02/2023", "03/04/2023", "05/05/2023"],
      {
        number: false,
        date: true,
      },
    );
    const january = {
      column: "a",
      op: "between",
      values: ["2023-01-01", "2023-12-31"],
    } as const;
    expect(outcome(january, "01/02/2023", loose, ambiguous)).toBe(
      "incomparable",
    );
    expect(outcome(january, "05/05/2023", loose, ambiguous)).toBe("match");
  });

  it("compares a time of day as HH:mm:ss", () => {
    expect(hits({ column: "a", op: "lt", value: "09:00:00" }, "08:15:00")).toBe(
      true,
    );
    expect(outcome({ column: "a", op: "lt", value: "09:00:00" }, "8:15")).toBe(
      "incomparable",
    );
  });
});

describe("census", () => {
  it("counts every stored kind and the text that reads as a number or an identifier", () => {
    const reading = sniffedReading(["12", "00123"], {
      number: true,
      date: false,
    });
    const census = emptyCensus();
    for (const value of [
      1,
      "2026-01-15",
      "09:30:00",
      "x",
      "12",
      "00123",
      true,
      { error: "#N/A" },
      null,
    ] as CellScalar[]) {
      record(census, typedCell(value, reading));
    }
    expect(census).toEqual({
      numbers: 1,
      dates: 1,
      times: 1,
      texts: 3,
      booleans: 1,
      errors: 1,
      nulls: 1,
      textNumbers: 1,
      identifiers: 1,
    });
  });

  it("breaks a tie toward the earlier comparable kind", () => {
    expect(majorityKind({ number: 2, date: 2, time: 0, text: 1 })).toBe(
      "number",
    );
    expect(majorityKind({ number: 0, date: 1, time: 0, text: 3 })).toBe("text");
  });
});
