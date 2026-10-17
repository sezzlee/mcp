import { ooxmlNamespaces } from "@sezzlee/ooxml-core";

export const namespaces = {
  ...ooxmlNamespaces,
  spreadsheetml: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  spreadsheetDrawing:
    "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
  drawing: "http://schemas.openxmlformats.org/drawingml/2006/main",
  chart: "http://schemas.openxmlformats.org/drawingml/2006/chart",
} as const;

/**
 * Guard: Office versions its chartEx vocabulary by date, one namespace per
 * revision (`2014/chartex`, `2015/9/8/chartex`, `2016/5/10/chartex`, …), and
 * a file declares several of them; a fixed list would miss the next revision.
 */
const chartExNamespace =
  /^http:\/\/schemas\.microsoft\.com\/office\/drawing\/\d{4}(?:\/\d{1,2}){0,2}\/chartex$/;

export function isChartExNamespace(uri: string): boolean {
  return chartExNamespace.test(uri);
}

export { fanOut, readXmlPart, scanPart, type PartScan } from "./reader.js";
export type { XmlNode, XmlVisitor } from "@sezzlee/ooxml-core";
