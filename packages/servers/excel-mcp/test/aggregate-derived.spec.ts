import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { roundTo } from "../src/grid/derived.js";
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

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-derived-"));
  handlers = createHandlers(await createWorkbookRoot(directory));
  await writeFile(
    join(directory, "units.csv"),
    "Mahalle,Yapi,Bagimsiz\nA,10,25\nB,20,30\nC,4,12\nD,0,5\n",
  );
  await writeFile(
    join(directory, "roads.csv"),
    "Mahalle,Yol\nA,x\nB,y\nE,z\na,w\n",
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const perNeighbourhood = {
  filePath: "units.csv",
  groupBy: ["Mahalle"],
  metrics: [
    { fn: "sum" as const, column: "Yapi" },
    { fn: "sum" as const, column: "Bagimsiz" },
  ],
};

describe("derived metrics", () => {
  it("ranks groups by a ratio of two metrics and nulls a zero denominator", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        ...perNeighbourhood,
        derived: [
          {
            name: "density",
            numerator: [{ metric: 2 }],
            denominator: [{ metric: 1 }],
            round: 3,
          },
        ],
        orderBy: "metric",
        orderByDerived: "density",
        descending: true,
      }),
    );
    expect(result["rows"]).toEqual([
      ["C", 4, 12, 3],
      ["A", 10, 25, 2.5],
      ["B", 20, 30, 1.5],
      ["D", 0, 5, null],
    ]);
    expect(result["columns"]).toContainEqual({
      label: "density",
      role: "derived",
    });
    expect(result["warnings"]).toContainEqual(
      expect.objectContaining({ code: "derived_division_by_zero" }),
    );
  });

  it("gives each group its share of the total over every group", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        ...perNeighbourhood,
        derived: [
          {
            name: "share",
            numerator: [{ metric: 1 }],
            denominator: [{ metric: 1, scope: "total" }],
            scale: 100,
            round: 1,
          },
        ],
        maxGroups: 2,
      }),
    );
    expect(result["rows"]).toEqual([
      ["A", 10, 25, 29.4],
      ["B", 20, 30, 58.8],
    ]);
  });

  it("adjusts a whole-range total with a weighted second metric", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "units.csv",
        metrics: [
          { fn: "sum", column: "Yapi" },
          {
            fn: "sum",
            column: "Yapi",
            where: [{ column: "Bagimsiz", op: "gt", value: 20 }],
          },
          { fn: "avg", column: "Yapi", round: 0 },
        ],
        derived: [
          {
            name: "raised",
            numerator: [{ metric: 1 }, { metric: 2, factor: 0.1 }],
            round: 2,
          },
        ],
      }),
    );
    expect(result["rows"]).toEqual([[34, 30, 9, 37]]);
  });

  it("refuses the total of a metric that does not add up across groups", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        ...perNeighbourhood,
        metrics: [{ fn: "avg", column: "Yapi" }],
        derived: [
          {
            name: "share",
            numerator: [{ metric: 1 }],
            denominator: [{ metric: 1, scope: "total" }],
          },
        ],
      }),
    );
    expect(result).toMatchObject({
      error: "invalid_argument",
      message: expect.stringContaining("does not add up across groups"),
    });
  });

  it.each([
    [1.005, 2, 1.01],
    [2.5, 0, 3],
    [-2.5, 0, -3],
    [0.125, 2, 0.13],
  ])(
    "rounds %d to %d places as Excel ROUND does: %d",
    (value, digits, expected) => {
      expect(roundTo(value, digits)).toBe(expected);
    },
  );
});

describe("a column tested against another file's column", () => {
  it("keeps the rows whose key the other list lacks, in each direction", async () => {
    const onlyInUnits = body(
      await handlers.aggregate_sheet({
        filePath: "units.csv",
        groupBy: ["Mahalle"],
        metrics: [{ fn: "count" }],
        where: [
          {
            column: "Mahalle",
            op: "notInColumn",
            source: { filePath: "roads.csv", column: "Mahalle" },
          },
        ],
      }),
    );
    expect(onlyInUnits["rows"]).toEqual([
      ["C", 1],
      ["D", 1],
    ]);
    const onlyInRoads = body(
      await handlers.aggregate_sheet({
        filePath: "roads.csv",
        groupBy: ["Mahalle"],
        metrics: [{ fn: "count" }],
        where: [
          {
            column: "Mahalle",
            op: "notInColumn",
            source: { filePath: "units.csv", column: "Mahalle" },
          },
        ],
      }),
    );
    expect(onlyInRoads["rows"]).toEqual([["E", 1]]);
  });

  it("keeps the rows whose key the other list holds", async () => {
    const shared = body(
      await handlers.aggregate_sheet({
        filePath: "units.csv",
        metrics: [{ fn: "sum", column: "Yapi" }],
        where: [
          {
            column: "Mahalle",
            op: "inColumn",
            source: { filePath: "roads.csv", column: "Mahalle" },
          },
        ],
      }),
    );
    expect(shared["rows"]).toEqual([[30]]);
  });

  it("refuses a source on an operator that takes none", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "units.csv",
        metrics: [{ fn: "count" }],
        where: [
          {
            column: "Mahalle",
            op: "eq",
            value: "A",
            source: { column: "Mahalle" },
          },
        ],
      }),
    );
    expect(result).toMatchObject({
      error: "invalid_argument",
      message: expect.stringContaining("takes no source"),
    });
  });
});
