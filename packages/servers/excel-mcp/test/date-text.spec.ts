import { describe, expect, it } from "vitest";
import {
  DateFormat,
  readDateText,
  sniffDateOrder,
} from "../src/grid/date-text.js";

describe("readDateText", () => {
  it.each([
    ["2023-01-02", "2023-01-02"],
    ["2023-01-02T13:45:00.000Z", "2023-01-02T13:45:00.000Z"],
    ["2023-01-02 13:45", "2023-01-02T13:45:00.000"],
    ["2023-01-02T13:45:00+03:00", "2023-01-02T13:45:00.000+03:00"],
    ["2023-01-02T13:45:00-0130", "2023-01-02T13:45:00.000-01:30"],
    ["2023-01-02T13:45:00.5Z", "2023-01-02T13:45:00.500Z"],
    ["2023/01/02", "2023-01-02"],
    ["2023.1.2", "2023-01-02"],
    ["02.01.2023", "2023-01-02"],
    ["2.1.2023", "2023-01-02"],
    ["02.01.2023 13:45", "2023-01-02T13:45:00.000"],
    ["02.01.2023 13:45:30", "2023-01-02T13:45:30.000"],
    ["29.02.2024", "2024-02-29"],
    ["18 Ekim 2026", "2026-10-18"],
    ["18 Eki 2026", "2026-10-18"],
    ["1 Ağustos 2025", "2025-08-01"],
    ["1 AĞUSTOS 2025", "2025-08-01"],
    ["5 Şubat 2024", "2024-02-05"],
    ["31 Aralık 2025", "2025-12-31"],
    ["18-Oct-2026", "2026-10-18"],
    ["October 18, 2026", "2026-10-18"],
    ["Sept 3, 2026", "2026-09-03"],
    ["18 Ekim 2026 09:30", "2026-10-18T09:30:00.000"],
  ])("reads %j as %j whatever the order", (text, iso) => {
    expect(readDateText(text, "dmy")).toEqual({ kind: "date", iso });
    expect(readDateText(text, "mdy")).toEqual({ kind: "date", iso });
  });

  it.each([
    ["02/01/2023", "dmy", "2023-01-02"],
    ["02/01/2023", "mdy", "2023-02-01"],
    ["02-01-2023", "dmy", "2023-01-02"],
    ["1/2/2023 1:45 PM", "mdy", "2023-01-02T13:45:00.000"],
    ["1/2/2023 12:05 AM", "mdy", "2023-01-02T00:05:00.000"],
    ["1/2/2023 12:05 pm", "mdy", "2023-01-02T12:05:00.000"],
    ["25/12/2023 23:59", "dmy", "2023-12-25T23:59:00.000"],
  ] as const)("reads %j %s as %j", (text, order, iso) => {
    expect(readDateText(text, order)).toEqual({ kind: "date", iso });
  });

  it.each([
    ["29.02.2023", "dmy"],
    ["31/04/2023", "dmy"],
    ["04/31/2023", "mdy"],
    ["32.01.2023", "dmy"],
    ["02.13.2023", "dmy"],
    ["2023-13-01", "dmy"],
    ["02.01.2023 24:00", "dmy"],
    ["02.01.2023 12:60", "dmy"],
    ["1/2/2023 13:00 PM", "mdy"],
    ["1/2/2023 0:30 AM", "mdy"],
    ["18 Foo 2026", "dmy"],
    ["02/01/23", "dmy"],
    ["02/01-2023", "dmy"],
    ["0999-01-01", "dmy"],
    ["abc", "dmy"],
    ["", "dmy"],
    ["2023", "dmy"],
    ["12:30", "dmy"],
    [`02.01.2023${" ".repeat(60)}x`, "dmy"],
    [`${"a".repeat(13)} 1, 2026`, "dmy"],
  ] as const)("leaves %j as text", (text, order) => {
    expect(readDateText(text, order)).toEqual({ kind: "text" });
  });
});

describe("sniffDateOrder", () => {
  it("reads day first when a day passes 12", () => {
    expect(sniffDateOrder(["25/01/2023", "02/01/2023"])).toEqual({
      kind: "decided",
      order: "dmy",
    });
  });

  it("reads month first when a day passes 12 in the second place", () => {
    expect(sniffDateOrder(["01/25/2023", "02/01/2023"])).toEqual({
      kind: "decided",
      order: "mdy",
    });
  });

  it("lets the order most values agree on win over a stray value", () => {
    expect(sniffDateOrder(["25/01/2023", "26/01/2023", "01/13/2023"])).toEqual({
      kind: "decided",
      order: "dmy",
    });
  });

  it("refuses to choose when every date fits both orders differently", () => {
    expect(sniffDateOrder(["01/02/2023", "03/04/2023"])).toEqual({
      kind: "ambiguous",
      example: "01/02/2023",
      orderedDots: false,
    });
  });

  it("orders dotted dates only when a dotted value makes the column ambiguous", () => {
    expect(sniffDateOrder(["25.01.2023", "01.13.2023"])).toEqual({
      kind: "ambiguous",
      example: "01.13.2023",
      orderedDots: true,
    });
  });

  it("needs no order when both read every date the same way", () => {
    expect(sniffDateOrder(["01/01/2023", "02.03.2023", "2023-05-06"])).toEqual({
      kind: "unordered",
    });
  });

  it("finds no date in text and numbers", () => {
    expect(sniffDateOrder(["abc", "12", "1.234,50"])).toEqual({
      kind: "none",
    });
  });
});

describe("DateFormat", () => {
  function read(pattern: string, text: string): unknown {
    const compiled = DateFormat.compile(pattern);
    if (compiled.kind === "invalid") return compiled;
    return compiled.format.read(text);
  }

  it.each([
    ["dd.MM.yyyy", "02.01.2023", "2023-01-02"],
    ["d.M.yyyy", "2.1.2023", "2023-01-02"],
    ["MM/dd/yyyy", "01/02/2023", "2023-01-02"],
    ["dd/MM/yyyy HH:mm", "02/01/2023 13:45", "2023-01-02T13:45:00.000"],
    ["MM/dd/yyyy h:mm a", "01/02/2023 1:45 PM", "2023-01-02T13:45:00.000"],
    ["d MMMM yyyy", "18 Ekim 2026", "2026-10-18"],
    ["dd-MMM-yyyy", "18-Oct-2026", "2026-10-18"],
    ["yyyy-MM-dd'", "x", undefined],
  ])("reads %j", (pattern, text, iso) => {
    if (iso === undefined) {
      expect(read(pattern, text)).toMatchObject({ kind: "invalid" });
      return;
    }
    expect(read(pattern, text)).toEqual({ kind: "date", iso });
  });

  it.each([
    ["dd.MM.yyyy", "2.1.2023"],
    ["dd.MM.yyyy", "02/01/2023"],
    ["dd.MM.yyyy", "31.04.2023"],
    ["MM/dd/yyyy", "13/01/2023"],
  ])("leaves %j against %j as text", (pattern, text) => {
    expect(read(pattern, text)).toEqual({ kind: "text" });
  });

  it.each([
    ["dd.MM", "year"],
    ["yyyy-dd", "month"],
    ["dd.MM.yyyy.dd", "twice"],
    ["dd MMMMMMM yyyy", "twice"],
    ["d.M.yyyy dd", "twice"],
    ["dd.MM.yyyy HH:mm h", "twice"],
    ["dd/MM/yyyy h:mm", "12-hour"],
    ["(.*)+", "neither"],
    ["dd.MM.yyyy'T'", "neither"],
  ])("refuses the pattern %j", (pattern, reason) => {
    const compiled = DateFormat.compile(pattern);
    expect(compiled.kind).toBe("invalid");
    expect(compiled.kind === "invalid" ? compiled.reason : "").toContain(
      reason,
    );
  });
});
