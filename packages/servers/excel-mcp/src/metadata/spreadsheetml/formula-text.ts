import {
  columnToLetters,
  lettersToColumn,
  maxColumn,
  maxRow,
} from "../../grid/range.js";
import type { RawCell } from "./cells.js";
import { cellText } from "./shared-strings.js";

const futureFunctionPrefix = "_xlfn.";

/**
 * An A1 reference outside a quoted literal: not preceded by a name character,
 * not followed by one or by `(` — so a function such as `LOG10(` and a defined
 * name such as `Q1_total` are not cells. The pattern is SheetJS's `crefregex`
 * as fixed on its master branch (lower-case letters before a reference stop a
 * match), which is the rule Excel's own shared-formula expansion follows.
 */
const cellReference =
  /(^|[^._A-Za-z0-9])(\$?)([A-Z]{1,2}|[A-W][A-Z]{2}|X[A-E][A-Z]|XF[A-D])(\$?)(10[0-3]\d{4}|104[0-7]\d{3}|1048[0-4]\d{2}|10485[0-6]\d|104857[0-6]|[1-9]\d{0,5})(?![_.(A-Za-z0-9])/g;

/**
 * Splits a formula into the parts outside and inside quotes: string literals
 * (`"…"`, a doubled quote escapes one) and quoted sheet names (`'…'`).
 */
function segments(
  formula: string,
): readonly { readonly quoted: boolean; readonly text: string }[] {
  const parts: { quoted: boolean; text: string }[] = [];
  let quote: '"' | "'" | undefined;
  let start = 0;
  for (let index = 0; index < formula.length; index += 1) {
    const character = formula.charAt(index);
    if (character !== '"' && character !== "'") continue;
    if (quote === undefined) {
      if (index > start) {
        parts.push({ quoted: false, text: formula.slice(start, index) });
      }
      quote = character;
      start = index;
    } else if (character === quote) {
      if (formula.charAt(index + 1) === quote) {
        index += 1;
        continue;
      }
      parts.push({ quoted: true, text: formula.slice(start, index + 1) });
      quote = undefined;
      start = index + 1;
    }
  }
  if (start < formula.length) {
    parts.push({ quoted: quote !== undefined, text: formula.slice(start) });
  }
  return parts;
}

/**
 * Moves every relative A1 reference of a formula by a row and column offset,
 * as Excel does when it copies a formula; `$`-anchored parts stay. A reference
 * moved off the grid becomes `#REF!`, as in Excel.
 */
export function shiftFormula(
  formula: string,
  rows: number,
  columns: number,
): string {
  return segments(formula)
    .map(({ quoted, text }) =>
      quoted
        ? text
        : text.replace(
            cellReference,
            (
              _match,
              before: string,
              columnAnchor: string,
              letters: string,
              rowAnchor: string,
              digits: string,
            ) => {
              const column =
                columnAnchor === "$"
                  ? lettersToColumn(letters)
                  : lettersToColumn(letters) + columns;
              const row =
                rowAnchor === "$" ? Number(digits) : Number(digits) + rows;
              if (column < 1 || column > maxColumn || row < 1 || row > maxRow) {
                return `${before}#REF!`;
              }
              return `${before}${columnAnchor}${columnToLetters(column)}${rowAnchor}${row}`;
            },
          ),
    )
    .join("");
}

/**
 * Turns a formula as stored into the text Excel shows: escapes decoded as in
 * any cell string, and the `_xlfn.` prefix that functions added after Excel
 * 2007 carry in the file (`_xlfn.CONCAT`) removed — the formula bar never
 * displays it.
 *
 * Guard: the prefix is removed only outside string literals and quoted sheet
 * names, so `"_xlfn.x"` typed as text stays as typed.
 */
export function displayFormula(stored: string): string {
  return segments(cellText(stored))
    .map(({ quoted, text }) =>
      quoted ? text : text.split(futureFunctionPrefix).join(""),
    )
    .join("");
}

/** The cell that opens a shared formula group, and its display text. */
export interface SharedFormula {
  readonly text: string;
  readonly row: number;
  readonly column: number;
}

/**
 * A formula cell's display text, or for a later cell of a shared group, the
 * group it is expanded from.
 */
export type FormulaSource = string | SharedFormula;

/**
 * Builds the function that tells, cell by cell in document order, where a
 * formula cell takes its display text from. A shared formula's text is written
 * once, on the cell that opens the group; each later cell of the group gets
 * that text moved by its offset from that cell, as Excel expands it. A group
 * cell met before the cell that defines the group has no text, which is how
 * SheetJS reads it too.
 *
 * Guard: a later cell keeps its group, not its expanded text. A group member
 * costs a few bytes of compressed XML, while its text can run to 8,192
 * characters, so expanding every member up front turns a small file into
 * gigabytes; `formulaText` expands one cell when it is read.
 *
 * @returns for each cell, its formula's source, or undefined for a cell with
 *   no formula text.
 */
export function formulaSourcer(): (cell: RawCell) => FormulaSource | undefined {
  const groups = new Map<number, SharedFormula>();
  return (cell) => {
    const formula = cell.formula;
    if (formula === undefined) return undefined;
    switch (formula.kind) {
      case "normal":
      case "array":
        return formula.text === "" ? undefined : displayFormula(formula.text);
      case "shared": {
        if (formula.text === undefined) return groups.get(formula.group);
        const text = displayFormula(formula.text);
        groups.set(formula.group, { text, row: cell.row, column: cell.column });
        return text;
      }
      case "dataTable":
        return undefined;
      default: {
        const _exhaustive: never = formula;
        return _exhaustive;
      }
    }
  };
}

/** @returns the display text of the formula at `cell`. */
export function formulaText(
  source: FormulaSource,
  cell: { readonly row: number; readonly column: number },
): string {
  return typeof source === "string"
    ? source
    : shiftFormula(
        source.text,
        cell.row - source.row,
        cell.column - source.column,
      );
}
