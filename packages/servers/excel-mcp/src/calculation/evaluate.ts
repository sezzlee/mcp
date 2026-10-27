import { fold } from "@sezzlee/file-core";
import {
  CalculationBudget,
  calculationLimits,
  type Expression,
} from "./syntax.js";

export type CalculationScalar =
  | string
  | number
  | boolean
  | null
  | { readonly kind: "error"; readonly code: string };
export interface CalculationIssue {
  readonly kind: "unsupported" | "cycle" | "dependency";
  readonly reason: string;
}
export type CalculationValue =
  | CalculationScalar
  | CalculationIssue
  | {
      readonly kind: "range";
      readonly values: readonly (CalculationScalar | CalculationIssue)[];
      readonly rows: number;
      readonly columns: number;
    };
export type CalculationAtom = CalculationScalar | CalculationIssue;

const error = (code: string): CalculationScalar => ({ kind: "error", code });
const unsupported = (reason: string): CalculationIssue => ({
  kind: "unsupported",
  reason,
});
const special = (
  value: CalculationValue,
): value is Exclude<CalculationAtom, string | number | boolean | null> =>
  typeof value === "object" && value !== null && value.kind !== "range";

function scalar(value: CalculationValue): CalculationAtom {
  return typeof value === "object" && value !== null && value.kind === "range"
    ? value.values.length === 1
      ? (value.values[0] ?? null)
      : unsupported(
          "A range requires a supported aggregate or lookup function.",
        )
    : value;
}

function formattedNumericText(value: string): boolean {
  return /\p{N}/u.test(value) && /^[\s\p{N}+\-.,/%:$€£¥TZ]+$/u.test(value);
}

function numeric(
  value: CalculationAtom,
): number | Exclude<CalculationAtom, string | number | boolean | null> {
  if (special(value)) return value;
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(text)) {
    if (formattedNumericText(text))
      return unsupported(
        "Formatted numeric or date text coercion is unsupported.",
      );
    return { kind: "error", code: "#VALUE!" };
  }
  const result = Number(text);
  return Number.isFinite(result) ? result : { kind: "error", code: "#NUM!" };
}

function truth(
  value: CalculationAtom,
): boolean | Exclude<CalculationAtom, string | number | boolean | null> {
  if (special(value)) return value;
  if (typeof value === "string") {
    if (/^TRUE$/i.test(value)) return true;
    if (/^FALSE$/i.test(value)) return false;
    return { kind: "error", code: "#VALUE!" };
  }
  return value !== null && value !== 0 && value !== false;
}

function finite(value: number): CalculationScalar {
  return Number.isFinite(value)
    ? Object.is(value, -0)
      ? 0
      : value
    : error("#NUM!");
}

function text(value: string | number | boolean | null): string {
  return value === null
    ? ""
    : typeof value === "boolean"
      ? value
        ? "TRUE"
        : "FALSE"
      : String(value);
}

function compare(
  left: string | number | boolean | null,
  right: string | number | boolean | null,
): number {
  const a =
    left === null
      ? typeof right === "string"
        ? ""
        : typeof right === "boolean"
          ? false
          : 0
      : left;
  const b =
    right === null
      ? typeof a === "string"
        ? ""
        : typeof a === "boolean"
          ? false
          : 0
      : right;
  const rank = (v: string | number | boolean) =>
    typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2;
  if (typeof a !== typeof b) return Math.sign(rank(a) - rank(b));
  const first = typeof a === "string" ? fold(a) : a;
  const second = typeof b === "string" ? fold(b) : b;
  return first === second ? 0 : first < second ? -1 : 1;
}

function relation(operator: string, order: number): boolean {
  switch (operator) {
    case "=":
      return order === 0;
    case "<>":
      return order !== 0;
    case "<":
      return order < 0;
    case ">":
      return order > 0;
    case "<=":
      return order <= 0;
    case ">=":
      return order >= 0;
    default:
      return false;
  }
}

function wildcardMatch(
  pattern: string,
  input: string,
  budget: CalculationBudget,
): boolean {
  const tokens: { character: string; wildcard: boolean }[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const character = pattern[i] ?? "";
    if (character === "~" && i + 1 < pattern.length) {
      i += 1;
      tokens.push({ character: pattern[i] ?? "", wildcard: false });
    } else
      tokens.push({
        character,
        wildcard: character === "*" || character === "?",
      });
  }
  let at = 0,
    position = 0,
    star = -1,
    retry = 0;
  while (position < input.length) {
    budget.tick();
    const token = tokens[at];
    if (token?.wildcard && token.character === "*") {
      star = at++;
      retry = position;
    } else if (
      token !== undefined &&
      ((token.wildcard && token.character === "?") ||
        fold(token.character) === fold(input[position] ?? ""))
    ) {
      at += 1;
      position += 1;
    } else if (star >= 0) {
      at = star + 1;
      position = ++retry;
    } else return false;
  }
  while (tokens[at]?.wildcard && tokens[at]?.character === "*") at += 1;
  return at === tokens.length;
}

function criterion(
  input: CalculationAtom,
  budget: CalculationBudget,
):
  | ((value: CalculationAtom) => boolean)
  | Exclude<CalculationAtom, string | number | boolean | null> {
  if (special(input)) return input;
  const raw = input === null ? 0 : input;
  if (typeof raw === "boolean")
    return (value) =>
      !special(value) &&
      (typeof value === "boolean"
        ? value === raw
        : typeof value === "string" &&
          fold(value) === fold(raw ? "TRUE" : "FALSE"));
  const source = String(raw);
  const match = /^(<=|>=|<>|=|<|>)([\s\S]*)$/.exec(source);
  const operator = match?.[1] ?? "=";
  const operand = match?.[2] ?? source;
  const asNumber = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(
    operand,
  )
    ? Number(operand)
    : undefined;
  if (asNumber === undefined && formattedNumericText(operand))
    return unsupported("Formatted numeric or date criteria are unsupported.");
  if (asNumber !== undefined)
    return (value) => {
      if (special(value) || typeof value === "boolean") return false;
      if (operator !== "=" && operator !== "<>")
        return (
          typeof value === "number" &&
          relation(operator, compare(value, asNumber))
        );
      return relation(
        operator,
        compare(
          typeof value === "string" &&
            value.trim() !== "" &&
            Number.isFinite(Number(value))
            ? Number(value)
            : value,
          asNumber,
        ),
      );
    };
  if (operator === "=" || operator === "<>") {
    return (value) => {
      if (special(value))
        return (
          value.kind === "error" && operand === value.code && operator === "="
        );
      const matches =
        (typeof value === "string" ||
          value === null ||
          (typeof value === "boolean" && /^(TRUE|FALSE)$/i.test(operand))) &&
        wildcardMatch(operand, text(value), budget);
      return matches !== (operator === "<>");
    };
  }
  return (value) =>
    !special(value) &&
    typeof value === "string" &&
    relation(operator, compare(value, operand));
}

export function evaluateCalculation(
  expression: Expression,
  resolve: (reference: string) => CalculationValue,
  budget: CalculationBudget,
  baseDepth: number,
): CalculationValue {
  function evaluate(node: Expression, depth: number): CalculationValue {
    budget.tick(baseDepth + depth);
    switch (node.kind) {
      case "literal":
        return node.value;
      case "error":
        return { kind: "error", code: node.code };
      case "reference":
        return resolve(node.text);
      case "unary": {
        const value = numeric(scalar(evaluate(node.operand, depth + 1)));
        return typeof value !== "number"
          ? value
          : finite(
              node.operator === "-"
                ? -value
                : node.operator === "%"
                  ? value / 100
                  : value,
            );
      }
      case "binary": {
        const left = scalar(evaluate(node.left, depth + 1));
        if (special(left)) return left;
        const right = scalar(evaluate(node.right, depth + 1));
        if (special(right)) return right;
        if (["=", "<>", "<", ">", "<=", ">="].includes(node.operator))
          return relation(node.operator, compare(left, right));
        if (node.operator === "&") {
          const joined = text(left) + text(right);
          return joined.length > calculationLimits.maxTextChars
            ? error("#VALUE!")
            : joined;
        }
        const a = numeric(left),
          b = numeric(right);
        if (typeof a !== "number") return a;
        if (typeof b !== "number") return b;
        switch (node.operator) {
          case "+":
            return finite(a + b);
          case "-":
            return finite(a - b);
          case "*":
            return finite(a * b);
          case "/":
            return b === 0 ? error("#DIV/0!") : finite(a / b);
          case "^":
            return a === 0 && b === 0 ? error("#NUM!") : finite(a ** b);
          default:
            return unsupported("Unsupported operator.");
        }
      }
      case "call":
        return call(node.name, node.args, depth + 1);
      default: {
        const exhaustive: never = node;
        return exhaustive;
      }
    }
  }
  function call(
    name: string,
    args: readonly Expression[],
    depth: number,
  ): CalculationValue {
    const argument = (i: number): CalculationValue => {
      const node = args[i];
      return node === undefined ? null : evaluate(node, depth);
    };
    const atom = (i: number) => scalar(argument(i));
    if (name === "IF") {
      if (args.length < 2 || args.length > 3) return error("#VALUE!");
      const condition = truth(atom(0));
      return typeof condition !== "boolean"
        ? condition
        : condition
          ? argument(1)
          : args.length === 3
            ? argument(2)
            : false;
    }
    if (name === "IFERROR") {
      if (args.length !== 2) return error("#VALUE!");
      const value = scalar(argument(0));
      return typeof value === "object" &&
        value !== null &&
        value.kind === "error"
        ? argument(1)
        : value;
    }
    if (
      name === "ABS" ||
      name === "ROUND" ||
      name === "ROUNDUP" ||
      name === "ROUNDDOWN"
    ) {
      if (args.length !== (name === "ABS" ? 1 : 2)) return error("#VALUE!");
      const value = numeric(atom(0));
      if (typeof value !== "number") return value;
      if (name === "ABS") return Math.abs(value);
      const places = numeric(atom(1));
      if (typeof places !== "number") return places;
      const digits = Math.trunc(places);
      if (Math.abs(digits) > 308)
        return unsupported("Rounding precision exceeds the supported range.");
      const scale = 10 ** digits,
        magnitude = Math.abs(value) * scale;
      if (!Number.isFinite(magnitude)) return error("#NUM!");
      const closest = Math.round(magnitude);
      const integral =
        Math.abs(magnitude - closest) <= magnitude * Number.EPSILON * 2
          ? closest
          : magnitude;
      const adjusted =
        name === "ROUND"
          ? Math.floor(magnitude + 0.5 + magnitude * Number.EPSILON)
          : name === "ROUNDUP"
            ? Math.ceil(integral)
            : Math.floor(integral);
      return finite((Math.sign(value) * adjusted) / scale);
    }
    if (name === "NOT") {
      if (args.length !== 1) return error("#VALUE!");
      const value = truth(atom(0));
      return typeof value === "boolean" ? !value : value;
    }
    if (name === "COUNTIF" || name === "SUMIF") {
      if (args.length < 2 || args.length > (name === "SUMIF" ? 3 : 2))
        return error("#VALUE!");
      const range = argument(0);
      if (typeof range !== "object" || range === null || range.kind !== "range")
        return special(range) ? range : error("#VALUE!");
      const test = criterion(atom(1), budget);
      if (typeof test !== "function") return test;
      const sums = name === "SUMIF" && args.length === 3 ? argument(2) : range;
      if (typeof sums !== "object" || sums === null || sums.kind !== "range")
        return special(sums) ? sums : error("#VALUE!");
      if (range.rows !== sums.rows || range.columns !== sums.columns)
        return unsupported(
          "SUMIF requires equally shaped criteria and sum ranges.",
        );
      let result = 0;
      for (const [i, value] of range.values.entries()) {
        budget.tick(baseDepth + depth);
        if (special(value) && value.kind !== "error") return value;
        if (!test(value)) continue;
        if (name === "COUNTIF") result += 1;
        else {
          const sum = sums.values[i] ?? null;
          if (special(sum)) return sum;
          if (typeof sum === "number") result += sum;
        }
      }
      return finite(result);
    }
    if (name === "VLOOKUP" || name === "MATCH" || name === "INDEX") {
      if (name === "INDEX") {
        if (args.length < 2 || args.length > 3) return error("#VALUE!");
        const range = argument(0),
          row = numeric(atom(1));
        if (special(range)) return range;
        if (typeof row !== "number") return row;
        if (
          typeof range !== "object" ||
          range === null ||
          range.kind !== "range"
        )
          return error("#VALUE!");
        const column = args.length === 3 ? numeric(atom(2)) : 1;
        if (typeof column !== "number") return column;
        if (row === 0 || column === 0)
          return unsupported("INDEX array results are unsupported.");
        if (row < 0 || column < 0) return error("#VALUE!");
        if (Math.trunc(row) > range.rows || Math.trunc(column) > range.columns)
          return error("#REF!");
        return (
          range.values[
            (Math.trunc(row) - 1) * range.columns + Math.trunc(column) - 1
          ] ?? error("#REF!")
        );
      }
      if (args.length !== (name === "MATCH" ? 3 : 4))
        return unsupported("Lookup requires an explicit exact-match mode.");
      const lookup = atom(0),
        range = argument(1);
      if (special(lookup)) return lookup;
      if (typeof lookup === "string" && /[*?~]/.test(lookup))
        return unsupported("Lookup wildcard matching is unsupported.");
      if (special(range)) return range;
      if (typeof range !== "object" || range === null || range.kind !== "range")
        return error("#VALUE!");
      const mode = numeric(atom(name === "MATCH" ? 2 : 3));
      if (typeof mode !== "number") return mode;
      if (mode !== 0) return unsupported("Approximate lookup is unsupported.");
      const column = name === "MATCH" ? 1 : numeric(atom(2));
      if (typeof column !== "number") return column;
      if (column < 1) return error("#VALUE!");
      if (column > range.columns) return error("#REF!");
      if (name === "MATCH" && range.rows !== 1 && range.columns !== 1)
        return error("#N/A");
      for (
        let i = 0;
        i < (name === "MATCH" ? range.values.length : range.rows);
        i += 1
      ) {
        budget.tick(baseDepth + depth);
        const value =
          range.values[name === "MATCH" ? i : i * range.columns] ?? null;
        if (special(value)) return value;
        if (typeof value === typeof lookup && compare(value, lookup) === 0)
          return name === "MATCH"
            ? i + 1
            : (range.values[i * range.columns + Math.trunc(column) - 1] ??
                null);
      }
      return error("#N/A");
    }
    if (args.length === 0) return error("#VALUE!");
    if (name === "COUNTBLANK" && args.length !== 1) return error("#VALUE!");
    let total = 0,
      count = 0,
      maximum = -Infinity,
      minimum = Infinity,
      logical: boolean | undefined;
    for (const node of args) {
      const argumentValue = evaluate(node, depth);
      const range =
        typeof argumentValue === "object" &&
        argumentValue !== null &&
        argumentValue.kind === "range";
      if (name === "COUNTBLANK" && !range)
        return special(argumentValue) ? argumentValue : error("#VALUE!");
      const values = range ? argumentValue.values : [scalar(argumentValue)];
      for (const value of values) {
        budget.tick(baseDepth + depth);
        if (name === "COUNTA") {
          if (special(value) && value.kind !== "error") return value;
          if (value !== null) count += 1;
          continue;
        }
        if (name === "COUNTBLANK") {
          if (special(value) && value.kind !== "error") return value;
          if (value === null || value === "") count += 1;
          continue;
        }
        if (name === "COUNT") {
          if (special(value)) {
            if (value.kind !== "error") return value;
            continue;
          }
          if (typeof value === "number") count += 1;
          else if (!range && value !== null) {
            const coerced = numeric(value);
            if (typeof coerced === "number") count += 1;
            else if (coerced.kind !== "error") return coerced;
          }
          continue;
        }
        if (special(value)) return value;
        if (name === "AND" || name === "OR") {
          if (range && (value === null || typeof value === "string")) continue;
          const condition = truth(value);
          if (typeof condition !== "boolean") return condition;
          logical =
            logical === undefined
              ? condition
              : name === "AND"
                ? logical && condition
                : logical || condition;
          continue;
        }
        if (range && typeof value !== "number") continue;
        if (!range && value === null) continue;
        const number = numeric(value);
        if (typeof number !== "number") return number;
        total += number;
        count += 1;
        maximum = Math.max(maximum, number);
        minimum = Math.min(minimum, number);
      }
    }
    switch (name) {
      case "SUM":
        return finite(total);
      case "AVERAGE":
        return count === 0 ? error("#DIV/0!") : finite(total / count);
      case "MIN":
        return count === 0 ? 0 : minimum;
      case "MAX":
        return count === 0 ? 0 : maximum;
      case "COUNT":
      case "COUNTA":
      case "COUNTBLANK":
        return count;
      case "AND":
      case "OR":
        return logical ?? error("#VALUE!");
      default:
        return unsupported(`Unsupported function: ${name}.`);
    }
  }
  return evaluate(expression, 0);
}
