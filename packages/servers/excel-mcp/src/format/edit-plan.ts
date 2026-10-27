import { canonical, fold } from "@sezzlee/file-core";
import type {
  EditBlocker,
  EditChange,
  InsertedCell,
  SourceEditChange,
} from "../authoring/edit.js";
import type { WriteCell } from "../authoring/values.js";
import {
  columnToLetters,
  formatCellRef,
  formatRange,
  lettersToColumn,
  maxColumn,
  maxRow,
  parseCellRef,
  type GridBounds,
} from "../grid/range.js";
import { SezzleeExcelError } from "../platform/errors.js";
import type { EditPlacement } from "../platform/versions.js";
import {
  copyFormula,
  transformFormula,
  type ReferenceMapper,
} from "./formula-edit.js";
import { authoringLimits } from "../authoring/workbook.js";
import { boundsOf } from "./preserved-workbook.js";
import { validationTargets } from "./rule-authoring.js";

type SourceIndex = number & { readonly __brand: "SourceIndex" };
type OutputIndex = number & { readonly __brand: "OutputIndex" };
const sourceIndex = (value: number): SourceIndex => value as SourceIndex;
const outputIndex = (value: number): OutputIndex => value as OutputIndex;

type Axis = "row" | "column";
type OperationBlocker = Extract<EditBlocker, { kind: "operation" }>;
type BlockerCode = OperationBlocker["code"];
type Phase =
  | "unprotect"
  | "create"
  | "edit"
  | "structure"
  | "rename"
  | "delete"
  | "reorder"
  | "protect";
type Role = "content" | "layout" | "reference" | "copy" | "move" | "snapshot";

interface Region {
  readonly sheet: string;
  readonly bounds: GridBounds;
  readonly role: Role;
}

interface Described {
  readonly phase: Phase;
  readonly sheets: readonly string[];
  readonly regions: readonly Region[];
  readonly formulas: readonly {
    readonly sheet: string;
    readonly text: string;
  }[];
  readonly placement: Region | undefined;
}

interface AxisChange {
  readonly origin: number;
  readonly sheetName: string;
  readonly axis: Axis;
  readonly at: SourceIndex;
  readonly count: number;
  readonly effect: "insert" | "delete";
}

interface InsertedRows {
  readonly origin: number;
  readonly sheetName: string;
  readonly change: AxisChange;
  readonly startColumn: SourceIndex;
  readonly rows: readonly (readonly InsertedCell[])[];
}

type Mapped = { kind: "kept"; at: OutputIndex } | { kind: "deleted" };

export interface PlannedChange {
  readonly origin: number;
  readonly change: EditChange;
}

export type EditPlan =
  | {
      readonly kind: "planned";
      readonly changes: readonly PlannedChange[];
      readonly placements: readonly EditPlacement[];
    }
  | {
      readonly kind: "blocked";
      readonly blockers: readonly OperationBlocker[];
    };

const conflictingRoles: ReadonlySet<Role> = new Set([
  "copy",
  "move",
  "snapshot",
]);
const writingRoles: ReadonlySet<Role> = new Set([
  "content",
  "copy",
  "move",
  "snapshot",
]);

function block(start: string, height: number, width: number): GridBounds {
  const cell = parseCellRef(start);
  return {
    top: cell.row,
    left: cell.column,
    bottom: cell.row + height - 1,
    right: cell.column + width - 1,
  };
}

const rows = (first: number, last: number): GridBounds => ({
  top: first,
  bottom: last,
  left: 1,
  right: maxColumn,
});
const columns = (first: number, last: number): GridBounds => ({
  top: 1,
  bottom: maxRow,
  left: first,
  right: last,
});

function described(
  phase: Phase,
  parts: Partial<Omit<Described, "phase">> = {},
): Described {
  return {
    phase,
    sheets: parts.sheets ?? [],
    regions: parts.regions ?? [],
    formulas: parts.formulas ?? [],
    placement: parts.placement,
  };
}

function region(sheet: string, bounds: GridBounds, role: Role): Region {
  return { sheet, bounds, role };
}

function placed(sheet: string, bounds: GridBounds, role: Role): Described {
  const target = region(sheet, bounds, role);
  return described("edit", {
    sheets: [sheet],
    regions: [target],
    placement: target,
  });
}

function describe(change: SourceEditChange, external: boolean): Described {
  switch (change.kind) {
    case "add_sheet":
      return described("create");
    case "write_cells":
      return placed(
        change.sheetName,
        block(
          change.startCell,
          change.values.length,
          change.values[0]?.length ?? 1,
        ),
        "content",
      );
    case "clear_contents":
      return placed(change.sheetName, boundsOf(change.range), "content");
    case "rename_sheet":
      return described("rename", { sheets: [change.sheetName] });
    case "reorder_sheet":
      return described("reorder", { sheets: [change.sheetName] });
    case "delete_sheet":
      return described("delete");
    case "copy_sheet":
      return described("create");
    case "copy_range": {
      const source = boundsOf(change.range);
      const target = region(
        change.targetSheet,
        block(
          change.startCell,
          source.bottom - source.top + 1,
          source.right - source.left + 1,
        ),
        "copy",
      );
      return described("create", {
        sheets: [change.targetSheet],
        regions: external
          ? [target]
          : [target, region(change.sheetName, source, "snapshot")],
        placement: target,
      });
    }
    case "move_range": {
      const source = boundsOf(change.range);
      const target = region(
        change.targetSheet,
        block(
          change.startCell,
          source.bottom - source.top + 1,
          source.right - source.left + 1,
        ),
        "move",
      );
      return described("edit", {
        sheets: [change.sheetName, change.targetSheet],
        regions: [region(change.sheetName, source, "move"), target],
        placement: target,
      });
    }
    case "insert_rows":
    case "delete_rows":
    case "insert_columns":
    case "delete_columns":
      return described("structure", { sheets: [change.sheetName] });
    case "unprotect_sheet":
    case "unprotect_workbook":
      return described("unprotect", { sheets: [change.sheetName] });
    case "protect_sheet":
    case "protect_workbook":
      return described("protect", { sheets: [change.sheetName] });
    case "set_pivot": {
      const output = region(change.sheetName, boundsOf(change.cell), "content");
      return described("edit", {
        sheets: [change.sheetName, change.sourceSheet],
        regions: [
          output,
          region(change.sourceSheet, boundsOf(change.sourceRange), "reference"),
        ],
        placement: output,
      });
    }
    case "set_chart": {
      const anchor = region(change.sheetName, boundsOf(change.cell), "layout");
      return described("edit", {
        sheets: [
          change.sheetName,
          ...change.series.map((series) => series.sheetName),
        ],
        regions: [
          anchor,
          ...change.series.flatMap((series) => [
            region(series.sheetName, boundsOf(series.categories), "reference"),
            region(series.sheetName, boundsOf(series.values), "reference"),
          ]),
        ],
        placement: anchor,
      });
    }
    case "set_hyperlink":
    case "remove_hyperlink":
    case "set_note":
    case "remove_note":
    case "set_image":
      return placed(change.sheetName, boundsOf(change.cell), "layout");
    case "set_validation": {
      const target = region(change.sheetName, boundsOf(change.range), "layout");
      return described("edit", {
        sheets: [change.sheetName],
        regions: [target],
        formulas:
          change.rule.type === "custom"
            ? [{ sheet: change.sheetName, text: change.rule.formula }]
            : [],
        placement: target,
      });
    }
    case "set_conditional_format": {
      const target = region(change.sheetName, boundsOf(change.range), "layout");
      const texts =
        change.rule.type === "expression"
          ? [change.rule.formula]
          : change.rule.formulas;
      return described("edit", {
        sheets: [change.sheetName],
        regions: [target],
        formulas: texts.map((text) => ({ sheet: change.sheetName, text })),
        placement: target,
      });
    }
    case "remove_validation": {
      const targets = validationTargets(change).map((bounds) =>
        region(change.sheetName, bounds, "layout"),
      );
      return described("edit", {
        sheets: [change.sheetName],
        regions: targets,
        placement: targets.length === 1 ? targets[0] : undefined,
      });
    }
    case "format_cells":
    case "unmerge_cells":
      return placed(change.sheetName, boundsOf(change.range), "layout");
    case "merge_cells":
      return placed(
        change.sheetName,
        boundsOf(change.range),
        change.loss === "discard_non_anchor" ? "content" : "layout",
      );
    case "define_name":
      return placed(change.sheetName, boundsOf(change.range), "reference");
    case "set_columns":
      return placed(
        change.sheetName,
        columns(change.first, change.last),
        "layout",
      );
    case "set_rows":
      return placed(
        change.sheetName,
        rows(change.first, change.last),
        "layout",
      );
    case "set_print_layout":
      return described("edit", {
        sheets: [change.sheetName],
        regions: [
          ...(change.printArea ? [boundsOf(change.printArea)] : []),
          ...(change.titleRows
            ? [rows(change.titleRows.first, change.titleRows.last)]
            : []),
          ...(change.titleColumns
            ? [columns(change.titleColumns.first, change.titleColumns.last)]
            : []),
        ].map((bounds) => region(change.sheetName, bounds, "reference")),
      });
    case "write_formula": {
      const target = region(change.sheetName, boundsOf(change.cell), "content");
      return described("edit", {
        sheets: [change.sheetName],
        regions: [target],
        formulas: [{ sheet: change.sheetName, text: change.formula }],
        placement: target,
      });
    }
    case "fill_formula": {
      const target = region(
        change.sheetName,
        boundsOf(change.range),
        "content",
      );
      return described("edit", {
        sheets: [change.sheetName],
        regions: [target],
        formulas: [{ sheet: change.sheetName, text: change.formula }],
        placement: target,
      });
    }
    case "create_table":
      return placed(change.sheetName, boundsOf(change.range), "content");
    case "edit_table":
      return change.range === undefined
        ? described("edit", { sheets: [change.sheetName] })
        : placed(change.sheetName, boundsOf(change.range), "content");
    case "remove_chart":
    case "remove_image":
    case "remove_conditional_format":
    case "delete_name":
    case "write_named_range":
    case "freeze_panes":
    case "set_sheet_visibility":
    case "convert_table":
      return described("edit", { sheets: [change.sheetName] });
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

function intersects(a: GridBounds, b: GridBounds): boolean {
  return (
    a.top <= b.bottom &&
    b.top <= a.bottom &&
    a.left <= b.right &&
    b.left <= a.right
  );
}

function mapIndex(changes: readonly AxisChange[], index: number): Mapped {
  let shift = 0;
  for (const change of changes)
    if (change.effect === "delete") {
      if (index >= change.at && index < change.at + change.count)
        return { kind: "deleted" };
      if (change.at + change.count <= index) shift -= change.count;
    } else if (change.at <= index) shift += change.count;
  return { kind: "kept", at: outputIndex(index + shift) };
}

function insertedStart(
  changes: readonly AxisChange[],
  insert: AxisChange,
): OutputIndex {
  let shift = 0;
  for (const change of changes)
    if (change.effect === "insert" && change.at < insert.at)
      shift += change.count;
    else if (
      change.effect === "delete" &&
      change.at + change.count <= insert.at
    )
      shift -= change.count;
  return outputIndex(insert.at + shift);
}

function mapEndpoint(
  changes: readonly AxisChange[],
  index: number,
  side: "start" | "end",
): OutputIndex {
  let at = index;
  for (;;) {
    const mapped = mapIndex(changes, at);
    if (mapped.kind === "kept") return mapped.at;
    at += side === "start" ? 1 : -1;
  }
}

function rendered(bounds: GridBounds): string {
  if (bounds.top === 1 && bounds.bottom === maxRow)
    return `${columnToLetters(bounds.left)}:${columnToLetters(bounds.right)}`;
  if (bounds.left === 1 && bounds.right === maxColumn)
    return `${bounds.top}:${bounds.bottom}`;
  return bounds.top === bounds.bottom && bounds.left === bounds.right
    ? formatCellRef(bounds.top, bounds.left)
    : formatRange(bounds);
}

function outsideStrings(
  text: string,
  replace: (segment: string) => string,
): string {
  return text
    .split('"')
    .map((segment, index) => (index % 2 === 0 ? replace(segment) : segment))
    .join('"');
}

const placeholder = /(\$?[A-Za-z]{1,3}\$?)\{row\}/g;

function invalidPlaceholder(message: string): never {
  throw new SezzleeExcelError(
    "invalid_argument",
    message,
    "Write {row} only as the row of a same-sheet cell reference in an inserted row, for example B{row}*C{row}.",
  );
}

function authoredText(formula: string): string {
  return (formula.startsWith("=") ? formula.slice(1) : formula).trim();
}

/**
 * Guard: a run of inserted formulas becomes one fill_formula only when the
 * engine's fill writes, cell for cell, the text each write_formula would. Fill
 * shifts every relative reference, while a source-frame formula keeps a
 * reference without {row} fixed, so equality is checked, never assumed.
 * Structured references are rewritten against the workbook's tables at write
 * time, so they never join a run. Without runs, each inserted formula cell is
 * its own operation and every one re-reads the whole sheet.
 */
function fillsAs(
  anchor: string,
  formula: string,
  sheetName: string,
  rows: number,
): boolean {
  const first = authoredText(anchor),
    next = authoredText(formula);
  return (
    !first.includes("[") &&
    !next.includes("[") &&
    copyFormula(next, sheetName, 0, 0) ===
      copyFormula(first, sheetName, rows, 0)
  );
}

function withPlaceholderRow(formula: string, row: number): string {
  if (
    formula
      .split('"')
      .some(
        (segment, index) =>
          index % 2 === 0 && segment.replace(placeholder, "").includes("{row}"),
      )
  )
    invalidPlaceholder("The formula uses {row} outside a cell reference.");
  return outsideStrings(formula, (segment) =>
    segment.replace(placeholder, (_, column: string) => `${column}${row}`),
  );
}

function axisEdit(change: AxisChange): EditChange {
  const target = {
    sheetName: change.sheetName,
    at: change.at,
    count: change.count,
  };
  if (change.axis === "row")
    return change.effect === "insert"
      ? { kind: "insert_rows", ...target }
      : { kind: "delete_rows", ...target };
  return change.effect === "insert"
    ? { kind: "insert_columns", ...target }
    : { kind: "delete_columns", ...target };
}

function inOutputNames(
  change: Exclude<SourceEditChange, { kind: "insert_rows" }>,
  outputName: (name: string) => string,
): EditChange {
  switch (change.kind) {
    case "reorder_sheet":
    case "protect_sheet":
    case "protect_workbook":
      return { ...change, sheetName: outputName(change.sheetName) };
    default:
      return change;
  }
}

export function planSourceFrameEdit(
  sourceSheets: readonly string[],
  changes: readonly SourceEditChange[],
  externalCopies: ReadonlySet<number> = new Set(),
): EditPlan {
  const blockers: OperationBlocker[] = [];
  const refuse = (operationIndex: number, code: BlockerCode): void => {
    if (
      !blockers.some(
        (entry) =>
          entry.operationIndex === operationIndex && entry.code === code,
      )
    )
      blockers.push({ kind: "operation", operationIndex, code });
  };

  const source = new Map(sourceSheets.map((name) => [canonical(name), name]));
  const created = new Map<string, number>();
  const renamed = new Map<
    string,
    { readonly name: string; readonly origin: number }
  >();
  const deleted = new Map<string, number>();
  const taken = new Set(sourceSheets.map((name) => fold(canonical(name))));

  function known(name: string): string {
    const key = canonical(name);
    if (source.has(key) || created.has(key)) return key;
    const renameTarget = [...renamed.values()].some(
      (entry) => fold(canonical(entry.name)) === fold(key),
    );
    throw new SezzleeExcelError(
      "unknown_sheet",
      renameTarget
        ? `'${name}' is the new name of a sheet renamed in this request.`
        : `'${name}' is neither a source sheet nor a sheet created in this request.`,
      "Address every sheet by its name in the source workbook; renames apply after all other changes.",
    );
  }

  for (const [origin, change] of changes.entries())
    if (change.kind === "add_sheet" || change.kind === "copy_sheet") {
      const folded = fold(canonical(change.name));
      if (taken.has(folded)) refuse(origin, "name_conflict");
      taken.add(folded);
      created.set(canonical(change.name), origin);
    }
  for (const [origin, change] of changes.entries()) {
    if (change.kind === "copy_sheet") known(change.sheetName);
    if (change.kind === "rename_sheet") {
      const key = known(change.sheetName);
      if (renamed.has(key)) refuse(origin, "name_conflict");
      if (deleted.has(key)) refuse(origin, "target_deleted");
      const folded = fold(canonical(change.name));
      if (folded !== fold(key)) {
        if (taken.has(folded)) refuse(origin, "name_conflict");
        taken.add(folded);
      }
      renamed.set(key, { name: change.name, origin });
    }
    if (change.kind === "delete_sheet") {
      const key = known(change.sheetName);
      if (deleted.has(key) || renamed.has(key))
        refuse(origin, "target_deleted");
      deleted.set(key, origin);
    }
  }
  const outputName = (name: string): string =>
    renamed.get(canonical(name))?.name ?? name;

  const descriptions = changes.map((change, origin) =>
    describe(change, externalCopies.has(origin)),
  );
  for (const [origin, description] of descriptions.entries()) {
    for (const entry of description.regions) known(entry.sheet);
    for (const name of [
      ...description.sheets,
      ...description.regions
        .filter((entry) => entry.role !== "snapshot")
        .map((entry) => entry.sheet),
    ])
      if (deleted.has(known(name))) refuse(origin, "target_deleted");
  }

  const axes = new Map<string, AxisChange[]>();
  const axisKey = (name: string, axis: Axis): string =>
    `${canonical(name)}\u0000${axis}`;
  const axisChanges = (name: string, axis: Axis): readonly AxisChange[] =>
    axes.get(axisKey(name, axis)) ?? [];
  const inserted: InsertedRows[] = [];
  for (const [origin, change] of changes.entries()) {
    if (
      change.kind !== "insert_rows" &&
      change.kind !== "delete_rows" &&
      change.kind !== "insert_columns" &&
      change.kind !== "delete_columns"
    )
      continue;
    const axis: Axis = change.kind.endsWith("rows") ? "row" : "column";
    const count =
      change.kind === "insert_rows" && change.values !== undefined
        ? change.values.length
        : change.count;
    if (count === undefined)
      throw new SezzleeExcelError(
        "invalid_argument",
        "insert_rows needs either count or values.",
      );
    const entry: AxisChange = {
      origin,
      sheetName: change.sheetName,
      axis,
      at: sourceIndex(change.at),
      count,
      effect: change.kind.startsWith("delete") ? "delete" : "insert",
    };
    const key = axisKey(change.sheetName, axis);
    axes.set(key, [...(axes.get(key) ?? []), entry]);
    if (change.kind === "insert_rows" && change.values !== undefined)
      inserted.push({
        origin,
        sheetName: change.sheetName,
        change: entry,
        startColumn: sourceIndex(lettersToColumn(change.startColumn ?? "A")),
        rows: change.values,
      });
  }

  for (const entries of axes.values())
    for (const [index, a] of entries.entries())
      for (const b of entries.slice(index + 1)) {
        const later = Math.max(a.origin, b.origin);
        const [insert, removal] = a.effect === "insert" ? [a, b] : [b, a];
        if (a.effect === "insert" && b.effect === "insert") {
          if (a.at === b.at) refuse(later, "conflicting_structure");
        } else if (a.effect === "delete" && b.effect === "delete") {
          if (a.at < b.at + b.count && b.at < a.at + a.count)
            refuse(later, "conflicting_structure");
        } else if (
          insert.at > removal.at &&
          insert.at < removal.at + removal.count
        )
          refuse(later, "conflicting_structure");
      }

  for (const insert of inserted) {
    const width = insert.rows[0]?.length ?? 0;
    for (const change of axisChanges(insert.sheetName, "column")) {
      const inside =
        change.effect === "insert"
          ? change.at > insert.startColumn &&
            change.at < insert.startColumn + width
          : change.at < insert.startColumn + width &&
            insert.startColumn < change.at + change.count;
      if (inside) refuse(insert.origin, "conflicting_structure");
    }
  }

  function deletedBand(
    name: string,
    axis: Axis,
    first: number,
    last: number,
    whole: boolean,
  ): boolean {
    return axisChanges(name, axis).some(
      (change) =>
        change.effect === "delete" &&
        (whole
          ? first >= change.at && last < change.at + change.count
          : first < change.at + change.count && change.at <= last),
    );
  }
  for (const [origin, description] of descriptions.entries())
    for (const entry of description.regions) {
      if (entry.role === "snapshot") continue;
      const { top, bottom, left, right } = entry.bounds;
      const whole = entry.role === "reference";
      if (
        (!(top === 1 && bottom === maxRow) &&
          deletedBand(entry.sheet, "row", top, bottom, whole)) ||
        (!(left === 1 && right === maxColumn) &&
          deletedBand(entry.sheet, "column", left, right, whole))
      )
        refuse(origin, "target_deleted");
    }

  const regions = descriptions.flatMap((description, origin) =>
    description.regions.map((entry) => ({ ...entry, origin })),
  );
  for (const [index, a] of regions.entries())
    for (const b of regions.slice(index + 1))
      if (
        a.origin !== b.origin &&
        canonical(a.sheet) === canonical(b.sheet) &&
        (conflictingRoles.has(a.role) || conflictingRoles.has(b.role)) &&
        writingRoles.has(a.role) &&
        writingRoles.has(b.role) &&
        !(a.role === "snapshot" && b.role === "snapshot") &&
        intersects(a.bounds, b.bounds)
      )
        refuse(Math.max(a.origin, b.origin), "overlapping_writes");

  function deletedReference(owner: string): ReferenceMapper {
    let pending: { readonly sheet: string; readonly hit: boolean } | undefined;
    return (reference) => {
      const sheet = reference.sheet ?? owner;
      const key = canonical(sheet);
      const hit =
        deleted.has(key) ||
        (reference.row !== undefined &&
          deletedBand(sheet, "row", reference.row, reference.row, true)) ||
        (reference.column !== undefined &&
          deletedBand(
            sheet,
            "column",
            reference.column,
            reference.column,
            true,
          ));
      if (reference.boundary === "start") pending = { sheet: key, hit };
      else if (reference.boundary === "end") {
        if (pending?.hit === true && hit && pending.sheet === key) {
          pending = undefined;
          return "#REF!";
        }
        pending = undefined;
      } else if (hit) return "#REF!";
      return reference;
    };
  }
  for (const [origin, description] of descriptions.entries())
    for (const formula of description.formulas) {
      let text: string;
      try {
        text = transformFormula(
          formula.text,
          formula.sheet,
          deletedReference(formula.sheet),
        );
      } catch (error) {
        if (error instanceof SezzleeExcelError) continue;
        throw error;
      }
      if (text.includes("#REF!") && !formula.text.includes("#REF!"))
        refuse(origin, "target_deleted");
    }

  if (blockers.length > 0)
    return {
      kind: "blocked",
      blockers: blockers.sort((a, b) => a.operationIndex - b.operationIndex),
    };

  function translateInserted(
    insert: InsertedRows,
    formula: string,
    row: OutputIndex,
  ): string {
    transformFormula(
      withPlaceholderRow(formula, 1),
      insert.sheetName,
      (reference) => {
        if (reference.row === maxRow)
          invalidPlaceholder(
            `An inserted-row formula cannot reference row ${maxRow}.`,
          );
        return reference;
      },
    );
    const text = withPlaceholderRow(formula, maxRow);
    const owner = canonical(insert.sheetName);
    let lost = false;
    const translated = transformFormula(text, insert.sheetName, (reference) => {
      const sheet = reference.sheet ?? insert.sheetName;
      const sameSheet = canonical(sheet) === owner;
      if (deleted.has(canonical(sheet))) {
        lost = true;
        return "#REF!";
      }
      let target: number | undefined = reference.row;
      if (reference.row === maxRow) {
        if (!sameSheet)
          invalidPlaceholder(
            "{row} refers to the inserted row and is valid only on its own sheet.",
          );
        target = row;
      } else if (reference.row !== undefined) {
        const mapped = mapIndex(axisChanges(sheet, "row"), reference.row);
        if (mapped.kind === "deleted") {
          lost = true;
          return "#REF!";
        }
        target = mapped.at;
      }
      let column = reference.column;
      if (reference.column !== undefined) {
        const mapped = mapIndex(axisChanges(sheet, "column"), reference.column);
        if (mapped.kind === "deleted") {
          lost = true;
          return "#REF!";
        }
        column = mapped.at;
      }
      return { ...reference, row: target, column };
    });
    if (lost)
      throw new SezzleeExcelError(
        "invalid_argument",
        "An inserted-row formula references a row, column or sheet deleted by the same request.",
      );
    return translated;
  }

  const planned: PlannedChange[] = [];
  const placements: EditPlacement[] = [];
  const emitPhase = (phase: Phase): void => {
    for (const [origin, change] of changes.entries())
      if (
        change.kind !== "insert_rows" &&
        descriptions[origin]?.phase === phase
      )
        planned.push({ origin, change: inOutputNames(change, outputName) });
  };
  emitPhase("unprotect");
  emitPhase("create");
  /**
   * Guard: content and presentation changes are applied at their source
   * coordinates before any row or column moves, so the engine's shift carries
   * what they wrote and every reference to it. Moving structural changes ahead
   * of this phase makes source addresses land on the wrong cells.
   */
  emitPhase("edit");

  const structural = [...axes.values()].flatMap((entries) =>
    [...entries].sort(
      (a, b) =>
        b.at - a.at ||
        (a.effect === b.effect ? 0 : a.effect === "delete" ? -1 : 1),
    ),
  );
  for (const change of structural)
    planned.push({ origin: change.origin, change: axisEdit(change) });

  let formulaOperations = 0;
  for (const insert of inserted) {
    const top = insertedStart(
      axisChanges(insert.sheetName, "row"),
      insert.change,
    );
    const left = mapEndpoint(
      axisChanges(insert.sheetName, "column"),
      insert.startColumn,
      "start",
    );
    const blanked: WriteCell[][] = insert.rows.map((cells) =>
      cells.map((cell) => (cell.kind === "formula" ? { kind: "blank" } : cell)),
    );
    if (
      insert.rows.some((cells) => cells.some((cell) => cell.kind !== "formula"))
    )
      planned.push({
        origin: insert.origin,
        change: {
          kind: "write_cells",
          sheetName: insert.sheetName,
          startCell: formatCellRef(top, left),
          values: blanked,
          overwrite: false,
        },
      });
    const width = insert.rows[0]?.length ?? 0;
    for (let columnOffset = 0; columnOffset < width; columnOffset++) {
      const column = left + columnOffset;
      let run: { readonly top: number; readonly formula: string } | undefined;
      let bottom = 0;
      const flush = (): void => {
        if (run === undefined) return;
        formulaOperations += 1;
        if (formulaOperations > authoringLimits.maxOperations)
          throw new SezzleeExcelError(
            "resource_limit",
            `Inserted rows need more than ${authoringLimits.maxOperations} formula writes in one request.`,
            "Make references to fixed cells absolute, such as $F$1, so each inserted column fills as one formula, or insert fewer formula rows per request.",
          );
        planned.push({
          origin: insert.origin,
          change:
            bottom === run.top
              ? {
                  kind: "write_formula",
                  sheetName: insert.sheetName,
                  cell: formatCellRef(run.top, column),
                  formula: run.formula,
                  overwrite: false,
                }
              : {
                  kind: "fill_formula",
                  sheetName: insert.sheetName,
                  anchor: formatCellRef(run.top, column),
                  range: formatRange({
                    top: run.top,
                    bottom,
                    left: column,
                    right: column,
                  }),
                  formula: run.formula,
                  overwrite: false,
                },
        });
        run = undefined;
      };
      for (const [rowOffset, cells] of insert.rows.entries()) {
        const cell = cells[columnOffset];
        if (cell?.kind !== "formula") {
          flush();
          continue;
        }
        const row = top + rowOffset;
        const formula = translateInserted(
          insert,
          cell.formula,
          outputIndex(row),
        );
        if (
          run !== undefined &&
          fillsAs(run.formula, formula, insert.sheetName, row - run.top)
        ) {
          bottom = row;
          continue;
        }
        flush();
        run = { top: row, formula };
        bottom = row;
      }
      flush();
    }
  }

  emitPhase("rename");
  emitPhase("delete");
  emitPhase("reorder");
  emitPhase("protect");

  const mapBounds = (sheet: string, bounds: GridBounds): GridBounds => {
    const rowChanges = axisChanges(sheet, "row"),
      columnChanges = axisChanges(sheet, "column");
    const wholeColumns = bounds.top === 1 && bounds.bottom === maxRow;
    const wholeRows = bounds.left === 1 && bounds.right === maxColumn;
    return {
      top: wholeColumns ? 1 : mapEndpoint(rowChanges, bounds.top, "start"),
      bottom: wholeColumns
        ? maxRow
        : mapEndpoint(rowChanges, bounds.bottom, "end"),
      left: wholeRows ? 1 : mapEndpoint(columnChanges, bounds.left, "start"),
      right: wholeRows
        ? maxColumn
        : mapEndpoint(columnChanges, bounds.right, "end"),
    };
  };
  for (const [origin, description] of descriptions.entries()) {
    const target = description.placement;
    if (target === undefined) continue;
    const sheetName = outputName(target.sheet);
    const range = rendered(mapBounds(target.sheet, target.bounds));
    if (sheetName !== target.sheet || range !== rendered(target.bounds))
      placements.push({ operation: origin, sheetName, range });
  }
  for (const entries of axes.values())
    for (const change of entries) {
      if (change.effect !== "insert") continue;
      const start = insertedStart(entries, change);
      const sheetName = outputName(change.sheetName);
      const insertedValues = inserted.find(
        (entry) => entry.origin === change.origin,
      );
      const bounds =
        insertedValues !== undefined
          ? block(
              formatCellRef(
                start,
                mapEndpoint(
                  axisChanges(change.sheetName, "column"),
                  insertedValues.startColumn,
                  "start",
                ),
              ),
              change.count,
              insertedValues.rows[0]?.length ?? 1,
            )
          : change.axis === "row"
            ? rows(start, start + change.count - 1)
            : columns(start, start + change.count - 1);
      const requested =
        insertedValues !== undefined
          ? block(
              formatCellRef(change.at, insertedValues.startColumn),
              change.count,
              insertedValues.rows[0]?.length ?? 1,
            )
          : change.axis === "row"
            ? rows(change.at, change.at + change.count - 1)
            : columns(change.at, change.at + change.count - 1);
      if (
        sheetName !== change.sheetName ||
        rendered(bounds) !== rendered(requested)
      )
        placements.push({
          operation: change.origin,
          sheetName,
          range: rendered(bounds),
        });
    }

  return {
    kind: "planned",
    changes: planned,
    placements: placements.sort((a, b) => a.operation - b.operation),
  };
}
