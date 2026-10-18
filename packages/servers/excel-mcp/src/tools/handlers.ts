import { json, measureJson } from "@sezzlee/file-core";
import { limits, modePolicy } from "../platform/limits.js";
import {
  listWorkbooks,
  resolveWorkbookPath,
  type WorkbookRoot,
} from "../platform/paths.js";
import { findInSheet, readSheet } from "../grid/read-sheet.js";
import { collectConditionalFormats } from "../metadata/conditional-formats.js";
import { collectCharts } from "../metadata/charts.js";
import { collectImages } from "../metadata/images.js";
import { collectTables } from "../metadata/tables.js";
import { collectValidations } from "../metadata/validations.js";
import { selectSheetName } from "../format/ooxml-workbook.js";
import {
  createDocumentCache,
  csvReportOf,
  describeDocument,
  documentSheet,
  sheetSource,
} from "../format/document.js";
import { aggregateSheet } from "../grid/aggregate.js";
import type { CsvReport } from "../format/csv.js";
import type { DelimiterName, EncodingName } from "../platform/delimited.js";
import { inheritCursorOptions, decodeCursor } from "../grid/cursor.js";
import type { ToolHandlers } from "./definitions.js";
import { guard } from "./guard.js";
import {
  assertHeaderScan,
  assertPictureKind,
  createXlsxOpener,
  rejectForCsv,
} from "./gate.js";
import { resolveHeaderRow } from "./coerce.js";
import {
  modeEnvelopeBytes,
  withAggregateEnvelope,
  withCsv,
  withMode,
} from "./envelope.js";

interface CsvOptions {
  readonly delimiter?: DelimiterName;
  readonly encoding?: EncodingName;
}

function csvOptionsOf(args: CsvOptions): CsvOptions {
  return {
    ...(args.delimiter === undefined ? {} : { delimiter: args.delimiter }),
    ...(args.encoding === undefined ? {} : { encoding: args.encoding }),
  };
}

export function createHandlers(root: WorkbookRoot): ToolHandlers {
  const cache = createDocumentCache(root.real);
  const openXlsx = createXlsxOpener(root, cache);
  const openFor = async (path: string, csv: CsvOptions = {}) =>
    cache.load(await resolveWorkbookPath(root, path), csv);

  return {
    list_workbooks: guard(
      { root: root.real, tool: "list_workbooks" },
      async (args) => {
        const listing = await listWorkbooks(root, {
          ...(args.subdirectory === undefined
            ? {}
            : { subdirectory: args.subdirectory }),
          ...(args.pattern === undefined ? {} : { pattern: args.pattern }),
          maxResults: args.maxResults ?? limits.defaultListResults,
          mode: modePolicy,
        });
        return json({ root: root.real, ...listing });
      },
    ),

    describe_workbook: guard(
      { root: root.real, tool: "describe_workbook" },
      async (args) => {
        const loaded = await openFor(args.filePath, csvOptionsOf(args));
        return json(
          withMode(
            describeDocument(
              loaded,
              {
                filePath: args.filePath,
                sizeBytes: loaded.sizeBytes,
                modifiedAt: loaded.modifiedAt,
              },
              args.includeDefinedNames ?? true,
            ),
            loaded.mode,
          ),
        );
      },
    ),

    read_sheet: guard({ root: root.real, tool: "read_sheet" }, async (raw) => {
      const args = inheritCursorOptions(raw);
      const csvEnvelope = (report: CsvReport | undefined): number =>
        report === undefined ? 0 : measureJson({ csv: report });
      if (args.cursor === undefined) assertHeaderScan(args, args.filePath);
      const loaded = await openFor(args.filePath, csvOptionsOf(args));
      rejectForCsv(loaded, "valueMode", raw.valueMode, args.filePath);
      rejectForCsv(loaded, "mergedCells", raw.mergedCells, args.filePath);
      rejectForCsv(
        loaded,
        "includeHyperlinks",
        args.includeHyperlinks === true ? true : undefined,
        args.filePath,
      );
      const report = csvReportOf(loaded);
      return json(
        withCsv(
          readSheet(sheetSource(loaded), {
            extraEnvelopeBytes: csvEnvelope(report) + modeEnvelopeBytes,
            ...(args.sheetName === undefined
              ? {}
              : { sheetName: args.sheetName }),
            ...(args.range === undefined ? {} : { range: args.range }),
            ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
            maxCells: args.maxCells ?? limits.maxCellsDefault,
            valueMode: args.valueMode ?? "values",
            mergedCells: args.mergedCells ?? "master",
            ...(args.cursor === undefined
              ? resolveHeaderRow(loaded, args)
              : {
                  headerRow: decodeCursor(args.cursor).h,
                  headerRowSource: "cursor" as const,
                }),
            headerScan: args.headerScan ?? false,
            ...csvOptionsOf(args),
            includeHyperlinks: args.includeHyperlinks ?? false,
          }),
          report,
          loaded.mode,
        ),
      );
    }),

    get_merged_ranges: guard(
      { root: root.real, tool: "get_merged_ranges" },
      async (args, tool) => {
        const loaded = await openXlsx(args.filePath, tool);
        const sheet = documentSheet(loaded, args.sheetName);
        const merges = sheet.merges;
        return json(
          withMode(
            { sheet: sheet.name, merges, count: merges.length },
            loaded.mode,
          ),
        );
      },
    ),

    get_data_validations: guard(
      { root: root.real, tool: "get_data_validations" },
      async (args, tool) => {
        const loaded = await openXlsx(args.filePath, tool);
        const sheet = selectSheetName(loaded.workbook, args.sheetName);
        return json(
          withMode(
            collectValidations(sheet, loaded.workbook.facts(sheet).validations),
            loaded.mode,
          ),
        );
      },
    ),

    get_tables: guard(
      { root: root.real, tool: "get_tables" },
      async (args, tool) => {
        const loaded = await openXlsx(args.filePath, tool);
        const sheet = selectSheetName(loaded.workbook, args.sheetName);
        return json(
          withMode(
            collectTables(sheet, loaded.workbook.facts(sheet).tables),
            loaded.mode,
          ),
        );
      },
    ),

    get_conditional_formats: guard(
      { root: root.real, tool: "get_conditional_formats" },
      async (args, tool) => {
        const loaded = await openXlsx(args.filePath, tool);
        const sheet = selectSheetName(loaded.workbook, args.sheetName);
        return json(
          withMode(
            collectConditionalFormats(
              sheet,
              loaded.workbook.facts(sheet).conditionalFormats,
            ),
            loaded.mode,
          ),
        );
      },
    ),

    get_images: guard(
      { root: root.real, tool: "get_images" },
      async (args, tool) => {
        assertPictureKind(args.kind);
        const loaded = await openXlsx(args.filePath, tool);
        const sheet = selectSheetName(loaded.workbook, args.sheetName);
        return json(
          withMode(
            collectImages(
              sheet,
              loaded.workbook.facts(sheet).images,
              loaded.workbook.media,
            ),
            loaded.mode,
          ),
        );
      },
    ),

    get_charts: guard(
      { root: root.real, tool: "get_charts" },
      async (args, tool) => {
        const loaded = await openXlsx(args.filePath, tool);
        const sheet = selectSheetName(loaded.workbook, args.sheetName, "any");
        return json(
          withMode(
            collectCharts(
              loaded.workbook.opc,
              sheet,
              loaded.workbook.facts(sheet).charts,
              {
                ...(args.chartId === undefined
                  ? {}
                  : { chartId: args.chartId }),
                ...(args.maxPoints === undefined
                  ? {}
                  : { maxPoints: args.maxPoints }),
              },
            ),
            loaded.mode,
          ),
        );
      },
    ),

    aggregate_sheet: guard(
      { root: root.real, tool: "aggregate_sheet" },
      async (args) => {
        assertHeaderScan(args, args.filePath);
        const loaded = await openFor(args.filePath, csvOptionsOf(args));
        return json(
          withAggregateEnvelope(
            aggregateSheet(sheetSource(loaded), {
              ...(args.sheetName === undefined
                ? {}
                : { sheetName: args.sheetName }),
              ...(args.range === undefined ? {} : { range: args.range }),
              ...(args.groupBy === undefined ? {} : { groupBy: args.groupBy }),
              ...(args.pivotBy === undefined ? {} : { pivotBy: args.pivotBy }),
              ...(args.groupingSets === undefined
                ? {}
                : { groupingSets: args.groupingSets }),
              metrics: args.metrics,
              ...(args.where === undefined ? {} : { where: args.where }),
              match: args.match ?? "all",
              ...resolveHeaderRow(loaded, args),
              columnMode: args.columnMode ?? "auto",
              caseSensitive: args.caseSensitive ?? false,
              ...(args.columns === undefined ? {} : { columns: args.columns }),
              mergedCells: args.mergedCells ?? "master",
              orderBy: args.orderBy ?? "group",
              ...(args.orderByMetric === undefined
                ? {}
                : { orderByMetric: args.orderByMetric }),
              descending: args.descending ?? false,
              maxGroups: args.maxGroups ?? limits.maxGroupsDefault,
            }),
            csvReportOf(loaded),
            loaded.mode,
            args.compact ?? false,
          ),
        );
      },
    ),

    find_in_sheet: guard(
      { root: root.real, tool: "find_in_sheet" },
      async (args, _tool, signal) => {
        const loaded = await openFor(args.filePath, csvOptionsOf(args));
        rejectForCsv(
          loaded,
          "searchIn",
          args.searchIn === "values" ? undefined : args.searchIn,
          args.filePath,
        );
        return json(
          withCsv(
            await findInSheet(sheetSource(loaded), {
              ...(signal === undefined ? {} : { signal }),
              query: args.query,
              ...(args.sheetName === undefined
                ? {}
                : { sheetName: args.sheetName }),
              ...(args.range === undefined ? {} : { range: args.range }),
              matchMode: args.matchMode ?? "contains",
              caseSensitive: args.caseSensitive ?? false,
              searchIn: args.searchIn ?? "values",
              maxResults: args.maxResults ?? limits.defaultFindResults,
            }),
            csvReportOf(loaded),
            loaded.mode,
          ),
        );
      },
    ),
  };
}
