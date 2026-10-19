import { describe, expect, it } from "vitest";
import { grade, gradeSubmission } from "../src/agent/grade.ts";
import type { Answer } from "../src/agent/task.ts";

describe("grading a submitted answer", () => {
  it("accepts a number within the tolerance, written with Turkish separators", () => {
    const answer: Answer = { kind: "number", value: 1234.5, tolerance: 0.01 };
    expect(grade(answer, { answer: { value: "1.234,5" } }).correct).toBe(true);
    expect(grade(answer, { answer: { value: 1234.52 } }).correct).toBe(false);
  });

  it("folds Turkish case in text answers", () => {
    const answer: Answer = { kind: "text", value: "ÇAYKARA" };
    expect(grade(answer, { answer: { value: "Çaykara" } }).correct).toBe(true);
    expect(grade(answer, { answer: { value: "Caykara" } }).correct).toBe(false);
  });

  it("matches a date and time written with or without seconds and a separator", () => {
    const answer: Answer = { kind: "text", value: "2019-12-31 23:40" };
    expect(
      grade(answer, { answer: { value: "2019-12-31T23:40:00.000" } }).correct,
    ).toBe(true);
    expect(
      grade(answer, { answer: { value: "2020-01-01T02:40:00" } }).correct,
    ).toBe(false);
  });

  it("keeps the order of a list and ignores the order of a set", () => {
    const list: Answer = { kind: "list", items: ["A", "B"] };
    const set: Answer = { kind: "set", items: ["A", "B"] };
    expect(grade(list, { answer: { items: ["B", "A"] } }).correct).toBe(false);
    expect(grade(set, { answer: { items: ["B", "A"] } }).correct).toBe(true);
  });

  it("requires the refusal reason, and refuses credit for an answer where a refusal was due", () => {
    const answer: Answer = {
      kind: "refusal",
      reason: "ambiguous",
      shape: "text",
    };
    expect(grade(answer, { refusal: { reason: "ambiguous" } }).correct).toBe(
      true,
    );
    expect(grade(answer, { refusal: { reason: "notInFile" } }).correct).toBe(
      false,
    );
    expect(grade(answer, { answer: { value: "2015-01-05" } }).correct).toBe(
      false,
    );
  });

  it("ignores a note the model appends to a value", () => {
    const list: Answer = { kind: "list", items: ["KAŞÜSTÜ", "SANCAK"] };
    const zero: Answer = { kind: "number", value: 0, tolerance: 0 };
    expect(
      grade(list, {
        answer: { items: ["KAŞÜSTÜ (15.535)", "Sancak (10.704)"] },
      }).correct,
    ).toBe(true);
    expect(grade(zero, { answer: { value: "Yok (0)" } }).correct).toBe(true);
    expect(grade(zero, { answer: { value: "0 ile 3 arası" } }).correct).toBe(
      false,
    );
  });

  it("grades the flat submit_answer arguments and the nested ones saved runs hold, and names arguments that fit neither", () => {
    const answer: Answer = {
      kind: "record",
      fields: { district: "Çaykara", buildings: 17579 },
      tolerance: 0,
    };
    const fields = { buildings: 17579, district: "Çaykara" };
    expect(
      gradeSubmission(answer, {
        fields,
        explanation: "En çok yapı Çaykara'da.",
      }),
    ).toEqual({ correct: true, detail: "record" });
    expect(gradeSubmission(answer, { answer: { fields } })).toEqual({
      correct: true,
      detail: "record",
    });
    expect(
      gradeSubmission(answer, {
        fields: '{"district": "Çaykara", "buildings": 17579}',
        explanation: "En çok yapı Çaykara'da.",
      }),
    ).toEqual({
      correct: false,
      detail: "arguments fit no submit_answer form",
    });
    expect(gradeSubmission(answer, null)).toBeNull();
  });

  it("reads a flat refusal with its reason", () => {
    const answer: Answer = {
      kind: "refusal",
      reason: "readOnly",
      shape: "text",
    };
    expect(
      gradeSubmission(answer, {
        refusal: "readOnly",
        explanation: "I can only read files.",
      }),
    ).toEqual({ correct: true, detail: "refusal" });
  });

  it("matches record fields by name regardless of case", () => {
    const answer: Answer = {
      kind: "record",
      fields: { district: "ÇAYKARA", buildings: 17579 },
      tolerance: 0,
    };
    expect(
      grade(answer, {
        answer: { fields: { District: "Çaykara", buildings: "17.579" } },
      }).correct,
    ).toBe(true);
  });
});
