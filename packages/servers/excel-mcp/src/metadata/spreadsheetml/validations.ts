import { asciiUpper } from "@sezzlee/file-core";
import { limits } from "../../platform/limits.js";
import { serialToClock, serialToDate } from "../../grid/excel-serial.js";
import {
  lettersToColumn,
  maxColumn,
  maxRow,
  parseCellRef,
} from "../../grid/range.js";
import { namespaces, type PartScan, type XmlVisitor } from "./xml.js";

export type ValidationFormula = string | number;

export interface OoxmlValidationRule {
  readonly ranges: readonly string[];
  readonly rangesTruncated: boolean;
  readonly type: string;
  readonly operator?: string;
  readonly allowBlank?: boolean;
  readonly formulae?: readonly ValidationFormula[];
  readonly promptTitle?: string;
  readonly prompt?: string;
  readonly errorTitle?: string;
  readonly error?: string;
  readonly errorStyle?: string;
  readonly showInputMessage?: boolean;
  readonly showErrorMessage?: boolean;
}

export interface OoxmlValidations {
  readonly rules: readonly OoxmlValidationRule[];
  readonly coveredCellCount: number;
  readonly rangesTruncated: boolean;
}

interface Draft {
  readonly ranges: string[];
  readonly attributes: Record<string, unknown>;
  readonly formulae: ValidationFormula[];
  readonly type: string;
}

/**
 * ECMA-376 writes these as "1"/"0", but Excel and several generators emit
 * "true"/"false" for the same attributes; accepting only "1" silently reads
 * half the real-world corpus as false.
 */
function flag(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  return raw === "1" || raw === "true";
}

const numericLiteral = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Guard: a bound is a number only when the whole formula is one numeric
 * literal. `parseFloat` read the prefix of `45000+1` as 45000 and turned a
 * reference such as `$B$1` into NaN, which JSON writes as null, so a rule
 * reported a bound the file never declared or lost the one it did.
 */
function literal(text: string): number | undefined {
  const trimmed = text.trim();
  return numericLiteral.test(trimmed) ? Number(trimmed) : undefined;
}

/**
 * A date bound is an Excel serial with no zone: the day alone at midnight,
 * else the zoneless wall clock, never an instant with `Z`. The serial is read
 * by the same rule as a cell, so a bound and the cells it constrains name the
 * same day; serial 60, which names no day, stays the formula text.
 */
function dateFormula(text: string, date1904: boolean): ValidationFormula {
  const serial = literal(text);
  const value =
    serial === undefined ? undefined : serialToDate(serial, date1904);
  if (value === undefined) return text;
  const iso = value.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 23);
}

/** ECMA-376 leaves `operator` meaningless for these types, so none is reported. */
const operatorlessTypes = new Set(["any", "list", "custom"]);

function coerce(
  text: string,
  type: string,
  date1904: boolean,
): ValidationFormula {
  switch (type) {
    case "whole":
    case "textLength": {
      const value = literal(text);
      return value !== undefined && Number.isInteger(value) ? value : text;
    }
    case "decimal":
      return literal(text) ?? text;
    case "date":
      return dateFormula(text, date1904);
    case "time": {
      const value = literal(text);
      return (
        (value === undefined ? undefined : serialToClock(value, date1904)) ??
        text
      );
    }
    default:
      return text;
  }
}

function cleanRange(raw: string): string {
  return asciiUpper(raw.replaceAll("$", ""));
}

const wholeColumns = /^([A-Z]{1,3}):([A-Z]{1,3})$/;
const wholeRows = /^([1-9][0-9]*):([1-9][0-9]*)$/;

/**
 * Guard: a range the count cannot place adds nothing to it. The count read
 * every range as two A1 cells, so a rule on `A:A`, as openpyxl writes a whole
 * column, threw `invalid_range` — the error for the caller's own argument —
 * and with it every read of that sheet's cells, which never needed the count.
 */
function areaOf(range: string): number {
  try {
    const columns = wholeColumns.exec(range);
    if (columns !== null) {
      const first = lettersToColumn(columns[1] ?? "");
      const last = lettersToColumn(columns[2] ?? "");
      return (Math.abs(last - first) + 1) * maxRow;
    }
    const rows = wholeRows.exec(range);
    if (rows !== null) {
      const first = Number(rows[1]);
      const last = Number(rows[2]);
      if (first > maxRow || last > maxRow) return 0;
      return (Math.abs(last - first) + 1) * maxColumn;
    }
    const [start, end] = range.split(":");
    if (start === undefined) return 0;
    const from = parseCellRef(start);
    const to = end === undefined ? from : parseCellRef(end);
    return (
      (Math.abs(to.row - from.row) + 1) *
      (Math.abs(to.column - from.column) + 1)
    );
  } catch {
    return 0;
  }
}

/**
 * `sqref` is a whitespace-separated list of ranges and is already the shape the
 * report wants, so ranges are read as written rather than expanded to one
 * address per cell and recompressed. A single `A2:A1048576` rule therefore
 * costs nothing to describe, which is what removes the per-cell visit budget
 * the ExcelJS-backed path needed.
 */
function rangesOf(sqref: string | undefined): string[] {
  if (sqref === undefined) return [];
  return sqref
    .split(/\s+/)
    .filter((part) => part !== "")
    .map(cleanRange);
}

function identityOf(draft: Draft): string {
  return JSON.stringify([
    draft.type,
    draft.formulae,
    Object.entries(draft.attributes).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  ]);
}

export function validationScan(date1904: boolean): PartScan<OoxmlValidations> {
  const drafts: Draft[] = [];
  let current: Draft | undefined;
  let formulaText: string | undefined;

  const visitor: XmlVisitor = {
    onOpen(node) {
      if (node.uri !== namespaces.spreadsheetml) return;
      if (node.local === "dataValidation") {
        const declaredType = node.attr("type");
        const type = declaredType ?? "any";
        const attributes: Record<string, unknown> = {};
        const put = (name: string, value: unknown) => {
          if (value !== undefined) attributes[name] = value;
        };
        if (declaredType !== undefined) {
          put("allowBlank", flag(node.attr("allowBlank")));
        }
        put("showInputMessage", flag(node.attr("showInputMessage")));
        put("showErrorMessage", flag(node.attr("showErrorMessage")));
        if (!operatorlessTypes.has(type)) {
          put("operator", node.attr("operator") ?? "between");
        }
        put("promptTitle", node.attr("promptTitle"));
        put("prompt", node.attr("prompt"));
        put("errorStyle", node.attr("errorStyle"));
        put("errorTitle", node.attr("errorTitle"));
        put("error", node.attr("error"));
        current = {
          ranges: rangesOf(node.attr("sqref")),
          attributes,
          formulae: [],
          type,
        };
        return;
      }
      if (
        current !== undefined &&
        (node.local === "formula1" || node.local === "formula2")
      ) {
        formulaText = "";
      }
    },
    onText(text) {
      if (formulaText !== undefined) formulaText += text;
    },
    onClose(local, uri) {
      if (uri !== namespaces.spreadsheetml) return;
      if (local === "formula1" || local === "formula2") {
        if (current !== undefined && formulaText !== undefined) {
          current.formulae.push(coerce(formulaText, current.type, date1904));
        }
        formulaText = undefined;
        return;
      }
      if (local === "dataValidation" && current !== undefined) {
        if (current.formulae.length === 0) {
          delete current.attributes["operator"];
        }
        drafts.push(current);
        current = undefined;
      }
    },
  };
  return { visitor, finish: () => validationsOf(drafts) };
}

function validationsOf(drafts: readonly Draft[]): OoxmlValidations {
  const grouped = new Map<string, Draft>();
  let coveredCellCount = 0;
  for (const draft of drafts) {
    coveredCellCount += draft.ranges.reduce(
      (total, range) => total + areaOf(range),
      0,
    );
    const key = identityOf(draft);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, draft);
    } else {
      existing.ranges.push(...draft.ranges);
    }
  }

  let rangesTruncated = false;
  const rules = [...grouped.values()].map((draft): OoxmlValidationRule => {
    const truncated = draft.ranges.length > limits.maxRangesPerRule;
    rangesTruncated = rangesTruncated || truncated;
    return {
      ranges: truncated
        ? draft.ranges.slice(0, limits.maxRangesPerRule)
        : draft.ranges,
      rangesTruncated: truncated,
      type: draft.type,
      ...draft.attributes,
      ...(draft.formulae.length === 0 ? {} : { formulae: draft.formulae }),
    };
  });

  return { rules, coveredCellCount, rangesTruncated };
}
