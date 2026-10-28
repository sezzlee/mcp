import { canonical, fold } from "@sezzlee/file-core";
import { createOoxmlWriter } from "@sezzlee/ooxml-core";
import {
  authoringLimits,
  sheetNameSchema,
  type NewSheet,
  type ValueBlock,
  type WorkbookChange,
} from "../authoring/workbook.js";
import { writeCellSchema, type WriteCell } from "../authoring/values.js";
import { isoWrite } from "./iso-write.js";
import { occupiedTarget } from "./occupied.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import {
  formatCellRef,
  maxColumn,
  maxRow,
  parseCellRef,
} from "../grid/range.js";
import { openPackage } from "../metadata/spreadsheetml/package.js";
import { scanPart, zipSource } from "../metadata/spreadsheetml/reader.js";
import { unescapeXstring } from "../metadata/spreadsheetml/shared-strings.js";
import { failOoxml } from "../metadata/spreadsheetml/errors.js";

interface AuthoredSheet {
  readonly name: string;
  readonly cells: Map<number, WriteCell>;
}

export interface AuthoredWorkbook {
  readonly sheets: AuthoredSheet[];
}

export interface MutationSummary {
  sheetsAdded: number;
  blocksWritten: number;
  cellsWritten: number;
}

const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const office =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const relationships =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const contentTypes =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const writer = createOoxmlWriter({ fail: failOoxml });

function invalid(message: string): never {
  throw new SezzleeExcelError("invalid_argument", message);
}

function budget(message: string): never {
  throw new SezzleeExcelError("resource_limit", message);
}

function escaped(value: string): string {
  return value
    .replace(/_x[0-9a-fA-F]{4}_/g, (match) => `_x005F_${match.slice(1)}`)
    .replace(/[\s\S]/g, (character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 9 && code !== 10) ||
        code === 65_534 ||
        code === 65_535
        ? `_x${code.toString(16).padStart(4, "0")}_`
        : character;
    })
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function addSheet(workbook: AuthoredWorkbook, name: string): AuthoredSheet {
  if (workbook.sheets.length >= authoringLimits.maxSheets)
    budget("The workbook exceeds the sheet limit.");
  if (
    workbook.sheets.some(
      (sheet) => fold(canonical(sheet.name)) === fold(canonical(name)),
    )
  )
    invalid(
      "A sheet with this name already exists, including normalized name matches.",
    );
  const sheet = { name, cells: new Map<number, WriteCell>() };
  workbook.sheets.push(sheet);
  return sheet;
}

function applyBlock(
  sheet: AuthoredSheet,
  block: ValueBlock,
  overwrite: boolean,
  summary: MutationSummary,
): void {
  const start = parseCellRef(block.startCell);
  const width = block.values[0]?.length ?? 0;
  if (
    start.row + block.values.length - 1 > maxRow ||
    start.column + width - 1 > maxColumn
  )
    throw new SezzleeExcelError(
      "invalid_range",
      "The value block exceeds the worksheet bounds.",
    );
  const size = block.values.length * width;
  if (summary.cellsWritten + size > authoringLimits.maxCells)
    budget("A request may write at most 1,000,000 cells.");
  for (const [rowOffset, row] of block.values.entries()) {
    for (const [columnOffset, cell] of row.entries()) {
      const key =
        (start.row + rowOffset - 1) * maxColumn +
        start.column +
        columnOffset -
        1;
      if (!overwrite && sheet.cells.has(key))
        occupiedTarget(
          sheet.name,
          formatCellRef(start.row + rowOffset, start.column + columnOffset),
        );
      if (cell.kind === "blank") sheet.cells.delete(key);
      else sheet.cells.set(key, cell);
    }
  }
  summary.blocksWritten += 1;
  summary.cellsWritten += size;
}

function checkWorkbookBudget(workbook: AuthoredWorkbook): void {
  let count = 0;
  let textBytes = 0;
  for (const sheet of workbook.sheets) {
    count += sheet.cells.size;
    if (count > authoringLimits.maxCells)
      budget("The workbook exceeds 1,000,000 stored cells.");
    for (const cell of sheet.cells.values()) {
      if (cell.kind === "text") textBytes += Buffer.byteLength(cell.value);
      if (textBytes > authoringLimits.maxTextBytes)
        budget("The workbook exceeds its text byte budget.");
    }
  }
}

export function createAuthoredWorkbook(sheets: readonly NewSheet[]): {
  workbook: AuthoredWorkbook;
  changes: MutationSummary;
} {
  const workbook: AuthoredWorkbook = { sheets: [] };
  const changes: MutationSummary = {
    sheetsAdded: 0,
    blocksWritten: 0,
    cellsWritten: 0,
  };
  let blocks = 0;
  for (const input of sheets) {
    blocks += input.blocks.length;
    if (blocks > authoringLimits.maxOperations)
      budget("The request exceeds the block limit.");
    const sheet = addSheet(workbook, input.name);
    changes.sheetsAdded += 1;
    for (const block of input.blocks) applyBlock(sheet, block, false, changes);
  }
  checkWorkbookBudget(workbook);
  return { workbook, changes };
}

export function editAuthoredWorkbook(
  workbook: AuthoredWorkbook,
  operations: readonly WorkbookChange[],
): MutationSummary {
  const changes: MutationSummary = {
    sheetsAdded: 0,
    blocksWritten: 0,
    cellsWritten: 0,
  };
  for (const operation of operations) {
    if (operation.kind === "add_sheet") {
      addSheet(workbook, operation.name);
      changes.sheetsAdded += 1;
    } else {
      const sheet = workbook.sheets.find(
        (entry) => canonical(entry.name) === canonical(operation.sheetName),
      );
      if (sheet === undefined)
        throw new SezzleeExcelError(
          "unknown_sheet",
          "The requested sheet does not exist.",
        );
      applyBlock(sheet, operation, operation.overwrite, changes);
    }
  }
  checkWorkbookBudget(workbook);
  return changes;
}

function cellXml(reference: string, cell: WriteCell): string {
  switch (cell.kind) {
    case "text":
      return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escaped(cell.value)}</t></is></c>`;
    case "number":
      return `<c r="${reference}" t="n"><v>${cell.value}</v></c>`;
    case "boolean":
      return `<c r="${reference}" t="b"><v>${cell.value ? 1 : 0}</v></c>`;
    case "date":
      return `<c r="${reference}" s="1" t="d"><v>${isoWrite(cell)}</v></c>`;
    case "datetime":
      return `<c r="${reference}" s="2" t="d"><v>${isoWrite(cell)}</v></c>`;
    case "blank":
      return "";
    default: {
      const exhaustive: never = cell;
      return exhaustive;
    }
  }
}

function sheetXml(sheet: AuthoredSheet): string {
  const rows: string[] = [];
  let current = -1;
  let cells: string[] = [];
  for (const key of [...sheet.cells.keys()].sort((a, b) => a - b)) {
    const row = Math.floor(key / maxColumn) + 1;
    if (row !== current) {
      if (current !== -1)
        rows.push(`<row r="${current}">${cells.join("")}</row>`);
      current = row;
      cells = [];
    }
    const cell = sheet.cells.get(key);
    if (cell !== undefined)
      cells.push(cellXml(formatCellRef(row, (key % maxColumn) + 1), cell));
  }
  if (current !== -1) rows.push(`<row r="${current}">${cells.join("")}</row>`);
  return `${declaration}<worksheet xmlns="${main}"><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

function metadataParts(workbook: AuthoredWorkbook): Map<string, Uint8Array> {
  const sheets = workbook.sheets;
  const parts = new Map<string, Uint8Array>();
  const put = (name: string, xml: string): void => {
    parts.set(name, Buffer.from(declaration + xml));
  };
  put(
    "[Content_Types].xml",
    `<Types xmlns="${contentTypes}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
  );
  put(
    "_rels/.rels",
    `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  put(
    "xl/workbook.xml",
    `<workbook xmlns="${main}" xmlns:r="${office}"><fileVersion appName="sezzlee"/><workbookPr date1904="0"/><sheets>${sheets.map((sheet, i) => `<sheet name="${escaped(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
  );
  put(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="${relationships}">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${office}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="${office}/styles" Target="styles.xml"/></Relationships>`,
  );
  put(
    "xl/styles.xml",
    `<styleSheet xmlns="${main}"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd&quot;T&quot;hh:mm:ss.000"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  return parts;
}

export function serializeAuthoredWorkbook(workbook: AuthoredWorkbook): Buffer {
  const parts = metadataParts(workbook);
  for (const [i, sheet] of workbook.sheets.entries())
    parts.set(`xl/worksheets/sheet${i + 1}.xml`, Buffer.from(sheetXml(sheet)));
  return Buffer.from(writer.zip(parts, limits.maxFileBytes));
}

export function readAuthoredWorkbook(bytes: Buffer): AuthoredWorkbook {
  const opc = openPackage(zipSource(bytes));
  const workbook: AuthoredWorkbook = { sheets: [] };
  if (
    opc.sheetParts.size < 1 ||
    opc.sheetParts.size > authoringLimits.maxSheets
  )
    invalid("This source is outside the Phase 1 workbook format.");
  let stored = 0;
  let textBytes = 0;
  for (const [name, part] of opc.sheetParts) {
    const parsed = sheetNameSchema.safeParse(name);
    if (!parsed.success)
      invalid("The source contains an unsupported sheet name.");
    const sheet = addSheet(workbook, parsed.data);
    let reference: string | undefined;
    let type: string | undefined;
    let style: string | undefined;
    let capture = false;
    let text = "";
    scanPart(opc, part, {
      onOpen(node) {
        if (node.uri !== main) return;
        if (node.local === "c") {
          reference = node.attr("r");
          type = node.attr("t");
          style = node.attr("s");
          text = "";
        }
        if (node.local === "v" || node.local === "t") capture = true;
      },
      onText(chunk) {
        if (capture) text += chunk;
      },
      onClose(local, uri) {
        if (uri !== main) return;
        if (local === "v" || local === "t") capture = false;
        if (local !== "c") return;
        if (reference === undefined)
          invalid("The source contains an unsupported cell.");
        stored += 1;
        if (stored > authoringLimits.maxCells)
          budget("The source exceeds the stored-cell limit.");
        let input: unknown;
        switch (type) {
          case "inlineStr": {
            const value = unescapeXstring(text);
            textBytes += Buffer.byteLength(value);
            if (textBytes > authoringLimits.maxTextBytes)
              budget("The source exceeds the text byte budget.");
            input = { kind: "text", value };
            break;
          }
          case "n":
            input = { kind: "number", value: Number(text) };
            break;
          case "b":
            input = { kind: "boolean", value: text === "1" };
            break;
          case "d":
            input = {
              kind: style === "1" ? "date" : "datetime",
              value:
                style === "1" && text.endsWith("T00:00:00.000")
                  ? text.slice(0, 10)
                  : text,
            };
            break;
          default:
            invalid(
              "This source contains unsupported cells. General workbook editing is a later phase.",
            );
        }
        const cell = writeCellSchema.safeParse(input);
        if (!cell.success)
          invalid(
            "The source contains a value outside the supported write contract.",
          );
        const coordinate = parseCellRef(reference);
        const key = (coordinate.row - 1) * maxColumn + coordinate.column - 1;
        if (sheet.cells.has(key))
          invalid("The source contains duplicate cell coordinates.");
        sheet.cells.set(key, cell.data);
        reference = undefined;
      },
    });
    const original = opc.partBytes(part);
    if (
      original === undefined ||
      !Buffer.from(original).equals(Buffer.from(sheetXml(sheet)))
    )
      invalid(
        "This source contains unsupported worksheet content. Phase 1 edits only its canonical outputs.",
      );
  }
  const expected = metadataParts(workbook);
  if (opc.parts.length !== expected.size + workbook.sheets.length)
    invalid("The source contains unsupported package parts.");
  for (const [name, expectedBytes] of expected) {
    const original = opc.partBytes(name);
    if (original === undefined || !Buffer.from(original).equals(expectedBytes))
      invalid(
        "This source contains unsupported package metadata. Phase 1 edits only its canonical outputs.",
      );
  }
  return workbook;
}
