import type { JsonSchemaObject } from "@sezzlee/core";

const tagsKey = "swagger/apiUseTags";
const parametersKey = "swagger/apiParameters";
const classHeadersKey = "swagger/apiHeaders";

export interface DocumentedParameter {
  readonly schema?: JsonSchemaObject;
  readonly required?: boolean;
  readonly description?: string;
}

export interface DocumentedType {
  readonly type: unknown;
  readonly isArray: boolean;
}

/**
 * Calls a `type: () => X` thunk. A class always has a `prototype` and an arrow or method thunk never
 * does, which `@nestjs/swagger`'s own test — a function named `type` — only approximates.
 */
export function resolveLazy(declared: unknown): unknown {
  return typeof declared === "function" && !("prototype" in declared)
    ? (declared as () => unknown)()
    : declared;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function documentedType(
  type: unknown,
  isArray: unknown,
): DocumentedType {
  const resolved = resolveLazy(type);
  if (Array.isArray(resolved)) {
    return {
      type: resolved.length === 1 ? resolveLazy(resolved[0]) : undefined,
      isArray: true,
    };
  }
  return { type: resolved, isArray: isArray === true };
}

/**
 * The tags `@nestjs/swagger` writes for an operation: the controller's `@ApiTags`, or the
 * controller's name when it declares none, followed by the handler's own.
 */
export function documentedTags(
  controller: NewableFunction,
  handler: object,
): string[] {
  const own = tagsOf(controller);
  const tags = [
    ...(own.length === 0 ? [controller.name.replace(/Controller$/, "")] : own),
    ...tagsOf(handler),
  ];
  return [...new Set(tags)];
}

function tagsOf(target: object): string[] {
  const declared: unknown = Reflect.getMetadata(tagsKey, target);
  return Array.isArray(declared)
    ? declared.filter(
        (tag): tag is string => typeof tag === "string" && tag.length > 0,
      )
    : [];
}

/**
 * A header may also be declared on the controller, which `@nestjs/swagger` keeps under a key of its
 * own; the handler's declaration wins.
 */
export function documentedParameter(
  controller: NewableFunction,
  handler: object,
  location: "query" | "path" | "header",
  name: string,
): DocumentedParameter | undefined {
  const matches = (declared: unknown): boolean =>
    location === "header"
      ? typeof declared === "string" &&
        declared.toLowerCase() === name.toLowerCase()
      : declared === name;
  const declared = [
    ...declaredParameters(handler, parametersKey),
    ...(location === "header"
      ? declaredParameters(controller, classHeadersKey)
      : []),
  ];
  const found = declared.find(
    (parameter) => parameter["in"] === location && matches(parameter["name"]),
  );
  if (found === undefined) {
    return undefined;
  }
  const schema = parameterSchema(found);
  const description = found["description"];
  return {
    ...(schema === undefined ? {} : { schema }),
    ...(typeof found["required"] === "boolean"
      ? { required: found["required"] }
      : {}),
    ...(typeof description === "string" && description.length > 0
      ? { description }
      : {}),
  };
}

export function documentedBody(handler: object): DocumentedType | undefined {
  const found = declaredParameters(handler, parametersKey).find(
    (parameter) => parameter["in"] === "body",
  );
  if (found === undefined) {
    return undefined;
  }
  const declared = documentedType(found["type"], found["isArray"]);
  return typeof declared.type === "function" ? declared : undefined;
}

function declaredParameters(
  target: object,
  key: string,
): Record<string, unknown>[] {
  const declared: unknown = Reflect.getMetadata(key, target);
  return Array.isArray(declared)
    ? declared.flatMap<Record<string, unknown>>(
        (parameter: unknown) => asRecord(parameter) ?? [],
      )
    : [];
}

function parameterSchema(
  parameter: Record<string, unknown>,
): JsonSchemaObject | undefined {
  const declared = asRecord(parameter["schema"]);
  const items = asRecord(declared?.["items"]);
  const enumerated =
    enumSchema(declared?.["enum"]) ??
    (declared?.["type"] === "array" ? enumSchema(items?.["enum"]) : undefined);
  if (enumerated !== undefined) {
    return declared?.["type"] === "array"
      ? { type: "array", items: enumerated }
      : enumerated;
  }
  const { type, isArray } = documentedType(
    parameter["type"],
    parameter["isArray"],
  );
  const element =
    scalarSchema(type, parameter["format"]) ??
    scalarSchema(declared?.["type"], declared?.["format"]);
  if (element === undefined) {
    return undefined;
  }
  return isArray ? { type: "array", items: element } : element;
}

function enumSchema(values: unknown): JsonSchemaObject | undefined {
  if (!Array.isArray(values) || values.length === 0) {
    return undefined;
  }
  if (values.every((value) => typeof value === "string")) {
    return { type: "string", enum: values };
  }
  if (values.every((value) => Number.isInteger(value))) {
    return { type: "integer", enum: values };
  }
  return undefined;
}

function scalarSchema(
  type: unknown,
  format: unknown,
): JsonSchemaObject | undefined {
  const named =
    type === String
      ? "string"
      : type === Number
        ? "number"
        : type === Boolean
          ? "boolean"
          : type;
  switch (named) {
    case "string":
      return typeof format === "string" && format.length > 0
        ? { type: "string", format }
        : { type: "string" };
    case "integer":
    case "number":
    case "boolean":
      return { type: named };
    default:
      return undefined;
  }
}
