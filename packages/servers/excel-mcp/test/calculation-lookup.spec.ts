import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import * as XLSX from "@e965/xlsx";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkbookRoot } from "../src/platform/paths.js";
import {
  createWorkbookOutput,
  versionReceiptSchema,
} from "../src/platform/versions.js";
import { createExcelMcpServer } from "../src/server.js";

const answers: readonly (readonly [
  string,
  number | string | boolean | { error: string },
])[] = [
  ["INDEX(Inputs!A1:B2,1,1)", 0],
  ["INDEX(Inputs!A1:B2,2,2)", 0],
  ["INDEX(Inputs!A1:B2,1,1)+5", 5],
  ["SUM(INDEX(Inputs!A1:B2,1,1),5)", 5],
  ["IFERROR(INDEX(Inputs!A1:B2,1,1),99)", 0],
  ["INDEX(Inputs!A1:A2,1)", 0],
  ["INDEX(Inputs!A1:B2,2,1)", 7],
  ["INDEX(Inputs!A1:B2,1,2)", "kept"],
  ["INDEX(Inputs!A1:B2,3,1)", { error: "#REF!" }],
  ["INDEX(Inputs!A1:B2,1,3)", { error: "#REF!" }],
  ["INDEX(Inputs!C1:C2,1)", false],
  ["INDEX(Inputs!C1:C2,2)", { error: "#DIV/0!" }],
  ["INDEX(Inputs!A1:C1,2)", "kept"],
  ["INDEX(Inputs!A1:C1,3)", false],
  ["INDEX(Inputs!A2:B2,2)", 0],
];

async function fixture(staleCache: boolean) {
  const workbook = new ExcelJS.Workbook();
  const inputs = workbook.addWorksheet("Inputs");
  inputs.getCell("A1").numFmt = "0.00";
  inputs.getCell("B1").value = "kept";
  inputs.getCell("A2").value = 7;
  inputs.getCell("C1").value = false;
  inputs.getCell("C2").value = { error: "#DIV/0!" };
  const results = workbook.addWorksheet("Calc");
  answers.forEach(([formula], index) => {
    results.getCell(index + 1, 1).value = {
      formula,
      ...(staleCache ? { result: 999 } : {}),
    };
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function check(bytes: Buffer, preserveFormulas = true) {
  const workbook = XLSX.read(bytes, { type: "buffer", cellDates: false });
  const saved = workbook.Sheets["Calc"];
  answers.forEach(([formula, expected], index) => {
    const cell = saved?.[`A${index + 1}`];
    const actual = cell?.t === "e" ? { error: cell.w } : cell?.v;
    expect(actual, formula).toEqual(expected);
    if (preserveFormulas) expect(cell?.f, formula).toBe(formula);
  });
}

describe("scalar INDEX blank references", () => {
  it("publishes correct scalar INDEX caches and refuses array results without successful stale caches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "excel-index-"));
    await mkdir(join(directory, "out"));
    const source = await fixture(true);
    await writeFile(join(directory, "source.xlsx"), source);
    const root = await createWorkbookRoot(directory);
    const server = createExcelMcpServer(root, {
      mode: "write",
      output: await createWorkbookOutput(root, "out"),
    });
    const client = new Client({ name: "index-contract", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(a), server.connect(b)]);
      const response = await client.callTool({
        name: "calculate_workbook",
        arguments: {
          source: {
            filePath: "source.xlsx",
            versionId: createHash("sha256").update(source).digest("hex"),
          },
        },
      });
      expect(response.isError).not.toBe(true);
      const item = response.content[0];
      if (item?.type !== "text")
        throw new Error("Missing calculation receipt.");
      const receipt = versionReceiptSchema
        .extend({
          calculation: z.object({
            complete: z.boolean(),
            formulaCells: z.number(),
            errorCells: z.number(),
            cacheStatus: z.string(),
          }),
        })
        .parse(JSON.parse(item.text));
      expect(receipt.calculation).toEqual({
        complete: true,
        formulaCells: answers.length,
        errorCells: 3,
        cacheStatus: "current",
      });
      const arrayBook = new ExcelJS.Workbook();
      const arrayInput = arrayBook.addWorksheet("Inputs");
      arrayInput.getCell("A1").value = 10;
      arrayInput.getCell("B1").value = 20;
      arrayInput.getCell("A2").value = 30;
      arrayInput.getCell("B2").value = 40;
      arrayBook.addWorksheet("Calc").getCell("A1").value = {
        formula: "INDEX(Inputs!A1:B2,2)",
        result: 999,
      };
      const arrayBytes = Buffer.from(await arrayBook.xlsx.writeBuffer());
      await writeFile(join(directory, "array.xlsx"), arrayBytes);
      const arrayResponse = await client.callTool({
        name: "calculate_workbook",
        arguments: {
          source: {
            filePath: "array.xlsx",
            versionId: createHash("sha256").update(arrayBytes).digest("hex"),
          },
        },
      });
      expect(arrayResponse.isError).not.toBe(true);
      const arrayItem = arrayResponse.content[0];
      if (arrayItem?.type !== "text")
        throw new Error("Missing array refusal receipt.");
      const arrayReceipt = versionReceiptSchema
        .extend({
          calculation: z.object({
            complete: z.boolean(),
            unavailableCells: z.number(),
          }),
        })
        .parse(JSON.parse(arrayItem.text));
      expect(arrayReceipt.calculation).toEqual({
        complete: false,
        unavailableCells: 1,
      });
      const arrayResult = XLSX.read(
        await readFile(join(directory, arrayReceipt.version.filePath)),
        { type: "buffer" },
      ).Sheets.Calc?.A1;
      expect(arrayResult?.v).toBeUndefined();
      const arrayZip = await JSZip.loadAsync(
        await readFile(join(directory, arrayReceipt.version.filePath)),
      );
      const arrayXml = await arrayZip
        .file("xl/worksheets/sheet2.xml")
        ?.async("string");
      expect(arrayXml).toContain("<f>INDEX(Inputs!A1:B2,2)</f>");
      expect(arrayXml).not.toMatch(/<v(?:\s|>)/);
      expect(await readFile(join(directory, "array.xlsx"))).toEqual(arrayBytes);
      check(await readFile(join(directory, receipt.version.filePath)));
      expect(await readFile(join(directory, "source.xlsx"))).toEqual(source);
    } finally {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.env.SEZZLEE_CALCULATION_ORACLE === "1")(
    "checks the same fixed answers with LibreOffice, without production evaluation or input caches",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "excel-index-oracle-"));
      try {
        await mkdir(join(directory, "out"));
        const source = await fixture(false);
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
        check(await readFile(join(directory, "out", "source.xlsx")), false);
        expect(await readFile(join(directory, "source.xlsx"))).toEqual(source);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
