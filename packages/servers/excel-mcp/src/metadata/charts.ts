import { limits } from "../platform/limits.js";
import type { MetadataLimitation } from "./support.js";
import {
  readChartPart,
  type ChartAxis,
  type ChartContent,
  type ChartPlot,
  type ChartTitle,
} from "./spreadsheetml/chart.js";
import type {
  AnchorCell,
  OoxmlChartFrame,
} from "./spreadsheetml/drawing.js";
import type { OpcPackage } from "./spreadsheetml/package.js";
import { formatRectangle } from "../grid/range.js";

export interface SheetChart {
  readonly chartId: number;
  readonly name?: string;
  readonly range?: string;
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
  readonly truncationReason?: "maxChartsPerSheet" | "maxPointsPerResponse";
  readonly hint?: string;
  readonly limitations: readonly MetadataLimitation[];
}

export interface CollectChartsOptions {
  readonly chartId?: number;
  readonly maxPoints?: number;
}

/**
 * A `to` anchor sitting exactly on a cell boundary stops at the previous cell;
 * any offset into the cell means the frame covers it. An absolute anchor has
 * no cell anchor at all, so it gets no range rather than a fabricated one.
 */
function occupiedRange(
  from: AnchorCell | undefined,
  to: AnchorCell | undefined,
): string | undefined {
  if (from === undefined) {
    return undefined;
  }
  const top = from.row + 1;
  const left = from.column + 1;
  if (to === undefined) {
    return formatRectangle(top, left, top, left);
  }
  const bottom = to.rowOffset === 0 ? to.row : to.row + 1;
  const right = to.columnOffset === 0 ? to.column : to.column + 1;
  return formatRectangle(
    top,
    left,
    Math.max(top, bottom),
    Math.max(left, right),
  );
}

function emptyContent(): ChartContent {
  return { plots: [], axes: [] };
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
  const range = occupiedRange(frame.from, frame.to);
  const base = {
    chartId,
    ...(frame.name === undefined ? {} : { name: frame.name }),
    ...(range === undefined ? {} : { range }),
  };
  if (frame.target.kind === "missing") {
    return { ...base, plots: [], axes: [], unsupported: "missing" };
  }
  if (frame.target.kind === "chartEx") {
    return { ...base, plots: [], axes: [], unsupported: "chartEx" };
  }
  const content =
    opc.part(frame.target.part) === undefined
      ? emptyContent()
      : readChartPart(opc, frame.target.part, options);
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
  const selected =
    options.chartId === undefined
      ? frames
      : frames.filter((_, index) => index + 1 === options.chartId);
  const truncated = selected.length > limits.maxChartsPerSheet;
  const kept = truncated
    ? selected.slice(0, limits.maxChartsPerSheet)
    : selected;
  const pointBudget: { remaining: number } = {
    remaining: limits.maxChartPointsPerResponse,
  };
  const charts = kept.map((frame, index) =>
    readFrame(opc, frame, options.chartId ?? index + 1, {
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
  return {
    sheet,
    count: options.chartId === undefined ? frames.length : selected.length,
    charts,
    truncated: truncated || pointsExhausted,
    limitations: [],
    ...(truncated
      ? {
          truncationReason: "maxChartsPerSheet" as const,
          hint: `${frames.length} charts are on this sheet; the first ${limits.maxChartsPerSheet} are listed.`,
        }
      : pointsExhausted
        ? {
            truncationReason: "maxPointsPerResponse" as const,
            hint: `Cached series points were cut at ${limits.maxChartPointsPerResponse} for this response. Pass chartId to read one chart, or raise maxPoints up to ${limits.maxChartPointsHard}.`,
          }
        : {}),
  };
}
