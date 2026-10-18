import { SezzleeExcelError } from "../platform/errors.js";

export type NumberMarks =
  | { readonly decimal: "."; readonly group: "none" | "," | " " | "'" }
  | { readonly decimal: ","; readonly group: "none" | "." | " " | "'" };

export type NumberUnit =
  | { readonly kind: "plain" }
  | { readonly kind: "percent" }
  | { readonly kind: "currency"; readonly code: string };

export type NumberReading =
  | {
      readonly kind: "number";
      readonly value: number;
      readonly unit: NumberUnit;
    }
  | { readonly kind: "identifier" }
  | { readonly kind: "text" };

export type MarksDecision =
  | { readonly kind: "decided"; readonly marks: NumberMarks }
  | {
      readonly kind: "ambiguous";
      readonly candidates: readonly NumberMarks[];
      readonly example: string;
    }
  | { readonly kind: "none" };

export const markCandidates = [
  { decimal: ".", group: "none" },
  { decimal: ".", group: "," },
  { decimal: ".", group: " " },
  { decimal: ".", group: "'" },
  { decimal: ",", group: "none" },
  { decimal: ",", group: "." },
  { decimal: ",", group: " " },
  { decimal: ",", group: "'" },
] as const satisfies readonly NumberMarks[];

const plain: NumberUnit = { kind: "plain" };

const unitTokens: readonly (readonly [string, NumberUnit])[] = [
  ["%", { kind: "percent" }],
  ["₺", { kind: "currency", code: "TRY" }],
  ["TRY", { kind: "currency", code: "TRY" }],
  ["TL", { kind: "currency", code: "TRY" }],
  ["€", { kind: "currency", code: "EUR" }],
  ["EUR", { kind: "currency", code: "EUR" }],
  ["£", { kind: "currency", code: "GBP" }],
  ["GBP", { kind: "currency", code: "GBP" }],
  ["USD", { kind: "currency", code: "USD" }],
  ["$", { kind: "currency", code: "$" }],
];

const spaceLike = /[    ]/g;
const letter = /\p{L}/u;
const exponent = /[eE][+-]?\d+$/;
const digitsOnly = /^\d*$/;
const groupHead = /^[1-9]\d{0,2}$/;
const groupTail = /^\d{3}$/;

interface Affixed {
  readonly negative: boolean;
  readonly unit: NumberUnit;
  readonly body: string;
}

function normalize(text: string): string {
  return text
    .replace(spaceLike, " ")
    .replaceAll("’", "'")
    .replaceAll("−", "-")
    .trim();
}

function unitAtStart(
  text: string,
): { readonly unit: NumberUnit; readonly rest: string } | undefined {
  for (const [token, unit] of unitTokens) {
    if (!text.startsWith(token)) continue;
    const rest = text.slice(token.length).trimStart();
    if (rest === "" || letter.test(rest.charAt(0))) continue;
    return { unit, rest };
  }
  return undefined;
}

function unitAtEnd(
  text: string,
): { readonly unit: NumberUnit; readonly rest: string } | undefined {
  for (const [token, unit] of unitTokens) {
    if (!text.endsWith(token)) continue;
    const rest = text.slice(0, text.length - token.length).trimEnd();
    if (rest === "" || letter.test(rest.charAt(rest.length - 1))) continue;
    return { unit, rest };
  }
  return undefined;
}

function affixesOf(text: string): Affixed | undefined {
  const parenthesised = text.startsWith("(") && text.endsWith(")");
  let rest = parenthesised ? text.slice(1, -1).trim() : text;
  let negative = parenthesised;
  let signs = 0;
  const takeSign = (): void => {
    const head = rest.charAt(0);
    if (head !== "-" && head !== "+") return;
    signs += 1;
    negative = negative || head === "-";
    rest = rest.slice(1).trimStart();
  };
  takeSign();
  const prefix = unitAtStart(rest);
  if (prefix !== undefined) {
    rest = prefix.rest;
    takeSign();
  }
  const suffix = unitAtEnd(rest);
  if (suffix !== undefined) rest = suffix.rest;
  if (
    signs > 1 ||
    (parenthesised && signs > 0) ||
    (prefix !== undefined && suffix !== undefined)
  )
    return undefined;
  return { negative, unit: prefix?.unit ?? suffix?.unit ?? plain, body: rest };
}

/**
 * Guard: a digit run with a leading zero, or longer than the 15 significant
 * digits Excel keeps, is an account number, a postcode or a card number, not
 * a quantity. Read as a number it would lose the zero or its last digits and
 * enter a total.
 */
function isIdentifier(body: string): boolean {
  if (body === "" || !digitsOnly.test(body)) return false;
  return (body.length > 1 && body.startsWith("0")) || body.length > 15;
}

function wholeDigits(
  whole: string,
  group: NumberMarks["group"],
  leadingZeros: boolean,
): string | undefined {
  if (digitsOnly.test(whole)) {
    return !leadingZeros && whole.length > 1 && whole.startsWith("0")
      ? undefined
      : whole;
  }
  if (group === "none") return undefined;
  const [head, ...tail] = whole.split(group);
  if (
    head === undefined ||
    tail.length === 0 ||
    !groupHead.test(head) ||
    !tail.every((part) => groupTail.test(part))
  )
    return undefined;
  return head + tail.join("");
}

function canonicalOf(
  body: string,
  marks: NumberMarks,
  leadingZeros = false,
): string | undefined {
  const power = exponent.exec(body);
  const mantissa = power === null ? body : body.slice(0, power.index);
  const parts = mantissa.split(marks.decimal);
  if (parts.length > 2) return undefined;
  const [whole = "", fraction = ""] = parts;
  if (!digitsOnly.test(fraction)) return undefined;
  const digits = wholeDigits(whole, marks.group, leadingZeros);
  if (digits === undefined || (digits === "" && fraction === ""))
    return undefined;
  const point = fraction === "" ? "" : `.${fraction}`;
  return `${digits === "" ? "0" : digits}${point}${power?.[0] ?? ""}`;
}

/**
 * Reads text as a number under the given decimal and group marks. A sign,
 * accounting parentheses, a percent sign or a currency symbol or code may sit
 * before or after the digits; a percentage is returned as its ratio.
 * `identifiers: "read"` reads a leading-zero or long digit run as a number,
 * for a caller that has said the column holds quantities.
 */
export function readNumberText(
  text: string,
  marks: NumberMarks,
  identifiers: "refuse" | "read" = "refuse",
): NumberReading {
  const affixed = affixesOf(normalize(text));
  if (affixed === undefined) return { kind: "text" };
  const reads = identifiers === "read";
  if (!reads && isIdentifier(affixed.body)) return { kind: "identifier" };
  const canonical = canonicalOf(affixed.body, marks, reads);
  if (canonical === undefined) return { kind: "text" };
  const magnitude = Number(canonical);
  if (!Number.isFinite(magnitude))
    throw new SezzleeExcelError(
      "numeric_overflow",
      "Numeric text is outside the finite number range.",
    );
  const signed = affixed.negative ? -magnitude : magnitude;
  return {
    kind: "number",
    value: affixed.unit.kind === "percent" ? signed / 100 : signed,
    unit: affixed.unit,
  };
}

function shapeOf(body: string): string {
  const shape = body.replace(/\d/g, "9");
  return body.startsWith("0") ? `0${shape.slice(1)}` : shape;
}

/**
 * Decides a column's decimal and group marks from all of its values: the
 * marks that read the most values win, and the values they cannot read are
 * left for the caller to count.
 *
 * Guard: when the winning marks read some value differently (`1.234` is 1234
 * under a group dot and 1.234 under a decimal dot) the column is ambiguous and
 * no marks are chosen; a guess there is a total off by a factor of a thousand.
 */
export function sniffNumberMarks(values: Iterable<string>): MarksDecision {
  const shapes = new Map<string, { count: number; readonly example: string }>();
  for (const value of values) {
    const affixed = affixesOf(normalize(value));
    if (affixed === undefined || isIdentifier(affixed.body)) continue;
    const shape = shapeOf(affixed.body);
    const seen = shapes.get(shape);
    if (seen === undefined) shapes.set(shape, { count: 1, example: value });
    else seen.count += 1;
  }
  const readings = [...shapes].map(([shape, seen]) => ({
    seen,
    canonical: markCandidates.map((marks) => canonicalOf(shape, marks)),
  }));
  const supported = markCandidates.map((marks, at) => ({
    marks,
    at,
    support: readings.reduce(
      (total, reading) =>
        reading.canonical[at] === undefined
          ? total
          : total + reading.seen.count,
      0,
    ),
  }));
  const best = Math.max(...supported.map((entry) => entry.support));
  if (best === 0) return { kind: "none" };
  const leaders = supported.filter((entry) => entry.support === best);
  const split = readings.find(
    (reading) =>
      new Set(leaders.map((entry) => reading.canonical[entry.at])).size > 1,
  );
  if (split !== undefined)
    return {
      kind: "ambiguous",
      candidates: leaders.map((entry) => entry.marks),
      example: split.seen.example,
    };
  const [first] = leaders;
  return first === undefined
    ? { kind: "none" }
    : { kind: "decided", marks: first.marks };
}
