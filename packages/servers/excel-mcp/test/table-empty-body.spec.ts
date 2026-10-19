import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createExcelMcpServer } from "../src/server.js";

it("reads a declared headerless table whose data cells are all absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "excel-empty-table-"));
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Blank").addTable({
    name: "BlankBody",
    ref: "D5",
    headerRow: false,
    columns: [{ name: "Key" }, { name: "Amount" }],
    rows: [
      [null, null],
      [null, null],
    ],
  });
  const bytes = await workbook.xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(bytes);
  const table = await zip.file("xl/tables/table1.xml")?.async("string");
  expect(table).toContain('ref="D5:E6"');
  expect(table).toContain('headerRowCount="0"');
  await writeFile(join(directory, "blank.xlsx"), Buffer.from(bytes));
  const server = createExcelMcpServer(await createWorkbookRoot(directory));
  const client = new Client({ name: "empty-table-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  try {
    const response = await client.callTool({
      name: "read_sheet",
      arguments: { filePath: "blank.xlsx", table: "BlankBody" },
    });
    const content = response.content[0];
    if (content?.type !== "text") throw new Error("Missing text response");
    expect(response.isError, content.text).not.toBe(true);
    expect(JSON.parse(content.text)).toMatchObject({
      sheet: "Blank",
      headerRow: 0,
      table: { name: "BlankBody", dataRange: "D5:E6" },
      values: [
        [null, null],
        [null, null],
      ],
      returnedRows: 2,
      returnedCells: 4,
      truncated: false,
    });
    const profile = await client.callTool({
      name: "profile_sheet",
      arguments: { filePath: "blank.xlsx", table: "BlankBody" },
    });
    const profileText = profile.content[0];
    if (profileText?.type !== "text")
      throw new Error("Missing profile response");
    expect(profile.isError, profileText.text).not.toBe(true);
    expect(JSON.parse(profileText.text)).toMatchObject({
      sheet: "Blank",
      range: "D5:E6",
      headerRow: 0,
      totalRows: 2,
      sampledRows: 2,
      omittedRows: 0,
      sampledCells: 4,
      profiles: [
        { letter: "D", header: "Key", missing: 2, inferredType: "empty" },
        { letter: "E", header: "Amount", missing: 2, inferredType: "empty" },
      ],
    });
    const aggregate = await client.callTool({
      name: "aggregate_sheet",
      arguments: {
        filePath: "blank.xlsx",
        table: "BlankBody",
        metrics: [{ fn: "count" }, { fn: "countValues", column: "Amount" }],
      },
    });
    const aggregateText = aggregate.content[0];
    if (aggregateText?.type !== "text")
      throw new Error("Missing aggregate response");
    expect(aggregate.isError, aggregateText.text).not.toBe(true);
    expect(JSON.parse(aggregateText.text)).toMatchObject({
      range: "D5:E6",
      headerRow: 0,
      rows: [[2, 0]],
      scannedRows: 2,
      blankRows: 2,
      matchedRows: 2,
    });
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
