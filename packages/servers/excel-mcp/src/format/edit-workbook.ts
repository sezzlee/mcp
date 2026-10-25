import type { EditChange } from "../authoring/edit.js";
import type { WorkbookChange } from "../authoring/workbook.js";
import { SezzleeExcelError } from "../platform/errors.js";
import {
  readAuthoredWorkbook,
  editAuthoredWorkbook,
  serializeAuthoredWorkbook,
} from "./authoring.js";
import {
  editPreservedWorkbook,
  type PreservedEditResult,
} from "./preserved-workbook.js";
import { openOpcPackage, zipSource } from "../metadata/spreadsheetml/reader.js";

export function applyWorkbookChanges(
  bytes: Buffer,
  changes: readonly EditChange[],
  sources: ReadonlyMap<number, Buffer> = new Map(),
): Omit<PreservedEditResult, "editing"> & {
  readonly editing?: PreservedEditResult["editing"];
} {
  const simple = changes.filter(
    (change): change is WorkbookChange =>
      change.kind === "add_sheet" || change.kind === "write_cells",
  );
  const packageView = openOpcPackage(zipSource(bytes));
  const canonicalCandidate =
    packageView
      .part("xl/workbook.xml")
      ?.includes('<fileVersion appName="sezzlee"/>') === true &&
    packageView.parts.every((part) =>
      /^(?:\[Content_Types\]\.xml|_rels\/\.rels|xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/styles\.xml|xl\/worksheets\/sheet[1-9][0-9]*\.xml)$/.test(
        part.path,
      ),
    );
  if (simple.length === changes.length && canonicalCandidate) {
    let canonical: ReturnType<typeof readAuthoredWorkbook> | undefined;
    try {
      canonical = readAuthoredWorkbook(bytes);
    } catch (error) {
      if (
        !(error instanceof SezzleeExcelError) ||
        error.code !== "invalid_argument"
      )
        throw error;
    }
    if (canonical !== undefined) {
      const summary = editAuthoredWorkbook(canonical, simple);
      return { bytes: serializeAuthoredWorkbook(canonical), changes: summary };
    }
  }
  return editPreservedWorkbook(bytes, changes, sources);
}
