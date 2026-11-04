import {
  readOnly,
  toolNamesOf,
  type HandlersOf,
  type ToolDefinitions,
  type ToolInputOf,
  type ToolNameOf,
} from "@sezzlee/file-core";
import { z } from "zod";
import { executionLimits } from "@sezzlee/compute-core";
import { resultExecutionDescription } from "./result-execution.js";
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
  groupAxisForms,
  rowConditionForms,
  rowConditions,
  readingHintsSchema,
  sheetName,
  table,
  visibleOnly,
} from "./schemas.js";

const typedOptions = {
  columns: columnSpecs,
  ...readingHintsSchema,
  columnMode: z
    .enum(["auto", "header", "letter"])
    .optional()
    .describe("Column: auto (default), header, letter."),
};

const selectionOptions = { table, visibleOnly };

const maxResultColumns =
  limits.maxMetrics + limits.maxPivotCells + limits.maxDerivedMetrics;

const profileHeaders = {
  headerRow: z
    .int()
    .min(0)
    .max(1_048_576)
    .optional()
    .describe(
      "Header: 0 none; default table/AutoFilter, text above data, else 1.",
    ),
  headerScan: z
    .boolean()
    .optional()
    .describe("Refuse ambiguous or missing headers."),
};

const derivedTerms = z
  .array(
    z.strictObject({
      metric: z
        .int()
        .min(1)
        .max(limits.maxMetrics)
        .describe("One-based index into metrics."),
      factor: z.number().optional().describe("Multiplier, default 1."),
      scope: z
        .enum(["group", "total"])
        .optional()
        .describe(
          "group (default) or total: the metric summed over every group, for a share; counts and sum only.",
        ),
    }),
  )
  .max(limits.maxMetrics);

export const toolDefinitions = {
  list_workbooks: {
    description:
      "List readable .xlsx, .xlsm and .csv files under the server root, as filePath values the other tools accept.",
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
      "Discover sheets, ranges, default headers and columns, merge/validation counts, formula cache coverage and defined names. Known files and columns need no discovery.",
    inputSchema: z.object({
      filePath,
      includeDefinedNames: z
        .boolean()
        .optional()
        .describe("Include defined names, default true."),
      delimiter,
      encoding,
    }),
    annotations: readOnly,
  },
  read_sheet: {
    description:
      "Read a rectangle as headers and row arrays; rowNumbers locate sheet rows. Continue with nextCursor. Unzoned dates/times remain local wall clocks; written offsets are kept.",
    inputSchema: z.object({
      filePath,
      sheetName,
      ...selectionOptions,
      range: z
        .string()
        .optional()
        .describe("A1: B2:D40, B:D, 2:40; default used range."),
      ...typedOptions,
      includeTyped: z
        .boolean()
        .optional()
        .describe("Add a typedValues grid read by columns, which it requires."),
      cursor: z
        .string()
        .optional()
        .describe(
          "Continue nextCursor; not with sheetName/range. Inherits options.",
        ),
      maxCells: z
        .int()
        .min(1)
        .max(limits.maxCellsHard)
        .optional()
        .describe("Cells per page, default 2000; cursor pages may differ."),
      valueMode: z
        .enum(["values", "formulas", "both"])
        .optional()
        .describe(
          "values (default), formulas, or values with formula notes. XLSX only.",
        ),
      mergedCells: z
        .enum(["master", "repeat"])
        .optional()
        .describe(
          "Merged cells: master value only (default) or repeated. XLSX only.",
        ),
      headerRow: z
        .int()
        .min(0)
        .optional()
        .describe(
          "Header: 0 none; default table/AutoFilter, text above data, else 1.",
        ),
      headerScan: z
        .boolean()
        .optional()
        .describe(
          "Refuse missing/ambiguous headers; not with headerRow on a new read. Cursor-bound: omit to inherit.",
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
  profile_sheet: {
    description:
      "Sample a bounded prefix for types/confidence, formats, missing/distinct values, extrema, frequencies, unreadable examples and identifiers. Returns reusable columns and sampling limits.",
    inputSchema: z.object({
      filePath,
      sheetName,
      ...selectionOptions,
      range: z
        .string()
        .optional()
        .describe("A1 range including any header row, default used range."),
      ...profileHeaders,
      ...typedOptions,
      mergedCells: z
        .enum(["master", "repeat"])
        .optional()
        .describe("Merged cell policy, default master."),
      maxRows: z
        .int()
        .min(1)
        .max(limits.maxProfileRowsHard)
        .optional()
        .describe("Sampled rows, default 1000."),
      maxColumns: z
        .int()
        .min(1)
        .max(limits.maxProfileColumnsHard)
        .optional()
        .describe("Profiled columns, default 16."),
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
      "List worksheet pictures, in-cell images included: anchor, size, extension, alternative text and decorative flag. imageId matches read_sheet values. Pixels are not interpreted.",
    inputSchema: z.object({ filePath, sheetName, kind: drawingKind }),
    annotations: readOnly,
  },

  get_charts: {
    description:
      "List charts on a worksheet or chart sheet: type, title, axes, series references with cached points, trendlines and pivot source. Cached values may be stale; read the ref for current cells.",
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
      "Calculate filtered totals, grouped rankings, conditional metrics or pivots over the selected range. resultMode retained enables query_result/execute_result over all groups. Unzoned dates remain local wall clocks.",
    inputSchema: z.object({
      filePath,
      sheetName,
      resultMode: z
        .enum(["inline", "retained"])
        .optional()
        .describe(
          "inline (default), or retain all groups for 15 minutes in this instance. retained returns a preview up to 16 KiB and resultId, plus one per groupingSets entry; a wide preview lists totalColumns. All processing limits apply; failures store nothing.",
        ),
      ...selectionOptions,
      range: z
        .string()
        .optional()
        .describe(
          "A1 range such as A1:H500, B:D or 2:40, including the header row. Defaults to the used range.",
        ),
      groupBy: groupAxis
        .optional()
        .describe(
          `Row grouping keys; omit for a whole-range total. ${groupAxisForms}`,
        ),
      pivotBy: groupAxis
        .optional()
        .describe(
          "Column axis of a dense pivot, in groupBy's key forms. Missing combinations have count 0, other metrics null.",
        ),
      groupingSets: z
        .array(
          z.strictObject({
            groupBy: groupAxis.describe("Keys in groupBy's forms."),
          }),
        )
        .min(1)
        .max(limits.maxGroupingSets)
        .optional()
        .describe(
          "More breakdowns [{groupBy}] in groupBy's key forms over the same scan, returned in groupingSets; [] gives a grand total.",
        ),
      compact: z
        .boolean()
        .optional()
        .describe("Omit repeated CSV and mode metadata; diagnostics remain."),
      metrics: z
        .array(
          z.strictObject({
            fn: z
              .enum(metricFunctions)
              .describe(
                "count counts matched rows including blank cells, regardless of column. countValues counts non-empty cells in column; countDistinct counts distinct values. trueRatio is true over valid booleans. Numeric functions read numeric text and skip identifiers; percentiles are PERCENTILE.INC; stddev is the sample deviation.",
              ),
            column: columnRef.optional(),
            percentile: z
              .number()
              .min(0)
              .max(1)
              .optional()
              .describe("Fraction 0 to 1, for fn percentile."),
            round: z
              .int()
              .min(0)
              .max(10)
              .optional()
              .describe("Decimal places, half away from zero as ROUND."),
            where: rowConditions
              .optional()
              .describe("Filter for this metric, in where's form."),
          }),
        )
        .min(1)
        .max(limits.maxMetrics)
        .describe(
          "Values to compute [{fn, column?, percentile?, round?, where?}], one output column each after the group keys. A metric's where has the top-level where's form and applies after it.",
        ),
      where: rowConditions
        .optional()
        .describe(`Row filter. ${rowConditionForms}`),
      match: z
        .enum(["all", "any"])
        .optional()
        .describe("Combine predicates with all (default) or any."),
      headerRow: z
        .int()
        .min(0)
        .optional()
        .describe(
          "Header row (0: none). Default: table/autofilter header, then first text header above data, else 1.",
        ),
      headerScan: z
        .boolean()
        .optional()
        .describe(
          "Strict header detection: refuse when two rows or none qualify.",
        ),
      columnMode: z
        .enum(["auto", "header", "letter"])
        .optional()
        .describe(
          "Column references: auto (default), header text or A1 letter.",
        ),
      caseSensitive: z
        .boolean()
        .optional()
        .describe(
          "Case-sensitive text comparisons, default false. Applies to predicate bounds and min/max.",
        ),
      columns: columnSpecs,
      ...readingHintsSchema,
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
      orderByDerived: z
        .string()
        .optional()
        .describe("Derived metric to sort by with orderBy metric."),
      derived: z
        .array(
          z.strictObject({
            name: z.string().min(1).max(64).describe("Output column label."),
            numerator: derivedTerms
              .min(1)
              .describe("Terms added together: factor (default 1) × metric."),
            denominator: derivedTerms
              .min(1)
              .optional()
              .describe("Terms added together; a zero denominator gives null."),
            scale: z
              .number()
              .optional()
              .describe("Final multiplier, such as 100."),
            round: z
              .int()
              .min(0)
              .max(10)
              .optional()
              .describe("Decimal places, half away from zero."),
          }),
        )
        .min(1)
        .max(limits.maxDerivedMetrics)
        .optional()
        .describe(
          "Per-group values from the metrics: ratios, shares, differences, adjusted totals; appended after the metrics. Not with pivotBy.",
        ),
      descending: z
        .boolean()
        .optional()
        .describe("Descending sort, default false."),
      maxGroups: z
        .int()
        .min(1)
        .max(
          limits.maxGroupsHard,
          `maxGroups is at most ${limits.maxGroupsHard}; use resultMode "retained" and query_result for continuation, or orderBy "metric", where conditions or a coarser groupBy`,
        )
        .optional()
        .describe(
          "Returned groups, default 50. In retained mode, caps only the byte-bounded preview.",
        ),
      delimiter,
      encoding,
    }),
    annotations: { ...readOnly, idempotentHint: false },
  },
  query_result: {
    description:
      "Query resultId from retained aggregate_sheet: exact, case-sensitive equality on full stored values, projection and stable paging. Reads the immutable snapshot, never the workbook. Continue with nextOffset and the same query.",
    inputSchema: z.strictObject({
      resultId: z
        .string()
        .min(1)
        .max(128)
        .describe("Opaque identifier from this server instance."),
      columns: z
        .array(z.int().min(1).max(maxResultColumns))
        .min(1)
        .max(maxResultColumns)
        .optional()
        .describe(
          "One-based original result columns in output order; default all.",
        ),
      where: z
        .array(
          z.strictObject({
            column: z
              .int()
              .min(1)
              .max(maxResultColumns)
              .describe("One-based original column, before projection."),
            equals: z
              .union([
                z.string().max(limits.maxResultFilterChars),
                z.number(),
                z.boolean(),
                z.null(),
              ])
              .describe("Exact scalar; no coercion or text normalization."),
          }),
        )
        .max(limits.maxConditions)
        .optional()
        .describe("AND equality over every retained row."),
      offset: z
        .int()
        .min(0)
        .max(limits.maxResultRows)
        .optional()
        .describe(
          "Zero-based offset among matches; default 0, then nextOffset.",
        ),
      maxRows: z
        .int()
        .min(1)
        .max(limits.maxGroupsHard)
        .optional()
        .describe("Returned rows, default 50; 16 KiB may admit fewer."),
    }),
    annotations: readOnly,
  },
  execute_result: {
    description: resultExecutionDescription(executionLimits),
    inputSchema: z.strictObject({
      resultId: z
        .string()
        .min(1)
        .max(128)
        .describe("This instance's retained result."),
      code: z.string().min(1).describe("Function body; return JSON from data."),
    }),
    annotations: { ...readOnly, idempotentHint: false, openWorldHint: false },
  },
  read_result: {
    description:
      "Read exact JSON by RFC 6901 path: /value for computed data, /rows for aggregates. select projects members; offset/limit page arrays, objects or UTF-16 strings. Narrow windows over 16 KiB; no value truncation.",
    inputSchema: z.strictObject({
      resultId: z.string().min(1).max(128).describe("Stored result."),
      path: z.string().max(4_096).optional().describe("JSON Pointer."),
      select: z
        .array(z.string().max(4_096))
        .min(1)
        .max(32)
        .optional()
        .describe("Member names."),
      offset: z
        .int()
        .min(0)
        .max(limits.maxResultBytes)
        .optional()
        .describe("Start; default 0."),
      limit: z
        .int()
        .min(1)
        .max(limits.maxGroupsHard)
        .optional()
        .describe("Max items; default 50."),
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
      sheetName: sheetName.describe(
        "Exact worksheet name. Omitted with no range, table or columns: every worksheet is searched and each match names its sheet.",
      ),
      ...selectionOptions,
      ...profileHeaders,
      ...typedOptions,
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
