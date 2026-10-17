import { asciiLower, asciiUpper } from "@sezzlee/file-core";

const elapsedTime = /\[[HhMmSsชนท]*\]/;
const numberRun = "0#?.,E+-%";
const digits = "0123456789";

function isGeneralAt(code: string, at: number): boolean {
  return (
    code.length >= at + 7 && asciiLower(code.slice(at, at + 7)) === "general"
  );
}

/**
 * Decides whether a number format code displays a date or a time, scanning it
 * the way SheetJS's `fmt_is_date` does so that a number reads as a date in
 * exactly the cells it did before: quoted text, escapes, padding and digit
 * placeholders are skipped, and any remaining date or time token (`d`, `m`,
 * `y`, `h`, `s`, `e`, `g`, `b`, `AM/PM`, `A/P`, an elapsed `[h]`) decides.
 */
export function isDateFormat(code: string): boolean {
  const length = code.length;
  let at = 0;
  while (at < length) {
    const character = code.charAt(at);
    switch (character) {
      case "G":
        if (isGeneralAt(code, at)) at += 6;
        at += 1;
        break;
      case '"':
        at += 1;
        while (at < length && code.charAt(at) !== '"') at += 1;
        at += 1;
        break;
      case "\\":
      case "_":
        at += 2;
        break;
      case "@":
        at += 1;
        break;
      case "M":
      case "D":
      case "Y":
      case "H":
      case "S":
      case "E":
      case "m":
      case "d":
      case "y":
      case "h":
      case "s":
      case "e":
      case "g":
      case "B":
      case "b":
        return true;
      case "A":
      case "a":
      case "上": {
        if (asciiUpper(code.slice(at, at + 3)) === "A/P") return true;
        const five = asciiUpper(code.slice(at, at + 5));
        if (five === "AM/PM" || five === "上午/下午") return true;
        at += 1;
        break;
      }
      case "[": {
        const close = code.indexOf("]", at);
        const bracket =
          close === -1 ? code.slice(at) : code.slice(at, close + 1);
        if (elapsedTime.test(bracket)) return true;
        at = close === -1 ? length : close + 1;
        break;
      }
      case ".":
      case "0":
      case "#":
        while (at < length) {
          at += 1;
          const next = code.charAt(at);
          const escapedMinus =
            next === "\\" &&
            code.charAt(at + 1) === "-" &&
            "0#".includes(code.charAt(at + 2));
          if (!numberRun.includes(next) && !escapedMinus) break;
        }
        break;
      case "?":
        do {
          at += 1;
        } while (code.charAt(at) === "?");
        break;
      case "*":
        at += 1;
        if (code.charAt(at) === " " || code.charAt(at) === "*") at += 1;
        break;
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7":
      case "8":
      case "9":
        while (at < length) {
          at += 1;
          if (!digits.includes(code.charAt(at))) break;
        }
        break;
      default:
        at += 1;
        break;
    }
  }
  return false;
}

const epoch1900 = Date.UTC(1899, 11, 30);
const offset1904 = 1462;

/**
 * Converts an Excel date serial to the instant it names, or `undefined` for
 * serial 60, the 29 February 1900 that Lotus 1-2-3 invented and Excel keeps:
 * it names no real day, so the cell stays a number.
 *
 * Guard: serials below 60 are shifted by one day, which is what keeps every
 * real date before March 1900 on the day Excel shows despite that phantom day.
 *
 * Guard: the day is scaled to milliseconds as `× 24 × 60 × 60 × 1000`, in that
 * order, as SheetJS does. `Date` truncates the fraction, and `× 86 400 000`
 * rounds differently: serial 46037.395833… (09:30) then lands on 09:29:59.999.
 */
export function serialToDate(
  serial: number,
  date1904: boolean,
): Date | undefined {
  const value = date1904 ? serial + offset1904 : serial;
  if (value >= 60 && value < 61) return undefined;
  const days = value > 60 ? value : value + 1;
  return new Date(days * 24 * 60 * 60 * 1000 + epoch1900);
}

function hasTimeToken(numberFormat: string | undefined): boolean {
  if (numberFormat === undefined) {
    return false;
  }
  const stripped = numberFormat
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "");
  return /[hs]/i.test(stripped);
}

/**
 * Renders a date cell for the tool surface: the calendar day alone when the
 * instant is midnight and the format shows no time, else the full ISO 8601
 * instant.
 */
export function formatDate(
  value: Date,
  numberFormat: string | undefined,
): string {
  const iso = value.toISOString();
  if (iso.endsWith("T00:00:00.000Z") && !hasTimeToken(numberFormat)) {
    return iso.slice(0, 10);
  }
  return iso;
}
