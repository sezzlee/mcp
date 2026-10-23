import { admittingNull, type JsonSchemaObject } from "@sezzlee/core";
import { OperationDropped, type DiagnosticSink } from "../diagnostics.js";
import { childPointer, segmentsOf, type JsonPointer } from "../ir/brand.js";
import {
  entriesOf,
  isObject,
  objectOf,
  stringOf,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
} from "../ir/json.js";
import type { DocumentVersion } from "../parse/parse.js";
import { pointerOfRef, resolvePointer } from "./refs.js";

export type Direction = "request" | "response";

export interface SchemaContext {
  readonly document: JsonObject;
  readonly version: DocumentVersion;
  readonly diagnostics: DiagnosticSink;
}

/**
 * @param root how a slot whose top level is a reference is treated: `required` dereferences it or
 * drops the operation (a parameter's kind is read from its top-level type), `preferred`
 * dereferences it when that terminates and keeps the reference otherwise
 * @param fileMediaType the media type a `format: binary` string becomes, from a multipart
 * `encoding` entry
 */
export interface SlotOptions {
  readonly direction: Direction;
  readonly root: "required" | "preferred";
  readonly fileMediaType?: (property: string) => string | undefined;
}

const subschemaMaps = [
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
] as const;

const subschemaSingles = [
  "items",
  "additionalProperties",
  "not",
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;

const subschemaLists = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

const annotations = new Set(["discriminator", "xml", "externalDocs"]);

const escapeDefName = (name: string): string =>
  name.replaceAll("~", "~0").replaceAll("/", "~1");

const localDefPrefix = "#/$defs/";

class SlotNormalizer {
  private readonly defs = new Map<string, JsonSchemaObject>();
  private readonly names = new Map<string, string>();
  private readonly queue: string[] = [];
  private local: JsonObject | undefined;

  constructor(
    private readonly context: SchemaContext,
    private readonly options: SlotOptions,
  ) {}

  /**
   * Guard: a schema with `$defs` at its root is JSON Schema 2020-12, as an SDK writes one into
   * `x-sezzlee`; an OpenAPI 3.0 Schema Object has no `$defs`. Its `#/$defs/<name>` references
   * point into that table, not at the document's root, where they would resolve to nothing.
   */
  normalize(schema: JsonValue | undefined, at: JsonPointer): JsonSchemaObject {
    const local = isObject(schema) ? objectOf(schema["$defs"]) : undefined;
    this.local = local;
    let root = this.convert(
      local === undefined ? schema : withoutDefs(schema as JsonObject),
      at,
      undefined,
    );
    while (this.queue.length > 0) {
      const ref = this.queue.shift() as string;
      const name = this.names.get(ref) as string;
      const localName = this.localName(ref);
      const target =
        localName === undefined
          ? resolvePointer(this.context.document, ref)
          : this.local?.[localName];
      if (target === undefined) {
        this.context.diagnostics.report(
          "openapi_document_invalid",
          pointerOfRef(ref),
          `Reference '${ref}' resolves to nothing; it is treated as an unconstrained schema.`,
        );
      }
      this.defs.set(name, this.convert(target, pointerOfRef(ref), undefined));
    }
    root = this.dereferenceRoot(root, at);
    const used = this.referencedDefs(root);
    const defs = [...this.defs.entries()].filter(([name]) => used.has(name));
    if (defs.length === 0) {
      return root;
    }
    return { ...root, $defs: Object.fromEntries(defs) };
  }

  private dereferenceRoot(
    root: JsonSchemaObject,
    at: JsonPointer,
  ): JsonSchemaObject {
    const nullableRef = nullableReference(root);
    if (nullableRef !== undefined) {
      const inner = this.dereferenceRoot(nullableRef, at);
      return inner === nullableRef
        ? root
        : this.nullable({ nullable: true }, inner);
    }
    let current = root;
    const seen = new Set<string>();
    while (Object.keys(current).length === 1 && current.$ref !== undefined) {
      const name = defNameOf(current.$ref);
      if (seen.has(name) || !this.defs.has(name)) {
        if (this.options.root === "required") {
          throw new OperationDropped(
            "recursive_parameter_schema",
            at,
            "The parameter's schema refers to itself at its top level, so it has no scalar or array type to write.",
          );
        }
        return root;
      }
      seen.add(name);
      current = this.defs.get(name) as JsonSchemaObject;
    }
    return current;
  }

  private referencedDefs(root: JsonSchemaObject): Set<string> {
    const used = new Set<string>();
    const pending: JsonValue[] = [root as JsonValue];
    while (pending.length > 0) {
      const node = pending.pop();
      if (Array.isArray(node)) {
        pending.push(...(node as JsonValue[]));
      } else if (isObject(node)) {
        for (const [key, value] of entriesOf(node)) {
          if (key === "$ref" && typeof value === "string") {
            const name = defNameOf(value);
            if (!used.has(name) && this.defs.has(name)) {
              used.add(name);
              pending.push(this.defs.get(name) as JsonValue);
            }
          } else {
            pending.push(value);
          }
        }
      }
    }
    return used;
  }

  private localName(ref: string): string | undefined {
    if (this.local === undefined || !ref.startsWith(localDefPrefix)) {
      return undefined;
    }
    const segment = ref.slice(localDefPrefix.length);
    if (segment.includes("/")) {
      return undefined;
    }
    const name = defNameOf(ref);
    return Object.hasOwn(this.local, name) ? name : undefined;
  }

  private nameFor(ref: string): string {
    const known = this.names.get(ref);
    if (known !== undefined) {
      return known;
    }
    const segments = segmentsOf(ref);
    const base =
      this.localName(ref) ??
      (segments.length === 3 &&
      segments[0] === "components" &&
      segments[1] === "schemas"
        ? (segments[2] as string)
        : segments.join("_"));
    let name = base;
    const taken = new Set(this.names.values());
    for (let suffix = 2; taken.has(name); suffix += 1) {
      name = `${base}_${suffix}`;
    }
    this.names.set(ref, name);
    this.queue.push(ref);
    return name;
  }

  private convert(
    value: JsonValue | undefined,
    at: JsonPointer,
    property: string | undefined,
  ): JsonSchemaObject {
    if (value === true || value === undefined) {
      return {};
    }
    if (value === false) {
      return { not: {} };
    }
    if (!isObject(value)) {
      return {};
    }
    const ref = stringOf(value["$ref"]);
    if (ref !== undefined && ref.startsWith("#")) {
      return this.convertRef(value, ref, at, property);
    }
    const out: MutableJsonObject = {};
    for (const [key, child] of entriesOf(value)) {
      const childAt = childPointer(at, key);
      if (key === "nullable" || key === "default" || key === "$ref") {
        continue;
      }
      if (key.startsWith("x-") || annotations.has(key)) {
        this.context.diagnostics.report(
          "annotation_removed",
          childAt,
          `Schema annotations such as '${key.startsWith("x-") ? "x-*" : key}' change nothing the composer writes and are removed.`,
        );
        continue;
      }
      if (key === "example") {
        if (value["examples"] === undefined) {
          out["examples"] = [child];
        }
        continue;
      }
      if (key === "format" && child === "binary") {
        out["contentMediaType"] =
          (property === undefined
            ? undefined
            : this.options.fileMediaType?.(property)) ??
          "application/octet-stream";
        continue;
      }
      if (key === "format" && child === "byte") {
        out["contentEncoding"] = "base64";
        continue;
      }
      if (
        (key === "exclusiveMinimum" || key === "exclusiveMaximum") &&
        typeof child === "boolean"
      ) {
        const bound = key === "exclusiveMinimum" ? "minimum" : "maximum";
        if (child && typeof value[bound] === "number") {
          out[key] = value[bound];
        }
        continue;
      }
      if (
        (key === "minimum" || key === "maximum") &&
        value[key === "minimum" ? "exclusiveMinimum" : "exclusiveMaximum"] ===
          true
      ) {
        continue;
      }
      if ((subschemaMaps as readonly string[]).includes(key)) {
        out[key] = this.convertMap(key, child, childAt);
        continue;
      }
      if ((subschemaSingles as readonly string[]).includes(key)) {
        out[key] =
          typeof child === "boolean"
            ? child
            : (this.convert(child, childAt, undefined) as JsonValue);
        continue;
      }
      if ((subschemaLists as readonly string[]).includes(key)) {
        out[key] = (Array.isArray(child) ? child : []).map(
          (member, index) =>
            this.convert(
              member as JsonValue,
              childPointer(childAt, index),
              undefined,
            ) as JsonValue,
        );
        continue;
      }
      out[key] = child;
    }
    if (Array.isArray(out["required"]) && isObject(out["properties"])) {
      const kept = new Set(Object.keys(out["properties"]));
      out["required"] = (out["required"] as readonly JsonValue[]).filter(
        (name) => typeof name === "string" && kept.has(name),
      );
    }
    const merged = mergeAllOf(out);
    return this.nullable(value, merged as JsonSchemaObject);
  }

  private convertRef(
    value: JsonObject,
    ref: string,
    at: JsonPointer,
    property: string | undefined,
  ): JsonSchemaObject {
    const target: JsonSchemaObject = {
      $ref: `#/$defs/${escapeDefName(this.nameFor(ref))}`,
    };
    const siblings = entriesOf(value).filter(
      ([key]) => key !== "$ref" && key !== "nullable",
    );
    if (
      this.context.version === "3.0" &&
      this.localName(ref) === undefined &&
      siblings.length > 0
    ) {
      this.context.diagnostics.report(
        "ref_siblings_ignored",
        at,
        "OpenAPI 3.0 ignores keywords next to $ref; only 'nullable' is honoured beside one.",
      );
      return this.nullable(value, target);
    }
    if (siblings.length === 0) {
      return this.nullable(value, target);
    }
    const rest: MutableJsonObject = {};
    for (const [key, child] of siblings) {
      rest[key] = child;
    }
    const converted = this.convert(rest, at, property);
    return this.nullable(value, { ...converted, ...target });
  }

  private convertMap(
    key: string,
    child: JsonValue,
    at: JsonPointer,
  ): JsonValue {
    const out: MutableJsonObject = {};
    for (const [name, schema] of entriesOf(child)) {
      if (key === "properties" && this.hidden(schema)) {
        continue;
      }
      out[name] = this.convert(
        schema,
        childPointer(at, name),
        key === "properties" ? name : undefined,
      ) as JsonValue;
    }
    return out;
  }

  private hidden(schema: JsonValue): boolean {
    if (!isObject(schema)) {
      return false;
    }
    return this.options.direction === "request"
      ? schema["readOnly"] === true
      : schema["writeOnly"] === true;
  }

  private nullable(
    source: JsonObject,
    schema: JsonSchemaObject,
  ): JsonSchemaObject {
    return source["nullable"] === true ? admittingNull(schema) : schema;
  }
}

function nullableReference(
  schema: JsonSchemaObject,
): JsonSchemaObject | undefined {
  const members = schema.anyOf ?? schema.oneOf;
  if (Object.keys(schema).length !== 1 || !Array.isArray(members)) {
    return undefined;
  }
  if (members.length !== 2) {
    return undefined;
  }
  const [first, second] = members as JsonSchemaObject[];
  const isNull = (member: JsonSchemaObject | undefined): boolean =>
    member !== undefined &&
    Object.keys(member).length === 1 &&
    member.type === "null";
  const isRef = (member: JsonSchemaObject | undefined): boolean =>
    member !== undefined &&
    Object.keys(member).length === 1 &&
    member.$ref !== undefined;
  if (isRef(first) && isNull(second)) {
    return first;
  }
  return isRef(second) && isNull(first) ? second : undefined;
}

function withoutDefs(schema: JsonObject): JsonObject {
  const { $defs: _defs, ...rest } = schema;
  return rest;
}

function defNameOf(ref: string): string {
  const name = ref.replace(/^#\/\$defs\//, "");
  return name.replaceAll("~1", "/").replaceAll("~0", "~");
}

const structural = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "allOf",
]);

/**
 * Merges an `allOf` of plain object schemas into one object, so a body root built by composition
 * can still be flattened. Anything that cannot be merged without choosing between two
 * definitions — a reference, a combinator, two different schemas for one property — is kept as
 * `allOf`, and the core sends such a body in root mode.
 */
function mergeAllOf(schema: MutableJsonObject): MutableJsonObject {
  const members = schema["allOf"];
  if (!Array.isArray(members) || members.length === 0) {
    return schema;
  }
  const objects = members.filter(isObject);
  if (objects.length !== members.length) {
    return schema;
  }
  const others = Object.keys(schema).filter((key) => key !== "allOf");
  if (
    objects.length === 1 &&
    others.every((key) => !structural.has(key)) &&
    Object.keys(objects[0] as JsonObject).length === 1 &&
    (objects[0] as JsonObject)["$ref"] !== undefined
  ) {
    const { allOf: _allOf, ...rest } = schema;
    return { ...rest, ...(objects[0] as JsonObject) };
  }
  const mergeable = objects.every(
    (member) =>
      member["$ref"] === undefined &&
      Object.keys(member).every(
        (key) => structural.has(key) || key === "description",
      ) &&
      (member["type"] === undefined || member["type"] === "object"),
  );
  if (!mergeable) {
    return schema;
  }
  const properties: MutableJsonObject = {
    ...(isObject(schema["properties"]) ? schema["properties"] : {}),
  };
  const required = new Set<string>(
    Array.isArray(schema["required"])
      ? (schema["required"] as JsonValue[]).filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  for (const member of objects) {
    for (const [name, property] of entriesOf(member["properties"])) {
      const existing = properties[name];
      if (
        existing !== undefined &&
        JSON.stringify(existing) !== JSON.stringify(property)
      ) {
        return schema;
      }
      properties[name] = property;
    }
    for (const name of Array.isArray(member["required"])
      ? (member["required"] as JsonValue[])
      : []) {
      if (typeof name === "string") {
        required.add(name);
      }
    }
  }
  const { allOf: _allOf, ...rest } = schema;
  return {
    ...rest,
    type: "object",
    properties,
    ...(required.size === 0 ? {} : { required: [...required] }),
  };
}

export function normalizeSlot(
  context: SchemaContext,
  schema: JsonValue | undefined,
  at: JsonPointer,
  options: SlotOptions,
): JsonSchemaObject {
  return new SlotNormalizer(context, options).normalize(schema, at);
}
