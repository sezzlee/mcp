import { describe, expect, it } from "vitest";
import { readCells } from "../src/metadata/spreadsheetml/cells.js";
import { openPackage } from "../src/metadata/spreadsheetml/package.js";
import { zipSource } from "../src/metadata/spreadsheetml/reader.js";
import { readHyperlinks } from "../src/metadata/spreadsheetml/hyperlinks.js";
import {
  declaredBounds,
  readSheetLayout,
} from "../src/metadata/spreadsheetml/sheet-layout.js";
import { readSharedStrings } from "../src/metadata/spreadsheetml/shared-strings.js";
import { readNumberFormats } from "../src/metadata/spreadsheetml/styles.js";
import {
  officeRelationships,
  rawWorkbook,
  type RawWorkbookOptions,
} from "./fixtures/raw-workbook.js";

async function workbook(options: RawWorkbookOptions) {
  const opc = openPackage(zipSource(await rawWorkbook(options)));
  const strings = readSharedStrings(opc);
  return {
    strings,
    formats: readNumberFormats(opc),
    links: () => readHyperlinks(opc, "xl/worksheets/sheet1.xml"),
    layout: () => readSheetLayout(opc, "xl/worksheets/sheet1.xml"),
    cells: () => readCells(opc, "xl/worksheets/sheet1.xml", strings),
  };
}

describe("readSharedStrings", () => {
  it("finds the table by relationship, joins rich runs, drops phonetic guides, decodes lower-case escapes and folds CRLF", async () => {
    const { strings } = await workbook({
      sheetData: "",
      sharedStrings:
        "<si><t>Ürün</t></si>" +
        '<si><r><t xml:space="preserve">Kırmızı </t></r><r><rPr><b/></rPr><t>kalem</t></r></si>' +
        '<si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si>' +
        "<si><t>a_x000D__x000A_b</t></si>" +
        "<si><t>c_X000D_</t></si>" +
        "<si><t>_x005F_x000D_</t></si>" +
        "<si><t/></si>",
    });

    expect(strings).toEqual([
      "Ürün",
      "Kırmızı kalem",
      "東京",
      "a\nb",
      "c_X000D_",
      "_x000D_",
      "",
    ]);
  });
});

describe("readCells", () => {
  it("reads every cell type ECMA-376 defines", async () => {
    const { cells } = await workbook({
      sharedStrings: "<si><t>Adet</t></si>",
      sheetData:
        '<row r="1">' +
        '<c r="A1" t="s"><v>0</v></c>' +
        '<c r="B1"><v>1.5E3</v></c>' +
        '<c r="C1" t="b"><v>1</v></c>' +
        '<c r="D1" t="b"><v>0</v></c>' +
        '<c r="E1" t="e"><v>#DIV/0!</v></c>' +
        '<c r="F1" t="str"><f>"a"&amp;"b"</f><v>ab</v></c>' +
        '<c r="G1" t="inlineStr"><is><t>satır içi</t></is></c>' +
        '<c r="H1" t="d"><v>2026-10-16T00:00:00</v></c>' +
        '<c r="I1" s="3"/>' +
        '<c r="J1"><v></v></c>' +
        "</row>",
    });

    expect(
      cells().map(({ column, value, style }) => [column, value, style]),
    ).toEqual([
      [1, { kind: "string", value: "Adet" }, 0],
      [2, { kind: "number", value: 1500 }, 0],
      [3, { kind: "boolean", value: true }, 0],
      [4, { kind: "boolean", value: false }, 0],
      [5, { kind: "error", value: "#DIV/0!" }, 0],
      [6, { kind: "string", value: "ab" }, 0],
      [7, { kind: "string", value: "satır içi" }, 0],
      [8, { kind: "date", value: "2026-10-16T00:00:00" }, 0],
      [9, { kind: "none" }, 3],
      [10, { kind: "none" }, 0],
    ]);
    expect(cells().at(5)?.formula).toEqual({ kind: "normal", text: '"a"&"b"' });
  });

  it("reads a Strict-conformant workbook as its Transitional twin", async () => {
    const { strings, cells } = await workbook({
      strict: true,
      sharedStrings: "<si><t>Katı</t></si>",
      sheetData:
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>7</v></c></row>',
    });

    expect(strings).toEqual(["Katı"]);
    expect(cells().map((cell) => cell.value)).toEqual([
      { kind: "string", value: "Katı" },
      { kind: "number", value: 7 },
    ]);
  });

  it("places rows and cells written without an r attribute after the previous one", async () => {
    const { cells } = await workbook({
      sheetData:
        '<row r="3"><c r="B3"><v>1</v></c><c><v>2</v></c></row>' +
        "<row><c><v>3</v></c><c><v>4</v></c></row>",
    });

    expect(cells().map(({ row, column }) => [row, column])).toEqual([
      [3, 2],
      [3, 3],
      [4, 1],
      [4, 2],
    ]);
  });

  it("matches a prefixed namespace the same as the default one", async () => {
    const { cells } = await workbook({
      prefix: "x",
      sharedStrings: "<x:si><x:t>Önekli</x:t></x:si>",
      sheetData: '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c></x:row>',
    });

    expect(cells().map((cell) => cell.value)).toEqual([
      { kind: "string", value: "Önekli" },
    ]);
  });

  it("keeps shared and array formulas as stored", async () => {
    const { cells } = await workbook({
      sheetData:
        '<row r="1">' +
        '<c r="A1"><f t="shared" ref="A1:A3" si="0">B1*2</f><v>2</v></c>' +
        "</row>" +
        '<row r="2"><c r="A2"><f t="shared" si="0"/><v>4</v></c></row>' +
        '<row r="4"><c r="A4"><f t="array" ref="A4:B4">B1:C1*2</f><v>2</v></c></row>',
    });

    expect(cells().map((cell) => cell.formula)).toEqual([
      { kind: "shared", group: 0, text: "B1*2", ref: "A1:A3" },
      { kind: "shared", group: 0, text: undefined, ref: undefined },
      { kind: "array", text: "B1:C1*2", ref: "A4:B4" },
    ]);
  });

  it.each([
    ["a negative index", "-1"],
    ["an index past the table", "5"],
    ["a fractional index", "0.5"],
  ])("reads a shared string cell with %s as empty", async (_name, index) => {
    const { cells } = await workbook({
      sharedStrings: "<si><t>x</t></si>",
      sheetData: `<row r="1"><c r="A1" t="s"><v>${index}</v></c></row>`,
    });

    expect(cells().map((cell) => cell.value)).toEqual([{ kind: "none" }]);
  });

  it.each([
    ["a malformed cell reference", '<row r="1"><c r="1A"><v>1</v></c></row>'],
    ["a column past XFD", '<row r="1"><c r="XFE1"><v>1</v></c></row>'],
    ["a row past 1048576", '<row r="1048577"><c><v>1</v></c></row>'],
    ["a row numbered 0", '<row r="0"><c><v>1</v></c></row>'],
  ])("refuses %s as a corrupt workbook", async (_name, sheetData) => {
    const { cells } = await workbook({ sheetData });

    expect(cells).toThrow(
      expect.objectContaining({ code: "corrupt_workbook" }),
    );
  });
});

describe("readNumberFormats", () => {
  it("maps each cell format to its code, reading custom codes from numFmts alone", async () => {
    const { formats } = await workbook({
      sheetData: "",
      styles:
        '<numFmts count="3">' +
        '<numFmt numFmtId="164" formatCode="0.0%"/>' +
        '<numFmt numFmtId="165" formatCode="d.m"/>' +
        '<numFmt numFmtId="0" formatCode="GENERAL"/>' +
        "</numFmts>" +
        '<cellStyleXfs count="1"><xf numFmtId="164"/></cellStyleXfs>' +
        '<cellXfs count="6">' +
        '<xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/>' +
        '<xf numFmtId="165"/><xf numFmtId="7"/><xf numFmtId="999"/>' +
        "</cellXfs>" +
        '<dxfs count="1"><dxf><numFmt numFmtId="14" formatCode="0.00%"/></dxf></dxfs>',
    });

    expect(
      [0, 1, 2, 3, 4, 5, 6].map((style) => formats.formatOf(style)),
    ).toEqual([
      "General",
      "m/d/yy",
      "0.0%",
      "d\\.m",
      '"$"#,##0.00_);\\("$"#,##0.00\\)',
      "General",
      "General",
    ]);
  });

  it("reads every cell as General when the workbook has no styles part", async () => {
    const { formats } = await workbook({ sheetData: "" });

    expect(formats.formatOf(3)).toBe("General");
  });
});

describe("readHyperlinks", () => {
  it("joins the relationship target and the location, and skips links that name neither", async () => {
    const { links } = await workbook({
      sheetData: "",
      afterSheetData:
        "<hyperlinks>" +
        '<hyperlink ref="A1" r:id="rIdWeb"/>' +
        '<hyperlink ref="A2:B3" r:id="rIdWeb" location="bolum-2"/>' +
        '<hyperlink ref="C1" location="\'Özet\'!A1"/>' +
        '<hyperlink r:id="rIdWeb"/>' +
        '<hyperlink ref="D1"/>' +
        '<hyperlink ref="not a cell" location="x"/>' +
        '<hyperlink ref="E1" r:id="rIdMissing" location="yedek"/>' +
        "</hyperlinks>",
      sheetRelationships: `<Relationship Id="rIdWeb" Type="${officeRelationships}/hyperlink" Target="https://ornek.test/rapor" TargetMode="External"/>`,
    });

    expect(links()).toEqual([
      {
        top: 1,
        left: 1,
        bottom: 1,
        right: 1,
        href: "https://ornek.test/rapor",
      },
      {
        top: 2,
        left: 1,
        bottom: 3,
        right: 2,
        href: "https://ornek.test/rapor#bolum-2",
      },
      { top: 1, left: 3, bottom: 1, right: 3, href: "#'Özet'!A1" },
      { top: 1, left: 5, bottom: 1, right: 5, href: "#yedek" },
    ]);
  });
});

describe("readSheetLayout", () => {
  it("reads the sheet's own merges, auto filter and declared dimension", async () => {
    const { layout } = await workbook({
      beforeSheetData: '<dimension ref="A1:D20"/>',
      sheetData: '<row r="1"><c r="A1"><v>1</v></c></row>',
      afterSheetData:
        '<autoFilter ref="A1:D20"/>' +
        '<mergeCells count="3"><mergeCell ref="A1:B2"/><mergeCell ref="C3"/><mergeCell ref="D9:C8"/></mergeCells>' +
        '<customSheetViews><customSheetView guid="{0}"><autoFilter ref="B1:B5"/></customSheetView></customSheetViews>',
    });

    expect(layout()).toMatchObject({
      dimension: { top: 1, left: 1, bottom: 20, right: 4 },
      autoFilter: "A1:D20",
      merges: [
        { top: 1, left: 1, bottom: 2, right: 2 },
        { top: 3, left: 3, bottom: 3, right: 3 },
      ],
    });
  });

  it("declares the written rows when the dimension names a single cell", async () => {
    const { layout, cells } = await workbook({
      beforeSheetData: '<dimension ref="A1"/>',
      sheetData:
        '<row r="2"><c r="B2"><v>1</v></c><c r="D2"><v>2</v></c></row>' +
        '<row r="40" ht="15.75" customHeight="1"/>',
    });

    expect(layout().dimension).toBeUndefined();
    expect(declaredBounds(layout(), cells())).toEqual({
      top: 2,
      left: 2,
      bottom: 40,
      right: 4,
    });
  });

  it("declares nothing for a sheet without stored cells", async () => {
    const { layout, cells } = await workbook({
      sheetData: '<row r="1000" ht="15.75" customHeight="1"/>',
    });

    expect(declaredBounds(layout(), cells())).toBeUndefined();
  });
});
