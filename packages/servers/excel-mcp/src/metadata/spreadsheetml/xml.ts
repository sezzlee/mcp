import { ooxmlNamespaces } from "@sezzlee/ooxml-core";

export const namespaces = {
  ...ooxmlNamespaces,
  spreadsheetml: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  spreadsheetDrawing:
    "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
  drawing: "http://schemas.openxmlformats.org/drawingml/2006/main",
} as const;

export { fanOut, readXmlPart, scanPart, type PartScan } from "./reader.js";
export type { XmlNode, XmlVisitor } from "@sezzlee/ooxml-core";
