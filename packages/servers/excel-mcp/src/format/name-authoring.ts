import { asciiUpper, canonical } from "@sezzlee/file-core";
import type { PresentationChange } from "../authoring/presentation.js";
import { columnToLetters } from "../grid/range.js";
import type { PreservedWorkbook } from "./preserved-workbook.js";
import { boundsOf } from "./preserved-workbook.js";
import {
  invalidPresentation,
  presentationBudget,
  setXmlChild,
  spreadsheetNamespace as main,
  xmlNodes,
} from "./presentation-xml.js";
import { scanXml, xmlEscape, xmlUnescape } from "./xml-edit.js";

type NameChange = Extract<
  PresentationChange,
  { kind: "define_name" | "delete_name" | "write_named_range" }
>;

export const sameDefinedName = (left: string, right: string): boolean =>
  new RegExp(
    `^${canonical(left).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    "iu",
  ).test(canonical(right));

function validateName(workbook: PreservedWorkbook, name: string): void {
  if (
    /^(?:[rc]|_xlnm\..*|_xlfn\..*|r[0-9]+c[0-9]+)$/i.test(name) ||
    /_x[0-9a-f]{4}_/i.test(name)
  )
    invalidPresentation("The defined name is reserved by Excel.");
  const cell = /^([A-Za-z]{1,3})([1-9][0-9]*)$/.exec(name);
  if (cell !== null) {
    let column = 0;
    for (const ch of asciiUpper(cell[1] ?? ""))
      column = column * 26 + ch.charCodeAt(0) - 64;
    if (column <= 16_384 && Number(cell[2]) <= 1_048_576)
      invalidPresentation("A defined name cannot be an Excel cell reference.");
  }
  for (const part of workbook.opc().parts) {
    if (
      !/\.table\+xml$/.test(
        workbook.opc().contentTypes.contentTypeOf(part.path) ?? "",
      )
    )
      continue;
    const table = xmlNodes(workbook.xml(part.path), "table")[0];
    if (sameDefinedName(table?.attributes.get("name") ?? "", name))
      invalidPresentation("A defined name cannot collide with a table name.");
  }
}

export function applyNameChange(
  workbook: PreservedWorkbook,
  change: NameChange,
): void {
  validateName(workbook, change.name);
  const sheet = workbook.sheet(change.sheetName);
  const sheetIndex = workbook
    .sheets()
    .findIndex((entry) => entry.part === sheet.part);
  const scope = change.scope === "sheet" ? String(sheetIndex) : undefined;
  const part = workbook.workbookPart();
  const xml = workbook.xml(part);
  const names = xmlNodes(xml, "definedName", "definedNames");
  const matches = names.filter(
    (node) =>
      sameDefinedName(node.attributes.get("name") ?? "", change.name) &&
      node.attributes.get("localSheetId") === scope,
  );
  if (matches.length > 1)
    invalidPresentation("The defined name is ambiguous in its scope.");
  const existing = matches[0];
  if (change.kind === "write_named_range") {
    if (existing === undefined)
      invalidPresentation(
        "The defined name does not exist in the selected scope.",
      );
    const formula = xmlUnescape(
      xml.slice(existing.openEnd, existing.closeStart),
    );
    const target =
      /^(?:'((?:[^']|'')+)'|([^'![\]]+))!\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)(?::\$?([A-Za-z]{1,3})\$?([1-9][0-9]*))?$/.exec(
        formula,
      );
    if (target === null)
      invalidPresentation(
        "Named filling requires a single static internal A1 rectangle.",
      );
    const targetName = target[1]?.replace(/''/g, "'") ?? target[2];
    if (targetName === undefined)
      invalidPresentation("The named target has no worksheet.");
    const range = `${target[3]}${target[4]}:${target[5] ?? target[3]}${target[6] ?? target[4]}`;
    const bounds = boundsOf(range);
    const height = bounds.bottom - bounds.top + 1;
    const width = bounds.right - bounds.left + 1;
    if (
      change.values.length !== height ||
      change.values.some((row) => row.length !== width)
    )
      invalidPresentation(
        "Named filling requires exactly the target rectangle's rows and columns.",
      );
    workbook.apply([
      {
        kind: "write_cells",
        sheetName: workbook.sheet(targetName).name,
        startCell: `${columnToLetters(bounds.left)}${bounds.top}`,
        values: change.values,
        overwrite: change.overwrite,
      },
    ]);
    return;
  }
  if (
    change.kind === "define_name" &&
    existing !== undefined &&
    !change.overwrite
  )
    invalidPresentation(
      "The defined name already exists; choose overwrite explicitly.",
    );
  if (change.kind === "delete_name" && existing === undefined)
    invalidPresentation(
      "The defined name does not exist in the selected scope.",
    );
  if (change.kind === "delete_name") {
    const token = new RegExp(
      `(^|[^\\p{L}\\p{N}_.\\\\])${change.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}_.\\\\])`,
      "iu",
    );
    for (const entry of workbook.opc().parts) {
      if (
        !(workbook.opc().contentTypes.contentTypeOf(entry.path) ?? "").endsWith(
          "xml",
        )
      )
        continue;
      const content = workbook.xml(entry.path);
      scanXml(content, entry.path, (node) => {
        if (
          ![
            "f",
            "formula",
            "formula1",
            "formula2",
            "definedName",
            "calculatedColumnFormula",
            "totalsRowFormula",
          ].includes(node.local)
        )
          return;
        if (entry.path === part && node.start === existing?.start) return;
        if (
          token.test(xmlUnescape(content.slice(node.openEnd, node.closeStart)))
        )
          invalidPresentation(
            "The defined name is still referenced; replace its dependent formulas before deletion.",
          );
      });
    }
  }
  const entries = names
    .filter((node) => node !== existing)
    .map((node) => xml.slice(node.start, node.end));
  if (change.kind === "define_name") {
    if (entries.length >= 4096)
      presentationBudget("The workbook exceeds 4,096 defined names.");
    const b = boundsOf(change.range);
    const ref = `'${sheet.name.replace(/'/g, "''")}'!$${columnToLetters(b.left)}$${b.top}:$${columnToLetters(b.right)}$${b.bottom}`;
    entries.push(
      `<definedName xmlns="${main}" name="${xmlEscape(change.name)}"${scope === undefined ? "" : ` localSheetId="${scope}"`}>${xmlEscape(ref)}</definedName>`,
    );
  }
  workbook.put(
    part,
    setXmlChild(
      xml,
      "workbook",
      "definedNames",
      entries.length
        ? `<definedNames xmlns="${main}">${entries.join("")}</definedNames>`
        : "",
      [
        "fileVersion",
        "fileSharing",
        "workbookPr",
        "workbookProtection",
        "bookViews",
        "sheets",
        "functionGroups",
        "externalReferences",
        "definedNames",
        "calcPr",
        "oleSize",
        "customWorkbookViews",
        "pivotCaches",
        "smartTagPr",
        "smartTagTypes",
        "webPublishing",
        "fileRecoveryPr",
        "webPublishObjects",
        "extLst",
      ],
    ),
  );
  workbook.presentationEffect("name", 0);
}
