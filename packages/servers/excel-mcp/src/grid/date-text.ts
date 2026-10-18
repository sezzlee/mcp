import { asciiLower, fold } from "@sezzlee/file-core";

export type DateOrder = "dmy" | "mdy";

export type DateReading =
  { readonly kind: "date"; readonly iso: string } | { readonly kind: "text" };

export type OrderDecision =
  | { readonly kind: "decided"; readonly order: DateOrder }
  | { readonly kind: "unordered" }
  | { readonly kind: "ambiguous"; readonly example: string }
  | { readonly kind: "none" };

interface Clock {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

interface Civil {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly clock: Clock | undefined;
  readonly offsetMinutes: number | undefined;
}

type Parsed =
  | { readonly kind: "fixed"; readonly civil: Civil }
  | {
      readonly kind: "ordered";
      readonly first: number;
      readonly second: number;
      readonly year: number;
      readonly clock: Clock | undefined;
    };

const monthNames: readonly (readonly string[])[] = [
  ["ocak", "oca", "january", "jan"],
  ["subat", "sub", "february", "feb"],
  ["mart", "mar", "march"],
  ["nisan", "nis", "april", "apr"],
  ["mayis", "may"],
  ["haziran", "haz", "june", "jun"],
  ["temmuz", "tem", "july", "jul"],
  ["agustos", "agu", "august", "aug"],
  ["eylul", "eyl", "september", "sept", "sep"],
  ["ekim", "eki", "october", "oct"],
  ["kasim", "kas", "november", "nov"],
  ["aralik", "ara", "december", "dec"],
];

const monthByName = new Map<string, number>(
  monthNames.flatMap((names, at) => names.map((name) => [name, at + 1])),
);

const time =
  "(?:[ T](\\d{1,2}):(\\d{2})(?::(\\d{2})(?:[.,](\\d{1,9}))?)?(?: ?([AaPp][Mm]))?)?";
const isoForm =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const yearFirstForm = new RegExp(
  `^(\\d{4})([./])(\\d{1,2})\\2(\\d{1,2})${time}$`,
);
const dottedForm = new RegExp(`^(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})${time}$`);
const orderedForm = new RegExp(
  `^(\\d{1,2})([/-])(\\d{1,2})\\2(\\d{4})${time}$`,
);
const dayNameForm = new RegExp(
  `^(\\d{1,2})[ .-]?(\\p{L}{1,12})\\.?[ .-]?(\\d{4})${time}$`,
  "u",
);
const nameDayForm = new RegExp(
  `^(\\p{L}{1,12})\\.? (\\d{1,2}),? (\\d{4})${time}$`,
  "u",
);

function asciiLowerOf(text: string | undefined): string | undefined {
  return text === undefined ? undefined : asciiLower(text);
}

/**
 * Guard: every date form read here fits in well under 64 characters, and a
 * cell may hold 32,767. Longer text is never offered to the date expressions,
 * so no cell can make them scan for long.
 */
const maxDateChars = 64;

function normalize(text: string): string | undefined {
  return text.length > maxDateChars
    ? undefined
    : text.replace(/\s+/g, " ").trim();
}

function numberAt(match: RegExpExecArray, at: number): number {
  return Number(match[at] ?? "");
}

function clockAt(match: RegExpExecArray, at: number): Clock | undefined {
  const hourText = match[at];
  if (hourText === undefined) return undefined;
  const meridiem = asciiLowerOf(match[at + 4]);
  const raw = Number(hourText);
  if (meridiem !== undefined && (raw < 1 || raw > 12)) return undefined;
  const fraction = match[at + 3] ?? "";
  return {
    hour: meridiemHour(raw, meridiem),
    minute: numberAt(match, at + 1),
    second: Number(match[at + 2] ?? "0"),
    millisecond: Number(`${fraction}000`.slice(0, 3)),
  };
}

function hasBrokenClock(match: RegExpExecArray, at: number): boolean {
  return match[at] !== undefined && clockAt(match, at) === undefined;
}

function offsetOf(zone: string | undefined): number | undefined {
  if (zone === undefined) return undefined;
  if (zone === "Z") return 0;
  const digits = zone.slice(1).replace(":", "");
  const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
  return zone.startsWith("-") ? -minutes : minutes;
}

function monthOf(name: string): number | undefined {
  return monthByName.get(fold(name));
}

function parseDate(text: string): Parsed | undefined {
  const iso = isoForm.exec(text);
  if (iso !== null) {
    const hour = iso[4];
    return {
      kind: "fixed",
      civil: {
        year: numberAt(iso, 1),
        month: numberAt(iso, 2),
        day: numberAt(iso, 3),
        clock:
          hour === undefined
            ? undefined
            : {
                hour: Number(hour),
                minute: numberAt(iso, 5),
                second: Number(iso[6] ?? "0"),
                millisecond: Number(`${iso[7] ?? ""}000`.slice(0, 3)),
              },
        offsetMinutes: offsetOf(iso[8]),
      },
    };
  }
  const yearFirst = yearFirstForm.exec(text);
  if (yearFirst !== null) {
    if (hasBrokenClock(yearFirst, 5)) return undefined;
    return {
      kind: "fixed",
      civil: {
        year: numberAt(yearFirst, 1),
        month: numberAt(yearFirst, 3),
        day: numberAt(yearFirst, 4),
        clock: clockAt(yearFirst, 5),
        offsetMinutes: undefined,
      },
    };
  }
  /**
   * Guard: a dotted date is read day first. Dots are the separator of the
   * day-first locales (Turkish, German, Russian); no locale writes month
   * first with dots, so reading them from column evidence would only turn a
   * column of early-month dates ambiguous for nothing.
   */
  const dotted = dottedForm.exec(text);
  if (dotted !== null) {
    if (hasBrokenClock(dotted, 4)) return undefined;
    return {
      kind: "fixed",
      civil: {
        year: numberAt(dotted, 3),
        month: numberAt(dotted, 2),
        day: numberAt(dotted, 1),
        clock: clockAt(dotted, 4),
        offsetMinutes: undefined,
      },
    };
  }
  const ordered = orderedForm.exec(text);
  if (ordered !== null) {
    if (hasBrokenClock(ordered, 5)) return undefined;
    return {
      kind: "ordered",
      first: numberAt(ordered, 1),
      second: numberAt(ordered, 3),
      year: numberAt(ordered, 4),
      clock: clockAt(ordered, 5),
    };
  }
  const dayName = dayNameForm.exec(text);
  if (dayName !== null) {
    const month = monthOf(dayName[2] ?? "");
    if (month === undefined || hasBrokenClock(dayName, 4)) return undefined;
    return {
      kind: "fixed",
      civil: {
        year: numberAt(dayName, 3),
        month,
        day: numberAt(dayName, 1),
        clock: clockAt(dayName, 4),
        offsetMinutes: undefined,
      },
    };
  }
  const nameDay = nameDayForm.exec(text);
  if (nameDay !== null) {
    const month = monthOf(nameDay[1] ?? "");
    if (month === undefined || hasBrokenClock(nameDay, 4)) return undefined;
    return {
      kind: "fixed",
      civil: {
        year: numberAt(nameDay, 3),
        month,
        day: numberAt(nameDay, 2),
        clock: clockAt(nameDay, 4),
        offsetMinutes: undefined,
      },
    };
  }
  return undefined;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Guard: a value without a zone is a wall-clock time and is returned as UTC,
 * as the OOXML reader returns zoneless `t="d"` cells, so the same file reads
 * the same on every host.
 */
function canonicalOf(civil: Civil): string | undefined {
  const { year, month, day, clock, offsetMinutes } = civil;
  if (year < 1000 || year > 9999 || month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysIn(year, month)) return undefined;
  if (
    clock !== undefined &&
    (clock.hour > 23 || clock.minute > 59 || clock.second > 59)
  )
    return undefined;
  if (clock === undefined && offsetMinutes === undefined)
    return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
  const instant =
    Date.UTC(
      year,
      month - 1,
      day,
      clock?.hour ?? 0,
      clock?.minute ?? 0,
      clock?.second ?? 0,
      clock?.millisecond ?? 0,
    ) -
    (offsetMinutes ?? 0) * 60_000;
  const iso = new Date(instant).toISOString();
  return /^\d{4}-/.test(iso) ? iso : undefined;
}

function civilOf(parsed: Parsed, order: DateOrder): Civil {
  if (parsed.kind === "fixed") return parsed.civil;
  return {
    year: parsed.year,
    month: order === "dmy" ? parsed.second : parsed.first,
    day: order === "dmy" ? parsed.first : parsed.second,
    clock: parsed.clock,
    offsetMinutes: undefined,
  };
}

/**
 * Reads text as a date and returns it as `yyyy-MM-dd`, or as a full ISO 8601
 * instant when it carries a time. `order` decides only numeric dates written
 * with slashes or dashes.
 */
export function readDateText(text: string, order: DateOrder): DateReading {
  const normalized = normalize(text);
  const parsed = normalized === undefined ? undefined : parseDate(normalized);
  if (parsed === undefined) return { kind: "text" };
  const iso = canonicalOf(civilOf(parsed, order));
  return iso === undefined ? { kind: "text" } : { kind: "date", iso };
}

/**
 * Decides whether a column's slash and dash dates put the day or the month
 * first, from all of its values: the order that reads the most values wins.
 * `unordered` means both orders read every date the same way.
 *
 * Guard: when both orders read every value and some value differently
 * (`01/02/2023`) the column is ambiguous; a guess there moves rows between
 * months without a trace.
 */
export function sniffDateOrder(values: Iterable<string>): OrderDecision {
  const support: Record<DateOrder, number> = { dmy: 0, mdy: 0 };
  const orders = ["dmy", "mdy"] as const;
  let split: string | undefined;
  for (const value of values) {
    const normalized = normalize(value);
    const parsed = normalized === undefined ? undefined : parseDate(normalized);
    if (parsed === undefined) continue;
    const readings = orders.map((order) => canonicalOf(civilOf(parsed, order)));
    orders.forEach((order, at) => {
      if (readings[at] !== undefined) support[order] += 1;
    });
    if (
      split === undefined &&
      readings[0] !== undefined &&
      readings[1] !== undefined &&
      readings[0] !== readings[1]
    )
      split = value;
  }
  if (support.dmy === 0 && support.mdy === 0) return { kind: "none" };
  if (support.dmy > support.mdy) return { kind: "decided", order: "dmy" };
  if (support.mdy > support.dmy) return { kind: "decided", order: "mdy" };
  return split === undefined
    ? { kind: "unordered" }
    : { kind: "ambiguous", example: split };
}

type Token =
  | "yyyy"
  | "MMMM"
  | "MMM"
  | "MM"
  | "M"
  | "dd"
  | "d"
  | "HH"
  | "H"
  | "hh"
  | "h"
  | "mm"
  | "ss"
  | "a";

const tokens: readonly Token[] = [
  "yyyy",
  "MMMM",
  "MMM",
  "MM",
  "M",
  "dd",
  "d",
  "HH",
  "H",
  "hh",
  "h",
  "mm",
  "ss",
  "a",
];

const tokenSource: Readonly<Record<Token, string>> = {
  yyyy: "(\\d{4})",
  MMMM: "(\\p{L}{1,12})",
  MMM: "(\\p{L}{1,12})\\.?",
  MM: "(\\d{2})",
  M: "(\\d{1,2})",
  dd: "(\\d{2})",
  d: "(\\d{1,2})",
  HH: "(\\d{2})",
  H: "(\\d{1,2})",
  hh: "(\\d{2})",
  h: "(\\d{1,2})",
  mm: "(\\d{2})",
  ss: "(\\d{2})",
  a: "([AaPp][Mm])",
};

const literals = new Set([".", "/", "-", ":", ",", " ", "T"]);

const tokenFamilies: readonly (readonly Token[])[] = [
  ["yyyy"],
  ["MMMM", "MMM", "MM", "M"],
  ["dd", "d"],
  ["HH", "H", "hh", "h"],
  ["mm"],
  ["ss"],
  ["a"],
];

/**
 * Guard: only `.` and `/` are escaped. Under the `u` flag an escape of any
 * other separator (`\-`, `\:`, `\,`) is a syntax error, not a literal.
 */
const literalSource: Readonly<Record<string, string>> = {
  " ": " ?",
  ".": "\\.",
  "/": "\\/",
};

function meridiemHour(raw: number, meridiem: string | undefined): number {
  return meridiem === undefined
    ? raw
    : (raw % 12) + (meridiem === "pm" ? 12 : 0);
}

/**
 * A date pattern built from `yyyy`, `MMMM`, `MMM`, `MM`, `M`, `dd`, `d`, `HH`,
 * `H`, `hh`, `h`, `mm`, `ss`, `a` and the separators `. / - : ,`, space and
 * `T`.
 *
 * Guard: the pattern is never handed to `RegExp` as written; only the source
 * fixed for each token is, so a caller's pattern cannot become a backtracking
 * expression.
 */
export class DateFormat {
  readonly pattern: string;

  readonly #expression: RegExp;

  readonly #fields: readonly Token[];

  private constructor(
    pattern: string,
    expression: RegExp,
    fields: readonly Token[],
  ) {
    this.pattern = pattern;
    this.#expression = expression;
    this.#fields = fields;
  }

  static compile(
    pattern: string,
  ):
    | { readonly kind: "format"; readonly format: DateFormat }
    | { readonly kind: "invalid"; readonly reason: string } {
    const fields: Token[] = [];
    let source = "^";
    let at = 0;
    while (at < pattern.length) {
      const token = tokens.find((candidate) =>
        pattern.startsWith(candidate, at),
      );
      if (token !== undefined) {
        fields.push(token);
        source += tokenSource[token];
        at += token.length;
        continue;
      }
      const character = pattern.charAt(at);
      if (!literals.has(character))
        return {
          kind: "invalid",
          reason: `'${character}' is neither a date token nor a separator.`,
        };
      source += literalSource[character] ?? character;
      at += 1;
    }
    const has = (...names: Token[]): boolean =>
      names.some((name) => fields.includes(name));
    if (!has("yyyy") || !has("MMMM", "MMM", "MM", "M") || !has("dd", "d"))
      return {
        kind: "invalid",
        reason: "The pattern needs a year (yyyy), a month and a day.",
      };
    /**
     * Guard: one token per family. Two month names side by side (`MMMMMMM`
     * splits into MMMM and MMM) would put two unbounded letter groups next to
     * each other, an expression that backtracks quadratically on a long cell.
     */
    if (
      tokenFamilies.some(
        (family) => fields.filter((field) => family.includes(field)).length > 1,
      )
    )
      return {
        kind: "invalid",
        reason: "A month, a day, an hour or another field appears twice.",
      };
    if (has("h", "hh") !== has("a"))
      return {
        kind: "invalid",
        reason: "A 12-hour clock (h, hh) needs a, and a needs h or hh.",
      };
    return {
      kind: "format",
      format: new DateFormat(pattern, new RegExp(`${source}$`, "u"), fields),
    };
  }

  read(text: string): DateReading {
    const normalized = normalize(text);
    const match =
      normalized === undefined ? null : this.#expression.exec(normalized);
    if (match === null) return { kind: "text" };
    const field = (...names: Token[]): string | undefined => {
      const at = this.#fields.findIndex((name) => names.includes(name));
      return at === -1 ? undefined : match[at + 1];
    };
    const monthText = field("MMMM", "MMM");
    const month =
      monthText === undefined ? Number(field("MM", "M")) : monthOf(monthText);
    if (month === undefined) return { kind: "text" };
    const hourText = field("HH", "H", "hh", "h");
    const meridiem = asciiLowerOf(field("a"));
    const raw = Number(hourText ?? "0");
    if (meridiem !== undefined && (raw < 1 || raw > 12))
      return { kind: "text" };
    const iso = canonicalOf({
      year: Number(field("yyyy")),
      month,
      day: Number(field("dd", "d")),
      clock:
        hourText === undefined
          ? undefined
          : {
              hour: meridiemHour(raw, meridiem),
              minute: Number(field("mm") ?? "0"),
              second: Number(field("ss") ?? "0"),
              millisecond: 0,
            },
      offsetMinutes: undefined,
    });
    return iso === undefined ? { kind: "text" } : { kind: "date", iso };
  }
}

/**
 * Names the pattern a numeric slash or dash date follows under `order`, for
 * a warning that tells the caller which `format` to pass.
 */
export function orderedPatternOf(
  example: string,
  order: DateOrder,
): string | undefined {
  const normalized = normalize(example);
  const match = normalized === undefined ? null : orderedForm.exec(normalized);
  if (match === null) return undefined;
  const separator = match[2] ?? "/";
  const head = order === "dmy" ? ["dd", "MM"] : ["MM", "dd"];
  return `${head.join(separator)}${separator}yyyy`;
}
