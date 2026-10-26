import { PreservedWorkbook } from "./preserved-workbook.js";
import {
  scanXml,
  attribute,
  applyXmlPatches,
  type XmlPatch,
} from "./xml-edit.js";
import { namespaces } from "../metadata/spreadsheetml/xml.js";
import { parseCellRef, formatCellRef, maxRow } from "../grid/range.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { fold } from "@sezzlee/file-core";

export function resizeBulkTable(
  bytes: Buffer,
  sheetName: string,
  tableName: string,
  records: number,
): Buffer {
  const workbook = new PreservedWorkbook(bytes);
  const sheet = workbook.sheet(sheetName);
  let found = false;
  for (const relation of workbook.opc().relationshipsFor(sheet.part).values()) {
    if (
      relation.kind !== "internal" ||
      relation.type !== `${namespaces.officeRelationships}/table`
    )
      continue;
    const xml = workbook.xml(relation.target);
    let matches = false,
      reference = "",
      totals = 0;
    scanXml(xml, relation.target, (node) => {
      if (node.uri !== namespaces.spreadsheetml || node.local !== "table")
        return;
      matches =
        fold(node.attributes.get("name") ?? "") === fold(tableName) ||
        fold(node.attributes.get("displayName") ?? "") === fold(tableName);
      reference = node.attributes.get("ref") ?? "";
      totals = Number(node.attributes.get("totalsRowCount") ?? "0");
      if (matches && Number(node.attributes.get("headerRowCount") ?? "1") !== 1)
        throw new SezzleeExcelError(
          "invalid_argument",
          "Bulk replacement requires a table header row.",
        );
    });
    if (!matches) continue;
    if (found)
      throw new SezzleeExcelError(
        "ambiguous_table",
        "The table name is ambiguous.",
      );
    found = true;
    const [first, last] = reference.split(":");
    const start = parseCellRef(first ?? ""),
      end = parseCellRef(last ?? first ?? "");
    if (totals !== 0)
      throw new SezzleeExcelError(
        "invalid_argument",
        "Resizing a table with totals requires an explicit structural edit; no bulk output was published.",
      );
    if (start.row + records > maxRow)
      throw new SezzleeExcelError(
        "invalid_range",
        "The resized table exceeds worksheet bounds.",
      );
    const ref = `${formatCellRef(start.row, start.column)}:${formatCellRef(start.row + records, end.column)}`;
    const patches: XmlPatch[] = [];
    scanXml(xml, relation.target, (node) => {
      if (node.uri !== namespaces.spreadsheetml) return;
      if (node.local === "sortState")
        patches.push({ start: node.start, end: node.end, text: "" });
      else if (node.local === "table" || node.local === "autoFilter")
        patches.push({
          start: node.start,
          end: node.openEnd,
          text: attribute(xml.slice(node.start, node.openEnd), "ref", ref),
        });
    });
    workbook.put(relation.target, applyXmlPatches(xml, patches));
  }
  if (!found)
    throw new SezzleeExcelError(
      "unknown_table",
      "The selected table cannot be resized.",
    );
  return workbook.finish(1).bytes;
}
