import type { CellFacts, CellSnapshot } from "../../../src/grid/cell-value.js";
import { SezzleeExcelError } from "../../../src/platform/errors.js";
import { formatDate } from "../../../src/format/cell-date.js";

export interface SheetJsCell {
  readonly t?: string;
  readonly v?: string | number | boolean | Date;
  readonly w?: string;
  readonly f?: string;
  readonly z?: string;
  readonly l?: { readonly Target?: string };
}

/**
 * BIFF error codes as they survive into SheetJS's `v` for `t: "e"` cells.
 * A workbook written without cached error text leaves `w` unset, and an
 * unmapped code would otherwise surface as a bare number that reads like data.
 */
const errorText: Readonly<Record<number, string>> = {
  0x00: "#NULL!",
  0x07: "#DIV/0!",
  0x0f: "#VALUE!",
  0x17: "#REF!",
  0x1d: "#NAME?",
  0x24: "#NUM!",
  0x2a: "#N/A",
  0x2b: "#GETTING_DATA",
};

function factsOf(cell: SheetJsCell): CellFacts {
  const value = cell.v;
  /**
   * A `t: "z"` stub is a cell with no value. SheetJS still fills `v` with 0 on
   * a stubbed formula cell, so reading `v` here would report an uncached
   * formula as cached.
   */
  if (cell.t === "z") {
    return { value: null };
  }
  if (cell.t === "e") {
    const code = typeof value === "number" ? errorText[value] : undefined;
    return { value: { error: cell.w ?? code ?? "#ERROR!" } };
  }
  if (value === undefined || value === null) {
    return { value: null };
  }
  if (value instanceof Date) {
    return { value: formatDate(value, cell.z) };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SezzleeExcelError(
        "numeric_overflow",
        "A cell contains a non-finite number.",
      );
    }
    return { value };
  }
  if (typeof value === "boolean") {
    return { value };
  }
  return { value };
}

function withHyperlink(facts: CellFacts, cell: SheetJsCell): CellFacts {
  const href = cell.l?.Target;
  return href === undefined ? facts : { ...facts, href };
}

export function sheetjsSnapshot(
  cell: SheetJsCell,
  merged: boolean,
): CellSnapshot {
  const facts = withHyperlink(factsOf(cell), cell);
  const formula = cell.f;
  const numberFormat = cell.z;
  if (formula === undefined || formula === "") {
    return {
      merged,
      value: facts,
      ...(numberFormat === undefined ? {} : { numberFormat }),
    };
  }
  return {
    merged,
    value: { value: null },
    formula,
    ...(cell.t === "z" || (cell.v === undefined && cell.t !== "e")
      ? {}
      : { cached: facts }),
    ...(numberFormat === undefined ? {} : { numberFormat }),
  };
}
