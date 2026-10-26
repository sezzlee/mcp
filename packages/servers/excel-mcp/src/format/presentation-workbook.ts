import {
  presentationChangeSchema,
  type PresentationChange,
} from "../authoring/presentation.js";
import type { EditChange } from "../authoring/edit.js";
import { formatCellRef, type GridBounds } from "../grid/range.js";
import {
  boundsOf,
  gridOf,
  renderGrid,
  keyOf,
  rowOf,
  columnOf,
  rewriteCell,
  type PreservedWorkbook,
} from "./preserved-workbook.js";
import { attribute, xmlEscape } from "./xml-edit.js";
import { StyleAuthoring } from "./style-authoring.js";
import {
  xmlNodes,
  setWorksheetChild,
  spreadsheetNamespace as main,
  invalidPresentation,
  presentationBudget,
} from "./presentation-xml.js";
import { applyLayoutChange } from "./layout-authoring.js";
import { applyFormulaChange } from "./formula-authoring.js";
import { applyTableChange } from "./table-authoring.js";

export function isPresentationChange(
  change: EditChange,
): change is PresentationChange {
  return presentationChangeSchema.safeParse(change).success;
}
export function intersectsRange(a: GridBounds, b: GridBounds): boolean {
  return (
    a.top <= b.bottom &&
    a.bottom >= b.top &&
    a.left <= b.right &&
    a.right >= b.left
  );
}
export function containsCell(
  range: GridBounds,
  row: number,
  column: number,
): boolean {
  return (
    row >= range.top &&
    row <= range.bottom &&
    column >= range.left &&
    column <= range.right
  );
}
export function rangeCells(range: GridBounds): number {
  const count = (range.bottom - range.top + 1) * (range.right - range.left + 1);
  if (count > 1_000_000)
    presentationBudget("The operation exceeds 1,000,000 cells.");
  return count;
}
export function occupiedCell(
  cell: ReturnType<typeof gridOf>["cells"] extends Map<number, infer C>
    ? C | undefined
    : never,
): boolean {
  return (
    cell !== undefined &&
    (cell.formula !== undefined ||
      cell.value !== undefined ||
      cell.type === "s" ||
      cell.type === "inlineStr")
  );
}
function formatCells(
  workbook: PreservedWorkbook,
  change: Extract<PresentationChange, { kind: "format_cells" }>,
): void {
  if (
    Object.keys(change.style).length === 0 ||
    [change.style.font, change.style.border, change.style.alignment].some(
      (value) =>
        value !== undefined &&
        value !== null &&
        Object.keys(value).length === 0,
    )
  )
    invalidPresentation(
      "Specify at least one style property; use null for an explicit component reset.",
    );
  const bounds = boundsOf(change.range),
    count = rangeCells(bounds);
  workbook.presentationEffect("format", count);
  const sheet = workbook.sheet(change.sheetName),
    grid = gridOf(workbook.xml(sheet.part), sheet.part),
    styles = new StyleAuthoring(workbook);
  workbook.reservePresentationCells(
    count -
      [...grid.cells.keys()].filter((key) =>
        containsCell(bounds, rowOf(key), columnOf(key)),
      ).length,
  );
  const tableRegions = [];
  if (change.style.font !== undefined && change.style.font !== null)
    for (const relation of workbook
      .opc()
      .relationshipsFor(sheet.part)
      .values()) {
      if (relation.kind !== "internal" || !relation.type.endsWith("/table"))
        continue;
      const xml = workbook.xml(relation.target),
        root = xmlNodes(xml, "table")[0];
      if (root === undefined) invalidPresentation("A table has no root.");
      const region = boundsOf(root.attributes.get("ref") ?? "");
      if (!intersectsRange(bounds, region)) continue;
      const style = xmlNodes(xml, "tableStyleInfo", "table")[0]?.attributes.get(
        "name",
      );
      tableRegions.push({
        bounds: region,
        style,
        totals: Number(root.attributes.get("totalsRowCount") ?? 0),
      });
    }
  let checkedBlue = false;
  for (let row = bounds.top; row <= bounds.bottom; row++)
    for (let column = bounds.left; column <= bounds.right; column++) {
      const key = keyOf(row, column),
        cell = grid.cells.get(key);
      let patch = change.style;
      if (
        patch.font !== undefined &&
        patch.font !== null &&
        styles.inheritedFont(cell?.style)
      ) {
        const table = tableRegions.find((t) =>
          containsCell(t.bounds, row, column),
        );
        if (table?.style !== undefined) {
          if (table.style !== "SezzleeBlue")
            invalidPresentation(
              "A partial font patch needs a supported effective table style; use an explicit font reset or preserve this table's font.",
            );
          if (!checkedBlue) {
            styles.requireTableStyle();
            checkedBlue = true;
          }
          const role =
            row === table.bounds.top
              ? { bold: true, color: "FFFFFF" }
              : table.totals && row === table.bounds.bottom
                ? { bold: true, color: "000000" }
                : { color: "000000" };
          patch = { ...patch, font: { ...role, ...patch.font } };
        }
      }
      const style = styles.style(cell?.style, patch);
      if (cell !== undefined)
        grid.cells.set(key, {
          ...cell,
          raw: attribute(cell.raw, "s", style),
          style,
        });
      else
        grid.cells.set(key, {
          raw: `<c xmlns="${main}" r="${formatCellRef(row, column)}" s="${style}"/>`,
          style,
          formula: undefined,
          formulaKind: undefined,
          formulaRange: undefined,
          sharedIndex: undefined,
          value: undefined,
          type: undefined,
          protectedMetadata: false,
          bindings: new Map([["", main]]),
        });
    }
  styles.finish();
  workbook.put(sheet.part, renderGrid(grid));
}
function mergeCells(
  workbook: PreservedWorkbook,
  change: Extract<
    PresentationChange,
    { kind: "merge_cells" | "unmerge_cells" }
  >,
): void {
  const bounds = boundsOf(change.range),
    count = rangeCells(bounds),
    sheet = workbook.sheet(change.sheetName);
  workbook.guardPresentation(change.sheetName, bounds);
  let xml = workbook.xml(sheet.part);
  const grid = gridOf(xml, sheet.part);
  const merges = xmlNodes(xml, "mergeCell", "mergeCells").map((node) => ({
    ref: node.attributes.get("ref") ?? "",
    bounds: boundsOf(node.attributes.get("ref") ?? ""),
    raw: xml.slice(node.start, node.end),
  }));
  const ref = `${formatCellRef(bounds.top, bounds.left)}:${formatCellRef(bounds.bottom, bounds.right)}`;
  const overlapping = merges.filter((m) => intersectsRange(m.bounds, bounds));
  if (
    overlapping.some(
      (m) =>
        m.bounds.top !== bounds.top ||
        m.bounds.left !== bounds.left ||
        m.bounds.bottom !== bounds.bottom ||
        m.bounds.right !== bounds.right,
    )
  )
    invalidPresentation(
      "The requested range partially overlaps an existing merge.",
    );
  if (change.kind === "unmerge_cells") {
    const remaining = merges.filter((m) => !intersectsRange(m.bounds, bounds));
    setWorksheetChild(
      workbook,
      sheet.part,
      "mergeCells",
      remaining.length === 0
        ? ""
        : `<mergeCells xmlns="${main}" count="${remaining.length}">${remaining.map((m) => `<mergeCell ref="${xmlEscape(m.ref)}"/>`).join("")}</mergeCells>`,
    );
    return;
  }
  if (count === 1) invalidPresentation("A merge needs at least two cells.");
  if (overlapping.length > 0) return;
  for (const relation of workbook.opc().relationshipsFor(sheet.part).values())
    if (relation.kind === "internal" && relation.type.endsWith("/table")) {
      const table = xmlNodes(workbook.xml(relation.target), "table")[0];
      if (
        table !== undefined &&
        intersectsRange(bounds, boundsOf(table.attributes.get("ref") ?? ""))
      )
        invalidPresentation("A merged range cannot overlap a table.");
    }
  let cleared = 0;
  for (const [key, cell] of grid.cells) {
    const row = rowOf(key),
      column = columnOf(key);
    if (
      !containsCell(bounds, row, column) ||
      (row === bounds.top && column === bounds.left) ||
      !occupiedCell(cell)
    )
      continue;
    if (change.loss !== "discard_non_anchor")
      invalidPresentation(
        "The merge would discard non-anchor contents. Choose loss discard_non_anchor explicitly.",
      );
    const raw = rewriteCell(
      cell,
      formatCellRef(row, column),
      "",
      undefined,
      cell.style,
    );
    grid.cells.set(key, {
      ...cell,
      raw,
      formula: undefined,
      formulaKind: undefined,
      formulaRange: undefined,
      sharedIndex: undefined,
      type: undefined,
      value: undefined,
    });
    cleared++;
  }
  workbook.presentationEffect("merge", count, cleared);
  workbook.put(sheet.part, renderGrid(grid));
  xml = workbook.xml(sheet.part);
  const refs = [...merges.map((m) => m.ref), ref];
  setWorksheetChild(
    workbook,
    sheet.part,
    "mergeCells",
    `<mergeCells xmlns="${main}" count="${refs.length}">${refs.map((r) => `<mergeCell ref="${xmlEscape(r)}"/>`).join("")}</mergeCells>`,
  );
}
export function applyPresentationChange(
  workbook: PreservedWorkbook,
  change: PresentationChange,
): void {
  switch (change.kind) {
    case "format_cells":
      formatCells(workbook, change);
      break;
    case "merge_cells":
    case "unmerge_cells":
      mergeCells(workbook, change);
      break;
    case "write_formula":
    case "fill_formula":
      applyFormulaChange(workbook, change);
      break;
    case "create_table":
    case "edit_table":
    case "convert_table":
      applyTableChange(workbook, change);
      break;
    case "set_columns":
    case "set_rows":
    case "freeze_panes":
    case "set_sheet_visibility":
    case "set_print_layout":
      applyLayoutChange(workbook, change);
      break;
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}
