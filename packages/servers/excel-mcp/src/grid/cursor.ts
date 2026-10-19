import {
  decodeCursorPayload,
  isFresh,
  type Cursor,
  type Fingerprint,
} from "@sezzlee/file-core";
import { SezzleeExcelError } from "../platform/errors.js";
import { encodingNames, type CsvOptions } from "../platform/delimited.js";
import { z } from "zod";
import {
  columnSpecsSchema,
  readingHintsSchema,
  type ColumnSpec,
  type ReadingHints,
} from "./column-spec.js";
import type { ColumnMode } from "./columns.js";

export { encodeCursor, fingerprint } from "@sezzlee/file-core";
export type { Fingerprint } from "@sezzlee/file-core";

export type ValueMode = "values" | "formulas" | "both";
export type MergePolicy = "master" | "repeat";

export interface SheetPosition {
  readonly s: string;
  readonly r: number;
  readonly c: number;
  readonly e: string;
  readonly m: ValueMode;
  readonly g: MergePolicy;
  readonly h: number;
  readonly o: CursorOptions;
}

export interface CursorOptions extends CsvOptions, ReadingHints {
  readonly table?: string;
  readonly visibleOnly?: boolean;
  readonly columns?: readonly ColumnSpec[];
  readonly columnMode?: ColumnMode;
  readonly includeTyped?: boolean;
  readonly valueMode: ValueMode;
  readonly mergedCells: MergePolicy;
  readonly headerRow: number;
  readonly headerScan: boolean;
  readonly includeHyperlinks: boolean;
}

const cursorOptionsSchema = z.strictObject({
  table: z.string().min(1).max(255).optional(),
  visibleOnly: z.boolean().optional(),
  valueMode: z.enum(["values", "formulas", "both"]),
  mergedCells: z.enum(["master", "repeat"]),
  headerRow: z.int().min(0).max(1_048_576),
  headerScan: z.boolean(),
  includeHyperlinks: z.boolean(),
  delimiter: z.enum(["comma", "semicolon", "tab", "pipe"]).optional(),
  encoding: z.enum(encodingNames).optional(),
  columns: columnSpecsSchema.optional(),
  columnMode: z.enum(["auto", "header", "letter"]).optional(),
  includeTyped: z.boolean().optional(),
  ...readingHintsSchema,
}) satisfies z.ZodType<CursorOptions>;

const inheritedOptions = cursorOptionsSchema.keyof().options;

function isOptions(value: unknown): value is CursorOptions {
  return cursorOptionsSchema.safeParse(value).success;
}

function sameOption(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) => sameOption(value, right[index]))
    );
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  )
    return false;
  const a = Object.entries(left);
  const b = Object.entries(right);
  return (
    a.length === b.length &&
    a.every(
      ([key, value]) =>
        Object.hasOwn(right, key) &&
        sameOption(value, (right as Record<string, unknown>)[key]),
    )
  );
}

export function inheritCursorOptions<
  T extends Partial<CursorOptions> & {
    readonly cursor?: string;
    readonly sheetName?: string;
    readonly range?: string;
  },
>(args: T): T & Partial<CursorOptions> {
  if (args.cursor === undefined) return args;
  if (args.sheetName !== undefined || args.range !== undefined)
    throw new SezzleeExcelError(
      "invalid_argument",
      "cursor cannot be combined with sheetName or range.",
    );
  const cursor = decodeCursor(args.cursor);
  for (const key of inheritedOptions) {
    if (args[key] !== undefined && !sameOption(args[key], cursor.o[key]))
      throw new SezzleeExcelError(
        "invalid_argument",
        `Option '${key}' conflicts with the cursor.`,
        "Drop cursor to start a read with different options.",
      );
  }
  return { ...args, ...cursor.o };
}

export type SheetCursor = Cursor<SheetPosition, 2>;

function isSheetCursor(candidate: unknown): candidate is SheetCursor {
  if (typeof candidate !== "object" || candidate === null) {
    return false;
  }
  const value = candidate as Record<string, unknown>;
  return (
    value["v"] === 2 &&
    typeof value["f"] === "string" &&
    /^[a-f0-9]{16,64}$/.test(value["f"]) &&
    typeof value["s"] === "string" &&
    typeof value["r"] === "number" &&
    Number.isSafeInteger(value["r"]) &&
    value["r"] >= 1 &&
    value["r"] <= 1048576 &&
    typeof value["c"] === "number" &&
    Number.isSafeInteger(value["c"]) &&
    value["c"] >= 1 &&
    value["c"] <= 16384 &&
    typeof value["e"] === "string" &&
    (value["m"] === "values" ||
      value["m"] === "formulas" ||
      value["m"] === "both") &&
    (value["g"] === "master" || value["g"] === "repeat") &&
    isOptions(value["o"]) &&
    value["h"] === value["o"].headerRow &&
    value["m"] === value["o"].valueMode &&
    value["g"] === value["o"].mergedCells
  );
}

export function decodeCursor(raw: string): SheetCursor {
  const parsed = decodeCursorPayload(raw);
  if (!isSheetCursor(parsed)) {
    throw new SezzleeExcelError(
      "invalid_cursor",
      "The cursor is not a token produced by a previous read_sheet response.",
      "Call read_sheet again without a cursor.",
    );
  }
  return parsed;
}

export function assertFresh(cursor: SheetCursor, current: Fingerprint): void {
  if (!isFresh(cursor, current)) {
    throw new SezzleeExcelError(
      "stale_cursor",
      "The workbook changed while the previous page was being read.",
      "Restart from read_sheet without a cursor.",
    );
  }
}
