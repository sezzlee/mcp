import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import ExcelJS from "exceljs";
import JSZip from "jszip";
import * as XLSX from "@e965/xlsx";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { calculateWorkbook } from "../src/calculation/workbook.js";
import { createWorkbookRoot } from "../src/platform/paths.js";
import {
  createWorkbookOutput,
  versionReceiptSchema,
} from "../src/platform/versions.js";
import { createExcelMcpServer } from "../src/server.js";

const knownAnswers: readonly (readonly [
  string,
  number | string | boolean | { error: string },
])[] = [
  ["2+3*4", 14],
  ["(2+3)*4", 20],
  ["-2^2", 4],
  ["2^3^2", 64],
  ["2^-2", 0.25],
  ["50%*8", 4],
  ['"a"&"B"', "aB"],
  ['"a"="A"', true],
  ['1="1"', false],
  ["1<TRUE", true],
  ["Inputs!B1+1", 8],
  ["Inputs!D1+1", 1],
  ["Inputs!D1", 0],
  ["Inputs!D2", "=2+3"],
  ['"_x0041_"&"<&"', "A<&"],
  ["SUM(Inputs!A1:A3)", 8],
  ['SUM("7",TRUE)', 8],
  ["SUM(Inputs!B1)", 0],
  ["SUM(Inputs!C1)", 0],
  ["AVERAGE(Inputs!A1:A3)", 8 / 3],
  ["MIN(Inputs!A1:A3)", -2],
  ["MAX(Inputs!A1:A3)", 7],
  ["COUNT(Inputs!A1:C3)", 3],
  ['COUNT("7",TRUE)', 2],
  ["COUNTA(Inputs!A1:C3)", 8],
  ["COUNTBLANK(Inputs!C1:C4)", 2],
  ["IF(TRUE,7,1/0)", 7],
  ["IF(FALSE,1/0,9)", 9],
  ["IF(FALSE,1)", false],
  ["IF(FALSE,1,)", 0],
  ["IFERROR(1/0,9)", 9],
  ["IFERROR(Inputs!B3,9)", 9],
  ["AND(Inputs!C1:C2)", false],
  ["OR(Inputs!C1:C2)", true],
  ["NOT(FALSE)", true],
  ["ABS(-3)", 3],
  ["ROUND(-2.5,0)", -3],
  ["ROUND(1.005,2)", 1.01],
  ["ROUNDUP(-1.21,1)", -1.3],
  ["ROUNDDOWN(-1.29,1)", -1.2],
  ["ROUNDUP(0.14,2)", 0.14],
  ["ROUNDDOWN(0.29,2)", 0.29],
  ['SUMIF(Inputs!A1:A3,">0")', 10],
  ['COUNTIF(Inputs!B1:B2,"a*")', 1],
  ['COUNTIF(Inputs!B1:B2,">0")', 0],
  ["COUNTIF(Inputs!A1:B2,7)", 2],
  ['COUNTIF(Inputs!C1:C2,"TRUE")', 1],
  ["COUNTIF(Inputs!C1:C2,TRUE)", 1],
  ['COUNTIF(Inputs!A1:A3,"<>foo")', 3],
  ['COUNTIF(Inputs!B1:B3,"#DIV/0!")', 1],
  ["COUNTIF(Inputs!A1:A3,#N/A)", { error: "#N/A" }],
  ["VLOOKUP(3,Inputs!A1:C3,2,FALSE)", "abc"],
  ["MATCH(3,Inputs!A1:A3,0)", 2],
  ["INDEX(Inputs!A1:C3,2,2)", "abc"],
  ["INDEX(Inputs!A1:C3,1,4)", { error: "#REF!" }],
  ["VLOOKUP(99,Inputs!A1:C3,2,FALSE)", { error: "#N/A" }],
  ["Inputs!A4+1", 45293],
  ["SUM(Numbers)", 8],
  ["'Inputs'!$A$1+Inputs!A2", 10],
  ["1/0", { error: "#DIV/0!" }],
  ["SUM(Inputs!B1:B3)", { error: "#DIV/0!" }],
  ["AVERAGE(Inputs!D1:D3)", { error: "#DIV/0!" }],
  ['"bad"+1', { error: "#VALUE!" }],
  ["0^0", { error: "#NUM!" }],
];

async function fixture(formulas: readonly string[], staleCache = true) {
  const workbook = new ExcelJS.Workbook();
  const inputs = workbook.addWorksheet("Inputs");
  inputs.addRow([7, "7", true]);
  inputs.addRow([3, "abc", false]);
  inputs.addRow([-2, { error: "#DIV/0!" }]);
  inputs.getCell("A4").value = new Date("2024-01-01T00:00:00Z");
  inputs.getCell("D2").value = "=2+3";
  workbook.definedNames.add("'Inputs'!$A$1:$A$3", "Numbers");
  const results = workbook.addWorksheet("Calc");
  formulas.forEach((formula, index) => {
    results.getCell(index + 1, 1).value = {
      formula,
      ...(staleCache ? { result: 999 } : {}),
    };
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function reopened(bytes: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  return workbook;
}

function cached(workbook: ExcelJS.Workbook, row: number) {
  return workbook.getWorksheet("Calc")?.getCell(row, 1).result;
}

async function payload(
  client: Client,
  source: { filePath: string; versionId: string },
) {
  const result = await client.callTool({
    name: "calculate_workbook",
    arguments: { source },
  });
  const item = result.content[0];
  if (item?.type !== "text")
    throw new Error("Expected a JSON calculation receipt.");
  const value: unknown = JSON.parse(item.text);
  return { result, value };
}

describe("server-side calculation", () => {
  it.runIf(process.env.SEZZLEE_CALCULATION_ORACLE === "1")(
    "checks the fixed known answers against LibreOffice independently of the production evaluator",
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "excel-calculation-oracle-"),
      );
      try {
        await mkdir(join(directory, "out"));
        const excelSpecific = new Set([
          "1<TRUE",
          'SUM("7",TRUE)',
          "SUM(Inputs!C1)",
          "COUNT(Inputs!A1:C3)",
          "0^0",
          'COUNTIF(Inputs!C1:C2,"TRUE")',
          "COUNTIF(Inputs!C1:C2,TRUE)",
          "COUNTIF(Inputs!A1:B2,7)",
        ]);
        const commonAnswers = knownAnswers.filter(
          ([formula]) => !excelSpecific.has(formula),
        );
        const source = await fixture(
          commonAnswers.map(([formula]) => formula),
          false,
        );
        await writeFile(join(directory, "source.xlsx"), source);
        await promisify(execFile)(
          "soffice",
          [
            "--headless",
            `-env:UserInstallation=file://${join(directory, "profile")}`,
            "--convert-to",
            "xlsx",
            "--outdir",
            join(directory, "out"),
            join(directory, "source.xlsx"),
          ],
          { timeout: 25_000 },
        );
        const saved = XLSX.read(
          await readFile(join(directory, "out", "source.xlsx")),
          { type: "buffer", cellDates: false },
        ).Sheets["Calc"];
        const differences = commonAnswers.flatMap(([formula, expected], i) => {
          const cell = saved?.[`A${i + 1}`];
          const actual = cell?.t === "e" ? { error: cell.w } : cell?.v;
          const matches =
            typeof expected === "number"
              ? typeof actual === "number" &&
                Math.abs(actual - expected) <=
                  1e-10 * Math.max(1, Math.abs(expected))
              : JSON.stringify(actual) === JSON.stringify(expected);
          return matches ? [] : [{ formula, expected, actual }];
        });
        expect(differences).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("matches independent known answers and persists typed caches without changing formulas or the input", async () => {
    const input = await fixture(knownAnswers.map(([formula]) => formula));
    const original = Buffer.from(input);
    const output = calculateWorkbook(input);
    expect(input.equals(original)).toBe(true);
    expect(output.calculation).toMatchObject({
      complete: true,
      formulaCells: knownAnswers.length,
      unavailableCells: 0,
    });
    const workbook = await reopened(output.bytes);
    for (const [index, [formula, expected]] of knownAnswers.entries()) {
      const actual = cached(workbook, index + 1);
      if (typeof expected === "number")
        expect(actual, formula).toBeCloseTo(expected, 10);
      else expect(actual, formula).toEqual(expected);
      expect(workbook.getWorksheet("Calc")?.getCell(index + 1, 1).formula).toBe(
        formula,
      );
    }
    const zip = await JSZip.loadAsync(output.bytes);
    const xml = await zip.file("xl/worksheets/sheet2.xml")?.async("string");
    expect(xml).toContain('t="str"');
    expect(xml).toContain('t="b"');
    expect(xml).toContain('t="e"');
    expect(output.calculation.omittedResults).toBe(knownAnswers.length - 20);
  });

  it("distinguishes unsupported formulas, cycles and their dependents and clears every stale cache", async () => {
    const formulas = [
      "SIN(1)",
      "A1+1",
      "A4+1",
      "A3+1",
      "NOW()",
      "IFERROR(A1,99)",
      "VLOOKUP(7,Inputs!A1:C3,2,TRUE)",
      "'[other.xlsx]S'!A1",
    ];
    const calculated = calculateWorkbook(await fixture(formulas));
    expect(calculated.calculation).toMatchObject({
      complete: false,
      calculatedCells: 0,
      unavailableCells: 8,
    });
    expect(calculated.calculation.results.map((cell) => cell.result)).toEqual([
      expect.objectContaining({ kind: "unsupported" }),
      expect.objectContaining({ kind: "dependency" }),
      expect.objectContaining({ kind: "cycle" }),
      expect.objectContaining({ kind: "cycle" }),
      expect.objectContaining({ kind: "unsupported" }),
      expect.objectContaining({ kind: "dependency" }),
      expect.objectContaining({ kind: "unsupported" }),
      expect.objectContaining({ kind: "unsupported" }),
    ]);
    const workbook = await reopened(calculated.bytes);
    for (let row = 1; row <= formulas.length; row += 1)
      expect(cached(workbook, row)).toBeUndefined();
  });

  it("recomputes changed inputs through cross-sheet chains, preserves tables and supports structured references", async () => {
    const workbook = await reopened(
      await fixture(["Inputs!A1*2", "A1+1", "SUM(Sales[Amount])"]),
    );
    const input = workbook.getWorksheet("Inputs");
    if (input === undefined) throw new Error("Missing input sheet.");
    input.getCell("A1").value = 10;
    input.addTable({
      name: "Sales",
      ref: "F1",
      headerRow: true,
      columns: [{ name: "Amount" }],
      rows: [[4], [6]],
    });
    const inputBytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const output = calculateWorkbook(inputBytes);
    const saved = await reopened(output.bytes);
    expect([cached(saved, 1), cached(saved, 2), cached(saved, 3)]).toEqual([
      20, 21, 10,
    ]);
    const originalZip = await JSZip.loadAsync(inputBytes),
      savedZip = await JSZip.loadAsync(output.bytes);
    expect(await savedZip.file("xl/tables/table1.xml")?.async("string")).toBe(
      await originalZip.file("xl/tables/table1.xml")?.async("string"),
    );
  });

  it.each([
    "SUM(Inputs!A1:A100001)",
    "-".repeat(130) + "1",
    "1+".repeat(4100) + "1",
  ])("refuses budget exhaustion atomically: %s", async (formula) => {
    const source = await fixture([formula]);
    const hash = createHash("sha256").update(source).digest("hex");
    expect(() => calculateWorkbook(source)).toThrow(/budget|exceeds/i);
    expect(createHash("sha256").update(source).digest("hex")).toBe(hash);
  });

  it("enforces aggregate work across individually permitted ranges", async () => {
    const input = await fixture(
      Array.from({ length: 6 }, () => "SUM(Inputs!A1:A100000)"),
    );
    expect(() => calculateWorkbook(input)).toThrow(/work budget/);
  });

  it("refuses a formula population beyond the declared workbook budget before evaluation", async () => {
    const input = await fixture(Array.from({ length: 10_001 }, () => "1+1"));
    expect(() => calculateWorkbook(input)).toThrow(/10,000 formula cells/);
  });

  it("honors the 1904 date system and numeric leap-day serials without locale conversion", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.properties.date1904 = true;
    const sheet = workbook.addWorksheet("Calc");
    sheet.getCell("B1").value = new Date("1904-01-02T00:00:00Z");
    sheet.getCell("A1").value = { formula: "B1+1" };
    sheet.getCell("B2").value = 60;
    sheet.getCell("A2").value = { formula: "B2+1" };
    const output = calculateWorkbook(
      Buffer.from(await workbook.xlsx.writeBuffer()),
    );
    const saved = await reopened(output.bytes);
    expect(output.calculation.dateSystem).toBe("1904");
    expect([cached(saved, 1), cached(saved, 2)]).toEqual([2, 61]);
  });

  it("uses sheet-scoped static names before workbook names and refuses relative name anchors", async () => {
    const zip = await JSZip.loadAsync(
      await fixture(["SUM(Numbers)", "SUM(Relative)"]),
    );
    const part = zip.file("xl/workbook.xml");
    if (part === null) throw new Error("Missing workbook.");
    zip.file(
      "xl/workbook.xml",
      (await part.async("string")).replace(
        "</definedNames>",
        '<definedName name="Numbers" localSheetId="1">Inputs!$A$1</definedName><definedName name="Relative">Inputs!A1</definedName></definedNames>',
      ),
    );
    const output = calculateWorkbook(
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    expect(cached(await reopened(output.bytes), 1)).toBe(7);
    expect(output.calculation.results[1]?.result).toMatchObject({
      kind: "unsupported",
    });
    expect(output.calculation.unavailableCells).toBe(1);
  });

  it("clears unsupported shared-formula caches while preserving their formula group", async () => {
    const zip = await JSZip.loadAsync(
      await fixture(["Inputs!A1*2", "Inputs!A2*2"]),
    );
    const part = zip.file("xl/worksheets/sheet2.xml");
    if (part === null) throw new Error("Missing formulas.");
    zip.file(
      "xl/worksheets/sheet2.xml",
      (await part.async("string"))
        .replace(
          "<f>Inputs!A1*2</f>",
          '<f t="shared" ref="A1:A2" si="0">Inputs!A1*2</f>',
        )
        .replace("<f>Inputs!A2*2</f>", '<f t="shared" si="0"/>'),
    );
    const output = calculateWorkbook(
      await zip.generateAsync({ type: "nodebuffer" }),
    );
    expect(output.calculation).toMatchObject({
      complete: false,
      unavailableCells: 2,
      cachedFormulaValues: 0,
    });
    const saved = await reopened(output.bytes);
    expect([cached(saved, 1), cached(saved, 2)]).toEqual([
      undefined,
      undefined,
    ]);
    expect(saved.getWorksheet("Calc")?.getCell("A2").formula).toBe(
      "Inputs!A2*2",
    );
  });

  it.each(["protection", "iteration", "precision", "array"])(
    "refuses a source requiring unsupported preservation or calculation semantics: %s",
    async (kind) => {
      const zip = await JSZip.loadAsync(await fixture(["Inputs!A1*2"]));
      const name =
        kind === "protection" || kind === "array"
          ? "xl/worksheets/sheet2.xml"
          : "xl/workbook.xml";
      const part = zip.file(name);
      if (part === null) throw new Error("Missing fixture part.");
      const xml = await part.async("string");
      zip.file(
        name,
        kind === "protection"
          ? xml.replace(
              "</sheetData>",
              '</sheetData><sheetProtection sheet="1"/>',
            )
          : kind === "array"
            ? xml.replace("<f>", '<f t="array" ref="A1:A2">')
            : xml.replace(
                /<calcPr\b[^>]*\/>/,
                `<calcPr ${kind === "iteration" ? 'iterate="1"' : 'fullPrecision="0"'}/>`,
              ),
      );
      const input = await zip.generateAsync({ type: "nodebuffer" });
      expect(() => calculateWorkbook(input)).toThrow(
        kind === "protection"
          ? /unsupported editing features/
          : kind === "array"
            ? /array or data-table/
            : /Iterative calculation.*precision-as-displayed/,
      );
    },
  );

  it("publishes a version through MCP, rejects stale sources and leaves no output on calculation refusal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "excel-calculation-"));
    await mkdir(join(directory, "out"));
    const source = await fixture(["Inputs!A1+Inputs!A2"]);
    await writeFile(join(directory, "source.xlsx"), source);
    const root = await createWorkbookRoot(directory);
    const server = createExcelMcpServer(root, {
      mode: "write",
      output: await createWorkbookOutput(root, "out"),
    });
    const client = new Client({ name: "calculation-contract", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(a), server.connect(b)]);
      const version = {
        filePath: "source.xlsx",
        versionId: createHash("sha256").update(source).digest("hex"),
      };
      const response = await payload(client, version);
      expect(response.result.isError).not.toBe(true);
      const receipt = versionReceiptSchema
        .extend({ calculation: z.unknown() })
        .parse(response.value);
      const calculated = z
        .object({
          calculation: z.object({
            complete: z.boolean(),
            calculatedCells: z.number(),
          }),
        })
        .parse(response.value);
      expect(calculated.calculation).toEqual({
        complete: true,
        calculatedCells: 1,
      });
      expect(
        cached(
          await reopened(
            await readFile(join(directory, receipt.version.filePath)),
          ),
          1,
        ),
      ).toBe(10);
      expect(await readFile(join(directory, "source.xlsx"))).toEqual(source);
      const edited = await client.callTool({
        name: "edit_workbook",
        arguments: {
          source: receipt.version,
          changes: [
            {
              kind: "write_cells",
              sheetName: "Inputs",
              startCell: "A1",
              values: [[{ kind: "number", value: 20 }]],
              overwrite: true,
            },
          ],
        },
      });
      expect(edited.isError).not.toBe(true);
      const editText = edited.content[0];
      if (editText?.type !== "text") throw new Error("Missing edit receipt.");
      const editedVersion = z
        .object({ version: versionReceiptSchema.shape.version })
        .parse(JSON.parse(editText.text)).version;
      expect(
        cached(
          await reopened(
            await readFile(join(directory, editedVersion.filePath)),
          ),
          1,
        ),
      ).toBeUndefined();
      const recalculated = await payload(client, editedVersion);
      expect(recalculated.result.isError).not.toBe(true);
      const updated = versionReceiptSchema
        .extend({ calculation: z.unknown() })
        .parse(recalculated.value);
      expect(
        cached(
          await reopened(
            await readFile(join(directory, updated.version.filePath)),
          ),
          1,
        ),
      ).toBe(23);
      expect(
        cached(
          await reopened(
            await readFile(join(directory, receipt.version.filePath)),
          ),
          1,
        ),
      ).toBe(10);
      await writeFile(
        join(directory, "source.xlsx"),
        await fixture(["SUM(A1:A100001)"]),
      );
      expect((await payload(client, version)).result.isError).toBe(true);
      const changed = await readFile(join(directory, "source.xlsx"));
      const files = await readdir(join(directory, "out"));
      expect(
        (
          await payload(client, {
            ...version,
            versionId: createHash("sha256").update(changed).digest("hex"),
          })
        ).result.isError,
      ).toBe(true);
      expect(await readdir(join(directory, "out"))).toEqual(files);
    } finally {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
