import { canonical, fold } from "@sezzlee/file-core";
import {
  createOoxmlWriter,
  relationshipsPathFor,
  type OpcPackage,
} from "@sezzlee/ooxml-core";
import { authoringLimits } from "../authoring/workbook.js";
import type { EditChange } from "../authoring/edit.js";
import type { WriteCell } from "../authoring/values.js";
import {
  isPresentationChange,
  applyPresentationChange,
} from "./presentation-workbook.js";
import type { PresentationChange } from "../authoring/presentation.js";
import type { MutationReceipt } from "../platform/versions.js";
import { isoWrite } from "./iso-write.js";
import {
  mapStructuredFormula,
  renderStructuredReference,
} from "./structured-reference.js";
import {
  deleteSheetTableReferences,
  deleteTableColumnReferences,
  syncTableFilterRanges,
} from "./table-authoring.js";
import { resolveStructuredReference } from "./formula-authoring.js";
import {
  parseCellRef,
  formatCellRef,
  maxColumn,
  maxRow,
  type GridBounds,
} from "../grid/range.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import { openOpcPackage, zipSource } from "../metadata/spreadsheetml/reader.js";
import { namespaces } from "../metadata/spreadsheetml/xml.js";
import { failOoxml } from "../metadata/spreadsheetml/errors.js";
import { unescapeXstring } from "../metadata/spreadsheetml/shared-strings.js";
import { inspectWorkbookEdit } from "./edit-inspection.js";
import { guardCurrentProtection } from "./protection-authoring.js";
import { featureData } from "./feature-data.js";
import { readNumberFormats } from "../metadata/spreadsheetml/styles.js";
import { isDateFormat } from "./cell-date.js";
import { isTimeOnlyFormat } from "./cell-date.js";
import { numericFormat } from "./number-format.js";
import { serialToDate } from "../grid/excel-serial.js";
import { occupiedTarget } from "./occupied.js";
import {
  copyFormula,
  transformFormula,
  type ReferenceMapper,
} from "./formula-edit.js";
import {
  scanXml,
  attribute,
  applyXmlPatches,
  xmlEscape,
  xmlUnescape,
  replaceElementBody,
  type XmlSpan,
  type XmlPatch,
} from "./xml-edit.js";

const main = namespaces.spreadsheetml;
const office = namespaces.officeRelationships;
const writer = createOoxmlWriter({ fail: failOoxml });
export const keyOf = (row: number, column: number): number =>
  (row - 1) * maxColumn + column - 1;
export const rowOf = (key: number): number => Math.floor(key / maxColumn) + 1;
export const columnOf = (key: number): number => (key % maxColumn) + 1;
const inside = (bounds: GridBounds, row: number, column: number): boolean =>
  row >= bounds.top &&
  row <= bounds.bottom &&
  column >= bounds.left &&
  column <= bounds.right;

function refuse(message: string): never {
  throw new SezzleeExcelError("invalid_argument", message);
}
function budget(message: string): never {
  throw new SezzleeExcelError("resource_limit", message);
}
export function boundsOf(range: string): GridBounds {
  const [first, last] = range.split(":");
  const start = parseCellRef(first ?? "");
  const end = last === undefined ? start : parseCellRef(last);
  if (end.row < start.row || end.column < start.column)
    throw new SezzleeExcelError(
      "invalid_range",
      "The range ends before it starts.",
    );
  return {
    top: start.row,
    left: start.column,
    bottom: end.row,
    right: end.column,
  };
}
function checked(row: number, column: number): void {
  if (row < 1 || row > maxRow || column < 1 || column > maxColumn)
    throw new SezzleeExcelError(
      "invalid_range",
      "The operation exceeds worksheet coordinates.",
    );
}
function literal(value: string): string {
  return xmlEscape(
    value
      .replace(/_x[0-9a-fA-F]{4}_/g, (match) => `_x005F_${match.slice(1)}`)
      .replace(/[\s\S]/g, (character) => {
        const code = character.charCodeAt(0);
        return (code < 32 && code !== 9 && code !== 10) ||
          code === 65534 ||
          code === 65535
          ? `_x${code.toString(16).padStart(4, "0")}_`
          : character;
      }),
  );
}

interface Cell {
  readonly raw: string;
  readonly style: string | undefined;
  readonly formula: string | undefined;
  readonly formulaKind: string | undefined;
  readonly formulaRange: string | undefined;
  readonly sharedIndex: string | undefined;
  readonly value: string | undefined;
  readonly type: string | undefined;
  readonly protectedMetadata: boolean;
  readonly bindings: ReadonlyMap<string, string>;
}
interface Row {
  readonly raw: string;
  readonly span: XmlSpan;
  readonly cells: readonly { start: number; end: number }[];
}
interface Grid {
  readonly xml: string;
  readonly data: XmlSpan;
  readonly root: XmlSpan;
  readonly rows: Map<number, Row>;
  readonly cells: Map<number, Cell>;
  readonly groups: readonly { bounds: GridBounds; kind: string }[];
}

export function gridOf(xml: string, part: string): Grid {
  const rows = new Map<number, Row>();
  const cells = new Map<number, Cell>();
  const groups: { bounds: GridBounds; kind: string }[] = [];
  let data: XmlSpan | undefined;
  let root: XmlSpan | undefined;
  let row: XmlSpan | undefined;
  let rowCells: { start: number; end: number }[] = [];
  let formula: string | undefined;
  let formulaKind: string | undefined;
  let formulaRange: string | undefined;
  let sharedIndex: string | undefined;
  let value: string | undefined;
  let count = 0;
  let unsupportedCell = false;
  scanXml(
    xml,
    part,
    (node) => {
      if (node.uri !== main) return;
      if (node.local === "f" && node.parent === "c") {
        formula = xmlUnescape(xml.slice(node.openEnd, node.closeStart));
        formulaKind = node.attributes.get("t");
        formulaRange = node.attributes.get("ref");
        sharedIndex = node.attributes.get("si");
        if (formulaRange !== undefined)
          groups.push({
            bounds: boundsOf(formulaRange),
            kind: formulaKind ?? "normal",
          });
      }
      if (node.local === "v" && node.parent === "c")
        value = xml.slice(node.openEnd, node.closeStart);
      if (node.local === "c" && node.parent === "row") {
        const reference = node.attributes.get("r");
        if (reference === undefined || row === undefined)
          refuse("Editing requires explicit cell and row coordinates.");
        const coordinate = parseCellRef(reference);
        if (coordinate.row !== Number(row.attributes.get("r")))
          refuse("A cell is stored outside its declared row.");
        const key = keyOf(coordinate.row, coordinate.column);
        if (cells.has(key)) refuse("The sheet contains duplicate cells.");
        count += 1;
        if (count > authoringLimits.maxCells)
          budget("The sheet exceeds the stored-cell budget.");
        cells.set(key, {
          raw: xml.slice(node.start, node.end),
          style: node.attributes.get("s"),
          formula,
          formulaKind,
          formulaRange,
          sharedIndex,
          value,
          type: node.attributes.get("t"),
          protectedMetadata:
            unsupportedCell ||
            node.attributes.has("vm") ||
            node.attributes.has("cm"),
          bindings: node.namespaces,
        });
        rowCells.push({
          start: node.start - row.start,
          end: node.end - row.start,
        });
      }
      if (node.local === "row" && node.parent === "sheetData") {
        const number = Number(node.attributes.get("r"));
        checked(number, 1);
        if (!Number.isInteger(number) || rows.has(number))
          refuse("The sheet contains invalid or duplicate row coordinates.");
        rows.set(number, {
          raw: xml.slice(node.start, node.end),
          span: {
            ...node,
            start: 0,
            openEnd: node.openEnd - node.start,
            closeStart: node.closeStart - node.start,
            end: node.end - node.start,
          },
          cells: rowCells,
        });
        row = undefined;
      }
      if (node.local === "sheetData") {
        if (data !== undefined)
          refuse("The sheet contains duplicate sheetData elements.");
        data = node;
      }
      if (node.depth === 0) root = node;
    },
    (node) => {
      if (
        node.parent === "c" &&
        (node.uri !== main || !["f", "v", "is"].includes(node.local))
      )
        unsupportedCell = true;
      if (node.uri !== main) return;
      if (node.local === "row" && node.parent === "sheetData") {
        row = node;
        rowCells = [];
      }
      if (node.local === "c" && node.parent === "row") {
        formula = undefined;
        formulaKind = undefined;
        formulaRange = undefined;
        sharedIndex = undefined;
        value = undefined;
        unsupportedCell = [...node.attributes.keys()].some(
          (name) => name.includes(":") && name !== "xml:space",
        );
      }
    },
  );
  if (root === undefined || data === undefined || root.local !== "worksheet")
    refuse("The selected part is not an editable worksheet.");
  return { xml, root, data, rows, cells, groups };
}

export function renderGrid(grid: Grid): string {
  const grouped = new Map<number, [number, Cell][]>();
  for (const [key, cell] of grid.cells) {
    const row = rowOf(key);
    const entries = grouped.get(row) ?? [];
    entries.push([columnOf(key), cell]);
    grouped.set(row, entries);
  }
  const prefix = grid.data.qname.includes(":")
    ? grid.data.qname.slice(0, grid.data.qname.indexOf(":") + 1)
    : "";
  const rows: string[] = [];
  for (const number of [
    ...new Set([...grid.rows.keys(), ...grouped.keys()]),
  ].sort((a, b) => a - b)) {
    const contents = (grouped.get(number) ?? [])
      .sort(([a], [b]) => a - b)
      .map(([column, cell]) =>
        attribute(cell.raw, "r", formatCellRef(number, column)),
      )
      .join("");
    const original = grid.rows.get(number);
    if (original === undefined) {
      if (contents !== "")
        rows.push(`<${prefix}row r="${number}">${contents}</${prefix}row>`);
      continue;
    }
    const patches: XmlPatch[] = original.cells.map((span, index) => ({
      ...span,
      text: index === 0 ? contents : "",
    }));
    if (patches.length === 0) {
      const body = original.raw.slice(
        original.span.openEnd,
        original.span.closeStart,
      );
      rows.push(
        attribute(
          replaceElementBody(original.raw, original.span, contents + body),
          "r",
          String(number),
        ),
      );
    } else {
      let raw = attribute(
        applyXmlPatches(original.raw, patches),
        "r",
        String(number),
      );
      if (original.span.attributes.has("spans")) {
        const columns = (grouped.get(number) ?? []).map(([column]) => column);
        raw = attribute(
          raw,
          "spans",
          columns.length
            ? `${Math.min(...columns)}:${Math.max(...columns)}`
            : undefined,
        );
      }
      rows.push(raw);
    }
  }
  const patches: XmlPatch[] = [
    {
      start: grid.data.start,
      end: grid.data.end,
      text: replaceElementBody(grid.xml, grid.data, rows.join("")),
    },
  ];
  {
    let top = grid.cells.size ? maxRow : 1,
      left = grid.cells.size ? maxColumn : 1,
      bottom = 1,
      right = 1;
    for (const key of grid.cells.keys()) {
      top = Math.min(top, rowOf(key));
      bottom = Math.max(bottom, rowOf(key));
      left = Math.min(left, columnOf(key));
      right = Math.max(right, columnOf(key));
    }
    scanXml(grid.xml, "worksheet", (node) => {
      if (node.uri === main && node.local === "dimension")
        patches.push({
          start: node.start,
          end: node.end,
          text: attribute(
            grid.xml.slice(node.start, node.end),
            "ref",
            `${formatCellRef(top, left)}:${formatCellRef(bottom, right)}`,
          ),
        });
    });
  }
  return applyXmlPatches(grid.xml, patches);
}

export function rewriteCell(
  cell: Cell | undefined,
  reference: string,
  content: string,
  type: string | undefined,
  style?: string,
): string {
  if (cell?.protectedMetadata)
    refuse("The edited cell carries unsupported rich or shared metadata.");
  let raw = cell?.raw ?? `<c xmlns="${main}" r="${reference}"></c>`;
  const wrapped = `<root xmlns="${main}"${[...(cell?.bindings ?? [])]
    .filter(([prefix]) => prefix !== "")
    .map(([prefix, uri]) => ` xmlns:${prefix}="${xmlEscape(uri)}"`)
    .join("")}>${raw}</root>`;
  const patches: XmlPatch[] = [];
  let span: XmlSpan | undefined;
  scanXml(wrapped, "cell", (node) => {
    if (node.local === "c" && node.uri === main && node.depth === 1)
      span = node;
    if (
      node.uri === main &&
      node.parent === "c" &&
      ["f", "v", "is"].includes(node.local)
    )
      patches.push({ start: node.start, end: node.end, text: "" });
  });
  if (span === undefined) refuse("The source cell cannot be preserved.");
  const cleaned = applyXmlPatches(wrapped, patches);
  raw = cleaned.slice(cleaned.indexOf(">") + 1, cleaned.lastIndexOf("</root>"));
  const close = raw.lastIndexOf("</");
  if (close === -1)
    raw = raw.replace(/\/\s*>$/, ">") + content + `</${span.qname}>`;
  else raw = raw.slice(0, close) + content + raw.slice(close);
  raw = attribute(attribute(raw, "t", type), "r", reference);
  if (style !== undefined) raw = attribute(raw, "s", style);
  return raw;
}

export interface PreservedEditResult {
  readonly bytes: Buffer;
  readonly changes: MutationReceipt["changes"];
  readonly editing: Required<NonNullable<MutationReceipt["editing"]>>;
}

export class PreservedWorkbook {
  readonly parts = new Map<string, Uint8Array>();
  readonly changes = { sheetsAdded: 0, blocksWritten: 0, cellsWritten: 0 };
  private cleared = 0;
  private touched = 0;
  private needsCalculation = false;
  private readonly featureRefresh = new Set<"charts" | "pivots">();
  private readonly featureFreshness = new Map<string, string>();
  private readonly originalBytes: Buffer;
  private formattingChanged = false;
  private cachedFormulaValues = 0;
  private readonly presentation = {
    cellsFormatted: 0,
    formulasWritten: 0,
    mergedValuesCleared: 0,
    tablesChanged: 0,
  };
  private sequence = 0;
  private readonly styleCache = new Map<string, string>();
  private formats: ReturnType<typeof readNumberFormats> | undefined;
  private readonly calendarStyles = new Map<string, boolean>();
  private readonly stringBindings = new Map<
    number,
    ReadonlyMap<string, string>
  >();
  private sharedCache: string[] | undefined;
  private readonly original: ReadonlyMap<string, Uint8Array>;

  constructor(bytes: Buffer) {
    this.originalBytes = bytes;
    const opc = openOpcPackage(zipSource(bytes));
    if (
      opc.parts.reduce((total, part) => total + part.sizeBytes, 0) >
      512 * 1024 * 1024
    )
      budget("The retained package exceeds the editing byte budget.");
    for (const entry of opc.parts) {
      const bytes = opc.partBytes(entry.path);
      if (bytes === undefined) refuse("A package part disappeared.");
      this.parts.set(entry.path, bytes);
    }
    this.original = new Map(this.parts);
  }
  opc(): OpcPackage {
    return openOpcPackage({
      entries: [...this.parts].map(([path, bytes]) => ({
        path,
        sizeBytes: bytes.byteLength,
      })),
      read: (path) => this.parts.get(path),
    });
  }
  xml(part: string): string {
    const bytes = this.parts.get(part);
    if (bytes === undefined) refuse("A required package part is absent.");
    if (
      bytes[0] === 0xff ||
      bytes[0] === 0xfe ||
      bytes[0] === 0 ||
      bytes[1] === 0
    )
      refuse(
        "Editing UTF-16 parts is unsupported; the original has not been changed.",
      );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  put(part: string, xml: string): void {
    if (Buffer.byteLength(xml) > 384 * 1024 * 1024)
      budget("An edited XML part exceeds its byte budget.");
    this.parts.set(part, Buffer.from(xml));
  }
  workbookPart(): string {
    const entry = [...this.opc().packageRelationships.values()].find(
      (entry) =>
        entry.kind === "internal" && entry.type === `${office}/officeDocument`,
    );
    if (entry?.kind !== "internal")
      refuse("No editable workbook entry point exists.");
    return entry.target;
  }
  sheets(): {
    name: string;
    part: string;
    id: string;
    relationship: string;
    state: string;
    span: XmlSpan;
  }[] {
    const part = this.workbookPart();
    const rels = this.opc().relationshipsFor(part);
    const result: ReturnType<PreservedWorkbook["sheets"]> = [];
    scanXml(this.xml(part), part, (node) => {
      if (
        node.uri !== main ||
        node.local !== "sheet" ||
        node.parent !== "sheets"
      )
        return;
      const name = node.attributes.get("name");
      const relationship = [...node.attributes].find(([name]) =>
        name.endsWith(":id"),
      )?.[1];
      const target =
        relationship === undefined ? undefined : rels.get(relationship);
      if (
        name === undefined ||
        relationship === undefined ||
        target?.kind !== "internal"
      )
        refuse("A sheet has an invalid identity.");
      result.push({
        name: unescapeXstring(name),
        part: target.target,
        id: node.attributes.get("sheetId") ?? "",
        relationship,
        state: node.attributes.get("state") ?? "visible",
        span: node,
      });
    });
    return result;
  }
  sheet(name: string) {
    const found = this.sheets().filter(
      (sheet) => canonical(sheet.name) === canonical(name),
    );
    if (found.length > 1)
      throw new SezzleeExcelError(
        "ambiguous_sheet",
        "The selected sheet is ambiguous.",
      );
    const result = found[0];
    if (result === undefined)
      throw new SezzleeExcelError(
        "unknown_sheet",
        "The selected sheet does not exist.",
      );
    return result;
  }
  private touch(count: number): void {
    this.touched += count;
    if (this.touched > authoringLimits.maxCells)
      budget("The transaction exceeds 1,000,000 touched cells.");
  }
  presentationEffect(
    kind:
      | "format"
      | "formula"
      | "merge"
      | "table"
      | "layout"
      | "visibility"
      | "name",
    cells: number,
    cleared = 0,
  ): void {
    this.touch(cells);
    if (kind === "format" || kind === "layout") this.formattingChanged = true;
    if (kind === "visibility" || kind === "name") this.needsCalculation = true;
    if (kind === "format") {
      this.presentation.cellsFormatted += cells;
      this.formats = undefined;
      this.calendarStyles.clear();
      this.styleCache.clear();
    } else if (kind === "formula") {
      this.presentation.formulasWritten += cells;
      this.changes.cellsWritten += cells;
      this.changes.blocksWritten += 1;
      this.needsCalculation = true;
    } else if (kind === "merge") {
      this.presentation.mergedValuesCleared += cleared;
      this.cleared += cleared;
      if (cleared > 0) this.needsCalculation = true;
    } else if (kind === "table") {
      this.presentation.tablesChanged += 1;
      this.needsCalculation = true;
    }
  }
  requireFeatureRefresh(kind: "charts" | "pivots"): void {
    this.featureRefresh.add(kind);
  }
  markFeatureCurrent(part: string): void {
    const signature = this.featureSourceSignature(part);
    if (signature !== undefined) this.featureFreshness.set(part, signature);
  }
  private featureSourceSignature(part: string): string | undefined {
    if (!this.parts.has(part)) return undefined;
    const sources: { sheet: string; range: string }[] = [];
    const xml = this.xml(part);
    let unsupported = false;
    scanXml(xml, part, (node) => {
      if (node.uri === namespaces.chart && node.local === "f") {
        const ref = xmlUnescape(xml.slice(node.openEnd, node.closeStart));
        const match =
          /^(?:'((?:[^']|'')+)'|([^'![\]]+))!([A-Za-z$0-9:]+)$/.exec(ref);
        const sheet = match?.[1]?.replace(/''/g, "'") ?? match?.[2],
          range = match?.[3]?.replace(/\$/g, "");
        if (sheet === undefined || range === undefined) unsupported = true;
        else sources.push({ sheet, range });
      }
      if (node.uri === main && node.local === "worksheetSource") {
        const sheet = node.attributes.get("sheet"),
          range = node.attributes.get("ref");
        if (sheet === undefined || range === undefined) unsupported = true;
        else sources.push({ sheet, range });
      }
    });
    if (unsupported || sources.length === 0) return undefined;
    try {
      const data = sources.map((source) =>
        featureData(this, source.sheet, source.range),
      );
      if (
        data.some((grid) =>
          grid.some((row) => row.some((cell) => cell.kind === "formula")),
        )
      )
        return undefined;
      return JSON.stringify({ sources, data });
    } catch (error) {
      if (error instanceof SezzleeExcelError) return undefined;
      throw error;
    }
  }
  guardPresentation(sheetName: string, bounds: GridBounds): void {
    const part = this.sheet(sheetName).part;
    this.guarded(gridOf(this.xml(part), part), bounds);
  }
  reservePresentationCells(additional: number): void {
    if (additional <= 0) return;
    let stored = additional;
    for (const sheet of this.sheets())
      scanXml(this.xml(sheet.part), sheet.part, (node) => {
        if (
          node.uri === main &&
          node.local === "c" &&
          ++stored > authoringLimits.maxCells
        )
          budget("The proposed expansion exceeds 1,000,000 stored cells.");
      });
    if (stored > authoringLimits.maxCells)
      budget("The proposed expansion exceeds 1,000,000 stored cells.");
  }
  private uniqueName(name: string): void {
    if (
      this.sheets().some(
        (sheet) => fold(canonical(sheet.name)) === fold(canonical(name)),
      )
    )
      refuse("A sheet with this name already exists.");
    if (this.sheets().length >= authoringLimits.maxSheets)
      budget("The workbook exceeds its sheet budget.");
  }
  private append(
    part: string,
    local: string,
    content: string,
    count?: number,
  ): void {
    const xml = this.xml(part);
    let owner: XmlSpan | undefined;
    scanXml(xml, part, (node) => {
      if (node.uri === main && node.local === local) owner = node;
    });
    if (owner === undefined)
      refuse(`The source has no supported ${local} container.`);
    let replacement = replaceElementBody(
      xml,
      owner,
      xml.slice(owner.openEnd, owner.closeStart) + content,
    );
    if (count !== undefined)
      replacement = attribute(replacement, "count", String(count));
    this.put(
      part,
      applyXmlPatches(xml, [
        { start: owner.start, end: owner.end, text: replacement },
      ]),
    );
  }
  private type(part: string, type: string): void {
    const xml = this.xml("[Content_Types].xml");
    let root: XmlSpan | undefined;
    scanXml(xml, "[Content_Types].xml", (node) => {
      if (node.depth === 0) root = node;
    });
    if (root === undefined) refuse("No content-type root exists.");
    this.put(
      "[Content_Types].xml",
      applyXmlPatches(xml, [
        {
          start: root.start,
          end: root.end,
          text: replaceElementBody(
            xml,
            root,
            xml.slice(root.openEnd, root.closeStart) +
              `<Override xmlns="${namespaces.contentTypes}" PartName="/${xmlEscape(part)}" ContentType="${xmlEscape(type)}"/>`,
          ),
        },
      ]),
    );
  }
  private allocate(source: string): string {
    const slash = source.lastIndexOf("/");
    const dot = source.lastIndexOf(".");
    for (;;) {
      const candidate = `${source.slice(0, slash + 1)}sezzlee-copy-${++this.sequence}${dot > slash ? source.slice(dot) : ".xml"}`;
      if (!this.parts.has(candidate)) return candidate;
    }
  }
  private addSheet(name: string, existingPart?: string): string {
    this.uniqueName(name);
    const workbook = this.workbookPart();
    const relPart = relationshipsPathFor(workbook);
    const rels = this.xml(relPart);
    const part =
      existingPart ??
      this.allocate(
        `${workbook.slice(0, workbook.lastIndexOf("/") + 1)}worksheets/sheet.xml`,
      );
    const ids = new Set(this.opc().relationshipsFor(workbook).keys());
    let id = 1;
    while (ids.has(`rId${id}`)) id += 1;
    const sheets = this.sheets();
    const sheetId = Math.max(0, ...sheets.map((sheet) => Number(sheet.id))) + 1;
    if (!Number.isSafeInteger(sheetId))
      refuse("The source sheet identifiers cannot be safely extended.");
    let root: XmlSpan | undefined;
    scanXml(rels, relPart, (node) => {
      if (node.depth === 0) root = node;
    });
    if (root === undefined) refuse("The workbook relationships have no root.");
    const directory = workbook.slice(0, workbook.lastIndexOf("/") + 1);
    const target = part.startsWith(directory)
      ? part.slice(directory.length)
      : "/" + part;
    this.put(
      relPart,
      applyXmlPatches(rels, [
        {
          start: root.start,
          end: root.end,
          text: replaceElementBody(
            rels,
            root,
            rels.slice(root.openEnd, root.closeStart) +
              `<Relationship xmlns="${namespaces.packageRelationships}" Id="rId${id}" Type="${office}/worksheet" Target="${xmlEscape(target)}"/>`,
          ),
        },
      ]),
    );
    this.append(
      workbook,
      "sheets",
      `<sheet xmlns="${main}" xmlns:r="${office}" name="${xmlEscape(name)}" sheetId="${sheetId}" r:id="rId${id}"/>`,
    );
    if (existingPart === undefined) {
      this.put(part, `<worksheet xmlns="${main}"><sheetData/></worksheet>`);
      this.type(
        part,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
      );
    }
    this.changes.sheetsAdded += 1;
    return part;
  }
  private guarded(grid: Grid, bounds: GridBounds): void {
    for (const group of grid.groups) {
      if (
        bounds.top <= group.bounds.bottom &&
        bounds.bottom >= group.bounds.top &&
        bounds.left <= group.bounds.right &&
        bounds.right >= group.bounds.left
      )
        refuse(
          "The edit intersects an existing array or shared-formula group; this operation cannot preserve that group.",
        );
    }
    scanXml(grid.xml, "worksheet", (node) => {
      if (node.uri === main && node.local === "mergeCell") {
        const ref = node.attributes.get("ref");
        if (ref === undefined) refuse("A merge has no range.");
        const merge = boundsOf(ref);
        const intersects =
          bounds.top <= merge.bottom &&
          bounds.bottom >= merge.top &&
          bounds.left <= merge.right &&
          bounds.right >= merge.left;
        if (
          intersects &&
          !(
            bounds.top <= merge.top &&
            bounds.bottom >= merge.bottom &&
            bounds.left <= merge.left &&
            bounds.right >= merge.right
          )
        )
          refuse("The edit intersects only part of a merged range.");
      }
    });
  }
  private merges(grid: Grid): GridBounds[] {
    const result: GridBounds[] = [];
    scanXml(grid.xml, "worksheet", (node) => {
      if (node.uri === main && node.local === "mergeCell")
        result.push(boundsOf(node.attributes.get("ref") ?? ""));
    });
    return result;
  }
  private changeMerges(
    part: string,
    removed: readonly GridBounds[],
    added: readonly GridBounds[],
  ): void {
    if (removed.length === 0 && added.length === 0) return;
    const xml = this.xml(part);
    let container: XmlSpan | undefined;
    let root: XmlSpan | undefined;
    const patches: XmlPatch[] = [];
    let existing = 0;
    scanXml(xml, part, (node) => {
      if (node.depth === 0) root = node;
      if (node.uri !== main) return;
      if (node.local === "mergeCells") container = node;
      if (node.local === "mergeCell") {
        const ref = boundsOf(node.attributes.get("ref") ?? "");
        if (
          removed.some(
            (item) =>
              item.top === ref.top &&
              item.left === ref.left &&
              item.bottom === ref.bottom &&
              item.right === ref.right,
          )
        )
          patches.push({ start: node.start, end: node.end, text: "" });
        else existing += 1;
      }
    });
    const prefix =
      container !== undefined && container.qname.includes(":")
        ? container.qname.slice(0, container.qname.indexOf(":") + 1)
        : "";
    const content = added
      .map(
        (bounds) =>
          `<${prefix}mergeCell ref="${formatCellRef(bounds.top, bounds.left)}:${formatCellRef(bounds.bottom, bounds.right)}"/>`,
      )
      .join("");
    if (container !== undefined) {
      const owner = container;
      const body =
        applyXmlPatches(
          xml.slice(owner.openEnd, owner.closeStart),
          patches.map((patch) => ({
            ...patch,
            start: patch.start - owner.openEnd,
            end: patch.end - owner.openEnd,
          })),
        ) + content;
      this.put(
        part,
        applyXmlPatches(xml, [
          {
            start: owner.start,
            end: owner.end,
            text:
              existing + added.length === 0
                ? ""
                : attribute(
                    replaceElementBody(xml, owner, body),
                    "count",
                    String(existing + added.length),
                  ),
          },
        ]),
      );
    } else if (root !== undefined && added.length) {
      let insertion = root.closeStart;
      const later = new Set([
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
      ]);
      scanXml(xml, part, (node) => {
        if (node.depth === 1 && node.uri === main && later.has(node.local))
          insertion = Math.min(insertion, node.start);
      });
      this.put(
        part,
        applyXmlPatches(xml, [
          {
            start: insertion,
            end: insertion,
            text: `<mergeCells count="${added.length}" xmlns="${main}">${content}</mergeCells>`,
          },
        ]),
      );
    }
  }
  private calendarStyle(style: string | undefined): boolean {
    if (style === undefined) return false;
    const cached = this.calendarStyles.get(style);
    if (cached !== undefined) return cached;
    const opc = this.opc();
    const relationship = [
      ...opc.relationshipsFor(this.workbookPart()).values(),
    ].find((entry) => entry.type === `${office}/styles`);
    this.formats ??= readNumberFormats({
      scanPart: opc.scanPart,
      stylesPart:
        relationship?.kind === "internal" ? relationship.target : undefined,
    });
    const calendar = isDateFormat(this.formats.formatOf(Number(style)));
    this.calendarStyles.set(style, calendar);
    return calendar;
  }
  private valueStyle(
    kind: "date" | "datetime" | "number",
    original?: string,
  ): string {
    const key = `${kind}:${original ?? "0"}`;
    const cached = this.styleCache.get(key);
    if (cached !== undefined) return cached;
    const opc = this.opc();
    const part = [...opc.relationshipsFor(this.workbookPart()).values()].find(
      (rel) => rel.kind === "internal" && rel.type === `${office}/styles`,
    );
    if (part?.kind !== "internal")
      refuse(
        "Date writing requires a styles part; export to a new workbook instead.",
      );
    const xml = this.xml(part.target);
    const xfs: string[] = [];
    let container: XmlSpan | undefined;
    scanXml(xml, part.target, (node) => {
      if (node.uri !== main) return;
      if (node.local === "xf" && node.parent === "cellXfs")
        xfs.push(xml.slice(node.start, node.end));
      if (node.local === "cellXfs") container = node;
    });
    const base = xfs[Number(original ?? "0")];
    if (base === undefined || container === undefined)
      refuse("The target style cannot be preserved.");
    const desired = attribute(
      attribute(
        base,
        "numFmtId",
        kind === "number" ? "0" : kind === "date" ? "14" : "22",
      ),
      "applyNumberFormat",
      "1",
    );
    const existing = xfs.indexOf(desired);
    if (existing !== -1) {
      this.styleCache.set(key, String(existing));
      return String(existing);
    }
    this.append(part.target, "cellXfs", desired, xfs.length + 1);
    this.styleCache.set(key, String(xfs.length));
    this.calendarStyles.set(String(xfs.length), kind !== "number");
    return String(xfs.length);
  }
  private tableHeaders(sheetName: string): Map<number, string> {
    const sheet = this.sheet(sheetName),
      headers = new Map<number, string>();
    for (const relation of this.opc().relationshipsFor(sheet.part).values()) {
      if (relation.kind !== "internal" || relation.type !== `${office}/table`)
        continue;
      const xml = this.xml(relation.target);
      let bounds: GridBounds | undefined,
        headerRows = 1;
      scanXml(xml, relation.target, (node) => {
        if (node.uri === main && node.local === "table") {
          bounds = boundsOf(node.attributes.get("ref") ?? "");
          headerRows = Number(node.attributes.get("headerRowCount") ?? 1);
        }
      });
      if (bounds === undefined || headerRows !== 1) continue;
      const top = bounds.top,
        left = bounds.left;
      let column = 0;
      scanXml(xml, relation.target, (node) => {
        if (
          node.uri === main &&
          node.local === "tableColumn" &&
          node.parent === "tableColumns"
        ) {
          const name = node.attributes.get("name"),
            key = keyOf(top, left + column++);
          if (name === undefined || headers.has(key))
            refuse("The table header identity is invalid or overlapping.");
          headers.set(key, name);
        }
      });
    }
    return headers;
  }
  private write(
    sheetName: string,
    startCell: string,
    values: readonly (readonly WriteCell[])[],
    overwrite: boolean,
  ): void {
    const part = this.sheet(sheetName).part;
    const grid = gridOf(this.xml(part), part);
    const start = parseCellRef(startCell);
    const width = values[0]?.length ?? 0;
    const bounds = {
      top: start.row,
      left: start.column,
      bottom: start.row + values.length - 1,
      right: start.column + width - 1,
    };
    checked(bounds.bottom, bounds.right);
    this.touch(values.length * width);
    this.guarded(grid, bounds);
    const tableHeaders = this.tableHeaders(sheetName);
    this.reservePresentationCells(
      values.length * width -
        [...grid.cells.keys()].filter((key) =>
          inside(bounds, rowOf(key), columnOf(key)),
        ).length,
    );
    const merges = this.merges(grid);
    for (const [row, entries] of values.entries())
      for (const [column, value] of entries.entries()) {
        const key = keyOf(start.row + row, start.column + column);
        const cell = grid.cells.get(key);
        const header = tableHeaders.get(key);
        if (
          header !== undefined &&
          (value.kind !== "text" || value.value !== header)
        )
          refuse(
            "Use edit_table columns to rename an Excel table header; scalar writes cannot desynchronize its column identity.",
          );
        if (
          value.kind !== "blank" &&
          merges.some(
            (merge) =>
              inside(merge, start.row + row, start.column + column) &&
              (merge.top !== start.row + row ||
                merge.left !== start.column + column),
          )
        )
          refuse("Writing a non-anchor merged cell would hide its value.");
        if (
          !overwrite &&
          cell !== undefined &&
          (cell.formula !== undefined ||
            cell.value !== undefined ||
            cell.type === "inlineStr" ||
            cell.type === "s")
        )
          occupiedTarget(
            sheetName,
            formatCellRef(start.row + row, start.column + column),
          );
        const prefix = cell?.raw.match(/^<([^\s/>]+:)?c/)?.[1] ?? "";
        let body = "";
        let type: string | undefined;
        let style = cell?.style;
        switch (value.kind) {
          case "blank":
            break;
          case "text":
            type = "inlineStr";
            body = `<${prefix}is><${prefix}t xml:space="preserve">${literal(value.value)}</${prefix}t></${prefix}is>`;
            break;
          case "number":
            type = "n";
            if (this.calendarStyle(style))
              style = this.valueStyle("number", style);
            body = `<${prefix}v>${value.value}</${prefix}v>`;
            break;
          case "boolean":
            type = "b";
            body = `<${prefix}v>${value.value ? 1 : 0}</${prefix}v>`;
            break;
          case "date":
          case "datetime":
            type = "d";
            style = this.valueStyle(value.kind, style);
            body = `<${prefix}v>${isoWrite(value)}</${prefix}v>`;
            break;
          default: {
            const exhaustive: never = value;
            return exhaustive;
          }
        }
        const raw = rewriteCell(
          cell,
          formatCellRef(start.row + row, start.column + column),
          body,
          type,
          style,
        );
        grid.cells.set(key, {
          raw,
          style,
          formula: undefined,
          formulaKind: undefined,
          formulaRange: undefined,
          sharedIndex: undefined,
          value:
            value.kind === "blank"
              ? undefined
              : String("value" in value ? value.value : ""),
          type,
          protectedMetadata: false,
          bindings: cell?.bindings ?? new Map([["", main]]),
        });
      }
    this.put(part, renderGrid(grid));
    this.changes.blocksWritten += 1;
    this.changes.cellsWritten += values.length * width;
    this.needsCalculation = true;
  }
  private clear(sheetName: string, range: string): void {
    const clearBounds = boundsOf(range);
    if (
      [...this.tableHeaders(sheetName).keys()].some((key) =>
        inside(clearBounds, rowOf(key), columnOf(key)),
      )
    )
      refuse(
        "Clearing table headers would invalidate column identities; convert the table or rename its columns explicitly.",
      );
    const part = this.sheet(sheetName).part;
    const grid = gridOf(this.xml(part), part);
    const bounds = boundsOf(range);
    this.touch(
      (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1),
    );
    this.guarded(grid, bounds);
    for (const [key, cell] of grid.cells)
      if (inside(bounds, rowOf(key), columnOf(key))) {
        grid.cells.set(key, {
          ...cell,
          raw: rewriteCell(
            cell,
            formatCellRef(rowOf(key), columnOf(key)),
            "",
            undefined,
          ),
          value: undefined,
          type: undefined,
          formula: undefined,
        });
        this.cleared += 1;
      }
    this.put(part, renderGrid(grid));
    this.needsCalculation = true;
  }

  apply(
    changes: readonly EditChange[],
    sources: ReadonlyMap<number, Buffer> = new Map(),
  ): void {
    for (const [index, change] of changes.entries()) {
      guardCurrentProtection(this, change);
      if (isPresentationChange(change)) {
        applyPresentationChange(this, change);
        continue;
      }
      const external = sources.get(index);
      if (
        external !== undefined &&
        (change.kind === "copy_sheet" || change.kind === "copy_range")
      ) {
        this.externalCopy(external, change);
        continue;
      }
      switch (change.kind) {
        case "add_sheet":
          this.addSheet(change.name);
          break;
        case "write_cells":
          this.write(
            change.sheetName,
            change.startCell,
            change.values,
            change.overwrite,
          );
          break;
        case "clear_contents":
          this.clear(change.sheetName, change.range);
          break;
        default:
          this.structural(change);
      }
    }
  }

  private structural(
    change: Exclude<
      EditChange,
      {
        kind:
          | "add_sheet"
          | "write_cells"
          | "clear_contents"
          | PresentationChange["kind"];
      }
    >,
  ): void {
    switch (change.kind) {
      case "copy_range":
        this.copyRange(
          change.sheetName,
          change.range,
          change.targetSheet,
          change.startCell,
          change.mode,
          change.overwrite,
          false,
        );
        break;
      case "move_range":
        this.copyRange(
          change.sheetName,
          change.range,
          change.targetSheet,
          change.startCell,
          "all",
          change.overwrite,
          true,
        );
        break;
      case "rename_sheet": {
        const sheet = this.sheet(change.sheetName);
        if (sheet.name === change.name) break;
        this.uniqueName(change.name);
        this.guardDependencies(false);
        this.references((ref) =>
          ref.qualified && canonical(ref.sheet ?? "") === canonical(sheet.name)
            ? { ...ref, sheet: change.name }
            : ref,
        );
        const part = this.workbookPart();
        const xml = this.xml(part);
        const current = this.sheet(sheet.name);
        this.put(
          part,
          applyXmlPatches(xml, [
            {
              start: current.span.start,
              end: current.span.end,
              text: attribute(
                xml.slice(current.span.start, current.span.end),
                "name",
                change.name,
              ),
            },
          ]),
        );
        this.needsCalculation = true;
        break;
      }
      case "reorder_sheet": {
        const sheets = this.sheets();
        const sheet = this.sheet(change.sheetName);
        if (change.position > sheets.length)
          refuse("The requested sheet position exceeds the sheet count.");
        const ordered = sheets.filter(
          (entry) => entry.relationship !== sheet.relationship,
        );
        ordered.splice(change.position - 1, 0, sheet);
        this.reorder(ordered.map((entry) => entry.relationship));
        break;
      }
      case "delete_sheet":
        this.deleteSheet(change.sheetName);
        break;
      case "copy_sheet":
        this.copySheet(change.sheetName, change.name, change.mode);
        break;
      case "insert_rows":
      case "delete_rows":
      case "insert_columns":
      case "delete_columns":
        this.shift(
          change.sheetName,
          change.kind.endsWith("rows") ? "row" : "column",
          change.at,
          change.count,
          change.kind.startsWith("delete"),
        );
        break;
      default: {
        const exhaustive: never = change;
        return exhaustive;
      }
    }
  }

  private guardDependencies(positions: boolean): void {
    const opc = this.opc();
    for (const part of opc.parts) {
      const type = opc.contentTypes.contentTypeOf(part.path) ?? "";
      if (/pivot|externalLink|chartex|slicer|activeX|oleObject/i.test(type))
        refuse(
          "This structural operation affects an unsupported pivot, external-link, chart extension or embedded-object dependency.",
        );
      if (positions && /sheetMetadata|richData/i.test(type))
        refuse(
          "Position changes cannot preserve unsupported rich metadata dependencies.",
        );
      if (positions && (/vmlDrawing/i.test(type) || /\.vml$/i.test(part.path)))
        refuse("Position changes cannot preserve VML anchors.");
      if (
        /worksheet|chartsheet|\.chart\+xml|\.drawing\+xml|\.sheet.main\+xml/.test(
          type,
        )
      )
        scanXml(this.xml(part.path), part.path, (node) => {
          if (node.local === "extLst" || node.local === "AlternateContent")
            refuse(
              "This structural operation cannot preserve an affected extension dependency.",
            );
          if (
            node.uri === main &&
            node.local === "calcPr" &&
            node.attributes.get("refMode") === "R1C1"
          )
            refuse("Reference transformations require A1 reference mode.");
        });
    }
  }

  private owners(): Map<string, string> {
    const result = new Map<string, string>();
    const opc = this.opc();
    for (const sheet of this.sheets()) {
      const pending = [sheet.part];
      const seen = new Set<string>();
      while (pending.length) {
        const part = pending.pop();
        if (part === undefined || seen.has(part)) continue;
        seen.add(part);
        const prior = result.get(part);
        if (prior !== undefined && prior !== sheet.name) {
          result.set(part, "");
          continue;
        }
        result.set(part, sheet.name);
        for (const rel of opc.relationshipsFor(part).values())
          if (
            rel.kind === "internal" &&
            this.parts.has(rel.target) &&
            /\+xml$/.test(opc.contentTypes.contentTypeOf(rel.target) ?? "")
          )
            pending.push(rel.target);
      }
    }
    return result;
  }

  private references(
    map: ReferenceMapper,
    positional?: {
      sheet: string;
      axis: "row" | "column";
      at: number;
      count: number;
      deleting: boolean;
    },
    excludedOwners?: ReadonlySet<string>,
  ): void {
    const owners = this.owners();
    const sheets = this.sheets();
    const workbook = this.workbookPart();
    const opc = this.opc();
    for (const [part, bytes] of [...this.parts]) {
      const type = opc.contentTypes.contentTypeOf(part) ?? "";
      if (
        !/worksheet|chartsheet|\.table\+xml|\.chart\+xml|\.drawing\+xml|\.comments\+xml/.test(
          type,
        ) &&
        part !== workbook
      )
        continue;
      const xml = this.xml(part);
      const owner = owners.get(part) ?? "";
      if (excludedOwners?.has(owner)) continue;
      const patches: XmlPatch[] = [];
      scanXml(xml, part, (node) => {
        const spreadsheet = node.uri === main;
        const formula =
          (spreadsheet &&
            [
              "f",
              "formula",
              "formula1",
              "formula2",
              "definedName",
              "calculatedColumnFormula",
              "totalsRowFormula",
            ].includes(node.local)) ||
          (node.uri === namespaces.chart && node.local === "f");
        if (formula && node.closeStart > node.openEnd) {
          const context =
            node.local === "definedName" && node.attributes.has("localSheetId")
              ? (sheets[Number(node.attributes.get("localSheetId"))]?.name ??
                "")
              : owner;
          const original = xmlUnescape(
            xml.slice(node.openEnd, node.closeStart),
          );
          const transformed = transformFormula(original, context, map);
          if (transformed !== original)
            patches.push({
              start: node.openEnd,
              end: node.closeStart,
              text: xmlEscape(transformed),
            });
        }
        if (spreadsheet) {
          let header = xml.slice(node.start, node.openEnd);
          for (const name of [
            "ref",
            "sqref",
            "topLeftCell",
            "activeCell",
            "location",
          ]) {
            const value = node.attributes.get(name);
            if (
              value === undefined ||
              (name === "ref" && node.local === "dimension")
            )
              continue;
            const mapped = transformFormula(value, owner, (ref) => {
              const result = map(ref);
              if (
                result === "#REF!" &&
                positional !== undefined &&
                ["topLeftCell", "activeCell"].includes(name)
              )
                return { ...ref, [positional.axis]: positional.at };
              return result;
            });
            if (mapped.includes("#REF!"))
              refuse(
                "The structural operation would remove a dependent range; its object must be removed explicitly first.",
              );
            if (mapped !== value) header = attribute(header, name, mapped);
          }
          if (header !== xml.slice(node.start, node.openEnd))
            patches.push({
              start: node.start,
              end: node.openEnd,
              text: header,
            });
        }
        if (
          positional !== undefined &&
          owner === positional.sheet &&
          node.uri === namespaces.spreadsheetDrawing &&
          node.local === (positional.axis === "row" ? "row" : "col")
        ) {
          const original = Number(xml.slice(node.openEnd, node.closeStart));
          if (!Number.isInteger(original))
            refuse("A drawing anchor has no supported coordinate.");
          let mapped = original + 1;
          if (mapped >= positional.at)
            mapped = positional.deleting
              ? mapped < positional.at + positional.count
                ? positional.at
                : mapped - positional.count
              : mapped + positional.count;
          checked(
            positional.axis === "row" ? mapped : 1,
            positional.axis === "column" ? mapped : 1,
          );
          patches.push({
            start: node.openEnd,
            end: node.closeStart,
            text: String(mapped - 1),
          });
        }
      });
      if (patches.length) this.put(part, applyXmlPatches(xml, patches));
      void bytes;
    }
  }

  private reorder(ids: readonly string[]): void {
    const part = this.workbookPart();
    const xml = this.xml(part);
    const original = this.sheets();
    const patches: XmlPatch[] = [];
    for (const [index, sheet] of original.entries()) {
      const selected = original.find(
        (entry) => entry.relationship === ids[index],
      );
      if (selected === undefined)
        refuse("The requested sheet order is invalid.");
      patches.push({
        start: sheet.span.start,
        end: sheet.span.end,
        text: xml.slice(selected.span.start, selected.span.end),
      });
    }
    scanXml(xml, part, (node) => {
      if (node.uri !== main) return;
      if (node.local === "definedName" && node.attributes.has("localSheetId")) {
        const old = original[Number(node.attributes.get("localSheetId"))];
        if (old === undefined)
          refuse("A defined name has an invalid sheet scope.");
        patches.push({
          start: node.start,
          end: node.openEnd,
          text: attribute(
            xml.slice(node.start, node.openEnd),
            "localSheetId",
            String(ids.indexOf(old.relationship)),
          ),
        });
      }
      if (node.local === "workbookView") {
        let header = xml.slice(node.start, node.openEnd);
        for (const name of ["activeTab", "firstSheet"]) {
          const old = original[Number(node.attributes.get(name) ?? "0")];
          if (old !== undefined)
            header = attribute(
              header,
              name,
              String(ids.indexOf(old.relationship)),
            );
        }
        patches.push({ start: node.start, end: node.openEnd, text: header });
      }
    });
    this.put(part, applyXmlPatches(xml, patches));
  }

  private shift(
    name: string,
    axis: "row" | "column",
    at: number,
    count: number,
    deleting: boolean,
  ): void {
    const sheet = this.sheet(name);
    const maximum = axis === "row" ? maxRow : maxColumn;
    if (at + count - 1 > maximum)
      throw new SezzleeExcelError(
        "invalid_range",
        "The inserted/deleted interval exceeds worksheet bounds.",
      );
    this.guardDependencies(true);
    if (deleting && axis === "column")
      deleteTableColumnReferences(this, sheet.name, at, count);
    const tableUpdates: {
      part: string;
      columns: string;
      count: number;
      headers: { column: number; row: number; name: string }[];
    }[] = [];
    const affectedTables = new Set<string>();
    for (const relation of this.opc().relationshipsFor(sheet.part).values()) {
      if (relation.kind !== "internal" || relation.type !== `${office}/table`)
        continue;
      const xml = this.xml(relation.target);
      let bounds: GridBounds | undefined;
      let headerRows = 1,
        totalsRows = 0;
      const columns: { raw: string; id: number; name: string }[] = [];
      scanXml(xml, relation.target, (node) => {
        if (node.uri !== main) return;
        if (node.local === "table") {
          bounds = boundsOf(node.attributes.get("ref") ?? "");
          headerRows = Number(node.attributes.get("headerRowCount") ?? "1");
          totalsRows = Number(node.attributes.get("totalsRowCount") ?? "0");
        }
        if (node.local === "tableColumn")
          columns.push({
            raw: xml.slice(node.start, node.end),
            id: Number(node.attributes.get("id")),
            name: node.attributes.get("name") ?? "",
          });
      });
      if (
        bounds === undefined ||
        columns.length !== bounds.right - bounds.left + 1
      )
        refuse("The table column inventory cannot be preserved.");
      if (
        ![0, 1].includes(headerRows) ||
        ![0, 1].includes(totalsRows) ||
        columns.some(
          (column) => !Number.isSafeInteger(column.id) || column.id < 1,
        ) ||
        new Set(columns.map((column) => column.id)).size !== columns.length
      )
        refuse(
          "The table header, totals or column identity profile is unsupported.",
        );
      if (axis === "row") {
        if (at <= bounds.bottom) affectedTables.add(relation.target);
        if (
          deleting &&
          ((headerRows > 0 && at <= bounds.top && at + count > bounds.top) ||
            (totalsRows > 0 &&
              at <= bounds.bottom &&
              at + count > bounds.bottom))
        )
          refuse("Deleting a table header or totals row is unsupported.");
        continue;
      }
      const tableBounds = bounds;
      if (at <= bounds.right) affectedTables.add(relation.target);
      const first = tableBounds.left,
        last = tableBounds.right;
      const headers: { column: number; row: number; name: string }[] = [];
      let result = [...columns];
      if (deleting)
        result = result.filter(
          (_column, index) => first + index < at || first + index >= at + count,
        );
      else if (at > first && at <= last) {
        let id = Math.max(0, ...columns.map((column) => column.id));
        const names = new Set(columns.map((column) => fold(column.name)));
        const inserted = Array.from({ length: count }, (_value, index) => {
          let name = `Column${id + 1}`;
          while (names.has(fold(name))) name = `Column${++id + 1}`;
          names.add(fold(name));
          id += 1;
          if (headerRows > 0)
            headers.push({ row: tableBounds.top, column: at + index, name });
          return {
            id,
            name,
            raw: `<tableColumn xmlns="${main}" id="${id}" name="${xmlEscape(name)}"/>`,
          };
        });
        result.splice(at - first, 0, ...inserted);
      }
      if (result.length === 0)
        refuse("Deleting every column of a table is unsupported.");
      if (result.length !== columns.length)
        tableUpdates.push({
          part: relation.target,
          columns: result.map((column) => column.raw).join(""),
          count: result.length,
          headers,
        });
    }
    const grid = gridOf(this.xml(sheet.part), sheet.part);
    for (const group of grid.groups) {
      const start = axis === "row" ? group.bounds.top : group.bounds.left;
      const end = axis === "row" ? group.bounds.bottom : group.bounds.right;
      if (at <= end && at + (deleting ? count - 1 : 0) >= start)
        refuse(
          "The structural edit intersects a shared or array formula group.",
        );
    }
    const shifted = new Map<number, Cell>();
    for (const [key, cell] of grid.cells) {
      const position = axis === "row" ? rowOf(key) : columnOf(key);
      if (position < at) {
        shifted.set(key, cell);
        continue;
      }
      if (cell.protectedMetadata)
        refuse("The structural edit affects unsupported cell metadata.");
      this.touch(1);
      if (deleting && position < at + count) continue;
      const target = position + (deleting ? -count : count);
      const row = axis === "row" ? target : rowOf(key);
      const column = axis === "column" ? target : columnOf(key);
      checked(row, column);
      shifted.set(keyOf(row, column), {
        ...cell,
        raw: attribute(cell.raw, "r", formatCellRef(row, column)),
      });
    }
    grid.cells.clear();
    for (const [key, cell] of shifted) grid.cells.set(key, cell);
    if (axis === "row") {
      const rows = [...grid.rows];
      grid.rows.clear();
      for (const [number, row] of rows) {
        if (deleting && number >= at && number < at + count) continue;
        const target =
          number < at ? number : number + (deleting ? -count : count);
        checked(target, 1);
        grid.rows.set(target, row);
      }
    }
    this.put(sheet.part, renderGrid(grid));
    const map: ReferenceMapper = (ref) => {
      if (canonical(ref.sheet ?? "") !== canonical(sheet.name)) return ref;
      const position = ref[axis];
      if (position === undefined || position < at) return ref;
      if (deleting && position < at + count) {
        if (ref.boundary === "single") return "#REF!";
        return { ...ref, [axis]: ref.boundary === "start" ? at : at - 1 };
      }
      return { ...ref, [axis]: position + (deleting ? -count : count) };
    };
    this.references(map, { sheet: sheet.name, axis, at, count, deleting });
    for (const update of tableUpdates) {
      const xml = this.xml(update.part);
      let container: XmlSpan | undefined;
      scanXml(xml, update.part, (node) => {
        if (node.uri === main && node.local === "tableColumns")
          container = node;
      });
      if (container === undefined)
        refuse("The table column container is missing.");
      this.put(
        update.part,
        applyXmlPatches(xml, [
          {
            start: container.start,
            end: container.end,
            text: attribute(
              replaceElementBody(xml, container, update.columns),
              "count",
              String(update.count),
            ),
          },
        ]),
      );
      for (const header of update.headers)
        this.write(
          sheet.name,
          formatCellRef(header.row, header.column),
          [[{ kind: "text", value: header.name }]],
          false,
        );
    }
    const current = this.xml(sheet.part);
    const patches: XmlPatch[] = [];
    scanXml(current, sheet.part, (node) => {
      if (node.uri !== main) return;
      if (axis === "column" && node.local === "col") {
        const min = Number(node.attributes.get("min")),
          max = Number(node.attributes.get("max"));
        if (deleting && min >= at && max < at + count) {
          patches.push({ start: node.start, end: node.end, text: "" });
          return;
        }
        const mappedMin =
          min < at ? min : deleting ? Math.max(at, min - count) : min + count;
        const mappedMax =
          max < at
            ? max
            : deleting
              ? Math.max(at - 1, max - count)
              : max + count;
        checked(1, mappedMax);
        patches.push({
          start: node.start,
          end: node.openEnd,
          text: attribute(
            attribute(
              current.slice(node.start, node.openEnd),
              "min",
              String(mappedMin),
            ),
            "max",
            String(mappedMax),
          ),
        });
      }
      if (
        node.local === "pane" &&
        /frozen/.test(node.attributes.get("state") ?? "")
      ) {
        const name = axis === "row" ? "ySplit" : "xSplit";
        const split = Number(node.attributes.get(name) ?? "0");
        if (split >= at)
          patches.push({
            start: node.start,
            end: node.openEnd,
            text: attribute(
              current.slice(node.start, node.openEnd),
              name,
              String(
                deleting ? Math.max(at - 1, split - count) : split + count,
              ),
            ),
          });
      }
    });
    if (patches.length) this.put(sheet.part, applyXmlPatches(current, patches));
    syncTableFilterRanges(this, sheet.name, affectedTables);
    this.needsCalculation = true;
  }

  private copyRange(
    sourceName: string,
    range: string,
    targetName: string,
    startCell: string,
    mode: "values" | "formulas" | "formatting" | "all",
    overwrite: boolean,
    moving: boolean,
  ): void {
    if (mode === "formulas" || mode === "all" || moving)
      this.guardDependencies(moving);
    const source = this.sheet(sourceName),
      target = this.sheet(targetName);
    const sourceGrid = gridOf(this.xml(source.part), source.part);
    const targetGrid =
      source.part === target.part
        ? sourceGrid
        : gridOf(this.xml(target.part), target.part);
    const bounds = boundsOf(range),
      start = parseCellRef(startCell);
    const rowDelta = start.row - bounds.top,
      columnDelta = start.column - bounds.left;
    const destination = {
      top: start.row,
      left: start.column,
      bottom: bounds.bottom + rowDelta,
      right: bounds.right + columnDelta,
    };
    checked(destination.bottom, destination.right);
    this.touch(
      (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1),
    );
    if (
      source.part === target.part &&
      bounds.top <= destination.bottom &&
      bounds.bottom >= destination.top &&
      bounds.left <= destination.right &&
      bounds.right >= destination.left
    ) {
      if (rowDelta === 0 && columnDelta === 0) return;
      refuse("Overlapping source and destination ranges are unsupported.");
    }
    this.guarded(sourceGrid, bounds);
    this.guarded(targetGrid, destination);
    const sourceMerges = this.merges(sourceGrid).filter(
      (merge) =>
        bounds.top <= merge.top &&
        bounds.left <= merge.left &&
        bounds.bottom >= merge.bottom &&
        bounds.right >= merge.right,
    );
    const targetMerges = this.merges(targetGrid).filter(
      (merge) =>
        destination.top <= merge.top &&
        destination.left <= merge.left &&
        destination.bottom >= merge.bottom &&
        destination.right >= merge.right,
    );
    if (targetMerges.length && mode !== "all" && mode !== "formatting")
      refuse("A values/formulas copy cannot safely fill a merged destination.");
    if (mode === "formatting")
      for (const merge of sourceMerges)
        for (const [key, cell] of targetGrid.cells) {
          const row = rowOf(key) - rowDelta,
            column = columnOf(key) - columnDelta;
          if (
            inside(merge, row, column) &&
            (row !== merge.top || column !== merge.left) &&
            (cell.formula !== undefined ||
              cell.value !== undefined ||
              cell.type === "inlineStr" ||
              cell.type === "s")
          )
            refuse(
              "Copying this merged format would hide existing destination content.",
            );
        }
    const selected = new Map(
      [...sourceGrid.cells].filter(([key]) =>
        inside(bounds, rowOf(key), columnOf(key)),
      ),
    );
    if (!moving)
      this.reservePresentationCells(
        [...selected.keys()].filter(
          (key) =>
            !targetGrid.cells.has(
              keyOf(rowOf(key) + rowDelta, columnOf(key) + columnDelta),
            ),
        ).length,
      );
    if (mode === "formulas" || mode === "all")
      for (const [key, cell] of selected)
        if (cell.formula !== undefined)
          mapStructuredFormula(cell.formula, (ref) => {
            if (ref.rowContext) {
              resolveStructuredReference(
                this,
                ref,
                source.name,
                rowOf(key),
                columnOf(key),
              );
              resolveStructuredReference(
                this,
                ref,
                target.name,
                rowOf(key) + rowDelta,
                columnOf(key) + columnDelta,
              );
            }
            return ref.raw;
          });
    const strings = this.sharedStrings();
    for (let row = bounds.top; row <= bounds.bottom; row += 1)
      for (let column = bounds.left; column <= bounds.right; column += 1) {
        const cell = selected.get(keyOf(row, column));
        const key = keyOf(row + rowDelta, column + columnDelta);
        const prior = targetGrid.cells.get(key);
        const occupied =
          prior !== undefined &&
          (prior.formula !== undefined ||
            prior.value !== undefined ||
            prior.type === "inlineStr" ||
            prior.type === "s");
        if (mode !== "formatting" && occupied && !overwrite)
          occupiedTarget(
            targetName,
            formatCellRef(row + rowDelta, column + columnDelta),
          );
        if (cell?.protectedMetadata || prior?.protectedMetadata)
          refuse("Range copying cannot preserve rich cell metadata.");
        if (mode === "formatting") {
          const raw = attribute(
            prior?.raw ??
              `<c xmlns="${main}" r="${formatCellRef(row + rowDelta, column + columnDelta)}"/>`,
            "s",
            cell?.style,
          );
          targetGrid.cells.set(key, {
            ...(prior ?? {
              raw,
              formula: undefined,
              formulaKind: undefined,
              formulaRange: undefined,
              sharedIndex: undefined,
              value: undefined,
              type: undefined,
              protectedMetadata: false,
              bindings: new Map([["", main]]),
            }),
            raw,
            style: cell?.style,
          });
          continue;
        }
        if (cell === undefined) {
          if (prior !== undefined)
            targetGrid.cells.set(key, {
              ...prior,
              raw: attribute(
                rewriteCell(
                  prior,
                  formatCellRef(row + rowDelta, column + columnDelta),
                  "",
                  undefined,
                ),
                "s",
                mode === "all" ? undefined : prior.style,
              ),
              formula: undefined,
              value: undefined,
              type: undefined,
            });
          continue;
        }
        if (mode === "values" || mode === "formulas") {
          targetGrid.cells.set(
            key,
            this.contentCell(
              cell,
              formatCellRef(row + rowDelta, column + columnDelta),
              mode,
              source.name,
              prior,
              rowDelta,
              columnDelta,
            ),
          );
          continue;
        }
        let raw = cell.raw;
        for (const [prefix, uri] of cell.bindings)
          raw = attribute(
            raw,
            prefix === "" ? "xmlns" : `xmlns:${prefix}`,
            uri,
          );
        let formula = cell.formula;
        if (formula !== undefined) {
          formula = moving
            ? transformFormula(formula, source.name, (ref) => ref, target.name)
            : copyFormula(formula, source.name, rowDelta, columnDelta);
          const prefix = /^<([^\s/>]+:)?c/.exec(raw)?.[1] ?? "";
          raw = rewriteCell(
            { ...cell, raw },
            formatCellRef(row + rowDelta, column + columnDelta),
            `<${prefix}f>${xmlEscape(formula)}</${prefix}f>`,
            undefined,
          );
        }
        if (cell.type === "s" && formula === undefined) {
          const value = strings[Number(cell.value)];
          if (value === undefined)
            refuse("A shared-string reference is invalid.");
          const prefix = /^<([^\s/>]+:)?c/.exec(raw)?.[1] ?? "";
          for (const [prefix, uri] of this.stringBindings.get(
            Number(cell.value),
          ) ?? [])
            raw = attribute(
              raw,
              prefix === "" ? "xmlns" : `xmlns:${prefix}`,
              uri,
            );
          raw = rewriteCell(
            { ...cell, raw },
            formatCellRef(row + rowDelta, column + columnDelta),
            `<${prefix}is>${value}</${prefix}is>`,
            "inlineStr",
          );
        }
        targetGrid.cells.set(key, {
          ...cell,
          raw: attribute(
            raw,
            "r",
            formatCellRef(row + rowDelta, column + columnDelta),
          ),
          formula,
          style: cell.style,
        });
      }
    if (moving) {
      this.guardDependencies(true);
      for (const key of selected.keys()) sourceGrid.cells.delete(key);
      this.put(source.part, renderGrid(sourceGrid));
    }
    this.put(target.part, renderGrid(targetGrid));
    if (moving) this.changeMerges(source.part, sourceMerges, []);
    if (mode === "all" || mode === "formatting")
      this.changeMerges(
        target.part,
        targetMerges,
        sourceMerges.map((merge) => ({
          top: merge.top + rowDelta,
          bottom: merge.bottom + rowDelta,
          left: merge.left + columnDelta,
          right: merge.right + columnDelta,
        })),
      );
    if (moving) {
      let rangeStart: boolean | undefined;
      this.references((ref) => {
        const selected =
          canonical(ref.sheet ?? "") === canonical(source.name) &&
          ref.row !== undefined &&
          ref.column !== undefined &&
          inside(bounds, ref.row, ref.column);
        if (ref.boundary === "start") rangeStart = selected;
        if (
          ref.boundary === "end" &&
          rangeStart !== undefined &&
          selected !== rangeStart
        )
          refuse(
            "The move intersects only part of a dependent reference range.",
          );
        return selected && ref.row !== undefined && ref.column !== undefined
          ? {
              ...ref,
              sheet: target.name,
              row: ref.row + rowDelta,
              column: ref.column + columnDelta,
            }
          : ref;
      });
    }
    this.changes.blocksWritten += 1;
    this.changes.cellsWritten +=
      (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1);
    this.needsCalculation = mode !== "formatting" || this.needsCalculation;
  }

  private sharedStrings(): string[] {
    if (this.sharedCache !== undefined) return this.sharedCache;
    const rel = [
      ...this.opc().relationshipsFor(this.workbookPart()).values(),
    ].find((entry) => entry.type === `${office}/sharedStrings`);
    if (rel?.kind !== "internal") return [];
    const xml = this.xml(rel.target);
    const result: string[] = [];
    scanXml(xml, rel.target, (node) => {
      if (node.uri === main && node.local === "si") {
        this.stringBindings.set(result.length, node.namespaces);
        result.push(xml.slice(node.openEnd, node.closeStart));
      }
    });
    this.sharedCache = result;
    return result;
  }

  private contentCell(
    cell: Cell,
    reference: string,
    mode: "values" | "formulas",
    owner: string,
    prior?: Cell,
    rows = 0,
    columns = 0,
  ): Cell {
    if (cell.protectedMetadata || prior?.protectedMetadata)
      refuse("The selected contents carry unsupported cell metadata.");
    const prefix = prior?.raw.match(/^<([^\s/>]+:)?c/)?.[1] ?? "";
    let formula = cell.formula;
    let type = cell.type;
    let style = prior?.style;
    let value = cell.value;
    let body = "";
    if (formula !== undefined && mode === "formulas") {
      formula = copyFormula(formula, owner, rows, columns);
      type = undefined;
      body = `<${prefix}f>${xmlEscape(formula)}</${prefix}f>`;
      value = undefined;
    } else {
      if (formula !== undefined) {
        if (value === undefined)
          refuse("Values copying requires a saved formula result.");
        this.cachedFormulaValues += 1;
        formula = undefined;
      }
      if (type === "e" && mode === "values")
        refuse(
          "Values copying cannot export an error as a supported Phase 2 value.",
        );
      if (type === "s" || type === "inlineStr") {
        const contents =
          type === "s" ? this.sharedStrings()[Number(value)] : cell.raw;
        if (contents === undefined)
          refuse("The source shared string is missing.");
        const bindings =
          type === "s"
            ? (this.stringBindings.get(Number(value)) ?? cell.bindings)
            : cell.bindings;
        const wrapped = `<root xmlns="${main}"${[...bindings]
          .filter(([name]) => name !== "")
          .map(([name, uri]) => ` xmlns:${name}="${xmlEscape(uri)}"`)
          .join("")}>${contents}</root>`;
        let text = "";
        scanXml(wrapped, "copied-text", (node) => {
          if (node.uri === main && node.local === "t")
            text += unescapeXstring(
              xmlUnescape(wrapped.slice(node.openEnd, node.closeStart)),
            );
        });
        type = "inlineStr";
        value = text;
        body = `<${prefix}is><${prefix}t xml:space="preserve">${literal(text)}</${prefix}t></${prefix}is>`;
      } else if (value !== undefined) {
        if (
          (type === undefined || type === "n") &&
          this.calendarStyle(cell.style)
        ) {
          const code = this.formats?.formatOf(Number(cell.style)) ?? "General";
          if (
            isTimeOnlyFormat(code) ||
            numericFormat(code, Number(value))?.elapsed
          )
            refuse(
              "Time-only and duration values require an explicit supported transfer representation.",
            );
          let date1904 = false;
          scanXml(this.xml(this.workbookPart()), "workbook", (node) => {
            if (node.uri === main && node.local === "workbookPr")
              date1904 = ["1", "true"].includes(
                node.attributes.get("date1904") ?? "0",
              );
          });
          const instant = serialToDate(Number(value), date1904);
          if (instant === undefined)
            refuse(
              "The source calendar value cannot be represented without loss.",
            );
          value = instant.toISOString().slice(0, -1);
          type = "d";
        }
        if (type === "d")
          style = this.valueStyle(
            value.includes("T") ? "datetime" : "date",
            style,
          );
        body = `<${prefix}v>${value}</${prefix}v>`;
      }
    }
    const raw = rewriteCell(prior, reference, body, type, style);
    return {
      raw,
      style,
      type,
      value,
      formula,
      formulaKind: undefined,
      formulaRange: undefined,
      sharedIndex: undefined,
      protectedMetadata: false,
      bindings: prior?.bindings ?? new Map([["", main]]),
    };
  }

  private externalCopy(
    bytes: Buffer,
    change: Extract<EditChange, { kind: "copy_range" | "copy_sheet" }>,
  ): void {
    const incoming = new PreservedWorkbook(bytes);
    const assessment = inspectWorkbookEdit(bytes, []);
    if (assessment.blockers.length)
      refuse(
        `The selected copy source cannot be used: ${assessment.blockers.map((blocker) => blocker.code).join(", ")}.`,
      );
    incoming.guardDependencies(true);
    const source = incoming.sheet(change.sheetName);
    const totalBytes = [
      ...this.parts.values(),
      ...incoming.parts.values(),
    ].reduce((total, part) => total + part.byteLength, 0);
    if (totalBytes > 512 * 1024 * 1024)
      budget("The combined copy packages exceed the retention budget.");
    let cells = 0;
    for (const book of [this, incoming])
      for (const sheet of book.sheets())
        scanXml(book.xml(sheet.part), sheet.part, (node) => {
          if (node.uri === main && node.local === "c") cells += 1;
        });
    if (cells > authoringLimits.maxCells)
      budget("The combined copy workbooks exceed 1,000,000 retained cells.");
    const linkedPart = (
      book: PreservedWorkbook,
      kind: string,
    ): Uint8Array | undefined => {
      const rel = [
        ...book.opc().relationshipsFor(book.workbookPart()).values(),
      ].find((entry) => entry.type === `${office}/${kind}`);
      return rel?.kind === "internal" ? book.parts.get(rel.target) : undefined;
    };
    for (const kind of ["styles", "theme"]) {
      const left = linkedPart(this, kind),
        right = linkedPart(incoming, kind);
      if (left === undefined && right === undefined) continue;
      if (
        left === undefined ||
        right === undefined ||
        !Buffer.from(left).equals(right)
      )
        refuse(
          "Cross-workbook formula/style copying requires identical style and theme profiles; unsupported styles are never replaced by values.",
        );
    }
    let temporary = `_SezzleeImport${++this.sequence}`;
    while (this.sheets().some((sheet) => fold(sheet.name) === fold(temporary)))
      temporary = `_SezzleeImport${++this.sequence}`;
    const scopedNames: { name: string; formula: string }[] = [];
    const declaredNames = new Set<string>();
    const sourceIndex = incoming
      .sheets()
      .findIndex((sheet) => sheet.name === source.name);
    const incomingBook = incoming.xml(incoming.workbookPart());
    scanXml(incomingBook, "workbook", (node) => {
      if (node.uri !== main || node.local !== "definedName") return;
      const name = node.attributes.get("name") ?? "";
      if (!name.startsWith("_xlnm.")) declaredNames.add(name);
      if (
        change.kind === "copy_sheet" &&
        node.attributes.get("localSheetId") === String(sourceIndex)
      )
        scopedNames.push({
          name,
          formula: xmlUnescape(
            incomingBook.slice(node.openEnd, node.closeStart),
          ),
        });
    });
    const remap = (formula: string): string => {
      mapStructuredFormula(formula, () =>
        refuse(
          "Cross-workbook formula copying requires an explicit table dependency mapping.",
        ),
      );
      const identifiers =
        formula
          .replace(/"(?:[^"]|"")*"/g, "")
          .match(/[\p{L}_\\][\p{L}\p{N}_.\\]*/gu) ?? [];
      if (identifiers.some((name) => declaredNames.has(name)))
        refuse(
          "Cross-workbook copying cannot bind an existing named formula without an explicit name mapping.",
        );
      return transformFormula(formula, temporary, (ref) => {
        if (!ref.qualified) return ref;
        if (
          change.kind === "copy_range" ||
          canonical(ref.sheet ?? "") !== canonical(source.name)
        )
          refuse(
            "The copied formula requires a reference to a different source workbook or sheet.",
          );
        return { ...ref, sheet: temporary };
      });
    };
    const strings = incoming.sharedStrings();
    const grid = gridOf(incoming.xml(source.part), source.part);
    if (
      grid.groups.length ||
      [...grid.cells.values()].some(
        (cell) =>
          cell.formulaKind !== undefined && cell.formulaKind !== "normal",
      )
    )
      refuse(
        "Cross-workbook copying cannot relocate a shared or array formula family.",
      );
    const source1904 = assessment.features.date1904;
    let target1904 = false;
    scanXml(this.xml(this.workbookPart()), "workbook", (node) => {
      if (node.uri === main && node.local === "workbookPr")
        target1904 =
          node.attributes.get("date1904") === "1" ||
          node.attributes.get("date1904") === "true";
    });
    for (const [key, cell] of grid.cells) {
      if (cell.protectedMetadata)
        refuse("Cross-workbook copying cannot preserve rich cell metadata.");
      if (
        source1904 !== target1904 &&
        (cell.type === undefined || cell.type === "n") &&
        incoming.calendarStyle(cell.style)
      )
        refuse(
          "Cross-workbook numeric calendar cells require a matching date system; ISO date cells remain supported.",
        );
      let raw = cell.raw;
      if (cell.type === "s") {
        const text = strings[Number(cell.value)];
        if (text === undefined) refuse("A source shared string is absent.");
        for (const [prefix, uri] of incoming.stringBindings.get(
          Number(cell.value),
        ) ?? [])
          raw = attribute(
            raw,
            prefix === "" ? "xmlns" : `xmlns:${prefix}`,
            uri,
          );
        const prefix = /^<([^\s/>]+:)?c/.exec(raw)?.[1] ?? "";
        raw = rewriteCell(
          { ...cell, raw },
          formatCellRef(rowOf(key), columnOf(key)),
          `<${prefix}is>${text}</${prefix}is>`,
          "inlineStr",
        );
      }
      if (cell.formula !== undefined) {
        const formula = remap(cell.formula);
        const prefix = /^<([^\s/>]+:)?c/.exec(raw)?.[1] ?? "";
        const cached =
          cell.value === undefined
            ? ""
            : `<${prefix}v>${cell.value}</${prefix}v>`;
        raw = rewriteCell(
          { ...cell, raw },
          formatCellRef(rowOf(key), columnOf(key)),
          `<${prefix}f>${xmlEscape(formula)}</${prefix}f>${cached}`,
          cell.type,
        );
      }
      grid.cells.set(key, { ...cell, raw });
    }
    incoming.put(source.part, renderGrid(grid));
    const imported = new Map<string, string>();
    const importPart = (part: string): string => {
      const known = imported.get(part);
      if (known !== undefined) return known;
      const target = this.allocate(part);
      imported.set(part, target);
      const data = incoming.parts.get(part);
      if (data === undefined) refuse("An imported part is absent.");
      const opc = incoming.opc();
      const type = opc.contentTypes.contentTypeOf(part);
      if (type === undefined) refuse("An imported part has no content type.");
      this.parts.set(target, data);
      this.type(target, type);
      if (
        !/^image\//.test(type) &&
        !type.endsWith("+xml") &&
        type !== "application/xml"
      )
        refuse("An imported dependency is not supported.");
      if (!/^image\//.test(type)) {
        const xml = this.xml(target);
        const patches: XmlPatch[] = [];
        scanXml(xml, target, (node) => {
          if (
            (node.uri === namespaces.chart && node.local === "f") ||
            (node.uri === main &&
              ["calculatedColumnFormula", "totalsRowFormula"].includes(
                node.local,
              ))
          )
            patches.push({
              start: node.openEnd,
              end: node.closeStart,
              text: xmlEscape(
                remap(xmlUnescape(xml.slice(node.openEnd, node.closeStart))),
              ),
            });
        });
        if (patches.length) this.put(target, applyXmlPatches(xml, patches));
      }
      const rels = opc.relationshipsFor(part);
      if (rels.size && change.kind === "copy_sheet") {
        const path = relationshipsPathFor(part),
          xml = incoming.xml(path);
        const patches: XmlPatch[] = [];
        scanXml(xml, path, (node) => {
          if (node.local !== "Relationship") return;
          const rel = rels.get(node.attributes.get("Id") ?? "");
          if (rel?.kind === "internal")
            patches.push({
              start: node.start,
              end: node.end,
              text: attribute(
                xml.slice(node.start, node.end),
                "Target",
                "/" + importPart(rel.target),
              ),
            });
        });
        this.put(relationshipsPathFor(target), applyXmlPatches(xml, patches));
      }
      return target;
    };
    const importedSheet = importPart(source.part);
    this.addSheet(temporary, importedSheet);
    if (scopedNames.length) {
      const book = this.workbookPart();
      const xml = this.xml(book);
      let names: XmlSpan | undefined;
      let root: XmlSpan | undefined;
      scanXml(xml, book, (node) => {
        if (node.uri === main && node.local === "definedNames") names = node;
        if (node.depth === 0) root = node;
      });
      const content = scopedNames
        .map(
          (name) =>
            `<definedName xmlns="${main}" name="${xmlEscape(name.name)}" localSheetId="${this.sheets().length - 1}">${xmlEscape(remap(name.formula))}</definedName>`,
        )
        .join("");
      if (names !== undefined) this.append(book, "definedNames", content);
      else if (root !== undefined) {
        let insertion = root.closeStart;
        scanXml(xml, book, (node) => {
          if (node.depth === 1 && ["calcPr", "extLst"].includes(node.local))
            insertion = Math.min(insertion, node.start);
        });
        this.put(
          book,
          applyXmlPatches(xml, [
            {
              start: insertion,
              end: insertion,
              text: `<definedNames xmlns="${main}">${content}</definedNames>`,
            },
          ]),
        );
      }
    }
    if (change.kind === "copy_sheet")
      this.copySheet(temporary, change.name, change.mode);
    else
      this.copyRange(
        temporary,
        change.range,
        change.targetSheet,
        change.startCell,
        change.mode,
        change.overwrite,
        false,
      );
    this.deleteSheet(temporary);
    this.changes.sheetsAdded -= 1;
  }

  private clonePart(source: string, cloned: Map<string, string>): string {
    const known = cloned.get(source);
    if (known !== undefined) return known;
    const target = this.allocate(source);
    cloned.set(source, target);
    const bytes = this.parts.get(source);
    if (bytes === undefined) refuse("A copied dependency is missing.");
    this.parts.set(target, bytes);
    const opc = this.opc();
    const type = opc.contentTypes.contentTypeOf(source);
    if (type === undefined) refuse("A copied dependency has no content type.");
    if (!type.endsWith("+xml") && type !== "application/xml")
      refuse("The copied sheet has an unsupported opaque dependency.");
    this.type(target, type);
    const rels = opc.relationshipsFor(source);
    if (rels.size > 0) {
      const sourceRels = relationshipsPathFor(source);
      let xml = this.xml(sourceRels);
      const patches: XmlPatch[] = [];
      scanXml(xml, sourceRels, (node) => {
        if (node.local !== "Relationship") return;
        const rel = rels.get(node.attributes.get("Id") ?? "");
        if (rel?.kind !== "internal") return;
        const content = opc.contentTypes.contentTypeOf(rel.target) ?? "";
        const part = /image\//.test(content)
          ? rel.target
          : this.clonePart(rel.target, cloned);
        patches.push({
          start: node.start,
          end: node.end,
          text: attribute(
            xml.slice(node.start, node.end),
            "Target",
            "/" + part,
          ),
        });
      });
      xml = applyXmlPatches(xml, patches);
      this.put(relationshipsPathFor(target), xml);
    }
    return target;
  }

  private copySheet(
    name: string,
    newName: string,
    mode: "values" | "formulas" | "formatting" | "all",
  ): void {
    this.uniqueName(newName);
    this.guardDependencies(true);
    const source = this.sheet(name);
    const sourceGrid = gridOf(this.xml(source.part), source.part);
    if (
      sourceGrid.groups.length ||
      [...sourceGrid.cells.values()].some(
        (cell) =>
          cell.protectedMetadata ||
          (cell.formulaKind !== undefined && cell.formulaKind !== "normal"),
      )
    )
      refuse(
        "Sheet copying cannot relocate an unsupported formula family or rich cell metadata.",
      );
    this.touch(sourceGrid.cells.size);
    this.reservePresentationCells(sourceGrid.cells.size);
    if (mode !== "all" && this.opc().relationshipsFor(source.part).size > 0)
      refuse(
        "Partial-mode sheet copying with dependent parts is unsupported; use all mode.",
      );
    const copied = new Map<string, string>();
    const target = this.clonePart(source.part, copied);
    this.addSheet(newName, target);
    if (source.state !== "visible") {
      const book = this.workbookPart();
      const xml = this.xml(book);
      const added = this.sheet(newName);
      this.put(
        book,
        applyXmlPatches(xml, [
          {
            start: added.span.start,
            end: added.span.end,
            text: attribute(
              xml.slice(added.span.start, added.span.end),
              "state",
              source.state,
            ),
          },
        ]),
      );
    }
    const tableNames = new Set<string>();
    let largestTable = 0;
    for (const [part] of this.parts) {
      if (
        !(this.opc().contentTypes.contentTypeOf(part) ?? "").endsWith(
          ".table+xml",
        ) ||
        copied.has(part)
      )
        continue;
      scanXml(this.xml(part), part, (node) => {
        if (node.local === "table") {
          tableNames.add(node.attributes.get("name") ?? "");
          largestTable = Math.max(
            largestTable,
            Number(node.attributes.get("id") ?? "0"),
          );
        }
      });
    }
    const copiedTables = new Map<string, { name: string; id: number }>();
    for (const targetPart of copied.values())
      scanXml(this.xml(targetPart), targetPart, (node) => {
        if (node.uri !== main || node.local !== "table") return;
        let table = `CopiedTable${++largestTable}`;
        while (tableNames.has(table)) table = `CopiedTable${++largestTable}`;
        tableNames.add(table);
        copiedTables.set(fold(node.attributes.get("name") ?? ""), {
          name: table,
          id: largestTable,
        });
      });
    const remapTableNames = (formula: string) =>
      mapStructuredFormula(formula, (ref) => {
        const table =
          ref.name === undefined ? undefined : copiedTables.get(fold(ref.name));
        return table === undefined
          ? ref.raw
          : renderStructuredReference(ref, ref.columns, table.name);
      });
    for (const targetPart of copied.values()) {
      let xml = this.xml(targetPart);
      const patches: XmlPatch[] = [];
      scanXml(xml, targetPart, (node) => {
        if (node.local === "table" && node.uri === main) {
          const mapped = copiedTables.get(
            fold(node.attributes.get("name") ?? ""),
          );
          if (mapped === undefined)
            refuse("A cloned table has no identity mapping.");
          const table = mapped.name;
          patches.push({
            start: node.start,
            end: node.openEnd,
            text: attribute(
              attribute(
                attribute(
                  xml.slice(node.start, node.openEnd),
                  "id",
                  String(mapped.id),
                ),
                "name",
                table,
              ),
              "displayName",
              table,
            ),
          });
        }
        if (
          (node.uri === main &&
            ["f", "calculatedColumnFormula", "totalsRowFormula"].includes(
              node.local,
            )) ||
          (node.uri === namespaces.chart && node.local === "f")
        ) {
          const transformed = transformFormula(
            remapTableNames(
              xmlUnescape(xml.slice(node.openEnd, node.closeStart)),
            ),
            newName,
            (ref) =>
              canonical(ref.sheet ?? "") === canonical(source.name)
                ? { ...ref, sheet: newName }
                : ref,
          );
          patches.push({
            start: node.openEnd,
            end: node.closeStart,
            text: xmlEscape(transformed),
          });
        }
      });
      if (patches.length) {
        xml = applyXmlPatches(xml, patches);
        this.put(targetPart, xml);
      }
    }
    if (mode !== "all") {
      const grid = gridOf(this.xml(target), target);
      if (mode === "values" || mode === "formulas") {
        const fresh = gridOf(
          `<worksheet xmlns="${main}"><sheetData/></worksheet>`,
          target,
        );
        for (const [key, cell] of grid.cells)
          fresh.cells.set(
            key,
            this.contentCell(
              cell,
              formatCellRef(rowOf(key), columnOf(key)),
              mode,
              newName,
            ),
          );
        this.put(target, renderGrid(fresh));
      } else {
        for (const [key, cell] of grid.cells)
          grid.cells.set(key, {
            ...cell,
            raw: rewriteCell(
              cell,
              formatCellRef(rowOf(key), columnOf(key)),
              "",
              undefined,
            ),
            formula: undefined,
            value: undefined,
            type: undefined,
          });
        this.put(target, renderGrid(grid));
      }
    }
    const workbook = this.workbookPart();
    const xml = this.xml(workbook);
    const sourceIndex = this.sheets().findIndex(
      (entry) => entry.name === source.name,
    );
    const targetIndex = this.sheets().length - 1;
    const names: string[] = [];
    scanXml(xml, workbook, (node) => {
      if (
        node.uri === main &&
        node.local === "definedName" &&
        node.attributes.get("localSheetId") === String(sourceIndex) &&
        (mode === "all" ||
          mode === "formatting" ||
          (mode === "formulas" &&
            !node.attributes.get("name")?.startsWith("_xlnm.")))
      ) {
        const formula = transformFormula(
          remapTableNames(
            xmlUnescape(xml.slice(node.openEnd, node.closeStart)),
          ),
          source.name,
          (ref) =>
            canonical(ref.sheet ?? "") === canonical(source.name)
              ? { ...ref, sheet: newName }
              : ref,
        );
        names.push(
          attribute(
            replaceElementBody(xml, node, xmlEscape(formula)),
            "localSheetId",
            String(targetIndex),
          ),
        );
      }
    });
    if (names.length) this.append(workbook, "definedNames", names.join(""));
    this.needsCalculation = true;
  }

  private deleteSheet(name: string): void {
    const sheet = this.sheet(name),
      sheets = this.sheets();
    if (
      sheet.state === "visible" &&
      sheets.filter((entry) => entry.state === "visible").length <= 1
    )
      refuse("The last visible sheet cannot be deleted.");
    this.guardDependencies(false);
    deleteSheetTableReferences(this, sheet.name);
    const owned = new Set<string>();
    const originalOpc = this.opc();
    const pending = [sheet.part];
    while (pending.length) {
      const part = pending.pop();
      if (part === undefined || owned.has(part)) continue;
      owned.add(part);
      for (const rel of originalOpc.relationshipsFor(part).values())
        if (rel.kind === "internal" && this.parts.has(rel.target))
          pending.push(rel.target);
    }
    this.references(
      (ref) =>
        canonical(ref.sheet ?? "") === canonical(sheet.name) ? "#REF!" : ref,
      undefined,
      new Set([sheet.name]),
    );
    const part = this.workbookPart();
    let xml = this.xml(part);
    const deletedIndex = sheets.findIndex(
      (entry) => entry.relationship === sheet.relationship,
    );
    const patches: XmlPatch[] = [];
    const current = this.sheet(name);
    patches.push({
      start: current.span.start,
      end: current.span.end,
      text: "",
    });
    scanXml(xml, part, (node) => {
      if (node.uri !== main) return;
      if (node.local === "definedName" && node.attributes.has("localSheetId")) {
        const index = Number(node.attributes.get("localSheetId"));
        if (index === deletedIndex)
          patches.push({ start: node.start, end: node.end, text: "" });
        else if (index > deletedIndex)
          patches.push({
            start: node.start,
            end: node.openEnd,
            text: attribute(
              xml.slice(node.start, node.openEnd),
              "localSheetId",
              String(index - 1),
            ),
          });
      }
      if (node.local === "workbookView") {
        let header = xml.slice(node.start, node.openEnd);
        for (const name of ["activeTab", "firstSheet"]) {
          const index = Number(node.attributes.get(name) ?? "0");
          header = attribute(
            header,
            name,
            String(
              index > deletedIndex
                ? index - 1
                : Math.min(index, sheets.length - 2),
            ),
          );
        }
        patches.push({ start: node.start, end: node.openEnd, text: header });
      }
    });
    xml = applyXmlPatches(xml, patches);
    this.put(part, xml);
    const relPart = relationshipsPathFor(part);
    const relXml = this.xml(relPart);
    const relPatches: XmlPatch[] = [];
    scanXml(relXml, relPart, (node) => {
      if (
        node.local === "Relationship" &&
        node.attributes.get("Id") === sheet.relationship
      )
        relPatches.push({ start: node.start, end: node.end, text: "" });
    });
    this.put(relPart, applyXmlPatches(relXml, relPatches));
    const reachable = new Set<string>();
    const opc = this.opc();
    const active = [...opc.packageRelationships.values()].flatMap((entry) =>
      entry.kind === "internal" ? [entry.target] : [],
    );
    while (active.length) {
      const part = active.pop();
      if (part === undefined || reachable.has(part)) continue;
      reachable.add(part);
      for (const rel of opc.relationshipsFor(part).values())
        if (rel.kind === "internal" && this.parts.has(rel.target))
          active.push(rel.target);
    }
    for (const part of owned)
      if (!reachable.has(part)) {
        this.removePart(part);
        this.parts.delete(relationshipsPathFor(part));
      }
    this.needsCalculation = true;
  }

  finish(operations: number): PreservedEditResult {
    let stored = 0;
    for (const sheet of this.sheets()) {
      const xml = this.xml(sheet.part);
      scanXml(xml, sheet.part, (node) => {
        if (node.uri === main && node.local === "c") stored += 1;
        if (
          this.formattingChanged &&
          node.uri === main &&
          node.local === "f" &&
          /\bCELL\s*\(/i.test(
            xmlUnescape(xml.slice(node.openEnd, node.closeStart)).replace(
              /"(?:[^"]|"")*"/g,
              "",
            ),
          )
        )
          this.needsCalculation = true;
      });
    }
    if (this.needsCalculation) {
      this.invalidateCalculations();
      const opc = this.opc();
      let originalWorkbook: PreservedWorkbook | undefined;
      for (const entry of opc.parts) {
        const type = opc.contentTypes.contentTypeOf(entry.path) ?? "";
        if (!/\.chart\+xml$|pivotCacheDefinition\+xml$/.test(type)) continue;
        const current = this.featureSourceSignature(entry.path);
        let previous = this.featureFreshness.get(entry.path);
        if (previous === undefined && this.original.has(entry.path)) {
          originalWorkbook ??= new PreservedWorkbook(this.originalBytes);
          previous = originalWorkbook.featureSourceSignature(entry.path);
        }
        if (current !== undefined && previous === current) continue;
        if (/\.chart\+xml$/.test(type)) {
          const xml = this.xml(entry.path),
            patches: XmlPatch[] = [];
          scanXml(xml, entry.path, (node) => {
            if (
              node.uri === namespaces.chart &&
              ["numCache", "strCache", "multiLvlStrCache"].includes(node.local)
            )
              patches.push({ start: node.start, end: node.end, text: "" });
          });
          if (patches.length)
            this.put(entry.path, applyXmlPatches(xml, patches));
          this.requireFeatureRefresh("charts");
        }
        if (/pivotCacheDefinition\+xml$/.test(type)) {
          const xml = this.xml(entry.path);
          let root: XmlSpan | undefined;
          scanXml(xml, entry.path, (node) => {
            if (node.uri === main && node.local === "pivotCacheDefinition")
              root = node;
          });
          if (root !== undefined)
            this.put(
              entry.path,
              applyXmlPatches(xml, [
                {
                  start: root.start,
                  end: root.end,
                  text: attribute(
                    attribute(xml.slice(root.start, root.end), "invalid", "1"),
                    "refreshOnLoad",
                    "1",
                  ),
                },
              ]),
            );
          this.requireFeatureRefresh("pivots");
        }
      }
    }
    if (stored > authoringLimits.maxCells)
      budget("The workbook exceeds 1,000,000 stored cells.");
    let changed = 0;
    for (const [part, bytes] of this.parts) {
      const prior = this.original.get(part);
      if (prior === undefined || !Buffer.from(prior).equals(bytes))
        changed += 1;
    }
    for (const part of this.original.keys())
      if (!this.parts.has(part)) changed += 1;
    const bytes = Buffer.from(writer.zip(this.parts, limits.maxFileBytes));
    const refreshRequired: ("formulas" | "charts" | "pivots")[] = [
      ...this.featureRefresh,
    ];
    if (this.needsCalculation) {
      refreshRequired.push("formulas");
    }
    return {
      bytes,
      changes: this.changes,
      editing: {
        operations,
        partsChanged: changed,
        cellsCleared: this.cleared,
        recalculated: false,
        recalculationRequired: this.needsCalculation,
        cachedFormulaValues: this.cachedFormulaValues,
        refreshRequired,
        ...this.presentation,
      },
    };
  }

  transferShape(
    selectedSheet?: string,
    headerRow?: number,
  ): { sheets: { name: string; cells: Map<number, WriteCell> }[] } {
    const strings = this.sharedStrings();
    return {
      sheets: this.sheets().map((sheet) => {
        const cells = new Map<number, WriteCell>();
        if (
          selectedSheet !== undefined &&
          canonical(selectedSheet) === canonical(sheet.name) &&
          headerRow !== undefined
        ) {
          const grid = gridOf(this.xml(sheet.part), sheet.part);
          for (const [key, cell] of grid.cells)
            if (rowOf(key) === headerRow) {
              let text: string | undefined;
              if (cell.type === "s") text = strings[Number(cell.value)];
              else if (cell.type === "inlineStr") text = cell.raw;
              if (text === undefined) continue;
              const wrapped = `<root xmlns="${main}"${[...cell.bindings]
                .filter(([prefix]) => prefix !== "")
                .map(([prefix, uri]) => ` xmlns:${prefix}="${xmlEscape(uri)}"`)
                .join("")}>${text}</root>`;
              let value = "";
              scanXml(wrapped, "header", (node) => {
                if (node.uri === main && node.local === "t")
                  value += unescapeXstring(
                    xmlUnescape(wrapped.slice(node.openEnd, node.closeStart)),
                  );
              });
              cells.set(key, { kind: "text", value });
            }
        }
        return { name: sheet.name, cells };
      }),
    };
  }

  private invalidateCalculations(): void {
    for (const sheet of this.sheets()) {
      const xml = this.xml(sheet.part);
      const patches: XmlPatch[] = [];
      let formula = false;
      let metadata = false;
      let value: XmlSpan | undefined;
      scanXml(xml, sheet.part, (node) => {
        if (node.uri !== main) return;
        if (node.local === "f" && node.parent === "c") formula = true;
        if (node.local === "v" && node.parent === "c") value = node;
        if (node.local === "c") {
          metadata = node.attributes.has("vm") || node.attributes.has("cm");
          if (formula && metadata)
            refuse(
              "The edit cannot invalidate an unsupported rich formula cache safely.",
            );
          if (formula && value !== undefined)
            patches.push({ start: value.start, end: value.end, text: "" });
          formula = false;
          value = undefined;
          metadata = false;
        }
      });
      if (patches.length) this.put(sheet.part, applyXmlPatches(xml, patches));
    }
    const part = this.workbookPart();
    const xml = this.xml(part);
    let calc: XmlSpan | undefined;
    let root: XmlSpan | undefined;
    scanXml(xml, part, (node) => {
      if (node.uri === main && node.local === "calcPr") calc = node;
      if (node.depth === 0) root = node;
    });
    if (calc !== undefined)
      this.put(
        part,
        applyXmlPatches(xml, [
          {
            start: calc.start,
            end: calc.end,
            text: attribute(
              attribute(xml.slice(calc.start, calc.end), "fullCalcOnLoad", "1"),
              "forceFullCalc",
              "1",
            ),
          },
        ]),
      );
    else if (root !== undefined) {
      let insertion = root.closeStart;
      scanXml(xml, part, (node) => {
        if (
          node.depth === 1 &&
          [
            "oleSize",
            "customWorkbookViews",
            "pivotCaches",
            "smartTagPr",
            "smartTagTypes",
            "webPublishing",
            "fileRecoveryPr",
            "webPublishObjects",
            "extLst",
          ].includes(node.local)
        )
          insertion = Math.min(insertion, node.start);
      });
      this.put(
        part,
        applyXmlPatches(xml, [
          {
            start: insertion,
            end: insertion,
            text: `<calcPr xmlns="${main}" fullCalcOnLoad="1" forceFullCalc="1"/>`,
          },
        ]),
      );
    }
    const opc = this.opc();
    const chains = [...opc.relationshipsFor(part).values()].filter(
      (entry) => entry.type === `${office}/calcChain`,
    );
    if (chains.length) {
      const relPart = relationshipsPathFor(part);
      const relXml = this.xml(relPart);
      const patches: XmlPatch[] = [];
      scanXml(relXml, relPart, (node) => {
        if (
          node.local === "Relationship" &&
          chains.some((entry) => entry.id === node.attributes.get("Id"))
        )
          patches.push({ start: node.start, end: node.end, text: "" });
      });
      this.put(relPart, applyXmlPatches(relXml, patches));
      for (const entry of chains)
        if (entry.kind === "internal") this.removePart(entry.target);
    }
  }

  private removePart(part: string): void {
    this.parts.delete(part);
    const xml = this.xml("[Content_Types].xml");
    const patches: XmlPatch[] = [];
    scanXml(xml, "[Content_Types].xml", (node) => {
      if (
        node.local === "Override" &&
        node.attributes.get("PartName") === "/" + part
      )
        patches.push({ start: node.start, end: node.end, text: "" });
    });
    if (patches.length)
      this.put("[Content_Types].xml", applyXmlPatches(xml, patches));
  }
}

export function editPreservedWorkbook(
  bytes: Buffer,
  changes: readonly EditChange[],
  sources: ReadonlyMap<number, Buffer> = new Map(),
): PreservedEditResult {
  const inspection = inspectWorkbookEdit(bytes, changes);
  if (inspection.blockers.length)
    refuse(
      `The workbook cannot be edited: ${inspection.blockers.map((blocker) => blocker.code).join(", ")}.`,
    );
  const workbook = new PreservedWorkbook(bytes);
  workbook.apply(changes, sources);
  return workbook.finish(changes.length);
}
