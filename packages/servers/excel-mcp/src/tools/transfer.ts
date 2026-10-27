import { contentFingerprint } from "@sezzlee/file-core";
import type {
  TransferSelection,
  TransferTarget,
  TransferSummary,
} from "./transfer-schemas.js";
import { authoringLimits, type WorkbookChange } from "../authoring/workbook.js";
import { writeCellSchema, type WriteCell } from "../authoring/values.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { formats } from "../platform/formats.js";
import { limits } from "../platform/limits.js";
import type { WorkbookSnapshot } from "../platform/versions.js";
import { aggregateSheet } from "../grid/aggregate.js";
import {
  resolveFacts,
  type CellFacts,
  type CellSnapshot,
} from "../grid/cell-value.js";
import { buildColumnIndex, resolveColumn } from "../grid/columns.js";
import { explicitPlans, observeTyped } from "../grid/column-plans.js";
import { rawReadingFor, typedCell } from "../grid/column-reading.js";
import { readingHintsOf } from "../grid/column-spec.js";
import { evaluate, validateCondition } from "../grid/predicate.js";
import {
  formatRange,
  maxColumn,
  maxRow,
  parseCellRef,
  columnToLetters,
  resolveRange,
} from "../grid/range.js";
import { selectSheetRange, visibilityOf } from "../grid/select-sheet.js";
import { resolveHeaderRow } from "../tools/coerce.js";
import { parseCsv } from "../format/csv.js";
import { sheetSource, type LoadedDocument } from "../format/document.js";
import { parseOoxml } from "../format/ooxml-workbook.js";
import type { AuthoredWorkbook } from "../format/authoring.js";

function invalid(message: string): never {
  throw new SezzleeExcelError("invalid_argument", message);
}

function budget(message: string): never {
  throw new SezzleeExcelError("resource_limit", message);
}

function factsOf(
  snapshot: CellSnapshot | undefined,
  mergedCells: "master" | "repeat",
  counters: { cachedFormulas: number },
): CellFacts {
  if (snapshot === undefined || (snapshot.merged && mergedCells === "master"))
    return { value: null };
  if (snapshot.unsupportedRichValue !== undefined)
    invalid("The selection contains an unsupported rich value.");
  if (snapshot.formula !== undefined && snapshot.formula !== "") {
    if (snapshot.cached === undefined)
      invalid(
        "A selected formula has no saved result. Recalculate and save the source before transferring values.",
      );
    counters.cachedFormulas += 1;
  }
  return resolveFacts(snapshot, {
    valueMode: "values",
    mergePolicy: mergedCells,
  });
}

type TransferFacts = CellFacts & {
  readonly temporal?: "date" | "datetime" | "time";
};

function writeValue(facts: TransferFacts): WriteCell {
  const value = facts.value;
  const parsed = writeCellSchema.safeParse(
    value === null
      ? { kind: "blank" }
      : typeof value === "string"
        ? { kind: facts.temporal ?? "text", value }
        : typeof value === "number"
          ? { kind: "number", value }
          : typeof value === "boolean"
            ? { kind: "boolean", value }
            : { kind: "unsupported" },
  );
  if (!parsed.success)
    invalid(
      "A selected value cannot be represented by the supported value writer without loss. Errors, rich values, durations, time-only values and unsafe numbers are not transferable in this phase.",
    );
  return parsed.data;
}

async function loadSnapshot(
  snapshot: WorkbookSnapshot,
  selection: TransferSelection,
): Promise<LoadedDocument> {
  const { bytes, version } = snapshot;
  const meta = {
    stamp: contentFingerprint(version.filePath, bytes),
    sizeBytes: bytes.length,
    modifiedAt: "",
    mode: "resident" as const,
  };
  const format = formats.formatFor(version.filePath);
  if (format === "csv") {
    if (selection.table !== undefined || selection.visibleOnly === true)
      invalid("CSV transfer does not support table or visibleOnly selection.");
    return {
      ...meta,
      format,
      table: await parseCsv(bytes, bytes.length, selection, version.filePath),
    };
  }
  if (selection.delimiter !== undefined || selection.encoding !== undefined)
    invalid("delimiter and encoding are CSV-only options.");
  return { ...meta, format, workbook: parseOoxml(bytes, version.filePath) };
}

export interface TransferData {
  readonly values: WriteCell[][];
  readonly headers: readonly (string | null)[];
  readonly summary: TransferSummary;
  readonly rowNumbers?: readonly number[];
}

export async function materializeTransfer(
  snapshot: WorkbookSnapshot,
  input: TransferSelection,
  capacity: {
    readonly maxRows: number;
    readonly maxCells: number;
    readonly maxTextBytes: number;
    readonly retainRowNumbers?: boolean;
  } = {
    maxRows: authoringLimits.maxCells,
    maxCells: authoringLimits.maxCells,
    maxTextBytes: authoringLimits.maxTextBytes,
  },
): Promise<TransferData> {
  const loaded = await loadSnapshot(snapshot, input);
  const source = sheetSource(loaded);
  const selected = (() => {
    if (
      input.kind !== "range" ||
      input.range === undefined ||
      input.table !== undefined
    )
      return selectSheetRange(source, input);
    const sheet = source.sheetFor(input.sheetName);
    const rectangle = resolveRange(
      { top: 1, left: 1, bottom: maxRow, right: maxColumn },
      input.range,
    );
    const parts = input.range.split(":");
    const bounds = parts.every((part) => /^[A-Za-z]+$/.test(part))
      ? {
          ...rectangle,
          top: sheet.bounds?.top ?? 1,
          bottom: sheet.bounds?.bottom ?? 1,
        }
      : parts.every((part) => /^[0-9]+$/.test(part))
        ? {
            ...rectangle,
            left: sheet.bounds?.left ?? 1,
            right: sheet.bounds?.right ?? 1,
          }
        : rectangle;
    return { sheet, used: sheet.bounds ?? bounds, bounds };
  })();
  const { sheet, bounds } = selected;
  const width = bounds.right - bounds.left + 1;
  if (width * (bounds.bottom - bounds.top + 1) > limits.maxAggregateCellVisits)
    budget("The transfer selection exceeds its scan cell budget.");
  const header =
    input.kind === "range"
      ? {
          headerRow: input.headerRow ?? 0,
          headerRowSource: "explicit" as const,
        }
      : resolveHeaderRow(loaded, input);
  const mergedCells = input.mergedCells ?? "master";
  const counters = { cachedFormulas: 0 };
  let currentRow = -1;
  const rowFormulas = new Set<number>();
  const headerFormulas = new Set<number>();
  /**
   * Guard: data rows are visited in source order after a single header read.
   * Only the header and current row need deduplication, bounding bookkeeping
   * while counting a formula used by a predicate and the output once.
   */
  function readFacts(row: number, column: number): TransferFacts {
    const observed = { cachedFormulas: 0 };
    const facts = factsOf(
      sheet.rowAt(row)?.cellAt(column),
      mergedCells,
      observed,
    );
    if (row !== currentRow) {
      currentRow = row;
      rowFormulas.clear();
    }
    const seen = row === header.headerRow ? headerFormulas : rowFormulas;
    if (observed.cachedFormulas > 0 && !seen.has(column)) {
      seen.add(column);
      counters.cachedFormulas += 1;
    }
    if (loaded.format === "csv" || typeof facts.value !== "string")
      return facts;
    const rawSheet = loaded.workbook.sheet(sheet.name);
    const merge = rawSheet.mergeIndex.at(
      rawSheet.mergeIndex.covering(row),
      column,
    );
    const slot = rawSheet.cells.indexAt(
      merge?.top ?? row,
      merge?.left ?? column,
    );
    if (slot === undefined) return facts;
    const raw = rawSheet.cells.value(slot);
    if (raw.kind !== "date" && raw.kind !== "number") return facts;
    if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(facts.value))
      return {
        ...facts,
        temporal: facts.value.includes("T") ? "datetime" : "date",
      };
    if (/^\d{2}:\d{2}:\d{2}/.test(facts.value))
      return { ...facts, temporal: "time" };
    return facts;
  }
  const headerValues = Array.from({ length: width }, (_, offset) => {
    const value = readFacts(header.headerRow, bounds.left + offset).value;
    return value === null || typeof value === "object" ? null : String(value);
  });
  const headers =
    selected.declared === undefined
      ? headerValues
      : [...selected.declared.columns];
  const index = buildColumnIndex(sheet.name, bounds, header.headerRow, headers);
  const columnMode = input.columnMode ?? "auto";
  const plans = explicitPlans(
    index,
    input.columns,
    columnMode,
    readingHintsOf(input),
  );
  const values: WriteCell[][] = [];
  const rowNumbers: number[] = [];
  let textBytes = 0;
  function addRow(row: WriteCell[]): void {
    if (values.length + 1 > capacity.maxRows)
      budget("The selection exceeds its record budget.");
    if ((values.length + 1) * row.length > capacity.maxCells)
      budget("The selection exceeds its cell budget, including headers.");
    for (const cell of row) {
      if (cell.kind === "text") textBytes += Buffer.byteLength(cell.value);
      if (textBytes > capacity.maxTextBytes)
        budget("The selection exceeds its text byte budget.");
    }
    values.push(row);
  }
  const visibility =
    input.visibleOnly === true
      ? visibilityOf(
          selected,
          input.kind === "range"
            ? bounds.top
            : Math.max(bounds.top, header.headerRow + 1),
          bounds.bottom,
        )
      : undefined;
  function converted(row: number, column: number): WriteCell {
    const facts = readFacts(row, column);
    const plan = plans.get(column);
    if (plan === undefined) return writeValue(facts);
    const observation = observeTyped(facts.value, plan);
    if (observation.status === "missing") return { kind: "blank" };
    if (observation.status !== "read")
      invalid("A selected cell does not satisfy its explicit column type.");
    const temporal =
      plan.spec.type === "date"
        ? typeof observation.value === "string" &&
          observation.value.includes("T")
          ? "datetime"
          : "date"
        : plan.spec.type === "time"
          ? "time"
          : undefined;
    return writeValue({
      value: observation.value,
      ...(temporal === undefined ? {} : { temporal }),
    });
  }
  if (input.kind === "aggregate") {
    if (
      [...plans.values()].some(
        (plan) => plan.spec.type === "time" || plan.spec.type === "duration",
      )
    )
      invalid(
        "Time-only and duration column readings are not transferable in this phase.",
      );
    const referenced = new Set<number>();
    for (const group of input.groupBy ?? [])
      referenced.add(
        resolveColumn(
          index,
          typeof group === "string" ? group : group.column,
          columnMode,
        ),
      );
    for (const metric of input.metrics) {
      if (metric.column !== undefined)
        referenced.add(resolveColumn(index, metric.column, columnMode));
      for (const condition of metric.where ?? [])
        referenced.add(resolveColumn(index, condition.column, columnMode));
    }
    for (const condition of input.where ?? [])
      referenced.add(resolveColumn(index, condition.column, columnMode));
    for (const row of sheet.populatedRows({
      from: Math.max(bounds.top, header.headerRow + 1),
      to: bounds.bottom,
      withCovered: mergedCells === "repeat",
    })) {
      if (input.visibleOnly === true && sheet.hiddenRows.has(row)) continue;
      for (const column of referenced) writeValue(readFacts(row, column));
    }
    const result = aggregateSheet(source, {
      ...input,
      ...header,
      columnMode,
      caseSensitive: input.caseSensitive ?? false,
      mergedCells,
      orderBy: input.orderBy ?? "group",
      descending: input.descending ?? false,
      maxGroups: limits.maxAggregateGroups,
    });
    if (result.truncated)
      budget(
        "The aggregate is incomplete and cannot be transferred as a complete result.",
      );
    const labels = result.columns.map((column) => column.label);
    addRow(labels.map((value) => writeValue({ value })));
    for (const row of result.rows)
      addRow(
        row.map((value, offset) => {
          const descriptor = result.columns[offset];
          const groupPlan =
            descriptor?.role === "group" &&
            descriptor.letter !== undefined &&
            descriptor.by === undefined &&
            descriptor.bins === undefined &&
            descriptor.width === undefined
              ? plans.get(resolveColumn(index, descriptor.letter, "letter"))
              : undefined;
          const date =
            descriptor?.kindUsed === "date" || groupPlan?.spec.type === "date";
          return writeValue({
            value,
            ...(date && typeof value === "string"
              ? {
                  temporal: value.includes("T")
                    ? ("datetime" as const)
                    : ("date" as const),
                }
              : {}),
          });
        }),
      );
    return {
      values,
      headers: labels,
      summary: {
        kind: input.kind,
        sheet: sheet.name,
        range: result.range,
        scope: "all",
        rows: values.length,
        columns: labels.length,
        cells: values.length * labels.length,
        headerRows: 1,
        matchedRows: result.matchedRows,
        ...counters,
        recalculated: false,
        ...(visibility === undefined ? {} : { visibility }),
        ...(result.warnings === undefined
          ? {}
          : { warnings: [...result.warnings] }),
      },
    };
  }
  const columns =
    input.selectColumns === undefined
      ? Array.from({ length: width }, (_, offset) => bounds.left + offset)
      : input.selectColumns.map((column) =>
          resolveColumn(index, column, columnMode),
        );
  if (new Set(columns).size !== columns.length)
    invalid("Selected columns must be unique.");
  const outputHeaders = columns.map(
    (column) => headers[column - bounds.left] ?? null,
  );
  const conditions = input.kind === "records" ? (input.where ?? []) : [];
  const filters = conditions.map((condition) => {
    validateCondition(condition, input.caseSensitive ?? false);
    return {
      condition,
      column: resolveColumn(index, condition.column, columnMode),
    };
  });
  const subset =
    input.kind === "records" && input.scope.kind === "rows"
      ? new Set(input.scope.rows)
      : undefined;
  if (
    subset !== undefined &&
    [...subset].some(
      (row) =>
        row < Math.max(bounds.top, header.headerRow + 1) || row > bounds.bottom,
    )
  )
    invalid("An explicit subset row lies outside the selected data rows.");
  if (input.kind === "records" && input.includeHeaders)
    addRow(outputHeaders.map((value) => writeValue({ value })));
  let matchedRows = 0;
  let selectedRows = 0;
  const first =
    input.kind === "range"
      ? bounds.top
      : Math.max(bounds.top, header.headerRow + 1);
  for (let row = first; row <= bounds.bottom; row += 1) {
    if (input.visibleOnly === true && sheet.hiddenRows.has(row)) continue;
    if (input.kind === "records") {
      const view = sheet.rowAt(row);
      if (view === undefined) continue;
      let populated = false;
      for (const column of view.populatedColumns({
        from: bounds.left,
        to: bounds.right,
        withCovered: mergedCells === "repeat",
      })) {
        const snapshot = view.cellAt(column);
        if (
          snapshot === undefined ||
          (snapshot.merged && mergedCells === "master")
        )
          continue;
        if (
          (snapshot.formula !== undefined && snapshot.formula !== "") ||
          resolveFacts(snapshot, {
            valueMode: "values",
            mergePolicy: mergedCells,
          }).value !== null
        ) {
          populated = true;
          break;
        }
      }
      if (!populated) continue;
      const hits = filters.map(({ condition, column }) => {
        const facts = readFacts(row, column);
        const reading =
          plans.get(column)?.reading ?? rawReadingFor(readingHintsOf(input));
        const outcome = evaluate(condition, typedCell(facts.value, reading), {
          caseSensitive: input.caseSensitive ?? false,
        });
        if (outcome === "incomparable")
          invalid(
            "A filter cell is incomparable with its condition. Choose an explicit column reading.",
          );
        return outcome === "match";
      });
      if (
        filters.length > 0 &&
        !(input.match === "all" ? hits.every(Boolean) : hits.some(Boolean))
      )
        continue;
    }
    matchedRows += 1;
    if (subset !== undefined && !subset.has(row)) continue;
    addRow(columns.map((column) => converted(row, column)));
    if (capacity.retainRowNumbers === true) rowNumbers.push(row);
    selectedRows += 1;
  }
  if (subset !== undefined && selectedRows !== subset.size)
    invalid(
      "The explicit subset includes rows excluded by the filter or visibility selection.",
    );
  return {
    values,
    headers: outputHeaders,
    ...(capacity.retainRowNumbers === true ? { rowNumbers } : {}),
    summary: {
      kind: input.kind,
      sheet: sheet.name,
      range: formatRange(bounds),
      scope: subset === undefined ? "all" : "rows",
      rows: values.length,
      columns: columns.length,
      cells: values.length * columns.length,
      headerRows: input.kind === "records" && input.includeHeaders ? 1 : 0,
      matchedRows,
      ...counters,
      recalculated: false,
      ...(visibility === undefined ? {} : { visibility }),
    },
  };
}

export function transferChanges(
  workbook: AuthoredWorkbook,
  data: TransferData,
  target: TransferTarget,
): WorkbookChange[] {
  const changes: WorkbookChange[] =
    target.kind === "add_sheet"
      ? [{ kind: "add_sheet", name: target.sheetName }]
      : [];
  if (
    target.kind === "sheet" &&
    !workbook.sheets.some((sheet) => sheet.name === target.sheetName)
  )
    throw new SezzleeExcelError(
      "unknown_sheet",
      "The target sheet does not exist.",
    );
  const start = parseCellRef(target.startCell);
  if (
    start.row + data.values.length - 1 > maxRow ||
    ((target.kind !== "sheet" || target.mapping.kind === "position") &&
      start.column + data.summary.columns - 1 > maxColumn)
  )
    throw new SezzleeExcelError(
      "invalid_range",
      "The transfer exceeds the target worksheet bounds.",
    );
  if (data.values.length === 0) return changes;
  if (target.kind !== "sheet" || target.mapping.kind === "position") {
    changes.push({
      kind: "write_cells",
      sheetName: target.sheetName,
      startCell: target.startCell,
      values: data.values,
      overwrite: target.kind === "sheet" && target.overwrite,
    });
    return changes;
  }
  const sheet = workbook.sheets.find(
    (entry) => entry.name === target.sheetName,
  );
  if (sheet === undefined)
    throw new SezzleeExcelError(
      "unknown_sheet",
      "The target sheet does not exist.",
    );
  const headerRow = target.mapping.headerRow;
  const headers = Array.from({ length: maxColumn }, (_, offset) => {
    const cell = sheet.cells.get((headerRow - 1) * maxColumn + offset);
    return cell?.kind === "text" ? cell.value : null;
  });
  const index = buildColumnIndex(
    sheet.name,
    { top: headerRow, bottom: headerRow, left: 1, right: maxColumn },
    headerRow,
    headers,
  );
  const seen = new Set<number>();
  for (const [offset, header] of data.headers.entries()) {
    if (header === null || header === "")
      invalid("Header mapping requires a name for every source column.");
    const column = resolveColumn(index, header, "header");
    if (seen.has(column))
      invalid("More than one source column maps to the same target column.");
    seen.add(column);
    if (changes.length >= authoringLimits.maxOperations)
      budget("The header mapping exceeds the block limit.");
    changes.push({
      kind: "write_cells",
      sheetName: target.sheetName,
      startCell: `${columnToLetters(column)}${start.row}`,
      values: data.values.map((row) => {
        const cell = row[offset];
        if (cell === undefined)
          invalid("The selected data is not rectangular.");
        return [cell];
      }),
      overwrite: target.overwrite,
    });
  }
  return changes;
}
