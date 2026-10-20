export interface RecordedCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly text: string;
}

export interface ReplayedText {
  readonly text: string;
}

export type CallReplay =
  | { readonly status: "same"; readonly tool: string }
  | {
      readonly status: "changed";
      readonly tool: string;
      readonly path: string;
      readonly before: unknown;
      readonly after: unknown;
    }
  | {
      readonly status: "blocked";
      readonly tool: string;
      readonly reason: string;
    };

/**
 * Fields that differ between two runs over the same bytes without meaning
 * anything: the copy's modification time, the workspace root, and opaque
 * cursors, which are compared by following them instead.
 */
const volatileKeys = new Set(["modifiedAt", "root", "nextCursor"]);

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function masked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(masked);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !volatileKeys.has(key))
        .map(([key, inner]) => [key, masked(inner)]),
    );
  return value;
}

/** The JSON pointer of the first place two values differ, or null when they are equal. */
export function firstDifference(
  before: unknown,
  after: unknown,
  path = "",
): {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
} | null {
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let at = 0; at < Math.max(before.length, after.length); at += 1) {
      const found = firstDifference(before[at], after[at], `${path}/${at}`);
      if (found !== null) return found;
    }
    return null;
  }
  if (
    typeof before === "object" &&
    before !== null &&
    typeof after === "object" &&
    after !== null &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const left = new Map(Object.entries(before));
    const right = new Map(Object.entries(after));
    for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      const found = firstDifference(
        left.get(key),
        right.get(key),
        `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
      );
      if (found !== null) return found;
    }
    return null;
  }
  return Object.is(before, after)
    ? null
    : { path: path === "" ? "/" : path, before, after };
}

function cursorOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const cursor = Object.entries(value).find(
    ([key]) => key === "nextCursor",
  )?.[1];
  return typeof cursor === "string" ? cursor : null;
}

/**
 * Replays one trial's recorded calls, in order, against a server and reports
 * each call as the same, changed at a JSON pointer, or blocked.
 *
 * Guard: arguments are replayed as recorded, wrong ones included, except a
 * cursor, which is bound to the cursor the replayed server returned for the
 * call that produced the recorded one. A cursor is opaque and tied to the
 * server that made it; replaying the old token would test the token, not the
 * server. A continuation whose source call no longer returns a cursor is
 * blocked by that divergence, not counted as a new failure.
 */
export async function replayTrial(input: {
  readonly calls: readonly RecordedCall[];
  readonly call: (
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<ReplayedText>;
}): Promise<readonly CallReplay[]> {
  const cursors = new Map<string, string | null>();
  const results: CallReplay[] = [];
  for (const recorded of input.calls) {
    const old = recorded.args["cursor"];
    let args = recorded.args;
    if (typeof old === "string") {
      const bound = cursors.get(old);
      if (bound === undefined || bound === null) {
        results.push({
          status: "blocked",
          tool: recorded.tool,
          reason:
            bound === null
              ? "the call that gave this cursor no longer returns one"
              : "no replayed call gave this cursor",
        });
        continue;
      }
      args = { ...recorded.args, cursor: bound };
    }
    const replayed = await input.call(recorded.tool, args);
    const before = parse(recorded.text);
    const after = parse(replayed.text);
    const recordedCursor = cursorOf(before);
    if (recordedCursor !== null) cursors.set(recordedCursor, cursorOf(after));
    const difference = firstDifference(masked(before), masked(after));
    results.push(
      difference === null
        ? { status: "same", tool: recorded.tool }
        : { status: "changed", tool: recorded.tool, ...difference },
    );
  }
  return results;
}
