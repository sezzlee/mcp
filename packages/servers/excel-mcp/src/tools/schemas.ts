import { z } from "zod";
import { limits } from "../platform/limits.js";
import { encodingNames } from "../platform/delimited.js";
import { dateParts } from "../grid/grouping.js";

export const filePath = z
  .string()
  .describe(
    "Workbook path relative to the server root, as returned by list_workbooks.",
  );
export const sheetName = z
  .string()
  .optional()
  .describe(
    "Case-sensitive worksheet name with NFC equivalence; no case-insensitive fallback. Defaults to the first visible sheet. Unknown names return available names.",
  );
export { columnRef, readingHintsSchema } from "../grid/column-spec.js";
import { columnRef, columnSpecsSchema } from "../grid/column-spec.js";

export const groupAxis = z
  .array(
    z.union([
      columnRef,
      z.strictObject({
        column: columnRef,
        by: z
          .enum(dateParts)
          .describe(
            "UTC date part. month and quarter include the year; week is the ISO week-year; weekday is Monday=1 to Sunday=7; hour is 0 to 23.",
          ),
      }),
      z.strictObject({
        column: columnRef,
        bins: z
          .array(z.number())
          .min(1)
          .max(limits.maxGroupBins)
          .describe(
            "Strictly increasing finite boundaries. Bins are [lower, upper), with underflow and overflow groups.",
          ),
      }),
      z.strictObject({
        column: columnRef,
        width: z
          .number()
          .min(Number.MIN_VALUE)
          .describe(
            "Positive fixed bin width. Boundaries use exact decimal arithmetic over the finite values, with [lower, upper) intervals.",
          ),
        origin: z
          .number()
          .optional()
          .describe("Anchor of the fixed-width boundaries, default 0."),
      }),
    ]),
  )
  .max(limits.maxMetrics);

export const rowConditions = z
  .array(
    z.strictObject({
      column: columnRef,
      op: z
        .enum([
          "eq",
          "ne",
          "lt",
          "lte",
          "gt",
          "gte",
          "contains",
          "startsWith",
          "endsWith",
          "in",
          "between",
          "isEmpty",
          "isNotEmpty",
          "isError",
          "isNumber",
          "isText",
        ])
        .describe(
          "Comparison and text operators take value; in takes values; between takes [low, high], both inclusive and of one kind. isEmpty, isNotEmpty, isNumber and isText take neither. isError optionally takes an error code in value.",
        ),
      value: z
        .union([z.string(), z.number(), z.boolean()])
        .optional()
        .describe(
          "Operand of eq, ne, lt, lte, gt, gte, contains, startsWith, endsWith or isError.",
        ),
      values: z
        .array(z.union([z.string(), z.number(), z.boolean()]))
        .min(1)
        .max(limits.maxInValues)
        .optional()
        .describe(
          "Operands of in (any of them) and between (exactly two: low and high).",
        ),
    }),
  )
  .max(limits.maxConditions);
export const drawingKind = z
  .enum(["picture", "chart", "pivotTable", "sparkline"])
  .optional()
  .describe(
    "Drawing kind. Only 'picture' can be read here; use get_charts for charts. Pivot tables and sparklines are refused rather than reported as absent.",
  );

export const delimiter = z
  .enum(["comma", "semicolon", "tab", "pipe"])
  .optional()
  .describe("CSV field separator. Sniffed and echoed back when omitted.");

export const encoding = z
  .enum(encodingNames)
  .optional()
  .describe(
    "CSV text encoding. Detected from the byte-order mark, else utf-8.",
  );

export const columnSpecs = columnSpecsSchema
  .optional()
  .describe(
    "Shared column interpretation for profiling, aggregation, reading and searching. Use profile_sheet columns directly. Aggregation infers omitted columns only when a calculation needs them; read_sheet keeps values raw and adds typedValues only when includeTyped is true; find_in_sheet searches canonical typed values only for specified columns.",
  );
