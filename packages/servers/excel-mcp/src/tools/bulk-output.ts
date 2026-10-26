import {
  createAuthoredWorkbook,
  serializeAuthoredWorkbook,
} from "../format/authoring.js";
import { applyWorkbookChanges } from "../format/edit-workbook.js";
import { resizeBulkTable } from "../format/bulk-table.js";
import { parseOoxml, ooxmlSheetView } from "../format/ooxml-workbook.js";
import { parseCellRef, formatCellRef, maxRow } from "../grid/range.js";
import { sameWriteValue } from "../authoring/bulk-key.js";
import { asciiLower } from "@sezzlee/file-core";
import type { WriteCell } from "../authoring/values.js";
import type { EditChange } from "../authoring/edit.js";
import type { WorkbookSnapshot } from "../platform/versions.js";
import type { TransferData } from "./transfer.js";
import type { BulkGroup, BulkStep } from "./bulk-job-schemas.js";
import { bulkJobLimits } from "./bulk-job-schemas.js";
import {
  bulkBudget,
  bulkInvalid,
  type BulkDataset,
  type BulkRow,
} from "./bulk-dataset.js";

export interface BulkReadBinding {
  readonly step: Extract<BulkStep, { kind: "read" }>;
  readonly snapshot: WorkbookSnapshot;
  readonly transfer: TransferData;
  readonly data: BulkDataset;
}
export interface BulkRenderedOutput {
  readonly id: string;
  readonly bytes: Buffer;
  readonly recalculationRequired: boolean;
  readonly refreshRequired: readonly string[];
}
type Block = { row: number; column: number; values: WriteCell[][] };
function exactCell(row: BulkRow, column: number): WriteCell {
  const value = row.cells[column];
  if (value === undefined) bulkInvalid("Missing bulk output cell.");
  return value;
}

export function renderBulkOutput(
  output: BulkGroup["outputs"][number],
  datasets: ReadonlyMap<string, BulkDataset>,
  reads: ReadonlyMap<string, BulkReadBinding>,
): BulkRenderedOutput {
  function get(id: string): BulkDataset {
    const data = datasets.get(id);
    if (data === undefined) bulkInvalid(`Unknown output step '${id}'.`);
    return data;
  }
  if (output.kind === "new") {
    const created = createAuthoredWorkbook(
      output.sheets.map((sheet) => {
        const data = get(sheet.input);
        return {
          name: sheet.name,
          blocks: [
            {
              startCell: "A1",
              values: [
                data.headers.map((value): WriteCell => ({
                  kind: "text",
                  value,
                })),
                ...data.rows.map((row) => [...row.cells]),
              ],
            },
          ],
        };
      }),
    );
    return {
      id: output.id,
      bytes: serializeAuthoredWorkbook(created.workbook),
      recalculationRequired: false,
      refreshRequired: [],
    };
  }
  if (output.kind === "edit_workbook") {
    let bytes: Buffer | undefined,
      sourceVersion: string | undefined,
      recalculationRequired = false;
    const sheets = new Set<string>(),
      refreshRequired = new Set<string>();
    for (const change of output.changes) {
      const original = reads.get(change.target);
      if (original === undefined)
        bulkInvalid("A combined edit target must name an original read.");
      const identity = JSON.stringify(original.snapshot.version);
      if (sourceVersion !== undefined && sourceVersion !== identity)
        bulkInvalid(
          "Combined workbook edits must select one exact source version.",
        );
      if (sheets.has(original.transfer.summary.sheet))
        bulkInvalid(
          "Combine same-sheet data changes into one pipeline before writing; separate sheet targets must be disjoint.",
        );
      sourceVersion = identity;
      sheets.add(original.transfer.summary.sheet);
      const current = new Map(reads);
      current.set(change.target, {
        ...original,
        snapshot: {
          ...original.snapshot,
          bytes: bytes ?? original.snapshot.bytes,
        },
      });
      const result = renderBulkOutput(
        { kind: "edit", id: output.id, ...change },
        datasets,
        current,
      );
      bytes = result.bytes;
      recalculationRequired ||= result.recalculationRequired;
      for (const value of result.refreshRequired) refreshRequired.add(value);
    }
    if (bytes === undefined) bulkInvalid("Combined edits must not be empty.");
    return {
      id: output.id,
      bytes,
      recalculationRequired,
      refreshRequired: [...refreshRequired],
    };
  }
  const target = reads.get(output.target);
  if (
    target === undefined ||
    !asciiLower(target.step.source.filePath).endsWith(".xlsx")
  )
    bulkInvalid("Editing requires an original .xlsx read step as target.");
  const selection = target.step.selection;
  if (
    selection.where !== undefined ||
    selection.visibleOnly === true ||
    selection.scope.kind !== "all" ||
    selection.selectColumns !== undefined ||
    selection.columns !== undefined
  )
    bulkInvalid(
      "An edit target must be a complete unconverted list selection.",
    );
  const data = get(output.input),
    original = target.data;
  const source = parseOoxml(
    target.snapshot.bytes,
    target.snapshot.version.filePath,
  );
  const view = ooxmlSheetView(source, target.transfer.summary.sheet);
  const [first, last] = target.transfer.summary.range.split(":");
  const start = parseCellRef(first ?? ""),
    end = parseCellRef(last ?? first ?? "");
  const headerRow = selection.headerRow;
  const changes: EditChange[] = [];
  let tableResize: number | undefined;
  const originalRows = new Map(
    original.rows.flatMap((row) =>
      row.origin === null ? [] : [[row.origin, row] as const],
    ),
  );
  function occupied(row: number, column: number): boolean {
    const value = view.rowAt(row)?.cellAt(column);
    return (
      value !== undefined &&
      (value.formula !== undefined || value.value !== null)
    );
  }
  if (output.mode === "replace_values") {
    if (data.headers.length > end.column - start.column + 1)
      bulkInvalid("Replacement columns exceed the selected target extent.");
    if (!output.overwrite)
      bulkInvalid("Whole-list replacement requires explicit overwrite.");
    const bottom = headerRow + data.rows.length;
    if (bottom > maxRow)
      bulkInvalid("The replacement exceeds worksheet bounds.");
    if (
      selection.table !== undefined &&
      (data.headers.length !== original.headers.length ||
        data.headers.some((name, i) => name !== original.headers[i]))
    )
      bulkInvalid(
        "Table replacement must preserve its declared column names and width.",
      );
    if (bottom > end.row)
      for (let row = end.row + 1; row <= bottom; row++)
        for (
          let col = start.column;
          col < start.column + data.headers.length;
          col++
        )
          if (occupied(row, col))
            bulkInvalid(
              "List expansion would overwrite content outside its selected extent.",
            );
    changes.push({
      kind: "write_cells",
      sheetName: view.name,
      startCell: formatCellRef(headerRow, start.column),
      overwrite: true,
      values: [
        data.headers.map((value): WriteCell => ({ kind: "text", value })),
        ...data.rows.map((row) => [...row.cells]),
      ],
    });
    if (bottom < end.row)
      changes.push({
        kind: "clear_contents",
        sheetName: view.name,
        range: `${formatCellRef(bottom + 1, start.column)}:${formatCellRef(end.row, end.column)}`,
      });
    if (data.headers.length < end.column - start.column + 1)
      changes.push({
        kind: "clear_contents",
        sheetName: view.name,
        range: `${formatCellRef(headerRow, start.column + data.headers.length)}:${formatCellRef(Math.min(bottom, end.row), end.column)}`,
      });
    if (selection.table !== undefined && bottom !== end.row)
      tableResize = data.rows.length;
  } else {
    if (
      data.kind !== "bound" ||
      data.basis !== output.target ||
      data.replacement
    )
      bulkInvalid(
        "Changed-value editing requires the original target identity; use explicit replace_values for a replacement dataset.",
      );
    if (
      data.headers.length !== original.headers.length ||
      data.headers.some((h, i) => h !== original.headers[i])
    )
      bulkInvalid(
        "Header projection or renaming requires explicit replace_values.",
      );
    let prior = 0,
      appendedSeen = false;
    const changed = new Map<number, Map<number, WriteCell>>();
    const appended = data.rows.filter((row) => row.origin === null);
    for (const row of data.rows) {
      if (row.origin === null) {
        appendedSeen = true;
        continue;
      }
      if (appendedSeen)
        bulkInvalid(
          "Reordering appended records requires explicit replace_values.",
        );
      if (row.origin <= prior)
        bulkInvalid(
          "Reordering records requires explicit replace_values; changed_values never silently ignores sorting.",
        );
      prior = row.origin;
      const baseline = originalRows.get(row.origin);
      if (baseline === undefined)
        bulkInvalid("A target record has no original row identity.");
      for (let col = 0; col < data.headers.length; col++) {
        const next = exactCell(row, col),
          old = exactCell(baseline, col);
        if (sameWriteValue(next, old)) continue;
        if (!output.overwrite && occupied(row.origin, start.column + col))
          bulkInvalid(
            "Changing an occupied target requires explicit overwrite.",
          );
        let rows = changed.get(col);
        if (rows === undefined) {
          rows = new Map();
          changed.set(col, rows);
        }
        rows.set(row.origin, next);
      }
    }
    const blocks: Block[] = [];
    for (const [column, rows] of changed) {
      const offsets = [...rows.keys()].sort((a, b) => a - b),
        top = offsets[0],
        bottom = offsets.at(-1);
      if (top === undefined || bottom === undefined) continue;
      let block: Block | undefined;
      for (let row = top; row <= bottom; row++) {
        const next = rows.get(row),
          snapshot = view.rowAt(row)?.cellAt(start.column + column);
        if (next === undefined && snapshot?.formula !== undefined) {
          block = undefined;
          continue;
        }
        if (block === undefined) {
          block = { row, column: start.column + column, values: [] };
          blocks.push(block);
        }
        const baseline = originalRows.get(row);
        block.values.push([
          next ??
            (baseline === undefined
              ? { kind: "blank" }
              : exactCell(baseline, column)),
        ]);
      }
    }
    const coalesced: Block[] = [];
    for (const block of blocks.sort(
      (a, b) =>
        a.row - b.row ||
        a.values.length - b.values.length ||
        a.column - b.column,
    )) {
      const previous = coalesced.at(-1);
      if (
        previous !== undefined &&
        previous.row === block.row &&
        previous.values.length === block.values.length &&
        previous.column + (previous.values[0]?.length ?? 0) === block.column
      ) {
        for (const [i, row] of previous.values.entries())
          row.push(...(block.values[i] ?? []));
      } else coalesced.push(block);
    }
    for (const block of coalesced)
      changes.push({
        kind: "write_cells",
        sheetName: view.name,
        startCell: formatCellRef(block.row, block.column),
        values: block.values,
        overwrite: true,
      });
    if (appended.length > 0) {
      const bottom = end.row + appended.length;
      if (bottom > maxRow) bulkInvalid("Upsert exceeds worksheet rows.");
      for (let row = end.row + 1; row <= bottom; row++)
        for (let col = start.column; col <= end.column; col++)
          if (occupied(row, col))
            bulkInvalid(
              "Upsert expansion collides with content outside the target list.",
            );
      changes.push({
        kind: "write_cells",
        sheetName: view.name,
        startCell: formatCellRef(end.row + 1, start.column),
        values: appended.map((row) => [...row.cells]),
        overwrite: false,
      });
      if (selection.table !== undefined)
        tableResize = end.row - headerRow + appended.length;
    }
    const removed = [...new Set(data.removedRows)].sort((a, b) => b - a);
    if (removed.length > 0) {
      for (const row of removed) {
        const originalRow = view.rowAt(row);
        if (originalRow !== undefined)
          for (const column of originalRow.populatedColumns({
            from: 1,
            to: 16_384,
            withCovered: true,
          }))
            if (column < start.column || column > end.column)
              bulkInvalid(
                "Physical row deletion would remove content outside the selected list columns.",
              );
      }
      const ranges: { at: number; count: number }[] = [];
      for (const row of removed) {
        const range = ranges.at(-1);
        if (range !== undefined && row === range.at - 1) {
          range.at = row;
          range.count += 1;
        } else ranges.push({ at: row, count: 1 });
      }
      for (const range of ranges)
        changes.push({ kind: "delete_rows", sheetName: view.name, ...range });
      if (selection.table !== undefined)
        tableResize =
          appended.length > 0
            ? end.row - headerRow + appended.length - removed.length
            : undefined;
    }
  }
  if (changes.length > bulkJobLimits.maxExpandedChanges)
    bulkBudget(
      "The bulk edit exceeds its expanded change budget; no output was published.",
    );
  if (changes.length === 0)
    return {
      id: output.id,
      bytes: target.snapshot.bytes,
      recalculationRequired: false,
      refreshRequired: [],
    };
  const edited = applyWorkbookChanges(target.snapshot.bytes, changes);
  const bytes =
    tableResize === undefined
      ? edited.bytes
      : resizeBulkTable(
          edited.bytes,
          view.name,
          selection.table ?? "",
          tableResize,
        );
  return {
    id: output.id,
    bytes,
    recalculationRequired: edited.editing?.recalculationRequired ?? false,
    refreshRequired: [
      ...(edited.editing?.refreshRequired ?? []),
      ...(tableResize === undefined ? [] : ["filters"]),
    ],
  };
}
