import { maxColumn, type GridBounds } from "../grid/range.js";
import { SezzleeExcelError } from "../platform/errors.js";

export interface MergeRange extends GridBounds {
  readonly ref: string;
}

export interface MergeIndex {
  /** @returns the merges covering a row, ordered by their left column. */
  covering(row: number): readonly MergeRange[];
  /** @returns the merge that covers a cell, from a row's `covering` list. */
  at(covering: readonly MergeRange[], column: number): MergeRange | undefined;
}

function overlap(
  part: string,
  first: MergeRange,
  second: MergeRange,
): SezzleeExcelError {
  return new SezzleeExcelError(
    "corrupt_workbook",
    `'${part}' merges ${first.ref} and ${second.ref}, which overlap.`,
    "Open the file in Excel and re-save it as .xlsx.",
  );
}

/**
 * Indexes a sheet's merges by row, as an interval tree over the merges sorted
 * by their top row: each node keeps the deepest row any merge under it reaches,
 * so a row query skips every subtree that ends above it.
 *
 * Guard: merges must not overlap; Excel repairs a file whose merges do. Two
 * merges overlapping on a row are refused when that row is read, which is
 * what keeps a row's list sorted, searchable and no longer than a row is wide.
 * A query stops once it holds more merges than a row has columns, because
 * two of them must then overlap and the check that follows names them.
 */
export function mergeIndex(
  part: string,
  merges: readonly MergeRange[],
): MergeIndex {
  const sorted = [...merges].sort((a, b) => a.top - b.top);
  const reach = new Int32Array(sorted.length);
  const build = (low: number, high: number): number => {
    if (low >= high) return 0;
    const middle = (low + high) >>> 1;
    const node = sorted[middle];
    const deepest = Math.max(
      node?.bottom ?? 0,
      build(low, middle),
      build(middle + 1, high),
    );
    reach[middle] = deepest;
    return deepest;
  };
  build(0, sorted.length);
  const collect = (
    low: number,
    high: number,
    row: number,
    found: MergeRange[],
  ): void => {
    if (low >= high || found.length > maxColumn) return;
    const middle = (low + high) >>> 1;
    if ((reach[middle] ?? 0) < row) return;
    collect(low, middle, row, found);
    const node = sorted[middle];
    if (node === undefined || node.top > row) return;
    if (node.bottom >= row) found.push(node);
    collect(middle + 1, high, row, found);
  };
  return {
    covering(row) {
      const found: MergeRange[] = [];
      collect(0, sorted.length, row, found);
      found.sort((a, b) => a.left - b.left);
      for (let index = 1; index < found.length; index += 1) {
        const before = found[index - 1];
        const after = found[index];
        if (
          before !== undefined &&
          after !== undefined &&
          after.left <= before.right
        ) {
          throw overlap(part, before, after);
        }
      }
      return found;
    },
    at(covering, column) {
      let low = 0;
      let high = covering.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        const merge = covering[middle];
        if (merge === undefined || merge.left > column) high = middle;
        else low = middle + 1;
      }
      const candidate = covering[low - 1];
      return candidate !== undefined && column <= candidate.right
        ? candidate
        : undefined;
    },
  };
}

/**
 * @returns the spans merged together where they touch or overlap, in order, so
 *   walking them visits each index once.
 */
export function coalesced(
  spans: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] {
  const ordered = [...spans].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [first, last] of ordered) {
    const previous = merged.at(-1);
    if (previous !== undefined && first <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], last);
    } else {
      merged.push([first, last]);
    }
  }
  return merged;
}
