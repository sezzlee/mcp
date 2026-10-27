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
    .describe(
      "Columns are named by header text or A1 letter: auto (default), header or letter.",
    ),
};

const selectionOptions = { table, visibleOnly };

const profileHeaders = {
  headerRow: z
    .int()
    .min(0)
    .max(1_048_576)
    .optional()
    .describe(
      "Header row, 0 for none. Omitted: a table or autofilter header, else the first top row naming its columns in text above any data, else row 1.",
    ),
  headerScan: z
    .boolean()
    .optional()
    .describe("Strict header detection: refuse when two rows or none qualify."),
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
      "Discover sheets, used ranges, each sheet's header row and first column names (the row reads use by default), merge and validation counts, formula cache coverage and defined names. A known file and columns can be read or aggregated directly.",
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
      "Read a rectangular cell range as a compact grid: hoisted column headers plus row arrays, with rowNumbers giving the sheet row of each array. Pass nextCursor back to continue a truncated read. A date and time stored without a zone is returned without one, as a local wall clock; a written offset is kept.",
    inputSchema: z.object({
      filePath,
      sheetName,
      ...selectionOptions,
      range: z
        .string()
        .optional()
        .describe(
          "A1 range such as B2:D40, B:D or 2:40. Defaults to the used range.",
        ),
      ...typedOptions,
      includeTyped: z
        .boolean()
        .optional()
        .describe("Add a typedValues grid read by columns, which it requires."),
      cursor: z
        .string()
        .optional()
        .describe(
          "nextCursor of the previous page; not with sheetName or range. Options are inherited.",
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
          "Header row, 0 for none. Omitted: a table or autofilter header, else the first top row naming its columns in text above any data, else row 1.",
        ),
      headerScan: z
        .boolean()
        .optional()
        .describe(
          "Strict header detection: refuse when two rows or none qualify. Cannot be combined with headerRow on a new read. Cursor-bound: omit to inherit.",
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
      "Profile a bounded rectangular prefix: types and confidence, formats, missing and distinct values, extrema, frequent values, unreadable examples and identifier signals. Returns reusable columns plus explicit sampling limits. This inspects cell contents.",
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
      "Answer questions with filtered totals, conditional metrics, rankings, several breakdowns or a pivot in one call. Use this instead of paging rows for a calculation. Known files and columns need no prior discovery call. Columns are named by header text or by A1 letter. A date and time stored without a zone is returned without one, as a local wall clock.",
    inputSchema: z.object({
      filePath,
      sheetName,
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
                "count counts matched rows, countValues non-empty cells, countDistinct distinct values; trueRatio is true over valid booleans. Numeric functions read numeric text and skip identifiers; percentiles are PERCENTILE.INC; stddev is the sample deviation.",
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
          "Header row, 0 for none. Omitted: a table or autofilter header, else the first top row naming its columns in text above any data, else row 1.",
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
          "Columns are named by header text or A1 letter: auto (default), header or letter.",
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
          `maxGroups is at most ${limits.maxGroupsHard} and groups past it are not paged; use orderBy "metric" with orderByMetric for the top groups, or where conditions or a coarser groupBy for fewer groups`,
        )
        .optional()
        .describe("Groups returned, default 50."),
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
