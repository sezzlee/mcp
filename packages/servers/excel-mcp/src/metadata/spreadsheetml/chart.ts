import { selectAlternateContent } from "@sezzlee/ooxml-core";
import { limits } from "../../platform/limits.js";
import type { OpcPackage } from "./package.js";
import { transitionalNamespace } from "./reader.js";
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

interface SeriesDataCommon {
  readonly count: number;
  readonly points: SeriesPoints;
  /** The cache's number format, omitted when it is `General`. */
  readonly numberFormat?: string;
  readonly truncated: boolean;
}

export type SeriesData =
  | (SeriesDataCommon & {
      readonly kind: "reference";
      readonly ref: string;
      readonly external?: true;
      /**
       * The outer levels of a multi-level category, innermost first; `points`
       * holds the level next to the axis.
       */
      readonly levels?: readonly SeriesPoints[];
    })
  | (SeriesDataCommon & { readonly kind: "literal" });

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
  /** Series past `maxSeriesPerChart`, counted but not listed. */
  readonly omittedSeries?: number;
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

type Slot = "name" | "categories" | "values" | "x" | "y" | "size";

const slots: Readonly<Record<string, Slot>> = {
  tx: "name",
  cat: "categories",
  val: "values",
  xVal: "x",
  yVal: "y",
  bubbleSize: "size",
};

const dataSources: Readonly<
  Record<string, { readonly kind: "reference" | "literal"; numeric: boolean }>
> = {
  numRef: { kind: "reference", numeric: true },
  numLit: { kind: "literal", numeric: true },
  strRef: { kind: "reference", numeric: false },
  strLit: { kind: "literal", numeric: false },
  multiLvlStrRef: { kind: "reference", numeric: false },
};

/** The c15 namespace Office 2013 writes chart extensions in. */
const chart2012 = "http://schemas.microsoft.com/office/drawing/2012/chart";

/**
 * Guard: Excel names a row count in `ptCount` that nothing else bounds, and a
 * series cannot plot more points than a sheet has rows, so a larger count is
 * not believed.
 */
const maxDeclaredPoints = 1_048_576;

interface PointDraft {
  readonly index: number;
  readonly value: string;
}

interface DataDraft {
  readonly kind: "reference" | "literal";
  readonly numeric: boolean;
  ref?: string;
  formatCode?: string;
  levels: PointDraft[][];
  declaredCount: number;
}

interface SeriesDraft {
  readonly hidden: boolean;
  name?: ChartTitle;
  trendlines: ChartTrendline[];
  data: Partial<Record<Exclude<Slot, "name">, DataDraft>>;
}

interface PlotDraft {
  readonly type: ChartPlotType;
  direction?: "bar" | "col";
  grouping?: string;
  axes: number[];
  series: SeriesDraft[];
  seriesCount: number;
}

interface AxisDraft {
  readonly kind: "category" | "value" | "date" | "series";
  id?: number;
  position?: string;
  title?: ChartTitle;
  deleted: boolean;
  min?: number;
  max?: number;
  logBase?: number;
  numberFormat?: string;
}

interface TitleDraft {
  paragraphs: string[];
  data?: DataDraft;
}

interface Opened {
  readonly uri: string;
  readonly local: string;
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

function readsChartNamespace(uri: string): boolean {
  const name = transitionalNamespace(uri);
  return (
    name === namespaces.chart ||
    name === namespaces.drawing ||
    name === chart2012
  );
}

/**
 * Guard: a number cache holds what Excel wrote, often 17 significant digits
 * (`68.599999999999994`), so a value is a number whenever it parses as one;
 * comparing it with its shortest spelling turned a third of the corpus's
 * cached values into strings. A text cache stays text, digits or not.
 */
function pointValue(raw: string, numeric: boolean): string | number {
  if (!numeric) return raw;
  return parseNumber(raw.trim()) ?? raw;
}

function finishData(draft: DataDraft, options: ReadChartOptions): SeriesData {
  const levels = draft.levels.length === 0 ? [[]] : draft.levels;
  let last = -1;
  for (const level of levels) {
    for (const point of level) last = Math.max(last, point.index);
  }
  const count = Math.max(
    last + 1,
    Math.min(Math.max(0, draft.declaredCount), maxDeclaredPoints),
  );
  const capped = Math.min(
    count,
    options.maxPoints,
    Math.floor(options.pointBudget.remaining / levels.length),
  );
  options.pointBudget.remaining -= capped * levels.length;
  const pointsOf = (level: readonly PointDraft[]): SeriesPoints => {
    const byIndex = new Map<number, string>();
    for (const point of level) {
      if (point.index < capped) byIndex.set(point.index, point.value);
    }
    return Array.from({ length: capped }, (_, index) => {
      const raw = byIndex.get(index);
      return raw === undefined ? null : pointValue(raw, draft.numeric);
    });
  };
  const [inner = [], ...outer] = levels;
  const common = {
    count,
    points: pointsOf(inner),
    ...(draft.formatCode === undefined || draft.formatCode === "General"
      ? {}
      : { numberFormat: draft.formatCode }),
    truncated: capped < count,
  };
  if (draft.kind === "reference" && draft.ref !== undefined) {
    return {
      kind: "reference",
      ref: draft.ref,
      ...(isExternalRef(draft.ref) ? { external: true as const } : {}),
      ...common,
      ...(outer.length === 0 ? {} : { levels: outer.map(pointsOf) }),
    };
  }
  return { kind: "literal", ...common };
}

function titleOf(draft: TitleDraft): ChartTitle {
  const data = draft.data;
  if (data === undefined) return { text: draft.paragraphs.join("\n") };
  const cached = data.levels[0]?.find((point) => point.index === 0)?.value;
  return data.ref === undefined
    ? { text: cached ?? "" }
    : { text: cached ?? "", ref: data.ref };
}

function finishSeries(
  draft: SeriesDraft,
  options: ReadChartOptions,
): ChartSeries {
  const data = (slot: Exclude<Slot, "name">) => {
    const found = draft.data[slot];
    return found === undefined ? {} : { [slot]: finishData(found, options) };
  };
  return {
    ...(draft.name === undefined ? {} : { name: draft.name }),
    ...(draft.hidden ? { hidden: true as const } : {}),
    ...(draft.trendlines.length === 0 ? {} : { trendlines: draft.trendlines }),
    ...data("categories"),
    ...data("values"),
    ...data("x"),
    ...data("y"),
    ...data("size"),
  };
}

/**
 * Guard: Excel draws a chart's first plot on the primary axes and gives a
 * plot moved to the secondary axes its own pair, so an axis is secondary when
 * the first plot does not use it. An axis's side says nothing: a primary
 * value axis can sit on the right, and a secondary category axis is usually
 * deleted at the bottom.
 */
function secondaryAxes(plots: readonly PlotDraft[]): ReadonlySet<number> {
  const [first, ...rest] = plots;
  if (first === undefined) return new Set();
  const primary = new Set(first.axes);
  return new Set(
    rest.flatMap((plot) => plot.axes.filter((id) => !primary.has(id))),
  );
}

/**
 * Reads one DrawingML chart part (ECMA-376 Part 1, §21.2), or returns
 * undefined when the part is absent. Every element is matched under its
 * parent, so a `c:tx` of a data label is not a series name and a `c:f` of a
 * title is not series data. Cached points are capped by `maxPoints` and the
 * shared response budget; `ptCount` never sizes an allocation.
 */
export function readChartPart(
  opc: OpcPackage,
  part: string,
  options: ReadChartOptions,
): ChartContent | undefined {
  const plots: PlotDraft[] = [];
  const axes: AxisDraft[] = [];
  const stack: Opened[] = [];
  let plot: PlotDraft | undefined;
  let series: SeriesDraft | undefined;
  let seriesDepth = 0;
  let slot: Slot | undefined;
  let axis: AxisDraft | undefined;
  let title: TitleDraft | undefined;
  let titleOwner: "chart" | "axis" | undefined;
  let chartTitle: ChartTitle | undefined;
  let data: DataDraft | undefined;
  let level: PointDraft[] | undefined;
  let pointIndex: number | undefined;
  let pivotSource: string | undefined;
  let legendPosition: string | undefined;
  let text: string | undefined;

  let richDepth = 0;

  const isChart = (opened: Opened | undefined, local: string): boolean =>
    opened?.uri === namespaces.chart && opened.local === local;
  const isPlot = (opened: Opened | undefined): boolean =>
    opened?.uri === namespaces.chart && plotTypes[opened.local] !== undefined;
  const isAxis = (opened: Opened | undefined): boolean =>
    opened?.uri === namespaces.chart && axisKinds[opened.local] !== undefined;

  const openSeries = (hidden: boolean, depth: number): void => {
    if (plot === undefined) return;
    plot.seriesCount += 1;
    series = { hidden, trendlines: [], data: {} };
    seriesDepth = depth;
  };

  const closeSeries = (): void => {
    if (
      series !== undefined &&
      plot !== undefined &&
      plot.series.length < limits.maxSeriesPerChart
    ) {
      plot.series.push(series);
    }
    series = undefined;
    seriesDepth = 0;
    slot = undefined;
  };

  const visitor: XmlVisitor = {
    onOpen(node) {
      const parent = stack.at(-1);
      const grandparent = stack.at(-2);
      const depth = stack.length + 1;
      stack.push({ uri: node.uri, local: node.local });

      if (node.uri === namespaces.drawing) {
        if (richDepth === 0 || title === undefined) return;
        if (node.local === "t") text = "";
        else if (node.local === "p" && isChart(parent, "rich")) {
          title.paragraphs.push("");
        }
        return;
      }
      if (node.uri === chart2012) {
        if (
          node.local === "ser" &&
          parent?.uri === chart2012 &&
          /^filtered\w+Series$/.test(parent.local)
        ) {
          openSeries(true, depth);
        }
        return;
      }
      if (node.uri !== namespaces.chart) return;

      const plotType = plotTypes[node.local];
      if (plotType !== undefined && isChart(parent, "plotArea")) {
        plot = { type: plotType, axes: [], series: [], seriesCount: 0 };
        return;
      }
      const axisKind = axisKinds[node.local];
      if (axisKind !== undefined && isChart(parent, "plotArea")) {
        axis = { kind: axisKind, deleted: false };
        return;
      }

      if (node.local === "ser" && isPlot(parent)) {
        openSeries(false, depth);
        return;
      }

      if (series !== undefined && depth === seriesDepth + 1) {
        const opened = slots[node.local];
        if (opened !== undefined) {
          slot = opened;
          return;
        }
      }

      const source = dataSources[node.local];
      if (source !== undefined) {
        const inSlot =
          series !== undefined &&
          slot !== undefined &&
          depth === seriesDepth + 2;
        const inTitle =
          title !== undefined &&
          node.local === "strRef" &&
          isChart(parent, "tx") &&
          isChart(grandparent, "title");
        if (inSlot || inTitle) {
          data = {
            kind: source.kind,
            numeric: source.numeric,
            levels: [],
            declaredCount: 0,
          };
          if (inTitle && title !== undefined) title.data = data;
        }
        return;
      }

      switch (node.local) {
        case "title":
          if (isChart(parent, "chart")) {
            title = { paragraphs: [] };
            titleOwner = "chart";
          } else if (axis !== undefined && isAxis(parent)) {
            title = { paragraphs: [] };
            titleOwner = "axis";
          }
          return;
        case "rich":
          if (
            title !== undefined &&
            isChart(parent, "tx") &&
            isChart(grandparent, "title")
          ) {
            richDepth = depth;
          }
          return;
        case "f":
          if (
            data !== undefined &&
            dataSources[parent?.local ?? ""] !== undefined
          ) {
            text = "";
          }
          return;
        case "formatCode":
          if (data !== undefined) text = "";
          return;
        case "ptCount":
          if (data !== undefined) {
            data.declaredCount =
              Number.parseInt(node.attr("val") ?? "0", 10) || 0;
          }
          return;
        case "lvl":
          if (data !== undefined) {
            level = [];
            data.levels.push(level);
          }
          return;
        case "pt":
          if (data !== undefined) {
            const index = Number.parseInt(node.attr("idx") ?? "", 10);
            pointIndex =
              Number.isFinite(index) && index >= 0 ? index : undefined;
          }
          return;
        case "v":
          if (
            (data !== undefined && pointIndex !== undefined) ||
            (series !== undefined &&
              slot === "name" &&
              depth === seriesDepth + 2)
          ) {
            text = "";
          }
          return;
        case "barDir": {
          const value = node.attr("val");
          if (
            plot !== undefined &&
            isPlot(parent) &&
            (value === "bar" || value === "col")
          ) {
            plot.direction = value;
          }
          return;
        }
        case "grouping":
          if (plot !== undefined && isPlot(parent)) {
            plot.grouping ??= node.attr("val");
          }
          return;
        case "axId": {
          const id = Number.parseInt(node.attr("val") ?? "", 10);
          if (!Number.isFinite(id)) return;
          if (axis !== undefined && isAxis(parent)) axis.id ??= id;
          else if (plot !== undefined && isPlot(parent)) plot.axes.push(id);
          return;
        }
        case "legendPos":
          if (isChart(parent, "legend")) legendPosition ??= node.attr("val");
          return;
        case "delete":
          if (axis !== undefined && isAxis(parent)) {
            const value = node.attr("val");
            axis.deleted = value === "1" || value === "true";
          }
          return;
        case "axPos":
          if (axis !== undefined && isAxis(parent)) {
            axis.position ??= node.attr("val");
          }
          return;
        case "min":
          if (axis !== undefined && isChart(parent, "scaling")) {
            axis.min ??= parseNumber(node.attr("val"));
          }
          return;
        case "max":
          if (axis !== undefined && isChart(parent, "scaling")) {
            axis.max ??= parseNumber(node.attr("val"));
          }
          return;
        case "logBase":
          if (axis !== undefined && isChart(parent, "scaling")) {
            axis.logBase ??= parseNumber(node.attr("val"));
          }
          return;
        case "numFmt":
          if (axis !== undefined && isAxis(parent)) {
            axis.numberFormat ??= node.attr("formatCode");
          }
          return;
        case "trendlineType": {
          const type = node.attr("val");
          if (
            series !== undefined &&
            isChart(parent, "trendline") &&
            type !== undefined
          ) {
            series.trendlines.push({ type });
          }
          return;
        }
        case "name":
          if (isChart(parent, "pivotSource")) text = "";
          return;
        default:
          return;
      }
    },
    onText(chunk) {
      if (text !== undefined) text += chunk;
    },
    onClose(local, uri) {
      const depth = stack.length;
      stack.pop();
      const parent = stack.at(-1);
      const value = text;

      if (uri === namespaces.drawing) {
        if (local !== "t") return;
        text = undefined;
        if (title !== undefined && richDepth > 0 && value !== undefined) {
          const paragraphs = title.paragraphs;
          if (paragraphs.length === 0) paragraphs.push("");
          paragraphs[paragraphs.length - 1] += value;
        }
        return;
      }
      if (uri === chart2012) {
        if (local === "ser" && depth === seriesDepth) closeSeries();
        return;
      }
      if (uri !== namespaces.chart) return;
      text = undefined;

      switch (local) {
        case "f":
          if (data !== undefined && value !== undefined) data.ref ??= value;
          return;
        case "formatCode":
          if (data !== undefined && value !== undefined)
            data.formatCode ??= value;
          return;
        case "v":
          if (value === undefined) return;
          if (data !== undefined && pointIndex !== undefined) {
            if (level === undefined) {
              level = [];
              data.levels.push(level);
            }
            level.push({ index: pointIndex, value });
          } else if (series !== undefined && slot === "name") {
            series.name ??= { text: value };
          }
          return;
        case "pt":
          pointIndex = undefined;
          return;
        case "lvl":
          level = undefined;
          return;
        case "name":
          if (isChart(parent, "pivotSource") && value !== undefined) {
            pivotSource ??= value;
          }
          return;
        case "rich":
          if (depth === richDepth) richDepth = 0;
          return;
        default:
          break;
      }

      if (dataSources[local] !== undefined && data !== undefined) {
        if (title?.data === data) {
          data = undefined;
          level = undefined;
          return;
        }
        if (series !== undefined && slot !== undefined) {
          if (slot === "name") {
            series.name ??= titleOf({ paragraphs: [], data });
          } else {
            series.data[slot] ??= data;
          }
        }
        data = undefined;
        level = undefined;
        return;
      }
      if (
        series !== undefined &&
        depth === seriesDepth + 1 &&
        slots[local] !== undefined
      ) {
        slot = undefined;
        return;
      }
      if (local === "ser" && depth === seriesDepth) {
        closeSeries();
        return;
      }
      if (local === "title" && title !== undefined) {
        const finished = titleOf(title);
        if (titleOwner === "axis" && axis !== undefined)
          axis.title ??= finished;
        else if (titleOwner === "chart") chartTitle ??= finished;
        title = undefined;
        titleOwner = undefined;
        return;
      }
      if (
        plot !== undefined &&
        isPlot({ uri, local }) &&
        isChart(parent, "plotArea")
      ) {
        plots.push(plot);
        plot = undefined;
        return;
      }
      if (
        axis !== undefined &&
        isAxis({ uri, local }) &&
        isChart(parent, "plotArea")
      ) {
        axes.push(axis);
        axis = undefined;
      }
    },
  };

  const found = scanPart(
    opc,
    part,
    selectAlternateContent(visitor, readsChartNamespace),
  );
  if (!found) return undefined;

  const secondary = secondaryAxes(plots);
  return {
    ...(chartTitle === undefined ? {} : { title: chartTitle }),
    ...(pivotSource === undefined ? {} : { pivotSource }),
    plots: plots.map((draft) => ({
      type: draft.type,
      ...(draft.direction === undefined ? {} : { direction: draft.direction }),
      ...(draft.grouping === undefined ? {} : { grouping: draft.grouping }),
      axes: draft.axes,
      series: draft.series.map((item) => finishSeries(item, options)),
      ...(draft.seriesCount > draft.series.length
        ? { omittedSeries: draft.seriesCount - draft.series.length }
        : {}),
    })),
    axes: axes.flatMap((draft): ChartAxis[] =>
      draft.id === undefined
        ? []
        : [
            {
              id: draft.id,
              kind: draft.kind,
              ...(draft.position === undefined
                ? {}
                : { position: draft.position }),
              ...(secondary.has(draft.id) ? { secondary: true as const } : {}),
              ...(draft.title === undefined ? {} : { title: draft.title }),
              deleted: draft.deleted,
              ...(draft.min === undefined ? {} : { min: draft.min }),
              ...(draft.max === undefined ? {} : { max: draft.max }),
              ...(draft.logBase === undefined
                ? {}
                : { logBase: draft.logBase }),
              ...(draft.numberFormat === undefined
                ? {}
                : { numberFormat: draft.numberFormat }),
            },
          ],
    ),
    ...(legendPosition === undefined
      ? {}
      : { legend: { position: legendPosition } }),
  };
}
