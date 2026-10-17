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
          <c:tx><c:v>Titled</c:v></c:tx>
          <c:val><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>3</c:v></c:pt></c:numLit></c:val>
          <c:extLst><c:ext uri="{02D57815-91ED-43cb-92C2-25804820EDAC}"><c15:filteredSeriesTitle><c15:tx><c:v>Titled</c:v></c15:tx></c15:filteredSeriesTitle></c:ext></c:extLst>
        </c:ser>
        <c:axId val="1"/><c:axId val="2"/>
        <c:extLst><c:ext uri="{02D57815-91ED-43cb-92C2-25804820EDAC}"><c15:filteredBarSeries><c15:ser>
          <c:idx val="3"/><c:order val="3"/>
          <c:tx><c:strRef><c:f>Sheet1!$D$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Hidden</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:val><c:numRef><c:f>Sheet1!$D$2:$D$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>4</c:v></c:pt><c:pt idx="1"><c:v>5</c:v></c:pt></c:numCache></c:numRef></c:val>
        </c15:ser></c15:filteredBarSeries></c:ext></c:extLst>
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
                { name: { text: "Titled" } },
                {
                  name: { text: "Hidden", ref: "Sheet1!$D$1" },
                  hidden: true,
                  values: { ref: "Sheet1!$D$2:$D$3", points: [4, 5] },
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
    const chart = (
      body["charts"] as {
        axes: { id: number; secondary?: true }[];
        plots: { series: { hidden?: true }[] }[];
      }[]
    )[0]!;
    expect(chart.axes.find((axis) => axis.id === 2)?.secondary).toBeUndefined();
    expect(chart.plots[0]!.series[1]!.hidden).toBeUndefined();
  });
});

const chartSpace = (plotArea: string, chart = ""): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${officeRelationships}"><c:chart>${chart}<c:plotArea>${plotArea}</c:plotArea></c:chart></c:chartSpace>`;

async function chartsOf(
  part: string | undefined,
  args: { readonly chartId?: number } = {},
  anchor = twoCellChart("Chart 1", "rId1"),
): Promise<CallToolResult> {
  const bytes = await rawWorkbook({
    sheetData: "",
    afterSheetData: '<drawing r:id="rId1"/>',
    sheetRelationships: `<Relationship Id="rId1" Type="${officeRelationships}/drawing" Target="../drawings/drawing1.xml"/>`,
    parts: {
      "xl/drawings/drawing1.xml": `<xdr:wsDr ${declarations}>${anchor}</xdr:wsDr>`,
      "xl/drawings/_rels/drawing1.xml.rels": `<Relationships xmlns="${relationshipsNs}">${chartRelationship("rId1", "../charts/chart1.xml")}</Relationships>`,
      ...(part === undefined ? {} : { "xl/charts/chart1.xml": part }),
    },
  });
  const handlers = await handlersFor(bytes, "c.xlsx");
  return handlers.get_charts({ filePath: "c.xlsx", ...args });
}

interface ReadChart {
  readonly title?: unknown;
  readonly plots: readonly {
    readonly series: readonly Record<string, unknown>[];
    readonly omittedSeries?: number;
  }[];
  readonly axes: readonly {
    readonly id: number;
    readonly secondary?: true;
    readonly title?: unknown;
  }[];
}

async function onlyChart(part: string): Promise<ReadChart> {
  const body = payload(await chartsOf(part));
  return (body["charts"] as ReadChart[])[0]!;
}

const numCache = (values: readonly string[], format = "General"): string =>
  `<c:numCache><c:formatCode>${format}</c:formatCode><c:ptCount val="${values.length}"/>${values
    .map((value, index) => `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`)
    .join("")}</c:numCache>`;

describe("get_charts reads cached values and names as Excel writes them", () => {
  it("returns a number cache as numbers, however many digits Excel wrote, and a text cache as text", async () => {
    const chart = await onlyChart(
      chartSpace(
        `<c:lineChart><c:grouping val="standard"/><c:ser><c:idx val="0"/><c:order val="0"/><c:cat><c:strRef><c:f>S!$A$2:$A$4</c:f><c:strCache><c:ptCount val="3"/><c:pt idx="0"><c:v>2019</c:v></c:pt><c:pt idx="1"><c:v>2020</c:v></c:pt><c:pt idx="2"><c:v>2021</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>S!$B$2:$B$4</c:f>${numCache(["68.599999999999994", "0.10000000000000001", "1.5E-3"])}</c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:lineChart>` +
          `<c:dateAx><c:axId val="1"/><c:axPos val="b"/></c:dateAx><c:valAx><c:axId val="2"/><c:axPos val="l"/></c:valAx>`,
      ),
    );
    expect(chart.plots[0]!.series[0]).toMatchObject({
      categories: { points: ["2019", "2020", "2021"] },
      values: { points: [68.6, 0.1, 0.0015] },
    });
  });

  it("reports a cache's number format, so date serials are recognisable", async () => {
    const chart = await onlyChart(
      chartSpace(
        `<c:lineChart><c:ser><c:idx val="0"/><c:order val="0"/><c:cat><c:numRef><c:f>S!$A$2:$A$3</c:f>${numCache(["45292", "45323"], "m/d/yyyy")}</c:numRef></c:cat><c:val><c:numRef><c:f>S!$B$2:$B$3</c:f>${numCache(["1", "2"])}</c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:lineChart>`,
      ),
    );
    const series = chart.plots[0]!.series[0]!;
    expect(series["categories"]).toMatchObject({
      numberFormat: "m/d/yyyy",
      points: [45292, 45323],
    });
    expect(series["values"]).not.toHaveProperty("numberFormat");
  });

  it("reads a chart or axis title linked to a cell, and a rich title by paragraph", async () => {
    const chart = await onlyChart(
      chartSpace(
        `<c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numRef><c:f>S!$B$2</c:f>${numCache(["1"])}</c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>` +
          `<c:catAx><c:axId val="1"/><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Fiscal </a:t></a:r><a:r><a:t>year</a:t></a:r></a:p><a:p><a:r><a:t>2024</a:t></a:r></a:p></c:rich></c:tx><c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr></c:title><c:axPos val="b"/></c:catAx>` +
          `<c:valAx><c:axId val="2"/><c:title><c:tx><c:strRef><c:f>S!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Units</c:v></c:pt></c:strCache></c:strRef></c:tx></c:title><c:axPos val="l"/></c:valAx>`,
        `<c:title><c:tx><c:strRef><c:f>S!$A$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache></c:strRef></c:tx><c:overlay val="0"/></c:title>`,
      ),
    );
    expect(chart.title).toEqual({ text: "Revenue", ref: "S!$A$1" });
    expect(chart.axes.map((axis) => axis.title)).toEqual([
      { text: "Fiscal year\n2024" },
      { text: "Units", ref: "S!$B$1" },
    ]);
    expect(chart.plots[0]!.series[0]!["values"]).toMatchObject({
      ref: "S!$B$2",
      points: [1],
    });
  });

  it("takes a series name only from the series' own tx, not from a label inside it", async () => {
    const chart = await onlyChart(
      chartSpace(
        `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:ser><c:idx val="0"/><c:order val="0"/>` +
          `<c:dLbls><c:dLbl><c:idx val="0"/><c:tx><c:strRef><c:f>S!$C$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Peak</c:v></c:pt></c:strCache></c:strRef></c:tx></c:dLbl><c:dLbl><c:idx val="1"/><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Label</a:t></a:r></a:p></c:rich></c:tx></c:dLbl></c:dLbls>` +
          `<c:trendline><c:trendlineType val="linear"/><c:trendlineLbl><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Fit</a:t></a:r></a:p></c:rich></c:tx></c:trendlineLbl></c:trendline>` +
          `<c:xVal><c:numRef><c:f>S!$A$2:$A$3</c:f>${numCache(["1", "2"])}</c:numRef></c:xVal><c:yVal><c:numRef><c:f>S!$B$2:$B$3</c:f>${numCache(["3", "4"])}</c:numRef></c:yVal></c:ser><c:axId val="1"/><c:axId val="2"/></c:scatterChart>`,
      ),
    );
    const series = chart.plots[0]!.series[0]!;
    expect(series).not.toHaveProperty("name");
    expect(series).toMatchObject({
      trendlines: [{ type: "linear" }],
      x: { ref: "S!$A$2:$A$3", points: [1, 2] },
      y: { ref: "S!$B$2:$B$3", points: [3, 4] },
    });
  });

  it("keeps every level of a multi-level category", async () => {
    const chart = await onlyChart(
      chartSpace(
        `<c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:cat><c:multiLvlStrRef><c:f>S!$A$2:$B$5</c:f><c:multiLvlStrCache><c:ptCount val="4"/><c:lvl><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt><c:pt idx="2"><c:v>Q1</c:v></c:pt><c:pt idx="3"><c:v>Q2</c:v></c:pt></c:lvl><c:lvl><c:pt idx="0"><c:v>2023</c:v></c:pt><c:pt idx="2"><c:v>2024</c:v></c:pt></c:lvl></c:multiLvlStrCache></c:multiLvlStrRef></c:cat><c:val><c:numRef><c:f>S!$C$2:$C$5</c:f>${numCache(["1", "2", "3", "4"])}</c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>`,
      ),
    );
    expect(chart.plots[0]!.series[0]!["categories"]).toEqual({
      kind: "reference",
      ref: "S!$A$2:$B$5",
      count: 4,
      points: ["Q1", "Q2", "Q1", "Q2"],
      levels: [["2023", null, "2024", null]],
      truncated: false,
    });
  });

  it("counts the series past the per-chart cap and marks the answer truncated", async () => {
    const series = Array.from(
      { length: 300 },
      (_, index) =>
        `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:val><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>${index}</c:v></c:pt></c:numLit></c:val></c:ser>`,
    ).join("");
    const body = payload(
      await chartsOf(
        chartSpace(
          `<c:lineChart>${series}<c:axId val="1"/><c:axId val="2"/></c:lineChart>`,
        ),
      ),
    );
    const plot = (body["charts"] as ReadChart[])[0]!.plots[0]!;
    expect(plot.series).toHaveLength(255);
    expect(plot.omittedSeries).toBe(45);
    expect(body).toMatchObject({
      truncated: true,
      truncationReason: "maxSeriesPerChart",
    });
  });
});

describe("get_charts places and selects charts honestly", () => {
  it("marks only the axes the first plot does not use as secondary", async () => {
    const chart = await onlyChart(
      chartSpace(
        `<c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:numLit></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>` +
          `<c:lineChart><c:ser><c:idx val="1"/><c:order val="1"/><c:val><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>2</c:v></c:pt></c:numLit></c:val></c:ser><c:axId val="3"/><c:axId val="4"/></c:lineChart>` +
          `<c:catAx><c:axId val="1"/><c:axPos val="b"/></c:catAx><c:valAx><c:axId val="2"/><c:axPos val="r"/></c:valAx>` +
          `<c:catAx><c:axId val="3"/><c:delete val="1"/><c:axPos val="b"/></c:catAx><c:valAx><c:axId val="4"/><c:axPos val="l"/></c:valAx>`,
      ),
    );
    expect(
      chart.axes.map((axis) => [axis.id, axis.secondary ?? false]),
    ).toEqual([
      [1, false],
      [2, false],
      [3, true],
      [4, true],
    ]);
  });

  it("gives a one-cell anchor its top-left cell and size, not a one-cell range", async () => {
    const oneCell = `<xdr:oneCellAnchor>${from(2, 4)}<xdr:ext cx="4762500" cy="2857500"/>${chartFrame("Chart 1", "rId1")}<xdr:clientData/></xdr:oneCellAnchor>`;
    const body = payload(
      await chartsOf(
        chartSpace(`<c:pieChart><c:varyColors val="1"/></c:pieChart>`),
        {},
        oneCell,
      ),
    );
    const chart = (body["charts"] as Record<string, unknown>[])[0]!;
    expect(chart).toMatchObject({
      anchor: "oneCell",
      cell: "C5",
      widthPx: 500,
      heightPx: 300,
    });
    expect(chart).not.toHaveProperty("range");
  });

  it("refuses a chartId the sheet does not have", async () => {
    const result = await chartsOf(
      chartSpace(`<c:pieChart><c:varyColors val="1"/></c:pieChart>`),
      { chartId: 2 },
    );
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: "invalid_argument" });
    expect(String(payload(result)["message"])).toContain("has 1 chart");
  });

  it("reports a chart whose part is absent as missing", async () => {
    const body = payload(await chartsOf(undefined));
    expect(body["charts"]).toEqual([
      expect.objectContaining({ unsupported: "missing", plots: [] }),
    ]);
  });

  it("defaults a grid tool to the first worksheet when a chart sheet comes first", async () => {
    const bytes = await rawChartSheetWorkbook({
      chartSheetFirst: true,
      drawingXml: `<xdr:wsDr ${declarations}>${absoluteChart("Chart 1", "rId1")}</xdr:wsDr>`,
      drawingRelationships: chartRelationship("rId1", "../charts/chart1.xml"),
      parts: { "xl/charts/chart1.xml": barChartPart },
    });
    const handlers = await handlersFor(bytes, "first.xlsx");
    const read = await handlers.read_sheet({ filePath: "first.xlsx" });
    expect(read.isError).not.toBe(true);
    expect(payload(read)).toMatchObject({ sheet: "Data" });
    const charts = await handlers.get_charts({ filePath: "first.xlsx" });
    expect(payload(charts)).toMatchObject({ sheet: "Chart", count: 1 });
  });
});
