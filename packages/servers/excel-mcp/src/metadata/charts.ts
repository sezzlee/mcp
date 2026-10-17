import { SezzleeExcelError } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import { reportedPlacement, type ReportedPlacement } from "./placement.js";
import type { MetadataLimitation } from "./support.js";
import {
  readChartPart,
  type ChartAxis,
  type ChartContent,
  type ChartPlot,
  type ChartTitle,
} from "./spreadsheetml/chart.js";
import type { OoxmlChartFrame } from "./spreadsheetml/drawing.js";
import type { OpcPackage } from "./spreadsheetml/package.js";

export interface SheetChart extends ReportedPlacement {
  readonly chartId: number;
  readonly name?: string;
  readonly title?: ChartTitle;
  readonly pivotSource?: string;
  readonly plots: readonly ChartPlot[];
  readonly axes: readonly ChartAxis[];
  readonly legend?: { readonly position: string };
  readonly unsupported?: "chartEx" | "missing";
}

export interface ChartReport {
  readonly sheet: string;
  readonly count: number;
  readonly charts: readonly SheetChart[];
  readonly truncated: boolean;
  readonly truncationReason?:
    "maxChartsPerSheet" | "maxSeriesPerChart" | "maxPointsPerResponse";
  readonly hint?: string;
  readonly limitations: readonly MetadataLimitation[];
}

export interface CollectChartsOptions {
  readonly chartId?: number;
  readonly maxPoints?: number;
}

function readFrame(
  opc: OpcPackage,
  frame: OoxmlChartFrame,
  chartId: number,
  options: {
    readonly maxPoints: number;
    readonly pointBudget: { remaining: number };
  },
): SheetChart {
  const base = {
    chartId,
    ...(frame.name === undefined ? {} : { name: frame.name }),
    ...reportedPlacement(frame),
  };
  if (frame.target.kind === "missing") {
    return { ...base, plots: [], axes: [], unsupported: "missing" };
  }
  if (frame.target.kind === "chartEx") {
    return { ...base, plots: [], axes: [], unsupported: "chartEx" };
  }
  const content: ChartContent | undefined = readChartPart(
    opc,
    frame.target.part,
    options,
  );
  if (content === undefined) {
    return { ...base, plots: [], axes: [], unsupported: "missing" };
  }
  return {
    ...base,
    ...(content.title === undefined ? {} : { title: content.title }),
    ...(content.pivotSource === undefined
      ? {}
      : { pivotSource: content.pivotSource }),
    plots: content.plots,
    axes: content.axes,
    ...(content.legend === undefined ? {} : { legend: content.legend }),
  };
}

/**
 * Lists charts on a sheet. Frames come from the drawing; series, titles and
 * cached points are read from each `xl/charts` part only when this runs.
 */
export function collectCharts(
  opc: OpcPackage,
  sheet: string,
  frames: readonly OoxmlChartFrame[],
  options: CollectChartsOptions = {},
): ChartReport {
  const maxPoints = Math.min(
    options.maxPoints ?? limits.maxChartPointsDefault,
    limits.maxChartPointsHard,
  );
  const { chartId } = options;
  if (chartId !== undefined && chartId > frames.length) {
    throw new SezzleeExcelError(
      "invalid_argument",
      `Sheet '${sheet}' has ${frames.length} chart${frames.length === 1 ? "" : "s"}; there is no chart ${chartId}.`,
      frames.length === 0
        ? "Call describe_workbook to see chartCount on every sheet."
        : `Pass a chartId from 1 to ${frames.length}, or omit it to list every chart.`,
    );
  }
  const selected =
    chartId === undefined ? frames : frames.slice(chartId - 1, chartId);
  const truncated = selected.length > limits.maxChartsPerSheet;
  const kept = truncated
    ? selected.slice(0, limits.maxChartsPerSheet)
    : selected;
  const pointBudget: { remaining: number } = {
    remaining: limits.maxChartPointsPerResponse,
  };
  const charts = kept.map((frame, index) =>
    readFrame(opc, frame, chartId ?? index + 1, {
      maxPoints,
      pointBudget,
    }),
  );
  const pointsExhausted =
    pointBudget.remaining === 0 &&
    charts.some((chart) =>
      chart.plots.some((plot) =>
        plot.series.some(
          (series) =>
            series.values?.truncated === true ||
            series.categories?.truncated === true ||
            series.x?.truncated === true ||
            series.y?.truncated === true ||
            series.size?.truncated === true,
        ),
      ),
    );
  const seriesOmitted = charts.some((chart) =>
    chart.plots.some((plot) => plot.omittedSeries !== undefined),
  );
  return {
    sheet,
    count: chartId === undefined ? frames.length : selected.length,
    charts,
    truncated: truncated || seriesOmitted || pointsExhausted,
    limitations: [],
    ...(truncated
      ? {
          truncationReason: "maxChartsPerSheet" as const,
          hint: `${frames.length} charts are on this sheet; the first ${limits.maxChartsPerSheet} are listed.`,
        }
      : seriesOmitted
        ? {
            truncationReason: "maxSeriesPerChart" as const,
            hint: `A plot holds more than ${limits.maxSeriesPerChart} series; omittedSeries counts the ones not listed.`,
          }
        : pointsExhausted
          ? {
              truncationReason: "maxPointsPerResponse" as const,
              hint: `Cached series points were cut at ${limits.maxChartPointsPerResponse} for this response. Pass chartId to read one chart, or raise maxPoints up to ${limits.maxChartPointsHard}.`,
            }
          : {}),
  };
}
