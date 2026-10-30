import { fold } from "@sezzlee/file-core";
import type {
  PresentationChange,
  CellStyle,
} from "../authoring/presentation.js";
import { presentationLimits } from "../authoring/presentation.js";
import { formatCellRef, maxRow } from "../grid/range.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { occupiedTarget } from "./occupied.js";
import { namespaces } from "../metadata/spreadsheetml/xml.js";
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
import {
  attribute,
  xmlEscape,
  xmlUnescape,
  applyXmlPatches,
} from "./xml-edit.js";
import {
  xmlNodes,
  setXmlChild,
  setWorksheetChild,
  addRelatedPart,
  removeRelatedPart,
  headerWith,
  invalidPresentation,
  presentationBudget,
  spreadsheetNamespace as main,
} from "./presentation-xml.js";
import {
  workbookTables,
  selectedTable,
  cellText,
  type WorkbookTable,
} from "./table-model.js";
import {
  containsCell,
  intersectsRange,
  occupiedCell,
  rangeCells,
} from "./presentation-workbook.js";
import {
  mapStructuredFormula,
  renderStructuredReference,
  type StructuredReference,
} from "./structured-reference.js";
import {
  applyFormulaChange,
  structuredAsA1,
  validateAuthoredFormula,
} from "./formula-authoring.js";
import { StyleAuthoring } from "./style-authoring.js";

type TableChange = Extract<
  PresentationChange,
  { kind: "create_table" | "edit_table" | "convert_table" }
>;
const tableOrder = [
  "autoFilter",
  "sortState",
  "tableColumns",
  "tableStyleInfo",
  "extLst",
];
const subtotal = {
  sum: 109,
  average: 101,
  count: 103,
  countNums: 102,
  min: 105,
  max: 104,
  stdDev: 107,
  var: 110,
};
function reference(bounds: ReturnType<typeof boundsOf>): string {
  return `${formatCellRef(bounds.top, bounds.left)}:${formatCellRef(bounds.bottom, bounds.right)}`;
}
/**
 * Guard: an agent that passes the data range alone makes its last data row
 * the totals row; told only to choose overwrite, it replaced that row. The
 * refusal names the cell and the range that adds the totals row below.
 */
function totalsRowOccupied(
  bounds: ReturnType<typeof boundsOf>,
  cell: string,
): never {
  const below = { ...bounds, bottom: bounds.bottom + 1 };
  throw new SezzleeExcelError(
    "invalid_argument",
    `The totals row is the last row of range ${reference(bounds)}, and ${cell} holds a value.`,
    bounds.bottom < maxRow
      ? `A table range includes its header and totals rows: give range ${reference(below)} to add the totals row below the data. Use overwrite:true only to replace row ${bounds.bottom}.`
      : `A table range includes its header and totals rows; there is no row below ${reference(bounds)}. Use overwrite:true only to replace row ${bounds.bottom}.`,
  );
}
function validateName(
  workbook: PreservedWorkbook,
  name: string,
  except?: string,
): void {
  if (/^(?:[A-Za-z]{1,3}[1-9][0-9]*|[Rr][0-9]*[Cc][0-9]*|[RrCc])$/.test(name))
    invalidPresentation(
      "A table name cannot be a cell reference or reserved R/C name.",
    );
  if (
    workbookTables(workbook).some(
      (t) =>
        t.part !== except &&
        (fold(t.name) === fold(name) || fold(t.displayName) === fold(name)),
    )
  )
    invalidPresentation("A table name is already in use.");
  if (
    xmlNodes(workbook.xml(workbook.workbookPart()), "definedName").some(
      (n) => fold(n.attributes.get("name") ?? "") === fold(name),
    )
  )
    invalidPresentation("The table name conflicts with a defined name.");
}
function checkExtent(
  workbook: PreservedWorkbook,
  sheetName: string,
  bounds: ReturnType<typeof boundsOf>,
  except?: string,
): void {
  rangeCells(bounds);
  workbook.guardPresentation(sheetName, bounds);
  const sheet = workbook.sheet(sheetName),
    xml = workbook.xml(sheet.part);
  if (
    workbookTables(workbook).some(
      (t) =>
        t.sheet.part === sheet.part &&
        t.part !== except &&
        intersectsRange(bounds, t.bounds),
    )
  )
    invalidPresentation("Tables cannot overlap.");
  if (
    xmlNodes(xml, "mergeCell").some((n) =>
      intersectsRange(bounds, boundsOf(n.attributes.get("ref") ?? "")),
    )
  )
    invalidPresentation("A table cannot overlap merged cells.");
  if (bounds.right - bounds.left + 1 > presentationLimits.maxTableColumns)
    presentationBudget("The table exceeds the column budget.");
}
function rewriteReferences(
  workbook: PreservedWorkbook,
  table: WorkbookTable,
  name: string,
  renames: ReadonlyMap<string, string>,
  convert: boolean | "delete",
  map?: (reference: StructuredReference) => string,
): void {
  const rewrite = (
    text: string,
    sheetName: string,
    row: number,
    column: number,
  ) =>
    mapStructuredFormula(text, (ref) => {
      const matching =
        ref.name === undefined
          ? sheetName === table.sheet.name &&
            containsCell(table.bounds, row, column)
          : fold(ref.name) === fold(table.name) ||
            fold(ref.name) === fold(table.displayName);
      if (!matching) return ref.raw;
      if (map !== undefined) return map(ref);
      if (convert === "delete") return "#REF!";
      if (convert) return structuredAsA1(workbook, ref, sheetName, row, column);
      return renderStructuredReference(
        ref,
        ref.columns.map((c) => renames.get(fold(c)) ?? c),
        ref.name === undefined ? undefined : name,
      );
    });
  for (const sheet of workbook.sheets()) {
    const xml = workbook.xml(sheet.part),
      grid = gridOf(xml, sheet.part);
    let changed = false;
    for (const [key, cell] of grid.cells)
      if (cell.formula !== undefined) {
        const formula = rewrite(
          cell.formula,
          sheet.name,
          rowOf(key),
          columnOf(key),
        );
        if (formula === cell.formula) continue;
        if (cell.formulaKind !== undefined && cell.formulaKind !== "normal")
          invalidPresentation(
            "A table identity change affects an unsupported grouped formula.",
          );
        const raw = rewriteCell(
          cell,
          formatCellRef(rowOf(key), columnOf(key)),
          `<f xmlns="${main}">${xmlEscape(formula)}</f>`,
          undefined,
          cell.style,
        );
        grid.cells.set(key, {
          ...cell,
          raw,
          formula,
          value: undefined,
          type: undefined,
        });
        changed = true;
      }
    if (changed) workbook.put(sheet.part, renderGrid(grid));
  }
  for (const owner of workbookTables(workbook)) {
    if (convert && owner.part === table.part) continue;
    const xml = workbook.xml(owner.part),
      patches: { start: number; end: number; text: string }[] = [];
    for (const local of ["calculatedColumnFormula", "totalsRowFormula"])
      for (const node of xmlNodes(xml, local, "tableColumn")) {
        const formula = xmlUnescape(xml.slice(node.openEnd, node.closeStart));
        const next = rewrite(
          formula,
          owner.sheet.name,
          local === "calculatedColumnFormula"
            ? owner.bounds.top + 1
            : owner.bounds.bottom,
          owner.bounds.left,
        );
        if (next !== formula)
          patches.push({
            start: node.openEnd,
            end: node.closeStart,
            text: xmlEscape(next),
          });
      }
    if (patches.length) workbook.put(owner.part, applyXmlPatches(xml, patches));
  }
  const part = workbook.workbookPart(),
    xml = workbook.xml(part),
    patches: { start: number; end: number; text: string }[] = [];
  for (const node of xmlNodes(xml, "definedName", "definedNames")) {
    const text = xmlUnescape(xml.slice(node.openEnd, node.closeStart));
    const owner =
      workbook.sheets()[Number(node.attributes.get("localSheetId") ?? 0)];
    if (owner === undefined)
      invalidPresentation("A defined name has an invalid owner.");
    const next = rewrite(text, owner.name, 1, 1);
    if (next !== text)
      patches.push({
        start: node.openEnd,
        end: node.closeStart,
        text: xmlEscape(next),
      });
  }
  if (patches.length) workbook.put(part, applyXmlPatches(xml, patches));
}
function setColumns(
  workbook: PreservedWorkbook,
  table: WorkbookTable,
  change: Extract<TableChange, { kind: "create_table" | "edit_table" }>,
): void {
  let xml = workbook.xml(table.part);
  const entries = xmlNodes(xml, "tableColumn", "tableColumns").map((n) => ({
    node: n,
    name: n.attributes.get("name") ?? "",
    raw: xml.slice(n.start, n.end),
  }));
  const totals = change.totals,
    calculated = change.calculatedColumns;
  for (const specs of [totals, calculated])
    if (specs !== undefined && specs !== null) {
      if (new Set(specs.map((s) => fold(s.column))).size !== specs.length)
        invalidPresentation("Each table column may be specified only once.");
      if (
        specs.some((s) => !entries.some((e) => fold(e.name) === fold(s.column)))
      )
        invalidPresentation(
          "An authored table formula or total names an unknown column.",
        );
    }
  for (const [index, entry] of entries.entries()) {
    let raw = entry.raw;
    for (const [prefix, uri] of entry.node.namespaces)
      raw = attribute(raw, prefix === "" ? "xmlns" : `xmlns:${prefix}`, uri);
    if (totals !== undefined) {
      raw = headerWith(raw, {
        totalsRowFunction: undefined,
        totalsRowLabel: undefined,
      });
      raw = setXmlChild(raw, "tableColumn", "totalsRowFormula", "");
      const spec = totals?.find((s) => fold(s.column) === fold(entry.name));
      if (spec?.kind === "label")
        raw = attribute(raw, "totalsRowLabel", spec.text);
      else if (spec?.kind === "function")
        raw = attribute(raw, "totalsRowFunction", spec.function);
      else if (spec?.kind === "formula") {
        const formula = validateAuthoredFormula(
          workbook,
          spec.formula,
          table.sheet.name,
          table.bounds.bottom,
          table.bounds.left + index,
        );
        raw = attribute(raw, "totalsRowFunction", "custom");
        raw = setXmlChild(
          raw,
          "tableColumn",
          "totalsRowFormula",
          `<totalsRowFormula xmlns="${main}">${xmlEscape(formula)}</totalsRowFormula>`,
          [
            "calculatedColumnFormula",
            "totalsRowFormula",
            "xmlColumnPr",
            "extLst",
          ],
        );
      }
    }
    const computed = calculated?.find(
      (c) => fold(c.column) === fold(entry.name),
    );
    if (computed !== undefined) {
      const formula = validateAuthoredFormula(
        workbook,
        computed.formula,
        table.sheet.name,
        table.bounds.top + 1,
        table.bounds.left + index,
        true,
      );
      raw = setXmlChild(
        raw,
        "tableColumn",
        "calculatedColumnFormula",
        `<calculatedColumnFormula xmlns="${main}">${xmlEscape(formula)}</calculatedColumnFormula>`,
        [
          "calculatedColumnFormula",
          "totalsRowFormula",
          "xmlColumnPr",
          "extLst",
        ],
      );
    }
    entry.raw = raw;
  }
  xml = setXmlChild(
    xml,
    "table",
    "tableColumns",
    `<tableColumns xmlns="${main}" count="${entries.length}">${entries.map((e) => e.raw).join("")}</tableColumns>`,
    tableOrder,
  );
  workbook.put(table.part, xml);
}
function writeTotals(
  workbook: PreservedWorkbook,
  table: WorkbookTable,
  overwrite: boolean,
): void {
  if (table.totalsRows !== 1) return;
  for (const [index, column] of table.columns.entries()) {
    const cell = formatCellRef(table.bounds.bottom, table.bounds.left + index),
      fn = column.node.attributes.get("totalsRowFunction"),
      label = column.node.attributes.get("totalsRowLabel");
    const raw = table.xml.slice(column.node.start, column.node.end),
      wrapped = `<root xmlns="${main}">${raw}</root>`,
      custom = xmlNodes(wrapped, "totalsRowFormula")[0];
    let formula: string | undefined;
    if (custom !== undefined)
      formula = xmlUnescape(wrapped.slice(custom.openEnd, custom.closeStart));
    else if (fn !== undefined && fn !== "none") {
      const parsed = Object.entries(subtotal).find(([name]) => name === fn);
      if (parsed === undefined)
        invalidPresentation("The totals function is unsupported.");
      const escaped = column.name.replace(/['[\]#@]/g, (ch) => "'" + ch);
      formula = `SUBTOTAL(${parsed[1]},${table.name}[${escaped}])`;
    }
    if (formula !== undefined)
      applyFormulaChange(workbook, {
        kind: "write_formula",
        sheetName: table.sheet.name,
        cell,
        formula,
        overwrite,
      });
    else if (label !== undefined)
      workbook.apply([
        {
          kind: "write_cells",
          sheetName: table.sheet.name,
          startCell: cell,
          values: [[{ kind: "text", value: label }]],
          overwrite,
        },
      ]);
  }
}
function calculatedRows(
  workbook: PreservedWorkbook,
  table: WorkbookTable,
  first: number,
  overwrite: boolean,
): void {
  const last = table.bounds.bottom - table.totalsRows;
  if (first > last) return;
  for (const [index, column] of table.columns.entries()) {
    const raw = `<root xmlns="${main}">${table.xml.slice(column.node.start, column.node.end)}</root>`,
      node = xmlNodes(raw, "calculatedColumnFormula")[0];
    if (node === undefined) continue;
    const formula = xmlUnescape(raw.slice(node.openEnd, node.closeStart)),
      col = table.bounds.left + index;
    applyFormulaChange(workbook, {
      kind: "fill_formula",
      sheetName: table.sheet.name,
      anchor: formatCellRef(table.bounds.top + 1, col),
      range: `${formatCellRef(first, col)}:${formatCellRef(last, col)}`,
      formula,
      overwrite,
    });
  }
}
function tableStyle(
  workbook: PreservedWorkbook,
  table: WorkbookTable,
  style: string | undefined,
  filter: boolean | undefined,
): void {
  let xml = workbook.xml(table.part);
  if (style !== undefined) {
    if (style === "SezzleeBlue") {
      const styles = new StyleAuthoring(workbook);
      styles.defineTableStyle();
      styles.finish();
    }
    xml = setXmlChild(
      xml,
      "table",
      "tableStyleInfo",
      `<tableStyleInfo xmlns="${main}"${style === "none" ? "" : ` name="${style}"`} showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>`,
      tableOrder,
    );
  }
  if (filter !== undefined) {
    const current = xmlNodes(xml, "autoFilter", "table")[0];
    if (
      !filter &&
      xmlNodes(xml, "filterColumn", "autoFilter").some(
        (n) => xml.slice(n.openEnd, n.closeStart).trim() !== "",
      )
    )
      invalidPresentation(
        "Hiding filter dropdowns cannot discard saved filter criteria.",
      );
    const ref = `${formatCellRef(table.bounds.top, table.bounds.left)}:${formatCellRef(table.bounds.bottom - table.totalsRows, table.bounds.right)}`;
    let raw =
      current === undefined
        ? `<autoFilter xmlns="${main}" ref="${ref}"/>`
        : attribute(xml.slice(current.start, current.end), "ref", ref);
    if (filter && current !== undefined) {
      for (const [prefix, uri] of current.namespaces)
        raw = attribute(raw, prefix === "" ? "xmlns" : `xmlns:${prefix}`, uri);
      raw = applyXmlPatches(
        raw,
        xmlNodes(raw, "filterColumn", "autoFilter").map((n) => ({
          start: n.start,
          end: n.openEnd,
          text: headerWith(raw.slice(n.start, n.openEnd), {
            hiddenButton: "0",
            showButton: "1",
          }),
        })),
      );
    }
    xml = setXmlChild(
      xml,
      "table",
      "autoFilter",
      filter ? raw : "",
      tableOrder,
    );
  }
  workbook.put(table.part, xml);
}
function createTable(
  workbook: PreservedWorkbook,
  change: Extract<TableChange, { kind: "create_table" }>,
): void {
  validateName(workbook, change.name);
  const bounds = boundsOf(change.range),
    sheet = workbook.sheet(change.sheetName);
  checkExtent(workbook, change.sheetName, bounds);
  const tables = workbookTables(workbook);
  if (tables.length >= presentationLimits.maxTables)
    presentationBudget("The table count exceeds the authoring budget.");
  const totals = change.totals !== undefined ? 1 : 0;
  if (bounds.bottom < bounds.top + totals)
    invalidPresentation("The table has no room for its totals row.");
  const grid = gridOf(workbook.xml(sheet.part), sheet.part),
    names: string[] = [];
  for (let col = bounds.left; col <= bounds.right; col++)
    names.push(cellText(workbook, grid.cells.get(keyOf(bounds.top, col))));
  if (new Set(names.map(fold)).size !== names.length)
    invalidPresentation("Table headers must be unique.");
  if (totals && !change.overwrite)
    for (let col = bounds.left; col <= bounds.right; col++)
      if (occupiedCell(grid.cells.get(keyOf(bounds.bottom, col))))
        totalsRowOccupied(bounds, formatCellRef(bounds.bottom, col));
  const ids = tables.map((t) => Number(t.root.attributes.get("id")));
  if (ids.some((id) => !Number.isInteger(id) || id < 1))
    invalidPresentation("A retained table has an invalid ID.");
  const id = Math.max(0, ...ids) + 1;
  let sequence = 1;
  while (workbook.parts.has(`xl/tables/table${sequence}.xml`)) sequence++;
  const part = `xl/tables/table${sequence}.xml`;
  const xml = `<table xmlns="${main}" id="${id}" name="${xmlEscape(change.name)}" displayName="${xmlEscape(change.name)}" ref="${reference(bounds)}" headerRowCount="1" totalsRowCount="${totals}" totalsRowShown="${totals}"><tableColumns count="${names.length}">${names.map((name, index) => `<tableColumn id="${index + 1}" name="${xmlEscape(name)}"/>`).join("")}</tableColumns></table>`;
  const relation = addRelatedPart(
    workbook,
    sheet.part,
    part,
    `${namespaces.officeRelationships}/table`,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml",
    xml,
  );
  const sheetXml = workbook.xml(sheet.part),
    existing = xmlNodes(sheetXml, "tablePart", "tableParts").map((n) =>
      sheetXml.slice(n.start, n.end),
    );
  existing.push(
    `<tablePart xmlns="${main}" xmlns:r="${namespaces.officeRelationships}" r:id="${relation}"/>`,
  );
  setWorksheetChild(
    workbook,
    sheet.part,
    "tableParts",
    `<tableParts xmlns="${main}" count="${existing.length}">${existing.join("")}</tableParts>`,
  );
  let table = selectedTable(workbook, sheet.name, change.name);
  setColumns(workbook, table, change);
  table = selectedTable(workbook, sheet.name, change.name);
  tableStyle(workbook, table, change.style, change.filter);
  if (totals)
    workbook.apply([
      {
        kind: "clear_contents",
        sheetName: sheet.name,
        range: `${formatCellRef(bounds.bottom, bounds.left)}:${formatCellRef(bounds.bottom, bounds.right)}`,
      },
    ]);
  table = selectedTable(workbook, sheet.name, change.name);
  calculatedRows(workbook, table, bounds.top + 1, change.overwrite);
  writeTotals(workbook, table, true);
  workbook.presentationEffect("table", 0);
}
function editTable(
  workbook: PreservedWorkbook,
  change: Extract<TableChange, { kind: "edit_table" }>,
): void {
  if (
    change.name === undefined &&
    change.range === undefined &&
    change.columns === undefined &&
    change.totals === undefined &&
    change.style === undefined &&
    change.filter === undefined &&
    change.calculatedColumns === undefined
  )
    invalidPresentation(
      "Specify a table change; overwrite and clearRemovedValues alone are not operations.",
    );
  if (change.columns?.length === 0 || change.calculatedColumns?.length === 0)
    invalidPresentation(
      "Column changes must contain at least one named column.",
    );
  const original = selectedTable(workbook, change.sheetName, change.tableName),
    newName = change.name ?? original.name;
  if (
    (change.range !== undefined ||
      change.name !== undefined ||
      change.columns !== undefined ||
      change.totals !== undefined ||
      change.calculatedColumns !== undefined) &&
    (workbook.opc().relationshipsFor(original.part).size > 0 ||
      xmlNodes(original.xml, "xmlColumnPr").length ||
      xmlNodes(original.xml, "extLst").length)
  )
    invalidPresentation(
      "The table has query/XML/extension dependencies that this structural authoring profile cannot preserve.",
    );
  validateName(workbook, newName, original.part);
  const renames = new Map<string, string>();
  for (const column of change.columns ?? []) {
    if (
      renames.has(fold(column.column)) ||
      !original.columns.some((c) => fold(c.name) === fold(column.column))
    )
      invalidPresentation(
        "A column rename is duplicated or names an unknown column.",
      );
    renames.set(fold(column.column), column.name);
  }
  const names = original.columns.map(
    (c) => renames.get(fold(c.name)) ?? c.name,
  );
  if (
    names.some((n) => !n.trim()) ||
    new Set(names.map(fold)).size !== names.length
  )
    invalidPresentation("Renamed headers must stay nonblank and unique.");
  const totals =
    change.totals === undefined
      ? original.totalsRows
      : change.totals === null
        ? 0
        : 1;
  const bounds =
    change.range === undefined
      ? {
          ...original.bounds,
          bottom: original.bounds.bottom + totals - original.totalsRows,
        }
      : boundsOf(change.range);
  if (
    bounds.top !== original.bounds.top ||
    bounds.left !== original.bounds.left ||
    bounds.right !== original.bounds.right
  )
    invalidPresentation(
      "Table resizing retains its header position and column width; use explicit column operations first.",
    );
  if (bounds.bottom < bounds.top + totals || bounds.bottom > maxRow)
    invalidPresentation(
      "The resized table has an invalid header/data/totals extent.",
    );
  checkExtent(workbook, change.sheetName, bounds, original.part);
  const part = original.sheet.part,
    grid = gridOf(workbook.xml(part), part),
    oldDataBottom = original.bounds.bottom - original.totalsRows,
    newDataBottom = bounds.bottom - totals;
  const resized =
    reference(bounds) !== original.ref || totals !== original.totalsRows;
  if (resized) {
    const filter = xmlNodes(original.xml, "filterColumn", "autoFilter").filter(
        (n) => original.xml.slice(n.openEnd, n.closeStart).trim() !== "",
      ),
      sort = xmlNodes(original.xml, "sortState").filter(
        (n) => original.xml.slice(n.openEnd, n.closeStart).trim() !== "",
      );
    if (filter.length || sort.length)
      invalidPresentation(
        "Resizing a table with saved filter/sort criteria requires an explicit supported filter transformation.",
      );
    for (let row = oldDataBottom + 1; row <= newDataBottom; row++)
      for (let col = bounds.left; col <= bounds.right; col++) {
        if (original.totalsRows && row === original.bounds.bottom) continue;
        if (occupiedCell(grid.cells.get(keyOf(row, col))) && !change.overwrite)
          occupiedTarget(change.sheetName, formatCellRef(row, col));
      }
    if (totals && bounds.bottom !== original.bounds.bottom)
      for (let col = bounds.left; col <= bounds.right; col++)
        if (
          occupiedCell(grid.cells.get(keyOf(bounds.bottom, col))) &&
          !change.overwrite
        )
          occupiedTarget(change.sheetName, formatCellRef(bounds.bottom, col));
  }
  if (newDataBottom < oldDataBottom) {
    const current = gridOf(workbook.xml(part), part);
    for (const [key, cell] of current.cells) {
      const row = rowOf(key),
        column = columnOf(key);
      if (
        row <= newDataBottom ||
        row > oldDataBottom ||
        column < bounds.left ||
        column > bounds.right ||
        cell.formula === undefined
      )
        continue;
      const formula = mapStructuredFormula(cell.formula, (ref) =>
        ref.rowContext &&
        (ref.name === undefined || fold(ref.name) === fold(original.name))
          ? structuredAsA1(workbook, ref, original.sheet.name, row, column)
          : ref.raw,
      );
      if (formula !== cell.formula) {
        if (cell.formulaKind !== undefined && cell.formulaKind !== "normal")
          invalidPresentation(
            "Shrinking affects a grouped formula that cannot be preserved.",
          );
        const raw = rewriteCell(
          cell,
          formatCellRef(row, column),
          `<f xmlns="${main}">${xmlEscape(formula)}</f>`,
          undefined,
          cell.style,
        );
        current.cells.set(key, {
          ...cell,
          raw,
          formula,
          value: undefined,
          type: undefined,
        });
      }
    }
    workbook.put(part, renderGrid(current));
  }
  if (renames.size || newName !== original.name)
    rewriteReferences(workbook, original, newName, renames, false);
  let xml = workbook.xml(original.part);
  const root = xmlNodes(xml, "table")[0];
  if (root === undefined) invalidPresentation("The table has no root.");
  xml = applyXmlPatches(xml, [
    {
      start: root.start,
      end: root.openEnd,
      text: headerWith(xml.slice(root.start, root.openEnd), {
        name: newName,
        displayName: newName,
        ref: reference(bounds),
        totalsRowCount: String(totals),
        totalsRowShown: String(totals),
      }),
    },
  ]);
  const patches = xmlNodes(xml, "tableColumn", "tableColumns").map((n) => ({
    start: n.start,
    end: n.openEnd,
    text: attribute(
      xml.slice(n.start, n.openEnd),
      "name",
      renames.get(fold(n.attributes.get("name") ?? "")) ??
        n.attributes.get("name"),
    ),
  }));
  xml = applyXmlPatches(xml, patches);
  const filters = xmlNodes(xml, "autoFilter", "table");
  if (filters[0] !== undefined)
    xml = applyXmlPatches(
      xml,
      filters.map((n) => ({
        start: n.start,
        end: n.openEnd,
        text: attribute(
          xml.slice(n.start, n.openEnd),
          "ref",
          `${formatCellRef(bounds.top, bounds.left)}:${formatCellRef(bounds.bottom - totals, bounds.right)}`,
        ),
      })),
    );
  workbook.put(original.part, xml);
  if (original.totalsRows && (resized || change.totals !== undefined))
    workbook.apply([
      {
        kind: "clear_contents",
        sheetName: change.sheetName,
        range: `${formatCellRef(original.bounds.bottom, bounds.left)}:${formatCellRef(original.bounds.bottom, bounds.right)}`,
      },
    ]);
  if (change.clearRemovedValues && bounds.bottom < original.bounds.bottom)
    workbook.apply([
      {
        kind: "clear_contents",
        sheetName: change.sheetName,
        range: `${formatCellRef(bounds.bottom + 1, bounds.left)}:${formatCellRef(original.bounds.bottom, bounds.right)}`,
      },
    ]);
  if (renames.size)
    workbook.apply([
      {
        kind: "write_cells",
        sheetName: change.sheetName,
        startCell: formatCellRef(bounds.top, bounds.left),
        values: [names.map((value) => ({ kind: "text", value }))],
        overwrite: true,
      },
    ]);
  let table = selectedTable(workbook, change.sheetName, newName);
  setColumns(workbook, table, change);
  table = selectedTable(workbook, change.sheetName, newName);
  tableStyle(workbook, table, change.style, change.filter);
  if (newDataBottom > oldDataBottom) {
    const current = gridOf(workbook.xml(part), part);
    for (let row = oldDataBottom + 1; row <= newDataBottom; row++)
      for (let col = bounds.left; col <= bounds.right; col++) {
        const template = grid.cells.get(
            keyOf(Math.max(original.bounds.top + 1, oldDataBottom), col),
          ),
          key = keyOf(row, col),
          cell = current.cells.get(key);
        if (template?.style !== undefined) {
          const raw = attribute(
            cell?.raw ?? `<c xmlns="${main}" r="${formatCellRef(row, col)}"/>`,
            "s",
            template.style,
          );
          current.cells.set(key, {
            raw,
            style: template.style,
            formula: cell?.formula,
            formulaKind: cell?.formulaKind,
            formulaRange: cell?.formulaRange,
            sharedIndex: cell?.sharedIndex,
            value: cell?.value,
            type: cell?.type,
            protectedMetadata: cell?.protectedMetadata ?? false,
            bindings: cell?.bindings ?? new Map([["", main]]),
          });
        }
      }
    workbook.put(part, renderGrid(current));
  }
  table = selectedTable(workbook, change.sheetName, newName);
  calculatedRows(
    workbook,
    table,
    change.calculatedColumns === undefined ? oldDataBottom + 1 : bounds.top + 1,
    change.overwrite,
  );
  if (totals && (resized || change.totals !== undefined))
    writeTotals(workbook, table, true);
  workbook.presentationEffect("table", 0);
}
function convertTable(
  workbook: PreservedWorkbook,
  change: Extract<TableChange, { kind: "convert_table" }>,
): void {
  const table = selectedTable(workbook, change.sheetName, change.tableName),
    info = xmlNodes(table.xml, "tableStyleInfo", "table")[0],
    style = info?.attributes.get("name");
  if (
    workbook.opc().relationshipsFor(table.part).size > 0 ||
    xmlNodes(table.xml, "xmlColumnPr").length ||
    xmlNodes(table.xml, "extLst").length
  )
    invalidPresentation(
      "Converting a table with query/XML/extension dependencies is unsupported.",
    );
  if (style !== undefined && style !== "SezzleeBlue")
    invalidPresentation(
      "This table style cannot yet be materialized without changing its appearance.",
    );
  if (
    info?.attributes.get("showFirstColumn") === "1" ||
    info?.attributes.get("showLastColumn") === "1" ||
    info?.attributes.get("showColumnStripes") === "1"
  )
    invalidPresentation(
      "The table's emphasis/column-stripe style cannot be materialized by this profile.",
    );
  if (
    xmlNodes(table.xml, "filterColumn").some(
      (n) => table.xml.slice(n.openEnd, n.closeStart).trim() !== "",
    ) ||
    xmlNodes(table.xml, "sortState").some(
      (n) => table.xml.slice(n.openEnd, n.closeStart).trim() !== "",
    )
  )
    invalidPresentation(
      "Converting saved filtered/sorted tables needs a supported filter-state transformation.",
    );
  rewriteReferences(workbook, table, table.name, new Map(), true);
  if (style === "SezzleeBlue") {
    const grid = gridOf(workbook.xml(table.sheet.part), table.sheet.part),
      styles = new StyleAuthoring(workbook);
    styles.requireTableStyle();
    workbook.presentationEffect("format", rangeCells(table.bounds));
    for (let row = table.bounds.top; row <= table.bounds.bottom; row++)
      for (let col = table.bounds.left; col <= table.bounds.right; col++) {
        const key = keyOf(row, col),
          cell = grid.cells.get(key);
        let patch: CellStyle = { font: { color: "000000" }, fill: "FFFFFF" };
        if (row === table.bounds.top)
          patch = { font: { bold: true, color: "FFFFFF" }, fill: "1F4E78" };
        else if (table.totalsRows && row === table.bounds.bottom)
          patch = {
            ...patch,
            font: { bold: true, color: "000000" },
            border: { top: { style: "thin", color: "1F4E78" } },
          };
        else if (
          info?.attributes.get("showRowStripes") !== "0" &&
          (row - table.bounds.top) % 2 === 1
        )
          patch = { ...patch, fill: "D9E2F3" };
        const styleId = styles.materializeTableStyle(cell?.style, patch),
          raw = attribute(
            cell?.raw ?? `<c xmlns="${main}" r="${formatCellRef(row, col)}"/>`,
            "s",
            styleId,
          );
        grid.cells.set(key, {
          raw,
          style: styleId,
          formula: cell?.formula,
          formulaKind: cell?.formulaKind,
          formulaRange: cell?.formulaRange,
          sharedIndex: cell?.sharedIndex,
          value: cell?.value,
          type: cell?.type,
          protectedMetadata: cell?.protectedMetadata ?? false,
          bindings: cell?.bindings ?? new Map([["", main]]),
        });
      }
    styles.finish();
    workbook.put(table.sheet.part, renderGrid(grid));
  }
  const xml = workbook.xml(table.sheet.part),
    remaining = xmlNodes(xml, "tablePart", "tableParts")
      .filter(
        (n) =>
          ![...n.attributes].some(
            ([key, value]) =>
              key.endsWith(":id") && value === table.relationship,
          ),
      )
      .map((n) => xml.slice(n.start, n.end));
  setWorksheetChild(
    workbook,
    table.sheet.part,
    "tableParts",
    remaining.length
      ? `<tableParts xmlns="${main}" count="${remaining.length}">${remaining.join("")}</tableParts>`
      : "",
  );
  removeRelatedPart(workbook, table.sheet.part, table.part);
  workbook.presentationEffect("table", 0);
}
export function applyTableChange(
  workbook: PreservedWorkbook,
  change: TableChange,
): void {
  switch (change.kind) {
    case "create_table":
      createTable(workbook, change);
      break;
    case "edit_table":
      editTable(workbook, change);
      break;
    case "convert_table":
      convertTable(workbook, change);
      break;
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}
export function refreshTableFormulas(
  workbook: PreservedWorkbook,
  sheetName: string,
  tableName: string,
  firstNewRow: number,
): void {
  const table = selectedTable(workbook, sheetName, tableName);
  calculatedRows(workbook, table, firstNewRow, true);
  writeTotals(workbook, table, true);
}
export function syncTableFilterRanges(
  workbook: PreservedWorkbook,
  sheetName: string,
  parts: ReadonlySet<string>,
): void {
  if (parts.size === 0) return;
  for (const table of workbookTables(workbook).filter(
    (table) => table.sheet.name === sheetName && parts.has(table.part),
  )) {
    const filter = xmlNodes(table.xml, "autoFilter", "table")[0];
    if (filter === undefined) continue;
    const ref = `${formatCellRef(table.bounds.top, table.bounds.left)}:${formatCellRef(table.bounds.bottom - table.totalsRows, table.bounds.right)}`;
    if (filter.attributes.get("ref") === ref) continue;
    workbook.put(
      table.part,
      applyXmlPatches(table.xml, [
        {
          start: filter.start,
          end: filter.openEnd,
          text: attribute(
            table.xml.slice(filter.start, filter.openEnd),
            "ref",
            ref,
          ),
        },
      ]),
    );
  }
}
export function deleteSheetTableReferences(
  workbook: PreservedWorkbook,
  sheetName: string,
): void {
  for (const table of workbookTables(workbook).filter(
    (t) => t.sheet.name === sheetName,
  ))
    rewriteReferences(workbook, table, table.name, new Map(), "delete");
}
export function deleteTableColumnReferences(
  workbook: PreservedWorkbook,
  sheetName: string,
  at: number,
  count: number,
): void {
  for (const table of workbookTables(workbook).filter(
    (t) =>
      t.sheet.name === sheetName &&
      at <= t.bounds.right &&
      at + count > t.bounds.left,
  )) {
    rewriteReferences(workbook, table, table.name, new Map(), false, (ref) => {
      if (ref.columns.length === 0) return ref.raw;
      const first = table.columns.findIndex(
          (c) => fold(c.name) === fold(ref.columns[0] ?? ""),
        ),
        last =
          ref.columns.length === 1
            ? first
            : table.columns.findIndex(
                (c) => fold(c.name) === fold(ref.columns[1] ?? ""),
              );
      if (first < 0 || last < first)
        invalidPresentation(
          "A deleted column affects an unresolved structured reference.",
        );
      const kept = table.columns.slice(first, last + 1).filter((_, i) => {
        const col = table.bounds.left + first + i;
        return col < at || col >= at + count;
      });
      const start = kept[0],
        end = kept.at(-1);
      if (start === undefined || end === undefined) return "#REF!";
      return renderStructuredReference(
        ref,
        start === end ? [start.name] : [start.name, end.name],
      );
    });
  }
}
