import { z } from "zod";
import { toolDefinitions } from "./definitions.js";
import { transferSelectionSchema } from "./transfer-schemas.js";
import { materializeTransfer } from "./transfer.js";
import type { ResultStore } from "./retained-results.js";
import { writeCellSchema, type WriteCell } from "../authoring/values.js";
import { authoringLimits } from "../authoring/workbook.js";
import type { InsertedCell } from "../authoring/edit.js";
import type { CellScalar } from "../grid/cell-value.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import type { WorkbookRoot } from "../platform/paths.js";
import {
  readSourceSnapshot,
  workbookVersionIdSchema,
  type BlockSourceReceipt,
  type WorkbookSnapshot,
} from "../platform/versions.js";

const pinned = {
  filePath: z.string().min(1).max(32_768),
  versionId: workbookVersionIdSchema.optional(),
};

const [rangeSelection, recordsSelection, aggregateSelection] =
  transferSelectionSchema.options;
const resultQuery = toolDefinitions.query_result.inputSchema.shape;

/** Guard: object-only unions must advertise their JSON type so tool decoders do not default nested arguments to strings. */
export const blockSourceSchema = z
  .discriminatedUnion("kind", [
    rangeSelection.extend(pinned),
    recordsSelection.extend(pinned),
    aggregateSelection.extend(pinned),
    z.strictObject({
      kind: z.literal("result"),
      resultId: resultQuery.resultId,
      columns: resultQuery.columns,
      where: resultQuery.where,
      offset: resultQuery.offset,
      maxRows: z.int().min(1).max(limits.maxResultRows).optional(),
      includeHeaders: z.boolean().default(true),
    }),
  ])
  .meta({ type: "object" });

export const blockHeaderSchema = z
  .array(z.string().max(32_767))
  .min(1)
  .max(16_384);

export type BlockSource = z.infer<typeof blockSourceSchema>;

/**
 * Parse rule shared by every block that takes values or a source.
 * @returns whether the block names exactly one of them.
 */
export function oneBlockInput(block: {
  readonly values?: unknown;
  readonly source?: unknown;
}): boolean {
  return (block.values === undefined) !== (block.source === undefined);
}

export const oneBlockInputMessage =
  "Give a block either values or source, not both.";

/**
 * Literal values under a header row of text cells.
 * @param header the column names written above the values
 * @param values the typed rows, each as wide as the header
 */
export function headedValues<Cell>(
  header: readonly string[],
  values: readonly (readonly Cell[])[],
): (Cell | Extract<WriteCell, { kind: "text" }>)[][] {
  const width = values[0]?.length ?? header.length;
  if (header.length !== width)
    invalid(
      `header has ${header.length} names but each values row has ${width} cells.`,
    );
  return [
    header.map((value) => ({ kind: "text" as const, value })),
    ...values.map((row) => [...row]),
  ];
}

function invalid(message: string): never {
  throw new SezzleeExcelError("invalid_argument", message);
}

function budget(message: string): never {
  throw new SezzleeExcelError("resource_limit", message);
}

function resultCell(value: CellScalar, date: boolean): WriteCell {
  const parsed = writeCellSchema.safeParse(
    value === null
      ? { kind: "blank" }
      : typeof value === "string"
        ? {
            kind: date ? (value.includes("T") ? "datetime" : "date") : "text",
            value,
          }
        : typeof value === "number"
          ? { kind: "number", value }
          : typeof value === "boolean"
            ? { kind: "boolean", value }
            : { kind: "unsupported" },
  );
  if (!parsed.success)
    invalid(
      "A result value cannot be written without loss. Errors, durations, images, linked values and unsafe numbers are not writable.",
    );
  return parsed.data;
}

function scalarOf(cell: WriteCell | InsertedCell): CellScalar {
  switch (cell.kind) {
    case "blank":
    case "formula":
      return null;
    case "text":
    case "date":
    case "datetime":
    case "number":
    case "boolean":
      return cell.value;
    default: {
      const exhaustive: never = cell;
      return exhaustive;
    }
  }
}

/**
 * Refuses a literal block that retypes rows of a retained result.
 * @param results the store of this server instance
 * @param rows the literal rows a write carries
 */
export function refuseCopiedRows(
  results: ResultStore,
  rows: readonly (readonly (WriteCell | InsertedCell)[])[],
): void {
  const resultId = results.repeated(rows.map((row) => row.map(scalarOf)));
  if (resultId !== undefined)
    throw new SezzleeExcelError(
      "invalid_argument",
      `These rows repeat result ${resultId}; write them with source {kind:"result", resultId:"${resultId}"}.`,
      "Replace values with source so the server writes the retained rows; add columns, where, offset or maxRows to select part of them.",
    );
}

export interface SourceResolver {
  resolve(
    source: BlockSource,
    header: readonly string[] | undefined,
    at: string,
  ): Promise<WriteCell[][]>;
  verify(): Promise<void>;
  readonly receipts: readonly BlockSourceReceipt[];
}

/**
 * Turns block sources of one request into typed value rectangles, reading
 * each source file once and bounding the cells and text of all of them.
 * @param root the configured workbook root
 * @param results the retained results of this server instance
 */
export function createSourceResolver(
  root: WorkbookRoot,
  results: ResultStore,
): SourceResolver {
  const snapshots: WorkbookSnapshot[] = [];
  const receipts: BlockSourceReceipt[] = [];
  let cells = 0;
  let textBytes = 0;
  let fileBytes = 0;

  const snapshotOf = async (
    filePath: string,
    versionId: z.infer<typeof workbookVersionIdSchema> | undefined,
  ): Promise<WorkbookSnapshot> => {
    const snapshot = await readSourceSnapshot(root, filePath, versionId);
    const known = snapshots.find(
      (prior) => prior.version.filePath === snapshot.version.filePath,
    );
    if (known !== undefined) {
      if (known.version.versionId !== snapshot.version.versionId)
        throw new SezzleeExcelError(
          "file_changed",
          "A source file changed while the request was read.",
          "Read the source again and repeat the request with its versionId.",
        );
      return known;
    }
    fileBytes += snapshot.bytes.length;
    if (fileBytes > limits.maxFileBytes)
      budget("Block source files exceed the combined byte budget.");
    snapshots.push(snapshot);
    return snapshot;
  };

  const admit = (rows: readonly (readonly WriteCell[])[]): void => {
    for (const row of rows) {
      cells += row.length;
      for (const cell of row)
        if (cell.kind === "text") textBytes += Buffer.byteLength(cell.value);
    }
    if (cells > authoringLimits.maxCells)
      budget(
        `Block sources exceed ${authoringLimits.maxCells} cells in one request.`,
      );
    if (textBytes > authoringLimits.maxTextBytes)
      budget("Block sources exceed their text byte budget.");
  };

  return {
    receipts,
    async resolve(source, header, at) {
      let rows: WriteCell[][];
      let width: number;
      let headed: boolean;
      let receipt: BlockSourceReceipt;
      if (source.kind === "result") {
        const selected = results.rows(source);
        rows = selected.rows.map((row) =>
          row.map((value, offset) =>
            resultCell(value, selected.dates[offset] ?? false),
          ),
        );
        width = selected.labels.length;
        headed = source.includeHeaders;
        if (headed)
          rows.unshift(
            selected.labels.map((value) => ({ kind: "text", value })),
          );
        receipt = {
          kind: "result",
          at,
          resultId: selected.resultId,
          rows: 0,
          columns: width,
        };
      } else {
        const { filePath, versionId, ...selection } = source;
        const snapshot = await snapshotOf(filePath, versionId);
        const data = await materializeTransfer(snapshot, selection, {
          maxRows: authoringLimits.maxCells,
          maxCells: authoringLimits.maxCells - cells,
          maxTextBytes: authoringLimits.maxTextBytes - textBytes,
        });
        rows = data.values;
        width = data.summary.columns;
        headed = data.summary.headerRows === 1;
        receipt = {
          kind: source.kind,
          at,
          version: snapshot.version,
          rows: 0,
          columns: width,
        };
      }
      if (header !== undefined) {
        if (header.length !== width)
          invalid(
            `header has ${header.length} names but the source selects ${width} columns.`,
          );
        const named = header.map((value): WriteCell => ({
          kind: "text",
          value,
        }));
        if (headed) rows[0] = named;
        else rows.unshift(named);
      }
      if (rows.length === 0)
        invalid(
          "The source selected no rows to write. Widen its selection, or give header to write the header row alone.",
        );
      admit(rows);
      receipts.push({ ...receipt, rows: rows.length });
      return rows;
    },
    async verify() {
      for (const snapshot of snapshots)
        await readSourceSnapshot(
          root,
          snapshot.version.filePath,
          snapshot.version.versionId,
        );
    },
  };
}
