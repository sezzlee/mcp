import { asciiUpper } from "@sezzlee/file-core";
import { SezzleeExcelError } from "../platform/errors.js";

export const calculationLimits = {
  maxCells: 100_000,
  maxFormulas: 10_000,
  maxFormulaChars: 8_192,
  maxDepth: 128,
  maxSteps: 1_000_000,
  maxRangeCells: 100_000,
  maxReportedCells: 20,
  maxTextChars: 32_767,
} as const;

export const calculationFunctions = [
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
  "COUNTA",
  "COUNTBLANK",
  "IF",
  "IFERROR",
  "AND",
  "OR",
  "NOT",
  "SUMIF",
  "COUNTIF",
  "ABS",
  "ROUND",
  "ROUNDUP",
  "ROUNDDOWN",
  "VLOOKUP",
  "MATCH",
  "INDEX",
] as const;

export class UnsupportedCalculation extends Error {}

export class CalculationBudget {
  private steps = 0;

  tick(depth = 0, count = 1): void {
    this.steps += count;
    if (
      depth > calculationLimits.maxDepth ||
      this.steps > calculationLimits.maxSteps
    )
      throw new SezzleeExcelError(
        "resource_limit",
        "The calculation depth or work budget was exceeded.",
      );
  }
}

export type Expression =
  | {
      readonly kind: "literal";
      readonly value: string | number | boolean | null;
    }
  | { readonly kind: "error"; readonly code: string }
  | { readonly kind: "reference"; readonly text: string }
  | {
      readonly kind: "unary";
      readonly operator: string;
      readonly operand: Expression;
    }
  | {
      readonly kind: "binary";
      readonly operator: string;
      readonly left: Expression;
      readonly right: Expression;
    }
  | {
      readonly kind: "call";
      readonly name: string;
      readonly args: readonly Expression[];
    };

interface Token {
  readonly kind: "number" | "text" | "name" | "error" | "symbol" | "end";
  readonly text: string;
}

const referenceToken =
  /^(?:(?:'(?:[^']|'')+'|[\p{L}_\\][\p{L}\p{N}_.\\]*)!)?(?:\$?[A-Za-z]{1,3}\$?[1-9]\d*|[\p{L}_\\][\p{L}\p{N}_.\\]*)(?::\$?[A-Za-z]{1,3}\$?[1-9]\d*)?/u;

function tokens(formula: string): Token[] {
  if (formula.length > calculationLimits.maxFormulaChars)
    throw new SezzleeExcelError(
      "resource_limit",
      "A formula exceeds the calculation text budget.",
    );
  const result: Token[] = [];
  let at = formula.startsWith("=") ? 1 : 0;
  while (at < formula.length) {
    const rest = formula.slice(at);
    const white = /^\s+/.exec(rest)?.[0];
    if (white !== undefined) {
      at += white.length;
      continue;
    }
    const text = /^"(?:[^"]|"")*"/.exec(rest)?.[0];
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/.exec(rest)?.[0];
    const error = /^#(?:DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|NULL!)/i.exec(
      rest,
    )?.[0];
    const name = referenceToken.exec(rest)?.[0];
    const symbol = /^(?:<=|>=|<>|[+\-*/^&=<>%(),])/.exec(rest)?.[0];
    const token: Token | undefined =
      text !== undefined
        ? { kind: "text", text }
        : number !== undefined
          ? { kind: "number", text: number }
          : error !== undefined
            ? { kind: "error", text: asciiUpper(error) }
            : name !== undefined
              ? { kind: "name", text: name }
              : symbol !== undefined
                ? { kind: "symbol", text: symbol }
                : undefined;
    if (token === undefined)
      throw new UnsupportedCalculation("Unsupported formula syntax.");
    result.push(token);
    at += token.text.length;
  }
  result.push({ kind: "end", text: "" });
  return result;
}

function precedence(operator: string): number {
  switch (operator) {
    case "=":
    case "<>":
    case "<":
    case ">":
    case "<=":
    case ">=":
      return 1;
    case "&":
      return 2;
    case "+":
    case "-":
      return 3;
    case "*":
    case "/":
      return 4;
    case "^":
      return 5;
    default:
      return 0;
  }
}

export function parseCalculation(
  formula: string,
  budget: CalculationBudget,
): Expression {
  const stream = tokens(formula);
  let index = 0;
  function peek(): Token {
    return stream[index] ?? { kind: "end", text: "" };
  }
  function take(): Token {
    const token = peek();
    index += 1;
    return token;
  }
  function require(text: string): void {
    if (take().text !== text)
      throw new UnsupportedCalculation("Malformed formula syntax.");
  }
  function expression(minimum: number, depth: number): Expression {
    budget.tick(depth);
    const token = take();
    let left: Expression;
    if (token.kind === "number") {
      const value = Number(token.text);
      left = Number.isFinite(value)
        ? { kind: "literal", value }
        : { kind: "error", code: "#NUM!" };
    } else if (token.kind === "text")
      left = {
        kind: "literal",
        value: token.text.slice(1, -1).replace(/""/g, '"'),
      };
    else if (token.kind === "error") left = { kind: "error", code: token.text };
    else if (token.text === "+" || token.text === "-")
      left = {
        kind: "unary",
        operator: token.text,
        operand: expression(6, depth + 1),
      };
    else if (token.text === "(") {
      left = expression(1, depth + 1);
      require(")");
    } else if (token.kind === "name") {
      if (peek().text === "(") {
        const name = asciiUpper(token.text);
        if (!calculationFunctions.some((supported) => supported === name))
          throw new UnsupportedCalculation(
            `Unsupported function: ${name.slice(0, 128)}.`,
          );
        take();
        const args: Expression[] = [];
        if (peek().text !== ")") {
          while (true) {
            args.push(
              peek().text === "," || peek().text === ")"
                ? { kind: "literal", value: null }
                : expression(1, depth + 1),
            );
            if (peek().text !== ",") break;
            take();
          }
        }
        require(")");
        left = { kind: "call", name, args };
      } else if (/^(TRUE|FALSE)$/i.test(token.text))
        left = { kind: "literal", value: /^TRUE$/i.test(token.text) };
      else left = { kind: "reference", text: token.text };
    } else throw new UnsupportedCalculation("Malformed formula syntax.");
    while (peek().text === "%") {
      take();
      left = { kind: "unary", operator: "%", operand: left };
    }
    while (true) {
      const operator = peek().text;
      const priority = precedence(operator);
      if (priority < minimum) break;
      take();
      const right = expression(priority + 1, depth + 1);
      left = { kind: "binary", operator, left, right };
    }
    return left;
  }
  const parsed = expression(1, 0);
  if (peek().kind !== "end")
    throw new UnsupportedCalculation("Unsupported trailing formula syntax.");
  return parsed;
}
