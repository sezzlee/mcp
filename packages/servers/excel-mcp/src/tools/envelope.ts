import { measureJson, type SourceMode } from "@sezzlee/file-core";
import type { CsvReport } from "../format/csv.js";

export const modeEnvelopeBytes = measureJson({ mode: "resident" });

export function withCsv<T extends object>(
  payload: T,
  report: CsvReport | undefined,
  mode: SourceMode,
): T & { mode: SourceMode; csv?: CsvReport } {
  return report === undefined
    ? { ...payload, mode }
    : { ...payload, csv: report, mode };
}

export function withMode<T extends object>(
  payload: T,
  mode: SourceMode,
): T & { mode: SourceMode } {
  return { ...payload, mode };
}

export function withAggregateEnvelope<T extends object>(
  payload: T,
  report: CsvReport | undefined,
  mode: SourceMode,
  compact: boolean,
): T & { mode?: SourceMode; csv?: Partial<CsvReport> } {
  if (!compact) return withCsv(payload, report, mode);
  if (report === undefined) return payload;
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
  return Object.keys(csv).length === 0 ? payload : { ...payload, csv };
}
