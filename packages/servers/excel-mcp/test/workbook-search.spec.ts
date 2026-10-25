import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
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

function codesOf(result: CallToolResult): unknown[] {
  const warnings = (body(result)["warnings"] ?? []) as { code: unknown }[];
  return warnings.map((entry) => entry.code);
}

async function cutAt(row: number, name: string): Promise<void> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Data");
  sheet.getCell("A1").value = "month";
  sheet.getCell("B1").value = "amount";
  sheet.getCell("A2").value = "2023-11";
  sheet.getCell("B2").value = 5;
  sheet.getCell(row, 1).value = "2023-12";
  sheet.getCell(row, 2).value = 7;
  await book.xlsx.writeFile(join(directory, name));
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-workbook-search-"));
  handlers = createHandlers(await createWorkbookRoot(directory));

  const book = new ExcelJS.Workbook();
  book.addWorksheet("Cover").getCell("A1").value = "Station report";
  const summary = book.addWorksheet("Summary");
  summary.getCell("A1").value = "station";
  summary.getCell("A2").value = "RG2 Bluebell";
  summary.getCell("A3").value = "RG1 Weir";
  book.addWorksheet("Empty");
  const notes = book.addWorksheet("Notes");
  notes.getCell("B4").value = "Bluebell gauge moved in 2019";
  notes.state = "hidden";
  await book.xlsx.writeFile(join(directory, "stations.xlsx"));

  await cutAt(1_048_576, "cut.xlsx");
  await cutAt(1_048_575, "full.xlsx");
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("find_in_sheet without a sheet", () => {
  it("searches every worksheet and names each match's sheet", async () => {
    const found = body(
      await handlers.find_in_sheet({
        filePath: "stations.xlsx",
        query: "bluebell",
      }),
    );
    expect(found).toMatchObject({
      scope: "workbook",
      total: 2,
      truncated: false,
      matches: [
        { sheet: "Summary", address: "A2", value: "RG2 Bluebell" },
        {
          sheet: "Notes",
          address: "B4",
          value: "Bluebell gauge moved in 2019",
        },
      ],
    });
    expect(
      (found["sheets"] as { sheet: string; total: number }[]).map(
        ({ sheet, total }) => [sheet, total],
      ),
    ).toEqual([
      ["Cover", 0],
      ["Summary", 1],
      ["Notes", 1],
    ]);
  });

  it("shares maxResults across sheets and still counts every match", async () => {
    const found = body(
      await handlers.find_in_sheet({
        filePath: "stations.xlsx",
        query: "bluebell",
        maxResults: 1,
      }),
    );
    expect(found).toMatchObject({ total: 2, truncated: true });
    expect(found["matches"]).toHaveLength(1);
  });

  it("keeps the one-sheet answer when a sheet is named", async () => {
    const found = body(
      await handlers.find_in_sheet({
        filePath: "stations.xlsx",
        sheetName: "Notes",
        query: "bluebell",
      }),
    );
    expect(found).toMatchObject({ sheet: "Notes", total: 1 });
    expect(found["scope"]).toBeUndefined();
  });
});

describe("data that fills Excel's last row", () => {
  it("is flagged by describe, read, aggregate and profile", async () => {
    const described = body(
      await handlers.describe_workbook({ filePath: "cut.xlsx" }),
    );
    expect(described["guidance"]).toContain('"Data" reaches row 1048576');

    const input = { filePath: "cut.xlsx" };
    expect(
      codesOf(await handlers.read_sheet({ ...input, maxCells: 4 })),
    ).toContain("row_limit_reached");
    expect(
      codesOf(
        await handlers.aggregate_sheet({
          ...input,
          metrics: [{ column: "amount", fn: "sum" }],
        }),
      ),
    ).toContain("row_limit_reached");
    expect(codesOf(await handlers.profile_sheet(input))).toContain(
      "row_limit_reached",
    );
  });

  it("is not flagged one row short of the limit", async () => {
    const described = body(
      await handlers.describe_workbook({ filePath: "full.xlsx" }),
    );
    expect(String(described["guidance"])).not.toContain("reaches row");
    expect(
      codesOf(
        await handlers.aggregate_sheet({
          filePath: "full.xlsx",
          metrics: [{ column: "amount", fn: "sum" }],
        }),
      ),
    ).not.toContain("row_limit_reached");
  });
});
