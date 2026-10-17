import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createHandlers } from "../src/tools/handlers.js";
import {
  officeRelationships,
  rawChartSheetWorkbook,
  rawWorkbook,
} from "./fixtures/raw-workbook.js";

const relationshipsNs =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const declarations = [
  'xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  `xmlns:r="${officeRelationships}"`,
].join(" ");

const from = (column: number, row: number): string =>
  `<xdr:from><xdr:col>${column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`;
const to = (column: number, row: number): string =>
  `<xdr:to><xdr:col>${column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`;
const chartFrame = (name: string, id: string): string =>
  `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="${name}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${id}"/></a:graphicData></a:graphic></xdr:graphicFrame>`;
const absoluteChart = (name: string, id: string): string =>
  `<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="952500" cy="952500"/>${chartFrame(name, id)}<xdr:clientData/></xdr:absoluteAnchor>`;
const twoCellChart = (name: string, id: string): string =>
  `<xdr:twoCellAnchor>${from(1, 2)}${to(4, 9)}${chartFrame(name, id)}<xdr:clientData/></xdr:twoCellAnchor>`;
const chartRelationship = (id: string, target: string): string =>
  `<Relationship Id="${id}" Type="${officeRelationships}/chart" Target="${target}"/>`;

const barChartPart = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${officeRelationships}">
  <c:chart>
    <c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx></c:title>
    <c:plotArea>
      <c:barChart>
        <c:barDir val="col"/>
        <c:grouping val="clustered"/>
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Series 1</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:cat><c:numRef><c:f>Sheet1!$A$2:$A$3</c:f><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:cat>
          <c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:val>
        </c:ser>
        <c:axId val="1"/><c:axId val="2"/>
      </c:barChart>
      <c:catAx><c:axId val="1"/><c:axPos val="b"/><c:delete val="0"/></c:catAx>
      <c:valAx><c:axId val="2"/><c:axPos val="l"/><c:delete val="0"/></c:valAx>
    </c:plotArea>
    <c:legend><c:legendPos val="r"/></c:legend>
  </c:chart>
</c:chartSpace>`;

function payload(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  if (first === undefined || first.type !== "text") {
    throw new Error("expected a text payload");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function handlersFor(bytes: Uint8Array, name: string) {
  const root = await mkdtemp(join(tmpdir(), "excel-charts-"));
  await writeFile(join(root, name), bytes);
  return createHandlers(await createWorkbookRoot(root));
}

describe("chart sheets are reported as charts, not empty grids", () => {
  it("marks a chart sheet in describe_workbook and refuses read_sheet", async () => {
    const bytes = await rawChartSheetWorkbook({
      drawingXml: `<xdr:wsDr ${declarations}>${absoluteChart("Chart 1", "rId1")}</xdr:wsDr>`,
      drawingRelationships: chartRelationship("rId1", "../charts/chart1.xml"),
      parts: { "xl/charts/chart1.xml": barChartPart },
    });
    const handlers = await handlersFor(bytes, "charts.xlsx");
    const described = payload(
      await handlers.describe_workbook({ filePath: "charts.xlsx" }),
    );
    const sheets = described["sheets"] as Record<string, unknown>[];
    expect(sheets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Data",
          kind: "worksheet",
          chartCount: 0,
        }),
        expect.objectContaining({
          name: "Chart",
          kind: "chartsheet",
          chartCount: 1,
          usedRange: null,
          rowCount: 0,
        }),
      ]),
    );
    expect(described["capabilities"]).toMatchObject({ charts: true });

    const read = await handlers.read_sheet({
      filePath: "charts.xlsx",
      sheetName: "Chart",
    });
    expect(read.isError).toBe(true);
    const body = payload(read);
    expect(body["error"]).toBe("chart_sheet");
    expect(String(body["recovery"])).toContain("get_charts");
  });
});

describe("get_charts reads series from xl/charts", () => {
  it("returns type, title, series refs and cached points", async () => {
    const bytes = await rawWorkbook({
      sheetData: "",
      afterSheetData: '<drawing r:id="rId1"/>',
      sheetRelationships: `<Relationship Id="rId1" Type="${officeRelationships}/drawing" Target="../drawings/drawing1.xml"/>`,
      parts: {
        "xl/drawings/drawing1.xml": `<xdr:wsDr ${declarations}>${twoCellChart("Chart 1", "rId1")}</xdr:wsDr>`,
        "xl/drawings/_rels/drawing1.xml.rels": `<Relationships xmlns="${relationshipsNs}">${chartRelationship("rId1", "../charts/chart1.xml")}</Relationships>`,
        "xl/charts/chart1.xml": barChartPart,
      },
    });
    const handlers = await handlersFor(bytes, "embedded.xlsx");
    const result = await handlers.get_charts({ filePath: "embedded.xlsx" });
    expect(result.isError).not.toBe(true);
    const body = payload(result);
    expect(body).toMatchObject({
      sheet: "S",
      count: 1,
      charts: [
        {
          chartId: 1,
          name: "Chart 1",
          range: "B3:D9",
          title: { text: "Sales" },
          legend: { position: "r" },
          plots: [
            {
              type: "bar",
              direction: "col",
              grouping: "clustered",
              series: [
                {
                  name: { text: "Series 1", ref: "Sheet1!$B$1" },
                  categories: {
                    kind: "reference",
                    ref: "Sheet1!$A$2:$A$3",
                    count: 2,
                    points: [1, 2],
                    truncated: false,
                  },
                  values: {
                    kind: "reference",
                    ref: "Sheet1!$B$2:$B$3",
                    count: 2,
                    points: [10, 20],
                    truncated: false,
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("reads a chart sheet through get_charts", async () => {
    const bytes = await rawChartSheetWorkbook({
      drawingXml: `<xdr:wsDr ${declarations}>${absoluteChart("Sheet Chart", "rId1")}</xdr:wsDr>`,
      drawingRelationships: chartRelationship("rId1", "../charts/chart1.xml"),
      parts: { "xl/charts/chart1.xml": barChartPart },
    });
    const handlers = await handlersFor(bytes, "chartsheet.xlsx");
    const result = await handlers.get_charts({
      filePath: "chartsheet.xlsx",
      sheetName: "Chart",
    });
    expect(result.isError).not.toBe(true);
    expect(payload(result)).toMatchObject({
      sheet: "Chart",
      count: 1,
      charts: [
        {
          chartId: 1,
          name: "Sheet Chart",
          plots: [{ type: "bar" }],
        },
      ],
    });
  });

  it("marks only bracketed workbook refs as external", async () => {
    const externalPart = barChartPart.replaceAll(
      "Sheet1!$B$2:$B$3",
      "[1]Sheet1!$B$2:$B$3",
    );
    const bytes = await rawWorkbook({
      sheetData: "",
      afterSheetData: '<drawing r:id="rId1"/>',
      sheetRelationships: `<Relationship Id="rId1" Type="${officeRelationships}/drawing" Target="../drawings/drawing1.xml"/>`,
      parts: {
        "xl/drawings/drawing1.xml": `<xdr:wsDr ${declarations}>${twoCellChart("Chart 1", "rId1")}</xdr:wsDr>`,
        "xl/drawings/_rels/drawing1.xml.rels": `<Relationships xmlns="${relationshipsNs}">${chartRelationship("rId1", "../charts/chart1.xml")}</Relationships>`,
        "xl/charts/chart1.xml": externalPart,
      },
    });
    const handlers = await handlersFor(bytes, "external.xlsx");
    const charts = (
      payload(await handlers.get_charts({ filePath: "external.xlsx" }))[
        "charts"
      ] as Record<string, unknown>[]
    )[0] as {
      plots: {
        series: {
          categories: { external?: true };
          values: { external?: true };
        }[];
      }[];
    };
    const series = charts.plots[0]!.series[0]!;
    expect(series.categories.external).toBeUndefined();
    expect(series.values.external).toBe(true);
  });

  it("marks chartEx and missing relationships without inventing plots", async () => {
    const chartEx =
      '<cx:chart xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" r:id="rId1"/>';
    const bytes = await rawWorkbook({
      sheetData: "",
      afterSheetData: '<drawing r:id="rId1"/>',
      sheetRelationships: `<Relationship Id="rId1" Type="${officeRelationships}/drawing" Target="../drawings/drawing1.xml"/>`,
      parts: {
        "xl/drawings/drawing1.xml": `<xdr:wsDr ${declarations} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:cx1="http://schemas.microsoft.com/office/drawing/2015/9/8/chartex"><mc:AlternateContent><mc:Choice Requires="cx1"><xdr:twoCellAnchor>${from(0, 0)}${to(1, 1)}<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Waterfall"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2014/chartex">${chartEx}</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></mc:Choice><mc:Fallback/></mc:AlternateContent>${twoCellChart("Broken", "rId7")}</xdr:wsDr>`,
        "xl/drawings/_rels/drawing1.xml.rels": `<Relationships xmlns="${relationshipsNs}"><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2014/relationships/chartEx" Target="../charts/chartEx1.xml"/></Relationships>`,
      },
    });
    const handlers = await handlersFor(bytes, "mixed.xlsx");
    const result = await handlers.get_charts({ filePath: "mixed.xlsx" });
    expect(payload(result)["charts"]).toEqual([
      expect.objectContaining({
        name: "Waterfall",
        unsupported: "chartEx",
        plots: [],
      }),
      expect.objectContaining({
        name: "Broken",
        unsupported: "missing",
        plots: [],
      }),
    ]);
  });
});

describe("get_charts layer 2: axes, trendlines, hidden series, pivot", () => {
  const layer2Part = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:c15="http://schemas.microsoft.com/office/drawing/2012/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${officeRelationships}">
  <c:pivotSource><c:name>[Book.xlsx]Sheet1!PivotTable1</c:name><c:fmtId val="0"/></c:pivotSource>
  <c:chart>
    <c:plotArea>
      <c:barChart>
        <c:barDir val="col"/><c:grouping val="clustered"/>
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:tx><c:v>Visible</c:v></c:tx>
          <c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numLit></c:val>
          <c:trendline><c:trendlineType val="linear"/></c:trendline>
        </c:ser>
        <c:ser>
          <c:idx val="1"/><c:order val="1"/>
          <c:tx><c:v>Hidden</c:v></c:tx>
          <c:val><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>3</c:v></c:pt></c:numLit></c:val>
          <c:extLst><c:ext uri="{02D57815-91ED-43cb-92C2-25804820EDAC}"><c15:filteredSeriesTitle><c15:tx><c:v>Hidden</c:v></c15:tx></c15:filteredSeriesTitle></c:ext></c:extLst>
        </c:ser>
        <c:axId val="1"/><c:axId val="2"/>
      </c:barChart>
      <c:lineChart>
        <c:grouping val="standard"/>
        <c:ser>
          <c:idx val="2"/><c:order val="2"/>
          <c:tx><c:v>Secondary</c:v></c:tx>
          <c:val><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>9</c:v></c:pt></c:numLit></c:val>
        </c:ser>
        <c:axId val="1"/><c:axId val="3"/>
      </c:lineChart>
      <c:catAx><c:axId val="1"/><c:axPos val="b"/><c:delete val="0"/></c:catAx>
      <c:valAx>
        <c:axId val="2"/>
        <c:scaling><c:logBase val="10"/><c:min val="1"/><c:max val="100"/></c:scaling>
        <c:axPos val="l"/><c:numFmt formatCode="0.00" sourceLinked="0"/><c:delete val="0"/>
      </c:valAx>
      <c:valAx>
        <c:axId val="3"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:axPos val="r"/><c:numFmt formatCode="General" sourceLinked="1"/><c:delete val="0"/>
      </c:valAx>
    </c:plotArea>
  </c:chart>
</c:chartSpace>`;

  it("reports secondary axes, scaling, number format, trendlines, hidden series and pivotSource", async () => {
    const bytes = await rawWorkbook({
      sheetData: "",
      afterSheetData: '<drawing r:id="rId1"/>',
      sheetRelationships: `<Relationship Id="rId1" Type="${officeRelationships}/drawing" Target="../drawings/drawing1.xml"/>`,
      parts: {
        "xl/drawings/drawing1.xml": `<xdr:wsDr ${declarations}>${twoCellChart("Combo", "rId1")}</xdr:wsDr>`,
        "xl/drawings/_rels/drawing1.xml.rels": `<Relationships xmlns="${relationshipsNs}">${chartRelationship("rId1", "../charts/chart1.xml")}</Relationships>`,
        "xl/charts/chart1.xml": layer2Part,
      },
    });
    const handlers = await handlersFor(bytes, "layer2.xlsx");
    const body = payload(
      await handlers.get_charts({ filePath: "layer2.xlsx" }),
    );
    expect(body).toMatchObject({
      charts: [
        {
          pivotSource: "[Book.xlsx]Sheet1!PivotTable1",
          plots: [
            {
              type: "bar",
              axes: [1, 2],
              series: [
                {
                  name: { text: "Visible" },
                  trendlines: [{ type: "linear" }],
                },
                {
                  name: { text: "Hidden" },
                  hidden: true,
                },
              ],
            },
            {
              type: "line",
              axes: [1, 3],
              series: [{ name: { text: "Secondary" } }],
            },
          ],
          axes: [
            { id: 1, kind: "category", position: "b" },
            {
              id: 2,
              kind: "value",
              position: "l",
              min: 1,
              max: 100,
              logBase: 10,
              numberFormat: "0.00",
            },
            {
              id: 3,
              kind: "value",
              position: "r",
              secondary: true,
              numberFormat: "General",
            },
          ],
        },
      ],
    });
    const primary = (
      body["charts"] as { axes: { id: number; secondary?: true }[] }[]
    )[0]!.axes.find((axis) => axis.id === 2);
    expect(primary?.secondary).toBeUndefined();
  });
});
