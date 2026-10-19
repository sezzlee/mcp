import { asciiDecimalDigits } from "./locale-text.js";

export type TimeReading =
  | { readonly kind: "time"; readonly value: string; readonly seconds: number }
  | { readonly kind: "text" };

export type DurationReading =
  | { readonly kind: "duration"; readonly seconds: number }
  | { readonly kind: "text" };

const maxTemporalChars = 128;
const clockForm = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?$/u;
const elapsedForm =
  /^([+-]?)(\d{1,120}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?$/u;
const isoDurationForm =
  /^(-?)P(?:(\d{1,120})D)?(?:T(?:(\d{1,120})H)?(?:(\d{1,120})M)?(?:(\d{1,120})(?:\.(\d{1,9}))?S)?)?$/u;
const canonicalTimeForm = /^\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/u;

function normalize(text: string): string | undefined {
  return text.length > maxTemporalChars ||
    (!text.includes(":") && !text.includes("P"))
    ? undefined
    : asciiDecimalDigits(text.trim());
}

function secondsOf(
  whole: string | undefined,
  fraction: string | undefined,
): number {
  return Number(
    `${whole ?? "0"}${fraction === undefined ? "" : `.${fraction}`}`,
  );
}

function clockOf(text: string): TimeReading {
  const match = clockForm.exec(text);
  if (match === null) return { kind: "text" };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = secondsOf(match[3], match[4]);
  if (hour > 23 || minute > 59 || second >= 60) return { kind: "text" };
  const fraction = (match[4] ?? "").replace(/0{1,9}$/u, "");
  return {
    kind: "time",
    value: `${String(hour).padStart(2, "0")}:${match[2]}:${match[3] ?? "00"}${fraction === "" ? "" : `.${fraction}`}`,
    seconds: hour * 3600 + minute * 60 + second,
  };
}

/** Reads a date-less clock, with no timezone or leap-second interpretation. */
export function readTimeText(text: string): TimeReading {
  const normalized = normalize(text);
  return normalized === undefined ? { kind: "text" } : clockOf(normalized);
}

export function isCanonicalTime(text: string): boolean {
  return (
    text.length <= 18 &&
    canonicalTimeForm.test(text) &&
    clockOf(text).kind === "time"
  );
}

function elapsedOf(text: string): DurationReading {
  const match = elapsedForm.exec(text);
  if (match === null) return { kind: "text" };
  const minute = Number(match[3]);
  const second = secondsOf(match[4], match[5]);
  if (minute > 59 || second >= 60) return { kind: "text" };
  const magnitude = Number(match[2]) * 3600 + minute * 60 + second;
  if (!Number.isFinite(magnitude)) return { kind: "text" };
  return {
    kind: "duration",
    seconds: magnitude === 0 || match[1] !== "-" ? magnitude : -magnitude,
  };
}

function isoDurationOf(text: string): DurationReading {
  const match = isoDurationForm.exec(text);
  if (match === null) return { kind: "text" };
  const hasTime =
    match[3] !== undefined || match[4] !== undefined || match[5] !== undefined;
  if ((match[2] === undefined && !hasTime) || (text.includes("T") && !hasTime))
    return { kind: "text" };
  const magnitude =
    Number(match[2] ?? 0) * 86400 +
    Number(match[3] ?? 0) * 3600 +
    Number(match[4] ?? 0) * 60 +
    secondsOf(match[5], match[6]);
  if (!Number.isFinite(magnitude)) return { kind: "text" };
  return {
    kind: "duration",
    seconds: magnitude === 0 || match[1] !== "-" ? magnitude : -magnitude,
  };
}

/** Reads signed elapsed hours or a fixed ISO day/time duration, in seconds. */
export function readDurationText(text: string): DurationReading {
  const normalized = normalize(text);
  if (normalized === undefined) return { kind: "text" };
  return normalized.startsWith("P") || normalized.startsWith("-P")
    ? isoDurationOf(normalized)
    : elapsedOf(normalized);
}

/** Unreadable values do not decide a column; an explicit duration cue wins. */
export function sniffTemporal(
  texts: readonly string[],
): "time" | "duration" | "none" {
  let clock = false;
  for (const text of texts) {
    const normalized = normalize(text);
    if (normalized === undefined) continue;
    if (isoDurationOf(normalized).kind === "duration") return "duration";
    const elapsed = elapsedOf(normalized);
    if (elapsed.kind === "duration" && Math.abs(elapsed.seconds) >= 86400)
      return "duration";
    if (clockOf(normalized).kind === "time") clock = true;
  }
  return clock ? "time" : "none";
}
