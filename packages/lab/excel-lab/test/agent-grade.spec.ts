import { describe, expect, it } from "vitest";
import { gradeSubmission, numericLiteral } from "../src/agent/grade.ts";
import type { Answer } from "../src/agent/task.ts";

function meaning(answer: Answer, raw: unknown): boolean | undefined {
  return gradeSubmission(answer, raw)?.semantic.correct;
}

describe("grading what a submission means", () => {
  it.each<readonly [string, Answer, unknown, boolean]>([
    ["an empty string is not zero", { kind: "integer", value: 0 }, "", false],
    [
      "a number inside words is not the number",
      { kind: "integer", value: 451 },
      "451 thousand",
      false,
    ],
    [
      "a negation is not the number",
      { kind: "integer", value: 451 },
      "not 451",
      false,
    ],
    [
      "a decimal comma reads as a decimal",
      { kind: "decimal", value: 12.5, tolerance: 0 },
      "12,5",
      true,
    ],
    [
      "a decimal comma is not a thousands mark",
      { kind: "integer", value: 125 },
      "12,5",
      false,
    ],
    [
      "an accepted wording names the same label",
      {
        kind: "text",
        value: "duplicateValues",
        accept: ["Duplicate values", "Yinelenen değerler"],
      },
      "yinelenen DEĞERLER",
      true,
    ],
    [
      "an accepted wording with a gloss is not the wording",
      {
        kind: "text",
        value: "duplicateValues",
        accept: ["Yinelenen değerler"],
      },
      "Yinelenen değerler (duplicate values) vurgulaması",
      false,
    ],
    [
      "a qualified total is not the total",
      { kind: "text", value: "Total" },
      "Total (male only)",
      false,
    ],
    [
      "English title case matches upper case",
      { kind: "text", value: "SIEMENS FINANCIAL SERVICES LTD" },
      "Siemens Financial Services Ltd",
      true,
    ],
    [
      "Turkish title case matches upper case",
      { kind: "text", value: "KAŞÜSTÜ" },
      "Kaşüstü",
      true,
    ],
    [
      "a dropped Turkish letter does not match",
      { kind: "text", value: "ÇAYKARA" },
      "Caykara",
      false,
    ],
    [
      "a zone turns a wall clock into an instant",
      { kind: "localDateTime", value: "2019-12-31 23:40" },
      "2019-12-31T23:40:00.000Z",
      false,
    ],
    [
      "seconds and a T separator keep the wall clock",
      { kind: "localDateTime", value: "2019-12-31 23:40" },
      "2019-12-31T23:40:00.000",
      true,
    ],
    [
      "the declared tolerance is the whole tolerance",
      { kind: "decimal", value: 43640187.03, tolerance: 0.01 },
      43640187.07,
      false,
    ],
    [
      "a value inside the tolerance passes",
      { kind: "decimal", value: 43640187.03, tolerance: 0.01 },
      43640187.035,
      true,
    ],
    [
      "a fraction is not a percent",
      { kind: "percent", value: 81, tolerance: 0.5 },
      0.81,
      false,
    ],
    [
      "a percent sign still reads as the percent",
      { kind: "percent", value: 81, tolerance: 0.5 },
      "81%",
      true,
    ],
  ])("%s", (_, answer, value, correct) => {
    expect(meaning(answer, { value })).toBe(correct);
  });

  it("keeps the order of a list, ignores the order of a set, and matches record keys regardless of case", () => {
    const items = [
      { kind: "text", value: "A" },
      { kind: "text", value: "B" },
    ] as const;
    expect(
      meaning(
        { kind: "list", items: [items[0], items[1]] },
        { items: ["B", "A"] },
      ),
    ).toBe(false);
    expect(
      meaning(
        { kind: "set", items: [items[0], items[1]] },
        { items: ["B", "A"] },
      ),
    ).toBe(true);
    expect(
      meaning(
        {
          kind: "record",
          fields: {
            district: { kind: "text", value: "ÇAYKARA" },
            buildings: { kind: "integer", value: 17579 },
          },
        },
        { fields: { District: "Çaykara", buildings: 17579 } },
      ),
    ).toBe(true);
  });

  it("requires the refusal reason, and refuses credit for an answer where a refusal was due", () => {
    const answer: Answer = {
      kind: "refusal",
      reason: "suppressed",
      shape: "decimal",
    };
    expect(meaning(answer, { refusal: "suppressed" })).toBe(true);
    expect(meaning(answer, { refusal: "notInFile" })).toBe(false);
    expect(meaning(answer, { value: 149.1 })).toBe(false);
  });
});

describe("grading a submission's form", () => {
  it("passes a bare value and flags a right value in the wrong form", () => {
    const answer: Answer = { kind: "month", value: "2019-10" };
    expect(
      gradeSubmission(answer, { value: "2019-10", explanation: "October" }),
    ).toMatchObject({
      correct: true,
      protocol: { valid: true },
    });
    expect(
      gradeSubmission({ kind: "integer", value: 17579 }, { value: "17.579" }),
    ).toMatchObject({
      correct: false,
      protocol: { valid: false },
      semantic: { correct: false },
    });
    expect(
      gradeSubmission({ kind: "integer", value: 17579 }, { value: "17579" }),
    ).toMatchObject({
      correct: false,
      protocol: { valid: false },
      semantic: { correct: true },
    });
  });

  it("reads the flat arguments, the nested ones saved runs hold, and names arguments that fit neither", () => {
    const answer: Answer = {
      kind: "record",
      fields: {
        district: { kind: "text", value: "Çaykara" },
        buildings: { kind: "integer", value: 17579 },
      },
    };
    const fields = { buildings: 17579, district: "Çaykara" };
    expect(gradeSubmission(answer, { fields })?.correct).toBe(true);
    expect(gradeSubmission(answer, { answer: { fields } })?.correct).toBe(true);
    expect(
      gradeSubmission(answer, {
        fields: '{"district": "Çaykara", "buildings": 17579}',
      }),
    ).toMatchObject({
      correct: false,
      protocol: { valid: false, reason: "arguments fit no submit_answer form" },
    });
    expect(gradeSubmission(answer, null)).toBeNull();
  });
});

describe("reading a numeric literal", () => {
  it.each<readonly [string, ReturnType<typeof numericLiteral>]>([
    ["1.234,5", { kind: "number", value: 1234.5 }],
    ["1,234.5", { kind: "number", value: 1234.5 }],
    ["43.640.187,03", { kind: "number", value: 43640187.03 }],
    ["1,234", { kind: "ambiguous" }],
    ["1.234", { kind: "ambiguous" }],
    ["about 12", { kind: "none" }],
  ])("%s", (text, literal) => {
    expect(numericLiteral(text, { percent: false })).toEqual(literal);
  });
});
