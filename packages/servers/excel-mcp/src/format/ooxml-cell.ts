import type { CellFacts, CellSnapshot } from "../grid/cell-value.js";
import type { RawValue } from "../metadata/spreadsheetml/cells.js";
import { SezzleeExcelError } from "../platform/errors.js";
import {
  formatDate,
  isDateFormat,
  isTimeOnlyFormat,
  serialToClock,
  serialToDate,
} from "./cell-date.js";
import { numericFormat } from "./number-format.js";

const zoneSuffix = /(?:[Zz]|([+-])(\d{2}):?(\d{2}))$/;

function offsetOfSuffix(text: string): number | undefined {
  const match = zoneSuffix.exec(text);
  if (match === null) return undefined;
  if (match[1] === undefined) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
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
      const offset = offsetOfSuffix(value.value);
      const instant = new Date(
        offset === undefined ? `${value.value}Z` : value.value,
      );
      return Number.isNaN(instant.getTime())
        ? { value: value.value }
        : { value: formatDate(instant, numberFormat, offset) };
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
