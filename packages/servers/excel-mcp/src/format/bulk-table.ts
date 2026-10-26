import { PreservedWorkbook } from "./preserved-workbook.js";
import { selectedTable } from "./table-model.js";
import { applyTableChange, refreshTableFormulas } from "./table-authoring.js";
import { formatCellRef, maxRow } from "../grid/range.js";
import { invalidPresentation } from "./presentation-xml.js";

export function resizeBulkTable(
  bytes: Buffer,
  sheetName: string,
  tableName: string,
  records: number,
): Buffer {
  const workbook = new PreservedWorkbook(bytes),
    table = selectedTable(workbook, sheetName, tableName);
  const bottom = table.bounds.top + records + table.totalsRows;
  if (bottom > maxRow)
    invalidPresentation("The resized table exceeds worksheet bounds.");
  applyTableChange(workbook, {
    kind: "edit_table",
    sheetName,
    tableName,
    range: `${formatCellRef(table.bounds.top, table.bounds.left)}:${formatCellRef(bottom, table.bounds.right)}`,
    overwrite: true,
    clearRemovedValues: false,
  });
  refreshTableFormulas(
    workbook,
    sheetName,
    tableName,
    table.bounds.bottom - table.totalsRows + 1,
  );
  return workbook.finish(1).bytes;
}
