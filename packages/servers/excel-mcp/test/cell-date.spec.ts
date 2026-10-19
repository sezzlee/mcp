import { describe, expect, it } from "vitest";
import {
  isDateFormat,
  isTimeOnlyFormat,
  serialToClock,
  serialToDate,
} from "../src/format/cell-date.js";

describe("isDateFormat", () => {
  it.each([
    ["m/d/yy", true],
    ["yyyy-mm-dd", true],
    ["[$-41F]dd.mm.yyyy", true],
    ["h:mm AM/PM", true],
    ["[h]:mm:ss", true],
    ["mmss.0", true],
    ["General", false],
    ["0.00", false],
    ["#,##0.00", false],
    ["0.00E+00", false],
    ["[Red]0.00", false],
    ['"Day "0', false],
    ["0\\m", false],
    ["_m0", false],
    ["@", false],
    ['_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)', false],
  ])("treats %s as a date format: %s", (code, expected) => {
    expect(isDateFormat(code)).toBe(expected);
  });
});

describe("isTimeOnlyFormat", () => {
  it.each([
    ["h:mm", true],
    ["hh:mm;@", true],
    ["h:mm:ss", true],
    ["h:mm AM/PM", true],
    ["[$-409]h:mm:ss AM/PM", true],
    ["mm:ss", true],
    ["mm:ss.0", true],
    ["[h]:mm:ss", false],
    ["[mm]:ss", false],
    ["m/d/yy h:mm", false],
    ["dd.mm.yyyy hh:mm", false],
    ["mm", false],
    ["mmm", false],
    ["yyyy-mm-dd", false],
  ])("treats %s as a time of day only: %s", (code, expected) => {
    expect(isTimeOnlyFormat(code)).toBe(expected);
  });
});

describe("serialToClock", () => {
  it.each([
    [0.34375, "08:15:00"],
    [0.395833333333333, "09:30:00"],
    [0.270833333333333, "06:30:00"],
    [45000.75, "18:00:00"],
    [0, "00:00:00"],
  ])("reads serial %d as %s", (serial, clock) => {
    expect(serialToClock(serial, false)).toBe(clock);
  });

  it("names no time for serial 60 or a negative serial", () => {
    expect(serialToClock(60.5, false)).toBeUndefined();
    expect(serialToClock(-0.5, false)).toBeUndefined();
  });
});

describe("serialToDate", () => {
  it.each([
    [1, false, "1900-01-01T00:00:00.000Z"],
    [59, false, "1900-02-28T00:00:00.000Z"],
    [61, false, "1900-03-01T00:00:00.000Z"],
    [45000, false, "2023-03-15T00:00:00.000Z"],
    [45000.5, false, "2023-03-15T12:00:00.000Z"],
    [0, true, "1904-01-01T00:00:00.000Z"],
  ])("reads serial %d (1904: %s) as %s", (serial, date1904, iso) => {
    expect(serialToDate(serial, date1904)?.toISOString()).toBe(iso);
  });

  it("keeps serial 60, Excel's phantom 29 February 1900, as a number", () => {
    expect(serialToDate(60, false)).toBeUndefined();
  });
});
