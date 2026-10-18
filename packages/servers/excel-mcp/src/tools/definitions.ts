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
import { metricFunctions } from "../grid/aggregate-metrics.js";
import {
  columnRef,
  columnSpecs,
  delimiter,
  drawingKind,
  encoding,
  filePath,
  groupAxis,
  rowConditions,
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
      groupBy: groupAxis
        .optional()
        .describe(
          "Row grouping keys. A plain column keeps raw values unless columns, a filter or a metric already reads that column as numbers or dates. Date parts and bins request that reading explicitly. Omit for a whole-range total.",
        ),
      pivotBy: groupAxis
        .optional()
        .describe(
          "Column axis of a dense pivot, with the same key forms as groupBy. Missing combinations have count 0 and other metrics null. The full row-key × pivot-key × metric count is bounded, before maxGroups slicing.",
        ),
      groupingSets: z
        .array(
          z.strictObject({
            groupBy: groupAxis.describe(
              "Keys for this independent breakdown, using the same forms as the primary groupBy. Pass an empty array for a grand total.",
            ),
          }),
        )
        .min(1)
        .max(limits.maxGroupingSets)
        .optional()
        .describe(
          "Additional independent groupings computed with the same metrics, filters and pivotBy in one shared scan. Results appear in groupingSets in this order; the primary groupBy result stays in rows. An empty groupBy computes a grand total.",
        ),
      compact: z
        .boolean()
        .optional()
        .describe(
          "Omit repeated CSV format and mode metadata, default false. CSV warnings and nonzero quality counts, typed-reading decisions and aggregation diagnostics remain.",
        ),
      metrics: z
        .array(
          z.strictObject({
            fn: z
              .enum(metricFunctions)
              .describe(
                "count counts matched rows. countValues counts non-empty cells; countDistinct counts distinct stored values. sum, avg, stddev, median, p50, p90 and percentile read numeric text column by column and exclude identifiers. stddev is the sample deviation. Percentiles use exact linear interpolation (Excel PERCENTILE.INC), bounded across the call. min/max compare one kind per group; a mixed group is refused.",
              ),
            column: columnRef.optional(),
            percentile: z
              .number()
              .min(0)
              .max(1)
              .optional()
              .describe(
                "Required only for fn percentile: fraction from 0 to 1 inclusive. median and p50 use 0.5, p90 uses 0.9.",
              ),
            where: rowConditions
              .optional()
              .describe(
                "Additional filter for this metric only; all conditions must match. It is applied after the top-level filter. filtered counts rows excluded here; skipped counts included rows whose values the metric could not use.",
              ),
          }),
        )
        .min(1)
        .max(limits.maxMetrics)
        .describe(
          "Values to compute. Each becomes an output column after the group keys, or one column per pivot key. Percentiles sharing a column and identical metric filter share their stored samples.",
        ),
      where: rowConditions
        .optional()
        .describe(
          "Row filter. Numeric and ISO date operands read text column by column. Incomparable cells are reported with counts and examples.",
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
