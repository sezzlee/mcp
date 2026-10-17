import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { ooxmlSheetView, parseOoxml } from "../src/format/ooxml-workbook.js";
import {
  rawWorkbook,
  type RawWorkbookOptions,
} from "./fixtures/raw-workbook.js";

async function sheetOf(options: RawWorkbookOptions) {
  const loaded = parseOoxml(Buffer.from(await rawWorkbook(options)), "b.xlsx");
  return { loaded, view: ooxmlSheetView(loaded, "S") };
}

const repeat = (count: number, line: (index: number) => string): string =>
  Array.from({ length: count }, (_, index) => line(index + 1)).join("");

/**
 * Each case is shaped so the reader's work grows with the product of two
 * counts in the file unless an index or a budget stops it. The default test
 * timeout is the assertion that it does: the unbounded reader takes minutes.
 */
describe("sheet reading stays bounded", () => {
  it("indexes hyperlinks that each name the whole sheet", async () => {
    const links = 20_000;
    const { view } = await sheetOf({
      sheetData: '<row r="3"><c r="C3"><v>1</v></c></row>',
      afterSheetData: `<hyperlinks>${repeat(
        links,
        (index) => `<hyperlink ref="A1:XFD1048576" location="S!A${index}"/>`,
      )}</hyperlinks>`,
    });

    expect(view.rowAt(3)?.cellAt(3)?.value).toEqual({
      value: 1,
      href: `#S!A${links}`,
    });
    expect(view.rowAt(1)?.cellAt(1)?.value).toEqual({
      value: null,
      href: `#S!A${links}`,
    });
  });

  it("refuses more hyperlinks than Excel keeps on one sheet", async () => {
    const pending = sheetOf({
      sheetData: "",
      afterSheetData: `<hyperlinks>${repeat(
        66_531,
        (index) => `<hyperlink ref="A${index}" location="S!A1"/>`,
      )}</hyperlinks>`,
    });

    await expect(pending).rejects.toMatchObject({
      code: "file_too_large",
      message: expect.stringMatching(/more than 66530 hyperlinks/),
    });
  });

  it("finds a row's merges without scanning every merge", async () => {
    const rows = 100_000;
    const { view } = await sheetOf({
      sheetData:
        '<row r="1"><c r="A1"><v>1</v></c></row>' +
        `<row r="${rows}"><c r="A${rows}"><v>${rows}</v></c></row>`,
      afterSheetData: `<mergeCells>${repeat(
        rows,
        (row) => `<mergeCell ref="A${row}:B${row}"/>`,
      )}</mergeCells>`,
    });

    const continued: unknown[] = [];
    for (let row = 1; row <= rows; row += 1) {
      const cell = view.rowAt(row)?.cellAt(2);
      if (cell !== undefined) continued.push([row, cell.merged, cell.value]);
    }
    expect(continued).toEqual([
      [1, true, { value: 1 }],
      [rows, true, { value: rows }],
    ]);
  });

  it("keeps a shared formula's members unexpanded until they are read", async () => {
    const members = 40_000;
    const text = Array.from({ length: 2_700 }, () => "B1").join("+");
    const before = process.memoryUsage().heapUsed;
    const { loaded, view } = await sheetOf({
      sheetData:
        `<row r="1"><c r="A1"><f t="shared" si="0" ref="A1:A${members}">${text}</f></c></row>` +
        repeat(
          members - 1,
          (index) =>
            `<row r="${index + 1}"><c r="A${index + 1}"><f t="shared" si="0"/></c></row>`,
        ),
    });
    loaded.sheet("S");
    const retained = process.memoryUsage().heapUsed - before;

    /**
     * Guard: expanded up front, the members hold 40,000 copies of an
     * 8,000-character formula, measured at 760 MB; unexpanded they hold none.
     */
    expect(retained).toBeLessThan(128 * 1024 * 1024);
    expect(view.rowAt(members)?.cellAt(1)?.formula).toBe(
      Array.from({ length: 2_700 }, () => `B${members}`).join("+"),
    );
  });
});

describe("overlapping merges", () => {
  it.each([
    ["A1:C2", "B2:D3", 2],
    ["A1:D1", "B1:C1", 1],
  ])("refuses %s and %s when row %i is read", async (first, second, row) => {
    const { view } = await sheetOf({
      sheetData: '<row r="1"><c r="A1"><v>1</v></c></row>',
      afterSheetData: `<mergeCells><mergeCell ref="${first}"/><mergeCell ref="${second}"/></mergeCells>`,
    });

    expect(() => view.rowAt(row)).toThrow(
      expect.objectContaining({
        code: "corrupt_workbook",
        message: expect.stringMatching(/overlap/),
      }),
    );
  });

  it("reads merges that only touch", async () => {
    const { view } = await sheetOf({
      sheetData:
        '<row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>2</v></c></row>',
      afterSheetData:
        '<mergeCells><mergeCell ref="A1:B1"/><mergeCell ref="C1:D1"/></mergeCells>',
    });

    const row = view.rowAt(1);
    expect(
      [1, 2, 3, 4].map((column) => {
        const cell = row?.cellAt(column);
        return [cell?.value.value, cell?.merged];
      }),
    ).toEqual([
      [1, false],
      [1, true],
      [2, false],
      [2, true],
    ]);
  });
});
