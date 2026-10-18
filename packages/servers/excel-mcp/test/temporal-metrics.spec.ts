import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classify } from "../src/grid/predicate.js";
import { createWorkbookRoot } from "../src/platform/paths.js";
import {
  toolDefinitions,
  type ToolHandlers,
} from "../src/tools/definitions.js";
import { createHandlers } from "../src/tools/handlers.js";

let directory: string;
let handlers: ToolHandlers;

function body(result: CallToolResult): Record<string, unknown> {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  return JSON.parse(content.text) as Record<string, unknown>;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-temporal-"));
  handlers = createHandlers(await createWorkbookRoot(directory));
  await writeFile(
    join(directory, "clocks.csv"),
    ["Time", "09:30", "1:30:00", "23:59:59", "24:00:00", "99:99:99"].join("\n"),
  );
  await writeFile(
    join(directory, "flags.csv"),
    ["Flag", "Evet", "Hayır", "TRUE", "FALSE", "N/A", "maybe"].join("\n"),
  );
  await writeFile(
    join(directory, "durations.csv"),
    ["Duration", "01:30", "36:00", "PT1H", "-PT30M", "bad", "N/A"].join("\n"),
  );
  await writeFile(
    join(directory, "pure-clocks.csv"),
    ["Time", "09:30", "1:30:00"].join("\n"),
  );
  await writeFile(
    join(directory, "fractions.csv"),
    [
      "Time",
      "1:30:00.2500",
      "01:30:00.25",
      "01:30:00.250000001",
      "01:30:00.249999999",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "custom-flags.csv"),
    ["Flag", "-", "NULL", "0", "YES", "MISSING"].join("\n"),
  );
  await writeFile(
    join(directory, "duration-keys.csv"),
    ["Duration", "01:30", "PT1H30M", "-PT30M"].join("\n"),
  );
  await writeFile(
    join(directory, "units.csv"),
    ["Fraction,Money,Mixed", "25%,€10,1", "50%,€20,50%"].join("\n"),
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("shared temporal and boolean aggregate readings", () => {
  it("groups valid CSV clocks by hour and counts invalid clocks", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "clocks.csv",
        groupBy: [{ column: "Time", by: "hour" }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(result["rows"]).toEqual([
      [1, 1],
      [9, 1],
      [23, 1],
    ]);
    expect(result["ungroupedRows"]).toBe(2);
  });

  it("does not classify invalid calendar or clock fields as typed values", () => {
    expect(classify("2025-02-29")).toBe("text");
    expect(classify("2024-02-29")).toBe("date");
    expect(classify("99:99:99")).toBe("text");
    expect(classify("23:59:60")).toBe("text");
    expect(classify("23:59:59.25")).toBe("time");
  });

  it("counts boolean values and excludes missing and unreadable values from the ratio", async () => {
    const input = toolDefinitions.aggregate_sheet.inputSchema.parse({
      filePath: "flags.csv",
      metrics: [
        { fn: "countTrue", column: "Flag" },
        { fn: "countFalse", column: "Flag" },
        { fn: "trueRatio", column: "Flag" },
        { fn: "countValues", column: "Flag" },
      ],
    });
    const result = body(await handlers.aggregate_sheet(input));
    expect(result["rows"]).toEqual([[2, 2, 0.5, 5]]);
    expect(result["columns"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fn: "trueRatio", counted: 4, skipped: 2 }),
      ]),
    );
  });

  it("reads elapsed and fixed ISO durations consistently in numeric metrics", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "durations.csv",
        metrics: [
          { fn: "sum", column: "Duration" },
          { fn: "avg", column: "Duration" },
          { fn: "median", column: "Duration" },
          { fn: "countValues", column: "Duration" },
        ],
      }),
    );
    expect(result["rows"]).toEqual([[136800, 34200, 4500, 5]]);
    expect(
      (result["columns"] as Record<string, unknown>[]).slice(0, 3),
    ).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({ unit: "seconds", counted: 4, skipped: 2 }),
      ),
    );
    expect(result["warnings"]).toEqual(
      expect.arrayContaining([expect.stringContaining("bad")]),
    );
    const extrema = body(
      await handlers.aggregate_sheet({
        filePath: "durations.csv",
        range: "A1:A5",
        metrics: [
          { fn: "min", column: "Duration" },
          { fn: "max", column: "Duration" },
        ],
      }),
    );
    expect(extrema["rows"]).toEqual([[-1800, 129600]]);
  });

  it("keeps pure clocks out of sum until duration is explicitly selected", async () => {
    const metrics = [{ fn: "sum" as const, column: "Time" }];
    expect(
      body(
        await handlers.aggregate_sheet({
          filePath: "pure-clocks.csv",
          metrics,
        }),
      )["rows"],
    ).toEqual([[null]]);
    const explicit = toolDefinitions.aggregate_sheet.inputSchema.parse({
      filePath: "pure-clocks.csv",
      columns: [{ column: "Time", type: "duration" }],
      metrics,
    });
    expect(body(await handlers.aggregate_sheet(explicit))["rows"]).toEqual([
      [39600],
    ]);
  });

  it("compares equivalent fractional precision without losing adjacent nanoseconds", async () => {
    const equal = body(
      await handlers.aggregate_sheet({
        filePath: "fractions.csv",
        where: [{ column: "Time", op: "eq", value: "01:30:00.250" }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(equal["rows"]).toEqual([[2]]);
    const above = body(
      await handlers.aggregate_sheet({
        filePath: "fractions.csv",
        where: [{ column: "Time", op: "gt", value: "01:30:00.25" }],
        metrics: [{ fn: "count" }],
      }),
    );
    expect(above["rows"]).toEqual([[1]]);
    const extrema = body(
      await handlers.aggregate_sheet({
        filePath: "fractions.csv",
        metrics: [
          { fn: "min", column: "Time" },
          { fn: "max", column: "Time" },
        ],
      }),
    );
    expect(extrema["rows"]).toEqual([
      ["01:30:00.249999999", "01:30:00.250000001"],
    ]);
  });

  it("supports typed boolean predicates and preserves raw distinct identities", async () => {
    const input = toolDefinitions.aggregate_sheet.inputSchema.parse({
      filePath: "flags.csv",
      metrics: [
        {
          fn: "countTrue",
          column: "Flag",
          where: [{ column: "Flag", op: "eq", value: true }],
        },
        {
          fn: "trueRatio",
          column: "Flag",
          where: [{ column: "Flag", op: "in", values: [true, false] }],
        },
        { fn: "countDistinct", column: "Flag" },
      ],
    });
    const result = body(await handlers.aggregate_sheet(input));
    expect(result["rows"]).toEqual([[2, 0.5, 5]]);
    expect(result["columns"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fn: "countTrue",
          counted: 2,
          skipped: 0,
          filtered: 4,
        }),
        expect.objectContaining({
          fn: "trueRatio",
          counted: 4,
          skipped: 0,
          filtered: 2,
          unit: "fraction",
        }),
      ]),
    );
    expect(
      body(
        await handlers.aggregate_sheet({
          filePath: "flags.csv",
          where: [{ column: "Flag", op: "eq", value: true }],
          metrics: [{ fn: "count" }],
        }),
      )["rows"],
    ).toEqual([[2]]);
  });

  it("uses null semantics for configured missing literals without changing native errors", async () => {
    const input = toolDefinitions.aggregate_sheet.inputSchema.parse({
      filePath: "flags.csv",
      where: [{ column: "Flag", op: "isEmpty" }],
      metrics: [
        { fn: "count" },
        { fn: "countTrue", column: "Flag" },
        { fn: "trueRatio", column: "Flag" },
      ],
    });
    const result = body(await handlers.aggregate_sheet(input));
    expect(result["rows"]).toEqual([[1, 0, null]]);
    expect(result["columnStats"]).toEqual({
      A: { texts: 1, missingLiterals: 1 },
    });
    expect(classify({ error: "#N/A" })).toBe("error");
  });

  it("lets per-column token lists replace request defaults", async () => {
    const input = toolDefinitions.aggregate_sheet.inputSchema.parse({
      filePath: "custom-flags.csv",
      missingValues: ["MISSING"],
      trueValues: ["YES"],
      falseValues: ["0"],
      columns: [{ column: "Flag", type: "boolean", missingValues: ["-"] }],
      metrics: [
        { fn: "countTrue", column: "Flag" },
        { fn: "countFalse", column: "Flag" },
        { fn: "countValues", column: "Flag" },
      ],
    });
    expect(body(await handlers.aggregate_sheet(input))["rows"]).toEqual([
      [1, 1, 4],
    ]);
  });

  it("canonicalizes explicit duration keys and labels pivot seconds", async () => {
    const input = toolDefinitions.aggregate_sheet.inputSchema.parse({
      filePath: "duration-keys.csv",
      columns: [{ column: "Duration", type: "duration" }],
      groupBy: ["Duration"],
      metrics: [{ fn: "count" }],
    });
    expect(body(await handlers.aggregate_sheet(input))["rows"]).toEqual([
      [{ durationSeconds: -1800 }, 1],
      [{ durationSeconds: 5400 }, 2],
    ]);
    const pivot = body(
      await handlers.aggregate_sheet({
        ...input,
        groupBy: [],
        pivotBy: ["Duration"],
      }),
    );
    expect(pivot["rows"]).toEqual([[1, 2]]);
    expect(pivot["columns"]).toEqual([
      expect.objectContaining({
        label: "-1800 s: count",
        pivotKey: [{ durationSeconds: -1800 }],
      }),
      expect.objectContaining({
        label: "5400 s: count",
        pivotKey: [{ durationSeconds: 5400 }],
      }),
    ]);
  });

  it("carries common numeric units and reports incompatible mixtures", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "units.csv",
        metrics: [
          { fn: "sum", column: "Fraction" },
          { fn: "sum", column: "Money" },
          { fn: "sum", column: "Mixed" },
        ],
      }),
    );
    expect(result["rows"]).toEqual([[0.75, 30, 1.5]]);
    const columns = result["columns"] as Record<string, unknown>[];
    expect(columns[0]).toMatchObject({ unit: "fraction" });
    expect(columns[1]).toMatchObject({ currency: "EUR" });
    expect(columns[2]).toMatchObject({ mixedUnits: true });
    expect(columns[2]).not.toHaveProperty("unit");
    expect(result["warnings"]).toEqual(
      expect.arrayContaining([
        "sum(Mixed) combines plain numbers, fractions or duration seconds; no common unit is assigned.",
      ]),
    );
  });
});
