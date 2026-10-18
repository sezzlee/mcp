import {
  readOnly,
  toolNamesOf,
  type HandlersOf,
  type ToolDefinitions,
  type ToolInputOf,
  type ToolNameOf,
} from "@sezzlee/file-core";
import { z } from "zod";
import { limits } from "../platform/limits.js";
import {
  columnRef,
  columnSpecs,
  delimiter,
  drawingKind,
  encoding,
  filePath,
  sheetName,
} from "./schemas.js";

export const toolDefinitions = {
  list_workbooks: {
    description:
      "List readable .xlsx, .xlsm and .csv files under the server root. Returns filePath values that other tools accept verbatim. totalExact distinguishes complete totals; scanTruncated is separate from the result page limit.",
    inputSchema: z.object({
      subdirectory: z
        .string()
        .optional()
        .describe("Folder under the root to list."),
      pattern: z
        .string()
        .optional()
        .describe("Glob over the relative path, for example q1/*.xlsx."),
      maxResults: z
        .int()
        .min(1)
        .max(limits.maxListResults)
        .optional()
        .describe(
          "Maximum returned files, default 50. Does not increase the traversal budget.",
        ),
    }),
    annotations: readOnly,
  },
  describe_workbook: {
    description:
      "Summarise a workbook: sheets, used ranges, merge and validation counts, formula cache coverage and defined names. Call this before reading data.",
    inputSchema: z.object({
      filePath,
      includeDefinedNames: z
        .boolean()
        .optional()
        .describe(
          "Include the defined-name list, default true. The list is partial: sheet-local scopes may be missing; inspect limitations.",
        ),
      delimiter,
      encoding,
    }),
    annotations: readOnly,
  },
  read_sheet: {
    description:
      "Read a rectangular cell range as a compact grid: hoisted column headers plus row arrays. Pass nextCursor back to continue a truncated read.",
    inputSchema: z.object({
      filePath,
      sheetName,
      range: z
        .string()
        .optional()
        .describe(
          "A1 range such as B2:D40, B:D or 2:40. Defaults to the used range.",
        ),
      cursor: z
        .string()
        .optional()
        .describe(
          "Opaque v2 token from a previous response. Cannot be combined with sheetName or range. Omitted interpretation and CSV options are inherited; explicit values must match the first page. maxCells may change.",
        ),
      maxCells: z
        .int()
        .min(1)
        .max(limits.maxCellsHard)
        .optional()
        .describe(
          "Cells per response, default 2000. May change between cursor pages.",
        ),
      valueMode: z
        .enum(["values", "formulas", "both"])
        .optional()
        .describe(
          "Values, formulas, or values with formula notes; default values. Cursor-bound: conflicts are rejected. XLSX only.",
        ),
      mergedCells: z
        .enum(["master", "repeat"])
        .optional()
        .describe(
          "Master-only or repeated merged values, default master. Applies to headers too. Cursor-bound; XLSX only.",
        ),
      headerRow: z
        .int()
        .min(0)
        .optional()
        .describe(
          "Explicit header row. New reads default to 1; 0 disables headers. Cursor-bound: omit to inherit. Cannot be combined with headerScan=true.",
        ),
      headerScan: z
        .boolean()
        .optional()
        .describe(
          "Detect a provable header row, default false. Cannot be combined with headerRow on a new read. Cursor-bound: omit to inherit. Ambiguity fails rather than guessing.",
        ),
      includeHyperlinks: z
        .boolean()
        .optional()
        .describe(
          "Include hyperlink notes, default false. Cursor-bound; true requires XLSX.",
        ),
      delimiter,
      encoding,
    }),
    annotations: readOnly,
  },
  get_merged_ranges: {
    description: "List the merged cell ranges of a worksheet.",
    inputSchema: z.object({ filePath, sheetName }),
    annotations: readOnly,
  },
  get_data_validations: {
    description:
      "List the data validation rules of a worksheet, grouped back into rectangular ranges.",
    inputSchema: z.object({ filePath, sheetName }),
    annotations: readOnly,
  },

  get_tables: {
    description:
      "List the Excel Tables (ListObjects) a worksheet declares: range, header and totals rows, and column names with their A1 letters.",
    inputSchema: z.object({ filePath, sheetName }),
    annotations: readOnly,
  },

  get_conditional_formats: {
    description:
      "List the conditional formatting rules of a worksheet as predicates: target ranges, rule kind, operator, formulae and thresholds. Fill colours, icons and bar geometry are not reported.",
    inputSchema: z.object({ filePath, sheetName }),
    annotations: readOnly,
  },

  get_images: {
    description:
      "List the pictures embedded in a worksheet: the cells a picture spans (range), or its top-left cell and pixel size when only those are anchored (cell), plus byte size and file extension. Charts belong to get_charts; pivot tables and sparklines are refused rather than reported as absent.",
    inputSchema: z.object({ filePath, sheetName, kind: drawingKind }),
    annotations: readOnly,
  },

  get_charts: {
    description:
      "List charts on a worksheet or chart sheet: type, title, axes (including secondary axes, scale and number format), series cell references and cached point values, trendline types, user-filtered series as hidden, and pivot source when present. Cached values may be stale; read the ref with read_sheet for current cells. Appearance (colours, fonts) is not reported.",
    inputSchema: z.object({
      filePath,
      sheetName,
      chartId: z
        .int()
        .min(1)
        .optional()
        .describe(
          "1-based chart index on the sheet. Omit to list every chart up to the per-sheet cap.",
        ),
      maxPoints: z
        .int()
        .min(1)
        .max(limits.maxChartPointsHard)
        .optional()
        .describe(
          `Cached points per series, default ${limits.maxChartPointsDefault}, at most ${limits.maxChartPointsHard}.`,
        ),
    }),
    annotations: readOnly,
  },

  aggregate_sheet: {
    description:
      "Group rows and compute totals, averages, extremes and counts over a sheet in one call. Use this instead of paging a large sheet. Columns are named by header text or by A1 letter.",
    inputSchema: z.object({
      filePath,
      sheetName,
      range: z
        .string()
        .optional()
        .describe(
          "A1 range such as A1:H500, B:D or 2:40, including the header row. Defaults to the used range.",
        ),
      groupBy: z
        .array(columnRef)
        .max(limits.maxMetrics)
        .optional()
        .describe("Columns to group by. Omit for a single whole-range total."),
      metrics: z
        .array(
          z.object({
            fn: z
              .enum([
                "count",
                "countValues",
                "countDistinct",
                "sum",
                "avg",
                "min",
                "max",
                "stddev",
              ])
              .describe(
                "count counts matched rows and needs no column. countValues counts the column's non-empty cells, countDistinct its distinct values. sum, avg and stddev read numbers, including text such as 1.234,50, (1,234.50), %20 or ₺95 read column by column; identifiers such as 00123 are never summed. min and max read the kind most of the column holds: numbers, dates, times or text. Other cells are counted as skipped.",
              ),
            column: columnRef.optional(),
          }),
        )
        .min(1)
        .max(limits.maxMetrics)
        .describe(
          "Values to compute. Each metric becomes one output column after the groupBy columns, labelled fn(column).",
        ),
      where: z
        .array(
          z.object({
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
                "Comparison and text operators take value; in takes values; between takes values as [low, high], both inclusive and of one kind; isEmpty, isNotEmpty, isError, isNumber and isText take neither.",
              ),
            value: z
              .union([z.string(), z.number(), z.boolean()])
              .optional()
              .describe(
                "Operand of eq, ne, lt, lte, gt, gte, contains, startsWith and endsWith.",
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
        .max(limits.maxConditions)
        .optional()
        .describe(
          "Row filter. Against a number or an ISO date operand, text such as 1.234,50 or 02.01.2023 is read as a number or a date column by column. A cell that still differs in kind from the operand never matches and is reported in warnings with examples.",
        ),
      match: z
        .enum(["all", "any"])
        .optional()
        .describe("Combine predicates with all (default) or any."),
      headerRow: z
        .int()
        .min(0)
        .optional()
        .describe(
          "Row treated as headers, never detected. Defaults to 1; 0 disables.",
        ),
      headerScan: z
        .boolean()
        .optional()
        .describe(
          "Prove the header row from the sheet instead of assuming row 1. Cannot be combined with headerRow. Fails rather than guessing.",
        ),
      columnMode: z
        .enum(["auto", "header", "letter"])
        .optional()
        .describe(
          "Automatic resolution (default), header text, or A1 letter. Letter mode ignores duplicate headers.",
        ),
      caseSensitive: z
        .boolean()
        .optional()
        .describe(
          "Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.",
        ),
      columns: columnSpecs,
      mergedCells: z
        .enum(["master", "repeat"])
        .optional()
        .describe("Merged values and header detection policy, default master."),
      orderBy: z
        .enum(["group", "metric"])
        .optional()
        .describe("Sort by group key (default) or selected metric."),
      orderByMetric: z
        .int()
        .min(1)
        .max(limits.maxMetrics)
        .optional()
        .describe(
          "One-based index into metrics, default 1. Cannot exceed the actual metrics count.",
        ),
      descending: z
        .boolean()
        .optional()
        .describe("Descending sort, default false."),
      maxGroups: z
        .int()
        .min(1)
        .max(limits.maxGroupsHard)
        .optional()
        .describe(
          "Maximum groups returned, default 50. matchedRows covers all groups; metric counted/skipped covers returnedMatchedRows.",
        ),
      delimiter,
      encoding,
    }),
    annotations: readOnly,
  },
  find_in_sheet: {
    description:
      "Find cells whose value or formula matches a query. Use this instead of paging a large sheet.",
    inputSchema: z.object({
      filePath,
      query: z
        .string()
        .min(1)
        .describe(
          "Text to find, or a JavaScript regular expression of at most 256 characters when matchMode is regex.",
        ),
      sheetName,
      matchMode: z
        .enum(["contains", "exact", "regex"])
        .optional()
        .describe(
          "Contains (default), exact text or JavaScript regex. Regex runs in an isolated worker with a two-second deadline.",
        ),
      caseSensitive: z
        .boolean()
        .optional()
        .describe(
          "Case-sensitive matching, default false. Literal search uses NFC/folding; regex retains JavaScript semantics.",
        ),
      searchIn: z
        .enum(["values", "formulas", "both"])
        .optional()
        .describe(
          "Search values (default), formulas or both. CSV supports values only.",
        ),
      range: z
        .string()
        .optional()
        .describe(
          "A1 range to search, such as B2:D40, B:D or 2:40. Defaults to the used range.",
        ),
      maxResults: z
        .int()
        .min(1)
        .max(limits.maxFindResults)
        .optional()
        .describe(
          "Maximum returned matches, default 50. Does not increase the regex deadline.",
        ),
      delimiter,
      encoding,
    }),
    annotations: readOnly,
  },
} as const satisfies ToolDefinitions;

export type Definitions = typeof toolDefinitions;

export type ToolName = ToolNameOf<Definitions>;

export const toolNames: readonly ToolName[] = toolNamesOf(toolDefinitions);

export type ToolInputSchema = Definitions[ToolName]["inputSchema"];

export type ToolInput<K extends ToolName> = ToolInputOf<Definitions, K>;

export type ToolHandlers = HandlersOf<Definitions>;
