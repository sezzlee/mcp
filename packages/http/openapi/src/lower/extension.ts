import {
  canonicalJson,
  declaredSchemaProblem,
  isRevisionNumber,
  type ArgumentCuration,
  type ArgumentFill,
  type EndpointDescriptor,
  type FamilyDeclaration,
  type FamilyKey,
  type FamilyMember,
  type JsonSchemaObject,
  type OperationExtension,
  type ParameterSchema,
  type SelectionDecision,
  type ToolAnnotations,
  type ToolVariant,
  type VariantRequestBody,
} from "@sezzlee/core";
import { OperationDropped } from "../diagnostics.js";
import { childPointer, type JsonPointer } from "../ir/brand.js";
import {
  entriesOf,
  isObject,
  type JsonObject,
  type JsonValue,
} from "../ir/json.js";
import { normalizeSlot, type SchemaContext } from "../normalize/schema.js";

export const extensionKey = "x-sezzlee";
const legacySearchTerms = "x-sezzlee-search-terms";
const legacyRevision = "x-sezzlee-revision";
const upgraderMark = "x-sezzlee-dropped";

const operationKeys: ReadonlySet<string> = new Set([
  extensionKey,
  legacySearchTerms,
  legacyRevision,
  upgraderMark,
]);
const scopeKeys: ReadonlySet<string> = new Set([extensionKey, legacyRevision]);

const toolNamePattern = /^[a-z][a-z0-9_]{0,255}$/;
const argumentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const annotationHints = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
] as const;

type Curation = Pick<
  EndpointDescriptor,
  | "toolName"
  | "containerPrefix"
  | "description"
  | "tags"
  | "annotations"
  | "arguments"
  | "variants"
  | "family"
  | "searchTerms"
>;

export type CarriedSchemas = Pick<
  OperationExtension,
  "parameters" | "requestBody" | "responses"
>;

export interface LoweredExtension {
  readonly selection?: SelectionDecision;
  readonly curation: Curation;
  readonly schemas: CarriedSchemas;
  readonly anonymous?: true;
  readonly foldedInto?: string;
  readonly revision?: number;
}

class Invalid extends Error {
  constructor(
    readonly at: JsonPointer,
    message: string,
  ) {
    super(message);
  }
}

type SchemaReader = (
  value: JsonValue | undefined,
  at: JsonPointer,
  direction: "request" | "response",
) => JsonSchemaObject;

interface Field {
  readonly context: SchemaContext;
  readonly read: SchemaReader;
  readonly value: JsonValue;
  readonly at: JsonPointer;
}

function objectAt(value: JsonValue, at: JsonPointer, what: string): JsonObject {
  if (!isObject(value)) {
    throw new Invalid(at, `${what} must be an object`);
  }
  return value;
}

function onlyKeys(
  value: JsonObject,
  at: JsonPointer,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new Invalid(
      childPointer(at, unknown),
      `'${unknown}' is not a field here; expected one of ${allowed.join(", ")}`,
    );
  }
}

function nonBlank(value: JsonValue | undefined, at: JsonPointer): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Invalid(at, "must be a non-empty string");
  }
  return value;
}

function toolName(value: JsonValue | undefined, at: JsonPointer): string {
  if (typeof value !== "string" || !toolNamePattern.test(value)) {
    throw new Invalid(at, `must match ${toolNamePattern.source}`);
  }
  return value;
}

function parseAnnotations(value: JsonValue, at: JsonPointer): ToolAnnotations {
  const declared = objectAt(value, at, "annotations");
  onlyKeys(declared, at, annotationHints);
  const annotations: { -readonly [K in keyof ToolAnnotations]: boolean } = {};
  for (const hint of annotationHints) {
    const hintValue = declared[hint];
    if (hintValue === undefined) {
      continue;
    }
    if (typeof hintValue !== "boolean") {
      throw new Invalid(childPointer(at, hint), "must be a boolean");
    }
    annotations[hint] = hintValue;
  }
  return annotations;
}

function parseFill(value: JsonValue, at: JsonPointer): ArgumentFill {
  const fill = objectAt(value, at, "hidden");
  switch (fill["kind"]) {
    case "constant":
      onlyKeys(fill, at, ["kind", "value"]);
      if (!("value" in fill)) {
        throw new Invalid(at, "a constant fill needs a value");
      }
      return { kind: "constant", value: fill["value"] };
    case "deferred":
      onlyKeys(fill, at, ["kind", "source"]);
      return {
        kind: "deferred",
        source: nonBlank(fill["source"], childPointer(at, "source")),
      };
    case "omit":
      onlyKeys(fill, at, ["kind"]);
      return { kind: "omit" };
    default:
      throw new Invalid(
        childPointer(at, "kind"),
        "must be one of constant, deferred, omit",
      );
  }
}

function parseArgument(value: JsonValue, at: JsonPointer): ArgumentCuration {
  const declared = objectAt(value, at, "an argument");
  onlyKeys(declared, at, ["name", "as", "description", "hidden"]);
  const as = declared["as"];
  if (
    as !== undefined &&
    (typeof as !== "string" || !argumentNamePattern.test(as))
  ) {
    throw new Invalid(
      childPointer(at, "as"),
      `must match ${argumentNamePattern.source}`,
    );
  }
  const description = declared["description"];
  const hidden = declared["hidden"];
  return {
    name: nonBlank(declared["name"], childPointer(at, "name")),
    ...(as === undefined ? {} : { as }),
    ...(description === undefined
      ? {}
      : {
          description: nonBlank(description, childPointer(at, "description")),
        }),
    ...(hidden === undefined
      ? {}
      : { hidden: parseFill(hidden, childPointer(at, "hidden")) }),
  };
}

function parseArguments(
  value: JsonValue | undefined,
  at: JsonPointer,
): ArgumentCuration[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Invalid(at, "arguments must be an array");
  }
  const seen = new Set<string>();
  return value.map((raw: JsonValue, index: number) => {
    const argument = parseArgument(raw, childPointer(at, index));
    if (seen.has(argument.name)) {
      throw new Invalid(
        childPointer(at, index, "name"),
        `'${argument.name}' is curated twice`,
      );
    }
    seen.add(argument.name);
    return argument;
  });
}

function parseRequestBody(
  read: SchemaReader,
  value: JsonValue | undefined,
  at: JsonPointer,
): VariantRequestBody | undefined {
  if (value === undefined) {
    return undefined;
  }
  const declared = objectAt(value, at, "requestBody");
  onlyKeys(declared, at, ["schema", "required", "description"]);
  const schema = read(
    declared["schema"],
    childPointer(at, "schema"),
    "request",
  );
  const required = declared["required"];
  if (required !== undefined && typeof required !== "boolean") {
    throw new Invalid(childPointer(at, "required"), "must be a boolean");
  }
  const description = declared["description"];
  if (description !== undefined && typeof description !== "string") {
    throw new Invalid(childPointer(at, "description"), "must be a string");
  }
  return {
    schema,
    ...(required === undefined ? {} : { required }),
    ...(description === undefined ? {} : { description }),
  };
}

const parameterLocations: ReadonlySet<string> = new Set([
  "path",
  "query",
  "header",
  "cookie",
  "querystring",
]);

function documentSchemas(context: SchemaContext): SchemaReader {
  return (value, at, direction) => {
    if (!isObject(value)) {
      throw new Invalid(at, "must be a Schema Object");
    }
    let schema: JsonSchemaObject;
    try {
      schema = normalizeSlot(context, value, at, {
        direction,
        root: "preferred",
      });
    } catch (error) {
      if (!(error instanceof OperationDropped)) {
        throw error;
      }
      throw new Invalid(error.at, `cannot be carried (${error.message})`);
    }
    return selfContained(schema, at);
  };
}

/**
 * Guard: a published schema skips normalization, so it is held to the one property normalization
 * would otherwise have produced: every `$ref` resolves within its own `$defs`. A reference into the
 * document's `components` would be left aimed at nothing in the tool's schema.
 */
const publishedSchema: SchemaReader = (value, at) => {
  if (!isObject(value)) {
    throw new Invalid(at, "must be a Schema Object");
  }
  return selfContained(structuredClone(value) as JsonSchemaObject, at);
};

function selfContained(
  schema: JsonSchemaObject,
  at: JsonPointer,
): JsonSchemaObject {
  const problem = declaredSchemaProblem(schema);
  if (problem !== undefined) {
    throw new Invalid(at, problem);
  }
  return schema;
}

function optionalString(
  declared: JsonObject,
  field: string,
  at: JsonPointer,
): { readonly description?: string } {
  const value = declared[field];
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "string") {
    throw new Invalid(childPointer(at, field), "must be a string");
  }
  return { description: value };
}

function parseParameters({ read, value, at }: Field): ParameterSchema[] {
  if (!Array.isArray(value)) {
    throw new Invalid(at, "parameters must be an array");
  }
  const seen = new Set<string>();
  return value.map((raw: JsonValue, index: number) => {
    const parameterAt = childPointer(at, index);
    const declared = objectAt(raw, parameterAt, "a parameter");
    onlyKeys(declared, parameterAt, [
      "name",
      "in",
      "required",
      "schema",
      "description",
    ]);
    const name = nonBlank(declared["name"], childPointer(parameterAt, "name"));
    const location = declared["in"];
    if (typeof location !== "string" || !parameterLocations.has(location)) {
      throw new Invalid(
        childPointer(parameterAt, "in"),
        `must be one of ${[...parameterLocations].join(", ")}`,
      );
    }
    const required = declared["required"];
    if (typeof required !== "boolean") {
      throw new Invalid(
        childPointer(parameterAt, "required"),
        "must be a boolean",
      );
    }
    if (seen.has(`${location} ${name}`)) {
      throw new Invalid(
        parameterAt,
        `'${name}' in ${location} is declared twice`,
      );
    }
    seen.add(`${location} ${name}`);
    return {
      name,
      in: location as ParameterSchema["in"],
      required,
      schema: read(
        declared["schema"],
        childPointer(parameterAt, "schema"),
        "request",
      ),
      ...optionalString(declared, "description", parameterAt),
    };
  });
}

const responseStatus = /^([1-5][0-9]{2}|[1-5]XX|default)$/;

function parseResponses({
  read,
  value,
  at,
}: Field): NonNullable<OperationExtension["responses"]> {
  const declared = objectAt(value, at, "responses");
  return Object.fromEntries(
    entriesOf(declared).map(([status, raw]) => {
      const responseAt = childPointer(at, status);
      if (!responseStatus.test(status)) {
        throw new Invalid(responseAt, "is not a response status");
      }
      const response = objectAt(raw, responseAt, "a response");
      onlyKeys(response, responseAt, ["schema", "description"]);
      return [
        status,
        {
          ...(response["schema"] === undefined
            ? {}
            : {
                schema: read(
                  response["schema"],
                  childPointer(responseAt, "schema"),
                  "response",
                ),
              }),
          ...optionalString(response, "description", responseAt),
        },
      ];
    }),
  );
}

function parseVariant(
  read: SchemaReader,
  value: JsonValue,
  at: JsonPointer,
): ToolVariant {
  const declared = objectAt(value, at, "a variant");
  onlyKeys(declared, at, [
    "name",
    "description",
    "arguments",
    "requestBody",
    "annotations",
  ]);
  const args = parseArguments(
    declared["arguments"],
    childPointer(at, "arguments"),
  );
  const requestBody = parseRequestBody(
    read,
    declared["requestBody"],
    childPointer(at, "requestBody"),
  );
  const annotations = declared["annotations"];
  return {
    name: toolName(declared["name"], childPointer(at, "name")),
    description: nonBlank(
      declared["description"],
      childPointer(at, "description"),
    ).trim(),
    ...(args === undefined ? {} : { arguments: args }),
    ...(requestBody === undefined ? {} : { requestBody }),
    ...(annotations === undefined
      ? {}
      : {
          annotations: parseAnnotations(
            annotations,
            childPointer(at, "annotations"),
          ),
        }),
  };
}

function parseVariants({
  read,
  value,
  at,
}: Field): [ToolVariant, ...ToolVariant[]] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Invalid(at, "variants must be a non-empty array");
  }
  const seen = new Set<string>();
  const [first, ...rest] = value.map((raw: JsonValue, index: number) => {
    const variant = parseVariant(read, raw, childPointer(at, index));
    if (seen.has(variant.name)) {
      throw new Invalid(
        childPointer(at, index, "name"),
        `another variant is already named '${variant.name}'`,
      );
    }
    seen.add(variant.name);
    return variant;
  });
  if (first === undefined) {
    throw new Invalid(at, "variants must be a non-empty array");
  }
  return [first, ...rest];
}

function familyKey(value: JsonValue | undefined, at: JsonPointer): FamilyKey {
  if (typeof value === "string" && value !== "") {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  throw new Invalid(at, "must be a non-empty string or an integer");
}

function parseMember(
  read: SchemaReader,
  value: JsonValue,
  at: JsonPointer,
  parameter: string,
): FamilyMember {
  const declared = objectAt(value, at, "a member");
  const key = familyKey(declared["key"], childPointer(at, "key"));
  const { key: _key, ...variantFields } = declared;
  const variant = parseVariant(read, variantFields, at);
  if (variant.arguments?.some((argument) => argument.name === parameter)) {
    throw new Invalid(
      childPointer(at, "arguments"),
      `curates the dispatch parameter '${parameter}', which the key fills`,
    );
  }
  return { key, ...variant };
}

/**
 * Guard: a defect in one member drops that member alone, because members are host data and one
 * bad row must not take every sibling offline; only a defect in the declaration itself drops the
 * operation, so the uncurated dispatcher is never published in the family's place.
 */
function parseFamily({ context, read, value, at }: Field): FamilyDeclaration {
  const declared = objectAt(value, at, "family");
  onlyKeys(declared, at, ["parameter", "members"]);
  const parameter = nonBlank(
    declared["parameter"],
    childPointer(at, "parameter"),
  ).trim();
  const members = declared["members"];
  if (!Array.isArray(members)) {
    throw new Invalid(childPointer(at, "members"), "must be an array");
  }
  const names = new Set<string>();
  const keys = new Set<string>();
  const accepted: FamilyMember[] = [];
  for (const [index, raw] of members.entries()) {
    const memberAt = childPointer(at, "members", index);
    const label =
      isObject(raw) && typeof raw["name"] === "string"
        ? raw["name"]
        : `#${index}`;
    try {
      const member = parseMember(read, raw, memberAt, parameter);
      if (names.has(member.name)) {
        throw new Invalid(memberAt, "another member has the same name");
      }
      if (keys.has(canonicalJson(member.key))) {
        throw new Invalid(memberAt, "its key repeats another member's");
      }
      names.add(member.name);
      keys.add(canonicalJson(member.key));
      accepted.push(member);
    } catch (error) {
      if (!(error instanceof Invalid)) {
        throw error;
      }
      context.diagnostics.report(
        "family_member_rejected",
        error.at,
        `Member '${label}' is dropped: ${error.message}.`,
      );
    }
  }
  return { parameter, members: accepted };
}

function parseSearchTerms({ context, value, at }: Field): string[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every((term: JsonValue) => typeof term === "string")
  ) {
    context.diagnostics.report(
      "search_terms_invalid",
      at,
      "Search terms must be an array of strings; the operation carries no search terms.",
    );
    return undefined;
  }
  const terms = value.filter((term: string) => term.trim() !== "");
  return terms.length === 0 ? undefined : terms;
}

function parseDescription({ context, value, at }: Field): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    context.diagnostics.report(
      "description_invalid",
      at,
      "A description must be a non-empty string; the operation keeps the one its summary and description give.",
    );
    return undefined;
  }
  return value.trim();
}

function parseTags({ context, value, at }: Field): string[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every((tag: JsonValue) => typeof tag === "string")
  ) {
    context.diagnostics.report(
      "tags_invalid",
      at,
      "Tags must be an array of strings; the operation keeps its own tags.",
    );
    return undefined;
  }
  return value.filter((tag: string) => tag.trim() !== "");
}

const operationKeyPattern = /^[A-Z]+ \//;

function parseFoldedInto({ context, value, at }: Field): string | undefined {
  if (typeof value !== "string" || !operationKeyPattern.test(value)) {
    context.diagnostics.report(
      "extension_fold_unmatched",
      at,
      "foldedInto must name an operation as METHOD /path; the route is not carried as an alternate route.",
    );
    return undefined;
  }
  return value;
}

function parseRevision({ context, value, at }: Field): number | undefined {
  if (!isRevisionNumber(value)) {
    context.diagnostics.report(
      "revision_invalid",
      at,
      "A revision must be a whole number from 1; it is not carried.",
    );
    return undefined;
  }
  return value;
}

type ExtensionFields = Required<OperationExtension>;

type FieldParsers = {
  readonly [K in keyof ExtensionFields]: (
    field: Field,
  ) => ExtensionFields[K] | undefined;
};

const fieldParsers: FieldParsers = {
  tool: ({ value, at }) => {
    if (typeof value !== "boolean") {
      throw new Invalid(at, "must be a boolean");
    }
    return value;
  },
  foldedInto: parseFoldedInto,
  toolName: ({ value, at }) => toolName(value, at),
  containerPrefix: ({ value, at }) => nonBlank(value, at),
  description: parseDescription,
  tags: parseTags,
  parameters: parseParameters,
  requestBody: ({ read, value, at }) => parseRequestBody(read, value, at),
  publishedSchemas: ({ value, at }) => {
    if (typeof value !== "boolean") {
      throw new Invalid(at, "must be a boolean");
    }
    return value;
  },
  responses: parseResponses,
  annotations: ({ value, at }) => parseAnnotations(value, at),
  anonymous: ({ value, at }) => {
    if (value !== true) {
      throw new Invalid(at, "must be true");
    }
    return value;
  },
  arguments: ({ value, at }) => parseArguments(value, at),
  variants: parseVariants,
  family: parseFamily,
  searchTerms: parseSearchTerms,
  revision: parseRevision,
};

const extensionFields = Object.keys(fieldParsers);

function aliasOf(
  context: SchemaContext,
  operation: JsonObject,
  at: JsonPointer,
  declared: JsonObject,
  field: "searchTerms" | "revision",
  legacy: string,
): Field | undefined {
  const legacyValue = operation[legacy];
  const value = declared[field];
  const read = documentSchemas(context);
  if (legacyValue === undefined) {
    return value === undefined
      ? undefined
      : { context, read, value, at: childPointer(at, extensionKey, field) };
  }
  if (
    value !== undefined &&
    canonicalJson(value) !== canonicalJson(legacyValue)
  ) {
    context.diagnostics.report(
      "extension_conflict",
      childPointer(at, legacy),
      `${legacy} and ${extensionKey}.${field} disagree; neither is carried.`,
    );
    return undefined;
  }
  return { context, read, value: legacyValue, at: childPointer(at, legacy) };
}

const legacyOf: Readonly<Record<string, string>> = {
  searchTerms: legacySearchTerms,
  revision: legacyRevision,
};

/**
 * Lays a host's configured `x-sezzlee` fields over the operation's own, field by field: a field
 * the config names replaces the document's whole value, including its legacy spelling, and every
 * replaced value that differed is reported as `extension_overridden`.
 *
 * @param overlay the config's entry for this operation, not yet validated; it is parsed with the
 * document's fields, so a body schema in it may reference the document's components
 */
export function overlayExtension(
  context: SchemaContext,
  operation: JsonObject,
  at: JsonPointer,
  overlay: JsonObject,
): JsonObject {
  const declared = operation[extensionKey];
  if (declared !== undefined && !isObject(declared)) {
    return operation;
  }
  const base = declared ?? {};
  const effective: { [key: string]: JsonValue | undefined } = { ...operation };
  for (const [field, value] of Object.entries(overlay)) {
    const legacy = legacyOf[field];
    const replaced = [
      { value: base[field], at: childPointer(at, extensionKey, field) },
      ...(legacy === undefined
        ? []
        : [{ value: operation[legacy], at: childPointer(at, legacy) }]),
    ];
    for (const previous of replaced) {
      if (
        previous.value !== undefined &&
        canonicalJson(previous.value) !== canonicalJson(value)
      ) {
        context.diagnostics.report(
          "extension_overridden",
          previous.at,
          `The config's ${extensionKey}.${field} replaces the document's.`,
        );
      }
    }
    if (legacy !== undefined) {
      delete effective[legacy];
    }
  }
  effective[extensionKey] = { ...base, ...overlay };
  return effective;
}

function unknownSezzleeKey(
  holder: JsonObject,
  allowed: ReadonlySet<string>,
): string | undefined {
  return Object.keys(holder).find(
    (key) => key.startsWith("x-sezzlee") && !allowed.has(key),
  );
}

function dropped(at: JsonPointer, message: string): OperationDropped {
  return new OperationDropped(
    "extension_invalid",
    at,
    `${message}; the operation is not published.`,
  );
}

function parseExtension(
  context: SchemaContext,
  operation: JsonObject,
  at: JsonPointer,
): OperationExtension {
  const unknown = unknownSezzleeKey(operation, operationKeys);
  if (unknown !== undefined) {
    throw dropped(
      childPointer(at, unknown),
      `'${unknown}' is not a sezzlee extension; curation moved to ${extensionKey}`,
    );
  }
  const raw = operation[extensionKey] ?? {};
  const extensionAt = childPointer(at, extensionKey);
  if (!isObject(raw)) {
    throw dropped(extensionAt, `${extensionKey} must be an object`);
  }
  const extra = Object.keys(raw).find((key) => !extensionFields.includes(key));
  if (extra !== undefined) {
    throw dropped(
      childPointer(extensionAt, extra),
      `'${extra}' is not a field of ${extensionKey}`,
    );
  }
  if (raw["variants"] !== undefined && raw["family"] !== undefined) {
    throw dropped(
      extensionAt,
      `${extensionKey} declares both variants and a family; a family's members are its variants`,
    );
  }
  const siteOf = (field: string, read: SchemaReader): Field | undefined => {
    const value = raw[field];
    return value === undefined
      ? undefined
      : { context, read, value, at: childPointer(extensionAt, field) };
  };
  const searchTerms = aliasOf(
    context,
    operation,
    at,
    raw,
    "searchTerms",
    legacySearchTerms,
  );
  const revision = aliasOf(
    context,
    operation,
    at,
    raw,
    "revision",
    legacyRevision,
  );
  const parse = <K extends keyof ExtensionFields>(
    field: K,
    site: Field | undefined,
  ): ExtensionFields[K] | undefined => {
    if (site === undefined) {
      return undefined;
    }
    try {
      const parser: FieldParsers[K] = fieldParsers[field];
      return parser(site);
    } catch (error) {
      if (!(error instanceof Invalid)) {
        throw error;
      }
      throw dropped(error.at, `${extensionKey}.${field} ${error.message}`);
    }
  };
  const extension: {
    -readonly [K in keyof OperationExtension]: OperationExtension[K];
  } = {};
  const documentReader = documentSchemas(context);
  const published = parse(
    "publishedSchemas",
    siteOf("publishedSchemas", documentReader),
  );
  const read = published === true ? publishedSchema : documentReader;
  const fieldAt = (field: string): Field | undefined => siteOf(field, read);
  assign(extension, "publishedSchemas", published);
  assign(extension, "tool", parse("tool", fieldAt("tool")));
  assign(extension, "foldedInto", parse("foldedInto", fieldAt("foldedInto")));
  assign(extension, "toolName", parse("toolName", fieldAt("toolName")));
  assign(
    extension,
    "containerPrefix",
    parse("containerPrefix", fieldAt("containerPrefix")),
  );
  assign(
    extension,
    "description",
    parse("description", fieldAt("description")),
  );
  assign(extension, "tags", parse("tags", fieldAt("tags")));
  assign(extension, "parameters", parse("parameters", fieldAt("parameters")));
  assign(
    extension,
    "requestBody",
    parse("requestBody", fieldAt("requestBody")),
  );
  assign(extension, "responses", parse("responses", fieldAt("responses")));
  assign(
    extension,
    "annotations",
    parse("annotations", fieldAt("annotations")),
  );
  assign(extension, "anonymous", parse("anonymous", fieldAt("anonymous")));
  assign(extension, "arguments", parse("arguments", fieldAt("arguments")));
  assign(extension, "variants", parse("variants", fieldAt("variants")));
  assign(extension, "family", parse("family", fieldAt("family")));
  assign(extension, "searchTerms", parse("searchTerms", searchTerms));
  assign(extension, "revision", parse("revision", revision));
  return extension;
}

function assign<K extends keyof ExtensionFields>(
  target: { -readonly [P in keyof OperationExtension]: OperationExtension[P] },
  field: K,
  value: ExtensionFields[K] | undefined,
): void {
  if (value !== undefined) {
    target[field] = value;
  }
}

function memberVariant(parameter: string, member: FamilyMember): ToolVariant {
  const { key, arguments: curated, ...variant } = member;
  return {
    ...variant,
    arguments: [
      { name: parameter, hidden: { kind: "constant", value: key } },
      ...(curated ?? []),
    ],
  };
}

function familyCuration(family: FamilyDeclaration): Curation {
  const [first, ...rest] = family.members.map((member) =>
    memberVariant(family.parameter, member),
  );
  return {
    family: { parameter: family.parameter },
    ...(first === undefined ? {} : { variants: [first, ...rest] }),
  };
}

/**
 * Lowers an operation's `x-sezzlee` extension, and the legacy `x-sezzlee-search-terms` and
 * `x-sezzlee-revision` spellings, into descriptor curation and its selection marker.
 *
 * Guard: an unknown `x-sezzlee-*` key drops the operation instead of being ignored. A document
 * still written for a removed spelling would otherwise publish the very operation its curation
 * was meant to hide or split, with nothing in the catalog to show it.
 *
 * @throws OperationDropped `extension_invalid` when a field that narrows what is published cannot
 * be carried
 */
export function lowerExtension(
  context: SchemaContext,
  operation: JsonObject,
  at: JsonPointer,
): LoweredExtension {
  const extension = parseExtension(context, operation, at);
  const {
    tool,
    revision,
    family,
    parameters,
    requestBody,
    responses,
    anonymous,
    foldedInto,
    publishedSchemas: _publishedSchemas,
    ...fields
  } = extension;
  return {
    ...(tool === undefined ? {} : { selection: tool ? "include" : "exclude" }),
    curation: {
      ...fields,
      ...(family === undefined ? {} : familyCuration(family)),
    },
    schemas: {
      ...(parameters === undefined ? {} : { parameters }),
      ...(requestBody === undefined ? {} : { requestBody }),
      ...(responses === undefined ? {} : { responses }),
    },
    ...(anonymous === undefined ? {} : { anonymous }),
    ...(foldedInto === undefined ? {} : { foldedInto }),
    ...(revision === undefined ? {} : { revision }),
  };
}

/**
 * Reads the revision a path item or the document root declares, in `x-sezzlee` or the legacy
 * `x-sezzlee-revision`.
 *
 * @throws OperationDropped `extension_invalid` when the scope carries an extension it cannot; every
 * operation beneath it is dropped, since the declaration may have meant to narrow them
 */
export function scopeRevisionOf(
  context: SchemaContext,
  holder: JsonObject,
  at: JsonPointer,
): number | undefined {
  const unknown = unknownSezzleeKey(holder, scopeKeys);
  if (unknown !== undefined) {
    throw new OperationDropped(
      "extension_invalid",
      childPointer(at, unknown),
      `'${unknown}' is not a sezzlee extension here; every operation beneath it is not published.`,
    );
  }
  const raw = holder[extensionKey];
  if (raw !== undefined) {
    const extensionAt = childPointer(at, extensionKey);
    if (
      !isObject(raw) ||
      Object.keys(raw).some((key) => key !== "revision") ||
      raw["revision"] === undefined
    ) {
      throw new OperationDropped(
        "extension_invalid",
        extensionAt,
        `${extensionKey} here may carry only a revision; every operation beneath it is not published.`,
      );
    }
  }
  const site = aliasOf(
    context,
    holder,
    at,
    isObject(raw) ? raw : {},
    "revision",
    legacyRevision,
  );
  return site === undefined ? undefined : parseRevision(site);
}
