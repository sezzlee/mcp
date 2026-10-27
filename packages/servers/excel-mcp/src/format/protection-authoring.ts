import { asciiUpper } from "@sezzlee/file-core";
import type { EditChange } from "../authoring/edit.js";
import type { PresentationChange } from "../authoring/presentation.js";
import type { PreservedWorkbook } from "./preserved-workbook.js";
import {
  invalidPresentation,
  setWorksheetChild,
  setXmlChild,
  spreadsheetNamespace as main,
  xmlNodes,
} from "./presentation-xml.js";
import type { XmlSpan } from "./xml-edit.js";

type ProtectionChange = Extract<
  PresentationChange,
  {
    kind:
      | "protect_sheet"
      | "unprotect_sheet"
      | "protect_workbook"
      | "unprotect_workbook";
  }
>;

function passwordHash(password: string): string {
  let hash = 0;
  for (let i = password.length - 1; i >= 0; i--) {
    hash = ((hash >> 14) & 1) | ((hash << 1) & 0x7fff);
    hash ^= password.charCodeAt(i);
  }
  hash = ((hash >> 14) & 1) | ((hash << 1) & 0x7fff);
  hash ^= password.length;
  hash ^= 0xce4b;
  return asciiUpper(hash.toString(16).padStart(4, "0"));
}

export function verifyProtection(
  attributes: ReadonlyMap<string, string>,
  password: string | undefined,
  workbook: boolean,
): void {
  if (
    [...attributes.keys()].some((key) =>
      /hashValue|saltValue|algorithmName|spinCount/i.test(key),
    )
  )
    invalidPresentation(
      "Removing strong-hash protection is outside the supported protection profile.",
    );
  const hash = attributes.get(workbook ? "workbookPassword" : "password");
  if (
    hash !== undefined &&
    (password === undefined || asciiUpper(hash) !== passwordHash(password))
  )
    invalidPresentation(
      "The protection password does not match; the protected source is unchanged.",
    );
  if (
    workbook &&
    (attributes.has("revisionsPassword") ||
      ["1", "true"].includes(attributes.get("lockRevision") ?? "") ||
      ["1", "true"].includes(attributes.get("lockWindows") ?? ""))
  )
    invalidPresentation(
      "Revision/window protection is outside the supported removal profile.",
    );
}

export function unprotectionPrefix(
  changes: readonly EditChange[],
  sheetName?: string,
): ProtectionChange | undefined {
  for (const change of changes) {
    if (
      change.kind !== "unprotect_sheet" &&
      change.kind !== "unprotect_workbook"
    )
      return undefined;
    if (
      sheetName === undefined
        ? change.kind === "unprotect_workbook"
        : change.kind === "unprotect_sheet" && change.sheetName === sheetName
    )
      return change;
  }
  return undefined;
}

export function guardCurrentProtection(
  workbook: PreservedWorkbook,
  change: EditChange,
): void {
  if (
    change.kind === "unprotect_workbook" ||
    change.kind === "unprotect_sheet" ||
    change.kind === "protect_workbook" ||
    change.kind === "protect_sheet"
  )
    return;
  const locked = (node: XmlSpan, names: readonly string[]) =>
    names.some((name) =>
      ["1", "true"].includes(node.attributes.get(name) ?? ""),
    );
  if (
    xmlNodes(
      workbook.xml(workbook.workbookPart()),
      "workbookProtection",
      "workbook",
    ).some((node) =>
      locked(node, ["lockStructure", "lockWindows", "lockRevision"]),
    )
  )
    invalidPresentation(
      "Unprotect the workbook explicitly before further changes.",
    );
  for (const sheet of workbook.sheets())
    if (
      xmlNodes(workbook.xml(sheet.part), "sheetProtection", "worksheet").some(
        (node) => locked(node, ["sheet", "objects", "scenarios"]),
      )
    )
      invalidPresentation(
        "Unprotect every protected sheet explicitly before further changes.",
      );
}

export function applyProtectionChange(
  workbook: PreservedWorkbook,
  change: ProtectionChange,
): void {
  if (change.kind === "protect_sheet" || change.kind === "unprotect_sheet") {
    const sheet = workbook.sheet(change.sheetName),
      xml = workbook.xml(sheet.part),
      nodes = xmlNodes(xml, "sheetProtection", "worksheet");
    if (nodes.length > 1)
      invalidPresentation("The worksheet protection is ambiguous.");
    if (change.kind === "unprotect_sheet") {
      const node = nodes[0];
      if (node === undefined)
        invalidPresentation("The worksheet has no protection to remove.");
      verifyProtection(node.attributes, change.password, false);
      setWorksheetChild(workbook, sheet.part, "sheetProtection", "");
    } else {
      if (nodes.length)
        invalidPresentation(
          "Remove existing protection explicitly before replacing it.",
        );
      setWorksheetChild(
        workbook,
        sheet.part,
        "sheetProtection",
        `<sheetProtection xmlns="${main}" sheet="1" objects="1" scenarios="1" selectLockedCells="${change.selectLocked ? 0 : 1}" selectUnlockedCells="${change.selectUnlocked ? 0 : 1}"${change.password === undefined ? "" : ` password="${passwordHash(change.password)}"`}/>`,
      );
    }
  } else {
    const part = workbook.workbookPart(),
      xml = workbook.xml(part),
      nodes = xmlNodes(xml, "workbookProtection", "workbook");
    if (nodes.length > 1)
      invalidPresentation("The workbook protection is ambiguous.");
    if (change.kind === "unprotect_workbook") {
      const node = nodes[0];
      if (node === undefined)
        invalidPresentation("The workbook has no protection to remove.");
      verifyProtection(node.attributes, change.password, true);
    } else if (nodes.length)
      invalidPresentation(
        "Remove existing protection explicitly before replacing it.",
      );
    workbook.put(
      part,
      setXmlChild(
        xml,
        "workbook",
        "workbookProtection",
        change.kind === "unprotect_workbook"
          ? ""
          : `<workbookProtection xmlns="${main}" lockStructure="1"${change.password === undefined ? "" : ` workbookPassword="${passwordHash(change.password)}"`}/>`,
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
  }
}
