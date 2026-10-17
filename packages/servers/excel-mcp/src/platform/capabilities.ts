import type { DocumentFormat } from "./formats.js";

export interface FormatCapabilities {
  readonly merges: boolean;
  readonly dataValidations: boolean;
  readonly formulas: boolean;
  readonly numberFormats: boolean;
  readonly hyperlinks: boolean;
  readonly multipleSheets: boolean;
  readonly definedNames: boolean;
  readonly typedValues: boolean;
  readonly headerScan: boolean;
  readonly tables: boolean;
  readonly conditionalFormats: boolean;
  readonly images: boolean;
  readonly frozenPanes: boolean;
  readonly charts: boolean;
  readonly pivotTables: boolean;
  readonly sparklines: boolean;
}

const csv: FormatCapabilities = {
  merges: false,
  dataValidations: false,
  formulas: false,
  numberFormats: false,
  hyperlinks: false,
  multipleSheets: false,
  definedNames: false,
  typedValues: false,
  headerScan: false,
  tables: false,
  conditionalFormats: false,
  images: false,
  frozenPanes: false,
  charts: false,
  pivotTables: false,
  sparklines: false,
};

const xlsx: FormatCapabilities = {
  merges: true,
  dataValidations: true,
  formulas: true,
  numberFormats: true,
  hyperlinks: true,
  multipleSheets: true,
  definedNames: true,
  typedValues: true,
  headerScan: true,
  tables: true,
  conditionalFormats: true,
  images: true,
  frozenPanes: true,
  charts: true,
  pivotTables: false,
  sparklines: false,
};

export const capabilities: Readonly<
  Record<DocumentFormat, FormatCapabilities>
> = { xlsx, csv };

export function capabilitiesFor(document: {
  readonly format: DocumentFormat;
}): FormatCapabilities {
  return document.format === "csv" ? csv : xlsx;
}
