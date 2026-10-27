import type { EditChange, SourceEditChange } from "../authoring/edit.js";
import type { WorkbookChange } from "../authoring/workbook.js";
import { SezzleeExcelError } from "../platform/errors.js";
import type { EditPlacement } from "../platform/versions.js";
import { workbookSheetNames } from "./edit-inspection.js";
import { planSourceFrameEdit, type EditPlan } from "./edit-plan.js";
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

export type PlannedEdit = Extract<EditPlan, { kind: "planned" }>;

export function planWorkbookEdit(
  bytes: Buffer,
  changes: readonly SourceEditChange[],
  externalCopies: ReadonlySet<number>,
): EditPlan {
  return planSourceFrameEdit(
    workbookSheetNames(bytes),
    changes,
    externalCopies,
  );
}

export function refuseBlockedPlan(plan: EditPlan): PlannedEdit {
  if (plan.kind === "planned") return plan;
  throw new SezzleeExcelError(
    "invalid_argument",
    `The workbook cannot be edited: ${plan.blockers
      .map((blocker) => `change ${blocker.operationIndex} ${blocker.code}`)
      .join(", ")}.`,
    "Address every change at source coordinates, never combine a change with another that deletes, moves or copies the same cells, and give new sheets names no source sheet uses.",
  );
}

export function applyPlannedEdit(
  bytes: Buffer,
  plan: PlannedEdit,
  operations: number,
  sources: ReadonlyMap<number, Buffer> = new Map(),
): ReturnType<typeof applyWorkbookChanges> & {
  readonly placements: readonly EditPlacement[];
} {
  const ordered = new Map<number, Buffer>();
  for (const [index, entry] of plan.changes.entries()) {
    const source = sources.get(entry.origin);
    if (source !== undefined) ordered.set(index, source);
  }
  const applied = applyWorkbookChanges(
    bytes,
    plan.changes.map((entry) => entry.change),
    ordered,
  );
  return {
    ...applied,
    ...(applied.editing === undefined
      ? {}
      : { editing: { ...applied.editing, operations } }),
    placements: plan.placements,
  };
}
