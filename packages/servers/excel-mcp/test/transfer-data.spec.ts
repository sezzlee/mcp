import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { read as independentRead } from "@e965/xlsx";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import {
  createWorkbookOutput,
  mutationReceiptSchema,
} from "../src/platform/versions.js";
import {
  transferReferenceSchema,
  transferReceiptSchema,
} from "../src/tools/transfer-schemas.js";
import { createExcelMcpServer } from "../src/server.js";
import { rawWorkbook } from "./fixtures/raw-workbook.js";

function payload(result: { readonly content: readonly unknown[] }): unknown {
  const block = result.content[0];
  if (
    typeof block !== "object" ||
    block === null ||
    !("text" in block) ||
    typeof block.text !== "string"
  )
    throw new Error("Expected a JSON tool result");
  return JSON.parse(block.text);
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(payload(result))).not.toBe(true);
  return payload(result);
}

async function prepare(
  client: Client,
  filePath: string,
  selection: Record<string, unknown>,
) {
  const ready = await call(client, "prepare_transfer", { filePath, selection });
  if (typeof ready !== "object" || ready === null || !("transfer" in ready))
    throw new Error("Expected a transfer reference");
  return transferReferenceSchema.parse(ready.transfer);
}

async function workspace(
  run: (directory: string, client: Client) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "excel-transfer-"));
  await mkdir(join(directory, "out"));
  const root = await createWorkbookRoot(directory);
  const server = createExcelMcpServer(root, {
    mode: "write",
    output: await createWorkbookOutput(root, "out"),
  });
  const client = new Client({ name: "transfer-acceptance", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    await run(directory, client);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

it("advertises transfer selections and targets as objects and decodes a JSON-encoded selection once", async () => {
  await workspace(async (directory, client) => {
    const tools = await client.listTools();
    expect(
      tools.tools.find((tool) => tool.name === "prepare_transfer")?.inputSchema,
    ).toMatchObject({
      properties: { selection: { type: "object" } },
    });
    expect(
      tools.tools.find((tool) => tool.name === "transfer_data")?.inputSchema,
    ).toMatchObject({
      properties: {
        transfer: {
          type: "object",
          properties: { selection: { type: "object" } },
        },
        target: { type: "object" },
      },
    });
    await writeFile(join(directory, "source.csv"), "Amount\n10\n");
    expect(
      await call(client, "prepare_transfer", {
        filePath: "source.csv",
        selection: '{"kind":"range"}',
      }),
    ).toEqual(
      await call(client, "prepare_transfer", {
        filePath: "source.csv",
        selection: { kind: "range" },
      }),
    );
    const rejected = await client.callTool({
      name: "prepare_transfer",
      arguments: { filePath: "source.csv", selection: "range A1:A2" },
    });
    expect(rejected.isError).toBe(true);
    expect(payload(rejected)).toMatchObject({
      error: "invalid_argument",
      message:
        "Invalid arguments for prepare_transfer: selection: Invalid input: expected object, received string.",
    });
  });
});

it("transfers every matching CSV record beyond a preview and preserves full text and identifiers", async () => {
  await workspace(async (directory, client) => {
    const longText = "Türkçe😀".repeat(1_000);
    const original =
      "ID,Amount,Note\n" +
      Array.from(
        { length: 1_025 },
        (_, i) =>
          `${String(i + 1).padStart(5, "0")},${i + 1},${i === 1_024 ? longText : "record"}`,
      ).join("\n");
    await writeFile(join(directory, "source.csv"), original);
    const preview = await call(client, "read_sheet", {
      filePath: "source.csv",
      maxCells: 20,
    });
    expect(preview).toMatchObject({ truncated: true });
    const transfer = await prepare(client, "source.csv", {
      kind: "records",
      headerRow: 1,
      columns: [{ column: "Amount", type: "number", decimal: "." }],
      where: [{ column: "Amount", op: "gte", value: 1 }],
    });
    const result = await call(client, "transfer_data", {
      transfer,
      target: { kind: "new", sheetName: "Export", startCell: "B2" },
    });
    expect(result).toMatchObject({
      transfer: {
        kind: "records",
        scope: "all",
        rows: 1_026,
        matchedRows: 1_025,
        columns: 3,
        cells: 3_078,
        recalculated: false,
      },
    });
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
    const receipt = transferReceiptSchema.parse(result);
    const workbook = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer" },
    );
    expect(workbook.Sheets.Export?.B3).toMatchObject({ t: "s", v: "00001" });
    expect(workbook.Sheets.Export?.C1027).toMatchObject({ t: "n", v: 1_025 });
    expect(workbook.Sheets.Export?.D1027).toMatchObject({
      t: "s",
      v: longText,
    });
    expect(await readFile(join(directory, "source.csv"), "utf8")).toBe(
      original,
    );
    expect(
      await call(client, "transfer_data", {
        transfer,
        target: { kind: "new", sheetName: "Export", startCell: "B2" },
      }),
    ).toEqual(result);
    expect(await readdir(join(directory, "out"))).toHaveLength(1);
  });
});

it("keeps an explicit subset and requested column order without widening it", async () => {
  await workspace(async (directory, client) => {
    await writeFile(
      join(directory, "source.csv"),
      "ID,Amount\n001,10\n002,15\n003,20\n",
    );
    const transfer = await prepare(client, "source.csv", {
      kind: "records",
      headerRow: 1,
      scope: { kind: "rows", rows: [2, 4] },
      selectColumns: ["Amount", "ID"],
      includeHeaders: false,
      columns: [{ column: "Amount", type: "number", decimal: "." }],
    });
    const result = await call(client, "transfer_data", {
      transfer,
      target: { kind: "new", sheetName: "Subset" },
    });
    expect(result).toMatchObject({
      transfer: { rows: 2, columns: 2, scope: "rows", matchedRows: 3 },
    });
    const receipt = transferReceiptSchema.parse(result);
    const sheet = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer" },
    ).Sheets.Subset;
    expect(sheet?.A1).toMatchObject({ t: "n", v: 10 });
    expect(sheet?.B1).toMatchObject({ t: "s", v: "001" });
    expect(sheet?.A2).toMatchObject({ t: "n", v: 20 });
    expect(sheet?.B2).toMatchObject({ t: "s", v: "003" });
    expect(sheet?.A3).toBeUndefined();
  });
});

it("exports a complete grouped summary beyond the reader's 500-group presentation cap", async () => {
  await workspace(async (directory, client) => {
    await writeFile(
      join(directory, "source.csv"),
      "Group,Amount\n" +
        Array.from(
          { length: 750 },
          (_, i) =>
            `g${String(i).padStart(3, "0")},2\ng${String(i).padStart(3, "0")},3`,
        ).join("\n"),
    );
    const transfer = await prepare(client, "source.csv", {
      kind: "aggregate",
      headerRow: 1,
      groupBy: ["Group"],
      metrics: [{ fn: "sum", column: "Amount" }],
    });
    const result = await call(client, "transfer_data", {
      transfer,
      target: { kind: "new", sheetName: "Summary" },
    });
    expect(result).toMatchObject({
      transfer: {
        kind: "aggregate",
        rows: 751,
        columns: 2,
        headerRows: 1,
        matchedRows: 1_500,
      },
    });
    const receipt = transferReceiptSchema.parse(result);
    const sheet = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer" },
    ).Sheets.Summary;
    expect(sheet?.A2).toMatchObject({ t: "s", v: "g000" });
    expect(sheet?.B2).toMatchObject({ t: "n", v: 5 });
    expect(sheet?.A751).toMatchObject({ t: "s", v: "g749" });
    expect(sheet?.B751).toMatchObject({ t: "n", v: 5 });
  });
});

it("maps reordered headers into a selected output and requires explicit overwrite atomically", async () => {
  await workspace(async (directory, client) => {
    await writeFile(
      join(directory, "source.csv"),
      "ID,Amount\n001,10\n002,20\n",
    );
    const transfer = await prepare(client, "source.csv", {
      kind: "records",
      headerRow: 1,
      includeHeaders: false,
    });
    const target = mutationReceiptSchema.parse(
      await call(client, "create_workbook", {
        sheets: [
          {
            name: "Target",
            blocks: [
              {
                startCell: "A1",
                values: [
                  [
                    { kind: "text", value: "Amount" },
                    { kind: "text", value: "ID" },
                  ],
                  [
                    { kind: "text", value: "old" },
                    { kind: "text", value: "" },
                  ],
                ],
              },
            ],
          },
        ],
      }),
    );
    const original = await readFile(join(directory, target.version.filePath));
    const placement = {
      kind: "sheet",
      source: target.version,
      sheetName: "Target",
      startCell: "A2",
      mapping: { kind: "headers", headerRow: 1 },
    };
    const refused = await client.callTool({
      name: "transfer_data",
      arguments: { transfer, target: placement },
    });
    expect(refused.isError).toBe(true);
    expect(payload(refused)).toMatchObject({ error: "invalid_argument" });
    expect(await readdir(join(directory, "out"))).toHaveLength(1);
    const result = transferReceiptSchema.parse(
      await call(client, "transfer_data", {
        transfer,
        target: { ...placement, overwrite: true },
      }),
    );
    const sheet = independentRead(
      await readFile(join(directory, result.version.filePath)),
      { type: "buffer" },
    ).Sheets.Target;
    expect(sheet?.A2).toMatchObject({ v: "10" });
    expect(sheet?.B2).toMatchObject({ v: "001" });
    expect(sheet?.A3).toMatchObject({ v: "20" });
    expect(sheet?.B3).toMatchObject({ v: "002" });
    expect(await readFile(join(directory, target.version.filePath))).toEqual(
      original,
    );
    const added = transferReceiptSchema.parse(
      await call(client, "transfer_data", {
        transfer,
        target: {
          kind: "add_sheet",
          source: result.version,
          sheetName: "Details",
        },
      }),
    );
    const book = independentRead(
      await readFile(join(directory, added.version.filePath)),
      { type: "buffer" },
    );
    expect(book.SheetNames).toEqual(["Target", "Details"]);
    expect(book.Sheets.Target?.B3).toMatchObject({ v: "002" });
    expect(book.Sheets.Details?.A1).toMatchObject({ v: "001" });
  });
});

it("rejects a changed source instead of silently selecting current data", async () => {
  await workspace(async (directory, client) => {
    await writeFile(join(directory, "source.csv"), "Name\nold\n");
    const transfer = await prepare(client, "source.csv", {
      kind: "range",
      range: "A1:A2",
    });
    await writeFile(join(directory, "source.csv"), "Name\nnew\n");
    const result = await client.callTool({
      name: "transfer_data",
      arguments: { transfer, target: { kind: "new", sheetName: "Changed" } },
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: "file_changed" });
    expect(await readdir(join(directory, "out"))).toEqual([]);
  });
});

it.each([false, true])(
  "preserves calendar values from date1904=%s while literal dates and formulas stay text",
  async (date1904) => {
    await workspace(async (directory, client) => {
      const raw = await rawWorkbook({
        sheetData:
          '<row r="1"><c r="A1" s="1"><v>' +
          (date1904 ? "1" : "1463") +
          '</v></c><c r="B1" t="inlineStr"><is><t>1904-01-02</t></is></c><c r="C1" t="inlineStr"><is><t>=1+1</t></is></c><c r="D1"><f>1+1</f><v>2</v></c><c r="E1" t="inlineStr"><is><t></t></is></c></row>',
        styles:
          '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>',
      });
      const zip = await JSZip.loadAsync(raw);
      const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
      if (workbookXml === undefined)
        throw new Error("Missing workbook fixture");
      zip.file(
        "xl/workbook.xml",
        workbookXml.replace(
          "<sheets>",
          `<workbookPr date1904="${date1904 ? 1 : 0}"/><sheets>`,
        ),
      );
      const original = await zip.generateAsync({ type: "nodebuffer" });
      await writeFile(join(directory, "source.xlsm"), original);
      const transfer = await prepare(client, "source.xlsm", {
        kind: "range",
        range: "A1:F1",
        headerRow: 0,
      });
      const result = await call(client, "transfer_data", {
        transfer,
        target: { kind: "new", sheetName: "Values", startCell: "B3" },
      });
      expect(result).toMatchObject({
        transfer: {
          rows: 1,
          columns: 6,
          cachedFormulas: 1,
          recalculated: false,
        },
      });
      const receipt = transferReceiptSchema.parse(result);
      const bytes = await readFile(join(directory, receipt.version.filePath));
      const sheet = independentRead(bytes, { type: "buffer", cellDates: true })
        .Sheets.Values;
      expect(sheet?.B3?.t).toBe("d");
      expect(sheet?.B3?.v).toEqual(new Date("1904-01-02T00:00:00Z"));
      expect(sheet?.C3).toMatchObject({ t: "s", v: "1904-01-02" });
      expect(sheet?.D3).toMatchObject({ t: "s", v: "=1+1" });
      expect(sheet?.E3).toMatchObject({ t: "n", v: 2 });
      expect(sheet?.E3?.f).toBeUndefined();
      expect(sheet?.F3).toMatchObject({ t: "s", v: "" });
      expect(sheet?.G3).toBeUndefined();
      expect(
        createHash("sha256")
          .update(await readFile(join(directory, "source.xlsm")))
          .digest("hex"),
      ).toBe(createHash("sha256").update(original).digest("hex"));
    });
  },
);

it.each([
  ['<c r="A1"><f>1+1</f></c>', "invalid_argument"],
  ['<c r="A1" t="e"><v>#DIV/0!</v></c>', "invalid_argument"],
  ['<c r="A1"><v>9007199254740992</v></c>', "invalid_argument"],
])(
  "rejects unsupported selected values without a completed output: %s",
  async (cell, error) => {
    await workspace(async (directory, client) => {
      await writeFile(
        join(directory, "source.xlsx"),
        await rawWorkbook({ sheetData: `<row r="1">${cell}</row>` }),
      );
      const result = await client.callTool({
        name: "prepare_transfer",
        arguments: {
          filePath: "source.xlsx",
          selection: { kind: "range", range: "A1", headerRow: 0 },
        },
      });
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({ error });
      expect(await readdir(join(directory, "out"))).toEqual([]);
    });
  },
);

it("keeps saved hidden-row selection explicit and rejects subsets excluded by that selection", async () => {
  await workspace(async (directory, client) => {
    await writeFile(
      join(directory, "source.xlsx"),
      await rawWorkbook({
        sheetData:
          '<row r="1"><c r="A1" t="inlineStr"><is><t>ID</t></is></c></row><row r="2" hidden="1"><c r="A2"><v>10</v></c></row><row r="3"><c r="A3"><v>20</v></c></row>',
      }),
    );
    const transfer = await prepare(client, "source.xlsx", {
      kind: "records",
      headerRow: 1,
      visibleOnly: true,
    });
    const result = await call(client, "transfer_data", {
      transfer,
      target: { kind: "new", sheetName: "Visible" },
    });
    expect(result).toMatchObject({
      transfer: {
        rows: 2,
        matchedRows: 1,
        visibility: { hiddenRowsSkipped: 1, filterCriteriaReevaluated: false },
      },
    });
    const receipt = transferReceiptSchema.parse(result);
    const sheet = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer" },
    ).Sheets.Visible;
    expect(sheet?.A2).toMatchObject({ v: 20 });
    const refused = await client.callTool({
      name: "prepare_transfer",
      arguments: {
        filePath: "source.xlsx",
        selection: {
          kind: "records",
          headerRow: 1,
          visibleOnly: true,
          scope: { kind: "rows", rows: [2] },
        },
      },
    });
    expect(payload(refused)).toMatchObject({ error: "invalid_argument" });
  });
});

it("refuses path escapes and oversized selections before publishing", async () => {
  await workspace(async (directory, client) => {
    await writeFile(join(directory, "source.csv"), "A\n1\n");
    const escaped = await client.callTool({
      name: "prepare_transfer",
      arguments: { filePath: "../outside.csv", selection: { kind: "range" } },
    });
    expect(payload(escaped)).toMatchObject({ error: "path_outside_root" });
    const oversized = await client.callTool({
      name: "prepare_transfer",
      arguments: {
        filePath: "source.csv",
        selection: { kind: "range", range: "A1:XFD1048576" },
      },
    });
    expect(payload(oversized)).toMatchObject({ error: "resource_limit" });
    expect(await readdir(join(directory, "out"))).toEqual([]);
  });
});

it("clears an occupied target only with explicit overwrite and preserves empty text separately", async () => {
  await workspace(async (directory, client) => {
    await writeFile(
      join(directory, "source.xlsx"),
      await rawWorkbook({
        sheetData:
          '<row r="1"><c r="B1" t="inlineStr"><is><t></t></is></c></row>',
      }),
    );
    const transfer = await prepare(client, "source.xlsx", {
      kind: "range",
      range: "A1:B1",
    });
    const initial = mutationReceiptSchema.parse(
      await call(client, "create_workbook", {
        sheets: [
          {
            name: "Target",
            blocks: [
              {
                startCell: "A1",
                values: [
                  [
                    { kind: "text", value: "keep" },
                    { kind: "text", value: "replace" },
                  ],
                ],
              },
            ],
          },
        ],
      }),
    );
    const target = {
      kind: "sheet",
      source: initial.version,
      sheetName: "Target",
      startCell: "A1",
    };
    const denied = await client.callTool({
      name: "transfer_data",
      arguments: { transfer, target },
    });
    expect(payload(denied)).toMatchObject({ error: "invalid_argument" });
    const receipt = transferReceiptSchema.parse(
      await call(client, "transfer_data", {
        transfer,
        target: { ...target, overwrite: true },
      }),
    );
    const sheet = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer" },
    ).Sheets.Target;
    expect(sheet?.A1).toBeUndefined();
    expect(sheet?.B1).toMatchObject({ t: "s", v: "" });
    expect((await readdir(join(directory, "out"))).length).toBe(2);
  });
});

it.each([
  {
    source: "ID,ID\nx,y\n",
    headers: ["ID", "Amount"],
    error: "invalid_argument",
  },
  {
    source: "ID,Amount\nx,10\n",
    headers: ["ID", "Amount", "Amount"],
    error: "ambiguous_column",
  },
  {
    source: "ID,Amount\nx,10\n",
    headers: ["ID", "Other"],
    error: "unknown_column",
  },
])(
  "refuses ambiguous or missing target mappings atomically: $headers",
  async ({ source, headers, error }) => {
    await workspace(async (directory, client) => {
      await writeFile(join(directory, "source.csv"), source);
      const transfer = await prepare(client, "source.csv", {
        kind: "records",
        headerRow: 1,
        includeHeaders: false,
      });
      const target = mutationReceiptSchema.parse(
        await call(client, "create_workbook", {
          sheets: [
            {
              name: "Target",
              blocks: [
                {
                  startCell: "A1",
                  values: [headers.map((value) => ({ kind: "text", value }))],
                },
              ],
            },
          ],
        }),
      );
      const result = await client.callTool({
        name: "transfer_data",
        arguments: {
          transfer,
          target: {
            kind: "sheet",
            source: target.version,
            sheetName: "Target",
            startCell: "A2",
            mapping: { kind: "headers", headerRow: 1 },
          },
        },
      });
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({ error });
      expect(await readdir(join(directory, "out"))).toHaveLength(1);
    });
  },
);

it("rejects uncached formulas used by an aggregate instead of exporting an incomplete total", async () => {
  await workspace(async (directory, client) => {
    await writeFile(
      join(directory, "source.xlsx"),
      await rawWorkbook({
        sheetData:
          '<row r="1"><c r="A1" t="inlineStr"><is><t>Amount</t></is></c></row><row r="2"><c r="A2"><f>1+1</f></c></row>',
      }),
    );
    const result = await client.callTool({
      name: "prepare_transfer",
      arguments: {
        filePath: "source.xlsx",
        selection: {
          kind: "aggregate",
          headerRow: 1,
          metrics: [{ fn: "sum", column: "Amount" }],
        },
      },
    });
    expect(payload(result)).toMatchObject({ error: "invalid_argument" });
    expect(await readdir(join(directory, "out"))).toEqual([]);
  });
});

it("refuses an explicit subset excluded by its condition and incomparable filter operands", async () => {
  await workspace(async (directory, client) => {
    await writeFile(
      join(directory, "source.csv"),
      "Name,Amount\nfirst,10\nsecond,20\n",
    );
    for (const selection of [
      {
        kind: "records",
        headerRow: 1,
        scope: { kind: "rows", rows: [2] },
        where: [{ column: "Amount", op: "gt", value: 15 }],
        columns: [{ column: "Amount", type: "number", decimal: "." }],
      },
      {
        kind: "records",
        headerRow: 1,
        where: [{ column: "Name", op: "gt", value: 15 }],
      },
    ]) {
      const result = await client.callTool({
        name: "prepare_transfer",
        arguments: { filePath: "source.csv", selection },
      });
      expect(payload(result)).toMatchObject({ error: "invalid_argument" });
    }
    expect(await readdir(join(directory, "out"))).toEqual([]);
  });
});

it("rejects a target without a spreadsheet content type and target overflow without changing either source", async () => {
  await workspace(async (directory, client) => {
    await writeFile(join(directory, "source.csv"), "ID\n001\n002\n");
    const transfer = await prepare(client, "source.csv", {
      kind: "records",
      headerRow: 1,
    });
    const external = await rawWorkbook({
      sheetData: '<row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row>',
    });
    await writeFile(join(directory, "external.xlsx"), external);
    const version = {
      filePath: "external.xlsx",
      versionId: createHash("sha256").update(external).digest("hex"),
    };
    const blocked = await client.callTool({
      name: "transfer_data",
      arguments: {
        transfer,
        target: {
          kind: "sheet",
          source: version,
          sheetName: "S",
          startCell: "A2",
        },
      },
    });
    expect(payload(blocked)).toMatchObject({ error: "not_a_workbook" });
    const overflow = await client.callTool({
      name: "transfer_data",
      arguments: {
        transfer,
        target: { kind: "new", sheetName: "Overflow", startCell: "A1048576" },
      },
    });
    expect(payload(overflow)).toMatchObject({ error: "invalid_range" });
    expect(await readFile(join(directory, "external.xlsx"))).toEqual(
      Buffer.from(external),
    );
    expect(await readdir(join(directory, "out"))).toEqual([]);
  });
});

it("keeps transfer tools unavailable through the default read-only server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "excel-transfer-readonly-"));
  const server = createExcelMcpServer(await createWorkbookRoot(directory));
  const client = new Client({ name: "transfer-readonly", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    await expect(
      client.callTool({ name: "transfer_data", arguments: {} }),
    ).rejects.toThrow("Tool transfer_data not found");
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("treats absent and stored blank rows consistently while preserving empty text records", async () => {
  await workspace(async (directory, client) => {
    await writeFile(
      join(directory, "source.xlsx"),
      await rawWorkbook({
        sheetData:
          '<row r="1"><c r="A1" t="inlineStr"><is><t>ID</t></is></c></row><row r="2"><c r="A2"/></row><row r="4"><c r="A4" t="inlineStr"><is><t></t></is></c></row><row r="5"><c r="A5"><v>7</v></c></row>',
      }),
    );
    const transfer = await prepare(client, "source.xlsx", {
      kind: "records",
      headerRow: 1,
    });
    const result = await call(client, "transfer_data", {
      transfer,
      target: { kind: "new", sheetName: "Records" },
    });
    expect(result).toMatchObject({ transfer: { rows: 3, matchedRows: 2 } });
    const receipt = transferReceiptSchema.parse(result);
    const sheet = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer" },
    ).Sheets.Records;
    expect(sheet?.A2).toMatchObject({ t: "s", v: "" });
    expect(sheet?.A3).toMatchObject({ t: "n", v: 7 });
  });
});

it("reports an empty match honestly and still validates an existing destination sheet", async () => {
  await workspace(async (directory, client) => {
    await writeFile(join(directory, "source.csv"), "ID\n001\n");
    const transfer = await prepare(client, "source.csv", {
      kind: "records",
      headerRow: 1,
      includeHeaders: false,
      where: [{ column: "ID", op: "eq", value: "absent" }],
    });
    const created = transferReceiptSchema.parse(
      await call(client, "transfer_data", {
        transfer,
        target: { kind: "new", sheetName: "Empty" },
      }),
    );
    expect(created.transfer).toMatchObject({
      rows: 0,
      cells: 0,
      matchedRows: 0,
    });
    const missing = await client.callTool({
      name: "transfer_data",
      arguments: {
        transfer,
        target: {
          kind: "sheet",
          source: created.version,
          sheetName: "Missing",
          startCell: "A1",
        },
      },
    });
    expect(payload(missing)).toMatchObject({ error: "unknown_sheet" });
    expect(await readdir(join(directory, "out"))).toHaveLength(1);
  });
});

it("reports a saved formula result used for both filtering and output once", async () => {
  await workspace(async (directory, client) => {
    await writeFile(
      join(directory, "source.xlsx"),
      await rawWorkbook({
        sheetData:
          '<row r="1"><c r="A1" t="inlineStr"><is><t>Amount</t></is></c></row><row r="2"><c r="A2"><f>1+1</f><v>2</v></c></row>',
      }),
    );
    const transfer = await prepare(client, "source.xlsx", {
      kind: "records",
      headerRow: 1,
      where: [{ column: "Amount", op: "gte", value: 1 }],
    });
    const result = await call(client, "transfer_data", {
      transfer,
      target: { kind: "new", sheetName: "Cached" },
    });
    expect(result).toMatchObject({
      transfer: { cachedFormulas: 1, recalculated: false, matchedRows: 1 },
    });
    const receipt = transferReceiptSchema.parse(result);
    const sheet = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer" },
    ).Sheets.Cached;
    expect(sheet?.A2).toMatchObject({ t: "n", v: 2 });
    expect(sheet?.A2?.f).toBeUndefined();
  });
});

it("bounds transfer descriptors before source access or materialization", async () => {
  await workspace(async (directory, client) => {
    const result = await client.callTool({
      name: "prepare_transfer",
      arguments: {
        filePath: "missing.csv",
        selection: {
          kind: "records",
          where: [{ column: "A", op: "eq", value: "x".repeat(70_000) }],
        },
      },
    });
    expect(payload(result)).toMatchObject({ error: "resource_limit" });
    expect(await readdir(join(directory, "out"))).toEqual([]);
  });
});

it("preserves the calendar type of explicitly interpreted date extrema in an aggregate", async () => {
  await workspace(async (directory, client) => {
    await writeFile(
      join(directory, "source.csv"),
      "Date\n2026-10-25\n2026-10-24\n",
    );
    const transfer = await prepare(client, "source.csv", {
      kind: "aggregate",
      headerRow: 1,
      columns: [{ column: "Date", type: "date", format: "yyyy-MM-dd" }],
      metrics: [
        { fn: "min", column: "Date" },
        { fn: "max", column: "Date" },
      ],
    });
    const receipt = transferReceiptSchema.parse(
      await call(client, "transfer_data", {
        transfer,
        target: { kind: "new", sheetName: "Dates" },
      }),
    );
    const sheet = independentRead(
      await readFile(join(directory, receipt.version.filePath)),
      { type: "buffer", cellDates: true },
    ).Sheets.Dates;
    expect(sheet?.A2).toMatchObject({
      t: "d",
      v: new Date("2026-10-24T00:00:00Z"),
    });
    expect(sheet?.B2).toMatchObject({
      t: "d",
      v: new Date("2026-10-25T00:00:00Z"),
    });
    const grouped = await prepare(client, "source.csv", {
      kind: "aggregate",
      headerRow: 1,
      columns: [{ column: "Date", type: "date", format: "yyyy-MM-dd" }],
      groupBy: ["Date"],
      metrics: [{ fn: "count" }],
    });
    const groupedReceipt = transferReceiptSchema.parse(
      await call(client, "transfer_data", {
        transfer: grouped,
        target: { kind: "new", sheetName: "Groups" },
      }),
    );
    const groupedSheet = independentRead(
      await readFile(join(directory, groupedReceipt.version.filePath)),
      { type: "buffer", cellDates: true },
    ).Sheets.Groups;
    expect(groupedSheet?.A2).toMatchObject({
      t: "d",
      v: new Date("2026-10-24T00:00:00Z"),
    });
    expect(groupedSheet?.A3).toMatchObject({
      t: "d",
      v: new Date("2026-10-25T00:00:00Z"),
    });
  });
});

it
  .skipIf(process.env["SEZZLEE_CORPUS"] === undefined)
  .each([
    "apache-testdata/files/poi/spreadsheet/Booleans.xlsx",
    "apache-testdata/files/poi/spreadsheet/SimpleStrict.xlsx",
    "apache-testdata/files/poi/spreadsheet/unicodeSheetName.xlsx",
  ])(
  "transfers an external corpus rectangle with independent cell expectations: %s",
  async (relative) => {
    const corpus = process.env["SEZZLEE_CORPUS"];
    if (corpus === undefined) throw new Error("The corpus root is required");
    await workspace(async (directory, client) => {
      const original = await readFile(join(corpus, relative));
      const source = independentRead(Buffer.from(original), {
        type: "buffer",
        cellDates: true,
      });
      const name = source.SheetNames[0];
      if (name === undefined)
        throw new Error("The corpus fixture has no sheet");
      await writeFile(join(directory, "corpus.xlsx"), original);
      const transfer = await prepare(client, "corpus.xlsx", {
        kind: "range",
        sheetName: name,
        range: "A1:D10",
      });
      const receipt = transferReceiptSchema.parse(
        await call(client, "transfer_data", {
          transfer,
          target: { kind: "new", sheetName: "Copy" },
        }),
      );
      const copied = independentRead(
        await readFile(join(directory, receipt.version.filePath)),
        { type: "buffer", cellDates: true },
      ).Sheets.Copy;
      for (let row = 1; row <= 10; row += 1) {
        for (const column of ["A", "B", "C", "D"]) {
          const address = `${column}${row}`;
          const expected = source.Sheets[name]?.[address];
          if (expected === undefined || expected.t === "z")
            expect(copied?.[address]).toBeUndefined();
          else
            expect(copied?.[address]).toMatchObject({
              t: expected.t,
              v: expected.v,
            });
          expect(copied?.[address]?.f).toBeUndefined();
        }
      }
      expect(await readFile(join(corpus, relative))).toEqual(original);
    });
  },
);
