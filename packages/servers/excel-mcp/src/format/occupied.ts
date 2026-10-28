import { SezzleeExcelError } from "../platform/errors.js";

/**
 * Refuses a write onto a cell that already holds a value.
 *
 * Guard: told only to "choose overwrite", an agent set overwrite:true and
 * replaced cells its request asked to preserve, so the refusal names the
 * cell and puts the choice that keeps the contents first.
 * @param sheetName the sheet of the occupied cell
 * @param cell the occupied cell in A1 notation
 */
export function occupiedTarget(sheetName: string, cell: string): never {
  throw new SezzleeExcelError(
    "invalid_argument",
    `Cell ${cell} on sheet ${JSON.stringify(sheetName)} already holds a value.`,
    "Check that this is the intended target. To keep its contents, write to an empty range or a new sheet (add_sheet); set overwrite:true only when the request asks to replace them.",
  );
}
