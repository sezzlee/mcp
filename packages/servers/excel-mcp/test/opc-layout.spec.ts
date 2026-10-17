import { beforeAll, describe, expect, inject, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  createWorkbookRoot,
  resolveWorkbookPath,
  type SandboxedPath,
} from "../src/platform/paths.js";
import { readFile } from "node:fs/promises";
import type { ToolHandlers } from "../src/tools/definitions.js";
import { createHandlers } from "../src/tools/handlers.js";

function payload(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected a text payload");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function pathTo(file: string): Promise<SandboxedPath> {
  const fixtures = inject("fixtures");
  const root = await createWorkbookRoot(fixtures.root);
  return resolveWorkbookPath(root, file);
}

const layouts = [
  ["prefixed.xlsx", "a prefixed SpreadsheetML namespace"],
  ["unnumbered-sheet.xlsx", "an unnumbered worksheet part name"],
] as const;

describe("OPC layouts Excel accepts but ExcelJS cannot read", () => {
  let handlers: ToolHandlers;

  beforeAll(async () => {
    const fixtures = inject("fixtures");
    handlers = createHandlers(await createWorkbookRoot(fixtures.root));
  });

  for (const [file, layout] of layouts) {
    describe(layout, () => {
      it("reads the grid", async () => {
        const result = await handlers.read_sheet({ filePath: file });
        expect(result.isError).not.toBe(true);
        const body = payload(result);
        expect(body["sheet"]).toBe("Veri");
        expect(body["usedRange"]).toBe("A1:B5");
        expect(body["values"]).toEqual([
          ["Kalem", 12],
          ["Defter", 7],
          [null, null],
          ["Toplam", null],
        ]);
      });

      it("describes the workbook with every capability intact", async () => {
        const result = await handlers.describe_workbook({ filePath: file });
        expect(result.isError).not.toBe(true);
        const body = payload(result);
        const capabilities = body["capabilities"] as Record<string, boolean>;
        expect(capabilities["merges"]).toBe(true);
        expect(capabilities["formulas"]).toBe(true);
        expect(capabilities["dataValidations"]).toBe(true);
        expect(capabilities["tables"]).toBe(true);
        expect(capabilities["conditionalFormats"]).toBe(true);
        expect(capabilities["images"]).toBe(true);
        expect(capabilities["frozenPanes"]).toBe(true);

        const sheets = body["sheets"] as readonly Record<string, unknown>[];
        expect(sheets[0]).toMatchObject({
          name: "Veri",
          usedRange: "A1:B5",
          mergeCount: 1,
          dataValidationRuleCount: 1,
          tableCount: 1,
          conditionalFormatRuleCount: 2,
          imageCount: 2,
        });
      });

      it("reports merges, which need no rich metadata", async () => {
        const result = await handlers.get_merged_ranges({ filePath: file });
        expect(result.isError).not.toBe(true);
        expect(payload(result)["merges"]).toEqual(["A5:B5"]);
      });

      it("answers every metadata tool", async () => {
        for (const tool of [
          "get_data_validations",
          "get_tables",
          "get_conditional_formats",
          "get_images",
          "get_charts",
        ] as const) {
          const result = await handlers[tool]({ filePath: file });
          expect(result.isError).not.toBe(true);
        }
      });

      it("is unreadable by ExcelJS, which is why the layout is a fixture", async () => {
        const { default: ExcelJS } = await import("exceljs");
        const bytes = await readFile(await pathTo(file));
        const workbook = new ExcelJS.Workbook();
        await expect(
          (async () => {
            await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
            if (workbook.worksheets.length === 0) throw new Error("no sheets");
          })(),
        ).rejects.toThrow();
      });
    });
  }
});

describe("the default layout keeps every capability too", () => {
  it("declares them for a workbook ExcelJS could also read", async () => {
    const fixtures = inject("fixtures");
    const handlers = createHandlers(await createWorkbookRoot(fixtures.root));
    const body = payload(
      await handlers.describe_workbook({ filePath: "q1/sample.xlsx" }),
    );
    const capabilities = body["capabilities"] as Record<string, boolean>;
    expect(capabilities["dataValidations"]).toBe(true);
    expect(capabilities["tables"]).toBe(true);
    expect(capabilities["conditionalFormats"]).toBe(true);
    expect(capabilities["images"]).toBe(true);
    expect(capabilities["frozenPanes"]).toBe(true);
  });
});
