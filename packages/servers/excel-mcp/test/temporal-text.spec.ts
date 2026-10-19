import { describe, expect, it } from "vitest";
import {
  isCanonicalTime,
  readDurationText,
  readTimeText,
  sniffTemporal,
} from "../src/grid/temporal-text.js";

describe("bounded clock text", () => {
  it.each([
    ["09:30", "09:30:00", 34200],
    ["1:30:00", "01:30:00", 5400],
    ["00:00", "00:00:00", 0],
    ["23:59:59", "23:59:59", 86399],
    ["12:03:04.2500", "12:03:04.25", 43384.25],
    ["12:03:04,000000001", "12:03:04.000000001", 43384.000000001],
    ["١٢:٣٤:٥٦", "12:34:56", 45296],
    ["۰۹:۳۰", "09:30:00", 34200],
    ["०१:३०:००", "01:30:00", 5400],
    ["２３:５９:５９", "23:59:59", 86399],
  ] as const)("normalizes %s", (input, value, seconds) => {
    expect(readTimeText(input)).toEqual({ kind: "time", value, seconds });
  });

  it.each([
    "24:00:00",
    "99:99:99",
    "23:59:60",
    "12:60",
    "12:00:-1",
    "1:3",
    "12:00:00.",
    "12:00:00.1234567890",
    "12:30Z",
    "12:30+02:00",
    "-01:30",
    "12:30 PM",
    "Ⅻ:30",
    "12:00\u0000",
  ])("refuses %s without rollover or locale guessing", (input) => {
    expect(readTimeText(input)).toEqual({ kind: "text" });
  });

  it("recognizes only valid canonical-width times", () => {
    expect(isCanonicalTime("12:03:04.2500")).toBe(true);
    expect(isCanonicalTime("12:03:04.000000001")).toBe(true);
    expect(isCanonicalTime("1:30:00")).toBe(false);
    expect(isCanonicalTime("24:00:00")).toBe(false);
    expect(isCanonicalTime("12:30:00,5")).toBe(false);
  });
});

describe("fixed duration text", () => {
  it.each([
    ["1:30", 5400],
    ["36:00:00", 129600],
    ["-01:30:00", -5400],
    ["+36:00", 129600],
    ["100:02:03.5", 360123.5],
    ["-00:00:00,5", -0.5],
    ["P1D", 86400],
    ["P1DT2H3M4.5S", 93784.5],
    ["PT36H", 129600],
    ["PT90M", 5400],
    ["PT0.000000001S", 0.000000001],
    ["-P2DT3H", -183600],
    ["P0D", 0],
    ["-PT0S", 0],
    ["P१DT२H", 93600],
  ] as const)("reads %s as seconds", (input, seconds) => {
    expect(readDurationText(input)).toEqual({ kind: "duration", seconds });
  });

  it.each([
    "P1Y",
    "P1M",
    "P1W",
    "P1.5D",
    "P",
    "PT",
    "P1DT",
    "PT1,5S",
    "PT1M2H",
    "PT1H1H",
    "+PT1H",
    "P-1D",
    "PT1e3S",
    "1:60",
    "10:00:60",
    "Infinity:00",
    "NaN:00",
    "PT1.1234567890S",
  ])("refuses unsupported duration %s", (input) => {
    expect(readDurationText(input)).toEqual({ kind: "text" });
  });

  it("does not sum pure clocks without duration evidence", () => {
    expect(sniffTemporal(["09:30", "1:30:00", "bad"])).toBe("time");
    expect(sniffTemporal(["09:30", "36:00:00", "bad"])).toBe("duration");
    expect(sniffTemporal(["09:30", "PT1H"])).toBe("duration");
    expect(sniffTemporal(["99:99:99", "P1M", "not a time"])).toBe("none");
    expect(sniffTemporal(["-01:30"])).toBe("none");
  });

  it("rejects hostile 32767-character values before temporal expressions", () => {
    for (const input of [
      "9".repeat(32767),
      `${"0:".repeat(16000)}!`,
      `PT${"9".repeat(32760)}S`,
    ]) {
      expect(readTimeText(input)).toEqual({ kind: "text" });
      expect(readDurationText(input)).toEqual({ kind: "text" });
      expect(sniffTemporal([input])).toBe("none");
    }
  });
});
