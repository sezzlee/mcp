import { describe, expect, inject, it } from "vitest";
import ExcelJS from "exceljs";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { loadDocument, type LoadedWorkbook } from "../src/format/document.js";
import {
  createWorkbookRoot,
  resolveWorkbookPath,
  type SandboxedPath,
} from "../src/platform/paths.js";
import { createHandlers } from "../src/tools/handlers.js";
import { collectValidations } from "../src/metadata/validations.js";

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

async function loadXlsx(file: string): Promise<LoadedWorkbook> {
  const loaded = await loadDocument(await pathTo(file));
  if (loaded.format !== "xlsx") {
    throw new Error("expected an xlsx fixture");
  }
  return loaded;
}

/**
 * The reference the OOXML reader has to agree with while ExcelJS is still in
 * the tree: its own model, regrouped the way the tool used to report it.
 */
function excelJsRules(
  worksheet: ExcelJS.Worksheet,
): readonly Record<string, unknown>[] {
  const host = worksheet as ExcelJS.Worksheet & {
    readonly dataValidations?: {
      readonly model?: Record<string, Record<string, unknown> | undefined>;
    };
  };
  const model = host.dataValidations?.model ?? {};
  const groups = new Map<string, Record<string, unknown>>();
  for (const address of Object.keys(model)) {
    const rule = model[address];
    if (rule === undefined) continue;
    groups.set(JSON.stringify(rule), rule);
  }
  return [...groups.values()];
}

function comparable(rule: object): string {
  const entries = Object.entries(rule as Record<string, unknown>)
    .filter(([key]) => key !== "ranges" && key !== "rangesTruncated")
    .map(([key, value]): [string, unknown] => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify(entries);
}

describe("the OOXML data validation reader agrees with ExcelJS", () => {
  it("reports the same rules for every validation type", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Data");
    sheet.getCell("A1").value = "seed";
    const host = sheet as ExcelJS.Worksheet & {
      readonly dataValidations: {
        add(range: string, rule: Record<string, unknown>): void;
      };
    };
    const list = { type: "list", allowBlank: true, formulae: ['"x,y"'] };
    host.dataValidations.add("A2:A5000", { ...list });
    host.dataValidations.add("C2:C10", { ...list });
    host.dataValidations.add("E2:E10", {
      type: "whole",
      operator: "greaterThan",
      allowBlank: false,
      formulae: [0],
    });
    host.dataValidations.add("G2:G3", {
      type: "textLength",
      operator: "between",
      formulae: [1, 10],
      showErrorMessage: true,
      errorStyle: "warning",
      errorTitle: "T",
      error: "E",
      promptTitle: "P",
      prompt: "p",
      showInputMessage: true,
    });
    host.dataValidations.add("I2:I3", {
      type: "date",
      operator: "greaterThan",
      formulae: [new Date(Date.UTC(2026, 0, 1))],
    });
    host.dataValidations.add("K2:K3", {
      type: "decimal",
      operator: "lessThan",
      formulae: [3.5],
    });
    host.dataValidations.add("M2:M3", {
      type: "custom",
      formulae: ["ISNUMBER(M2)"],
    });
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

    const reference = new ExcelJS.Workbook();
    await reference.xlsx.load(Uint8Array.from(bytes).buffer);
    const expected = excelJsRules(reference.worksheets[0]!);

    const { parseOoxml } = await import("../src/format/ooxml-workbook.js");
    const parsed = parseOoxml(bytes, "parity.xlsx");
    const actual = collectValidations("Data", parsed.facts("Data").validations);

    expect(actual.rules).toHaveLength(expected.length);
    expect(actual.rules.map(comparable).sort()).toEqual(
      expected.map(comparable).sort(),
    );
  });

  it("reads the sqref as written instead of one entry per cell", async () => {
    const loaded = await loadXlsx("validations.xlsx");
    const report = collectValidations(
      "Data",
      loaded.workbook.facts("Data").validations,
    );
    const list = report.rules.find((rule) => rule.type === "list");
    expect(list?.ranges).toEqual(["A2:A5000", "C2:C10"]);
    expect(report.coveredCellCount).toBe(5017);
    expect(report.rangesTruncated).toBe(false);
  });

  it("counts a whole-column rule without visiting its cells", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Wide");
    sheet.getCell("A1").value = "seed";
    (
      sheet as ExcelJS.Worksheet & {
        readonly dataValidations: {
          add(range: string, rule: Record<string, unknown>): void;
        };
      }
    ).dataValidations.add("A1:A1048576", {
      type: "custom",
      formulae: ["TRUE()"],
    });
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const { parseOoxml } = await import("../src/format/ooxml-workbook.js");
    const report = collectValidations(
      "Wide",
      parseOoxml(bytes, "wide.xlsx").facts("Wide").validations,
    );
    expect(report.count).toBe(1);
    expect(report.rules[0]?.ranges).toEqual(["A1:A1048576"]);
    expect(report.coveredCellCount).toBe(1_048_576);
  });
});

describe("validations no longer need the ExcelJS metadata reader", () => {
  for (const file of ["prefixed.xlsx", "unnumbered-sheet.xlsx"]) {
    it(`answers get_data_validations for ${file}`, async () => {
      const fixtures = inject("fixtures");
      const handlers = createHandlers(await createWorkbookRoot(fixtures.root));
      const result = await handlers.get_data_validations({ filePath: file });
      expect(result.isError).not.toBe(true);
      const body = payload(result);
      expect(body).toMatchObject({
        sheet: "Veri",
        count: 1,
        coveredCellCount: 2,
        rangesTruncated: false,
      });
      expect(body["rules"]).toEqual([
        {
          ranges: ["A2:A3"],
          rangesTruncated: false,
          type: "list",
          allowBlank: true,
          showErrorMessage: true,
          errorTitle: "Hata",
          error: "Listeden seçin",
          formulae: ['"Kalem,Defter"'],
        },
      ]);
    });

    it(`declares dataValidations as a capability for ${file}`, async () => {
      const fixtures = inject("fixtures");
      const handlers = createHandlers(await createWorkbookRoot(fixtures.root));
      const body = payload(
        await handlers.describe_workbook({ filePath: file }),
      );
      const capabilities = body["capabilities"] as Record<string, boolean>;
      expect(capabilities["dataValidations"]).toBe(true);
      expect(
        (await loadXlsx(file)).workbook.facts("Veri").validations.rules,
      ).toHaveLength(1);
    });
  }
});
