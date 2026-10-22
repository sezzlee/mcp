import type { CellFacts, CellSnapshot } from "../grid/cell-value.js";
import type { RawValue } from "../metadata/spreadsheetml/cells.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { serialToClock, serialToDate } from "../grid/excel-serial.js";
import { formatDate, isDateFormat, isTimeOnlyFormat } from "./cell-date.js";
import { numericFormat } from "./number-format.js";

const isoDateCell =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2)
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

interface IsoCell {
  readonly instant: Date;
  readonly offset: number | undefined;
}

/**
 * Guard: the text was read with `new Date`, which falls back to V8's legacy
 * parser for anything outside the ECMAScript form, `2026-02-30Z` among them:
 * it rolled that into 1 March, read `0001-01-01` as 2001 and took
 * `1/15/2026` as a date. Only ISO 8601 with a real calendar day and clock is
 * read now; any other text stays the text the cell holds.
 */
function readIsoCell(text: string): IsoCell | undefined {
  const match = isoDateCell.exec(text);
  if (match === null) return undefined;
  const [, y, mo, d, h, mi, s, fraction, zulu, sign, oh, om] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h ?? 0);
  const minute = Number(mi ?? 0);
  const second = Number(s ?? 0);
  const offsetHours = Number(oh ?? 0);
  const offsetMinutes = Number(om ?? 0);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  )
    return undefined;
  const offset =
    zulu !== undefined
      ? 0
      : sign === undefined
        ? undefined
        : (sign === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(
    hour,
    minute,
    second,
    Number((fraction ?? "").slice(0, 3).padEnd(3, "0")),
  );
  return {
    instant: new Date(wall.getTime() - (offset ?? 0) * 60_000),
    offset,
  };
}

function factsOf(
  value: RawValue,
  numberFormat: string,
  date1904: boolean,
): CellFacts {
  switch (value.kind) {
    case "none":
      return { value: null };
    case "string":
    case "boolean":
      return { value: value.value };
    case "error":
      return { value: { error: value.value === "" ? "#ERROR!" : value.value } };
    case "date": {
      /**
       * Guard: an ISO 8601 date cell without a zone names a wall-clock time,
       * and `Date` would read it in the server's own zone; it is read as UTC so
       * the same file gives the same answer on every host.
       */
      const read = readIsoCell(value.value);
      return read === undefined
        ? { value: value.value }
        : { value: formatDate(read.instant, numberFormat, read.offset) };
    }
    case "number": {
      if (!Number.isFinite(value.value)) {
        throw new SezzleeExcelError(
          "numeric_overflow",
          "A cell contains a non-finite number.",
        );
      }
      const format = numericFormat(numberFormat, value.value);
      if (format === undefined) return { value: value.value };
      if (format.elapsed) {
        /**
         * Guard: a serial is a fraction of a day, so one second is stored as
         * 1/86400 and multiplies back to 0.9999999999999997. Excel keeps 15
         * significant digits, so the product is cut to them: the noise goes
         * and an exactly stored fraction of a second stays as it was.
         */
        const seconds = Number((value.value * 86400).toPrecision(15));
        if (!Number.isFinite(seconds))
          throw new SezzleeExcelError(
            "numeric_overflow",
            "Elapsed duration exceeds the finite number range.",
          );
        return {
          value: { durationSeconds: seconds },
          meaning: { unit: "seconds" },
        };
      }
      if (!isDateFormat(format.code))
        return {
          value: value.value,
          ...(format.meaning === undefined ? {} : { meaning: format.meaning }),
        };
      if (isTimeOnlyFormat(format.code)) {
        const clock = serialToClock(value.value, date1904);
        return { value: clock ?? value.value };
      }
      const instant = serialToDate(value.value, date1904);
      return instant === undefined
        ? { value: value.value }
        : { value: formatDate(instant, format.code) };
    }
    default: {
      const _exhaustive: never = value;
      return _exhaustive;
    }
  }
}

/**
 * Builds the snapshot the grid layer reads from one stored cell: its value
 * (a date-formatted number as an ISO date), and for a formula cell the formula
 * text with the cached result kept apart from the value.
 */
export function ooxmlSnapshot({
  value,
  formula,
  numberFormat,
  date1904,
  href,
  merged,
  richFacts,
}: {
  readonly value: RawValue;
  readonly formula: string | undefined;
  readonly numberFormat: string;
  readonly date1904: boolean;
  readonly href: string | undefined;
  readonly merged: boolean;
  readonly richFacts?: CellFacts;
}): CellSnapshot {
  const base = richFacts ?? factsOf(value, numberFormat, date1904);
  const facts = href === undefined ? base : { ...base, href };
  if (formula === undefined) {
    return { merged, value: facts, numberFormat };
  }
  return {
    merged,
    value: { value: null },
    formula,
    ...(value.kind === "none" ? {} : { cached: facts }),
    numberFormat,
  };
}

/**
 * The snapshot of a cell the sheet does not store but a hyperlink is anchored
 * on: no value and no number format, only the link.
 */
export function anchorSnapshot({
  href,
  merged,
}: {
  readonly href: string;
  readonly merged: boolean;
}): CellSnapshot {
  return { merged, value: { value: null, href } };
}
