import { z } from "zod";
import {
  refusalReasons,
  type Answer,
  type Field,
  type FieldKind,
  type RefusalReason,
} from "./task.ts";

export const graderVersion = "v2";

const scalar = z.union([z.string(), z.number()]);
type Scalar = z.infer<typeof scalar>;

const answerFields = {
  value: scalar.optional(),
  items: z.array(scalar).optional(),
  fields: z.record(z.string(), scalar).optional(),
  explanation: z.string().optional(),
};

const flatSubmissionSchema = z.strictObject({
  ...answerFields,
  refusal: z.enum(refusalReasons).optional(),
});

const nestedSubmissionSchema = z.strictObject({
  answer: z.strictObject(answerFields).optional(),
  refusal: z
    .strictObject({
      reason: z.enum(refusalReasons),
      explanation: z.string().optional(),
    })
    .optional(),
});

type Given = Omit<z.infer<typeof flatSubmissionSchema>, "refusal">;

export type Submission =
  | { readonly kind: "answer"; readonly given: Given }
  | {
      readonly kind: "refusal";
      readonly reason: RefusalReason;
      readonly explanation: string | undefined;
    };

/**
 * Reads a `submit_answer` call: the flat arguments the tool takes, or the
 * nested `answer`/`refusal` objects earlier runs sent. Returns null for
 * arguments that fit neither, such as `fields` sent as a JSON string.
 */
export function readSubmission(raw: unknown): Submission | null {
  const flat = flatSubmissionSchema.safeParse(raw);
  if (flat.success) {
    const { refusal, ...given } = flat.data;
    return refusal === undefined
      ? { kind: "answer", given }
      : { kind: "refusal", reason: refusal, explanation: given.explanation };
  }
  const nested = nestedSubmissionSchema.safeParse(raw);
  if (!nested.success) return null;
  if (nested.data.refusal !== undefined)
    return {
      kind: "refusal",
      reason: nested.data.refusal.reason,
      explanation: nested.data.refusal.explanation,
    };
  return { kind: "answer", given: nested.data.answer ?? {} };
}

const integerRule =
  "A whole number as a JSON number, with no unit, sign of currency or thousands separator.";
const decimalRule =
  "A JSON number with a decimal point, with no unit, sign of currency or thousands separator, and unrounded unless the question asks for rounding.";
const percentRule =
  "The number of percent as a JSON number: 81 for 81%, never 0.81 and never with a percent sign.";
const textRule =
  "Only what the question asks for, written as the file writes it, with nothing around it.";
const datePatterns: Readonly<
  Record<"date" | "month" | "localDateTime", { pattern: string; rule: string }>
> = {
  date: { pattern: "^\\d{4}-\\d{2}-\\d{2}$", rule: "A date as yyyy-MM-dd." },
  month: { pattern: "^\\d{4}-\\d{2}$", rule: "A month as yyyy-MM." },
  localDateTime: {
    pattern: "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$",
    rule: "A date and time as yyyy-MM-dd HH:mm, as the file's clock shows it, with no time zone.",
  },
};

function fieldSchemaOf(kind: FieldKind): Record<string, unknown> {
  switch (kind) {
    case "integer":
      return { type: "integer", description: integerRule };
    case "decimal":
      return { type: "number", description: decimalRule };
    case "percent":
      return { type: "number", description: percentRule };
    case "text":
      return { type: "string", description: textRule };
    case "date":
    case "month":
    case "localDateTime":
      return {
        type: "string",
        pattern: datePatterns[kind].pattern,
        description: datePatterns[kind].rule,
      };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function answerPropertiesOf(answer: Answer): Record<string, unknown> {
  switch (answer.kind) {
    case "integer":
    case "decimal":
    case "percent":
    case "text":
    case "date":
    case "month":
    case "localDateTime":
      return { value: fieldSchemaOf(answer.kind) };
    case "list":
      return {
        items: {
          type: "array",
          items: fieldSchemaOf(answer.items[0].kind),
          description: "In the order the question asks for.",
        },
      };
    case "set":
      return {
        items: { type: "array", items: fieldSchemaOf(answer.items[0].kind) },
      };
    case "record":
      return {
        fields: {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(answer.fields).map(([key, field]) => [
              key,
              fieldSchemaOf(field.kind),
            ]),
          ),
          required: Object.keys(answer.fields),
        },
      };
    case "refusal":
      return answer.shape === "list" || answer.shape === "set"
        ? { items: { type: "array", items: fieldSchemaOf("text") } }
        : { value: fieldSchemaOf(answer.shape) };
    default: {
      const exhaustive: never = answer;
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
          explanation: {
            type: "string",
            description:
              "Anything besides the value itself: how you found it, its unit, an assumption you made. Never put this in the value.",
          },
          refusal: { type: "string", enum: refusalReasons },
        },
      },
    },
  };
}

type Literal =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "none" };

/**
 * Reads a numeric literal written as text, whole: a value with any other
 * word around it is not a number. One separator followed by exactly three
 * digits (`1,234`, `1.234`) reads both as a thousands mark and as a decimal
 * mark, so it is ambiguous rather than guessed.
 */
export function numericLiteral(
  text: string,
  options: { readonly percent: boolean },
): Literal {
  let body = text.trim().replace(/^[£$€₺]\s*/, "");
  if (options.percent) body = body.replace(/\s*%$/, "");
  const parse = (normalized: string): Literal => {
    const value = Number(normalized);
    return Number.isFinite(value)
      ? { kind: "number", value }
      : { kind: "none" };
  };
  if (/^-?\d+$/.test(body)) return parse(body);
  if (/^-?\d{1,3}[.,]\d{3}$/.test(body)) return { kind: "ambiguous" };
  if (/^-?\d+\.\d+$/.test(body)) return parse(body);
  if (/^-?\d+,\d+$/.test(body)) return parse(body.replace(",", "."));
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(body))
    return parse(body.replace(/,/g, ""));
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(body))
    return parse(body.replace(/\./g, "").replace(",", "."));
  return { kind: "none" };
}

function foldings(text: string): readonly string[] {
  const plain = text.normalize("NFC").trim().replace(/\s+/g, " ");
  return [plain.toLocaleLowerCase("tr"), plain.toLocaleLowerCase("en")];
}

function sameText(expected: string, got: string): boolean {
  const want = foldings(expected);
  const have = foldings(got);
  return want[0] === have[0] || want[1] === have[1];
}

const temporalReadings: Readonly<
  Record<"date" | "month" | "localDateTime", RegExp>
> = {
  date: /^(\d{4}-\d{2}-\d{2})(?:T00:00(?::00(?:\.0+)?)?)?$/,
  month: /^(\d{4}-\d{2})$/,
  localDateTime: /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::00(?:\.0+)?)?$/,
};

interface FieldVerdict {
  readonly bare: boolean;
  readonly same: boolean;
  readonly detail: string;
}

function judgeField(expected: Field, got: Scalar | undefined): FieldVerdict {
  if (got === undefined) return { bare: false, same: false, detail: "missing" };
  switch (expected.kind) {
    case "integer":
    case "decimal":
    case "percent": {
      const literal: Literal =
        typeof got === "number"
          ? { kind: "number", value: got }
          : numericLiteral(got, { percent: expected.kind === "percent" });
      const bare = typeof got === "number";
      if (literal.kind !== "number")
        return {
          bare,
          same: false,
          detail: `${JSON.stringify(got)} is ${literal.kind === "ambiguous" ? "an ambiguous number" : "not a number"}`,
        };
      const value = literal.value;
      if (expected.kind === "integer")
        return {
          bare: bare && Number.isInteger(value),
          same: value === expected.value,
          detail: `${value}`,
        };
      if (
        expected.kind === "percent" &&
        Math.abs(expected.value) > 1 &&
        Math.abs(value) <= 1 &&
        value !== 0
      )
        return {
          bare,
          same: false,
          detail: `${value} is a fraction, not a percent`,
        };
      const allowed =
        expected.tolerance +
        4 * Number.EPSILON * Math.max(1, Math.abs(expected.value));
      return {
        bare,
        same: Math.abs(value - expected.value) <= allowed,
        detail: `${value}`,
      };
    }
    case "text":
      return {
        bare: typeof got === "string" && got.trim() !== "",
        same: typeof got === "string" && sameText(expected.value, got),
        detail: JSON.stringify(got),
      };
    case "date":
    case "month":
    case "localDateTime": {
      if (typeof got !== "string")
        return { bare: false, same: false, detail: `${got} is not a date` };
      const text = got.trim();
      const bare = new RegExp(datePatterns[expected.kind].pattern).test(text);
      const reading = temporalReadings[expected.kind].exec(text);
      const canonical =
        reading === null
          ? null
          : expected.kind === "localDateTime"
            ? `${reading[1]} ${reading[2]}`
            : reading[1];
      return {
        bare,
        same: canonical === expected.value,
        detail:
          canonical === null && /(?:Z|[+-]\d{2}:\d{2})$/.test(text)
            ? `${JSON.stringify(got)} is an instant, not a local time`
            : JSON.stringify(got),
      };
    }
    default: {
      const exhaustive: never = expected;
      return exhaustive;
    }
  }
}

function judgeAnswer(
  expected: Exclude<Answer, { kind: "refusal" }>,
  given: Given,
): FieldVerdict {
  switch (expected.kind) {
    case "integer":
    case "decimal":
    case "percent":
    case "text":
    case "date":
    case "month":
    case "localDateTime":
      return judgeField(expected, given.value);
    case "list": {
      const items = given.items ?? [];
      const verdicts = expected.items.map((item, at) =>
        judgeField(item, items[at]),
      );
      const sameLength = items.length === expected.items.length;
      return {
        bare: sameLength && verdicts.every((verdict) => verdict.bare),
        same: sameLength && verdicts.every((verdict) => verdict.same),
        detail: `items ${JSON.stringify(items)}`,
      };
    }
    case "set": {
      const items = given.items ?? [];
      const unused = [...items];
      const verdicts = expected.items.map((item) => {
        const at = unused.findIndex((have) => judgeField(item, have).same);
        return judgeField(
          item,
          at < 0 ? undefined : unused.splice(at, 1).at(0),
        );
      });
      return {
        bare: verdicts.every((verdict) => verdict.bare),
        same: unused.length === 0 && verdicts.every((verdict) => verdict.same),
        detail: `items ${JSON.stringify(items)}`,
      };
    }
    case "record": {
      const fields = new Map(
        Object.entries(given.fields ?? {}).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      );
      const verdicts = Object.entries(expected.fields).map(([key, field]) => ({
        key,
        verdict: judgeField(field, fields.get(key.toLowerCase())),
      }));
      const wrong = verdicts
        .filter((entry) => !entry.verdict.same)
        .map((entry) => entry.key);
      return {
        bare: verdicts.every((entry) => entry.verdict.bare),
        same: wrong.length === 0,
        detail:
          wrong.length === 0
            ? "record"
            : `fields ${wrong.join(", ")}: ${JSON.stringify(given.fields ?? {})}`,
      };
    }
    default: {
      const exhaustive: never = expected;
      return exhaustive;
    }
  }
}

/**
 * Compares a value a plan derived from server responses with the task's
 * answer, under the same reading the grader gives a submission's meaning.
 */
export function matchesAnswer(
  answer: Exclude<Answer, { kind: "refusal" }>,
  value: unknown,
): { readonly same: boolean; readonly detail: string } {
  const raw =
    answer.kind === "list" || answer.kind === "set"
      ? { items: value }
      : answer.kind === "record"
        ? { fields: value }
        : { value };
  const submission = readSubmission(raw);
  if (submission?.kind !== "answer")
    return {
      same: false,
      detail: `${JSON.stringify(value)} has no answer shape`,
    };
  const verdict = judgeAnswer(answer, submission.given);
  return { same: verdict.same, detail: verdict.detail };
}

export interface Grade {
  readonly graderVersion: string;
  readonly correct: boolean;
  readonly protocol:
    | { readonly valid: true }
    | { readonly valid: false; readonly reason: string };
  readonly semantic:
    | { readonly correct: true }
    | { readonly correct: false; readonly detail: string };
}

function gradeOf(input: {
  readonly bare: boolean;
  readonly protocolReason: string;
  readonly same: boolean;
  readonly detail: string;
}): Grade {
  return {
    graderVersion,
    correct: input.bare && input.same,
    protocol: input.bare
      ? { valid: true }
      : { valid: false, reason: input.protocolReason },
    semantic: input.same
      ? { correct: true }
      : { correct: false, detail: input.detail },
  };
}

/** Compares a submission with the task's answer: the value's form and its meaning separately. */
export function grade(answer: Answer, submission: Submission): Grade {
  if (answer.kind === "refusal")
    return gradeOf({
      bare: true,
      protocolReason: "",
      same:
        submission.kind === "refusal" && submission.reason === answer.reason,
      detail:
        submission.kind === "refusal"
          ? `refusal reason ${submission.reason}`
          : "answered where a refusal was expected",
    });
  if (submission.kind === "refusal")
    return gradeOf({
      bare: true,
      protocolReason: "",
      same: false,
      detail: `refused (${submission.reason})`,
    });
  const verdict = judgeAnswer(answer, submission.given);
  return gradeOf({
    bare: verdict.bare,
    protocolReason: "the value is not in the form the tool asks for",
    same: verdict.same,
    detail: verdict.detail,
  });
}

/**
 * Grades the raw arguments of a `submit_answer` call, or returns null when
 * the run submitted nothing.
 */
export function gradeSubmission(answer: Answer, raw: unknown): Grade | null {
  if (raw === null || raw === undefined) return null;
  const submission = readSubmission(raw);
  return submission === null
    ? gradeOf({
        bare: false,
        protocolReason: "arguments fit no submit_answer form",
        same: false,
        detail: "unreadable submission",
      })
    : grade(answer, submission);
}

function describeField(field: Field): string {
  switch (field.kind) {
    case "decimal":
    case "percent":
      return `${field.value}${field.kind === "percent" ? "%" : ""}${field.tolerance > 0 ? ` ±${field.tolerance}` : ""}`;
    case "integer":
      return String(field.value);
    case "text":
    case "date":
    case "month":
    case "localDateTime":
      return field.value;
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

/** One line for a report: the expected answer. */
export function describeAnswer(answer: Answer): string {
  switch (answer.kind) {
    case "list":
      return answer.items.map(describeField).join(" → ");
    case "set":
      return `{${answer.items.map(describeField).join(", ")}}`;
    case "record":
      return Object.entries(answer.fields)
        .map(([key, field]) => `${key}: ${describeField(field)}`)
        .join(", ");
    case "refusal":
      return `refusal: ${answer.reason}`;
    default:
      return describeField(answer);
  }
}

/** One line for a report: the meaning verdict, and the form verdict when it failed. */
export function describeGrade(grade: Grade): string {
  const meaning = grade.semantic.correct ? "correct" : grade.semantic.detail;
  return grade.protocol.valid
    ? meaning
    : `${meaning} (form: ${grade.protocol.reason})`;
}
