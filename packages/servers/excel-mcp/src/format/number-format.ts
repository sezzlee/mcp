import type { CellNumericMeaning } from "../grid/cell-value.js";
import { currencyCodeOf } from "../grid/number-text.js";

type Operator = "<" | "<=" | ">" | ">=" | "=" | "<>";

interface FormatCondition {
  readonly operator: Operator;
  readonly value: number;
}

interface Section {
  readonly code: string;
  readonly condition: FormatCondition | undefined;
  readonly text: boolean;
}

export interface NumericFormat {
  readonly code: string;
  readonly elapsed: boolean;
  readonly meaning?: CellNumericMeaning;
}

const conditionPattern =
  /^(<=|>=|<>|<|>|=)([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?)$/;
const elapsedPattern = /^(?:h+|m+|s+)$/i;

function conditionOf(code: string): FormatCondition | undefined {
  const match = conditionPattern.exec(code);
  if (match === null) return undefined;
  const value = Number(match[2]);
  if (!Number.isFinite(value)) return undefined;
  const operator = match[1];
  if (
    operator !== "<" &&
    operator !== "<=" &&
    operator !== ">" &&
    operator !== ">=" &&
    operator !== "=" &&
    operator !== "<>"
  )
    return undefined;
  return { operator, value };
}

function sectionsOf(code: string): readonly Section[] | undefined {
  if (code.length >= 255) return undefined;
  const sections: Section[] = [];
  let start = 0;
  let at = 0;
  let condition: FormatCondition | undefined;
  let text = false;
  while (at < code.length) {
    const character = code.charAt(at);
    if (character === '"') {
      const end = code.indexOf('"', at + 1);
      if (end === -1) return undefined;
      at = end + 1;
    } else if (character === "\\" || character === "_" || character === "*") {
      if (at + 1 === code.length) return undefined;
      at += 2;
    } else if (character === "[") {
      const end = code.indexOf("]", at + 1);
      if (end === -1) return undefined;
      const bracket = code.slice(at + 1, end);
      if (/^[<>=]/.test(bracket)) {
        if (condition !== undefined || sections.length > 1) return undefined;
        condition = conditionOf(bracket);
        if (condition === undefined) return undefined;
      }
      at = end + 1;
    } else if (character === ";") {
      sections.push({ code: code.slice(start, at), condition, text });
      if (sections.length === 4) return undefined;
      start = at + 1;
      condition = undefined;
      text = false;
      at += 1;
    } else {
      if (character === "@") text = true;
      if (character === "]") return undefined;
      at += 1;
    }
  }
  sections.push({ code: code.slice(start), condition, text });
  if (sections.at(-1)?.text) sections.pop();
  if (sections.some((section) => section.text)) return undefined;
  return sections;
}

function matches(condition: FormatCondition, value: number): boolean {
  switch (condition.operator) {
    case "<":
      return value < condition.value;
    case "<=":
      return value <= condition.value;
    case ">":
      return value > condition.value;
    case ">=":
      return value >= condition.value;
    case "=":
      return value === condition.value;
    case "<>":
      return value !== condition.value;
    default: {
      const exhaustive: never = condition.operator;
      return exhaustive;
    }
  }
}

function activeSection(code: string, value: number): string | undefined {
  const sections = sectionsOf(code);
  if (sections === undefined) return undefined;
  if (!sections.some((section) => section.condition !== undefined)) {
    const at =
      sections.length < 2
        ? 0
        : value < 0
          ? 1
          : value === 0 && sections.length > 2
            ? 2
            : 0;
    return sections[at]?.code;
  }
  for (const section of sections.slice(0, 2))
    if (section.condition !== undefined && matches(section.condition, value))
      return section.code;
  return sections.find((section) => section.condition === undefined)?.code;
}

/**
 * Selects one bounded numeric section before interpreting its elapsed, percent
 * and currency tokens. Stored values are never scaled by display precision.
 */
export function numericFormat(
  code: string,
  value: number,
): NumericFormat | undefined {
  if (code === "General" || code === "0" || code === "0.00" || code === "")
    return undefined;
  const selected = activeSection(code, value);
  if (selected === undefined) return undefined;
  let elapsed = false;
  let fraction = false;
  const currencies = new Set<string>();
  let at = 0;
  while (at < selected.length) {
    const character = selected.charAt(at);
    let token: string | undefined;
    if (character === '"') {
      const end = selected.indexOf('"', at + 1);
      token = selected.slice(at + 1, end).trim();
      at = end + 1;
    } else if (character === "[") {
      const end = selected.indexOf("]", at + 1);
      const bracket = selected.slice(at + 1, end);
      if (elapsedPattern.test(bracket)) elapsed = true;
      else if (bracket.startsWith("$"))
        token = bracket
          .slice(1)
          .replace(/-[A-Fa-f0-9]{3,8}$/, "")
          .trim();
      at = end + 1;
    } else if (character === "\\") {
      token = "";
      while (selected.charAt(at) === "\\") {
        token += selected.charAt(at + 1);
        at += 2;
      }
    } else if (character === "_" || character === "*") {
      at += 2;
    } else {
      if (character === "%") fraction = true;
      token = character;
      at += 1;
    }
    const currency = token === undefined ? undefined : currencyCodeOf(token);
    if (currency !== undefined) currencies.add(currency);
  }
  const currency =
    currencies.size === 1 ? currencies.values().next().value : undefined;
  const meaning: CellNumericMeaning | undefined = elapsed
    ? { unit: "seconds" }
    : !fraction && currency === undefined
      ? undefined
      : {
          ...(fraction ? { unit: "fraction" as const } : {}),
          ...(currency === undefined ? {} : { currency }),
        };
  return {
    code: selected,
    elapsed,
    ...(meaning === undefined ? {} : { meaning }),
  };
}
