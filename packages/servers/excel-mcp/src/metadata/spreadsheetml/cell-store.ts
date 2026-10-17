import type { GridBounds } from "../../grid/range.js";
import type { RawCell, RawValue } from "./cells.js";
import { formulaSourcer, type FormulaSource } from "./formula-text.js";

const kinds = {
  none: 0,
  number: 1,
  string: 2,
  false: 3,
  true: 4,
  error: 5,
  date: 6,
} as const;

/**
 * Guard: a style index is only ever looked up in the cell format table, which
 * Excel caps at 64,000 entries, so an index past 32 bits is stored as the
 * largest one and still names no format.
 */
const maxStyle = 0xffff_ffff;

/** A sheet's stored cells, one typed array per field. */
export interface CellStore {
  /** @returns the cell stored at a position, or undefined. */
  indexAt(row: number, column: number): number | undefined;
  /** @returns the rows in range that store a cell, ascending. */
  rows(from: number, to: number): Iterable<number>;
  /** @returns the columns of `row` in range that store a cell, ascending. */
  columns(row: number, from: number, to: number): Iterable<number>;
  value(index: number): RawValue;
  style(index: number): number;
  formula(index: number): FormulaSource | undefined;
}

export interface StoredCells {
  readonly store: CellStore;
  /** The cells with a value or a formula. */
  readonly bounds: GridBounds | undefined;
  /** Every stored cell, empty ones included. */
  readonly stored: GridBounds | undefined;
  /** Formula cells, a cell the part stores twice counted twice. */
  readonly formulaCellCount: number;
  readonly cachedFormulaValueCount: number;
}

export interface CellStoreBuilder {
  add(cell: RawCell): void;
  finish(): StoredCells;
}

export function grownBounds(
  bounds: GridBounds | undefined,
  row: number,
  column: number,
): GridBounds {
  return bounds === undefined
    ? { top: row, left: column, bottom: row, right: column }
    : {
        top: Math.min(bounds.top, row),
        left: Math.min(bounds.left, column),
        bottom: Math.max(bounds.bottom, row),
        right: Math.max(bounds.right, column),
      };
}

function widened<A extends ArrayLike<number> & { set(source: A): void }>(
  array: A,
  make: (length: number) => A,
): A {
  const next = make(array.length * 2);
  next.set(array);
  return next;
}

/** @returns the first position in `sorted[from, to)` holding `wanted` or more. */
function lowerBound(
  sorted: Int32Array,
  wanted: number,
  from: number,
  to: number,
): number {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] ?? 0) < wanted) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Collects a sheet's cells in document order and keeps them as typed arrays.
 * A position the part stores twice keeps the cell stored last, while the
 * counts include both.
 *
 * Guard: an object per cell, with a value object of its own, took 120 to
 * 300 bytes a cell and was most of what a read workbook retained (1.1 GiB of
 * the largest corpus file's 9.4 million cells); these arrays take about 21
 * bytes.
 */
export function cellStoreBuilder(): CellStoreBuilder {
  const sourceOf = formulaSourcer();
  const texts: string[] = [];
  const formulas: FormulaSource[] = [];
  let rows = new Int32Array(1024);
  let columns = new Int32Array(1024);
  let styles = new Uint32Array(1024);
  let kindOf = new Uint8Array(1024);
  let payloads = new Float64Array(1024);
  let formulaOf = new Int32Array(1024);
  let count = 0;
  let ordered = true;
  let bounds: GridBounds | undefined;
  let stored: GridBounds | undefined;
  let formulaCellCount = 0;
  let cachedFormulaValueCount = 0;

  const encode = (value: RawValue, at: number): void => {
    switch (value.kind) {
      case "none":
        kindOf[at] = kinds.none;
        return;
      case "number":
        kindOf[at] = kinds.number;
        payloads[at] = value.value;
        return;
      case "boolean":
        kindOf[at] = value.value ? kinds.true : kinds.false;
        return;
      case "string":
      case "error":
      case "date":
        kindOf[at] = kinds[value.kind];
        payloads[at] = texts.push(value.value) - 1;
        return;
      default: {
        const _exhaustive: never = value;
        return _exhaustive;
      }
    }
  };

  const add = (cell: RawCell): void => {
    if (count === rows.length) {
      rows = widened(rows, (length) => new Int32Array(length));
      columns = widened(columns, (length) => new Int32Array(length));
      styles = widened(styles, (length) => new Uint32Array(length));
      kindOf = widened(kindOf, (length) => new Uint8Array(length));
      payloads = widened(payloads, (length) => new Float64Array(length));
      formulaOf = widened(formulaOf, (length) => new Int32Array(length));
    }
    const { row, column } = cell;
    if (count > 0) {
      const lastRow = rows[count - 1] ?? 0;
      if (
        row < lastRow ||
        (row === lastRow && column <= (columns[count - 1] ?? 0))
      )
        ordered = false;
    }
    rows[count] = row;
    columns[count] = column;
    styles[count] = Math.min(cell.style, maxStyle);
    encode(cell.value, count);
    const source = sourceOf(cell);
    formulaOf[count] = source === undefined ? -1 : formulas.push(source) - 1;
    if (source !== undefined) {
      formulaCellCount += 1;
      if (cell.value.kind !== "none") cachedFormulaValueCount += 1;
    }
    if (source !== undefined || cell.value.kind !== "none") {
      bounds = grownBounds(bounds, row, column);
    }
    stored = grownBounds(stored, row, column);
    count += 1;
  };

  /**
   * @returns the cells to keep, by position, each position's last; undefined
   *   when the part stored them in order already, which is the usual case.
   */
  const keptOrder = (): Int32Array | undefined => {
    if (ordered) return undefined;
    const order = new Int32Array(count);
    for (let index = 0; index < count; index += 1) order[index] = index;
    order.sort(
      (a, b) =>
        (rows[a] ?? 0) - (rows[b] ?? 0) ||
        (columns[a] ?? 0) - (columns[b] ?? 0) ||
        a - b,
    );
    const kept = new Int32Array(count);
    let length = 0;
    for (let at = 0; at < count; at += 1) {
      const index = order[at] ?? 0;
      const next = order[at + 1];
      if (
        next !== undefined &&
        rows[next] === rows[index] &&
        columns[next] === columns[index]
      ) {
        continue;
      }
      kept[length] = index;
      length += 1;
    }
    return kept.slice(0, length);
  };

  const finish = (): StoredCells => {
    const order = keptOrder();
    const length = order?.length ?? count;
    const at = (position: number): number =>
      order === undefined ? position : (order[position] ?? 0);
    const cellColumns = new Int32Array(length);
    const cellStyles = new Uint32Array(length);
    const cellKinds = new Uint8Array(length);
    const cellPayloads = new Float64Array(length);
    const cellFormulas = new Int32Array(length);
    const rowNumbers: number[] = [];
    const rowStarts: number[] = [];
    for (let position = 0; position < length; position += 1) {
      const index = at(position);
      const row = rows[index] ?? 0;
      if (rowNumbers.at(-1) !== row) {
        rowNumbers.push(row);
        rowStarts.push(position);
      }
      cellColumns[position] = columns[index] ?? 0;
      cellStyles[position] = styles[index] ?? 0;
      cellKinds[position] = kindOf[index] ?? kinds.none;
      cellPayloads[position] = payloads[index] ?? 0;
      cellFormulas[position] = formulaOf[index] ?? -1;
    }
    rowStarts.push(length);
    const rowIndex = Int32Array.from(rowNumbers);
    const starts = Int32Array.from(rowStarts);
    /**
     * Guard: the store's methods close over this builder's scope, so the
     * arrays it grew while collecting, up to twice the cells, would live as
     * long as the store unless they are let go here.
     */
    rows = new Int32Array(0);
    columns = new Int32Array(0);
    styles = new Uint32Array(0);
    kindOf = new Uint8Array(0);
    payloads = new Float64Array(0);
    formulaOf = new Int32Array(0);

    const rowSpan = (row: number): readonly [number, number] | undefined => {
      const slot = lowerBound(rowIndex, row, 0, rowIndex.length);
      if (rowIndex[slot] !== row) return undefined;
      return [starts[slot] ?? 0, starts[slot + 1] ?? 0];
    };

    const store: CellStore = {
      indexAt(row, column) {
        const span = rowSpan(row);
        if (span === undefined) return undefined;
        const found = lowerBound(cellColumns, column, span[0], span[1]);
        return found < span[1] && cellColumns[found] === column
          ? found
          : undefined;
      },
      *rows(from, to) {
        for (
          let slot = lowerBound(rowIndex, from, 0, rowIndex.length);
          slot < rowIndex.length && (rowIndex[slot] ?? 0) <= to;
          slot += 1
        ) {
          yield rowIndex[slot] ?? 0;
        }
      },
      *columns(row, from, to) {
        const span = rowSpan(row);
        if (span === undefined) return;
        for (
          let position = lowerBound(cellColumns, from, span[0], span[1]);
          position < span[1] && (cellColumns[position] ?? 0) <= to;
          position += 1
        ) {
          yield cellColumns[position] ?? 0;
        }
      },
      value(index) {
        const payload = cellPayloads[index] ?? 0;
        switch (cellKinds[index]) {
          case kinds.number:
            return { kind: "number", value: payload };
          case kinds.string:
            return { kind: "string", value: texts[payload] ?? "" };
          case kinds.error:
            return { kind: "error", value: texts[payload] ?? "" };
          case kinds.date:
            return { kind: "date", value: texts[payload] ?? "" };
          case kinds.true:
            return { kind: "boolean", value: true };
          case kinds.false:
            return { kind: "boolean", value: false };
          default:
            return { kind: "none" };
        }
      },
      style(index) {
        return cellStyles[index] ?? 0;
      },
      formula(index) {
        const reference = cellFormulas[index] ?? -1;
        return reference === -1 ? undefined : formulas[reference];
      },
    };
    return {
      store,
      bounds,
      stored,
      formulaCellCount,
      cachedFormulaValueCount,
    };
  };

  return { add, finish };
}
