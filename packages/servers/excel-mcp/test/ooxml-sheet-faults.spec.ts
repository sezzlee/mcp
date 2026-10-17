import { Buffer } from "node:buffer";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  describeOoxml,
  ooxmlSheetView,
  parseOoxml,
} from "../src/format/ooxml-workbook.js";
import {
  rawWorkbook,
  type RawWorkbookOptions,
} from "./fixtures/raw-workbook.js";

async function sheetOf(options: RawWorkbookOptions) {
  const loaded = parseOoxml(Buffer.from(await rawWorkbook(options)), "f.xlsx");
  return ooxmlSheetView(loaded, "S");
}

const meta = {
  filePath: "f.xlsx",
  sizeBytes: 1,
  modifiedAt: "2026-01-01T00:00:00.000Z",
};

const repeat = (count: number, line: (index: number) => string): string =>
  Array.from({ length: count }, (_, index) => line(index + 1)).join("");

/**
 * The part readers of a worksheet share one pass, taken when a tool first
 * needs that sheet. A fault is reported by the calls that read the sheet, under
 * the code it always had, and the hyperlink reader's faults still follow the
 * cell reader's.
 */
describe("where a worksheet's faults surface", () => {
  it("refuses a malformed worksheet only where it is read", async () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Good").getCell("A1").value = "kept";
    book.addWorksheet("Broken").getCell("A1").value = 1;
    const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
    const broken = await zip.file("xl/worksheets/sheet2.xml")?.async("string");
    expect(broken).toContain("</sheetData>");
    zip.file(
      "xl/worksheets/sheet2.xml",
      (broken ?? "").replace("</sheetData>", "</sheetDat>"),
    );
    const bytes = await zip.generateAsync({ type: "nodebuffer" });

    const loaded = parseOoxml(bytes, "f.xlsx");

    expect(ooxmlSheetView(loaded, "Good").rowAt(1)?.cellAt(1)?.value).toEqual({
      value: "kept",
    });
    expect(loaded.facts("Good").validations.rules).toEqual([]);
    for (const read of [
      () => ooxmlSheetView(loaded, "Broken"),
      () => loaded.facts("Broken"),
      () => describeOoxml(loaded, meta, { includeDefinedNames: false }),
    ]) {
      expect(read).toThrow(
        expect.objectContaining({
          code: "corrupt_workbook",
          message: expect.stringContaining("'xl/worksheets/sheet2.xml'"),
        }),
      );
    }
  });

  it("refuses a sheet whose relationships part is malformed though it has no hyperlink", async () => {
    await expect(
      sheetOf({
        sheetData: '<row r="1"><c r="A1"><v>1</v></c></row>',
        sheetRelationships: "<Relationship",
      }),
    ).rejects.toMatchObject({
      code: "corrupt_workbook",
      message: expect.stringContaining(
        "'xl/worksheets/_rels/sheet1.xml.rels' is not well-formed XML",
      ),
    });
  });

  it("reports a misnumbered row before too many hyperlinks written ahead of it", async () => {
    await expect(
      sheetOf({
        beforeSheetData: `<hyperlinks>${repeat(
          66_531,
          (index) => `<hyperlink ref="A${index}" location="S!A1"/>`,
        )}</hyperlinks>`,
        sheetData: '<row r="0"><c r="A1"><v>1</v></c></row>',
      }),
    ).rejects.toMatchObject({
      code: "corrupt_workbook",
      message: expect.stringContaining("row numbered '0'"),
    });
  });
});
