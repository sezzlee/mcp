import type { WriteCell } from "../authoring/values.js";

/**
 * Guard: Open XML SDK 2.16 validates date cells with an exact millisecond
 * pattern. A local ISO value with omitted seconds fractions is rejected by
 * that independent validator; no timezone is introduced by padding precision.
 */
export function isoWrite(
  value: Extract<WriteCell, { kind: "date" | "datetime" }>,
): string {
  if (value.kind === "date") return value.value + "T00:00:00.000";
  const dot = value.value.indexOf(".");
  return dot < 0
    ? value.value + ".000"
    : value.value.slice(0, dot + 1) + value.value.slice(dot + 1).padEnd(3, "0");
}
