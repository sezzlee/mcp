import { fold } from "@sezzlee/file-core";
import { presentationLimits } from "../authoring/presentation.js";
import { namespaces } from "../metadata/spreadsheetml/xml.js";
import { unescapeXstring } from "../metadata/spreadsheetml/shared-strings.js";
import {
  boundsOf,
  gridOf,
  type PreservedWorkbook,
} from "./preserved-workbook.js";
import {
  xmlNodes,
  invalidPresentation,
  presentationBudget,
} from "./presentation-xml.js";
import { attribute, xmlUnescape } from "./xml-edit.js";

export function workbookTables(workbook: PreservedWorkbook) {
  const tables = [];
  for (const sheet of workbook.sheets())
    for (const relation of workbook
      .opc()
      .relationshipsFor(sheet.part)
      .values()) {
      if (relation.type !== `${namespaces.officeRelationships}/table`) continue;
      if (relation.kind !== "internal")
        invalidPresentation("A table relationship must be internal.");
      const xml = workbook.xml(relation.target),
        root = xmlNodes(xml, "table")[0];
      if (root === undefined)
        invalidPresentation("A retained table has no root.");
      const name = root.attributes.get("name"),
        displayName = root.attributes.get("displayName"),
        ref = root.attributes.get("ref");
      if (!name || !displayName || !ref)
        invalidPresentation("A retained table has an incomplete identity.");
      const bounds = boundsOf(ref),
        columns = xmlNodes(xml, "tableColumn", "tableColumns").map((node) => ({
          id: node.attributes.get("id") ?? "",
          name: node.attributes.get("name") ?? "",
          node,
        }));
      if (
        columns.length !== bounds.right - bounds.left + 1 ||
        columns.some((c) => !c.name) ||
        new Set(columns.map((c) => fold(c.name))).size !== columns.length
      )
        invalidPresentation(
          "Table columns must have unique nonempty names and match its extent.",
        );
      const headerRows = Number(root.attributes.get("headerRowCount") ?? 1),
        totalsRows = Number(root.attributes.get("totalsRowCount") ?? 0);
      if (
        headerRows !== 1 ||
        ![0, 1].includes(totalsRows) ||
        bounds.bottom < bounds.top + totalsRows
      )
        invalidPresentation(
          "The table layout is outside the supported one-header, optional-total profile.",
        );
      tables.push({
        sheet,
        part: relation.target,
        relationship: relation.id,
        xml,
        root,
        name,
        displayName,
        ref,
        bounds,
        columns,
        headerRows,
        totalsRows,
      });
      if (tables.length > presentationLimits.maxTables)
        presentationBudget("The workbook exceeds the table authoring budget.");
    }
  if (new Set(tables.map((t) => fold(t.name))).size !== tables.length)
    invalidPresentation("Table names are ambiguous.");
  return tables;
}
export type WorkbookTable = ReturnType<typeof workbookTables>[number];
export function selectedTable(
  workbook: PreservedWorkbook,
  sheetName: string,
  name: string,
): WorkbookTable {
  const sheet = workbook.sheet(sheetName),
    matches = workbookTables(workbook).filter(
      (t) =>
        t.sheet.part === sheet.part &&
        (fold(t.name) === fold(name) || fold(t.displayName) === fold(name)),
    );
  const table = matches[0];
  if (matches.length !== 1 || table === undefined)
    invalidPresentation("The selected table is missing or ambiguous.");
  return table;
}
export function cellText(
  workbook: PreservedWorkbook,
  cell: ReturnType<typeof gridOf>["cells"] extends Map<number, infer C>
    ? C | undefined
    : never,
): string {
  if (cell === undefined || cell.formula !== undefined)
    invalidPresentation("Table headers must be literal nonempty text.");
  let text = "";
  if (cell.type === "s") {
    const rel = [
      ...workbook.opc().relationshipsFor(workbook.workbookPart()).values(),
    ].find((r) => r.type === `${namespaces.officeRelationships}/sharedStrings`);
    if (rel?.kind !== "internal")
      invalidPresentation("A shared-string header has no string part.");
    const xml = workbook.xml(rel.target),
      si = xmlNodes(xml, "si", "sst")[Number(cell.value)];
    if (si === undefined)
      invalidPresentation("A header has an invalid string index.");
    const raw = xml.slice(si.start, si.end);
    for (const node of xmlNodes(
      `<root xmlns="${namespaces.spreadsheetml}">${raw}</root>`,
      "t",
    ))
      text += xmlUnescape(
        `<root xmlns="${namespaces.spreadsheetml}">${raw}</root>`.slice(
          node.openEnd,
          node.closeStart,
        ),
      );
  } else if (cell.type === "inlineStr") {
    let raw = cell.raw;
    for (const [prefix, uri] of cell.bindings)
      raw = attribute(raw, prefix === "" ? "xmlns" : `xmlns:${prefix}`, uri);
    for (const node of xmlNodes(raw, "t"))
      text += xmlUnescape(raw.slice(node.openEnd, node.closeStart));
  } else invalidPresentation("Table headers must be literal nonempty text.");
  text = unescapeXstring(text);
  if (
    !text.trim() ||
    text.length > 255 ||
    [...text].some((ch) => (ch.codePointAt(0) ?? 0) < 32)
  )
    invalidPresentation(
      "Table headers need nonblank text of at most 255 characters without control characters.",
    );
  return text;
}
