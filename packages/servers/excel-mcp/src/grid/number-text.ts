import { SezzleeExcelError } from "../platform/errors.js";

export type NumberMarks =
  | { readonly decimal: "."; readonly group: "none" | "," | " " | "'" }
  | { readonly decimal: ","; readonly group: "none" | "." | " " | "'" };

export type NumberUnit =
  | { readonly kind: "plain" }
  | { readonly kind: "percent" }
  | { readonly kind: "permille" }
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
const currencyCodes = new Set(Intl.supportedValuesOf("currency"));

const unitTokens: readonly (readonly [string, NumberUnit])[] = [
  ["%", { kind: "percent" }],
  ["٪", { kind: "percent" }],
  ["‰", { kind: "permille" }],
  ["؉", { kind: "permille" }],
  ["₺", { kind: "currency", code: "TRY" }],
  ["TRY", { kind: "currency", code: "TRY" }],
  ["TL", { kind: "currency", code: "TRY" }],
  ["€", { kind: "currency", code: "EUR" }],
  ["EUR", { kind: "currency", code: "EUR" }],
  ["£", { kind: "currency", code: "GBP" }],
  ["GBP", { kind: "currency", code: "GBP" }],
  ["USD", { kind: "currency", code: "USD" }],
  ["$", { kind: "currency", code: "$" }],
  ["₹", { kind: "currency", code: "INR" }],
  ["₽", { kind: "currency", code: "RUB" }],
  ["¥", { kind: "currency", code: "¥" }],
  ["￥", { kind: "currency", code: "¥" }],
  ["₩", { kind: "currency", code: "₩" }],
];

/** Resolves an isolated currency token without guessing the country of a shared symbol. */
export function currencyCodeOf(token: string): string | undefined {
  if (token.length > 3) return undefined;
  if (currencyCodes.has(token)) return token;
  for (const [text, unit] of unitTokens) {
    if (text === token && unit.kind === "currency") return unit.code;
  }
  return undefined;
}

const spaceLike = /[    ]/g;
const letter = /\p{L}/u;
const exponent = /[eE][+-]?\d+$/;
const digitsOnly = /^\d*$/;

interface NumberSyntax {
  readonly decimal: string;
  readonly group: string;
  readonly primary?: number;
  readonly secondary?: number;
}

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
  const code = text.slice(0, 3);
  const rest = text.slice(3).trimStart();
  if (currencyCodes.has(code) && rest !== "" && !letter.test(rest.charAt(0)))
    return { unit: { kind: "currency", code }, rest };
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
  const code = text.slice(-3);
  const rest = text.slice(0, -3).trimEnd();
  if (
    currencyCodes.has(code) &&
    rest !== "" &&
    !letter.test(rest.charAt(rest.length - 1))
  )
    return { unit: { kind: "currency", code }, rest };
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
  syntax: NumberSyntax,
  leadingZeros: boolean,
): string | undefined {
  if (digitsOnly.test(whole)) {
    return !leadingZeros && whole.length > 1 && whole.startsWith("0")
      ? undefined
      : whole;
  }
  if (syntax.group === "none") return undefined;
  const [head, ...tail] = whole.split(syntax.group);
  const primary = syntax.primary ?? 3;
  const secondary = syntax.secondary ?? 3;
  if (
    head === undefined ||
    tail.length === 0 ||
    head === "" ||
    head.startsWith("0") ||
    !digitsOnly.test(head) ||
    head.length > secondary ||
    !tail.every(
      (part, at) =>
        digitsOnly.test(part) &&
        part.length === (at === tail.length - 1 ? primary : secondary),
    )
  )
    return undefined;
  return head + tail.join("");
}

function canonicalOf(
  body: string,
  marks: NumberSyntax,
  leadingZeros = false,
): string | undefined {
  const power = exponent.exec(body);
  const mantissa = power === null ? body : body.slice(0, power.index);
  const parts = mantissa.split(marks.decimal);
  if (parts.length > 2) return undefined;
  const [whole = "", fraction = ""] = parts;
  if (!digitsOnly.test(fraction)) return undefined;
  const digits = wholeDigits(whole, marks, leadingZeros);
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
  return readWithSyntax(text, marks, identifiers);
}

function readWithSyntax(
  text: string,
  marks: NumberSyntax,
  identifiers: "refuse" | "read",
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
    value:
      affixed.unit.kind === "percent"
        ? signed / 100
        : affixed.unit.kind === "permille"
          ? signed / 1000
          : signed,
    unit: affixed.unit,
  };
}

/**
 * An explicit decimal numeral system compiled from the host's Intl data.
 * Symbols, digit mappings and primary/secondary grouping widths are decided
 * once; reading a cell makes no Intl call and never selects the host locale.
 */
export class NumberLocale {
  readonly locale: string;
  readonly numberingSystem: string;
  readonly decimal: string;
  readonly group: string;
  readonly #syntax: NumberSyntax;
  readonly #digits: ReadonlyMap<string, string>;
  readonly #symbols: readonly (readonly [string, string])[];

  private constructor(
    locale: string,
    numberingSystem: string,
    syntax: NumberSyntax,
    digits: ReadonlyMap<string, string>,
    symbols: readonly (readonly [string, string])[],
  ) {
    this.locale = locale;
    this.numberingSystem = numberingSystem;
    this.decimal = syntax.decimal;
    this.group = syntax.group;
    this.#syntax = {
      ...syntax,
      group: syntax.group.replace(spaceLike, " ").replaceAll("’", "'"),
    };
    this.#digits = digits;
    this.#symbols = symbols;
  }

  static compile(
    locale: string,
    numberingSystem?: string,
  ):
    | { readonly kind: "locale"; readonly locale: NumberLocale }
    | { readonly kind: "invalid"; readonly reason: string } {
    try {
      if (locale.length === 0 || locale.length > 128)
        return {
          kind: "invalid",
          reason:
            "The locale must be a supported BCP 47 language tag of at most 128 characters.",
        };
      const requested = new Intl.Locale(locale);
      const canonical = requested.toString();
      if (
        Intl.NumberFormat.supportedLocalesOf([canonical], {
          localeMatcher: "lookup",
        }).length === 0
      )
        return {
          kind: "invalid",
          reason: `Locale '${locale}' is not supported by this runtime.`,
        };
      if (
        numberingSystem !== undefined &&
        requested.numberingSystem !== undefined &&
        numberingSystem !== requested.numberingSystem
      )
        return {
          kind: "invalid",
          reason: "numberingSystem conflicts with the locale's nu extension.",
        };
      const wanted = numberingSystem ?? requested.numberingSystem;
      const options = {
        useGrouping: true,
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
        ...(wanted === undefined ? {} : { numberingSystem: wanted }),
      } as const;
      const formatter = new Intl.NumberFormat(canonical, options);
      const resolved = formatter.resolvedOptions();
      if (wanted !== undefined && resolved.numberingSystem !== wanted)
        return {
          kind: "invalid",
          reason: `Numbering system '${wanted}' is not supported as a decimal positional system.`,
        };
      const digitFormatter = new Intl.NumberFormat(canonical, {
        useGrouping: false,
        maximumFractionDigits: 0,
        numberingSystem: resolved.numberingSystem,
      });
      const digits = new Map<string, string>();
      for (let value = 0; value < 10; value += 1) {
        const digit = digitFormatter
          .formatToParts(value)
          .filter((part) => part.type === "integer")
          .map((part) => part.value)
          .join("");
        if ([...digit].length !== 1 || digits.has(digit))
          return {
            kind: "invalid",
            reason:
              "Only decimal positional systems with ten distinct digits can be read.",
          };
        digits.set(digit, String(value));
      }
      const parts = formatter.formatToParts(1234567890123.5);
      const decimal = parts.find((part) => part.type === "decimal")?.value;
      const group =
        parts.find((part) => part.type === "group")?.value ?? "none";
      const widths = parts
        .filter((part) => part.type === "integer")
        .map((part) => [...part.value].length);
      if (decimal === undefined)
        return {
          kind: "invalid",
          reason: "The locale does not expose a decimal separator.",
        };
      const signParts = new Intl.NumberFormat(canonical, {
        ...options,
        signDisplay: "always",
      }).formatToParts(1);
      const percentParts = new Intl.NumberFormat(canonical, {
        style: "percent",
        numberingSystem: resolved.numberingSystem,
      }).formatToParts(0.5);
      const scientificParts = new Intl.NumberFormat(canonical, {
        notation: "scientific",
        numberingSystem: resolved.numberingSystem,
      }).formatToParts(1234);
      const symbols: (readonly [string, string])[] = [];
      const minus = formatter
        .formatToParts(-1)
        .find((part) => part.type === "minusSign")?.value;
      const plus = signParts.find((part) => part.type === "plusSign")?.value;
      const percent = percentParts.find(
        (part) => part.type === "percentSign",
      )?.value;
      const power = scientificParts.find(
        (part) => part.type === "exponentSeparator",
      )?.value;
      for (const [symbol, replacement] of [
        [power, "E"],
        [minus, "-"],
        [plus, "+"],
        [percent, "%"],
      ] as const)
        if (symbol !== undefined && symbol !== replacement)
          symbols.push([symbol, replacement]);
      return {
        kind: "locale",
        locale: new NumberLocale(
          resolved.locale,
          resolved.numberingSystem,
          {
            decimal,
            group,
            primary: widths.at(-1) ?? 3,
            secondary: widths.at(-2) ?? 3,
          },
          digits,
          symbols,
        ),
      };
    } catch {
      return {
        kind: "invalid",
        reason:
          "The locale or numbering system is not supported by this runtime.",
      };
    }
  }

  read(text: string, identifiers: "refuse" | "read" = "refuse"): NumberReading {
    if (
      text.length > 512 ||
      /[\p{Cc}\p{Cf}]/u.test(text.replace(/[\u061c\u200e\u200f]/g, ""))
    )
      return { kind: "text" };
    let source = text
      .trim()
      .replace(/^[\u061c\u200e\u200f]+|[\u061c\u200e\u200f]+$/g, "")
      .trim();
    if (/\p{Cf}/u.test(source)) return { kind: "text" };
    for (const [symbol, replacement] of this.#symbols)
      source = source.replaceAll(symbol, replacement);
    source = [...source]
      .map((character) => this.#digits.get(character) ?? character)
      .join("");
    return readWithSyntax(source, this.#syntax, identifiers);
  }
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
