import { z } from "zod";

const scalar = z.union([z.string(), z.number()]);
const index = z.int().nonnegative();
const pointer = z.string().regex(/^(\/[^/]*)*$/);

const cellOf = z.union([
  index,
  z.strictObject({
    op: z.enum(["divide", "subtract"]),
    columns: z.tuple([index, index]),
  }),
]);
type CellOf = z.infer<typeof cellOf>;

const rowFilter = z.union([
  z.strictObject({ key: index, equals: scalar }),
  z.strictObject({ key: index, number: z.literal(true) }),
  z.strictObject({ key: index, nonEmpty: z.literal(true) }),
]);
type RowFilter = z.infer<typeof rowFilter>;

const itemFilter = z.strictObject({ field: z.string(), equals: scalar });
type ItemFilter = z.infer<typeof itemFilter>;

export const reducers = [
  "sum",
  "avg",
  "subtract",
  "divide",
  "multiply",
  "percent",
  "max",
  "min",
  "count",
  "countDistinct",
  "countNotIn",
  "distinct",
  "single",
  "lexMin",
  "lexMax",
  "argmax",
  "rangeRows",
  "dayFirst",
] as const;
type Reducer = (typeof reducers)[number];

interface TableRef {
  readonly step: number;
  readonly rows: string;
}

export type Expr =
  | { readonly at: readonly [number, string] }
  | {
      readonly row: TableRef & {
        readonly key: number;
        readonly equals: string | number;
        readonly value: number;
      };
    }
  | {
      readonly column: TableRef & {
        readonly value: number;
        readonly where?: RowFilter;
      };
    }
  | {
      readonly pairs: TableRef & {
        readonly label: number;
        readonly value: CellOf;
        readonly where?: RowFilter;
      };
    }
  | {
      readonly countBy: TableRef & {
        readonly label: number;
        readonly where?: RowFilter;
      };
    }
  | {
      readonly pluck: {
        readonly step: number;
        readonly items: string;
        readonly field: string;
        readonly where?: ItemFilter;
      };
    }
  | { readonly zip: readonly [Expr, Expr] }
  | { readonly fn: Reducer; readonly args: readonly Expr[] }
  | {
      readonly fn: "round";
      readonly args: readonly Expr[];
      readonly places: number;
    }
  | { readonly fn: "topK"; readonly args: readonly Expr[]; readonly k: number }
  | {
      readonly fn: "capture";
      readonly args: readonly Expr[];
      readonly pattern: string;
    }
  | { readonly const: unknown }
  | { readonly list: readonly Expr[] }
  | { readonly pair: readonly [Expr, Expr] }
  | { readonly record: Readonly<Record<string, Expr>> }
  | { readonly error: number };

const tableRef = { step: index, rows: pointer };

export const exprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.strictObject({ at: z.tuple([index, pointer]) }),
    z.strictObject({
      row: z.strictObject({
        ...tableRef,
        key: index,
        equals: scalar,
        value: index,
      }),
    }),
    z.strictObject({
      column: z.strictObject({
        ...tableRef,
        value: index,
        where: rowFilter.optional(),
      }),
    }),
    z.strictObject({
      pairs: z.strictObject({
        ...tableRef,
        label: index,
        value: cellOf,
        where: rowFilter.optional(),
      }),
    }),
    z.strictObject({
      countBy: z.strictObject({
        ...tableRef,
        label: index,
        where: rowFilter.optional(),
      }),
    }),
    z.strictObject({
      pluck: z.strictObject({
        step: index,
        items: pointer,
        field: z.string().min(1),
        where: itemFilter.optional(),
      }),
    }),
    z.strictObject({ zip: z.tuple([exprSchema, exprSchema]) }),
    z.strictObject({ fn: z.enum(reducers), args: z.array(exprSchema) }),
    z.strictObject({
      fn: z.literal("round"),
      args: z.array(exprSchema).length(1),
      places: index,
    }),
    z.strictObject({
      fn: z.literal("topK"),
      args: z.array(exprSchema).length(1),
      k: z.int().positive(),
    }),
    z.strictObject({
      fn: z.literal("capture"),
      args: z.array(exprSchema).length(1),
      pattern: z.string().min(1),
    }),
    z.strictObject({ const: z.unknown() }),
    z.strictObject({ list: z.array(exprSchema) }),
    z.strictObject({ pair: z.tuple([exprSchema, exprSchema]) }),
    z.strictObject({ record: z.record(z.string(), exprSchema) }),
    z.strictObject({ error: index }),
  ]),
);

/** What one planned call returned, as the derivation reads it. */
export type StepResponse =
  | { readonly kind: "ok"; readonly body: unknown }
  | { readonly kind: "error"; readonly code: string };

export type Derived =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "incomplete"; readonly detail: string };

class Incomplete extends Error {}

function fail(detail: string): never {
  throw new Incomplete(detail);
}

function resolvePointer(body: unknown, path: string): unknown {
  let current: unknown = body;
  for (const raw of path.split("/").slice(1)) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const at = Number(part);
      if (!Number.isInteger(at) || at < 0 || at >= current.length)
        fail(`no ${path}`);
      current = current[at];
    } else if (typeof current === "object" && current !== null)
      current = Object.entries(current).find(([key]) => key === part)?.[1];
    else fail(`no ${path}`);
    if (current === undefined) fail(`no ${path}`);
  }
  return current;
}

function fold(value: unknown): string {
  return String(value).normalize("NFC").trim().toLocaleLowerCase("tr");
}

function isNumeric(value: unknown): boolean {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()))
  );
}

function numberOf(value: unknown): number {
  if (!isNumeric(value)) fail(`${JSON.stringify(value)} is not a number`);
  return Number(typeof value === "string" ? value.trim() : value);
}

function bodyOf(responses: readonly StepResponse[], step: number): unknown {
  const response = responses[step];
  if (response === undefined) return fail(`no step ${step}`);
  if (response.kind === "error")
    return fail(`step ${step} failed with ${response.code}`);
  return response.body;
}

/**
 * Guard: a table read from a truncated response is not the table. Every
 * row-wise selection refuses a response that says it was cut short, so a
 * plan cannot pass on a first page that happens to hold the value. A single
 * cell taken with `at` is unaffected, which is what an ordered aggregate
 * with `maxGroups` relies on.
 */
function rowsOf(
  responses: readonly StepResponse[],
  table: TableRef,
): readonly (readonly unknown[])[] {
  const body = bodyOf(responses, table.step);
  if (
    typeof body === "object" &&
    body !== null &&
    "truncated" in body &&
    body.truncated === true
  )
    fail(`step ${table.step} is truncated`);
  const rows = resolvePointer(body, table.rows);
  if (!Array.isArray(rows) || !rows.every((row) => Array.isArray(row)))
    return fail(`${table.rows} of step ${table.step} is not a table`);
  return rows;
}

function kept(
  rows: readonly (readonly unknown[])[],
  where: RowFilter | undefined,
): readonly (readonly unknown[])[] {
  if (where === undefined) return rows;
  return rows.filter((row) => {
    const cell = row[where.key];
    if ("number" in where) return isNumeric(cell);
    if ("nonEmpty" in where)
      return cell !== null && cell !== undefined && String(cell).trim() !== "";
    return fold(cell) === fold(where.equals);
  });
}

function cellValue(row: readonly unknown[], cell: CellOf): unknown {
  if (typeof cell === "number") return row[cell];
  const left = numberOf(row[cell.columns[0]]);
  const right = numberOf(row[cell.columns[1]]);
  if (cell.op === "subtract") return left - right;
  return right === 0 ? fail("division by zero") : left / right;
}

function pairsOf(value: unknown): readonly (readonly [unknown, number])[] {
  if (!Array.isArray(value)) return fail("expected pairs");
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2)
      return fail("expected a pair");
    return [entry[0], numberOf(entry[1])] as const;
  });
}

function fieldOf(item: unknown, field: string): unknown {
  if (typeof item !== "object" || item === null) return undefined;
  return Object.entries(item).find(([key]) => key === field)?.[1];
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : fail("expected a list");
}

/** Blank cells are skipped by sums and averages, as a spreadsheet skips them. */
function present(values: readonly unknown[]): readonly unknown[] {
  return values.filter((value) => value !== null && value !== "");
}

function reduce(
  fn: Reducer,
  values: readonly unknown[],
  flat: readonly unknown[],
): unknown {
  switch (fn) {
    case "sum":
      return present(flat).reduce(
        (total: number, value) => total + numberOf(value),
        0,
      );
    case "avg": {
      const counted = present(flat);
      return counted.length === 0
        ? fail("average of nothing")
        : counted.reduce((total: number, value) => total + numberOf(value), 0) /
            counted.length;
    }
    case "subtract":
      return numberOf(flat[0]) - numberOf(flat[1]);
    case "multiply":
      return flat.reduce((total: number, value) => total * numberOf(value), 1);
    case "divide": {
      const denominator = numberOf(flat[1]);
      return denominator === 0
        ? fail("division by zero")
        : numberOf(flat[0]) / denominator;
    }
    case "percent": {
      const denominator = numberOf(flat[1]);
      return denominator === 0
        ? fail("division by zero")
        : (100 * numberOf(flat[0])) / denominator;
    }
    case "max":
      return Math.max(...flat.map(numberOf));
    case "min":
      return Math.min(...flat.map(numberOf));
    case "count":
      return flat.length;
    case "countDistinct":
      return new Set(flat.map(fold)).size;
    case "countNotIn": {
      const others = new Set(listOf(values[1]).map(fold));
      return new Set(
        listOf(values[0])
          .map(fold)
          .filter((item) => !others.has(item)),
      ).size;
    }
    case "distinct": {
      const seen = new Map<string, unknown>();
      for (const value of flat)
        if (!seen.has(fold(value))) seen.set(fold(value), value);
      return [...seen.values()];
    }
    case "single": {
      const distinct = [...new Set(flat.map(fold))];
      return distinct.length === 1
        ? flat[0]
        : fail(`${distinct.length} distinct values where one was expected`);
    }
    case "lexMin":
    case "lexMax": {
      const sorted = flat.map(String).sort();
      return fn === "lexMin" ? sorted[0] : sorted.at(-1);
    }
    case "argmax": {
      const pairs = pairsOf(values[0]);
      const best = Math.max(...pairs.map(([, value]) => value));
      const winners = pairs.filter(([, value]) => value === best);
      return winners.length === 1
        ? winners[0]?.[0]
        : fail(`${winners.length} labels share the largest value`);
    }
    case "rangeRows": {
      const match = /^[A-Z]+(\d+):[A-Z]+(\d+)$/.exec(String(flat[0]));
      return match === null
        ? fail(`${JSON.stringify(flat[0])} is not a range`)
        : Number(match[2]) - Number(match[1]) + 1;
    }
    case "dayFirst": {
      const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(
        String(flat[0]).trim(),
      );
      if (match === null)
        return fail(`${JSON.stringify(flat[0])} is not d/M/yyyy`);
      return `${match[3]}-${match[2]?.padStart(2, "0")}-${match[1]?.padStart(2, "0")}`;
    }
    default: {
      const exhaustive: never = fn;
      return exhaustive;
    }
  }
}

function evaluate(expr: Expr, responses: readonly StepResponse[]): unknown {
  if ("at" in expr)
    return resolvePointer(bodyOf(responses, expr.at[0]), expr.at[1]);
  if ("row" in expr) {
    const { key, equals, value } = expr.row;
    const matches = rowsOf(responses, expr.row).filter(
      (row) => fold(row[key]) === fold(equals),
    );
    if (matches.length !== 1)
      fail(
        `${matches.length} rows of step ${expr.row.step} have ${String(equals)} in column ${key}`,
      );
    return matches[0]?.[value];
  }
  if ("column" in expr)
    return kept(rowsOf(responses, expr.column), expr.column.where).map(
      (row) => row[expr.column.value],
    );
  if ("pairs" in expr)
    return kept(rowsOf(responses, expr.pairs), expr.pairs.where).map((row) => [
      row[expr.pairs.label],
      cellValue(row, expr.pairs.value),
    ]);
  if ("countBy" in expr) {
    const counts = new Map<string, readonly [unknown, number]>();
    for (const row of kept(
      rowsOf(responses, expr.countBy),
      expr.countBy.where,
    )) {
      const label = row[expr.countBy.label];
      const seen = counts.get(fold(label));
      counts.set(fold(label), [seen?.[0] ?? label, (seen?.[1] ?? 0) + 1]);
    }
    return [...counts.values()];
  }
  if ("pluck" in expr) {
    const { step, items, field, where } = expr.pluck;
    return listOf(resolvePointer(bodyOf(responses, step), items))
      .filter(
        (item) =>
          where === undefined ||
          fold(fieldOf(item, where.field)) === fold(where.equals),
      )
      .map((item) => fieldOf(item, field));
  }
  if ("zip" in expr) {
    const left = listOf(evaluate(expr.zip[0], responses));
    const right = listOf(evaluate(expr.zip[1], responses));
    if (left.length !== right.length)
      fail(`zip of ${left.length} and ${right.length} items`);
    return left.map((item, at) => [item, right[at]]);
  }
  if ("const" in expr) return expr.const;
  if ("list" in expr) return expr.list.map((item) => evaluate(item, responses));
  if ("pair" in expr)
    return [
      evaluate(expr.pair[0], responses),
      evaluate(expr.pair[1], responses),
    ];
  if ("record" in expr)
    return Object.fromEntries(
      Object.entries(expr.record).map(([key, item]) => [
        key,
        evaluate(item, responses),
      ]),
    );
  if ("error" in expr) {
    const response = responses[expr.error];
    return response?.kind === "error"
      ? response.code
      : fail(`step ${expr.error} did not fail`);
  }
  const values = expr.args.map((arg) => evaluate(arg, responses));
  const flat = values.flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
  switch (expr.fn) {
    case "round": {
      const scale = 10 ** expr.places;
      return Math.round(numberOf(flat[0]) * scale) / scale;
    }
    case "topK": {
      const pairs = [...pairsOf(values[0])].sort(
        (left, right) => right[1] - left[1],
      );
      const cutoff = pairs[expr.k - 1]?.[1];
      if (cutoff === undefined) return fail(`fewer than ${expr.k} labels`);
      if (pairs[expr.k]?.[1] === cutoff)
        return fail(`a tie at position ${expr.k}`);
      return pairs.slice(0, expr.k).map(([label]) => label);
    }
    case "capture": {
      const match = new RegExp(expr.pattern, "u").exec(String(flat[0]));
      return match?.[1] ?? fail(`${expr.pattern} found nothing`);
    }
    default:
      return reduce(expr.fn, values, flat);
  }
}

/** Evaluates a derivation over the planned calls' responses, or says which evidence was missing. */
export function derive(
  expr: Expr,
  responses: readonly StepResponse[],
): Derived {
  try {
    return { kind: "value", value: evaluate(expr, responses) };
  } catch (error) {
    if (error instanceof Incomplete)
      return { kind: "incomplete", detail: error.message };
    throw error;
  }
}
