import { limits } from "../../platform/limits.js";
import type { OpcPackage } from "./package.js";
import { namespaces, scanPart, type XmlVisitor } from "./xml.js";

export type ChartPlotType =
  | "bar"
  | "line"
  | "pie"
  | "doughnut"
  | "area"
  | "scatter"
  | "bubble"
  | "radar"
  | "stock"
  | "surface"
  | "ofPie";

export type ChartTitle =
  { readonly text: string } | { readonly text: string; readonly ref: string };

export type SeriesPoints = readonly (string | number | null)[];

export type SeriesData =
  | {
      readonly kind: "reference";
      readonly ref: string;
      readonly external?: true;
      readonly count: number;
      readonly points: SeriesPoints;
      readonly truncated: boolean;
    }
  | {
      readonly kind: "literal";
      readonly count: number;
      readonly points: SeriesPoints;
      readonly truncated: boolean;
    };

export interface ChartTrendline {
  readonly type: string;
}

export interface ChartSeries {
  readonly name?: ChartTitle;
  readonly hidden?: true;
  readonly trendlines?: readonly ChartTrendline[];
  readonly categories?: SeriesData;
  readonly values?: SeriesData;
  readonly x?: SeriesData;
  readonly y?: SeriesData;
  readonly size?: SeriesData;
}

export interface ChartPlot {
  readonly type: ChartPlotType;
  readonly direction?: "bar" | "col";
  readonly grouping?: string;
  readonly axes: readonly number[];
  readonly series: readonly ChartSeries[];
}

export interface ChartAxis {
  readonly id: number;
  readonly kind: "category" | "value" | "date" | "series";
  readonly position?: string;
  readonly secondary?: true;
  readonly title?: ChartTitle;
  readonly deleted: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly logBase?: number;
  readonly numberFormat?: string;
}

export interface ChartContent {
  readonly title?: ChartTitle;
  readonly pivotSource?: string;
  readonly plots: readonly ChartPlot[];
  readonly axes: readonly ChartAxis[];
  readonly legend?: { readonly position: string };
}

const plotTypes: Readonly<Record<string, ChartPlotType>> = {
  barChart: "bar",
  bar3DChart: "bar",
  lineChart: "line",
  line3DChart: "line",
  pieChart: "pie",
  pie3DChart: "pie",
  doughnutChart: "doughnut",
  areaChart: "area",
  area3DChart: "area",
  scatterChart: "scatter",
  bubbleChart: "bubble",
  radarChart: "radar",
  stockChart: "stock",
  surfaceChart: "surface",
  surface3DChart: "surface",
  ofPieChart: "ofPie",
};

const axisKinds: Readonly<
  Record<string, "category" | "value" | "date" | "series">
> = {
  catAx: "category",
  valAx: "value",
  dateAx: "date",
  serAx: "series",
};

interface PointDraft {
  readonly index: number;
  readonly value: string;
}

interface DataDraft {
  kind: "reference" | "literal";
  ref?: string;
  points: PointDraft[];
  declaredCount: number;
}

interface SeriesDraft {
  name?: ChartTitle;
  hidden?: true;
  trendlines: ChartTrendline[];
  categories?: DataDraft;
  values?: DataDraft;
  x?: DataDraft;
  y?: DataDraft;
  size?: DataDraft;
  slot?: "categories" | "values" | "x" | "y" | "size" | "name";
}

interface PlotDraft {
  type: ChartPlotType;
  direction?: "bar" | "col";
  grouping?: string;
  axes: number[];
  series: SeriesDraft[];
}

interface AxisDraft {
  id?: number;
  kind: "category" | "value" | "date" | "series";
  position?: string;
  secondary?: true;
  title?: ChartTitle;
  deleted: boolean;
  min?: number;
  max?: number;
  logBase?: number;
  numberFormat?: string;
}

interface TitleDraft {
  text: string;
  ref?: string;
}

export interface ReadChartOptions {
  readonly maxPoints: number;
  readonly pointBudget: { remaining: number };
}

/** Guard: a local `Sheet1!$A$1` always contains `!`; only `[n]…` / `'[file]Sheet'!…` are external. */
function isExternalRef(ref: string): boolean {
  const trimmed = ref.trimStart();
  return trimmed.startsWith("[") || trimmed.startsWith("'[");
}

function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function finishData(
  draft: DataDraft | undefined,
  options: ReadChartOptions,
): SeriesData | undefined {
  if (draft === undefined) return undefined;
  const sorted = [...draft.points].sort((a, b) => a.index - b.index);
  const last = sorted.at(-1)?.index;
  const count =
    last === undefined ? Math.max(0, draft.declaredCount) : last + 1;
  const capped = Math.min(
    count,
    options.maxPoints,
    options.pointBudget.remaining,
  );
  const truncated = capped < count;
  options.pointBudget.remaining = Math.max(
    0,
    options.pointBudget.remaining - capped,
  );
  const byIndex = new Map(
    sorted.map((point): [number, string] => [point.index, point.value]),
  );
  const points: (string | number | null)[] = [];
  for (let index = 0; index < capped; index += 1) {
    const raw = byIndex.get(index);
    if (raw === undefined) {
      points.push(null);
      continue;
    }
    const asNumber = Number(raw);
    points.push(
      raw !== "" && Number.isFinite(asNumber) && String(asNumber) === raw.trim()
        ? asNumber
        : raw,
    );
  }
  if (draft.kind === "reference" && draft.ref !== undefined) {
    return {
      kind: "reference",
      ref: draft.ref,
      ...(isExternalRef(draft.ref) ? { external: true as const } : {}),
      count,
      points,
      truncated,
    };
  }
  return { kind: "literal", count, points, truncated };
}

function finishSeries(
  draft: SeriesDraft,
  options: ReadChartOptions,
): ChartSeries {
  return {
    ...(draft.name === undefined ? {} : { name: draft.name }),
    ...(draft.hidden === undefined ? {} : { hidden: true as const }),
    ...(draft.trendlines.length === 0 ? {} : { trendlines: draft.trendlines }),
    ...(draft.categories === undefined
      ? {}
      : { categories: finishData(draft.categories, options) }),
    ...(draft.values === undefined
      ? {}
      : { values: finishData(draft.values, options) }),
    ...(draft.x === undefined ? {} : { x: finishData(draft.x, options) }),
    ...(draft.y === undefined ? {} : { y: finishData(draft.y, options) }),
    ...(draft.size === undefined
      ? {}
      : { size: finishData(draft.size, options) }),
  };
}

function finishAxis(draft: AxisDraft): ChartAxis | undefined {
  if (draft.id === undefined) return undefined;
  return {
    id: draft.id,
    kind: draft.kind,
    ...(draft.position === undefined ? {} : { position: draft.position }),
    ...(draft.secondary === undefined ? {} : { secondary: true as const }),
    ...(draft.title === undefined ? {} : { title: draft.title }),
    deleted: draft.deleted,
    ...(draft.min === undefined ? {} : { min: draft.min }),
    ...(draft.max === undefined ? {} : { max: draft.max }),
    ...(draft.logBase === undefined ? {} : { logBase: draft.logBase }),
    ...(draft.numberFormat === undefined
      ? {}
      : { numberFormat: draft.numberFormat }),
  };
}

/**
 * Reads one DrawingML chart part. Cached points are capped by `maxPoints` and
 * the shared response budget; `ptCount` is never used to allocate memory.
 */
export function readChartPart(
  opc: OpcPackage,
  part: string,
  options: ReadChartOptions,
): ChartContent {
  const plots: PlotDraft[] = [];
  const axes: AxisDraft[] = [];
  let plot: PlotDraft | undefined;
  let series: SeriesDraft | undefined;
  let axis: AxisDraft | undefined;
  let data: DataDraft | undefined;
  let title: TitleDraft | undefined;
  let titleTarget: "chart" | "axis" | undefined;
  let chartTitle: ChartTitle | undefined;
  let pivotSource: string | undefined;
  let inPivotSource = false;
  let inScaling = false;
  let legendPosition: string | undefined;
  let text = "";
  let collectingText = false;
  let pointIndex: number | undefined;

  const beginData = (kind: "reference" | "literal"): void => {
    data = { kind, points: [], declaredCount: 0 };
  };

  const visitor: XmlVisitor = {
    onOpen(node) {
      if (node.uri === namespaces.drawing && node.local === "t") {
        text = "";
        collectingText = true;
        return;
      }
      if (series !== undefined && node.local.startsWith("filtered")) {
        series.hidden = true;
      }
      if (node.uri !== namespaces.chart) return;
      const plotType = plotTypes[node.local];
      if (plotType !== undefined) {
        plot = { type: plotType, axes: [], series: [] };
        return;
      }
      const axisKind = axisKinds[node.local];
      if (axisKind !== undefined) {
        axis = { kind: axisKind, deleted: false };
        return;
      }
      switch (node.local) {
        case "ser":
          if (plot !== undefined) series = { trendlines: [] };
          break;
        case "barDir": {
          const value = node.attr("val");
          if (plot !== undefined && (value === "bar" || value === "col")) {
            plot.direction = value;
          }
          break;
        }
        case "grouping":
          if (plot !== undefined) plot.grouping ??= node.attr("val");
          break;
        case "axId": {
          const id = Number.parseInt(node.attr("val") ?? "", 10);
          if (plot !== undefined && Number.isFinite(id)) plot.axes.push(id);
          break;
        }
        case "cat":
          if (series !== undefined) series.slot = "categories";
          break;
        case "val":
          if (series !== undefined) series.slot = "values";
          break;
        case "xVal":
          if (series !== undefined) series.slot = "x";
          break;
        case "yVal":
          if (series !== undefined) series.slot = "y";
          break;
        case "bubbleSize":
          if (series !== undefined) series.slot = "size";
          break;
        case "tx":
          if (series !== undefined) {
            series.slot = "name";
          } else if (titleTarget !== undefined) {
            title ??= { text: "" };
          }
          break;
        case "title":
          titleTarget = axis !== undefined ? "axis" : "chart";
          title = { text: "" };
          break;
        case "numRef":
        case "strRef":
          beginData("reference");
          break;
        case "numLit":
        case "strLit":
          beginData("literal");
          break;
        case "f":
          text = "";
          collectingText = true;
          break;
        case "ptCount":
          if (data !== undefined) {
            data.declaredCount =
              Number.parseInt(node.attr("val") ?? "0", 10) || 0;
          }
          break;
        case "pt":
          if (data !== undefined) {
            pointIndex = Number.parseInt(node.attr("idx") ?? "", 10);
            text = "";
          }
          break;
        case "v":
          text = "";
          collectingText = true;
          break;
        case "legendPos":
          legendPosition ??= node.attr("val");
          break;
        case "delete":
          if (axis !== undefined && node.attr("val") === "1") {
            axis.deleted = true;
          }
          break;
        case "axPos": {
          const position = node.attr("val");
          if (axis !== undefined && position !== undefined) {
            axis.position ??= position;
            if (position === "r" || position === "t") {
              axis.secondary = true;
            }
          }
          break;
        }
        case "scaling":
          if (axis !== undefined) inScaling = true;
          break;
        case "min":
          if (axis !== undefined && inScaling) {
            axis.min ??= parseNumber(node.attr("val"));
          }
          break;
        case "max":
          if (axis !== undefined && inScaling) {
            axis.max ??= parseNumber(node.attr("val"));
          }
          break;
        case "logBase":
          if (axis !== undefined && inScaling) {
            axis.logBase ??= parseNumber(node.attr("val"));
          }
          break;
        case "numFmt":
          if (axis !== undefined) {
            axis.numberFormat ??= node.attr("formatCode");
          }
          break;
        case "trendlineType": {
          const type = node.attr("val");
          if (series !== undefined && type !== undefined) {
            series.trendlines.push({ type });
          }
          break;
        }
        case "pivotSource":
          inPivotSource = true;
          break;
        case "name":
          if (inPivotSource) {
            text = "";
            collectingText = true;
          }
          break;
        default:
          break;
      }
      if (
        axis !== undefined &&
        node.local === "axId" &&
        axis.id === undefined
      ) {
        const id = Number.parseInt(node.attr("val") ?? "", 10);
        if (Number.isFinite(id)) axis.id = id;
      }
    },
    onText(chunk) {
      if (collectingText || pointIndex !== undefined) text += chunk;
    },
    onClose(local, uri) {
      if (uri === namespaces.drawing && local === "t" && collectingText) {
        collectingText = false;
        if (title !== undefined) {
          title.text = title.text === "" ? text : `${title.text}${text}`;
        } else if (series?.slot === "name" && series.name === undefined) {
          series.name = { text };
        }
        text = "";
        return;
      }
      if (uri !== namespaces.chart) return;
      if (local === "f" && collectingText) {
        collectingText = false;
        if (data !== undefined && data.ref === undefined) data.ref = text;
        else if (
          series?.slot === "name" &&
          series.name === undefined &&
          text !== ""
        ) {
          series.name = { text: "", ref: text };
        } else if (title !== undefined && title.ref === undefined) {
          title.ref = text;
        }
        text = "";
        return;
      }
      if (local === "name" && inPivotSource && collectingText) {
        collectingText = false;
        pivotSource ??= text;
        text = "";
        return;
      }
      if (local === "v") {
        collectingText = false;
        if (
          data !== undefined &&
          pointIndex !== undefined &&
          Number.isFinite(pointIndex)
        ) {
          data.points.push({ index: pointIndex, value: text });
        } else if (series?.slot === "name" && series.name === undefined) {
          series.name = { text };
        } else if (title !== undefined && title.text === "") {
          title.text = text;
        }
        pointIndex = undefined;
        text = "";
        return;
      }
      if (
        (local === "numRef" ||
          local === "strRef" ||
          local === "numLit" ||
          local === "strLit") &&
        data !== undefined &&
        series !== undefined
      ) {
        const slot = series.slot;
        if (slot === "categories") series.categories ??= data;
        else if (slot === "values") series.values ??= data;
        else if (slot === "x") series.x ??= data;
        else if (slot === "y") series.y ??= data;
        else if (slot === "size") series.size ??= data;
        else if (slot === "name" && data.ref !== undefined) {
          const cached = data.points.find((point) => point.index === 0)?.value;
          series.name ??= {
            text: cached ?? "",
            ref: data.ref,
          };
        }
        data = undefined;
        return;
      }
      if (
        local === "cat" ||
        local === "val" ||
        local === "xVal" ||
        local === "yVal" ||
        local === "bubbleSize" ||
        local === "tx"
      ) {
        if (series !== undefined) series.slot = undefined;
        return;
      }
      if (local === "scaling") {
        inScaling = false;
        return;
      }
      if (local === "pivotSource") {
        inPivotSource = false;
        return;
      }
      if (local === "title") {
        if (title !== undefined) {
          const finished =
            title.ref === undefined
              ? { text: title.text }
              : { text: title.text, ref: title.ref };
          if (titleTarget === "axis" && axis !== undefined) {
            axis.title ??= finished;
          } else if (titleTarget === "chart") {
            chartTitle ??= finished;
          }
        }
        title = undefined;
        titleTarget = undefined;
        return;
      }
      if (local === "ser" && series !== undefined && plot !== undefined) {
        if (plot.series.length < limits.maxSeriesPerChart) {
          plot.series.push(series);
        }
        series = undefined;
        return;
      }
      if (plotTypes[local] !== undefined && plot !== undefined) {
        plots.push(plot);
        plot = undefined;
        return;
      }
      if (axisKinds[local] !== undefined && axis !== undefined) {
        axes.push(axis);
        axis = undefined;
        inScaling = false;
      }
    },
  };

  scanPart(opc, part, visitor);

  return {
    ...(chartTitle === undefined ? {} : { title: chartTitle }),
    ...(pivotSource === undefined ? {} : { pivotSource }),
    plots: plots.map((draft) => ({
      type: draft.type,
      ...(draft.direction === undefined ? {} : { direction: draft.direction }),
      ...(draft.grouping === undefined ? {} : { grouping: draft.grouping }),
      axes: draft.axes,
      series: draft.series.map((item) => finishSeries(item, options)),
    })),
    axes: axes.flatMap((draft) => {
      const finished = finishAxis(draft);
      return finished === undefined ? [] : [finished];
    }),
    ...(legendPosition === undefined
      ? {}
      : { legend: { position: legendPosition } }),
  };
}
