/**
 * Renders the time of day an Excel serial names as `HH:mm:ss`, or `undefined`
 * for a serial the calendar cannot place.
 */
export function serialToClock(
  serial: number,
  date1904: boolean,
): string | undefined {
  if (serial < 0) return undefined;
  return serialToDate(serial, date1904)?.toISOString().slice(11, 19);
}

const epoch1900 = Date.UTC(1899, 11, 30);
const offset1904 = 1462;

/**
 * Converts an Excel date serial to the instant it names, or `undefined` for
 * serial 60, the 29 February 1900 that Lotus 1-2-3 invented and Excel keeps:
 * it names no real day, so the cell stays a number. A serial past the range a
 * `Date` can hold is `undefined` too, so it stays a number instead of throwing
 * from `toISOString`.
 *
 * Guard: serials below 60 are shifted by one day, which is what keeps every
 * real date before March 1900 on the day Excel shows despite that phantom day.
 *
 * Guard: the day is scaled to milliseconds as `× 24 × 60 × 60 × 1000`, in that
 * order, as SheetJS does. `Date` truncates the fraction, and `× 86 400 000`
 * rounds differently: serial 46037.395833… (09:30) then lands on 09:29:59.999.
 *
 * Guard: only years 1 to 9999 are placed. `toISOString` writes any other year
 * as `+010000-…` or `-000001-…`, and the readers that slice it returned
 * `+010000-01` for a date and `01T00:00` for a time; Excel itself shows no
 * date past 31 December 9999.
 */
export function serialToDate(
  serial: number,
  date1904: boolean,
): Date | undefined {
  const value = date1904 ? serial + offset1904 : serial;
  if (value >= 60 && value < 61) return undefined;
  const days = value > 60 ? value : value + 1;
  const instant = new Date(days * 24 * 60 * 60 * 1000 + epoch1900);
  const year = instant.getUTCFullYear();
  return Number.isNaN(year) || year < 1 || year > 9999 ? undefined : instant;
}
