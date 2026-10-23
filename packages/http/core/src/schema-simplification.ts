import type { JsonSchemaObject } from "./generated/endpoint-descriptor.js";
import type {
  Constraints,
  EnumFacts,
  MapKey,
  Member,
  ObjectType,
  TypeNode,
  TypeShape,
} from "./generated/type-shape.js";
import { admittingNull, typeOf } from "./json-schema.js";

export type SchemaDiagnosticCode =
  | "unsupported_dictionary_key"
  | "schema_def_name_disambiguated"
  | "schema_depth_truncated"
  | "unreadable_shape";

export interface SchemaDiagnostic {
  readonly code: SchemaDiagnosticCode;
  readonly message: string;
}

export interface SchemaSimplificationOptions {
  readonly dropReadOnlyProperties?: boolean;
  readonly maxDepth?: number;
}

export interface SimplifiedSchema {
  readonly schema: JsonSchemaObject;
  readonly diagnostics: readonly SchemaDiagnostic[];
}

const integerKeyPattern = "^-?[0-9]+$";

function opaque(): JsonSchemaObject {
  return { type: "object", additionalProperties: true };
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collectRefs(node: TypeNode, out: string[]): void {
  if (node.kind === "ref") {
    if (node.ref !== undefined) {
      out.push(node.ref);
    }
    return;
  }
  if (node.kind === "array" && node.items !== undefined) {
    collectRefs(node.items, out);
    return;
  }
  if (node.kind === "map" && node.values !== undefined) {
    collectRefs(node.values, out);
  }
}

interface RefGraph {
  readonly uses: ReadonlyMap<string, number>;
  readonly edges: ReadonlyMap<string, readonly string[]>;
}

function buildGraph(shape: TypeShape): RefGraph {
  const uses = new Map<string, number>();
  const edges = new Map<string, readonly string[]>();
  const bump = (key: string): void => {
    uses.set(key, (uses.get(key) ?? 0) + 1);
  };

  const rootRefs: string[] = [];
  collectRefs(shape.root, rootRefs);
  const queue = [...rootRefs];
  for (const key of rootRefs) {
    bump(key);
  }

  while (queue.length > 0) {
    const key = queue.shift() as string;
    if (edges.has(key)) {
      continue;
    }
    const declared = shape.types[key];
    if (declared === undefined) {
      edges.set(key, []);
      continue;
    }
    const refs: string[] = [];
    for (const member of declared.members) {
      collectRefs(member.type, refs);
    }
    edges.set(key, refs);
    for (const ref of refs) {
      bump(ref);
      queue.push(ref);
    }
  }
  return { uses, edges };
}

function reaches(graph: RefGraph, from: string, target: string): boolean {
  const seen = new Set<string>();
  const queue = [...(graph.edges.get(from) ?? [])];
  while (queue.length > 0) {
    const key = queue.shift() as string;
    if (key === target) {
      return true;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    queue.push(...(graph.edges.get(key) ?? []));
  }
  return false;
}

function enumSchema(facts: EnumFacts): JsonSchemaObject {
  if (facts.wireForm === "unresolved") {
    return facts.combinable === true
      ? { anyOf: [{ type: "string" }, { type: "integer" }] }
      : {
          anyOf: [
            { type: "string", enum: [...facts.names] },
            { type: "integer", enum: [...facts.numbers] },
          ],
        };
  }
  const schema: JsonSchemaObject = { type: facts.wireForm };
  if (facts.combinable !== true) {
    schema.enum =
      facts.wireForm === "string" ? [...facts.names] : [...facts.numbers];
  }
  return schema;
}

function propertyNames(keys: MapKey): JsonSchemaObject | undefined {
  if (keys.scalar === undefined) {
    return undefined;
  }
  const schema: JsonSchemaObject = { type: "string" };
  if (keys.format !== undefined) {
    schema.format = keys.format;
  } else if (keys.scalar === "integer") {
    schema.pattern = integerKeyPattern;
  }
  return schema;
}

function applyConstraints(
  schema: JsonSchemaObject,
  description: string | undefined,
  constraints: Constraints | undefined,
): void {
  if (description !== undefined && schema.description === undefined) {
    schema.description = description;
  }
  if (constraints === undefined) {
    return;
  }
  const type = typeOf(schema);
  const list = type === "array";
  const text = type === "string";
  const numeric = type === "integer" || type === "number";

  if (constraints.minSize !== undefined) {
    if (list) {
      schema.minItems = constraints.minSize;
    } else {
      schema.minLength = constraints.minSize;
    }
  }
  if (constraints.maxSize !== undefined) {
    if (list) {
      schema.maxItems = constraints.maxSize;
    } else {
      schema.maxLength = constraints.maxSize;
    }
  }
  if (numeric && constraints.minimum !== undefined) {
    schema.minimum = constraints.minimum;
  }
  if (numeric && constraints.maximum !== undefined) {
    schema.maximum = constraints.maximum;
  }
  if (text && constraints.pattern !== undefined) {
    schema.pattern = constraints.pattern;
  }
  if (text && constraints.format !== undefined && schema.format === undefined) {
    schema.format = constraints.format;
  }
}

function populatable(node: TypeNode): boolean {
  return node.kind === "array" || node.kind === "map";
}

class Writer {
  private readonly diagnostics: SchemaDiagnostic[] = [];
  private readonly defs = new Map<string, JsonSchemaObject>();
  private readonly hoisted = new Set<string>();
  private readonly names = new Map<string, string>();
  private readonly dropReadOnly: boolean;
  private readonly maxDepth: number | undefined;

  constructor(
    private readonly shape: TypeShape,
    options: SchemaSimplificationOptions,
  ) {
    this.dropReadOnly = options.dropReadOnlyProperties ?? true;
    this.maxDepth = options.maxDepth;

    const graph = buildGraph(shape);
    for (const [key, count] of graph.uses) {
      if (count > 1 || reaches(graph, key, key)) {
        this.hoisted.add(key);
      }
    }
    this.assignNames();
  }

  private assignNames(): void {
    const claimed = new Map<string, number>();
    for (const key of [...this.hoisted].sort(ordinal)) {
      const declared = this.shape.types[key];
      const base = declared?.name ?? key;
      const seen = claimed.get(base) ?? 0;
      claimed.set(base, seen + 1);
      if (seen === 0) {
        this.names.set(key, base);
        continue;
      }
      const suffixed = `${base}_${seen + 1}`;
      this.names.set(key, suffixed);
      this.report(
        "schema_def_name_disambiguated",
        `Types '${key}' and another type share the simple name '${base}'; this one is emitted as '${suffixed}'.`,
      );
    }
  }

  private report(code: SchemaDiagnosticCode, message: string): void {
    this.diagnostics.push({ code, message });
  }

  write(): SimplifiedSchema {
    const schema = this.node(this.shape.root, 0, true);
    for (const key of [...this.hoisted].sort(ordinal)) {
      this.defs.set(key, this.body(key, 0));
    }
    if (this.defs.size > 0) {
      const bag: Record<string, JsonSchemaObject> = {};
      for (const key of [...this.defs.keys()].sort((left, right) =>
        ordinal(
          this.names.get(left) as string,
          this.names.get(right) as string,
        ),
      )) {
        bag[this.names.get(key) as string] = this.defs.get(
          key,
        ) as JsonSchemaObject;
      }
      schema.$defs = bag;
    }
    return { schema, diagnostics: this.diagnostics };
  }

  private truncated(depth: number): boolean {
    return this.maxDepth !== undefined && depth >= this.maxDepth;
  }

  private node(
    node: TypeNode,
    depth: number,
    rootInline = false,
  ): JsonSchemaObject {
    switch (node.kind) {
      case "verbatim":
        return structuredClone(node.schema ?? {});
      case "binary":
        return { type: "string", contentEncoding: "base64" };
      case "scalar": {
        const schema: JsonSchemaObject = { type: node.scalar ?? "string" };
        if (node.format !== undefined) {
          schema.format = node.format;
        }
        return schema;
      }
      case "enum": {
        if (node.enumFacts === undefined) {
          this.report("unreadable_shape", "An enum node carries no members.");
          return opaque();
        }
        return enumSchema(node.enumFacts);
      }
      case "map":
        return this.map(node, depth);
      case "array":
        return {
          type: "array",
          items:
            node.items === undefined
              ? opaque()
              : this.descend(node.items, depth),
        };
      case "ref":
        return this.ref(node, depth, rootInline);
      default:
        this.report(
          "unreadable_shape",
          node.reason ??
            "The binding layer could not read this type; the shape is unknown.",
        );
        return opaque();
    }
  }

  private descend(node: TypeNode, depth: number): JsonSchemaObject {
    if (this.truncated(depth + 1)) {
      this.report(
        "schema_depth_truncated",
        `The configured depth budget of ${String(this.maxDepth)} cut the shape here.`,
      );
      return opaque();
    }
    return this.node(node, depth + 1);
  }

  private map(node: TypeNode, depth: number): JsonSchemaObject {
    if (node.keys !== undefined && !node.keys.writable) {
      this.report(
        "unsupported_dictionary_key",
        "The serializer cannot write this map's key type as a JSON property name; the value shape was dropped.",
      );
      return opaque();
    }
    const schema: JsonSchemaObject = {
      type: "object",
      additionalProperties:
        node.values === undefined ? opaque() : this.descend(node.values, depth),
    };
    const keys = node.keys === undefined ? undefined : propertyNames(node.keys);
    if (keys !== undefined) {
      schema.propertyNames = keys;
    }
    return schema;
  }

  private ref(
    node: TypeNode,
    depth: number,
    rootInline: boolean,
  ): JsonSchemaObject {
    const key = node.ref;
    if (key === undefined) {
      this.report("unreadable_shape", "A ref node carries no target.");
      return opaque();
    }
    if (!rootInline && this.hoisted.has(key)) {
      return { $ref: `#/$defs/${this.names.get(key) as string}` };
    }
    return this.body(key, depth);
  }

  private selected(declared: ObjectType): readonly Member[] {
    return declared.members.filter(
      (member) =>
        !(
          this.dropReadOnly &&
          member.readOnly &&
          !member.constructorBound &&
          !populatable(member.type)
        ),
    );
  }

  private body(key: string, depth: number): JsonSchemaObject {
    const declared = this.shape.types[key];
    if (declared === undefined) {
      this.report("unreadable_shape", `No type is declared for '${key}'.`);
      return opaque();
    }
    return this.object(declared, depth);
  }

  private object(declared: ObjectType, depth: number): JsonSchemaObject {
    const members = this.selected(declared);
    if (declared.wrapper === true && members.length === 1) {
      const only = members[0] as Member;
      const unwrapped = this.node(only.type, depth);
      applyConstraints(unwrapped, only.description, only.constraints);
      return only.nullable === true ? admittingNull(unwrapped) : unwrapped;
    }

    const properties: Record<string, JsonSchemaObject> = {};
    const required: string[] = [];

    for (const member of members) {
      const schema = this.descend(member.type, depth);
      applyConstraints(schema, member.description, member.constraints);
      properties[member.name] =
        member.nullable === true ? admittingNull(schema) : schema;
      if (member.required) {
        required.push(member.name);
      }
    }

    const schema: JsonSchemaObject = { type: "object", properties };
    if (required.length > 0) {
      schema.required = required;
    }
    return schema;
  }
}

export function simplifySchema(
  shape: TypeShape,
  options: SchemaSimplificationOptions = {},
): SimplifiedSchema {
  return new Writer(shape, options).write();
}
