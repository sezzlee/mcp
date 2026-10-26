import type { WriteCell } from "./values.js";

export function canonicalWriteValue(
  cell: WriteCell,
): string | number | boolean | null {
  switch (cell.kind) {
    case "blank":
      return null;
    case "datetime":
      return cell.value.replace(/\.([0-9]*?)0+$/, (_match, fraction: string) =>
        fraction === "" ? "" : `.${fraction}`,
      );
    case "text":
    case "number":
    case "boolean":
    case "date":
      return cell.value;
    default: {
      const exhaustive: never = cell;
      return exhaustive;
    }
  }
}
export function sameWriteValue(left: WriteCell, right: WriteCell): boolean {
  return (
    left.kind === right.kind &&
    canonicalWriteValue(left) === canonicalWriteValue(right)
  );
}
export function encodeBulkKey(cells: readonly WriteCell[]): string | null {
  if (
    cells.some(
      (cell) =>
        cell.kind === "blank" || (cell.kind === "text" && cell.value === ""),
    )
  )
    return null;
  return JSON.stringify(
    cells.map((cell) => [cell.kind, canonicalWriteValue(cell)]),
  );
}
