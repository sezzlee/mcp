import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import * as XLSX from "@e965/xlsx";
import { describe, expect, it } from "vitest";
import { createWorkbookRoot } from "../src/platform/paths.js";
import {
  createWorkbookOutput,
  mutationReceiptSchema,
} from "../src/platform/versions.js";
import { createExcelMcpServer } from "../src/server.js";
import { editPreparationSchema } from "../src/tools/edit-schemas.js";
import {
  bulkGroupReceiptSchema,
  bulkBatchReceiptSchema,
  bulkJobSchema,
} from "../src/tools/bulk-job-schemas.js";

async function workspace(
  run: (directory: string, client: Client) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "excel-presentation-"));
  await mkdir(join(directory, "out"));
  const root = await createWorkbookRoot(directory),
    server = createExcelMcpServer(root, {
      mode: "write",
      output: await createWorkbookOutput(root, "out"),
    }),
    client = new Client({ name: "presentation-contract", version: "1" }),
    [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    await run(directory, client);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}
function payload(result: { content: readonly unknown[] }): unknown {
  const first = result.content[0];
  if (
    first === null ||
    typeof first !== "object" ||
    !("text" in first) ||
    typeof first.text !== "string"
  )
    throw new Error("Missing JSON tool result");
  return JSON.parse(first.text);
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError, JSON.stringify(payload(response))).not.toBe(true);
  return payload(response);
}
async function created(
  client: Client,
  changes: readonly unknown[] = [],
  values: readonly (readonly unknown[])[] = [],
) {
  return mutationReceiptSchema.parse(
    await call(client, "create_workbook", {
      sheets: [
        {
          name: "S",
          blocks: values.length ? [{ startCell: "A1", values }] : [],
        },
      ],
      changes,
    }),
  );
}
async function files(
  directory: string,
  receipt: Pick<ReturnType<typeof mutationReceiptSchema.parse>, "version">,
) {
  const bytes = await readFile(join(directory, receipt.version.filePath)),
    sha256 = createHash("sha256").update(bytes).digest("hex"),
    zip = await JSZip.loadAsync(bytes);
  async function part(name: string) {
    const file = zip.file(name);
    if (file === null) throw new Error("Missing part " + name);
    return file.async("string");
  }
  const excel = new ExcelJS.Workbook();
  await excel.xlsx.load(Uint8Array.from(bytes).buffer);
  return { bytes, zip, part, excel, sha256 };
}
const text = (value: string) => ({ kind: "text", value });
const number = (value: number) => ({ kind: "number", value });
const blank = { kind: "blank" };
async function worksheetXml(
  output: Awaited<ReturnType<typeof files>>,
  name: string,
): Promise<string> {
  const xml = await output.part("xl/workbook.xml"),
    tag = xml.match(new RegExp(`<sheet\\b[^>]*name="${name}"[^>]*/?>`))?.[0];
  if (tag === undefined) throw new Error("Missing named sheet " + name);
  const id = /\br:id="([^"]+)"/.exec(tag)?.[1];
  if (id === undefined) throw new Error("Missing sheet relationship");
  const rels = await output.part("xl/_rels/workbook.xml.rels"),
    relationship = rels.match(
      new RegExp(`<Relationship\\b[^>]*Id="${id}"[^>]*/?>`),
    )?.[0],
    target =
      relationship === undefined
        ? undefined
        : /\bTarget="([^"]+)"/.exec(relationship)?.[1];
  if (target === undefined) throw new Error("Missing worksheet target");
  return output.part(
    target.startsWith("/") ? target.slice(1) : posix.normalize("xl/" + target),
  );
}

describe("Phase 5 authoring through MCP", () => {
  it("extends table filter coverage when inserting before a totals row and excludes the moved total", () =>
    workspace(async (directory, client) => {
      const source = await created(
        client,
        [
          {
            kind: "fill_formula",
            sheetName: "S",
            anchor: "D2",
            range: "D2:D3",
            formula: "B2*C2",
          },
          {
            kind: "create_table",
            sheetName: "S",
            range: "A1:D4",
            name: "Orders",
            totals: [
              { kind: "label", column: "Item", text: "Total" },
              { kind: "function", column: "Amount", function: "sum" },
            ],
          },
        ],
        [
          [text("Item"), text("Qty"), text("Price"), text("Amount")],
          [text("A"), number(2), number(10), blank],
          [text("B"), number(3), number(5), blank],
        ],
      );
      const edited = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: source.version,
          changes: [
            {
              kind: "insert_rows",
              sheetName: "S",
              at: 4,
              values: [
                [
                  text("C"),
                  number(4),
                  number(2),
                  { kind: "formula", formula: "B{row}*C{row}" },
                ],
              ],
            },
          ],
        }),
      );
      const output = await files(directory, edited),
        table = await output.part("xl/tables/table1.xml");
      expect(table).toContain('ref="A1:D5"');
      expect(table).toMatch(/<autoFilter\b[^>]*ref="A1:D4"/);
      expect(output.excel.getWorksheet("S")?.getCell("A4").value).toBe("C");
      expect(output.excel.getWorksheet("S")?.getCell("D4").value).toEqual({
        formula: "B4*C4",
      });
      expect(output.excel.getWorksheet("S")?.getCell("A5").value).toBe("Total");
      expect(output.excel.getWorksheet("S")?.getCell("D5").value).toEqual({
        formula: "SUBTOTAL(109,Orders[Amount])",
      });
      const removed = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: edited.version,
          changes: [{ kind: "delete_rows", sheetName: "S", at: 4, count: 1 }],
        }),
      );
      const after = await files(directory, removed);
      expect(await after.part("xl/tables/table1.xml")).toMatch(
        /<autoFilter\b[^>]*ref="A1:D3"/,
      );
      expect(after.excel.getWorksheet("S")?.getCell("A4").value).toBe("Total");
    }));
  it(
    "refuses a new distinct style at the supported style ceiling without changing its source",
    () =>
      workspace(async (directory, client) => {
        const book = new ExcelJS.Workbook();
        book.addWorksheet("S").getCell("A1").value = 1;
        const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
        const part = zip.file("xl/styles.xml");
        if (part === null)
          throw new Error("Missing independent fixture styles");
        let styles = await part.async("string");
        const formats = Array.from(
          { length: 16384 },
          (_, i) =>
            `<numFmt numFmtId="${164 + i}" formatCode="0.00&quot; x${i}&quot;"/>`,
        ).join("");
        const xfs = Array.from(
          { length: 16384 },
          (_, i) =>
            `<xf numFmtId="${164 + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
        ).join("");
        styles = styles
          .replace(
            /<numFmts\b[^>]*\/>|<numFmts\b[^>]*>[\s\S]*?<\/numFmts>/g,
            "",
          )
          .replace(
            /(<styleSheet\b[^>]*>)/,
            `$1<numFmts count="16384">${formats}</numFmts>`,
          )
          .replace(
            /<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/,
            `<cellXfs count="16384">${xfs}</cellXfs>`,
          );
        zip.file("xl/styles.xml", styles);
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        await writeFile(join(directory, "styles.xlsx"), bytes);
        const result = await client.callTool({
          name: "edit_workbook",
          arguments: {
            source: {
              filePath: "styles.xlsx",
              versionId: createHash("sha256").update(bytes).digest("hex"),
            },
            changes: [
              {
                kind: "format_cells",
                sheetName: "S",
                range: "A1",
                style: { font: { bold: true } },
              },
            ],
          },
        });
        expect(result.isError).toBe(true);
        expect(payload(result)).toMatchObject({
          error: "resource_limit",
          message: expect.stringMatching(/cellXfs|style/i),
        });
        expect(await readdir(join(directory, "out"))).toEqual([]);
        expect(await readFile(join(directory, "styles.xlsx"))).toEqual(bytes);
        const below = styles
          .replace('numFmts count="16384"', 'numFmts count="16383"')
          .replace(/<numFmt numFmtId="16547"[^>]*\/>/, "")
          .replace('cellXfs count="16384"', 'cellXfs count="16383"')
          .replace(/<xf numFmtId="16547"[^>]*\/>/, "");
        zip.file("xl/styles.xml", below);
        const supported = await zip.generateAsync({ type: "nodebuffer" });
        await writeFile(join(directory, "below.xlsx"), supported);
        const accepted = mutationReceiptSchema.parse(
          await call(client, "edit_workbook", {
            source: {
              filePath: "below.xlsx",
              versionId: createHash("sha256").update(supported).digest("hex"),
            },
            changes: [
              {
                kind: "format_cells",
                sheetName: "S",
                range: "A1",
                style: { font: { bold: true } },
              },
            ],
          }),
        );
        const output = await files(directory, accepted);
        expect(output.excel.getWorksheet("S")?.getCell("A1").font.bold).toBe(
          true,
        );
        expect(
          /<cellXfs\b[^>]*\bcount="(\d+)"/.exec(
            await output.part("xl/styles.xml"),
          )?.[1],
        ).toBe("16384");
      }),
    120_000,
  );
  it.each(["format_cells", "fill_formula"])(
    "refuses a whole-grid %s before publishing or allocating cells",
    (kind) =>
      workspace(async (directory, client) => {
        const change =
          kind === "format_cells"
            ? {
                kind,
                sheetName: "S",
                range: "A1:XFD1048576",
                style: { numberFormat: "0.00" },
              }
            : {
                kind,
                sheetName: "S",
                anchor: "A1",
                range: "A1:XFD1048576",
                formula: "1+1",
              };
        const result = await client.callTool({
          name: "create_workbook",
          arguments: { sheets: [{ name: "S" }], changes: [change] },
        });
        expect(result.isError).toBe(true);
        expect(payload(result)).toMatchObject({ error: "resource_limit" });
        expect(await readdir(join(directory, "out"))).toEqual([]);
      }),
  );
  it("counts existing cells on other sheets before expanding a formatted range", () =>
    workspace(async (directory, client) => {
      const result = await client.callTool({
        name: "create_workbook",
        arguments: {
          sheets: [
            { name: "S", blocks: [{ startCell: "A1", values: [[number(1)]] }] },
            { name: "T" },
          ],
          changes: [
            {
              kind: "format_cells",
              sheetName: "T",
              range: "A1:CV10000",
              style: { numberFormat: "0.00" },
            },
          ],
        },
      });
      expect(result.isError).toBe(true);
      expect(payload(result)).toMatchObject({ error: "resource_limit" });
      expect(await readdir(join(directory, "out"))).toEqual([]);
    }));
  it("preserves saved ordinary results and errors but invalidates format-dependent CELL caches", () =>
    workspace(async (directory, client) => {
      const book = new ExcelJS.Workbook(),
        sheet = book.addWorksheet("S");
      sheet.getCell("A1").value = 5;
      sheet.getCell("B1").value = { formula: "A1*2", result: 10 };
      sheet.getCell("C1").value = {
        formula: "1/0",
        result: { error: "#DIV/0!" },
      };
      const bytes = Buffer.from(await book.xlsx.writeBuffer());
      await writeFile(join(directory, "saved.xlsx"), bytes);
      const edited = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: {
            filePath: "saved.xlsx",
            versionId: createHash("sha256").update(bytes).digest("hex"),
          },
          changes: [
            {
              kind: "format_cells",
              sheetName: "S",
              range: "A1",
              style: { numberFormat: "0.00" },
            },
          ],
        }),
      );
      const output = await files(directory, edited);
      expect(output.excel.getWorksheet("S")?.getCell("B1").value).toEqual({
        formula: "A1*2",
        result: 10,
      });
      expect(output.excel.getWorksheet("S")?.getCell("C1").value).toEqual({
        formula: "1/0",
        result: { error: "#DIV/0!" },
      });
      const read = await call(client, "read_sheet", {
        filePath: edited.version.filePath,
        sheetName: "S",
        range: "A1:D1",
        headerRow: 0,
        valueMode: "both",
      });
      expect(read).toMatchObject({
        values: [[5, 10, { error: "#DIV/0!" }]],
        cellNotes: {
          B1: { kind: "formula", cached: true },
          C1: { kind: "formula", cached: true },
        },
      });
      expect(edited.editing?.recalculated).toBe(false);
      expect(edited.editing?.recalculationRequired).toBe(false);
      sheet.getCell("D1").value = { formula: 'CELL("format",A1)', result: "G" };
      const sensitive = Buffer.from(await book.xlsx.writeBuffer());
      await writeFile(join(directory, "sensitive.xlsx"), sensitive);
      const invalidated = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: {
            filePath: "sensitive.xlsx",
            versionId: createHash("sha256").update(sensitive).digest("hex"),
          },
          changes: [
            {
              kind: "format_cells",
              sheetName: "S",
              range: "A1",
              style: { numberFormat: "0.00" },
            },
          ],
        }),
      );
      const sensitiveOutput = await files(directory, invalidated);
      expect(
        sensitiveOutput.excel.getWorksheet("S")?.getCell("D1").value,
      ).toEqual({ formula: 'CELL("format",A1)' });
      expect(
        sensitiveOutput.excel.getWorksheet("S")?.getCell("B1").value,
      ).toEqual({ formula: "A1*2" });
      expect(invalidated.editing?.recalculated).toBe(false);
      expect(invalidated.editing?.recalculationRequired).toBe(true);
    }));
  it("keeps scalars and literal formula-looking text while styling, authoring and continuing a retained version", () =>
    workspace(async (directory, client) => {
      const source = await created(
        client,
        [
          {
            kind: "format_cells",
            sheetName: "S",
            range: "A1:B1",
            style: {
              numberFormat: "0.00%",
              font: { bold: true, color: "123456" },
              fill: "FFEEDD",
            },
          },
          {
            kind: "write_formula",
            sheetName: "S",
            cell: "C1",
            formula: "=A1*2",
          },
        ],
        [[number(0.15), text("=1+1")]],
      );
      expect(source.editing).toMatchObject({
        cellsFormatted: 2,
        formulasWritten: 1,
        recalculated: false,
        recalculationRequired: true,
      });
      const original = await files(directory, source),
        raw = await original.part("xl/worksheets/sheet1.xml"),
        styles = await original.part("xl/styles.xml");
      expect(raw).toContain("<f");
      expect(raw).toContain("A1*2");
      expect(raw).toContain("0.15");
      expect(raw).toContain("=1+1");
      expect(styles).toContain('formatCode="0.00%"');
      expect(styles).toContain('rgb="FF123456"');
      const oracle = XLSX.read(original.bytes, {
        type: "buffer",
        cellNF: true,
      });
      expect(oracle.Sheets.S?.A1.v).toBe(0.15);
      expect(oracle.Sheets.S?.B1).toMatchObject({ t: "s", v: "=1+1" });
      expect(original.excel.getWorksheet("S")?.getCell("C1").value).toEqual({
        formula: "A1*2",
      });
      const changes = [
        {
          kind: "write_cells",
          sheetName: "S",
          startCell: "D1",
          values: [[number(9)]],
        },
      ];
      const prepared = editPreparationSchema.parse(
        await call(client, "prepare_edit", {
          filePath: source.version.filePath,
          expectedVersion: source.version.versionId,
          changes,
        }),
      );
      expect(prepared.kind).toBe("ready");
      const next = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: source.version,
          changes,
        }),
      );
      const continued = await files(directory, next);
      expect(await continued.part("xl/styles.xml")).toBe(styles);
      expect(await continued.part("xl/worksheets/sheet1.xml")).toContain(
        "A1*2",
      );
      expect(
        createHash("sha256")
          .update(await readFile(join(directory, source.version.filePath)))
          .digest("hex"),
      ).toBe(original.sha256);
    }));
  it("writes newly added font properties in the independent Open XML SDK sequence", () =>
    workspace(async (directory, client) => {
      const receipt = await created(
        client,
        [
          {
            kind: "format_cells",
            sheetName: "S",
            range: "A1",
            style: {
              font: {
                bold: true,
                italic: true,
                strike: true,
                underline: true,
                size: 13,
                color: "FFFFFF",
                name: "Arial",
              },
            },
          },
        ],
        [[text("Header")]],
      );
      const output = await files(directory, receipt);
      const fonts = (await output.part("xl/styles.xml")).match(
        /<font\b[^>]*>[\s\S]*?<\/font>/g,
      );
      expect(fonts).toHaveLength(2);
      expect(
        [...(fonts?.[1] ?? "").matchAll(/<([a-zA-Z]+)\b/g)]
          .map((match) => match[1])
          .slice(1),
      ).toEqual(["b", "i", "strike", "u", "sz", "color", "name"]);
    }));

  it("deduplicates equivalent styles and does not restyle other cells sharing the original format", () =>
    workspace(async (directory, client) => {
      const source = await created(
        client,
        [
          {
            kind: "format_cells",
            sheetName: "S",
            range: "A1",
            style: { font: { bold: true } },
          },
          {
            kind: "format_cells",
            sheetName: "S",
            range: "A1",
            style: { font: { bold: true } },
          },
        ],
        [[number(1), number(2)]],
      );
      const output = await files(directory, source),
        styles = await output.part("xl/styles.xml");
      const repeated = mutationReceiptSchema.parse(
          await call(client, "edit_workbook", {
            source: source.version,
            changes: [
              {
                kind: "format_cells",
                sheetName: "S",
                range: "A1",
                style: { font: { bold: true } },
              },
            ],
          }),
        ),
        again = await files(directory, repeated);
      expect(await again.part("xl/styles.xml")).toBe(styles);
      expect(output.excel.getWorksheet("S")?.getCell("A1").font?.bold).toBe(
        true,
      );
      expect(output.excel.getWorksheet("S")?.getCell("B1").font?.bold).not.toBe(
        true,
      );
    }));
  it("stores dimensions, panes, visibility and print names without altering values", () =>
    workspace(async (directory, client) => {
      const source = await created(
        client,
        [
          { kind: "set_columns", sheetName: "S", first: 1, last: 2, width: 22 },
          { kind: "set_rows", sheetName: "S", first: 1, last: 1, height: 30 },
          { kind: "freeze_panes", sheetName: "S", rows: 1, columns: 1 },
          {
            kind: "set_print_layout",
            sheetName: "S",
            orientation: "landscape",
            paper: "A4",
            fitWidth: 1,
            fitHeight: 0,
            printArea: "A1:B5",
            titleRows: { first: 1, last: 1 },
            margins: {
              left: 0.5,
              right: 0.5,
              top: 0.75,
              bottom: 0.75,
              header: 0.3,
              footer: 0.3,
            },
          },
        ],
        [[text("Header"), number(5)]],
      );
      const output = await files(directory, source),
        sheet = await output.part("xl/worksheets/sheet1.xml"),
        workbook = await output.part("xl/workbook.xml");
      expect(sheet).toContain('width="22"');
      expect(sheet).toContain('ht="30"');
      expect(sheet).toContain('topLeftCell="B2"');
      expect(sheet).toContain('state="frozen"');
      expect(sheet).toContain('orientation="landscape"');
      expect(sheet).toContain('fitToWidth="1"');
      expect(workbook).toContain("_xlnm.Print_Area");
      expect(workbook).toContain("$A$1:$B$5");
      expect(workbook).toContain("$1:$1");
    }));
  it.each([number(0), { kind: "boolean", value: false }, text("")])(
    "refuses losing non-anchor contents %j unless explicitly requested",
    (value) =>
      workspace(async (directory, client) => {
        const source = await created(client, [], [[text("Anchor"), value]]),
          before = await readdir(join(directory, "out"));
        const refused = await client.callTool({
          name: "edit_workbook",
          arguments: {
            source: source.version,
            changes: [{ kind: "merge_cells", sheetName: "S", range: "A1:B1" }],
          },
        });
        expect(refused.isError).toBe(true);
        expect(payload(refused)).toMatchObject({ error: "invalid_argument" });
        expect(await readdir(join(directory, "out"))).toEqual(before);
        const changes = [
          {
            kind: "merge_cells",
            sheetName: "S",
            range: "A1:B1",
            loss: "discard_non_anchor",
          },
        ];
        const prepared = editPreparationSchema.parse(
          await call(client, "prepare_edit", {
            filePath: source.version.filePath,
            changes,
          }),
        );
        expect(prepared.effects?.mergedValuesCleared).toBe(1);
        expect(await readdir(join(directory, "out"))).toEqual(before);
        const merged = mutationReceiptSchema.parse(
          await call(client, "edit_workbook", {
            source: source.version,
            changes,
          }),
        );
        expect(merged.editing?.mergedValuesCleared).toBe(1);
        const unmerged = mutationReceiptSchema.parse(
          await call(client, "edit_workbook", {
            source: merged.version,
            changes: [
              { kind: "unmerge_cells", sheetName: "S", range: "A1:B1" },
            ],
          }),
        );
        const output = await files(directory, unmerged),
          oracle = XLSX.read(output.bytes, { type: "buffer" });
        expect(oracle.Sheets.S?.A1.v).toBe("Anchor");
        expect(oracle.Sheets.S?.B1?.v).toBeUndefined();
        expect(await output.part("xl/worksheets/sheet1.xml")).not.toContain(
          "mergeCells",
        );
      }),
  );
  it.each([
    "SUM(",
    "FILTER(A1:A3,A1:A3>0)",
    "[other.xlsx]S!A1",
    "A1#",
    "1+",
    "'S'!A1+{1,2}",
  ])("atomically refuses unsupported or malformed formula %s", (formula) =>
    workspace(async (directory, client) => {
      const response = await client.callTool({
        name: "create_workbook",
        arguments: {
          sheets: [{ name: "S" }],
          changes: [
            { kind: "write_formula", sheetName: "S", cell: "A1", formula },
          ],
        },
      });
      expect(response.isError).toBe(true);
      expect(payload(response)).toMatchObject({ error: "invalid_argument" });
      expect(await readdir(join(directory, "out"))).toEqual([]);
    }),
  );
  it("fills relative and absolute references without manufacturing calculated values", () =>
    workspace(async (directory, client) => {
      const result = await created(client, [
        {
          kind: "fill_formula",
          sheetName: "S",
          anchor: "B2",
          range: "B2:C3",
          formula: "=$A2+B$1+$D$4",
        },
      ]);
      const output = await files(directory, result);
      expect(output.excel.getWorksheet("S")?.getCell("B2").value).toEqual({
        formula: "$A2+B$1+$D$4",
      });
      expect(output.excel.getWorksheet("S")?.getCell("C3").value).toEqual({
        formula: "$A3+C$1+$D$4",
      });
      expect(await output.part("xl/worksheets/sheet1.xml")).not.toContain(
        "<v>",
      );
      expect(result.editing?.recalculated).toBe(false);
    }));
  it("creates, grows, renames and converts a calculated table with totals and column-name formulas", () =>
    workspace(async (directory, client) => {
      const source = await created(
        client,
        [
          {
            kind: "create_table",
            sheetName: "S",
            range: "A1:D5",
            name: "Sales",
            calculatedColumns: [
              { column: "Amount", formula: "[@Qty]*[@Price]" },
            ],
            totals: [
              { kind: "label", column: "Item", text: "Total" },
              { kind: "function", column: "Amount", function: "sum" },
            ],
          },
          {
            kind: "write_formula",
            sheetName: "S",
            cell: "F1",
            formula: "SUM(Sales[Amount])",
          },
        ],
        [
          [text("Item"), text("Qty"), text("Price"), text("Amount")],
          [text("A"), number(2), number(10), blank],
          [text("B"), number(3), number(5), blank],
          [text("C"), number(1), number(7), blank],
        ],
      );
      const initial = await files(directory, source);
      expect(initial.excel.getWorksheet("S")?.getCell("D2").value).toEqual({
        formula: "Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]",
      });
      expect(await initial.part("xl/tables/table1.xml")).toContain(
        "Sales[[#This Row],[Qty]]*Sales[[#This Row],[Price]]",
      );
      expect(await initial.part("xl/tables/table1.xml")).toContain(
        'ref="A1:D5"',
      );
      expect(await initial.part("xl/tables/table1.xml")).toContain(
        'totalsRowCount="1"',
      );
      const next = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: source.version,
          changes: [
            {
              kind: "edit_table",
              sheetName: "S",
              tableName: "Sales",
              range: "A1:D6",
            },
            {
              kind: "write_cells",
              sheetName: "S",
              startCell: "A5",
              values: [[text("D"), number(4), number(2)]],
              overwrite: true,
            },
            {
              kind: "edit_table",
              sheetName: "S",
              tableName: "Sales",
              name: "Orders",
              columns: [{ column: "Qty", name: "Quantity" }],
            },
          ],
        }),
      );
      const grown = await files(directory, next),
        table = await grown.part("xl/tables/table1.xml"),
        sheet = await grown.part("xl/worksheets/sheet1.xml");
      expect(table).toContain('ref="A1:D6"');
      expect(table).toContain('name="Orders"');
      expect(table).toContain('name="Quantity"');
      expect(sheet).toContain("SUM(Orders[Amount])");
      expect(sheet).toContain("Quantity");
      const result = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: next.version,
          changes: [
            { kind: "convert_table", sheetName: "S", tableName: "Orders" },
          ],
        }),
      );
      const converted = await files(directory, result),
        raw = await converted.part("xl/worksheets/sheet1.xml"),
        oracle = XLSX.read(converted.bytes, { type: "buffer" });
      expect(converted.zip.file("xl/tables/table1.xml")).toBeNull();
      expect(raw).not.toContain("tableParts");
      expect(raw).not.toContain("Orders[");
      expect(raw).not.toContain("[@");
      expect(converted.excel.getWorksheet("S")?.getCell("D5").value).toEqual({
        formula: "'S'!$B5*'S'!$C5",
      });
      expect(converted.excel.getWorksheet("S")?.getCell("F1").value).toEqual({
        formula: "SUM('S'!$D$2:$D$5)",
      });
      expect(oracle.Sheets.S?.A6.v).toBe("Total");
    }));
  it("keeps excluded values on table shrink and refuses occupied expansion without explicit overwrite", () =>
    workspace(async (directory, client) => {
      const source = await created(
        client,
        [
          {
            kind: "create_table",
            sheetName: "S",
            range: "A1:B3",
            name: "Items",
            style: "none",
          },
        ],
        [
          [text("Name"), text("Value")],
          [text("A"), number(1)],
          [text("B"), number(2)],
          [text("Outside"), number(3)],
        ],
      );
      const refused = await client.callTool({
        name: "edit_workbook",
        arguments: {
          source: source.version,
          changes: [
            {
              kind: "edit_table",
              sheetName: "S",
              tableName: "Items",
              range: "A1:B4",
            },
          ],
        },
      });
      expect(refused.isError).toBe(true);
      expect(payload(refused)).toMatchObject({ error: "invalid_argument" });
      const shrunk = mutationReceiptSchema.parse(
          await call(client, "edit_workbook", {
            source: source.version,
            changes: [
              {
                kind: "edit_table",
                sheetName: "S",
                tableName: "Items",
                range: "A1:B2",
              },
            ],
          }),
        ),
        output = await files(directory, shrunk);
      expect(XLSX.read(output.bytes, { type: "buffer" }).Sheets.S?.A3.v).toBe(
        "B",
      );
      expect(await output.part("xl/tables/table1.xml")).toContain(
        'ref="A1:B2"',
      );
    }));
  it("grows an empty calculated table and rebases excluded row-context formulas before shrink and conversion", () =>
    workspace(async (directory, client) => {
      const source = await created(
        client,
        [
          {
            kind: "create_table",
            sheetName: "S",
            range: "A1:C1",
            name: "Items",
            style: "none",
            calculatedColumns: [
              { column: "Amount", formula: "[@Qty]*[@Price]" },
            ],
          },
        ],
        [[text("Qty"), text("Price"), text("Amount")]],
      );
      const next = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: source.version,
          changes: [
            {
              kind: "edit_table",
              sheetName: "S",
              tableName: "Items",
              range: "A1:C3",
            },
            {
              kind: "write_cells",
              sheetName: "S",
              startCell: "A2",
              values: [
                [number(2), number(10)],
                [number(3), number(5)],
              ],
              overwrite: true,
            },
            {
              kind: "edit_table",
              sheetName: "S",
              tableName: "Items",
              range: "A1:C2",
            },
            { kind: "convert_table", sheetName: "S", tableName: "Items" },
          ],
        }),
      );
      const output = await files(directory, next);
      expect(output.excel.getWorksheet("S")?.getCell("C2").value).toEqual({
        formula: "'S'!$A2*'S'!$B2",
      });
      expect(output.excel.getWorksheet("S")?.getCell("C3").value).toEqual({
        formula: "'S'!$A3*'S'!$B3",
      });
      expect(output.excel.getWorksheet("S")?.getCell("A3").value).toBe(3);
    }));
  it("copies table identities with their sheet and invalidates references to a subsequently deleted table", () =>
    workspace(async (directory, client) => {
      const source = await created(
        client,
        [
          {
            kind: "create_table",
            sheetName: "S",
            range: "A1:B2",
            name: "Sales",
            style: "none",
          },
          {
            kind: "write_formula",
            sheetName: "S",
            cell: "D1",
            formula: "SUM(Sales[Amount])",
          },
        ],
        [
          [text("Item"), text("Amount")],
          [text("A"), number(20)],
        ],
      );
      const copied = mutationReceiptSchema.parse(
        await call(client, "edit_workbook", {
          source: source.version,
          changes: [
            { kind: "copy_sheet", sheetName: "S", name: "Copy", mode: "all" },
            { kind: "add_sheet", name: "Summary" },
            {
              kind: "write_formula",
              sheetName: "Summary",
              cell: "A1",
              formula: "SUM(Sales[Amount])",
            },
          ],
        }),
      );
      const before = await files(directory, copied),
        copyFormula = (await worksheetXml(before, "Copy")).match(
          /<f[^>]*>(SUM\(CopiedTable[0-9]+\[Amount\]\))<\/f>/,
        )?.[1];
      expect(copyFormula).toBeDefined();
      const deleted = mutationReceiptSchema.parse(
          await call(client, "edit_workbook", {
            source: copied.version,
            changes: [{ kind: "delete_sheet", sheetName: "S" }],
          }),
        ),
        output = await files(directory, deleted);
      expect(await worksheetXml(output, "Summary")).toContain("SUM(#REF!)");
      expect(await worksheetXml(output, "Copy")).toContain(copyFormula);
    }));
  it("keeps inherited table header emphasis when a partial font change is materialized", () =>
    workspace(async (directory, client) => {
      const source = await created(
          client,
          [
            {
              kind: "create_table",
              sheetName: "S",
              range: "A1:B2",
              name: "Items",
            },
            {
              kind: "format_cells",
              sheetName: "S",
              range: "A1:B1",
              style: { font: { name: "Arial" } },
            },
            { kind: "convert_table", sheetName: "S", tableName: "Items" },
          ],
          [
            [text("Item"), text("Amount")],
            [text("A"), number(20)],
          ],
        ),
        output = await files(directory, source),
        font = output.excel.getWorksheet("S")?.getCell("A1").font;
      expect(font).toMatchObject({
        name: "Arial",
        bold: true,
        color: { argb: "FFFFFFFF" },
      });
    }));
  it("prevents scalar writes and clears from desynchronizing a table header", () =>
    workspace(async (directory, client) => {
      const source = await created(
          client,
          [
            {
              kind: "create_table",
              sheetName: "S",
              range: "A1:B2",
              name: "Items",
              style: "none",
            },
          ],
          [
            [text("Item"), text("Amount")],
            [text("A"), number(20)],
          ],
        ),
        before = await readdir(join(directory, "out"));
      for (const change of [
        {
          kind: "write_cells",
          sheetName: "S",
          startCell: "A1",
          values: [[text("Other")]],
          overwrite: true,
        },
        { kind: "clear_contents", sheetName: "S", range: "A1:B1" },
      ]) {
        const result = await client.callTool({
          name: "edit_workbook",
          arguments: { source: source.version, changes: [change] },
        });
        expect(result.isError).toBe(true);
        expect(payload(result)).toMatchObject({ error: "invalid_argument" });
      }
      expect(await readdir(join(directory, "out"))).toEqual(before);
    }));
  it("updates structured single-column and span references when deleting a table column", () =>
    workspace(async (directory, client) => {
      const source = await created(
        client,
        [
          {
            kind: "create_table",
            sheetName: "S",
            range: "A1:C2",
            name: "Items",
            style: "none",
          },
          {
            kind: "write_formula",
            sheetName: "S",
            cell: "E1",
            formula: "SUM(Items[Qty])",
          },
          {
            kind: "write_formula",
            sheetName: "S",
            cell: "E2",
            formula: "SUM(Items[[Qty]:[Price]])",
          },
        ],
        [
          [text("Item"), text("Qty"), text("Price")],
          [text("A"), number(2), number(10)],
        ],
      );
      const result = mutationReceiptSchema.parse(
          await call(client, "edit_workbook", {
            source: source.version,
            changes: [
              { kind: "delete_columns", sheetName: "S", at: 2, count: 1 },
            ],
          }),
        ),
        output = await files(directory, result);
      expect(output.excel.getWorksheet("S")?.getCell("D1").formula).toBe(
        "SUM(#REF!)",
      );
      expect(output.excel.getWorksheet("S")?.getCell("D2").formula).toBe(
        "SUM(Items[Price])",
      );
    }));
  it("refuses cross-workbook structured formulas rather than rebinding an unrelated same-named table", () =>
    workspace(async (directory, client) => {
      const first = await created(
        client,
        [
          {
            kind: "create_table",
            sheetName: "S",
            range: "A1:B2",
            name: "Items",
            style: "none",
          },
          {
            kind: "write_formula",
            sheetName: "S",
            cell: "D1",
            formula: "SUM(Items[Amount])",
          },
        ],
        [
          [text("Item"), text("Amount")],
          [text("A"), number(20)],
        ],
      );
      const second = await created(
          client,
          [
            {
              kind: "create_table",
              sheetName: "S",
              range: "A1:B2",
              name: "Items",
              style: "none",
            },
          ],
          [
            [text("Item"), text("Amount")],
            [text("Other"), number(99)],
          ],
        ),
        before = await readdir(join(directory, "out"));
      const response = await client.callTool({
        name: "edit_workbook",
        arguments: {
          source: second.version,
          changes: [
            {
              kind: "copy_range",
              sheetName: "S",
              range: "D1",
              targetSheet: "S",
              startCell: "F1",
              mode: "formulas",
              from: first.version,
            },
          ],
        },
      });
      expect(response.isError).toBe(true);
      expect(payload(response)).toMatchObject({
        error: "invalid_argument",
        message: expect.stringContaining("explicit table dependency mapping"),
      });
      expect(await readdir(join(directory, "out"))).toEqual(before);
    }));
  it("serializes dates and local datetimes with the SDK millisecond lexical form", () =>
    workspace(async (directory, client) => {
      const source = await created(
          client,
          [],
          [
            [
              { kind: "date", value: "2026-01-02" },
              { kind: "datetime", value: "2026-01-02T09:30:00" },
              { kind: "datetime", value: "2026-01-02T09:30:00.1" },
            ],
          ],
        ),
        output = await files(directory, source),
        xml = await output.part("xl/worksheets/sheet1.xml");
      expect(xml).toContain("2026-01-02T00:00:00.000");
      expect(xml).toContain("2026-01-02T09:30:00.000");
      expect(xml).toContain("2026-01-02T09:30:00.100");
      const next = mutationReceiptSchema.parse(
          await call(client, "edit_workbook", {
            source: source.version,
            changes: [
              {
                kind: "write_cells",
                sheetName: "S",
                startCell: "D1",
                values: [[number(1)]],
              },
            ],
          }),
        ),
        continued = await files(directory, next);
      expect(await continued.part("xl/worksheets/sheet1.xml")).toContain(
        "2026-01-02T00:00:00.000",
      );
    }));
  it("finishes data, appearance and formulas before dependent publication and independent retry", () =>
    workspace(async (directory, client) => {
      const source = await created(
        client,
        [],
        [
          [text("Id"), text("Amount")],
          [text("A"), number(2)],
          [text("B"), number(3)],
        ],
      );
      const group = {
        steps: [
          {
            kind: "read",
            id: "rows",
            source: source.version,
            selection: {
              kind: "records",
              sheetName: "S",
              range: "A1:B3",
              headerRow: 1,
            },
          },
        ],
        outputs: [
          {
            kind: "new",
            id: "report",
            sheets: [{ name: "Report", input: "rows" }],
          },
        ],
      };
      const finishing = [
        {
          kind: "format_cells",
          sheetName: "Report",
          range: "B2:B3",
          style: { numberFormat: "0.00" },
        },
        {
          kind: "write_formula",
          sheetName: "Report",
          cell: "D1",
          formula: "SUM(B2:B3)",
        },
      ];
      const good = bulkGroupReceiptSchema.parse(
          await call(client, "run_bulk_job", {
            job: bulkJobSchema.parse({
              kind: "dependent",
              group,
              finish: [{ output: "report", changes: finishing }],
            }),
          }),
        ),
        version = good.outputs[0];
      if (version === undefined) throw new Error("Missing finished output");
      const output = await files(directory, version);
      expect(output.excel.getWorksheet("Report")?.getCell("D1").value).toEqual({
        formula: "SUM(B2:B3)",
      });
      expect(output.excel.getWorksheet("Report")?.getCell("B2").numFmt).toBe(
        "0.00",
      );
      const bad = [
          {
            kind: "write_formula",
            sheetName: "Report",
            cell: "D1",
            formula: "FILTER(B2:B3,B2:B3>0)",
          },
        ],
        before = (await readdir(join(directory, "out"))).filter((n) =>
          n.startsWith("job-"),
        );
      const refused = await client.callTool({
        name: "run_bulk_job",
        arguments: {
          job: {
            kind: "dependent",
            group,
            finish: [{ output: "report", changes: bad }],
          },
        },
      });
      expect(refused.isError).toBe(true);
      expect(
        (await readdir(join(directory, "out"))).filter((n) =>
          n.startsWith("job-"),
        ),
      ).toEqual(before);
      const batch = {
        kind: "independent",
        jobs: [
          { id: "good", group },
          { id: "bad", group },
        ],
        finish: [
          { job: "good", output: "report", changes: finishing },
          { job: "bad", output: "report", changes: bad },
        ],
      };
      const partial = bulkBatchReceiptSchema.parse(
        await call(client, "run_bulk_job", { job: batch }),
      );
      expect(partial.kind).toBe("partial");
      expect(partial.jobs.map((j) => j.kind)).toEqual(["complete", "failed"]);
      const repaired = bulkBatchReceiptSchema.parse(
        await call(client, "run_bulk_job", {
          job: {
            ...batch,
            finish: [
              { job: "good", output: "report", changes: finishing },
              { job: "bad", output: "report", changes: finishing },
            ],
          },
        }),
      );
      expect(repaired.kind).toBe("complete");
      expect(repaired.jobs[0]).toEqual(partial.jobs[0]);
    }));
});
