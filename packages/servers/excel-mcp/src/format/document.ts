import {
  createDocumentStore,
  type DocumentStore,
  type OpenedFile,
  type ParseContext,
  type SandboxedPath,
} from "@sezzlee/file-core";
import {
  capabilitiesFor,
  type FormatCapabilities,
} from "../platform/capabilities.js";
import {
  csvSheetName,
  csvSheetView,
  describeCsv,
  parseCsv,
  type CsvReport,
  type CsvTable,
} from "./csv.js";
import type { CsvOptions } from "../platform/delimited.js";
import { SezzleeExcelError, fail } from "../platform/errors.js";
import { formats, type DocumentFormat } from "../platform/formats.js";
import { limits, modePolicy } from "../platform/limits.js";
import { assertReadableFormat } from "../platform/paths.js";
import type { SheetSource, SheetView } from "../grid/sheet.js";
import { vocabulary } from "../platform/vocabulary.js";
import {
  assertWorksheet,
  describeOoxml,
  ooxmlSheetView,
  parseOoxml,
  selectSheetName,
  type OoxmlWorkbook,
} from "./ooxml-workbook.js";
import type {
  DocumentMeta,
  WorkbookDescription,
} from "../metadata/description.js";
import { declaredTablesOf } from "../metadata/tables.js";

interface XlsxBody {
  readonly format: "xlsx";
  readonly workbook: OoxmlWorkbook;
}

interface CsvBody {
  readonly format: "csv";
  readonly table: CsvTable;
}

type DocumentBody = XlsxBody | CsvBody;

export type LoadedWorkbook = XlsxBody & OpenedFile;
export type LoadedCsv = CsvBody & OpenedFile;
export type LoadedDocument = LoadedWorkbook | LoadedCsv;

async function parseDocument(
  context: ParseContext,
  options: CsvOptions,
): Promise<DocumentBody> {
  const format = formats.formatFor(context.path);
  const bytes =
    context.mode === "resident"
      ? context.bytes
      : await context.source.read({
          offset: 0,
          length: context.source.sizeBytes,
        });
  if (format === "csv") {
    const table = await parseCsv(
      bytes,
      context.sizeBytes,
      options,
      context.displayPath,
    );
    return { format, table };
  }
  assertReadableFormat(bytes.subarray(0, 8), context.displayPath);
  const workbook = parseOoxml(bytes, context.displayPath);
  return { format, workbook };
}

function variantKey(options: CsvOptions): string {
  return [options.delimiter ?? "", options.encoding ?? ""].join(":");
}

export interface DocumentCache {
  load(path: SandboxedPath, options?: CsvOptions): Promise<LoadedDocument>;
  clear(): void;
  readonly size: number;
}

export function createDocumentCache(root?: string): DocumentCache {
  const store: DocumentStore<DocumentBody, CsvOptions> = createDocumentStore({
    maxEntries: limits.documentCacheSize,
    maxBytes: limits.maxFileBytes,
    maxBytesFor: (path) =>
      formats.formatFor(path) === "csv"
        ? limits.maxCsvBytes
        : limits.maxFileBytes,
    mode: modePolicy,
    ...(root === undefined ? {} : { root }),
    vocabulary,
    fail,
    variantKey,
    parse: parseDocument,
  });
  return {
    load: (path, options = {}) => store.load(path, options),
    clear: () => {
      store.clear();
    },
    get size() {
      return store.size;
    },
  };
}

const defaultCache = createDocumentCache();

export function clearDocumentCache(): void {
  defaultCache.clear();
}

export async function loadDocument(
  path: SandboxedPath,
  options: CsvOptions = {},
): Promise<LoadedDocument> {
  return defaultCache.load(path, options);
}

export function documentSheet(
  loaded: LoadedDocument,
  sheetName: string | undefined,
): SheetView {
  if (loaded.format === "csv") {
    if (sheetName !== undefined && sheetName !== csvSheetName) {
      throw new SezzleeExcelError(
        "unknown_sheet",
        `A CSV file has no sheet named '${sheetName}'.`,
        `Available sheets: ${csvSheetName}.`,
      );
    }
    return csvSheetView(loaded.table);
  }
  const name = selectSheetName(loaded.workbook, sheetName);
  assertWorksheet(loaded.workbook, name);
  return ooxmlSheetView(
    loaded.workbook,
    name,
    declaredTablesOf(loaded.workbook.sheet(name).facts.tables),
  );
}

export function sheetSource(loaded: LoadedDocument): SheetSource {
  return {
    stamp: loaded.stamp,
    sheetFor: (sheetName) => documentSheet(loaded, sheetName),
  };
}

export function csvReportOf(loaded: LoadedDocument): CsvReport | undefined {
  return loaded.format === "csv" ? loaded.table.report : undefined;
}

export interface DocumentDescription extends WorkbookDescription {
  readonly format: DocumentFormat;
  readonly capabilities: FormatCapabilities;
  readonly csv?: CsvReport;
}

export function describeDocument(
  loaded: LoadedDocument,
  meta: DocumentMeta,
  includeDefinedNames: boolean,
): DocumentDescription {
  const body =
    loaded.format === "csv"
      ? describeCsv(loaded.table, meta)
      : describeOoxml(loaded.workbook, meta, { includeDefinedNames });
  return {
    ...body,
    format: loaded.format,
    capabilities: capabilitiesFor(loaded),
    ...(loaded.format === "csv" ? { csv: loaded.table.report } : {}),
  };
}
