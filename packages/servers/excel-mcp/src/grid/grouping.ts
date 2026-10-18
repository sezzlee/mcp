import { SezzleeExcelError } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import { isCellDuration, type CellScalar } from "./cell-value.js";
import { resolveColumn, type ColumnIndex, type ColumnMode } from "./columns.js";
import { readDateText } from "./date-text.js";
import { classify, type ReadingNeed, type TypedCell } from "./predicate.js";
import { columnToLetters } from "./range.js";

export const dateParts = [
  "year",
  "quarter",
  "month",
  "week",
  "day",
  "weekday",
  "hour",
] as const;

export type DatePart = (typeof dateParts)[number];

export type GroupRequest =
  | string
  | { readonly column: string; readonly by: DatePart }
  | { readonly column: string; readonly bins: readonly number[] }
  | {
      readonly column: string;
      readonly width: number;
      readonly origin?: number;
    };

interface GroupLabel {
  readonly label: string;
  readonly letter: string;
  readonly role: "group";
}

export type GroupDescription = GroupLabel &
  (
    | { readonly by?: never }
    | { readonly by: DatePart }
    | { readonly bins: readonly number[]; readonly interval: "[lower, upper)" }
    | {
        readonly width: number;
        readonly origin: number;
        readonly interval: "[lower, upper)";
      }
  );

interface Decimal {
  readonly coefficient: bigint;
  readonly exponent: number;
}

export type GroupPlan = {
  readonly column: number;
  readonly reference: string;
  readonly description: GroupDescription;
} & (
  | { readonly kind: "value" }
  | { readonly kind: "date"; readonly by: DatePart }
  | { readonly kind: "bins"; readonly bounds: readonly number[] }
  | {
      readonly kind: "width";
      readonly width: Decimal;
      readonly origin: Decimal;
    }
);

export type GroupValue =
  | {
      readonly kind: "value";
      readonly value: CellScalar;
      readonly order: CellScalar;
    }
  | { readonly kind: "unreadable" };

function decimalOf(value: number): Decimal {
  const [mantissa = "0", exponent = "0"] = String(value).split("e");
  const point = mantissa.indexOf(".");
  return {
    coefficient: BigInt(mantissa.replace(".", "")),
    exponent: Number(exponent) - (point < 0 ? 0 : mantissa.length - point - 1),
  };
}

function scaled(decimal: Decimal, exponent: number): bigint {
  return decimal.coefficient * 10n ** BigInt(decimal.exponent - exponent);
}

function decimalText(coefficient: bigint, exponent: number): string {
  const sign = coefficient < 0n ? "-" : "";
  const digits = String(coefficient < 0n ? -coefficient : coefficient);
  if (exponent >= 0) return `${sign}${digits}${"0".repeat(exponent)}`;
  const padded = digits.padStart(1 - exponent, "0");
  const point = padded.length + exponent;
  const fraction = padded.slice(point).replace(/0+$/, "");
  return `${sign}${padded.slice(0, point)}${fraction === "" ? "" : `.${fraction}`}`;
}

function invalid(message: string): never {
  throw new SezzleeExcelError("invalid_argument", message);
}

export function compileGroup(
  index: ColumnIndex,
  request: GroupRequest,
  mode: ColumnMode,
): GroupPlan {
  const reference = typeof request === "string" ? request : request.column;
  const column = resolveColumn(index, reference, mode);
  const label =
    index.headers[column - index.bounds.left] ?? columnToLetters(column);
  const base = { column, reference };
  const description: GroupLabel = {
    label,
    letter: columnToLetters(column),
    role: "group",
  };
  if (typeof request === "string")
    return { ...base, description, kind: "value" };
  if ("by" in request) {
    if (!dateParts.includes(request.by))
      invalid("groupBy by must name a supported date part.");
    return {
      ...base,
      kind: "date",
      by: request.by,
      description: {
        ...description,
        label: `${label} (${request.by})`,
        by: request.by,
      },
    };
  }
  if ("bins" in request) {
    if (
      request.bins.length === 0 ||
      request.bins.length > limits.maxGroupBins ||
      request.bins.some(
        (bound, at) =>
          !Number.isFinite(bound) ||
          (at > 0 && bound <= (request.bins[at - 1] ?? bound)),
      )
    )
      invalid(
        "groupBy bins must be a non-empty, strictly increasing list of finite boundaries.",
      );
    return {
      ...base,
      kind: "bins",
      bounds: request.bins,
      description: {
        ...description,
        bins: request.bins,
        interval: "[lower, upper)",
      },
    };
  }
  const origin = request.origin ?? 0;
  if (
    !Number.isFinite(request.width) ||
    request.width <= 0 ||
    !Number.isFinite(origin)
  )
    invalid(
      "groupBy width must be positive and finite, and origin must be finite.",
    );
  return {
    ...base,
    kind: "width",
    width: decimalOf(request.width),
    origin: decimalOf(origin),
    description: {
      ...description,
      width: request.width,
      origin,
      interval: "[lower, upper)",
    },
  };
}

export function groupNeeds(plan: GroupPlan): readonly ReadingNeed[] {
  if (plan.kind === "date")
    return plan.by === "hour" ? ["date", "time"] : ["date"];
  return plan.kind === "value" ? [] : ["number", "duration"];
}

function valueOf(value: CellScalar, order: CellScalar = value): GroupValue {
  return { kind: "value", value, order };
}

function datePart(iso: string, by: DatePart): CellScalar {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00.000Z` : iso);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const weekday = date.getUTCDay() || 7;
  switch (by) {
    case "year":
      return year;
    case "quarter":
      return `${year}-Q${Math.ceil(month / 3)}`;
    case "month":
      return iso.slice(0, 7);
    case "day":
      return iso.slice(0, 10);
    case "weekday":
      return weekday;
    case "hour":
      return date.getUTCHours();
    case "week": {
      date.setUTCHours(0, 0, 0, 0);
      date.setUTCDate(date.getUTCDate() + 4 - weekday);
      const isoYear = date.getUTCFullYear();
      const jan1 = Date.UTC(isoYear, 0, 1);
      const week = Math.floor((date.getTime() - jan1) / 604_800_000) + 1;
      return `${isoYear}-W${String(week).padStart(2, "0")}`;
    }
    default: {
      const exhaustive: never = by;
      return exhaustive;
    }
  }
}

/**
 * Guard: decimal widths use the finite numbers' canonical decimal values.
 * Binary division puts 0.3 / 0.1 below 3; epsilon rounding moves the distinct
 * preceding number across a half-open boundary. Integer scaling avoids both.
 */
function widthValue(
  plan: Extract<GroupPlan, { kind: "width" }>,
  value: number,
): GroupValue {
  const decimal = decimalOf(value);
  const exponent = Math.min(
    decimal.exponent,
    plan.width.exponent,
    plan.origin.exponent,
  );
  const width = scaled(plan.width, exponent);
  const origin = scaled(plan.origin, exponent);
  const offset = scaled(decimal, exponent) - origin;
  const bucket =
    offset / width - (offset < 0n && offset % width !== 0n ? 1n : 0n);
  const low = decimalText(origin + bucket * width, exponent);
  const high = decimalText(origin + (bucket + 1n) * width, exponent);
  const lower = Number(low);
  const upper = Number(high);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper)
    throw new SezzleeExcelError(
      "numeric_overflow",
      "A numeric grouping interval cannot be represented with finite distinct boundaries.",
      "Use a larger width, smaller values, or explicit bins.",
    );
  return valueOf(`[${low}, ${high})`, lower);
}

export function groupValue(plan: GroupPlan, cell: TypedCell): GroupValue {
  if (plan.kind === "value") {
    const value = cell.value();
    return valueOf(
      value,
      isCellDuration(value) ? value.durationSeconds : value,
    );
  }
  if (cell.missing) return valueOf(null);
  if (plan.kind === "date") {
    if (plan.by === "hour") {
      const time = cell.as("time");
      if (typeof time === "string" && classify(time) === "time")
        return valueOf(Number(time.slice(0, 2)));
    }
    const read = cell.as("date");
    if (typeof read !== "string") return { kind: "unreadable" };
    if (classify(read) !== "date") return { kind: "unreadable" };
    const date = readDateText(read, "dmy");
    return date.kind === "date"
      ? valueOf(datePart(date.iso, plan.by))
      : { kind: "unreadable" };
  }
  const number = cell.number();
  if (number.kind !== "number") return { kind: "unreadable" };
  if (plan.kind === "width") return widthValue(plan, number.value);
  let at = 0;
  while (
    at < plan.bounds.length &&
    number.value >= (plan.bounds[at] ?? Number.POSITIVE_INFINITY)
  )
    at += 1;
  const low = plan.bounds[at - 1];
  const high = plan.bounds[at];
  return valueOf(
    low === undefined
      ? `(-inf, ${high})`
      : `[${low}, ${high === undefined ? "+inf" : high})`,
    at,
  );
}
