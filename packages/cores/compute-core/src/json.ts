export interface JsonReadRequest {
  readonly path?: string;
  readonly select?: readonly string[];
  readonly offset?: number;
  readonly limit?: number;
}

export type JsonRead =
  | { readonly kind: "invalid"; readonly message: string }
  | {
      readonly kind: "array" | "object" | "string" | "scalar";
      readonly path: string;
      readonly value: unknown;
      readonly total?: number;
      readonly offset?: number;
      readonly nextOffset?: number;
    };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads exact JSON values using RFC 6901 pointers and stable windows. */
export function readJsonValue(
  json: string,
  request: JsonReadRequest,
): JsonRead {
  const path = request.path ?? "";
  const offset = request.offset ?? 0;
  const limit = request.limit ?? 50;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  )
    return {
      kind: "invalid",
      message:
        "offset must be a non-negative integer and limit a positive integer.",
    };
  if ((path !== "" && !path.startsWith("/")) || /~(?![01])/u.test(path))
    return {
      kind: "invalid",
      message: "path must be an RFC 6901 JSON Pointer, with ~0 and ~1 escapes.",
    };
  let value: unknown = JSON.parse(json);
  for (const token of path === "" ? [] : path.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(value)) {
      if (
        !/^(0|[1-9][0-9]*)$/u.test(key) ||
        !Number.isSafeInteger(Number(key)) ||
        Number(key) >= value.length
      )
        return { kind: "invalid", message: "path names no array element." };
      const element: unknown = value[Number(key)];
      value = element;
    } else if (isJsonObject(value) && Object.hasOwn(value, key))
      value = value[key];
    else return { kind: "invalid", message: "path names no stored value." };
  }
  const select = request.select;
  if (
    select !== undefined &&
    (!Array.isArray(select) ||
      !select.every((name) => typeof name === "string"))
  )
    return { kind: "invalid", message: "select must contain member names." };
  if (select !== undefined && !Array.isArray(value) && !isJsonObject(value))
    return { kind: "invalid", message: "select requires an object or array." };
  if (select !== undefined) {
    const candidates: readonly unknown[] = Array.isArray(value)
      ? value
      : [value];
    if (
      select.some(
        (name) =>
          !candidates.some(
            (item) => isJsonObject(item) && Object.hasOwn(item, name),
          ),
      )
    )
      return {
        kind: "invalid",
        message: "A selected member does not exist in this object or array.",
      };
  }
  const project = (item: unknown): unknown =>
    !isJsonObject(item) || select === undefined
      ? item
      : Object.fromEntries(
          Object.entries(item).filter(([name]) => select.includes(name)),
        );
  const page = (
    kind: "array" | "object" | "string",
    total: number,
    selected: unknown,
    returned: number,
  ): JsonRead => ({
    kind,
    path,
    total,
    offset,
    value: selected,
    ...(offset + returned < total ? { nextOffset: offset + returned } : {}),
  });
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    const window = items.slice(offset, offset + limit);
    return page("array", items.length, window.map(project), window.length);
  }
  if (isJsonObject(value)) {
    const members = Object.entries(value).filter(
      ([name]) => select === undefined || select.includes(name),
    );
    const window = members.slice(offset, offset + limit);
    return page(
      "object",
      members.length,
      Object.fromEntries(window),
      window.length,
    );
  }
  if (typeof value === "string") {
    const window = value.slice(offset, offset + limit);
    return page("string", value.length, window, window.length);
  }
  return { kind: "scalar", path, value };
}

/** A bounded shape hint; array element contents are never included. */
export function outlineJsonValue(json: string): readonly {
  readonly path: string;
  readonly kind: string;
  readonly count?: number;
  readonly fields?: readonly string[];
}[] {
  const value: unknown = JSON.parse(json);
  const entry = (value: unknown, path: string) => ({
    path,
    kind: Array.isArray(value)
      ? "array"
      : isJsonObject(value)
        ? "object"
        : typeof value === "string"
          ? "string"
          : "scalar",
    ...(Array.isArray(value) || typeof value === "string"
      ? { count: value.length }
      : isJsonObject(value)
        ? { count: Object.keys(value).length }
        : {}),
    ...(isJsonObject(value) ? { fields: Object.keys(value).slice(0, 16) } : {}),
  });
  return [
    entry(value, ""),
    ...(!isJsonObject(value)
      ? []
      : Object.entries(value)
          .slice(0, 15)
          .filter(([, child]) => isJsonObject(child) || Array.isArray(child))
          .map(([key, child]) =>
            entry(child, `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
          )),
  ];
}
