import { coreLimits, type ModePolicy } from "@sezzlee/file-core";

export const modePolicy: ModePolicy = {
  residentMaxBytes: coreLimits.maxFileBytes,
};

export const limits = {
  ...coreLimits,
  maxCellsHard: 10_000,
  maxCellsDefault: 2_000,
  maxFindResults: 200,
  defaultFindResults: 50,
  maxRegexSource: 256,
  maxRangesPerRule: 64,
  maxTablesPerSheet: 64,
  maxTableColumns: 256,
  maxConditionalFormatRules: 200,
  maxImagesPerSheet: 200,
  maxChartsPerSheet: 200,
  maxChartPointsDefault: 200,
  maxChartPointsHard: 2_000,
  maxChartPointsPerResponse: 5_000,
  maxSeriesPerChart: 255,
  maxCsvBytes: 16 * 1024 * 1024, // 16 MB
  maxCsvCells: 2_000_000,
  maxCsvColumns: 16_384,
  csvNulScanBytes: 8 * 1024, // 8 KB
  csvSniffBytes: 64 * 1024, // 64 KB
  csvSniffLines: 20,
  headerScanRows: 20,
  maxGroupsDefault: 50,
  maxGroupsHard: 500,
  maxAggregateGroups: 100_000,
  maxAggregateCellVisits: 20_000_000,
  maxConditions: 16,
  maxColumnSpecs: 16,
  maxMetrics: 8,
  maxInValues: 64,
  guidanceRowThreshold: 5_000,
} as const;

export type Limits = typeof limits;
