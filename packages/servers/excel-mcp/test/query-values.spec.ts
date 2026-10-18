import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { limits } from "../src/platform/limits.js";
import type { ToolHandlers } from "../src/tools/definitions.js";
import { createHandlers } from "../src/tools/handlers.js";

const prefix = "p".repeat(limits.maxStringChars + 40);
const alpha = `${prefix}CUSTOMER-ALPHA`;
const beta = `${prefix}CUSTOMER-BETA`;

let directory: string;
let handlers: ToolHandlers;

function body(result: CallToolResult): Record<string, unknown> {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  return JSON.parse(content.text) as Record<string, unknown>;
}

function rowsOf(result: CallToolResult): readonly (readonly unknown[])[] {
  return body(result)["rows"] as readonly (readonly unknown[])[];
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-query-values-"));
  handlers = createHandlers(await createWorkbookRoot(directory));

  const long = new ExcelJS.Workbook();
  const sheet = long.addWorksheet("Long");
  sheet.addRow(["name", "cached"]);
  sheet.addRow([alpha, { formula: "A2", result: alpha }]);
  sheet.addRow([beta, { formula: "A3", result: beta }]);
  await long.xlsx.writeFile(join(directory, "long.xlsx"));

  const sparse = new ExcelJS.Workbook();
  const far = sparse.addWorksheet("Far");
  far.getCell("A1").value = "kind";
  far.getCell("A2").value = "x";
  far.getCell(200_000, 5_000).value = 7;
  await sparse.xlsx.writeFile(join(directory, "sparse.xlsx"));

  await writeFile(
    join(directory, "cities.csv"),
    Buffer.concat([
      Buffer.from([0xfe]),
      Buffer.from("ehir;tutar\n"),
      Buffer.from([0xdd]),
      Buffer.from("zmir;10\n"),
      Buffer.from([0xdd]),
      Buffer.from("zmir;5\nAnkara;1\n"),
    ]),
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("queries read the whole value, responses show the shortened one", () => {
  for (const column of ["name", "cached"]) {
    it(`keeps two long values apart in ${column}`, async () => {
      const distinct = await handlers.aggregate_sheet({
        filePath: "long.xlsx",
        metrics: [{ fn: "countDistinct", column }],
      });
      expect(rowsOf(distinct)[0]?.[0]).toBe(2);

      const grouped = await handlers.aggregate_sheet({
        filePath: "long.xlsx",
        groupBy: [column],
        metrics: [{ fn: "count" }],
      });
      expect(rowsOf(grouped)).toHaveLength(2);
      for (const row of rowsOf(grouped)) {
        expect(String(row[0]).length).toBeLessThanOrEqual(
          limits.maxStringChars,
        );
      }

      const filtered = await handlers.aggregate_sheet({
        filePath: "long.xlsx",
        where: [{ column, op: "endsWith", value: "customer-alpha" }],
        metrics: [{ fn: "count" }],
      });
      expect(rowsOf(filtered)[0]?.[0]).toBe(1);

      const equal = await handlers.aggregate_sheet({
        filePath: "long.xlsx",
        where: [{ column, op: "eq", value: beta }],
        metrics: [{ fn: "count" }],
      });
      expect(rowsOf(equal)[0]?.[0]).toBe(1);
    });
  }

  it("finds a suffix past the display cut and returns the shortened value", async () => {
    const found = body(
      await handlers.find_in_sheet({ filePath: "long.xlsx", query: "ALPHA" }),
    );
    const matches = found["matches"] as readonly { value: string }[];
    expect(matches).toHaveLength(2);
    for (const match of matches) {
      expect(match.value.length).toBeLessThanOrEqual(limits.maxStringChars);
    }
  });

  it("does not match a longer cell exactly against its shortened prefix", async () => {
    const found = body(
      await handlers.find_in_sheet({
        filePath: "long.xlsx",
        query: prefix.slice(0, limits.maxStringChars),
        matchMode: "exact",
      }),
    );
    expect(found["matches"]).toStrictEqual([]);
  });
});

describe("a sparse sheet costs its populated cells, not its rectangle", () => {
  it("folds the absent rows into the null group with the right counts", async () => {
    const result = body(
      await handlers.aggregate_sheet({
        filePath: "sparse.xlsx",
        groupBy: ["kind"],
        metrics: [{ fn: "count" }, { fn: "countValues", column: "kind" }],
      }),
    );
    expect(result["scannedRows"]).toBe(199_999);
    expect(result["matchedRows"]).toBe(199_999);
    expect(result["blankRows"]).toBe(199_997);
    expect(result["rows"]).toHaveLength(2);
    expect(result["rows"]).toEqual(
      expect.arrayContaining([
        ["x", 1, 1],
        [null, 199_998, 0],
      ]),
    );
  });

  it("filters the absent rows like any blank row", async () => {
    const result = await handlers.aggregate_sheet({
      filePath: "sparse.xlsx",
      where: [{ column: "kind", op: "isEmpty" }],
      metrics: [{ fn: "count" }],
    });
    expect(rowsOf(result)[0]?.[0]).toBe(199_998);
  });

  it("finds the far corner", async () => {
    const found = body(
      await handlers.find_in_sheet({ filePath: "sparse.xlsx", query: "7" }),
    );
    expect(found["matches"]).toMatchObject([{ row: 200_000, column: 5_000 }]);
  });
});

describe("aggregate_sheet parses a csv the way read_sheet does", () => {
  it("honours delimiter and encoding", async () => {
    const csv = { delimiter: "semicolon", encoding: "windows-1254" } as const;
    const read = body(
      await handlers.read_sheet({ filePath: "cities.csv", ...csv }),
    );
    const values = read["values"] as readonly (readonly unknown[])[];
    const expected = new Map<string, number>();
    for (const [city, amount] of values) {
      if (!Number.isFinite(Number(amount))) continue;
      expected.set(
        String(city),
        (expected.get(String(city)) ?? 0) + Number(amount),
      );
    }

    const result = await handlers.aggregate_sheet({
      filePath: "cities.csv",
      ...csv,
      groupBy: ["şehir"],
      metrics: [{ fn: "sum", column: "tutar" }],
    });
    expect(new Map(rowsOf(result) as [string, number][])).toStrictEqual(
      expected,
    );
    expect(expected.get("İzmir")).toBe(15);
  });
});
