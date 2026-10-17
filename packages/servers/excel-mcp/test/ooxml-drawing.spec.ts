import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { parseOoxml } from "../src/format/ooxml-workbook.js";
import type { SheetFacts } from "../src/metadata/spreadsheetml/worksheet.js";
import { officeRelationships, rawWorkbook } from "./fixtures/raw-workbook.js";

const relationshipsNs =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const declarations = [
  'xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  `xmlns:r="${officeRelationships}"`,
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
].join(" ");

const from = (column: number, row: number): string =>
  `<xdr:from><xdr:col>${column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`;
const to = (column: number, row: number): string =>
  `<xdr:to><xdr:col>${column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`;
const twoCell = (content: string): string =>
  `<xdr:twoCellAnchor>${from(1, 2)}${to(4, 9)}${content}<xdr:clientData/></xdr:twoCellAnchor>`;

const chartFrame = (name: string, id: string, chart?: string): string =>
  `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="${name}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">${chart ?? `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${id}"/>`}</a:graphicData></a:graphic></xdr:graphicFrame>`;
const picture = (id: string): string =>
  `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Picture 1"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${id}"/></xdr:blipFill><xdr:spPr/></xdr:pic>`;
const shape =
  '<xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="4" name="Rectangle 1"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr/></xdr:sp>';

async function factsOf(
  anchors: string,
  relationships: string,
): Promise<SheetFacts> {
  const bytes = await rawWorkbook({
    sheetData: "",
    afterSheetData: '<drawing r:id="rId1"/>',
    sheetRelationships: `<Relationship Id="rId1" Type="${officeRelationships}/drawing" Target="../drawings/drawing1.xml"/>`,
    parts: {
      "xl/drawings/drawing1.xml": `<xdr:wsDr ${declarations}>${anchors}</xdr:wsDr>`,
      "xl/drawings/_rels/drawing1.xml.rels": `<Relationships xmlns="${relationshipsNs}">${relationships}</Relationships>`,
    },
  });
  return parseOoxml(Buffer.from(bytes), "drawing.xlsx").facts("S");
}

const chartRelationship = (id: string, target: string): string =>
  `<Relationship Id="${id}" Type="${officeRelationships}/chart" Target="${target}"/>`;
const imageRelationship = `<Relationship Id="rId9" Type="${officeRelationships}/image" Target="../media/image1.png"/>`;

describe("the drawing reader finds charts beside pictures", () => {
  it("reports a chart frame with its anchor, name and part, and a picture as before", async () => {
    const facts = await factsOf(
      twoCell(chartFrame("Chart 1", "rId1")) + twoCell(picture("rId9")),
      chartRelationship("rId1", "../charts/chart1.xml") + imageRelationship,
    );
    expect(facts.charts).toStrictEqual([
      {
        anchor: "twoCell",
        from: { column: 1, columnOffset: 0, row: 2, rowOffset: 0 },
        to: { column: 4, columnOffset: 0, row: 9, rowOffset: 0 },
        name: "Chart 1",
        target: { kind: "chart", part: "xl/charts/chart1.xml" },
      },
    ]);
    expect(facts.images.map((image) => image.mediaPart)).toStrictEqual([
      "xl/media/image1.png",
    ]);
  });

  it("reports each chart a group holds, at the group's anchor", async () => {
    const facts = await factsOf(
      twoCell(
        `<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="5" name="Group 1"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr><xdr:grpSpPr/>${shape}${chartFrame("Chart 1", "rId1")}${chartFrame("Chart 2", "rId2")}</xdr:grpSp>`,
      ),
      chartRelationship("rId1", "../charts/chart1.xml") +
        chartRelationship("rId2", "../charts/chart2.xml"),
    );
    expect(
      facts.charts.map((chart) => [chart.name, chart.target, chart.from?.row]),
    ).toStrictEqual([
      ["Chart 1", { kind: "chart", part: "xl/charts/chart1.xml" }, 2],
      ["Chart 2", { kind: "chart", part: "xl/charts/chart2.xml" }, 2],
    ]);
  });

  it("marks a frame whose relationship names no part as missing", async () => {
    const facts = await factsOf(twoCell(chartFrame("Chart 1", "rId7")), "");
    expect(facts.charts.map((chart) => chart.target)).toStrictEqual([
      { kind: "missing", format: "chart" },
    ]);
  });

  it("reads a chart frame written in the Strict namespaces", async () => {
    const strictChart =
      '<c:chart xmlns:c="http://purl.oclc.org/ooxml/drawingml/chart" r:id="rId1"/>';
    const facts = await factsOf(
      twoCell(chartFrame("Chart 1", "rId1", strictChart)),
      chartRelationship("rId1", "../charts/chart1.xml"),
    );
    expect(facts.charts.map((chart) => chart.target)).toStrictEqual([
      { kind: "chart", part: "xl/charts/chart1.xml" },
    ]);
  });
});

describe("the drawing reader applies Markup Compatibility", () => {
  it("reports a chartEx frame once, not its placeholder shape", async () => {
    const chartEx =
      '<cx:chart xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" r:id="rId1"/>';
    const facts = await factsOf(
      twoCell(
        `<mc:AlternateContent xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex"><mc:Choice Requires="cx1">${chartFrame("Chart 1", "rId1", chartEx)}</mc:Choice><mc:Fallback>${shape}</mc:Fallback></mc:AlternateContent>`,
      ),
      `<Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2014/relationships/chartEx" Target="../charts/chartEx1.xml"/>`,
    );
    expect(
      facts.charts.map((chart) => [chart.name, chart.target]),
    ).toStrictEqual([
      ["Chart 1", { kind: "chartEx", part: "xl/charts/chartEx1.xml" }],
    ]);
  });

  it("reports the picture an unread Choice falls back to", async () => {
    const facts = await factsOf(
      twoCell(
        `<mc:AlternateContent xmlns:xdr14="http://schemas.microsoft.com/office/excel/2010/spreadsheetDrawing" xmlns:aink="http://schemas.microsoft.com/office/drawing/2016/ink"><mc:Choice Requires="xdr14 aink"><xdr14:contentPart r:id="rId8"/></mc:Choice><mc:Fallback>${picture("rId9")}</mc:Fallback></mc:AlternateContent>`,
      ),
      imageRelationship,
    );
    expect(facts.images).toHaveLength(1);
    expect(facts.charts).toStrictEqual([]);
  });

  it("counts an anchor written in two branches once", async () => {
    const facts = await factsOf(
      `<mc:AlternateContent xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><mc:Choice Requires="a14">${twoCell(picture("rId9") + chartFrame("Chart 1", "rId1"))}</mc:Choice><mc:Fallback>${twoCell(picture("rId9") + chartFrame("Chart 1", "rId1"))}</mc:Fallback></mc:AlternateContent>`,
      chartRelationship("rId1", "../charts/chart1.xml") + imageRelationship,
    );
    expect(facts.images).toHaveLength(1);
    expect(facts.charts).toHaveLength(1);
  });
});
