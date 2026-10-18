import type { CellSnapshot } from "../grid/cell-value.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import { columnToLetters, type GridBounds } from "../grid/range.js";
import { presentIndices, type RowView, type SheetView } from "../grid/sheet.js";
import type {
  DocumentMeta,
  WorkbookDescription,
} from "../metadata/description.js";
import {
  delimiterNames,
  type CsvOptions,
  type DelimiterName,
  type EncodingName,
} from "../platform/delimited.js";
import { readRecords, type CsvFault, type LineBreak } from "./csv-tokenizer.js";

export const csvSheetName = "csv";

export interface CsvReport {
  readonly warnings?: readonly string[];
  readonly delimiter: DelimiterName;
  readonly delimiterSource: "explicit" | "sniffed" | "default";
  readonly encoding: string;
  readonly encodingSource: "explicit" | "bom" | "default";
  readonly hadBom: boolean;
  readonly lineBreak: LineBreak;
  readonly recordCount: number;
  readonly columnCount: number;
  readonly raggedRecordCount: number;
  readonly blankRecordCount: number;
  readonly formulaLikeCellCount: number;
  readonly duplicateHeaders?: readonly string[];
}

export interface CsvTable {
  readonly rows: readonly (readonly string[])[];
  readonly bounds: GridBounds | undefined;
  readonly report: CsvReport;
}

function assertNoNulBytes(bytes: Buffer, path: string): void {
  const window = bytes.subarray(
    0,
    Math.min(bytes.length, limits.csvNulScanBytes),
  );
  if (!window.includes(0)) {
    return;
  }
  throw new SezzleeExcelError(
    "undecodable_text",
    `'${path}' contains NUL bytes near its start. It is a binary file, or UTF-16 text without a byte-order mark.`,
    "Pass encoding 'utf-16le' or 'utf-16be' if the file is UTF-16 text.",
  );
}

interface BomMatch {
  readonly encoding: EncodingName;
  readonly length: number;
}

function detectBom(bytes: Buffer): BomMatch | undefined {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xfe &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) {
    throw new SezzleeExcelError(
      "undecodable_text",
      "The file begins with a UTF-32 byte-order mark, which cannot be decoded.",
      "Save the file as UTF-8.",
    );
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0xfe &&
    bytes[3] === 0xff
  ) {
    throw new SezzleeExcelError(
      "undecodable_text",
      "The file begins with a UTF-32 byte-order mark, which cannot be decoded.",
      "Save the file as UTF-8.",
    );
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return { encoding: "utf-8", length: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: "utf-16le", length: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: "utf-16be", length: 2 };
  }
  return undefined;
}

/**
 * Guard: Node 24.12's TextDecoder decodes windows-1252 as ISO-8859-1, so the
 * bytes 0x80 to 0x9F (€, curly quotes, dashes, …, ™) came back as C1 control
 * characters. They are mapped here through the WHATWG index-windows-1252; a
 * decoder that is already right leaves only the five unmapped bytes, which map
 * to themselves.
 */
const windows1252High =
  "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ";

function repairWindows1252(text: string): string {
  return text.replace(
    /[\u0080-\u009f]/g,
    (character) => windows1252High[character.charCodeAt(0) - 0x80] ?? character,
  );
}

interface Decoded {
  readonly text: string;
  readonly encoding: string;
  readonly encodingSource: "explicit" | "bom" | "default";
  readonly hadBom: boolean;
}

function decode(
  bytes: Buffer,
  requested: EncodingName | undefined,
  path: string,
): Decoded {
  const bom = detectBom(bytes);
  if (
    requested !== undefined &&
    bom !== undefined &&
    bom.encoding !== requested
  ) {
    throw new SezzleeExcelError(
      "invalid_argument",
      `'${path}' begins with a ${bom.encoding} byte-order mark but encoding '${requested}' was requested.`,
      `Omit encoding, or pass '${bom.encoding}'.`,
    );
  }
  const chosen = requested ?? bom?.encoding ?? "utf-8";
  const source =
    requested !== undefined
      ? "explicit"
      : bom !== undefined
        ? "bom"
        : "default";
  const strict = chosen.startsWith("utf-");
  const decoder = new TextDecoder(chosen, { fatal: strict, ignoreBOM: false });
  let text: string;
  try {
    text = decoder.decode(bytes);
    if (decoder.encoding === "windows-1252") text = repairWindows1252(text);
  } catch {
    throw new SezzleeExcelError(
      "undecodable_text",
      `'${path}' is not valid ${chosen} text.`,
      "Pass encoding explicitly: 'windows-1254' (Turkish Excel), 'iso-8859-9', 'windows-1252', 'utf-16le' or 'utf-16be'.",
    );
  }
  const hadBom = bom !== undefined;
  return {
    text: text.startsWith("﻿") ? text.slice(1) : text,
    encoding: decoder.encoding,
    encodingSource: source,
    hadBom,
  };
}

function sniffLines(text: string): string[] {
  const window = text.slice(0, limits.csvSniffBytes);
  const lines: string[] = [];
  let current = "";
  let inQuote = false;
  for (const character of window) {
    if (character === '"') {
      inQuote = !inQuote;
      current += character;
      continue;
    }
    if (character === "\n" && !inQuote) {
      lines.push(current.replace(/\r$/, ""));
      current = "";
      if (lines.length >= limits.csvSniffLines) {
        return lines;
      }
      continue;
    }
    current += character;
  }
  if (current !== "") {
    lines.push(current);
  }
  return lines;
}

function countOutsideQuotes(line: string, candidate: string): number {
  let count = 0;
  let inQuote = false;
  for (const character of line) {
    if (character === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && character === candidate) {
      count += 1;
    }
  }
  return count;
}

interface DelimiterChoice {
  readonly delimiter: DelimiterName;
  readonly delimiterSource: "explicit" | "sniffed" | "default";
}

function scoreCandidate(lines: string[], candidate: string): number {
  const header = lines[0];
  if (header === undefined || countOutsideQuotes(header, candidate) === 0) {
    return -1;
  }
  const counts = lines
    .map((line) => countOutsideQuotes(line, candidate))
    .filter((count) => count >= 1);
  const frequency = new Map<number, number>();
  for (const count of counts) {
    frequency.set(count, (frequency.get(count) ?? 0) + 1);
  }
  let modal = 0;
  for (const seen of frequency.values()) {
    modal = Math.max(modal, seen);
  }
  return modal / lines.length;
}

export function sniffDelimiter(
  text: string,
  requested: DelimiterName | undefined,
): DelimiterChoice {
  if (requested !== undefined) {
    return { delimiter: requested, delimiterSource: "explicit" };
  }
  const lines = sniffLines(text).filter((line) => line !== "");
  if (lines.length === 0) {
    return { delimiter: "comma", delimiterSource: "default" };
  }
  const scored = (Object.keys(delimiterNames) as DelimiterName[]).map(
    (name) => ({
      name,
      score: scoreCandidate(lines, delimiterNames[name]),
    }),
  );
  const best = scored.reduce((top, entry) =>
    entry.score > top.score ? entry : top,
  );
  if (best.score <= 0) {
    return { delimiter: "comma", delimiterSource: "default" };
  }
  const tied = scored.filter((entry) => entry.score === best.score);
  if (tied.length > 1) {
    throw new SezzleeExcelError(
      "ambiguous_delimiter",
      `${tied.map((entry) => `'${entry.name}'`).join(" and ")} are equally consistent in the first ${limits.csvSniffLines} lines.`,
      "Pass delimiter explicitly: 'comma', 'semicolon', 'tab' or 'pipe'.",
    );
  }
  return { delimiter: best.name, delimiterSource: "sniffed" };
}

function malformed(path: string, reason: string): SezzleeExcelError {
  return new SezzleeExcelError(
    "corrupt_workbook",
    `'${path}' is not well-formed CSV: ${reason}.`,
    "Check the quoting around the reported line and re-save the file.",
  );
}

function faultError(fault: CsvFault, path: string): SezzleeExcelError {
  switch (fault.kind) {
    case "too_many_columns":
      return new SezzleeExcelError(
        "file_too_large",
        `A CSV record exceeds ${limits.maxCsvColumns} fields.`,
        "Read a narrower file, or split it.",
      );
    case "too_many_cells":
      return new SezzleeExcelError(
        "file_too_large",
        `The file holds more than ${limits.maxCsvCells} cells.`,
        "Read a narrower file, or split it.",
      );
    case "stray_quote":
      return malformed(
        path,
        `a quote inside an unquoted field on line ${fault.line}`,
      );
    case "text_after_quote":
      return malformed(
        path,
        `text after a closing quote on line ${fault.line}`,
      );
    case "unclosed_quote":
      return malformed(
        path,
        `a quote opened on line ${fault.line} never closes`,
      );
    default: {
      const _exhaustive: never = fault;
      return _exhaustive;
    }
  }
}

/**
 * Guard: counts the cells LibreOffice 26.8.1 runs as formulas when it opens a
 * CSV with formula evaluation on: `=` followed by anything. A `+`, `-` or `@`
 * prefix stays text there, and 256,000 corpus cells start with `-` as a number
 * or a dash, so counting OWASP's wider prefix list would bury the signal.
 * Excel has not been measured.
 */
function isFormulaLike(field: string): boolean {
  return field.length > 1 && field.startsWith("=");
}

export async function parseCsv(
  bytes: Buffer,
  sizeBytes: number,
  options: CsvOptions,
  path: string,
): Promise<CsvTable> {
  if (sizeBytes > limits.maxCsvBytes) {
    throw new SezzleeExcelError(
      "file_too_large",
      `The file is ${sizeBytes} bytes; the CSV limit is ${limits.maxCsvBytes}.`,
      "Split the file or read a smaller one.",
    );
  }
  const decoded = decode(bytes, options.encoding, path);
  if (!decoded.encoding.startsWith("utf-16")) {
    assertNoNulBytes(bytes, path);
  }
  const choice = sniffDelimiter(decoded.text, options.delimiter);
  const parsed = readRecords(decoded.text, delimiterNames[choice.delimiter], {
    maxColumns: limits.maxCsvColumns,
    maxCells: limits.maxCsvCells,
  });
  if (parsed.kind === "fault") throw faultError(parsed.fault, path);

  let blankRecordCount = 0;
  const rows: string[][] = parsed.records.map((record) => {
    if (record.length === 1 && record[0] === "") {
      blankRecordCount += 1;
      return [];
    }
    return record;
  });

  const columnCount = rows.reduce(
    (widest, record) => Math.max(widest, record.length),
    0,
  );
  const headerLength = rows[0]?.length ?? 0;
  let raggedRecordCount = 0;
  let formulaLikeCellCount = 0;
  for (const record of rows) {
    if (record.length !== headerLength && record.length !== 0) {
      raggedRecordCount += 1;
    }
    for (const field of record) {
      if (isFormulaLike(field)) {
        formulaLikeCellCount += 1;
      }
    }
  }

  const headers = rows[0] ?? [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const header of headers) {
    if (header === "") {
      continue;
    }
    if (seen.has(header)) {
      duplicates.add(header);
    }
    seen.add(header);
  }

  const bounds: GridBounds | undefined =
    rows.length === 0 || columnCount === 0
      ? undefined
      : { top: 1, left: 1, bottom: rows.length, right: columnCount };

  return {
    rows,
    bounds,
    report: {
      delimiter: choice.delimiter,
      delimiterSource: choice.delimiterSource,
      encoding: decoded.encoding,
      encodingSource: decoded.encodingSource,
      hadBom: decoded.hadBom,
      lineBreak: parsed.lineBreak,
      recordCount: rows.length,
      columnCount,
      raggedRecordCount,
      blankRecordCount,
      ...(rows[0]?.length === 0
        ? {
            warnings: [
              "The first CSV record is blank and remains the default header. Physical records are preserved; pass headerRow to select a different header.",
            ],
          }
        : {}),
      formulaLikeCellCount,
      ...(duplicates.size > 0 ? { duplicateHeaders: [...duplicates] } : {}),
    },
  };
}

export function csvSheetView(table: CsvTable): SheetView {
  return {
    name: csvSheetName,
    bounds: table.bounds,
    merges: [],
    tables: [],
    autoFilter: undefined,
    rowAt(row): RowView | undefined {
      const record = table.rows[row - 1];
      if (record === undefined) {
        return undefined;
      }
      return {
        cellAt(column): CellSnapshot | undefined {
          const field = record[column - 1];
          if (field === undefined) {
            return undefined;
          }
          return { merged: false, value: { value: field } };
        },
        populatedColumns: ({ from, to }) => presentIndices(record, from, to),
      };
    },
    populatedRows: ({ from, to }) => presentIndices(table.rows, from, to),
  };
}

export function describeCsv(
  table: CsvTable,
  meta: DocumentMeta,
): WorkbookDescription {
  const bounds = table.bounds;
  return {
    filePath: meta.filePath,
    sizeBytes: meta.sizeBytes,
    modifiedAt: meta.modifiedAt,
    dateSystem: null,
    sheets: [
      {
        name: csvSheetName,
        index: 1,
        state: "visible",
        kind: "worksheet",
        usedRange:
          bounds === undefined
            ? null
            : `A1:${columnToLetters(bounds.right)}${bounds.bottom}`,
        rowCount: bounds === undefined ? 0 : bounds.bottom,
        columnCount: bounds === undefined ? 0 : bounds.right,
        declaredRowCount: null,
        declaredColumnCount: null,
        mergeCount: null,
        dataValidationRuleCount: null,
        dataValidationRuleCountExact: false,
        formulaCellCount: null,
        cachedFormulaValueCount: null,
        tableCount: null,
        conditionalFormatRuleCount: null,
        imageCount: null,
        imageCountExact: false,
        chartCount: null,
        autoFilterRef: null,
        frozenRowCount: null,
        frozenColumnCount: null,
      },
    ],
    ...(bounds !== undefined && bounds.bottom > limits.guidanceRowThreshold
      ? {
          guidance: `The table has ${bounds.bottom} records. Use aggregate_sheet for totals and rankings, find_in_sheet to locate a value, or read_sheet with a narrow range.`,
        }
      : {}),
  };
}
