import { measureJson, type SourceMode } from "@sezzlee/file-core";
import type { CsvReport } from "../format/csv.js";
import type { ReadVersion } from "../format/document.js";

export interface ReadSource {
  readonly mode: SourceMode;
  readonly version: ReadVersion;
}

export function sourceEnvelopeBytes(source: ReadSource): number {
  return measureJson({ mode: source.mode, version: source.version });
}

export function withCsv<T extends object>(
  payload: T,
  report: CsvReport | undefined,
  source: ReadSource,
): T & ReadSource & { csv?: CsvReport } {
  return report === undefined
    ? { ...payload, mode: source.mode, version: source.version }
    : { ...payload, csv: report, mode: source.mode, version: source.version };
}

export function withMode<T extends object>(
  payload: T,
  source: ReadSource,
): T & ReadSource {
  return { ...payload, mode: source.mode, version: source.version };
}

export function withAggregateEnvelope<T extends object>(
  payload: T,
  report: CsvReport | undefined,
  source: ReadSource,
  compact: boolean,
): T & {
  mode?: SourceMode;
  version: ReadVersion;
  csv?: Partial<CsvReport>;
} {
  if (!compact) return withCsv(payload, report, source);
  const versioned = { ...payload, version: source.version };
  if (report === undefined) return versioned;
  const csv: Partial<CsvReport> = {
    ...(report.warnings === undefined ? {} : { warnings: report.warnings }),
    ...(report.raggedRecordCount === 0
      ? {}
      : { raggedRecordCount: report.raggedRecordCount }),
    ...(report.blankRecordCount === 0
      ? {}
      : { blankRecordCount: report.blankRecordCount }),
    ...(report.formulaLikeCellCount === 0
      ? {}
      : { formulaLikeCellCount: report.formulaLikeCellCount }),
    ...(report.duplicateHeaders === undefined
      ? {}
      : { duplicateHeaders: report.duplicateHeaders }),
  };
  return Object.keys(csv).length === 0 ? versioned : { ...versioned, csv };
}
