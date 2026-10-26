import { posix } from "node:path";
import { relationshipsPathFor } from "@sezzlee/ooxml-core";
import { namespaces } from "../metadata/spreadsheetml/xml.js";
import { SezzleeExcelError } from "../platform/errors.js";
import type { PreservedWorkbook } from "./preserved-workbook.js";
import {
  scanXml,
  applyXmlPatches,
  replaceElementBody,
  attribute,
  xmlEscape,
  type XmlSpan,
} from "./xml-edit.js";

export const spreadsheetNamespace = namespaces.spreadsheetml;
export function invalidPresentation(message: string): never {
  throw new SezzleeExcelError("invalid_argument", message);
}
export function presentationBudget(message: string): never {
  throw new SezzleeExcelError("resource_limit", message);
}
export function xmlNodes(
  xml: string,
  local: string,
  parent?: string,
): XmlSpan[] {
  const result: XmlSpan[] = [];
  scanXml(xml, local, (node) => {
    if (
      node.uri === spreadsheetNamespace &&
      node.local === local &&
      (parent === undefined || node.parent === parent)
    )
      result.push(node);
  });
  return result;
}
export function setXmlChild(
  xml: string,
  parent: string,
  local: string,
  replacement: string,
  order: readonly string[] = [],
): string {
  const owners = xmlNodes(xml, parent);
  const owner = owners[0];
  if (owners.length !== 1 || owner === undefined)
    invalidPresentation(`Expected one ${parent} container.`);
  const children = xmlNodes(xml, local, parent);
  if (children.length > 1)
    invalidPresentation(`Duplicate ${local} elements cannot be edited.`);
  const child = children[0];
  if (child !== undefined)
    return applyXmlPatches(xml, [
      { start: child.start, end: child.end, text: replacement },
    ]);
  if (replacement === "") return xml;
  const index = order.indexOf(local);
  let insertion = owner.closeStart;
  scanXml(xml, parent, (node) => {
    if (
      node.uri === spreadsheetNamespace &&
      node.parent === parent &&
      index >= 0 &&
      order.indexOf(node.local) > index
    )
      insertion = Math.min(insertion, node.start);
  });
  const body =
    xml.slice(owner.openEnd, insertion) +
    replacement +
    xml.slice(insertion, owner.closeStart);
  return applyXmlPatches(xml, [
    {
      start: owner.start,
      end: owner.end,
      text: replaceElementBody(xml, owner, body),
    },
  ]);
}
export const worksheetOrder = [
  "sheetPr",
  "dimension",
  "sheetViews",
  "sheetFormatPr",
  "cols",
  "sheetData",
  "sheetCalcPr",
  "sheetProtection",
  "protectedRanges",
  "scenarios",
  "autoFilter",
  "sortState",
  "dataConsolidate",
  "customSheetViews",
  "mergeCells",
  "phoneticPr",
  "conditionalFormatting",
  "dataValidations",
  "hyperlinks",
  "printOptions",
  "pageMargins",
  "pageSetup",
  "headerFooter",
  "rowBreaks",
  "colBreaks",
  "customProperties",
  "cellWatches",
  "ignoredErrors",
  "smartTags",
  "drawing",
  "legacyDrawing",
  "legacyDrawingHF",
  "picture",
  "oleObjects",
  "controls",
  "webPublishItems",
  "tableParts",
  "extLst",
];
export function setWorksheetChild(
  workbook: PreservedWorkbook,
  part: string,
  local: string,
  replacement: string,
): void {
  workbook.put(
    part,
    setXmlChild(
      workbook.xml(part),
      "worksheet",
      local,
      replacement,
      worksheetOrder,
    ),
  );
}
export function addRelatedPart(
  workbook: PreservedWorkbook,
  owner: string,
  target: string,
  type: string,
  contentType: string,
  xml: string,
): string {
  if (workbook.parts.has(target))
    invalidPresentation("A new package part collides with retained content.");
  const relPart = relationshipsPathFor(owner);
  let rels = workbook.parts.has(relPart)
    ? workbook.xml(relPart)
    : `<Relationships xmlns="${namespaces.packageRelationships}"/>`;
  const ids = new Set([...workbook.opc().relationshipsFor(owner).keys()]);
  let id = 1;
  while (ids.has(`rId${id}`)) id += 1;
  let root: XmlSpan | undefined;
  scanXml(rels, relPart, (node) => {
    if (node.depth === 0) root = node;
  });
  if (root === undefined) invalidPresentation("No relationship root exists.");
  const relationship = `<Relationship xmlns="${namespaces.packageRelationships}" Id="rId${id}" Type="${xmlEscape(type)}" Target="${xmlEscape(posix.relative(posix.dirname(owner), target))}"/>`;
  rels = replaceElementBody(
    rels,
    root,
    rels.slice(root.openEnd, root.closeStart) + relationship,
  );
  workbook.put(relPart, rels);
  const types = workbook.xml("[Content_Types].xml");
  let typesRoot: XmlSpan | undefined;
  scanXml(types, "content types", (node) => {
    if (node.depth === 0) typesRoot = node;
  });
  if (typesRoot === undefined)
    invalidPresentation("No content-type root exists.");
  workbook.put(
    "[Content_Types].xml",
    replaceElementBody(
      types,
      typesRoot,
      types.slice(typesRoot.openEnd, typesRoot.closeStart) +
        `<Override xmlns="${namespaces.contentTypes}" PartName="/${xmlEscape(target)}" ContentType="${xmlEscape(contentType)}"/>`,
    ),
  );
  workbook.put(target, xml);
  return `rId${id}`;
}
export function removeRelatedPart(
  workbook: PreservedWorkbook,
  owner: string,
  target: string,
): void {
  const ownedRelationships = relationshipsPathFor(target);
  if (workbook.opc().relationshipsFor(target).size > 0)
    invalidPresentation(
      "Removing a part with retained outgoing dependencies is unsupported.",
    );
  const relPart = relationshipsPathFor(owner);
  if (workbook.parts.has(relPart)) {
    const xml = workbook.xml(relPart),
      patches: { start: number; end: number; text: string }[] = [];
    const ids = new Set(
      [...workbook.opc().relationshipsFor(owner).values()]
        .filter((r) => r.kind === "internal" && r.target === target)
        .map((r) => r.id),
    );
    scanXml(xml, relPart, (node) => {
      if (
        node.local === "Relationship" &&
        ids.has(node.attributes.get("Id") ?? "")
      )
        patches.push({ start: node.start, end: node.end, text: "" });
    });
    workbook.put(relPart, applyXmlPatches(xml, patches));
  }
  const xml = workbook.xml("[Content_Types].xml"),
    patches: { start: number; end: number; text: string }[] = [];
  scanXml(xml, "content types", (node) => {
    if (
      node.local === "Override" &&
      (node.attributes.get("PartName") === "/" + target ||
        node.attributes.get("PartName") === "/" + ownedRelationships)
    )
      patches.push({ start: node.start, end: node.end, text: "" });
  });
  workbook.put("[Content_Types].xml", applyXmlPatches(xml, patches));
  workbook.parts.delete(target);
  workbook.parts.delete(ownedRelationships);
}
export function headerWith(
  xml: string,
  values: Readonly<Record<string, string | undefined>>,
): string {
  for (const [name, value] of Object.entries(values))
    xml = attribute(xml, name, value);
  return xml;
}
