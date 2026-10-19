import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createWorkbookRoot } from "../src/platform/paths.js";
import type { ToolHandlers } from "../src/tools/definitions.js";
import { createHandlers } from "../src/tools/handlers.js";

vi.mock("../src/platform/limits.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/platform/limits.js")>();
  return {
    ...original,
    limits: {
      ...original.limits,
      maxPivotCells: 8,
      maxAggregateSamples: 5,
      maxAggregateDistinctValues: 5,
      maxAggregateGroups: 16,
    },
  };
});

let directory: string;
let handlers: ToolHandlers;

function body(result: CallToolResult): Record<string, unknown> {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  return JSON.parse(content.text) as Record<string, unknown>;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-analysis-budget-"));
  handlers = createHandlers(await createWorkbookRoot(directory));
  await writeFile(
    join(directory, "values.csv"),
    ["Value,Label", "1,a", "2,b", "3,c", "4,d", "5,e", "6,f"].join("\n"),
  );
  await writeFile(
    join(directory, "sparse-pivot.csv"),
    ["Row,Column,Value", "A,X,1", "B,Y,2", "C,Z,3"].join("\n"),
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("analysis resource bounds on the real public handler", () => {
  it("refuses a 3x3 dense pivot despite only three populated intersections and maxGroups=1", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "sparse-pivot.csv",
      groupBy: ["Row"],
      pivotBy: ["Column"],
      metrics: [{ fn: "sum", column: "Value" }],
      maxGroups: 1,
    });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({
      error: "resource_limit",
      message: expect.stringContaining(
        "dense pivots require more than 8 cells",
      ),
    });
  });

  it("refuses exact percentile storage past its budget", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "values.csv",
      metrics: [{ fn: "p90", column: "Value" }],
    });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({
      error: "resource_limit",
      message: expect.stringContaining("more than 5 stored numeric values"),
    });
  });

  it("shares percentile storage across aliases of the same resolved column and filter columns", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "values.csv",
      range: "A1:B6",
      metrics: [
        {
          fn: "median",
          column: "Value",
          where: [{ column: "Label", op: "isNotEmpty" }],
        },
        { fn: "p90", column: "A", where: [{ column: "B", op: "isNotEmpty" }] },
      ],
    });
    expect(result.isError).not.toBe(true);
    expect(body(result)["rows"]).toEqual([[3, 4.6]]);
  });

  it("does not reset the sample budget for a second grouping set", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "values.csv",
      range: "A1:B4",
      metrics: [{ fn: "median", column: "Value" }],
      groupingSets: [{ groupBy: ["Label"] }],
    });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({
      error: "resource_limit",
      message: expect.stringContaining("more than 5 stored numeric values"),
    });
  });

  it("bounds retained distinct keys across grouping sets", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "values.csv",
      range: "A1:B4",
      metrics: [{ fn: "countDistinct", column: "Label" }],
      groupingSets: [{ groupBy: ["Value"] }],
    });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({
      error: "resource_limit",
      message: expect.stringContaining("more than 5 retained values"),
    });
  });

  it("refuses a sixth retained distinct key in an ordinary aggregation", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "values.csv",
      metrics: [{ fn: "countDistinct", column: "Label" }],
    });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({
      error: "resource_limit",
      message: expect.stringContaining("more than 5 retained values"),
    });
  });
});
