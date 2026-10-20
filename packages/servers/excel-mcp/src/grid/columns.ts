import { asciiUpper, fold } from "@sezzlee/file-core";
import { SezzleeExcelError } from "../platform/errors.js";
import { columnToLetters, type GridBounds } from "./range.js";

export type ColumnMode = "auto" | "header" | "letter";

export interface ColumnIndex {
  readonly byHeader: ReadonlyMap<string, readonly number[]>;
  readonly letters: ReadonlySet<string>;
  readonly headers: readonly (string | null)[];
  readonly bounds: GridBounds;
  readonly headerRow: number;
  readonly sheet: string;
}

export function buildColumnIndex(
  sheet: string,
  bounds: GridBounds,
  headerRow: number,
  headers: readonly (string | null)[],
): ColumnIndex {
  const byHeader = new Map<string, number[]>();
  const letters = new Set<string>();
  for (let offset = 0; offset < headers.length; offset += 1) {
    const index = bounds.left + offset;
    letters.add(columnToLetters(index));
    const header = headers[offset];
    if (header === undefined || header === null || header === "") {
      continue;
    }
    const key = fold(header);
    const slot = byHeader.get(key);
    if (slot === undefined) {
      byHeader.set(key, [index]);
    } else {
      slot.push(index);
    }
  }
  return { byHeader, letters, headers, bounds, headerRow, sheet };
}

function describeColumns(index: ColumnIndex): string {
  const named = index.headers
    .map((header, offset) =>
      header === null || header === ""
        ? null
        : `${columnToLetters(index.bounds.left + offset)} (${header})`,
    )
    .filter((entry): entry is string => entry !== null);
  const range = `${columnToLetters(index.bounds.left)}..${columnToLetters(index.bounds.right)}`;
  if (named.length === 0) {
    return index.headerRow === 0
      ? `Columns ${range} are in range; none of them has header text.`
      : `Columns ${range} are in range; row ${index.headerRow} (headerRow) has no text in any of them.`;
  }
  return `Columns ${range} are in range. Named columns: ${named.join(", ")}.`;
}

function letterOf(index: ColumnIndex, reference: string): number | undefined {
  const wanted = asciiUpper(reference.trim());
  if (!index.letters.has(wanted)) {
    return undefined;
  }
  for (let offset = 0; offset < index.headers.length; offset += 1) {
    if (columnToLetters(index.bounds.left + offset) === wanted) {
      return index.bounds.left + offset;
    }
  }
  return undefined;
}

export function resolveColumn(
  index: ColumnIndex,
  reference: string,
  mode: ColumnMode = "auto",
): number {
  const byHeader = index.byHeader.get(fold(reference));
  const byLetter = letterOf(index, reference);

  if (mode === "letter") {
    if (byLetter === undefined) throw unknownColumn(index, reference, "letter");
    return byLetter;
  }

  if (byHeader !== undefined && byHeader.length > 1) {
    throw new SezzleeExcelError(
      "ambiguous_column",
      `'${reference}' is the header of columns ${byHeader.map(columnToLetters).join(" and ")}.`,
      `Address one of them by letter: ${byHeader.map((column) => `"${columnToLetters(column)}"`).join(" or ")}.`,
    );
  }

  if (mode === "header") {
    const only = byHeader?.[0];
    if (only === undefined) {
      throw unknownColumn(index, reference, "header");
    }
    return only;
  }

  const header = byHeader?.[0];
  if (header !== undefined && byLetter !== undefined && header !== byLetter) {
    throw new SezzleeExcelError(
      "ambiguous_column",
      `'${reference}' is both the header of column ${columnToLetters(header)} and the A1 letter of column ${columnToLetters(byLetter)}.`,
      'Set columnMode to "header" or "letter".',
    );
  }
  if (header !== undefined) {
    return header;
  }
  if (byLetter !== undefined) {
    return byLetter;
  }
  throw unknownColumn(index, reference, "auto");
}

function titleBand(index: ColumnIndex): boolean {
  const named = index.headers.filter(
    (header) => header !== null && header !== "",
  );
  const [first] = index.headers;
  return (
    index.bounds.right > index.bounds.left &&
    named.length === 1 &&
    first !== undefined &&
    first !== null &&
    first !== ""
  );
}

function unknownColumn(
  index: ColumnIndex,
  reference: string,
  mode: ColumnMode,
): SezzleeExcelError {
  const scope =
    index.headerRow === 0
      ? "headerRow is 0, so only A1 letters resolve here. "
      : mode === "header"
        ? 'columnMode is "header", so only header text resolves here. '
        : mode === "letter"
          ? 'columnMode is "letter", so only A1 letters resolve here. '
          : "";
  const adjust =
    index.headerRow > 0 &&
    mode !== "letter" &&
    (index.byHeader.size === 0 || titleBand(index))
      ? " Pass headerRow to name the row that carries the column headers, or use headerScan true when the format supports it."
      : "";
  return new SezzleeExcelError(
    "unknown_column",
    `'${reference}' is not a column of ${index.sheet}.`,
    `${scope}${describeColumns(index)}${adjust}`,
  );
}
