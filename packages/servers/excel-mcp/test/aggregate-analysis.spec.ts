import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createWorkbookRoot } from "../src/platform/paths.js";
import type { ToolHandlers } from "../src/tools/definitions.js";
import { createHandlers } from "../src/tools/handlers.js";

let directory: string;
let handlers: ToolHandlers;

function body(result: CallToolResult): Record<string, unknown> {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  return JSON.parse(content.text) as Record<string, unknown>;
}

const monthTotals = [
  ["2023-01", 56, 560],
  ["2023-02", 56, 560],
  ["2023-03", 56, 560],
  ["2023-04", 56, 560],
  ["2023-05", 56, 560],
  ["2023-06", 56, 560],
  ["2023-07", 56, 560],
  ["2023-08", 56, 560],
  ["2023-09", 56, 560],
  ["2023-10", 56, 560],
  ["2023-11", 56, 560],
  ["2023-12", 56, 560],
  ["2024-01", 56, 560],
  ["2024-02", 56, 560],
  ["2024-03", 56, 560],
  ["2024-04", 56, 560],
  ["2024-05", 56, 560],
  ["2024-06", 56, 560],
  ["2024-07", 56, 560],
  ["2024-08", 56, 560],
  ["2024-09", 55, 550],
  ["2024-10", 55, 550],
  ["2024-11", 55, 550],
  ["2024-12", 55, 550],
  ["2025-01", 55, 550],
  ["2025-02", 55, 550],
  ["2025-03", 55, 550],
  ["2025-04", 55, 550],
  ["2025-05", 55, 550],
  ["2025-06", 55, 550],
  ["2025-07", 55, 550],
  ["2025-08", 55, 550],
  ["2025-09", 55, 550],
  ["2025-10", 55, 550],
  ["2025-11", 55, 550],
  ["2025-12", 55, 550],
] as const;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-analysis-"));
  handlers = createHandlers(await createWorkbookRoot(directory));
  await writeFile(
    join(directory, "dates.csv"),
    [
      "Date,Amount,Kind",
      "2015-12-31T23:00:00-02:00,1,sale",
      "2016-01-03,2,sale",
      "2016-01-04,3,refund",
      "2020-12-31,4,sale",
      "2021-01-01,5,refund",
      "2021-01-04,6,sale",
      "not a date,7,sale",
      ",8,sale",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "percentiles.csv"),
    ["Value,Kind", "1,keep", "3,keep", "2,keep", "4,keep", "100,drop"].join(
      "\n",
    ),
  );
  await writeFile(
    join(directory, "extremes.csv"),
    ["Value", "-1.7976931348623157e308", "1.7976931348623157e308"].join("\n"),
  );
  await writeFile(
    join(directory, "quality.csv"),
    ["Value,Kind", "1,keep", "=2", "3,drop"].join("\n"),
  );
  await writeFile(
    join(directory, "hours.csv"),
    ["Time", "09:30:00", "23:59:59", "24:00:00", "99:99:99"].join("\n"),
  );
  await writeFile(
    join(directory, "buckets.csv"),
    ["Amount", "-10", "0", "99", "100", "499", "500", "invalid", ""].join("\n"),
  );
  await writeFile(
    join(directory, "decimal-buckets.csv"),
    ["Amount", "-0.3", "-0.2", "0.1", "0.2", "0.3", "0.29999999999999993"].join(
      "\n",
    ),
  );
  await writeFile(
    join(directory, "pivot.csv"),
    [
      "Country,Category,Sales",
      "Japan,Food,10",
      "Japan,Books,20",
      "Brazil,Food,30",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "keys.csv"),
    ["Amount", '"1.234,50"', '"1234,5"', '"00123"'].join("\n"),
  );
  const countries = ["Türkiye", "日本", "Deutschland", "Brasil"];
  const categories = ["Food", "Electronics", "Home", "Books", "Clothing"];
  const payments = ["Card", "Bank", "Wallet", "Cash"];
  const rows = Array.from({ length: 2000 }, (_, at) =>
    [
      `O-${at + 1}`,
      `${2023 + Math.floor((at % 36) / 12)}-${String((at % 12) + 1).padStart(2, "0")}-15`,
      countries[at % 4],
      categories[at % 5],
      payments[at % 4],
      "10.00",
      1,
      "10.00",
      "0%",
      0,
      0,
      `C-${at + 1}`,
      "Web",
      "EUR",
      "Paid",
    ].join(","),
  );
  await writeFile(
    join(directory, "global_ecommerce_sales.csv"),
    [
      "Order_ID,Order_Date,Country,Product_Category,Payment_Method,Total_Sales,Quantity,Unit_Price,Discount,Shipping,Tax,Customer_ID,Channel,Currency,Status",
      ...rows,
    ].join("\n"),
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("derived grouping on the public aggregate handler", () => {
  it.each([
    {
      by: "year",
      rows: [
        [2016, 3],
        [2020, 1],
        [2021, 2],
      ],
    },
    {
      by: "quarter",
      rows: [
        ["2016-Q1", 3],
        ["2020-Q4", 1],
        ["2021-Q1", 2],
      ],
    },
    {
      by: "day",
      rows: [
        ["2016-01-01", 1],
        ["2016-01-03", 1],
        ["2016-01-04", 1],
        ["2020-12-31", 1],
        ["2021-01-01", 1],
        ["2021-01-04", 1],
      ],
    },
    {
      by: "weekday",
      rows: [
        [1, 2],
        [4, 1],
        [5, 2],
        [7, 1],
      ],
    },
    {
      by: "hour",
      rows: [
        [0, 5],
        [1, 1],
      ],
    },
  ] as const)("returns the documented UTC $by keys", async ({ by, rows }) => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "dates.csv",
        range: "A1:C7",
        groupBy: [{ column: "Date", by }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(result["rows"]).toEqual(rows);
  });

  it("accepts clock times for hour grouping and reports invalid clocks", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "hours.csv",
        groupBy: [{ column: "Time", by: "hour" }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(result["rows"]).toEqual([
      [9, 1],
      [23, 1],
    ]);
    expect(result["ungroupedRows"]).toBe(2);
    expect(result["warnings"]).toEqual(
      expect.arrayContaining([expect.stringContaining("24:00:00")]),
    );
  });

  it("uses the ISO week-year and reports unreadable keys separately from missing keys", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "dates.csv",
        groupBy: [{ column: "Date", by: "week" }],
        metrics: [{ fn: "count" }, { fn: "sum", column: "Amount" }],
      }),
    );
    expect(result["rows"]).toEqual([
      ["2015-W53", 2, 3],
      ["2016-W01", 1, 3],
      ["2020-W53", 2, 9],
      ["2021-W01", 1, 6],
      [null, 1, 8],
    ]);
    expect(result["matchedRows"]).toBe(8);
    expect(result["ungroupedRows"]).toBe(1);
    expect(result["returnedMatchedRows"]).toBe(7);
    expect(result["warnings"]).toEqual(
      expect.arrayContaining([expect.stringContaining("not a date")]),
    );
  });

  it("uses UTC after an explicit offset and keeps different years apart in monthly groups", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "dates.csv",
        range: "A1:C7",
        groupBy: [{ column: "Date", by: "month" }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(result["rows"]).toEqual([
      ["2016-01", 3],
      ["2020-12", 1],
      ["2021-01", 2],
    ]);
  });

  it("makes explicit bins left-closed and right-open, including both tails", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "buckets.csv",
        groupBy: [{ column: "Amount", bins: [0, 100, 500] }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(result["rows"]).toEqual([
      ["(-inf, 0)", 1],
      ["[0, 100)", 2],
      ["[100, 500)", 2],
      ["[500, +inf)", 1],
    ]);
    expect(result["columns"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          interval: "[lower, upper)",
          bins: [0, 100, 500],
        }),
      ]),
    );
    expect(result["ungroupedRows"]).toBe(1);
  });

  it("keeps decimal width boundaries exact without snapping a neighbouring representable number across them", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "decimal-buckets.csv",
        groupBy: [{ column: "Amount", width: 0.1 }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(result["rows"]).toEqual([
      ["[-0.3, -0.2)", 1],
      ["[-0.2, -0.1)", 1],
      ["[0.1, 0.2)", 1],
      ["[0.2, 0.3)", 2],
      ["[0.3, 0.4)", 1],
    ]);
  });

  it("normalizes explicitly numeric keys while leaving a plain grouping and raw read intact", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "keys.csv",
        groupBy: ["Amount"],
        columns: [{ column: "Amount", type: "number", decimal: "," }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(result["rows"]).toEqual([
      [123, 1],
      [1234.5, 2],
    ]);
    const raw = body(
      await handlers.aggregate_sheet({
        filePath: "keys.csv",
        groupBy: ["Amount"],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(raw["groupCount"]).toBe(3);
    expect(
      body(await handlers.read_sheet({ filePath: "keys.csv" }))["values"],
    ).toEqual([["1.234,50"], ["1234,5"], ["00123"]]);
  });
});

describe("bounded pivot and conditional percentiles", () => {
  it("keeps the known-answer quantiles under 32 seeded row permutations and mixed numeric spellings", async () => {
    for (let seed = 1; seed <= 32; seed += 1) {
      const values = [
        "5",
        "-100",
        '"1,000.0"',
        "4",
        "-1",
        "90",
        "0",
        "-9",
        "5",
      ];
      let random = seed;
      for (let at = values.length - 1; at > 0; at -= 1) {
        random ^= random << 13;
        random ^= random >>> 17;
        random ^= random << 5;
        const pick = (random >>> 0) % (at + 1);
        const current = values[at];
        const other = values[pick];
        if (current === undefined || other === undefined)
          throw new Error("Permutation index is out of range");
        values[at] = other;
        values[pick] = current;
      }
      await writeFile(
        join(directory, "permuted.csv"),
        ["Value", ...values].join("\n"),
      );
      const result = body(
        await handlers.aggregate_sheet({
          filePath: "permuted.csv",
          metrics: [
            { fn: "count" },
            { fn: "sum", column: "Value" },
            { fn: "median", column: "Value" },
            { fn: "percentile", column: "Value", percentile: 0.3 },
            { fn: "p90", column: "Value" },
          ],
        }),
      );
      const rows = result["rows"] as number[][];
      expect(rows[0]?.slice(0, 3), `seed ${seed}`).toEqual([9, 994, 4]);
      expect(rows[0]?.[3], `seed ${seed}`).toBeCloseTo(-0.6, 12);
      expect(rows[0]?.[4], `seed ${seed}`).toBeCloseTo(272, 10);
    }
  });

  it("includes both percentile endpoints and interpolates opposite finite extremes without overflow", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "extremes.csv",
        metrics: [
          { fn: "percentile", column: "Value", percentile: 0 },
          { fn: "median", column: "Value" },
          { fn: "percentile", column: "Value", percentile: 1 },
        ],
      }),
    );
    expect(result["rows"]).toEqual([[-Number.MAX_VALUE, 0, Number.MAX_VALUE]]);
  });

  it("keeps an empty top-level filter separate from a metric filter that excluded every row", async () => {
    const none = body(
      await handlers.aggregate_sheet({
        filePath: "percentiles.csv",
        where: [{ column: "Kind", op: "eq", value: "absent" }],
        metrics: [
          { fn: "countValues", column: "Value" },
          { fn: "p90", column: "Value" },
        ],
      }),
    );
    expect(none["matchedRows"]).toBe(0);
    expect(none["rows"]).toEqual([[0, null]]);
    expect(none["columnStats"]).toBeUndefined();
    const filtered = body(
      await handlers.aggregate_sheet({
        filePath: "percentiles.csv",
        metrics: [
          {
            fn: "p90",
            column: "Value",
            where: [{ column: "Kind", op: "gt", value: 1 }],
          },
        ],
      }),
    );
    expect(filtered["matchedRows"]).toBe(5);
    expect(filtered["rows"]).toEqual([[null]]);
    expect(filtered["columns"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ counted: 0, skipped: 0, filtered: 5 }),
      ]),
    );
    expect(filtered["warnings"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("metrics[1].where Kind gt: 5 cells"),
      ]),
    );
  });

  it("retains CSV quality counts when compact output omits repeated format metadata", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "quality.csv",
        compact: true,
        metrics: [{ fn: "count" }],
      }),
    );
    expect(result["mode"]).toBeUndefined();
    expect(result["csv"]).toEqual({
      raggedRecordCount: 1,
      formulaLikeCellCount: 1,
    });
  });

  it("agrees with the Microsoft PERCENTILE.INC example and conditions each metric independently", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "percentiles.csv",
        metrics: [
          { fn: "count" },
          {
            fn: "percentile",
            column: "Value",
            percentile: 0.3,
            where: [{ column: "Kind", op: "eq", value: "keep" }],
          },
          { fn: "median", column: "Value" },
          { fn: "p50", column: "Value" },
          { fn: "p90", column: "Value" },
          { fn: "count", where: [{ column: "Kind", op: "eq", value: "drop" }] },
        ],
      }),
    );
    const rows = result["rows"] as number[][];
    expect(rows[0]?.[0]).toBe(5);
    expect(rows[0]?.[1]).toBeCloseTo(1.9, 12);
    expect(rows[0]?.slice(2, 4)).toEqual([3, 3]);
    expect(rows[0]?.[4]).toBeCloseTo(61.6, 12);
    expect(rows[0]?.[5]).toBe(1);
    expect(result["columns"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fn: "percentile",
          counted: 4,
          skipped: 0,
          filtered: 1,
          percentile: 0.3,
        }),
      ]),
    );
  });

  it("returns a dense pivot and keeps a missing combination distinct from a zero total", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "pivot.csv",
        groupBy: ["Country"],
        pivotBy: ["Category"],
        metrics: [{ fn: "sum", column: "Sales" }, { fn: "count" }],
      }),
    );
    expect(result["rows"]).toEqual([
      ["Brazil", null, 0, 30, 1],
      ["Japan", 20, 1, 10, 1],
    ]);
    expect(result["columns"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fn: "sum", pivotKey: ["Books"] }),
        expect.objectContaining({ fn: "count", pivotKey: ["Food"] }),
      ]),
    );
  });

  it.each([
    { fn: "percentile", column: "Value" },
    { fn: "percentile", column: "Value", percentile: -0.1 },
    { fn: "percentile", column: "Value", percentile: 1.1 },
    { fn: "median", column: "Value", percentile: 0.5 },
  ] as const)("refuses an invalid percentile contract: %j", async (metric) => {
    const result = await handlers.aggregate_sheet({
      filePath: "percentiles.csv",
      metrics: [metric],
    });
    expect(result.isError).toBe(true);
    expect(body(result)["error"]).toBe("invalid_argument");
  });

  it.each([
    { column: "Value", bins: [1, 1] },
    { column: "Value", bins: [2, 1] },
    { column: "Value", width: 0 },
    { column: "Value", width: -1 },
  ])("refuses invalid interval geometry: %j", async (group) => {
    const result = await handlers.aggregate_sheet({
      filePath: "percentiles.csv",
      groupBy: [group],
      metrics: [{ fn: "count" }],
    });
    expect(result.isError).toBe(true);
    expect(body(result)["error"]).toBe("invalid_argument");
  });

  it("refuses a width whose finite boundaries collapse at the input magnitude", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "extremes.csv",
      groupBy: [{ column: "Value", width: Number.MIN_VALUE }],
      metrics: [{ fn: "count" }],
    });
    expect(result.isError).toBe(true);
    expect(body(result)["error"]).toBe("numeric_overflow");
  });
});

it("produces a 2000-row, 15-column, 36-month commerce dashboard in one bounded response", async () => {
  const result = await handlers.aggregate_sheet({
    filePath: "global_ecommerce_sales.csv",
    metrics: [{ fn: "count" }, { fn: "sum", column: "Total_Sales" }],
    groupingSets: [
      { groupBy: ["Country"] },
      { groupBy: ["Product_Category"] },
      { groupBy: ["Payment_Method"] },
      { groupBy: [{ column: "Order_Date", by: "month" }] },
    ],
    compact: true,
  });
  const response = body(result);
  expect(result.isError).not.toBe(true);
  expect(response["rows"]).toEqual([[2000, 20000]]);
  const sets = response["groupingSets"] as Record<string, unknown>[];
  expect(sets[0]?.["rows"]).toEqual([
    ["Brasil", 500, 5000],
    ["Deutschland", 500, 5000],
    ["Türkiye", 500, 5000],
    ["日本", 500, 5000],
  ]);
  expect(sets[1]?.["rows"]).toEqual([
    ["Books", 400, 4000],
    ["Clothing", 400, 4000],
    ["Electronics", 400, 4000],
    ["Food", 400, 4000],
    ["Home", 400, 4000],
  ]);
  expect(sets[2]?.["rows"]).toEqual([
    ["Bank", 500, 5000],
    ["Card", 500, 5000],
    ["Cash", 500, 5000],
    ["Wallet", 500, 5000],
  ]);
  expect(sets[3]?.["rows"]).toEqual(monthTotals);
  expect(response["scannedRows"]).toBe(2000);
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  expect(Buffer.byteLength(content.text, "utf8")).toBeLessThan(8000);
});
