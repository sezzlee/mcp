import type {
  FieldError,
  InvokeSuccess,
  SdkError,
} from "../generated/invoke-result.js";
import type {
  InvokeStored,
  OutlineEntry,
  ReadResult,
  StoredValueKind,
} from "../generated/result-reading.js";
import { sdkError } from "../invoke-guard.js";

const maxOutlineEntries = 16;
const maxOutlineDepth = 3;
const maxListedFields = 32;

export const readResultDescription =
  "Read part of a result invoke_tool stored because it was over the response limit. Pass the handle from that answer. path is a JSON Pointer into the stored body, taken from its outline: empty for the whole body, /items for a member, /items/0 for an element. select keeps only the named members of each element of an array, or of an object. offset and limit choose a window of elements, members or characters; the answer gives the total and the next offset.";

export const readHandleDescription =
  "The handle an invoke_tool answer returned in stored.handle.";

export const readPathDescription =
  "JSON Pointer into the stored body; empty for all of it.";

export const readSelectDescription =
  "Member names to keep, of each element of an array or of an object.";

export const readOffsetDescription =
  "First element, member or character to return; 0 by default.";

export const readLimitDescription =
  "Most elements, members or characters to return; all from offset by default.";

export const readNarrowing: readonly FieldError[] = [
  {
    name: "limit",
    message: "The most elements, members or characters to return.",
  },
  { name: "offset", message: "Where the window starts." },
  { name: "select", message: "The members to keep." },
  { name: "path", message: "A JSON Pointer to a smaller part of the result." },
];

/** The facts a stored answer is written from; the handle and lifetime come from the store. */
export interface StoredFacts {
  readonly success: InvokeSuccess;
  readonly handle: string;
  readonly bytes: number;
  readonly limit: number;
  readonly expiresInSeconds: number;
  readonly applied?: boolean;
}

/** The `read_result` arguments other than `handle`, after their types were checked. */
export interface ReadRequest {
  readonly path: string;
  readonly select?: readonly string[];
  readonly offset: number;
  readonly limit?: number;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindOf(value: unknown): StoredValueKind {
  if (Array.isArray(value)) {
    return "array";
  }
  if (isObject(value)) {
    return "object";
  }
  return typeof value === "string" ? "string" : "scalar";
}

function countOf(value: unknown): number | undefined {
  if (Array.isArray(value) || typeof value === "string") {
    return value.length;
  }
  return isObject(value) ? Object.keys(value).length : undefined;
}

function memberNames(value: unknown): string[] {
  if (isObject(value)) {
    return Object.keys(value);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const names = new Set<string>();
  for (const element of value) {
    if (isObject(element)) {
      for (const name of Object.keys(element)) {
        names.add(name);
      }
    }
  }
  return [...names];
}

function escapeToken(name: string): string {
  return name.replaceAll("~", "~0").replaceAll("/", "~1");
}

function entryOf(value: unknown, path: string): OutlineEntry {
  const count = countOf(value);
  const fields = memberNames(value).slice(0, maxListedFields);
  const [first, ...rest] = fields;
  return {
    path,
    kind: kindOf(value),
    ...(count === undefined ? {} : { count }),
    ...(first === undefined ? {} : { fields: [first, ...rest] }),
  };
}

/**
 * The parts of a stored body an agent can ask for: the root, then every array and object reached
 * through object members, depth first.
 */
export function outlineOf(body: unknown): [OutlineEntry, ...OutlineEntry[]] {
  const root = entryOf(body, "");
  const entries: [OutlineEntry, ...OutlineEntry[]] = [root];
  const visit = (value: unknown, path: string, depth: number): void => {
    if (!isObject(value) || depth >= maxOutlineDepth) {
      return;
    }
    for (const [name, child] of Object.entries(value)) {
      if (entries.length >= maxOutlineEntries) {
        return;
      }
      if (Array.isArray(child) || isObject(child)) {
        const childPath = `${path}/${escapeToken(name)}`;
        entries.push(entryOf(child, childPath));
        visit(child, childPath, depth + 1);
      }
    }
  };
  visit(body, "", 0);
  return entries;
}

/**
 * The answer that replaces an over-budget success once a store kept its body.
 */
export function storedAnswer(facts: StoredFacts): InvokeStored {
  const { success } = facts;
  const message = [
    `The response is ${facts.bytes} bytes; the limit is ${facts.limit} bytes.`,
    "It was stored, not returned: read it with read_result and the handle, choosing a path from the outline, the properties to select and a window with offset and limit.",
    `The stored result expires in ${facts.expiresInSeconds} seconds.`,
    ...(facts.applied === true
      ? [
          "The backend already applied the operation; read the stored result rather than calling it again.",
        ]
      : []),
  ].join(" ");
  return {
    status: success.status,
    ...(success.contentType === undefined
      ? {}
      : { contentType: success.contentType }),
    ...(success.location === undefined ? {} : { location: success.location }),
    stored: {
      handle: facts.handle,
      bytes: facts.bytes,
      limit: facts.limit,
      expiresInSeconds: facts.expiresInSeconds,
      outline: outlineOf(success.body),
    },
    message,
  };
}

function wrongType(argument: string, expected: string): SdkError {
  return sdkError(
    "invalid_selection",
    `Tool 'read_result' takes '${argument}' as ${expected}.`,
  );
}

function isAbsent(value: unknown): value is undefined | null {
  return value === undefined || value === null;
}

/**
 * Checks the types of the `read_result` arguments other than `handle`; nothing about the stored
 * result is consulted, so a call with no result to read learns nothing about one.
 */
export function parseReadArguments(read: {
  readonly path?: unknown;
  readonly select?: unknown;
  readonly offset?: unknown;
  readonly limit?: unknown;
}): ReadRequest | SdkError {
  const { path, select, offset, limit } = read;
  if (!isAbsent(path) && typeof path !== "string") {
    return wrongType("path", "a string");
  }
  if (
    !isAbsent(select) &&
    !(
      Array.isArray(select) &&
      select.every((name): name is string => typeof name === "string")
    )
  ) {
    return wrongType("select", "an array of strings");
  }
  if (
    !isAbsent(offset) &&
    !(typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0)
  ) {
    return wrongType("offset", "a non-negative integer");
  }
  if (
    !isAbsent(limit) &&
    !(typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 1)
  ) {
    return wrongType("limit", "a positive integer");
  }
  const selected = isAbsent(select) ? [] : [...new Set<string>(select)];
  return {
    path: path ?? "",
    ...(selected.length === 0 ? {} : { select: selected }),
    offset: offset ?? 0,
    ...(isAbsent(limit) ? {} : { limit }),
  };
}

function pointerSegments(path: string): string[] | undefined {
  if (path === "") {
    return [];
  }
  if (!path.startsWith("/")) {
    return undefined;
  }
  const segments = path.slice(1).split("/");
  return segments.some((segment) => /~(?![01])/.test(segment))
    ? undefined
    : segments;
}

function unescapeToken(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

const arrayIndex = /^(?:0|[1-9][0-9]*)$/;

type Resolution =
  | { readonly found: true; readonly value: unknown }
  | { readonly found: false; readonly existing: number };

function resolve(body: unknown, segments: readonly string[]): Resolution {
  let current = body;
  for (const [position, segment] of segments.entries()) {
    const token = unescapeToken(segment);
    if (Array.isArray(current)) {
      if (!arrayIndex.test(token) || Number(token) >= current.length) {
        return { found: false, existing: position };
      }
      current = current[Number(token)];
    } else if (isObject(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      return { found: false, existing: position };
    }
  }
  return { found: true, value: current };
}

function quoted(names: readonly string[]): string {
  return names.map((name) => `'${name}'`).join(", ");
}

function projected(element: unknown, select: readonly string[]): unknown {
  if (!isObject(element)) {
    return element;
  }
  return Object.fromEntries(
    select
      .filter((name) => Object.hasOwn(element, name))
      .map((name) => [name, element[name]]),
  );
}

/**
 * Reads one part of a stored body: resolves the path, applies the selection, then the window.
 */
export function selectFrom(
  body: unknown,
  request: ReadRequest,
): ReadResult | SdkError {
  const { path, select, offset, limit } = request;
  const segments = pointerSegments(path);
  if (segments === undefined) {
    return sdkError(
      "invalid_selection",
      `'${path}' is not a JSON Pointer: it is empty for the whole result, or starts with '/' and escapes '~' as '~0' and '/' as '~1'.`,
    );
  }
  const resolution = resolve(body, segments);
  if (!resolution.found) {
    const prefix = segments
      .slice(0, resolution.existing)
      .map((segment) => `/${segment}`)
      .join("");
    return sdkError(
      "invalid_selection",
      `Path '${path}' names nothing in the stored result. The longest part of it that exists is '${prefix}'.`,
    );
  }
  const value = resolution.value;
  const kind = kindOf(value);
  if (select !== undefined) {
    if (kind === "string" || kind === "scalar") {
      return sdkError(
        "invalid_selection",
        `select applies to an array or an object; path '${path}' holds a ${kind}.`,
      );
    }
    const names = memberNames(value);
    const present = new Set(names);
    const unknown = select.filter((name) => !present.has(name));
    if (unknown.length > 0) {
      const listed = names.slice(0, maxListedFields);
      return sdkError(
        "invalid_selection",
        `Path '${path}' has no property named ${quoted(unknown)}. ${
          listed.length === 0
            ? "It has no properties."
            : `Its properties are: ${listed.join(", ")}.`
        }`,
      );
    }
  }
  const end = limit === undefined ? undefined : offset + limit;
  const windowOf = (total: number, picked: unknown, returned: number) => ({
    path,
    kind,
    total,
    offset,
    ...(offset + returned < total ? { nextOffset: offset + returned } : {}),
    value: picked,
  });
  if (Array.isArray(value)) {
    const window = value.slice(offset, end);
    return windowOf(
      value.length,
      select === undefined
        ? window
        : window.map((element) => projected(element, select)),
      window.length,
    );
  }
  if (isObject(value)) {
    const members = Object.entries(value).filter(
      ([name]) => select === undefined || select.includes(name),
    );
    const window = members.slice(offset, end);
    return windowOf(members.length, Object.fromEntries(window), window.length);
  }
  if (typeof value === "string") {
    const window = value.slice(offset, end);
    return windowOf(value.length, window, window.length);
  }
  return { path, kind, value };
}

/**
 * The record a result store holds: the tool that produced the body, so a read can be decided as
 * `load_tool` would decide that tool.
 */
export function storedRecord(tool: string, body: unknown): string {
  return JSON.stringify({ tool, body });
}

export function recordOf(
  value: string,
): { readonly tool: string; readonly body: unknown } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const tool: unknown = Reflect.get(parsed, "tool");
  return typeof tool === "string"
    ? { tool, body: Reflect.get(parsed, "body") }
    : undefined;
}
