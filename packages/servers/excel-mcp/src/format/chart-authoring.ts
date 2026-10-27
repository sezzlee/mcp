import type { PresentationChange } from "../authoring/presentation.js";
import { parseCellRef } from "../grid/range.js";
import { namespaces } from "../metadata/spreadsheetml/xml.js";
import type { PreservedWorkbook } from "./preserved-workbook.js";
import { boundsOf } from "./preserved-workbook.js";
import { featureData, type FeatureCell } from "./feature-data.js";
import { addRelatedPart, invalidPresentation } from "./presentation-xml.js";
import { applyXmlPatches, attribute, xmlEscape } from "./xml-edit.js";
import {
  appendDrawing,
  artNamespace,
  drawingFor,
  drawingIdentity,
  drawingNamespace,
  drawingNodes,
  removeDrawingDependencies,
  uniquePart,
} from "./drawing-authoring.js";

type ChartChange = Extract<
  PresentationChange,
  { kind: "set_chart" | "remove_chart" }
>;
const chart = namespaces.chart;
const office = namespaces.officeRelationships;
const literal = (text: string): string =>
  xmlEscape(text.replace(/_x[0-9a-f]{4}_/gi, (s) => "_x005F_" + s.slice(1)));

function vector(
  workbook: PreservedWorkbook,
  sheetName: string,
  range: string,
): FeatureCell[] {
  const b = boundsOf(range);
  if (b.left !== b.right && b.top !== b.bottom)
    invalidPresentation("Chart series must use one row or one column.");
  const data = featureData(workbook, sheetName, range).flat();
  if (data.length > 10_000)
    invalidPresentation("A chart series exceeds 10,000 points.");
  return data;
}

function reference(sheet: string, range: string): string {
  return xmlEscape(
    `'${sheet.replace(/'/g, "''")}'!${range.replace(/([A-Za-z]+)([0-9]+)/g, "$$$1$$$2")}`,
  );
}

const seriesColors = [
  "4472C4",
  "ED7D31",
  "A5A5A5",
  "FFC000",
  "5B9BD5",
  "70AD47",
];
function seriesPaint(index: number, line = false): string {
  const color = seriesColors[index % seriesColors.length] ?? "4472C4";
  const fill = `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`;
  return `<c:spPr>${line ? "<a:noFill/>" : fill}<a:ln w="28575">${fill}</a:ln></c:spPr>`;
}

export function applyChartChange(
  workbook: PreservedWorkbook,
  change: ChartChange,
): void {
  const part = drawingFor(
    workbook,
    change.sheetName,
    change.kind === "set_chart",
  );
  let xml = workbook.xml(part);
  const properties = drawingNodes(xml, "cNvPr").filter(
    (node) => node.attributes.get("name") === change.name,
  );
  if (properties.length > 1)
    invalidPresentation("The drawing name is ambiguous.");
  const property = properties[0];
  const anchor =
    property === undefined
      ? undefined
      : ["oneCellAnchor", "twoCellAnchor", "absoluteAnchor"]
          .flatMap((local) => drawingNodes(xml, local))
          .find(
            (node) => node.start < property.start && node.end > property.end,
          );
  if (
    property !== undefined &&
    (anchor === undefined ||
      !drawingNodes(xml, "graphicFrame").some(
        (node) => node.start > anchor.start && node.end < anchor.end,
      ))
  )
    invalidPresentation("The drawing name belongs to an unsupported object.");
  if (change.kind === "remove_chart" && !anchor)
    invalidPresentation("The named chart does not exist.");
  if (change.kind === "set_chart" && anchor && !change.overwrite)
    invalidPresentation("The chart exists; choose overwrite explicitly.");
  const identity = drawingIdentity(xml);
  const removedAnchor =
    anchor === undefined
      ? undefined
      : [...anchor.namespaces].reduce(
          (raw, [prefix, uri]) =>
            attribute(raw, prefix ? `xmlns:${prefix}` : "xmlns", uri),
          xml.slice(anchor.start, anchor.end),
        );
  if (anchor)
    xml = applyXmlPatches(xml, [
      { start: anchor.start, end: anchor.end, text: "" },
    ]);
  workbook.put(part, xml);
  if (removedAnchor !== undefined)
    removeDrawingDependencies(workbook, part, removedAnchor);
  if (change.kind === "remove_chart") return;
  if (change.cell.includes(":"))
    invalidPresentation("Chart placement requires one cell.");
  const cell = parseCellRef(change.cell);
  if (change.chartType === "pie" && change.series.length !== 1)
    invalidPresentation("A pie chart requires exactly one series.");
  let hasFormula = false;
  const rendered = change.series
    .map((series, index) => {
      const categories = vector(workbook, series.sheetName, series.categories),
        values = vector(workbook, series.sheetName, series.values);
      if (categories.length !== values.length)
        invalidPresentation(
          "Chart category and value sources must have equal lengths.",
        );
      if (
        values.some(
          (cell) => cell.kind === "value" && typeof cell.value !== "number",
        )
      )
        invalidPresentation("Chart values must be numeric or blank.");
      const stale = [...categories, ...values].some(
        (cell) => cell.kind === "formula",
      );
      if (stale) {
        workbook.requireFeatureRefresh("charts");
        hasFormula = true;
      }
      const categoryCache = stale
        ? ""
        : `<c:strCache><c:ptCount val="${categories.length}"/>${categories.map((cell, i) => (cell.kind === "value" ? `<c:pt idx="${i}"><c:v>${literal(String(cell.value))}</c:v></c:pt>` : "")).join("")}</c:strCache>`;
      const valueCache = stale
        ? ""
        : `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values.map((cell, i) => (cell.kind === "value" ? `<c:pt idx="${i}"><c:v>${cell.value}</c:v></c:pt>` : "")).join("")}</c:numCache>`;
      const paint = seriesPaint(index, change.chartType === "line");
      const points =
        change.chartType === "pie"
          ? values
              .map(
                (_, i) => `<c:dPt><c:idx val="${i}"/>${seriesPaint(i)}</c:dPt>`,
              )
              .join("")
          : "";
      return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:v>${literal(series.name)}</c:v></c:tx>${paint}${points}${change.chartType === "line" ? '<c:marker><c:symbol val="none"/></c:marker>' : ""}<c:cat><c:strRef><c:f>${reference(workbook.sheet(series.sheetName).name, series.categories)}</c:f>${categoryCache}</c:strRef></c:cat><c:val><c:numRef><c:f>${reference(workbook.sheet(series.sheetName).name, series.values)}</c:f>${valueCache}</c:numRef></c:val>${change.chartType === "line" ? '<c:smooth val="0"/>' : ""}</c:ser>`;
    })
    .join("");
  const tag =
    change.chartType === "column" || change.chartType === "bar"
      ? "barChart"
      : change.chartType + "Chart";
  const axes =
    change.chartType === "pie"
      ? ""
      : `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${change.chartType === "bar" ? "l" : "b"}"/><c:crossAx val="2"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${change.chartType === "bar" ? "b" : "l"}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="1"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
  const title = change.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${literal(change.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`
    : "";
  const chartXml = `<c:chartSpace xmlns:c="${chart}" xmlns:a="${artNamespace}" xmlns:r="${office}"><c:lang val="en-US"/><c:chart>${title}<c:autoTitleDeleted val="${change.title ? 0 : 1}"/><c:plotArea><c:layout/><c:${tag}>${tag === "barChart" ? `<c:barDir val="${change.chartType === "bar" ? "bar" : "col"}"/><c:grouping val="clustered"/>` : tag === "lineChart" ? '<c:grouping val="standard"/>' : ""}<c:varyColors val="${change.chartType === "pie" ? 1 : 0}"/>${rendered}${change.chartType === "pie" ? "" : '<c:axId val="1"/><c:axId val="2"/>'}</c:${tag}>${axes}</c:plotArea><c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/></c:chart></c:chartSpace>`;
  const target = uniquePart(workbook, "xl/charts/chart", "xml");
  const id = addRelatedPart(
    workbook,
    part,
    target,
    `${office}/chart`,
    "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
    chartXml,
  );
  if (!hasFormula) workbook.markFeatureCurrent(target);
  appendDrawing(
    workbook,
    part,
    `<xdr:oneCellAnchor xmlns:xdr="${drawingNamespace}" xmlns:a="${artNamespace}" xmlns:r="${office}"><xdr:from><xdr:col>${cell.column - 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${cell.row - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${change.width * 9525}" cy="${change.height * 9525}"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${identity}" name="${literal(change.name)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${chart}"><c:chart xmlns:c="${chart}" r:id="${id}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`,
  );
  workbook.presentationEffect("layout", 0);
}
