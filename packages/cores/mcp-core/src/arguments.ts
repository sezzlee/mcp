import type { z } from "zod";

type Issue = z.core.$ZodIssue;
type Path = readonly PropertyKey[];

function at(value: unknown, path: Path): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

function replaced(value: unknown, path: Path, next: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return next;
  if (Array.isArray(value) && typeof key === "number") {
    const copy = [...value];
    copy[key] = replaced(value[key], rest, next);
    return copy;
  }
  if (typeof value === "object" && value !== null)
    return { ...value, [key]: replaced(Reflect.get(value, key), rest, next) };
  return value;
}

function containerOf(issue: Issue): "array" | "object" | null {
  if (issue.code !== "invalid_type") return null;
  if (issue.expected === "array") return "array";
  return issue.expected === "object" ? "object" : null;
}

function decoded(text: string, expected: "array" | "object"): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith(expected === "array" ? "[" : "{")) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    const array = Array.isArray(value);
    if (expected === "array" ? array : typeof value === "object" && !array)
      return value;
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * The arguments with every JSON-encoded string decoded once where the schema
 * expects an array or object, or undefined when there is none to decode.
 *
 * Guard: open-weight models served through Ollama send an array argument as
 * text. In the excel lab every such string was malformed JSON, which stays
 * refused; decoding is limited to well-formed text. Only a string the parse
 * refused as the wrong container is decoded, only when it is that container's
 * JSON, and the result is validated again in full.
 */
export function decodeEncodedArguments(
  args: unknown,
  issues: readonly Issue[],
): unknown {
  let next = args;
  let changed = false;
  for (const issue of issues) {
    const expected = containerOf(issue);
    const text = expected === null ? undefined : at(next, issue.path);
    if (expected === null || typeof text !== "string") continue;
    const value = decoded(text, expected);
    if (value === undefined) continue;
    next = replaced(next, issue.path, value);
    changed = true;
  }
  return changed ? next : undefined;
}

function key(path: Path): string {
  return path.map(String).join(".");
}

/**
 * The issues of a failed parse as one sentence for the agent.
 *
 * Guard: zod keeps checking a value after its type failed, so a string sent
 * for a bounded array also fails the array's length bound as a string, and
 * "Too big: expected string to have <=128 characters" read as an invitation
 * to send shorter text. Only the type issue is kept at such a path.
 */
export function describeIssues(
  args: unknown,
  issues: readonly Issue[],
): string {
  const mistyped = new Set(
    issues
      .filter((issue) => issue.code === "invalid_type")
      .map((issue) => key(issue.path)),
  );
  return issues
    .filter(
      (issue) =>
        issue.code === "invalid_type" || !mistyped.has(key(issue.path)),
    )
    .map((issue) => {
      const expected = containerOf(issue);
      const message =
        expected !== null && typeof at(args, issue.path) === "string"
          ? `expected ${expected === "array" ? "an array" : "an object"}, received a string; send the ${expected} itself, not text that encodes it`
          : issue.message;
      return issue.path.length === 0
        ? message
        : `${key(issue.path)}: ${message}`;
    })
    .join("; ");
}

/** Recovery advice: the accepted names when a top-level argument is wrong, else the failing fields. */
export function recoveryFor(
  name: string,
  accepted: readonly string[],
  args: unknown,
  issues: readonly Issue[],
): string {
  if (accepted.length === 0) return `${name} takes no arguments.`;
  const topLevel = issues.some(
    (issue) =>
      issue.path.length === 0 ||
      (issue.path.length === 1 && at(args, issue.path) === undefined),
  );
  if (topLevel) return `Accepted arguments: ${accepted.join(", ")}.`;
  const fields = [...new Set(issues.map((issue) => key(issue.path)))];
  return `Only ${fields.join(", ")} failed validation; keep the other arguments as they are.`;
}
