export { SezzleeExcelError, asExcelError } from "./platform/errors.js";
export type { SezzleeExcelErrorCode } from "./platform/errors.js";
export { limits } from "./platform/limits.js";
export type { Limits } from "./platform/limits.js";
export { formats } from "./platform/formats.js";
export type { DocumentFormat } from "./platform/formats.js";
export {
  createWorkbookRoot,
  isContained,
  listWorkbooks,
  resolveWorkbookPath,
} from "./platform/paths.js";
export type {
  SandboxedPath,
  WorkbookEntry,
  WorkbookListing,
  WorkbookRoot,
} from "./platform/paths.js";
export {
  advance,
  columnToLetters,
  formatCellRef,
  formatRange,
  formatRectangle,
  lettersToColumn,
  parseCellRef,
  resolveRange,
} from "./grid/range.js";
export type { CellRef, GridBounds } from "./grid/range.js";
export {
  assertFresh,
  decodeCursor,
  encodeCursor,
  fingerprint,
} from "./grid/cursor.js";
export type { MergePolicy, SheetCursor, ValueMode } from "./grid/cursor.js";
export { normalizeCell } from "./grid/cell-value.js";
export type {
  CellNote,
  CellScalar,
  CellFacts,
  CellSnapshot,
  NormalizedCell,
} from "./grid/cell-value.js";
export { buildColumnIndex, resolveColumn } from "./grid/columns.js";
export type { ColumnIndex, ColumnMode } from "./grid/columns.js";
export {
  classify,
  compareWithin,
  emptyCensus,
  evaluate,
  majorityKind,
  validateCondition,
} from "./grid/predicate.js";
export type {
  CellKind,
  Census,
  ComparableKind,
  Condition,
  Operator,
  PredicateOptions,
} from "./grid/predicate.js";
export { collectTables, declaredTablesOf } from "./metadata/tables.js";
export type {
  DeclaredTableDetail,
  TableColumnDetail,
  TableReport,
} from "./metadata/tables.js";
export { requireSheetBounds } from "./grid/sheet.js";
export type {
  BoundedSheet,
  DeclaredTable,
  RowView,
  SheetSource,
  SheetView,
} from "./grid/sheet.js";
export { aggregateSheet } from "./grid/aggregate.js";
export type {
  AggregateColumn,
  AggregateOptions,
  AggregateResult,
  MetricFunction,
  MetricRequest,
} from "./grid/aggregate.js";
export { capabilities, capabilitiesFor } from "./platform/capabilities.js";
export type { FormatCapabilities } from "./platform/capabilities.js";
export {
  csvSheetName,
  csvSheetView,
  describeCsv,
  parseCsv,
  sniffDelimiter,
} from "./format/csv.js";
export type { CsvReport, CsvTable } from "./format/csv.js";
export { delimiterNames } from "./platform/delimited.js";
export type {
  CsvOptions,
  DelimiterName,
  EncodingName,
} from "./platform/delimited.js";
export {
  clearDocumentCache,
  csvReportOf,
  describeDocument,
  documentSheet,
  loadDocument,
} from "./format/document.js";
export type {
  DocumentDescription,
  LoadedCsv,
  LoadedDocument,
  LoadedWorkbook,
} from "./format/document.js";
export {
  describeOoxml,
  ooxmlSheetView,
  parseOoxml,
  selectSheetName,
} from "./format/ooxml-workbook.js";
export type { OoxmlWorkbook } from "./format/ooxml-workbook.js";
export type {
  DocumentMeta,
  SheetSummary,
  WorkbookDescription,
} from "./metadata/description.js";
export {
  collectConditionalFormats,
  conditionalFormatRuleCountOf,
} from "./metadata/conditional-formats.js";
export type {
  ConditionalFormatReport,
  ConditionalFormatRule,
  ConditionalFormatThreshold,
} from "./metadata/conditional-formats.js";
export { collectImages } from "./metadata/images.js";
export type { ImageReport, MediaEntry, SheetImage } from "./metadata/images.js";
export {
  collectValidations,
  compressAddresses,
} from "./metadata/validations.js";
export type {
  ValidationReport,
  ValidationRule,
} from "./metadata/validations.js";
export { findInSheet, readSheet } from "./grid/read-sheet.js";
export type {
  FindResult,
  ReadSheetOptions,
  ReadSheetResult,
} from "./grid/read-sheet.js";
export { closeRegexWorkers, withRegex } from "./platform/regex.js";
export { toolDefinitions, toolNames } from "./tools/definitions.js";
export type { ToolHandlers, ToolName } from "./tools/definitions.js";
export { createHandlers } from "./tools/handlers.js";
export { createExcelMcpServer } from "./server.js";
export { metadataLimitations } from "./metadata/support.js";
export type { MetadataLimitation } from "./metadata/support.js";
