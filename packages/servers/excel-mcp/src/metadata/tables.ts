import { limits } from "../platform/limits.js";
import type { OoxmlTable, OoxmlTableColumn } from "./spreadsheetml/tables.js";
import { columnToLetters, parseCellRef } from "../grid/range.js";
import type { DeclaredTable } from "../grid/sheet.js";

export interface TableColumnDetail {
  readonly name: string | null;
  readonly letter?: string;
  readonly totalsRowFunction?: string;
  readonly totalsRowLabel?: string;
  readonly filterButton?: boolean;
}

export interface DeclaredTableDetail {
  readonly name: string;
  readonly displayName?: string;
  readonly ref: string;
  readonly headerRow: boolean;
  readonly totalsRow: boolean;
  readonly autoFilterRef?: string;
  readonly columns: readonly TableColumnDetail[];
  readonly columnsTruncated: boolean;
}

export interface TableReport {
  readonly sheet: string;
  readonly count: number;
  readonly tables: readonly DeclaredTableDetail[];
  readonly truncated: boolean;
  readonly truncationReason?: "maxTablesPerSheet";
  readonly hint?: string;
  readonly warnings?: readonly string[];
}

export function declaredTablesOf(
  tables: readonly OoxmlTable[],
): DeclaredTable[] {
  return tables.map((table) => ({
    name: table.name,
    displayName: table.displayName,
    ref: table.ref,
    headerRow: table.headerRow,
    totalsRow: table.totalsRow,
    headerRowCount: table.headerRowCount,
    totalsRowCount: table.totalsRowCount,
    ...(table.autoFilterRef === undefined
      ? {}
      : { autoFilterRef: table.autoFilterRef }),
    columns: table.columns.map((column) => column.name ?? null),
  }));
}

interface Origin {
  readonly row: number;
  readonly left: number;
  readonly right: number;
}

function originOf(ref: string): Origin | undefined {
  const [start, end] = ref.split(":");
  if (start === undefined) {
    return undefined;
  }
  const topLeft = parseCellRef(start);
  const bottomRight = end === undefined ? topLeft : parseCellRef(end);
  return {
    row: topLeft.row,
    left: topLeft.column,
    right: bottomRight.column,
  };
}

function columnDetail(
  column: OoxmlTableColumn,
  offset: number,
  origin: Origin | undefined,
  totalsRow: boolean,
): TableColumnDetail {
  const index = origin === undefined ? undefined : origin.left + offset;
  const letter =
    index === undefined || origin === undefined || index > origin.right
      ? undefined
      : columnToLetters(index);
  const totalsRowFunction =
    column.totalsRowFunction === undefined ||
    column.totalsRowFunction === "none"
      ? undefined
      : column.totalsRowFunction;
  return {
    name: typeof column.name === "string" ? column.name : null,
    ...(letter === undefined ? {} : { letter }),
    ...(totalsRowFunction === undefined ? {} : { totalsRowFunction }),
    ...(!totalsRow || column.totalsRowLabel === undefined
      ? {}
      : { totalsRowLabel: column.totalsRowLabel }),
    ...(column.filterButton === true ? { filterButton: true } : {}),
  };
}

function tableDetail(table: OoxmlTable): DeclaredTableDetail {
  const ref = table.ref;
  const origin = originOf(ref);
  const name = table.name;
  const totalsRow = table.totalsRow;
  const declared = table.columns;
  const columnsTruncated = declared.length > limits.maxTableColumns;
  const kept = columnsTruncated
    ? declared.slice(0, limits.maxTableColumns)
    : declared;
  return {
    name,
    ...(table.displayName === undefined || table.displayName === name
      ? {}
      : { displayName: table.displayName }),
    ref,
    headerRow: table.headerRow,
    totalsRow,
    ...(table.autoFilterRef === undefined
      ? {}
      : { autoFilterRef: table.autoFilterRef }),
    columns: kept.map((column, offset) =>
      columnDetail(column, offset, origin, totalsRow),
    ),
    columnsTruncated,
  };
}

export function collectTables(
  sheet: string,
  tables: readonly OoxmlTable[],
): TableReport {
  const ordered = [...tables].sort((left, right) => {
    const a = originOf(left.ref);
    const b = originOf(right.ref);
    if (a === undefined || b === undefined) {
      return 0;
    }
    return a.row === b.row ? a.left - b.left : a.row - b.row;
  });
  const truncated = ordered.length > limits.maxTablesPerSheet;
  const kept = truncated ? ordered.slice(0, limits.maxTablesPerSheet) : ordered;
  return {
    sheet,
    count: ordered.length,
    tables: kept.map(tableDetail),
    ...(kept.some((table) =>
      table.columns.some((column) => column.name === undefined),
    )
      ? {
          warnings: [
            "Table metadata has missing column names; null entries preserve column positions.",
          ],
        }
      : {}),
    truncated,
    ...(truncated
      ? {
          truncationReason: "maxTablesPerSheet" as const,
          hint: `${ordered.length} tables are declared on this sheet; the first ${limits.maxTablesPerSheet} are listed. Call describe_workbook for the count on every sheet.`,
        }
      : {}),
  };
}
