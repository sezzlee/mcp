import {
  editFeaturesSchema,
  type EditBlocker,
  type EditChange,
  type EditFeatures,
} from "../authoring/edit.js";
import { authoringLimits } from "../authoring/workbook.js";
import { parseCellRef, maxColumn, maxRow } from "../grid/range.js";
import { SezzleeExcelError } from "../platform/errors.js";
import {
  openOpcPackage,
  zipSource,
  transitionalNamespace,
} from "../metadata/spreadsheetml/reader.js";
import { namespaces, type XmlNode } from "../metadata/spreadsheetml/xml.js";
import { unescapeXstring } from "../metadata/spreadsheetml/shared-strings.js";
import {
  unprotectionPrefix,
  verifyProtection,
} from "./protection-authoring.js";
import { xmlNodes } from "./presentation-xml.js";

const officeDocument = new Set([
  `${namespaces.officeRelationships}/officeDocument`,
  "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
]);
const mainType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const macroType = "application/vnd.ms-excel.sheet.macroEnabled.main+xml";
const strictOffice = "http://purl.oclc.org/ooxml/officeDocument/relationships";

function corrupt(message: string): never {
  throw new SezzleeExcelError("corrupt_workbook", message);
}

function flag(node: XmlNode, name: string): boolean {
  const value = node.attr(name)?.trim();
  if (value === undefined || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  return corrupt(
    "The workbook contains an invalid protection or date-system flag.",
  );
}

function requestedCells(changes: readonly EditChange[]): number {
  let total = 0;
  for (const change of changes) {
    switch (change.kind) {
      case "add_sheet":
        break;
      case "write_cells": {
        const start = parseCellRef(change.startCell);
        const width = change.values[0]?.length ?? 0;
        if (
          start.row + change.values.length - 1 > maxRow ||
          start.column + width - 1 > maxColumn
        )
          throw new SezzleeExcelError(
            "invalid_range",
            "The value block exceeds the worksheet bounds.",
          );
        total += change.values.length * width;
        break;
      }
      case "clear_contents": {
        const [first, last] = change.range.split(":");
        const start = parseCellRef(first ?? "");
        const end = last === undefined ? start : parseCellRef(last);
        if (end.row < start.row || end.column < start.column)
          throw new SezzleeExcelError(
            "invalid_range",
            "The clear range ends before it starts.",
          );
        total += (end.row - start.row + 1) * (end.column - start.column + 1);
        break;
      }
      case "format_cells":
      case "fill_formula":
      case "merge_cells":
      case "unmerge_cells":
      case "create_table": {
        const [first, last] = change.range.split(":");
        const start = parseCellRef(first ?? ""),
          end = parseCellRef(last ?? first ?? "");
        if (end.row < start.row || end.column < start.column)
          throw new SezzleeExcelError(
            "invalid_range",
            "The operation range ends before it starts.",
          );
        total += (end.row - start.row + 1) * (end.column - start.column + 1);
        break;
      }
      case "write_formula":
        parseCellRef(change.cell);
        total += 1;
        break;
      case "set_rows":
      case "set_columns":
        total += change.last - change.first + 1;
        break;
      default:
        break;
    }
    if (total > authoringLimits.maxCells)
      throw new SezzleeExcelError(
        "resource_limit",
        "The edit request exceeds 1,000,000 cells.",
      );
  }
  return total;
}

interface SheetIdentity {
  readonly name: string;
  readonly part: string;
  readonly kind: "worksheet" | "chartsheet" | "unsupported";
}

export interface EditInspection {
  readonly features: EditFeatures;
  readonly blockers: readonly EditBlocker[];
  readonly cellsRequested: number;
}

export function inspectWorkbookEdit(
  bytes: Buffer,
  changes: readonly EditChange[],
): EditInspection {
  const basic = changes.filter(
    (change) =>
      change.kind === "add_sheet" ||
      change.kind === "write_cells" ||
      change.kind === "clear_contents",
  );
  const cellsRequested = requestedCells(basic);
  const opc = openOpcPackage(zipSource(bytes));
  const features = editFeaturesSchema.parse({ parts: opc.parts.length });
  const blockers: EditBlocker[] = [];
  function block(
    code: Extract<EditBlocker, { kind: "workbook" }>["code"],
  ): void {
    if (
      !blockers.some(
        (entry) => entry.kind === "workbook" && entry.code === code,
      )
    )
      blockers.push({ kind: "workbook", code });
  }
  const entries = [...opc.packageRelationships.values()].filter((entry) =>
    officeDocument.has(entry.type),
  );
  const entry = entries[0];
  if (
    entries.length !== 1 ||
    entry?.kind !== "internal" ||
    opc.partSize(entry.target) === undefined
  )
    throw new SezzleeExcelError(
      "not_a_workbook",
      "The package must have one internal workbook entry point.",
    );
  const workbookPart = entry.target;
  const contentType = opc.contentTypes.contentTypeOf(workbookPart);
  if (contentType !== mainType && contentType !== macroType)
    throw new SezzleeExcelError(
      "not_a_workbook",
      "The entry point has no supported spreadsheet content type.",
    );

  const relationships = opc.relationshipsFor(workbookPart);
  const sheets: SheetIdentity[] = [];
  let workbookRoot = false;
  const stack: string[] = [];
  opc.scanPart(workbookPart, {
    onOpen(node) {
      const parent = stack.at(-1);
      const main = transitionalNamespace(node.uri) === namespaces.spreadsheetml;
      stack.push(main ? node.local : "");
      if (stack.length === 1) {
        workbookRoot = main && node.local === "workbook";
        features.strict =
          node.uri === "http://purl.oclc.org/ooxml/spreadsheetml/main";
      }
      if (!main) return;
      if (stack.length === 2 && node.local === "workbookPr")
        features.date1904 = flag(node, "date1904");
      if (stack.length === 2 && node.local === "workbookProtection") {
        features.protectionElements += 1;
        const locked = ["lockStructure", "lockWindows", "lockRevision"].map(
          (name) => flag(node, name),
        );
        if (locked.some(Boolean)) features.workbookProtected = true;
      }
      if (
        stack.length === 2 &&
        node.local === "fileSharing" &&
        (node.attr("reservationPassword") !== undefined ||
          node.attr("hashValue") !== undefined)
      )
        block("write_reservation");
      if (parent === "definedNames" && node.local === "definedName")
        features.definedNames += 1;
      if (stack.length !== 3 || parent !== "sheets" || node.local !== "sheet")
        return;
      const name = node.attr("name");
      const id =
        node.attr("id", namespaces.officeRelationships) ??
        node.attr("id", strictOffice);
      const target = id === undefined ? undefined : relationships.get(id);
      if (
        name === undefined ||
        target?.kind !== "internal" ||
        opc.partSize(target.target) === undefined
      )
        corrupt("A sheet has no valid name or internal part relationship.");
      if (
        sheets.some(
          (sheet) =>
            sheet.part === target.target ||
            sheet.name === unescapeXstring(name),
        )
      )
        corrupt("The workbook contains duplicate sheet identities.");
      const kind =
        target.type === `${namespaces.officeRelationships}/worksheet` ||
        target.type === `${strictOffice}/worksheet`
          ? "worksheet"
          : target.type === `${namespaces.officeRelationships}/chartsheet` ||
              target.type === `${strictOffice}/chartsheet`
            ? "chartsheet"
            : "unsupported";
      if (kind === "unsupported") block("unsupported_layout");
      sheets.push({ name: unescapeXstring(name), part: target.target, kind });
    },
    onClose() {
      stack.pop();
    },
  });
  if (!workbookRoot || sheets.length === 0)
    throw new SezzleeExcelError(
      "not_a_workbook",
      "The package has no valid workbook or sheets.",
    );
  features.sheets = sheets.length;
  if (features.strict) block("strict_markup");
  if (features.workbookProtected) {
    const unprotect = unprotectionPrefix(changes);
    const node = xmlNodes(
      opc.part(workbookPart) ?? "",
      "workbookProtection",
    )[0];
    if (unprotect === undefined || node === undefined)
      block("protected_workbook");
    else verifyProtection(node.attributes, unprotect.password, true);
  }
  for (const part of opc.parts) {
    if (part.path === "[Content_Types].xml") continue;
    const type = opc.contentTypes.contentTypeOf(part.path) ?? "";
    if (
      /macroenabled|vbaproject/i.test(type) ||
      /(?:^|\/)vbaproject\.bin$/i.test(part.path)
    )
      block("macros");
    if (
      part.path.startsWith("_xmlsignatures/") ||
      type.includes("digital-signature")
    )
      block("signed_package");
    if (type.endsWith(".table+xml")) features.tables += 1;
    if (type.endsWith(".chart+xml")) features.charts += 1;
    if (type.endsWith(".drawing+xml")) features.drawings += 1;
    if (part.path.endsWith(".rels"))
      opc.scanPart(part.path, {
        onOpen(node) {
          if (
            node.uri !== namespaces.packageRelationships ||
            node.local !== "Relationship"
          )
            return;
          const type = node.attr("Type") ?? "";
          if (type.endsWith("/vbaProject")) block("macros");
          if (type.includes("/digital-signature/")) block("signed_package");
          if (node.attr("TargetMode") === "External")
            features.externalRelationships += 1;
        },
      });
    const worksheet = sheets.some(
      (sheet) => sheet.part === part.path && sheet.kind === "worksheet",
    );
    const chartSheet = sheets.some(
      (sheet) => sheet.part === part.path && sheet.kind === "chartsheet",
    );
    if (
      !worksheet &&
      !chartSheet &&
      !type.endsWith(".worksheet+xml") &&
      !type.endsWith(".chartsheet+xml")
    )
      continue;
    let root = false;
    let depth = 0;
    let protectedSheet = false;
    opc.scanPart(part.path, {
      onOpen(node) {
        depth += 1;
        if (transitionalNamespace(node.uri) !== namespaces.spreadsheetml)
          return;
        if (depth === 1)
          root = node.local === (chartSheet ? "chartsheet" : "worksheet");
        switch (node.local) {
          case "c":
            if (node.attr("s") !== undefined) features.styledCells += 1;
            break;
          case "f":
            features.formulas += 1;
            if (node.attr("t") === "shared") features.sharedFormulas += 1;
            if (node.attr("t") === "array") features.arrayFormulas += 1;
            break;
          case "mergeCell":
            features.mergedRanges += 1;
            break;
          case "conditionalFormatting":
            features.conditionalFormats += 1;
            break;
          case "dataValidation":
            features.validations += 1;
            break;
          case "sheetProtection": {
            if (depth !== 2) break;
            features.protectionElements += 1;
            const locked = ["sheet", "objects", "scenarios"].map((name) =>
              flag(node, name),
            );
            if (locked.some(Boolean)) protectedSheet = true;
            break;
          }
        }
      },
      onClose() {
        depth -= 1;
      },
    });
    if (!root) corrupt("A sheet part has an unexpected root element.");
    if (protectedSheet) {
      features.protectedSheets += 1;
      const sheet = sheets.find((s) => s.part === part.path);
      const unprotect =
        sheet === undefined
          ? undefined
          : unprotectionPrefix(changes, sheet.name);
      const node = xmlNodes(opc.part(part.path) ?? "", "sheetProtection")[0];
      if (unprotect === undefined || node === undefined)
        block("protected_sheet");
      else verifyProtection(node.attributes, unprotect.password, false);
    }
  }
  if (features.sheets > authoringLimits.maxSheets)
    throw new SezzleeExcelError(
      "resource_limit",
      "The workbook exceeds the editing sheet budget.",
    );
  return { features, blockers, cellsRequested };
}
