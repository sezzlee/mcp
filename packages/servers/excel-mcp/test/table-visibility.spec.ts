import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createExcelMcpServer } from "../src/server.js";

let directory: string;
let client: Client;
let server: ReturnType<typeof createExcelMcpServer>;

async function request(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({
    name,
    arguments: { filePath: "tables.xlsx", ...args },
  });
  const content = response.content[0];
  if (content?.type !== "text") throw new Error("Missing text response");
  return {
    ...(JSON.parse(content.text) as Record<string, unknown>),
    isError: response.isError === true,
  };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-table-visibility-"));
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Introduction").addRows([["Outside"], [999]]);
  const sheet = book.addWorksheet("Sales");
  sheet.getCell("A1").value = 999;
  sheet.getRow(2).hidden = true;
  sheet.addTable({
    name: "Revenue_Q4",
    ref: "B3",
    headerRow: true,
    totalsRow: true,
    columns: [
      { name: "Region", totalsRowLabel: "Total" },
      { name: "Amount", totalsRowFunction: "sum" },
    ],
    rows: [
      ["West", 10],
      ["Hidden", 20],
      ["East", 30],
      ["North", 40],
    ],
  });
  sheet.getRow(5).hidden = true;
  sheet.getCell("C8").value = 100;
  const plain = book.addWorksheet("NoHeaders");
  plain.addTable({
    name: "Headerless",
    ref: "D5",
    headerRow: false,
    columns: [{ name: "Key" }, { name: "Count" }],
    rows: [
      ["First", 7],
      ["Second", 11],
    ],
  });
  const blank = book.addWorksheet("HiddenBlanks");
  blank.addRow(["Amount"]);
  blank.getCell("A2").value = 10;
  blank.getRow(3).hidden = true;
  blank.getCell("A4").value = 30;
  blank.getRow(4).hidden = true;
  blank.getCell("A5").value = 50;
  const filtered = book.addWorksheet("SavedFilter");
  filtered.addRows([
    ["Region", "Amount"],
    ["East", 5],
    ["West", 15],
  ]);
  filtered.autoFilter = "A1:B3";
  const leading = book.addWorksheet("LeadingHidden");
  leading.addRows([["Amount"], [10], [20], [30]]);
  leading.getRow(2).hidden = true;
  leading.getRow(4).hidden = true;
  const allHidden = book.addWorksheet("AllHidden");
  allHidden.addRows([["Amount"], [10], [20]]);
  allHidden.getRow(2).hidden = true;
  allHidden.getRow(3).hidden = true;
  const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
  const filterPart = zip.file("xl/worksheets/sheet5.xml");
  if (filterPart === null) throw new Error("Missing fixture worksheet");
  const blankPart = zip.file("xl/worksheets/sheet4.xml");
  if (blankPart === null)
    throw new Error("Missing blank-row fixture worksheet");
  const blankXml = await blankPart.async("string");
  if (blankXml.includes('<row r="3"'))
    throw new Error("The independent blank row would be duplicated");
  zip.file(
    "xl/worksheets/sheet4.xml",
    blankXml.replace('<row r="4"', '<row r="3" hidden="true"/><row r="4"'),
  );
  zip.file(
    "xl/worksheets/sheet5.xml",
    (await filterPart.async("string")).replace(
      '<autoFilter ref="A1:B3"/>',
      '<autoFilter ref="A1:B3"><filterColumn colId="0"><filters><filter val="East"/></filters></filterColumn></autoFilter>',
    ),
  );
  await writeFile(
    join(directory, "tables.xlsx"),
    await zip.generateAsync({ type: "nodebuffer" }),
  );
  const duplicate = await JSZip.loadAsync(
    await zip.generateAsync({ type: "nodebuffer" }),
  );
  const duplicatePart = duplicate.file("xl/tables/table2.xml");
  if (duplicatePart === null)
    throw new Error("Missing headerless table fixture");
  duplicate.file(
    "xl/tables/table2.xml",
    (await duplicatePart.async("string")).replaceAll(
      '"Headerless"',
      '"Revenue_Q4"',
    ),
  );
  await writeFile(
    join(directory, "duplicates.xlsx"),
    await duplicate.generateAsync({ type: "nodebuffer" }),
  );
  const unsupported = await JSZip.loadAsync(
    await zip.generateAsync({ type: "nodebuffer" }),
  );
  const unsupportedPart = unsupported.file("xl/tables/table1.xml");
  if (unsupportedPart === null)
    throw new Error("Missing counted table fixture");
  const originalTable = await unsupportedPart.async("string");
  if (!originalTable.includes('headerRowCount="1"'))
    throw new Error("Missing explicit table row count");
  unsupported.file(
    "xl/tables/table1.xml",
    originalTable.replace('headerRowCount="1"', 'headerRowCount="2"'),
  );
  await writeFile(
    join(directory, "unsupported-count.xlsx"),
    await unsupported.generateAsync({ type: "nodebuffer" }),
  );
  await writeFile(join(directory, "plain.csv"), "Amount\n10\n20");
  server = createExcelMcpServer(await createWorkbookRoot(directory));
  client = new Client({ name: "table-visibility-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
});

afterAll(async () => {
  await client.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

describe("named table bodies and saved row visibility", () => {
  it("finds a table across the workbook and pages visible rows with exact source row numbers", async () => {
    const first = await request("read_sheet", {
      table: "revenue_q4",
      visibleOnly: true,
      maxCells: 2,
    });
    expect(first["isError"]).toBe(false);
    expect(first).toMatchObject({
      sheet: "Sales",
      headerRow: 3,
      headerRowSource: "declared",
      table: {
        name: "Revenue_Q4",
        ref: "B3:C8",
        dataRange: "B4:C7",
        totalsRowExcluded: true,
      },
      values: [["West", 10]],
      rowNumbers: [4],
      visibility: {
        basis: "savedHiddenRows",
        hiddenRowsSkipped: 1,
        filterCriteriaReevaluated: false,
      },
    });
    const second = await request("read_sheet", {
      cursor: first["nextCursor"],
      maxCells: 2,
    });
    expect(second).toMatchObject({
      isError: false,
      values: [["East", 30]],
      rowNumbers: [6],
      table: { name: "Revenue_Q4" },
    });
    const third = await request("read_sheet", {
      cursor: second["nextCursor"],
      maxCells: 2,
    });
    expect(third).toMatchObject({
      isError: false,
      values: [["North", 40]],
      rowNumbers: [7],
      truncated: false,
    });
    expect(third["nextCursor"]).toBeUndefined();
    const conflict = await request("read_sheet", {
      cursor: first["nextCursor"],
      visibleOnly: false,
    });
    expect(conflict["isError"]).toBe(true);
    expect(conflict["message"]).toContain("visibleOnly");
  });

  it("excludes saved hidden rows, headers, totals and unrelated cells from analysis", async () => {
    const metrics = [{ fn: "sum", column: "Amount" }, { fn: "count" }];
    const all = await request("aggregate_sheet", {
      table: "Revenue_Q4",
      metrics,
    });
    const visible = await request("aggregate_sheet", {
      table: "Revenue_Q4",
      metrics,
      visibleOnly: true,
    });
    expect(all).toMatchObject({
      isError: false,
      range: "B4:C7",
      scannedRows: 4,
      rows: [[100, 4]],
    });
    expect(visible).toMatchObject({
      isError: false,
      scannedRows: 3,
      rows: [[80, 3]],
      visibility: { hiddenRowsSkipped: 1 },
    });
  });

  it("profiles a prefix of visible rows and reuses its table metadata names", async () => {
    const profile = await request("profile_sheet", {
      table: "Revenue_Q4",
      visibleOnly: true,
      maxRows: 2,
    });
    expect(profile).toMatchObject({
      isError: false,
      totalRows: 3,
      sampledRows: 2,
      omittedRows: 1,
      visibility: { hiddenRowsSkipped: 1 },
    });
    expect(profile["profiles"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          letter: "C",
          header: "Amount",
          min: 10,
          max: 30,
        }),
      ]),
    );
    const headerless = await request("aggregate_sheet", {
      table: "Headerless",
      metrics: [{ fn: "sum", column: "Count" }],
    });
    expect(headerless).toMatchObject({
      isError: false,
      headerRow: 0,
      rows: [[18]],
    });
  });

  it("searches the selected table body and counts hidden blank rows in visibility", async () => {
    const all = await request("find_in_sheet", {
      table: "Revenue_Q4",
      query: "Hidden",
    });
    expect(all).toMatchObject({
      isError: false,
      total: 1,
      matches: [{ address: "B5" }],
    });
    const visible = await request("find_in_sheet", {
      table: "Revenue_Q4",
      query: "Hidden",
      visibleOnly: true,
    });
    expect(visible).toMatchObject({
      isError: false,
      total: 0,
      scannedCells: 6,
      visibility: { hiddenRowsSkipped: 1 },
    });
    const blanks = await request("read_sheet", {
      sheetName: "HiddenBlanks",
      visibleOnly: true,
    });
    expect(blanks).toMatchObject({
      isError: false,
      values: [[10], [50]],
      rowNumbers: [2, 5],
      visibility: { hiddenRowsSkipped: 2 },
    });
  });

  it("states saved visibility when filter criteria exist without persisted hidden rows", async () => {
    const result = await request("aggregate_sheet", {
      sheetName: "SavedFilter",
      visibleOnly: true,
      metrics: [{ fn: "sum", column: "Amount" }],
    });
    expect(result).toMatchObject({
      isError: false,
      rows: [[20]],
      visibility: {
        basis: "savedHiddenRows",
        hiddenRowsSkipped: 0,
        autoFilterRef: "A1:B3",
        filterCriteriaReevaluated: false,
      },
    });
  });

  it("refuses conflicting addressing and missing tables without falling back to a sheet", async () => {
    for (const args of [
      { table: "Missing" },
      { table: "Revenue_Q4", sheetName: "Introduction" },
      { table: "Revenue_Q4", range: "B4:C7" },
      { table: "Revenue_Q4", headerRow: 1 },
      { table: "Revenue_Q4", filePath: "plain.csv" },
      { visibleOnly: true, filePath: "plain.csv" },
    ]) {
      expect((await request("read_sheet", args))["isError"]).toBe(true);
    }
  });

  it("does not reintroduce hidden rows as synthetic blanks and finishes an entirely hidden page", async () => {
    const leading = await request("aggregate_sheet", {
      sheetName: "LeadingHidden",
      visibleOnly: true,
      metrics: [{ fn: "sum", column: "Amount" }, { fn: "count" }],
    });
    expect(leading).toMatchObject({
      isError: false,
      rows: [[20, 1]],
      scannedRows: 1,
      blankRows: 0,
      firstScannedRow: 3,
      visibility: { hiddenRowsSkipped: 2 },
    });
    const all = await request("read_sheet", {
      sheetName: "AllHidden",
      visibleOnly: true,
      maxCells: 1,
    });
    expect(all).toMatchObject({
      isError: false,
      values: [],
      rowNumbers: [],
      returnedCells: 0,
      truncated: false,
      visibility: { hiddenRowsSkipped: 2 },
    });
    expect(all["nextCursor"]).toBeUndefined();
    const total = await request("aggregate_sheet", {
      sheetName: "AllHidden",
      visibleOnly: true,
      metrics: [{ fn: "count" }],
    });
    expect(total).toMatchObject({
      isError: false,
      rows: [[0]],
      scannedRows: 0,
      matchedRows: 0,
      blankRows: 0,
      visibility: { hiddenRowsSkipped: 2 },
    });
  });

  it("requires a sheet to disambiguate duplicate table names and refuses unsupported row counts", async () => {
    const ambiguous = await request("read_sheet", {
      filePath: "duplicates.xlsx",
      table: "Revenue_Q4",
    });
    expect(ambiguous["isError"]).toBe(true);
    expect(JSON.stringify(ambiguous)).toContain("ambiguous_table");
    const selected = await request("read_sheet", {
      filePath: "duplicates.xlsx",
      table: "Revenue_Q4",
      sheetName: "Sales",
    });
    expect(selected).toMatchObject({
      isError: false,
      values: [
        ["West", 10],
        ["Hidden", 20],
        ["East", 30],
        ["North", 40],
      ],
    });
    const unsupported = await request("read_sheet", {
      filePath: "unsupported-count.xlsx",
      table: "Revenue_Q4",
    });
    expect(unsupported["isError"]).toBe(true);
    expect(JSON.stringify(unsupported)).toContain("unsupported_object_kind");
  });
});
