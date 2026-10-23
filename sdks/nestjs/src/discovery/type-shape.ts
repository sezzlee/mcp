import { createRequire } from "node:module";
import type {
  Constraints,
  EnumFacts,
  Member,
  ObjectType,
  ScalarKind,
  TypeNode,
  TypeShape,
} from "@sezzlee/core";

import { asRecord, documentedType, resolveLazy } from "./swagger-metadata.js";

const load = createRequire(import.meta.url);

export interface TypeShapeDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface TypeShapeBinderOptions {
  readonly typeShape?: (
    target: NewableFunction,
  ) => TypeShape | TypeNode | undefined;
  readonly report?: (diagnostic: TypeShapeDiagnostic) => void;
  readonly serialization?: SerializationView;
}

/** How `ClassSerializerInterceptor` writes an instance: class-transformer's `classToPlain` options. */
export interface SerializationView {
  readonly strategy?: string;
  readonly excludeExtraneousValues?: boolean;
}

interface ValidationEntry {
  readonly propertyName: string;
  readonly type: string;
  readonly name?: string;
  readonly constraints?: readonly unknown[];
  readonly each?: boolean;
}

function scalar(kind: ScalarKind, format?: string): TypeNode {
  return format === undefined
    ? { kind: "scalar", scalar: kind }
    : { kind: "scalar", scalar: kind, format };
}

function unreadable(reason: string): TypeNode {
  return { kind: "unknown", reason };
}

const byConstructor = new Map<unknown, () => TypeNode>([
  [String, () => scalar("string")],
  [Number, () => scalar("number")],
  [Boolean, () => scalar("boolean")],
  [Date, () => scalar("string", "date-time")],
]);

export class NestTypeShapeBinder {
  private readonly types: Record<string, ObjectType> = {};
  private readonly keys = new Map<NewableFunction, string>();

  constructor(private readonly options: TypeShapeBinderOptions = {}) {}

  bind(target: unknown): TypeShape {
    return { root: this.node(target, undefined), types: this.types };
  }

  private node(target: unknown, owner: string | undefined): TypeNode {
    if (typeof target !== "function") {
      return unreadable(
        owner === undefined
          ? "No runtime type is available for this body."
          : `No runtime type is available for member '${owner}'.`,
      );
    }
    const declared = this.options.typeShape?.(target as NewableFunction);
    if (declared !== undefined) {
      return "root" in declared ? declared.root : declared;
    }
    const mapped = byConstructor.get(target);
    if (mapped !== undefined) {
      return mapped();
    }
    if (target === Array) {
      return {
        kind: "array",
        items: unreadable(
          "Array element type is erased at runtime; declare @Type(() => X).",
        ),
      };
    }
    if (target === Object) {
      return unreadable(
        "'Object' carries no readable shape; any JSON value is accepted.",
      );
    }
    return { kind: "ref", ref: this.declare(target as NewableFunction) };
  }

  private declare(target: NewableFunction): string {
    const existing = this.keys.get(target);
    if (existing !== undefined) {
      return existing;
    }
    const key = target.name;
    this.keys.set(target, key);
    this.types[key] = { name: target.name, members: [] };
    this.types[key] = { name: target.name, members: this.members(target) };
    return key;
  }

  private members(target: NewableFunction): Member[] {
    const validation = groupValidators(target);
    const documentation = documentedMembers(target);
    if (validation.size === 0 && documentation.size === 0) {
      this.options.report?.({
        code: "unreadable_shape",
        message: `'${target.name}' carries no class-validator or @nestjs/swagger metadata; its shape cannot be read. Decorate its properties, or declare options.schema.typeShape.`,
      });
      return [];
    }
    const members = interleave(
      [...validation.keys()],
      [...documentation.keys()],
    ).map((property) =>
      this.member(
        target,
        property,
        validation.get(property) ?? [],
        documentation.get(property),
      ),
    );
    return this.options.serialization === undefined
      ? members
      : this.serialized(target, members, this.options.serialization);
  }

  /**
   * The members `classToPlain` writes: what `@Exclude()` removes, what the strategy or
   * `excludeExtraneousValues` leaves out, what an `@Expose()` accessor adds, under the name
   * `@Expose({ name })` gives it.
   */
  private serialized(
    target: NewableFunction,
    members: readonly Member[],
    view: SerializationView,
  ): Member[] {
    const storage = transformStorage();
    if (storage === undefined) {
      return [...members];
    }
    const declared = storage.getStrategy(target);
    const strategy =
      declared === "none" ? (view.strategy ?? "exposeAll") : declared;
    const exposed = storage.getExposedProperties(target, classToPlain);
    const excluded = new Set(
      storage.getExcludedProperties(target, classToPlain),
    );
    const everything =
      strategy === "exposeAll" && view.excludeExtraneousValues !== true;
    const written = members.filter(
      (member) =>
        (everything || exposed.includes(member.name)) &&
        !excluded.has(member.name),
    );
    for (const name of exposed) {
      if (
        excluded.has(name) ||
        written.some((member) => member.name === name)
      ) {
        continue;
      }
      written.push({
        name,
        type: this.fromReflected(
          Reflect.getMetadata("design:type", target.prototype as object, name),
          name,
        ),
        required: false,
        readOnly: true,
        constructorBound: false,
      });
    }
    return written.map((member) => {
      const options = storage.findExposeMetadata(target, member.name)?.options;
      const renamed =
        options?.toClassOnly === true && options.toPlainOnly !== true
          ? undefined
          : options?.name;
      return renamed === undefined ? member : { ...member, name: renamed };
    });
  }

  /**
   * Validators describe what the pipe enforces, so they decide a member's type and whether it is
   * required wherever they speak; `@ApiProperty` fills only what they leave unsaid. A member
   * documented as optional but validated without `@IsOptional()` is rejected when it is missing,
   * so publishing it as optional would invite a call that fails.
   */
  private member(
    target: NewableFunction,
    property: string,
    entries: readonly ValidationEntry[],
    documented: DocumentedMember | undefined,
  ): Member {
    const nested = nestedType(target, property);
    const reflected = Reflect.getMetadata(
      "design:type",
      target.prototype as object,
      property,
    ) as unknown;

    const validated =
      nested === undefined ? this.fromValidators(entries) : undefined;
    const declared =
      nested === undefined &&
      validated === undefined &&
      documented !== undefined
        ? this.fromDocumentation(documented)
        : undefined;
    const inner =
      nested !== undefined
        ? this.node(nested, property)
        : (validated ?? declared ?? this.fromReflected(reflected, property));

    const listed =
      entries.some((entry) => entry.each === true) ||
      (validated === undefined &&
        (documented?.isArray === true ||
          (nested !== undefined && reflected === Array)));
    const type: TypeNode = listed ? { kind: "array", items: inner } : inner;
    const constraints = constraintsOf(entries, documented?.options);
    const description = documented?.options["description"];

    return {
      name: property,
      type,
      required:
        entries.length > 0
          ? !entries.some((entry) => entry.type === "conditionalValidation")
          : documented?.options["required"] !== false,
      readOnly: documented?.options["readOnly"] === true,
      constructorBound: false,
      ...(documented?.options["nullable"] === true ? { nullable: true } : {}),
      ...(typeof description === "string" && description.length > 0
        ? { description }
        : {}),
      ...(constraints === undefined ? {} : { constraints }),
    };
  }

  private fromValidators(
    entries: readonly ValidationEntry[],
  ): TypeNode | undefined {
    const enumFacts = enumFactsOf(entries);
    if (enumFacts !== undefined) {
      return { kind: "enum", enumFacts };
    }
    for (const entry of entries) {
      const mapped = validatorScalar(entry.name);
      if (mapped !== undefined) {
        return mapped;
      }
    }
    return undefined;
  }

  private fromDocumentation(
    documented: DocumentedMember,
  ): TypeNode | undefined {
    if (documented.values !== undefined) {
      const enumFacts = factsOf(documented.values, []);
      return enumFacts === undefined ? undefined : { kind: "enum", enumFacts };
    }
    const { type } = documented;
    if (typeof type === "string") {
      return documentedScalar(type, documented.options["format"]);
    }
    if (typeof type !== "function" || type === Object || type === Array) {
      return undefined;
    }
    return this.node(type, undefined);
  }

  private fromReflected(reflected: unknown, property: string): TypeNode {
    if (reflected !== undefined && reflected !== Array) {
      return this.node(reflected, property);
    }
    return unreadable(
      `Member '${property}' has no readable type; add a class-validator type decorator, @ApiProperty({ type }) or @Type(() => X).`,
    );
  }
}

interface DocumentedMember {
  readonly type: unknown;
  readonly isArray: boolean;
  readonly values?: readonly unknown[];
  readonly options: Readonly<Record<string, unknown>>;
}

const documentedProperties = "swagger/apiModelProperties";
const documentedPropertyList = "swagger/apiModelPropertiesArray";
const pluginMetadataFactory = "_OPENAPI_METADATA_FACTORY";

/**
 * Reads what `@nestjs/swagger` knows about a class's members without loading it: the metadata its
 * `@ApiProperty` decorators write, under the plugin's `_OPENAPI_METADATA_FACTORY`. The factory is
 * read directly because `@nestjs/swagger` folds it into the decorator metadata only while it builds
 * a document, which may never happen or happen after the catalog is built. A decorator wins over
 * the factory and a subclass over its base, as `@nestjs/swagger` merges them.
 */
function documentedMembers(
  target: NewableFunction,
): Map<string, DocumentedMember> {
  const merged = new Map<string, Record<string, unknown>>();
  for (const owner of lineageOf(target)) {
    const factory: unknown = Object.hasOwn(owner, pluginMetadataFactory)
      ? (owner as unknown as Record<string, unknown>)[pluginMetadataFactory]
      : undefined;
    if (typeof factory !== "function") {
      continue;
    }
    const declared: unknown = (factory as () => unknown).call(owner);
    for (const [name, options] of Object.entries(asRecord(declared) ?? {})) {
      merged.set(name, { ...merged.get(name), ...asRecord(options) });
    }
  }
  const listed: unknown = Reflect.getMetadata(
    documentedPropertyList,
    target.prototype as object,
  );
  for (const key of Array.isArray(listed) ? listed : []) {
    if (typeof key !== "string" || !key.startsWith(":")) {
      continue;
    }
    const name = key.slice(1);
    const decorated = asRecord(
      Reflect.getMetadata(
        documentedProperties,
        target.prototype as object,
        name,
      ),
    );
    merged.set(name, { ...merged.get(name), ...decorated });
  }
  return new Map(
    [...merged].map(([name, options]) => [name, documentedMember(options)]),
  );
}

function documentedMember(options: Record<string, unknown>): DocumentedMember {
  let { type, isArray } = documentedType(options["type"], options["isArray"]);
  let values = enumValuesOfDeclaration(options["enum"]);
  const items = asRecord(options["items"]);
  if (type === "array" && items !== undefined) {
    type = items["type"];
    values = enumValuesOfDeclaration(items["enum"]);
    isArray = true;
  }
  return {
    type,
    isArray,
    options,
    ...(values === undefined ? {} : { values }),
  };
}

function enumValuesOfDeclaration(
  declared: unknown,
): readonly unknown[] | undefined {
  const resolved = resolveLazy(declared);
  if (Array.isArray(resolved)) {
    return resolved as readonly unknown[];
  }
  const entity = asRecord(resolved);
  return entity === undefined
    ? undefined
    : namedValuesOf(entity).map(([, value]) => value);
}

function documentedScalar(type: string, format: unknown): TypeNode | undefined {
  switch (type) {
    case "string":
      return typeof format === "string" && format.length > 0
        ? scalar("string", format)
        : scalar("string");
    case "integer":
    case "number":
    case "boolean":
      return scalar(type);
    default:
      return undefined;
  }
}

function lineageOf(target: NewableFunction): NewableFunction[] {
  const lineage: NewableFunction[] = [];
  let current: unknown = target;
  while (typeof current === "function" && current !== Function.prototype) {
    lineage.unshift(current as NewableFunction);
    current = Object.getPrototypeOf(current);
  }
  return lineage;
}

/**
 * Merges two member lists that each follow declaration order but name different subsets of it, so
 * a member read from only one registry keeps its place among the others.
 */
function interleave(
  first: readonly string[],
  second: readonly string[],
): string[] {
  const merged: string[] = [];
  let next = 0;
  for (const name of second) {
    const at = first.indexOf(name);
    if (at >= next) {
      merged.push(...first.slice(next, at));
      next = at + 1;
    }
    if (!merged.includes(name)) {
      merged.push(name);
    }
  }
  merged.push(...first.slice(next).filter((name) => !merged.includes(name)));
  return merged;
}

/**
 * Reads the members a `@IsEnum` or `@IsIn` decorator allows.
 *
 * @returns the allowed values, or `undefined` when the decorator declares none this layer can read.
 */
function enumValuesOf(entry: ValidationEntry): readonly unknown[] | undefined {
  if (entry.name === "isIn") {
    const values = entry.constraints?.[0];
    return Array.isArray(values) ? (values as readonly unknown[]) : undefined;
  }
  if (entry.name !== "isEnum") {
    return undefined;
  }
  const declared = entry.constraints?.[1];
  if (Array.isArray(declared)) {
    return declared as readonly unknown[];
  }
  return memberEntriesOf(entry)?.map(([, value]) => value);
}

function memberEntriesOf(
  entry: ValidationEntry,
): [string, unknown][] | undefined {
  const entity = entry.constraints?.[0];
  if (typeof entity !== "object" || entity === null) {
    return undefined;
  }
  return namedValuesOf(entity);
}

function namedValuesOf(entity: object): [string, unknown][] {
  return Object.entries(entity).filter(([key]) =>
    Number.isNaN(Number.parseInt(key, 10)),
  );
}

/**
 * Derives {@link EnumFacts} from the first readable enum-shaped validator on a member.
 *
 * class-validator hands `@IsEnum` the enum object in `constraints[0]` and the already
 * reverse-mapping-filtered value list in `constraints[1]`; the second is what the schema needs, and
 * recomputing it from the first is only a fallback for a class-validator that predates it.
 *
 * A numeric enum resolves to the **integer** wire form even though `isEnum` also accepts the member
 * name at runtime (it validates against `Object.keys(entity).map(k => entity[k])`, which on a
 * numeric enum contains the names too). Reporting `unresolved` would publish an `anyOf` that invites
 * the agent to send `"Active"`, which passes validation and then compares unequal to `Status.Active`
 * everywhere in the handler. The narrower form is the honest one.
 *
 * @returns the facts, or `undefined` when no member list is readable or a value is not a string or
 * an integer — a float or an object cannot be written as a JSON Schema `enum` of a single type.
 */
function enumFactsOf(
  entries: readonly ValidationEntry[],
): EnumFacts | undefined {
  for (const entry of entries) {
    const values = enumValuesOf(entry);
    if (values === undefined) {
      continue;
    }
    const facts = factsOf(
      values,
      memberEntriesOf(entry)?.map(([key]) => key) ?? [],
    );
    if (facts !== undefined) {
      return facts;
    }
  }
  return undefined;
}

function factsOf(
  values: readonly unknown[],
  memberNames: readonly string[],
): EnumFacts | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const names = new Set<string>();
  const numbers = new Set<number>();
  for (const value of values) {
    if (typeof value === "string") {
      names.add(value);
    } else if (typeof value === "number" && Number.isInteger(value)) {
      numbers.add(value);
    } else {
      return undefined;
    }
  }
  if (names.size > 0 && numbers.size > 0) {
    return {
      wireForm: "unresolved",
      names: [...names],
      numbers: [...numbers],
    };
  }
  if (numbers.size > 0) {
    return {
      wireForm: "integer",
      names: [...memberNames],
      numbers: [...numbers],
    };
  }
  return { wireForm: "string", names: [...names], numbers: [] };
}

function validatorScalar(name: string | undefined): TypeNode | undefined {
  switch (name) {
    case "isString":
    case "isEmail":
    case "isUrl":
      return scalar("string");
    case "isInt":
      return scalar("integer");
    case "isNumber":
      return scalar("number");
    case "isBoolean":
      return scalar("boolean");
    case "isUuid":
      return scalar("string", "uuid");
    case "isDate":
    case "isDateString":
      return scalar("string", "date-time");
    default:
      return undefined;
  }
}

function constraintsOf(
  entries: readonly ValidationEntry[],
  documented: Readonly<Record<string, unknown>> = {},
): Constraints | undefined {
  const found: Record<string, unknown> = {};
  const number = (value: unknown): number | undefined =>
    typeof value === "number" ? value : undefined;

  for (const entry of entries) {
    const first = entry.constraints?.[0];
    switch (entry.name) {
      case "minLength":
      case "arrayMinSize":
        found["minSize"] = number(first) ?? found["minSize"];
        break;
      case "maxLength":
      case "arrayMaxSize":
        found["maxSize"] = number(first) ?? found["maxSize"];
        break;
      case "min":
        found["minimum"] = number(first) ?? found["minimum"];
        break;
      case "max":
        found["maximum"] = number(first) ?? found["maximum"];
        break;
      case "matches":
        if (first instanceof RegExp) {
          found["pattern"] = first.source;
        }
        break;
      case "isEmail":
        found["format"] = "email";
        break;
      case "isUrl":
        found["format"] = "uri";
        break;
      default:
        break;
    }
  }
  const documentedNumber = (...keys: string[]): number | undefined =>
    keys
      .map((key) => number(documented[key]))
      .find((value) => value !== undefined);
  found["minSize"] ??= documentedNumber("minLength", "minItems");
  found["maxSize"] ??= documentedNumber("maxLength", "maxItems");
  found["minimum"] ??= documentedNumber("minimum");
  found["maximum"] ??= documentedNumber("maximum");
  const pattern = documented["pattern"];
  found["pattern"] ??=
    pattern instanceof RegExp
      ? pattern.source
      : typeof pattern === "string"
        ? pattern
        : undefined;
  for (const key of Object.keys(found)) {
    if (found[key] === undefined) {
      delete found[key];
    }
  }
  return Object.keys(found).length === 0 ? undefined : (found as Constraints);
}

interface MetadataStorage {
  getTargetValidationMetadatas(
    target: NewableFunction,
    targetSchema: string,
    always: boolean,
    strictGroups: boolean,
  ): unknown[];
}

interface TransformStorage {
  findTypeMetadata(target: NewableFunction, property: string): unknown;
  findExposeMetadata(
    target: NewableFunction,
    property: string,
  ):
    | {
        readonly options?: {
          readonly name?: string;
          readonly toClassOnly?: boolean;
          readonly toPlainOnly?: boolean;
        };
      }
    | undefined;
  getStrategy(target: NewableFunction): string;
  getExposedProperties(target: NewableFunction, type: number): string[];
  getExcludedProperties(target: NewableFunction, type: number): string[];
}

const classToPlain = 1;

let validators: MetadataStorage | null | undefined;
let transforms: TransformStorage | null | undefined;

function groupValidators(
  target: NewableFunction,
): Map<string, ValidationEntry[]> {
  const grouped = new Map<string, ValidationEntry[]>();
  if (validators === undefined) {
    try {
      validators = (
        load("class-validator") as {
          getMetadataStorage: () => MetadataStorage;
        }
      ).getMetadataStorage();
    } catch {
      validators = null;
    }
  }
  if (validators === null) {
    return grouped;
  }
  const entries = validators.getTargetValidationMetadatas(
    target,
    target.name,
    true,
    false,
  ) as ValidationEntry[];
  for (const entry of entries) {
    const list = grouped.get(entry.propertyName);
    if (list === undefined) {
      grouped.set(entry.propertyName, [entry]);
    } else {
      list.push(entry);
    }
  }
  return grouped;
}

function transformStorage(): TransformStorage | undefined {
  if (transforms === undefined) {
    try {
      transforms = (
        load("class-transformer/cjs/storage") as {
          defaultMetadataStorage: TransformStorage;
        }
      ).defaultMetadataStorage;
    } catch {
      transforms = null;
    }
  }
  return transforms ?? undefined;
}

function nestedType(
  target: NewableFunction,
  property: string,
): unknown | undefined {
  const metadata = transformStorage()?.findTypeMetadata(target, property) as
    { typeFunction?: () => unknown } | undefined;
  return metadata?.typeFunction?.();
}
