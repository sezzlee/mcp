import { z } from "zod";
import type { Answer } from "./task.ts";

const refusalReasons = [
  "notInFile",
  "suppressed",
  "ambiguous",
  "readOnly",
  "limit",
] as const;

const scalar = z.union([z.string(), z.number()]);

const answerFields = {
  value: scalar.optional(),
  items: z.array(scalar).optional(),
  fields: z.record(z.string(), scalar).optional(),
  explanation: z.string().optional(),
};

const submissionSchema = z.strictObject({
  answer: z.strictObject(answerFields).optional(),
  refusal: z
    .strictObject({
      reason: z.enum(refusalReasons),
      explanation: z.string().optional(),
    })
    .optional(),
});
export type Submission = z.infer<typeof submissionSchema>;

const flatSubmissionSchema = z.strictObject({
  ...answerFields,
  refusal: z.enum(refusalReasons).optional(),
});

/**
 * Reads a `submit_answer` call: the flat arguments the tool takes now, or the
 * `answer`/`refusal` objects it took before, so saved runs still grade.
 * Returns null for arguments that fit neither, such as `fields` sent as a
 * JSON string.
 */
export function readSubmission(raw: unknown): Submission | null {
  const flat = flatSubmissionSchema.safeParse(raw);
  if (flat.success) {
    const { refusal, explanation, ...answer } = flat.data;
    return refusal === undefined
      ? { answer: { ...answer, explanation } }
      : { refusal: { reason: refusal, explanation } };
  }
  const nested = submissionSchema.safeParse(raw);
  return nested.success ? nested.data : null;
}

type Shape = "number" | "text" | "list" | "set" | "record";

const numberRule =
  "A number is bare: digits and a decimal point, with no unit, currency sign, percent sign or thousands separator, and unrounded unless the question asks for rounding.";
const textRule =
  "A text value is only what the question asks for, written as the file writes it. A date is yyyy-MM-dd, a month yyyy-MM, a date and time yyyy-MM-dd HH:mm.";
const explanation = {
  type: "string",
  description:
    "Anything besides the value itself: how you found it, its unit, an assumption you made. Never put this in the value.",
};

function shapeOf(answer: Answer): Shape {
  return answer.kind === "refusal" ? answer.shape : answer.kind;
}

function answerPropertiesOf(answer: Answer): Record<string, unknown> {
  const item = {
    type: ["string", "number"],
    description: `One bare value. ${textRule} ${numberRule}`,
  };
  const shape = shapeOf(answer);
  switch (shape) {
    case "number":
      return { value: { type: "number", description: numberRule } };
    case "text":
      return { value: { type: "string", description: textRule } };
    case "list":
      return {
        items: {
          type: "array",
          items: item,
          description: "In the order the question asks for.",
        },
      };
    case "set":
      return { items: { type: "array", items: item } };
    case "record": {
      const keys = answer.kind === "record" ? Object.keys(answer.fields) : [];
      return {
        fields: {
          type: "object",
          properties: Object.fromEntries(keys.map((key) => [key, item])),
          required: keys,
        },
      };
    }
    default: {
      const exhaustive: never = shape;
      return exhaustive;
    }
  }
}

/**
 * The lab-side tool the agent ends a run with; its answer property follows
 * the task's answer shape.
 *
 * Guard: the arguments are one flat object. With the answer nested under
 * `answer` beside an `explanation`, qwen3.8 moved `fields` to the top level
 * or sent it as a JSON string, and two answers it had found were graded as
 * none (first 14 runs of 2026-10-19's second matrix).
 */
export function submitTool(answer: Answer) {
  return {
    type: "function" as const,
    function: {
      name: "submit_answer",
      description:
        "Submit your final answer exactly once, then stop. Put only the asked value in the answer property and anything else in explanation. When the files cannot answer the question, pass refusal with its reason instead: notInFile (no such data), suppressed (the file withholds the value), ambiguous (the file supports more than one reading), readOnly (it asks to change a file), limit (a file is too large to read).",
      parameters: {
        type: "object",
        properties: {
          ...answerPropertiesOf(answer),
          explanation,
          refusal: { type: "string", enum: refusalReasons },
        },
      },
    },
  };
}

function fold(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleLowerCase("tr")
    .replace(/(\d)t(\d)/g, "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
}

function withoutNote(text: string): string {
  return text.replace(/\s*\([^()]*\)\s*$/, "");
}

function sameText(expected: string, got: string): boolean {
  const want = fold(expected);
  const have = fold(withoutNote(got));
  if (have === want || fold(got) === want) return true;
  return (
    /^\d{4}-\d{2}/.test(want) &&
    have.startsWith(want) &&
    /^(:00)?(\.0+)?(z)?$/.test(have.slice(want.length))
  );
}

function numberOf(value: string | number): number | undefined {
  if (typeof value === "number") return value;
  const tokens = value.match(/-?\d[\d.,]*/g) ?? [];
  const only = tokens.length === 1 ? tokens[0] : undefined;
  const cleaned = (only ?? value).replace(/[%£$€₺\s]/g, "");
  const normalized = /^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sameScalar(
  expected: string | number,
  got: string | number,
  tolerance: number,
): boolean {
  if (typeof expected === "number") {
    const value = numberOf(got);
    const allowed = Math.max(tolerance, 1e-9 * Math.max(1, Math.abs(expected)));
    return value !== undefined && Math.abs(value - expected) <= allowed;
  }
  return sameText(expected, String(got));
}

export interface Grade {
  readonly correct: boolean;
  readonly detail: string;
}

/**
 * Grades the raw arguments of a `submit_answer` call, or returns null when
 * the run submitted nothing.
 */
export function gradeSubmission(answer: Answer, raw: unknown): Grade | null {
  if (raw === null || raw === undefined) return null;
  const submission = readSubmission(raw);
  return submission === null
    ? { correct: false, detail: "arguments fit no submit_answer form" }
    : grade(answer, submission);
}

/** Compares a submission with the task's answer under the answer's own comparison. */
export function grade(answer: Answer, submission: Submission): Grade {
  if (answer.kind === "refusal") {
    if (submission.refusal === undefined)
      return {
        correct: false,
        detail: "answered where a refusal was expected",
      };
    return submission.refusal.reason === answer.reason
      ? { correct: true, detail: "refusal" }
      : {
          correct: false,
          detail: `refusal reason ${submission.refusal.reason}`,
        };
  }
  if (submission.answer === undefined)
    return {
      correct: false,
      detail: `refused (${submission.refusal?.reason ?? "no answer"})`,
    };
  const given = submission.answer;
  switch (answer.kind) {
    case "number":
      return given.value !== undefined &&
        sameScalar(answer.value, given.value, answer.tolerance)
        ? { correct: true, detail: "number" }
        : { correct: false, detail: `number ${String(given.value)}` };
    case "text":
      return given.value !== undefined &&
        sameScalar(answer.value, given.value, 0)
        ? { correct: true, detail: "text" }
        : { correct: false, detail: `text ${String(given.value)}` };
    case "list": {
      const items = given.items ?? [];
      const ok =
        items.length === answer.items.length &&
        answer.items.every((item, at) => sameScalar(item, items[at] ?? "", 0));
      return {
        correct: ok,
        detail: ok ? "list" : `list ${JSON.stringify(items)}`,
      };
    }
    case "set": {
      const items = given.items ?? [];
      const ok =
        items.length === answer.items.length &&
        answer.items.every((item) =>
          items.some((have) => sameScalar(item, have, 0)),
        );
      return {
        correct: ok,
        detail: ok ? "set" : `set ${JSON.stringify(items)}`,
      };
    }
    case "record": {
      const fields = Object.fromEntries(
        Object.entries(given.fields ?? {}).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      );
      const wrong = Object.entries(answer.fields)
        .filter(([key, value]) => {
          const have = fields[key.toLowerCase()];
          return (
            have === undefined || !sameScalar(value, have, answer.tolerance)
          );
        })
        .map(([key]) => key);
      return wrong.length === 0
        ? { correct: true, detail: "record" }
        : {
            correct: false,
            detail: `record fields ${wrong.join(", ")}: ${JSON.stringify(given.fields)}`,
          };
    }
    default: {
      const exhaustive: never = answer;
      return exhaustive;
    }
  }
}
