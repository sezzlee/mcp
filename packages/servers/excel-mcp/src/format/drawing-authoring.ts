import { namespaces } from "../metadata/spreadsheetml/xml.js";
import type { PreservedWorkbook } from "./preserved-workbook.js";
import {
  addRelatedPart,
  invalidPresentation,
  presentationBudget,
  removeRelatedPart,
  removeRelationship,
  setWorksheetChild,
} from "./presentation-xml.js";
import { replaceElementBody, scanXml, type XmlSpan } from "./xml-edit.js";

export const drawingNamespace =
  "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
export const artNamespace =
  "http://schemas.openxmlformats.org/drawingml/2006/main";

export function drawingNodes(xml: string, local: string): XmlSpan[] {
  const nodes: XmlSpan[] = [];
  scanXml(xml, "drawing", (node) => {
    if (node.uri === drawingNamespace && node.local === local) nodes.push(node);
  });
  return nodes;
}

export function uniquePart(
  workbook: PreservedWorkbook,
  stem: string,
  extension: string,
): string {
  for (let id = 1; id <= 4096; id++) {
    const path = `${stem}${id}.${extension}`;
    if (!workbook.parts.has(path)) return path;
  }
  return presentationBudget(
    "The package exceeds its authored-object part limit.",
  );
}

export function drawingFor(
  workbook: PreservedWorkbook,
  sheetName: string,
  create: boolean,
): string {
  const sheet = workbook.sheet(sheetName);
  const relations = [
    ...workbook.opc().relationshipsFor(sheet.part).values(),
  ].filter((r) => r.type === `${namespaces.officeRelationships}/drawing`);
  if (relations.length > 1)
    invalidPresentation("Multiple worksheet drawings cannot be authored.");
  const relation = relations[0];
  if (relation !== undefined) {
    if (relation.kind !== "internal")
      invalidPresentation("A worksheet drawing must be internal.");
    return relation.target;
  }
  if (!create) invalidPresentation("The worksheet has no drawing.");
  const part = uniquePart(workbook, "xl/drawings/sezzleeDrawing", "xml");
  const id = addRelatedPart(
    workbook,
    sheet.part,
    part,
    `${namespaces.officeRelationships}/drawing`,
    "application/vnd.openxmlformats-officedocument.drawing+xml",
    `<xdr:wsDr xmlns:xdr="${drawingNamespace}" xmlns:a="${artNamespace}" xmlns:r="${namespaces.officeRelationships}"/>`,
  );
  setWorksheetChild(
    workbook,
    sheet.part,
    "drawing",
    `<drawing xmlns="${namespaces.spreadsheetml}" xmlns:r="${namespaces.officeRelationships}" r:id="${id}"/>`,
  );
  return part;
}

export function appendDrawing(
  workbook: PreservedWorkbook,
  part: string,
  anchor: string,
): void {
  const xml = workbook.xml(part),
    root = drawingNodes(xml, "wsDr")[0];
  if (root === undefined)
    invalidPresentation("The drawing root is unsupported.");
  const count = ["oneCellAnchor", "twoCellAnchor", "absoluteAnchor"].reduce(
    (total, local) => total + drawingNodes(xml, local).length,
    0,
  );
  if (count >= 256)
    presentationBudget("A drawing exceeds 256 anchored objects.");
  workbook.put(
    part,
    replaceElementBody(
      xml,
      root,
      xml.slice(root.openEnd, root.closeStart) + anchor,
    ),
  );
}

export function drawingIdentity(xml: string): number {
  const ids = drawingNodes(xml, "cNvPr").map((node) =>
    Number(node.attributes.get("id")),
  );
  const next = Math.max(0, ...ids.filter(Number.isFinite)) + 1;
  if (!Number.isSafeInteger(next))
    invalidPresentation("The drawing object identity is invalid.");
  return next;
}

export function removeDrawingDependencies(
  workbook: PreservedWorkbook,
  part: string,
  removed: string,
): void {
  const ids = (xml: string): Set<string> => {
    const result = new Set<string>();
    scanXml(xml, part, (node) => {
      for (const [name, value] of node.attributes) {
        const prefix = name.includes(":")
          ? name.slice(0, name.indexOf(":"))
          : "";
        if (node.namespaces.get(prefix) === namespaces.officeRelationships)
          result.add(value);
      }
    });
    return result;
  };
  const used = ids(workbook.xml(part));
  const relations = workbook.opc().relationshipsFor(part);
  for (const id of ids(removed)) {
    if (used.has(id)) continue;
    const relation = relations.get(id);
    if (!relation) continue;
    if (
      relation.kind === "internal" &&
      workbook.opc().relationshipsFor(relation.target).size
    )
      invalidPresentation(
        "Removing an object with unsupported retained outgoing dependencies is unsupported.",
      );
    removeRelationship(workbook, part, id);
    if (relation.kind !== "internal") continue;
    const opc = workbook.opc();
    const referenced =
      [...opc.packageRelationships.values()].some(
        (r) => r.kind === "internal" && r.target === relation.target,
      ) ||
      opc.parts.some((p) =>
        [...opc.relationshipsFor(p.path).values()].some(
          (r) => r.kind === "internal" && r.target === relation.target,
        ),
      );
    if (!referenced) removeRelatedPart(workbook, part, relation.target);
  }
}
