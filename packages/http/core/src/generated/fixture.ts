export type Fixture =
  | NamingFixture
  | MetadataExtractionFixture
  | ArgumentMappingFixture
  | SelectionFixture
  | VisibilityFixture
  | SearchFixture
  | RankedSearchFixture
  | ErrorMappingFixture
  | SchemaSimplificationFixture
  | CardFixture
  | DetailFixture
  | OpenApiIngestionFixture;
export type ArgumentFill = (
  | {
      kind: "constant";
      value: unknown;
      source?: never;
    }
  | {
      kind: "deferred";
      source: unknown;
      value?: never;
    }
  | {
      kind: "omit";
      value?: never;
      source?: never;
    }
) & {
  kind: ArgumentFillKind;
  value?: unknown;
  source?: string;
};
export type ArgumentFillKind = "constant" | "deferred" | "omit";
export type PrefixMode = "always" | "onCollision";
export type Anonymity = "yes" | "no" | "unknown";
export type ArgumentFill1 = (
  | {
      kind: "constant";
      value: unknown;
      source?: never;
    }
  | {
      kind: "deferred";
      source: unknown;
      value?: never;
    }
  | {
      kind: "omit";
      value?: never;
      source?: never;
    }
) & {
  kind: ArgumentFillKind;
  value?: unknown;
  source?: string;
};
export type ArgumentFill2 = (
  | {
      kind: "constant";
      value: unknown;
      source?: never;
    }
  | {
      kind: "deferred";
      source: unknown;
      value?: never;
    }
  | {
      kind: "omit";
      value?: never;
      source?: never;
    }
) & {
  kind: ArgumentFillKind;
  value?: unknown;
  source?: string;
};
export type ExpectedPart =
  | {
      name: string;
      value: string;
    }
  | {
      name: string;
      file: ExpectedFile;
    };
export type ExpectedFile =
  | {
      text: string;
      filename: string;
      mediaType: string;
    }
  | {
      base64: string;
      byteLength: number;
      filename: string;
      mediaType: string;
    }
  | {
      ref: string;
      filename?: string;
      mediaType?: string;
    };
export type ExpectedFile1 =
  | {
      text: string;
      filename: string;
      mediaType: string;
    }
  | {
      base64: string;
      byteLength: number;
      filename: string;
      mediaType: string;
    }
  | {
      ref: string;
      filename?: string;
      mediaType?: string;
    };
export type SdkErrorCode =
  | "unknown_tool"
  | "not_invocable"
  | "unknown_argument"
  | "invalid_path_type"
  | "missing_path_parameter"
  | "header_injection"
  | "null_not_allowed"
  | "invalid_type"
  | "deferred_value_missing"
  | "deferred_value_invalid"
  | "invalid_cookie_value"
  | "cookie_carrier_collision"
  | "invalid_file_argument"
  | "file_too_large"
  | "file_unresolved"
  | "response_too_large"
  | "invoke_timeout"
  | "search_ranker_unavailable"
  | "internal_error"
  | "tool_changed";
export type InvokeResult = InvokeSuccess | MappedError | SdkError;
export type BackendErrorCode =
  | "validation_failed"
  | "bad_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "backend_error"
  | "backend_unavailable";
export type PayloadShapeKind = "array" | "object" | "text";
export type TypeKind =
  | "scalar"
  | "binary"
  | "enum"
  | "map"
  | "array"
  | "ref"
  | "verbatim"
  | "unknown";
export type ScalarKind = "string" | "boolean" | "integer" | "number";
export type EnumWireForm = "string" | "integer" | "unresolved";
export type SchemaDiagnosticCode =
  | "unsupported_dictionary_key"
  | "schema_def_name_disambiguated"
  | "schema_depth_truncated"
  | "unreadable_shape";

export interface NamingFixture {
  kind: "naming";
  description: string;
  input: {
    endpoints: [NamingEndpoint, ...NamingEndpoint[]];
    prefixMode?: PrefixMode;
    hostPrefixes?: {
      [k: string]: string;
    };
  };
  expected: NamingExpectedNames | NamingExpectedError;
}
export interface NamingEndpoint {
  operationId?: string;
  container?: string;
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  route: string;
  containerPrefix?: string;
  toolName?: string;
  variants?: [NamingVariant, ...NamingVariant[]];
}
export interface NamingVariant {
  name: string;
  description: string;
  arguments?: ArgumentCuration[];
}
export interface ArgumentCuration {
  name: string;
  as?: string;
  description?: string;
  hidden?: ArgumentFill;
}
export interface NamingExpectedNames {
  names: [string, ...string[]];
}
export interface NamingExpectedError {
  error: "name_collision" | "invalid_name";
}
export interface MetadataExtractionFixture {
  kind: "metadata-extraction";
  description: string;
  input: EndpointDescriptor;
  foldedRoutes?: [string, ...string[]];
  files?: {
    refDescription?: string;
  };
  expected:
    | ToolDefinition
    | MetadataExtractionExpectedTools
    | MetadataExtractionExpectedError;
}
export interface EndpointDescriptor {
  operationId?: string;
  container?: string;
  containerPrefix?: string;
  toolName?: string;
  method:
    "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "QUERY";
  route: string;
  description?: string;
  deprecated?: boolean;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses?: {
    [k: string]: ResponseBody;
  };
  auth: Auth;
  tags?: string[];
  searchTerms?: string[];
  arguments?: ArgumentCuration[];
  variants?: [ToolVariant, ...ToolVariant[]];
  family?: ToolFamily;
  annotations?: ToolAnnotations;
}
export interface Parameter {
  name: string;
  in: "path" | "query" | "header" | "cookie" | "querystring";
  required: boolean;
  schema: JsonSchemaObject;
  style?:
    | "form"
    | "spaceDelimited"
    | "pipeDelimited"
    | "deepObject"
    | "simple"
    | "label"
    | "matrix"
    | "cookie";
  explode?: boolean;
  objectNotation?: "bracket" | "dot";
  description?: string;
  contentType?:
    "application/json" | "text/plain" | "application/x-www-form-urlencoded";
  allowReserved?: boolean;
}
export interface JsonSchemaObject {
  type?:
    | (
        | "object"
        | "array"
        | "string"
        | "integer"
        | "number"
        | "boolean"
        | "null"
      )
    | (
        | "object"
        | "array"
        | "string"
        | "integer"
        | "number"
        | "boolean"
        | "null"
      )[];
  description?: string;
  format?: string;
  properties?: {
    [k: string]: JsonSchemaObject;
  };
  required?: string[];
  items?: JsonSchemaObject;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchemaObject;
  contentEncoding?: string;
  contentMediaType?: string;
  propertyNames?: JsonSchemaObject;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
  $ref?: string;
  $defs?: {
    [k: string]: JsonSchemaObject;
  };
  [k: string]: unknown;
}
export interface RequestBody {
  schema: JsonSchemaObject;
  required?: boolean;
  description?: string;
  contentType?: string;
  objectNotation?: "bracket" | "dot";
}
export interface ResponseBody {
  schema?: JsonSchemaObject;
  description?: string;
}
export interface Auth {
  anonymous: Anonymity;
  policies: string[];
  imperative: boolean;
  carriers?: IdentityCarrier[];
}
export interface IdentityCarrier {
  in: "header" | "query" | "cookie";
  name: string;
}
export interface ToolVariant {
  name: string;
  description: string;
  arguments?: ArgumentCuration[];
  requestBody?: VariantRequestBody;
  annotations?: ToolAnnotations;
}
export interface VariantRequestBody {
  schema: JsonSchemaObject;
  required?: boolean;
  description?: string;
}
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}
export interface ToolFamily {
  parameter: string;
}
export interface ToolDefinition {
  name: string;
  description: string;
  deprecated?: boolean;
  inputSchema: JsonSchemaObject;
  outputSchema?: JsonSchemaObject;
  annotations: ToolAnnotations;
  auth: Auth;
}
export interface MetadataExtractionExpectedTools {
  tools: [ToolDefinition, ...ToolDefinition[]];
}
export interface MetadataExtractionExpectedError {
  error:
    | "argument_collision"
    | "schema_def_conflict"
    | "duplicate_argument"
    | "curation_unresolved"
    | "invalid_fill_constant"
    | "hidden_required_omitted"
    | "variant_declaration_conflict"
    | "unsupported_body_shape"
    | "unsupported_parameter_style"
    | "invalid_cookie_name"
    | "identity_carrier_parameter"
    | "unsupported_parameter_content"
    | "multiple_querystring"
    | "querystring_with_query"
    | "family_parameter_unresolved"
    | "family_without_members"
    | "family_key_unfilled"
    | "family_key_duplicate"
    | "variant_body_without_family"
    | "variant_body_invalid";
}
export interface ArgumentMappingFixture {
  kind: "argument-mapping";
  description: string;
  input: {
    template: RequestTemplateSpec;
    arguments: {};
    deferred?: {};
    maxInlineFileBytes?: number;
    carrierCookies?: string;
  };
  expected: ComposedRequestExpectation | ArgumentMappingError;
}
export interface RequestTemplateSpec {
  method:
    "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "QUERY";
  route: string;
  parameters?: TemplateParameter[];
  body?: {
    properties: string[];
    additionalProperties?: boolean;
    curation?: TemplateBodyCuration[];
  };
  bodyRoot?: string;
  rootFill?: ArgumentFill2;
  contentType?: string;
  form?: {
    notation?: "bracket" | "dot";
    fields: [TemplateFormField, ...TemplateFormField[]];
  };
  fileSources?: ["text" | "base64" | "ref", ...("text" | "base64" | "ref")[]];
}
export interface TemplateParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie" | "querystring";
  type: "string" | "integer" | "number" | "boolean" | "object" | "json";
  array?: boolean;
  style?:
    | "form"
    | "spaceDelimited"
    | "pipeDelimited"
    | "deepObject"
    | "simple"
    | "label"
    | "matrix"
    | "cookie";
  explode?: boolean;
  notation?: "bracket" | "dot";
  members?: [TemplateObjectMember, ...TemplateObjectMember[]];
  as?: string;
  fill?: ArgumentFill1;
  contentType?:
    "application/json" | "text/plain" | "application/x-www-form-urlencoded";
  allowReserved?: boolean;
}
export interface TemplateObjectMember {
  name: string;
  type: "string" | "integer" | "number" | "boolean";
  array?: boolean;
}
export interface TemplateBodyCuration {
  name: string;
  as?: string;
  fill?: ArgumentFill;
}
export interface TemplateFormField {
  name: string;
  type: "string" | "integer" | "number" | "boolean" | "object" | "file";
  array?: boolean;
  members?: [TemplateObjectMember, ...TemplateObjectMember[]];
  mediaType?: string;
}
export interface ComposedRequestExpectation {
  pathAndQuery: string;
  headers?: {
    [k: string]: string;
  };
  contentType?: string;
  bodyJson?: {} | unknown[] | string | number | boolean;
  bodyText?: string;
  bodyForm?: string;
  bodyParts?: ExpectedPart[];
  bodyFile?: ExpectedFile1;
}
export interface ArgumentMappingError {
  error:
    | "unknown_argument"
    | "invalid_path_type"
    | "missing_path_parameter"
    | "header_injection"
    | "null_not_allowed"
    | "invalid_type"
    | "deferred_value_missing"
    | "deferred_value_invalid"
    | "invalid_cookie_value"
    | "cookie_carrier_collision"
    | "invalid_file_argument"
    | "file_too_large";
}
export interface SelectionFixture {
  kind: "selection";
  description: string;
  input: {
    default: "include" | "exclude";
    operations: [SelectionOperation, ...SelectionOperation[]];
    rules?: SelectionRule[];
  };
  expected: SelectionExpectedIds | SelectionExpectedError;
}
export interface SelectionOperation {
  id: string;
  container?: "include" | "exclude" | "both";
  operation?: "include" | "exclude" | "both";
  route?: string;
  method?: string;
}
export interface SelectionRule {
  decision: "include" | "exclude";
  route?: string;
  method?: string;
}
export interface SelectionExpectedIds {
  selected: string[];
}
export interface SelectionExpectedError {
  error: "ambiguous_selection";
}
export interface VisibilityFixture {
  kind: "visibility";
  description: string;
  input: {
    auth: Auth;
    caller: CallerFacts;
  };
  expected: VisibilityExpectation;
}
export interface CallerFacts {
  identity: "present" | "absent" | "unknown";
  policyResults?: {
    [k: string]: "allow" | "deny" | "unknown";
  };
}
export interface VisibilityExpectation {
  decision: "allow" | "deny" | "unknown";
}
export interface SearchFixture {
  kind: "search";
  description: string;
  input: {
    tools: [SearchTool, ...SearchTool[]];
    query: string;
    limit?: number;
    tags?: string[];
  };
  expected: SearchExpectation;
}
export interface SearchTool {
  name: string;
  description?: string;
  tags?: string[];
  searchTerms?: string[];
  route: string;
  alternateRoutes?: string[];
  inputSchema?: JsonSchemaObject;
  groupedParameters?: [string, ...string[]];
}
export interface SearchExpectation {
  names: string[];
}
export interface RankedSearchFixture {
  kind: "ranked-search";
  description: string;
  input: {
    tools: [SearchTool, ...SearchTool[]];
    query: string;
    limit?: number;
    tags?: string[];
    rankerAnswer: {
      [k: string]: unknown;
    };
  };
  expected: RankedSearchExpectation;
}
export interface RankedSearchExpectation {
  names: string[];
  fallback: boolean;
  unknown?: string[];
  duplicate?: string[];
}
export interface ErrorMappingFixture {
  kind: "error-mapping";
  description: string;
  input: BackendResponseSpec | SdkErrorSpec;
  expected: InvokeResult;
}
export interface BackendResponseSpec {
  status: number;
  contentType?: string;
  headers?: {
    [k: string]: string;
  };
  body?: string | {} | unknown[];
  knownFields?: string[];
  fieldAliases?: {
    [k: string]: string;
  };
  hiddenFields?: string[];
}
export interface SdkErrorSpec {
  sdkError: SdkErrorCode;
  message?: string;
  bytes?: number;
  limit?: number;
  payload?: unknown;
  limitMs?: number;
  narrowing?: FieldError[];
  field?: string;
  tool?: string;
  reason?: "not_found" | "forbidden" | "unavailable" | "too_large";
}
export interface FieldError {
  name?: string;
  message: string;
}
export interface InvokeSuccess {
  status: number;
  body?: unknown;
  contentType?: string;
  location?: string;
}
export interface MappedError {
  error: BackendErrorCode;
  message: string;
  status: number;
  retryable: boolean;
  fields?: FieldError[];
  retryAfterSeconds?: number;
  reference?: string;
}
export interface SdkError {
  error: SdkErrorCode;
  message: string;
  retryable: boolean;
  fields?: FieldError[];
  payload?: PayloadFacts;
}
export interface PayloadFacts {
  bytes: number;
  limit: number;
  shape: PayloadShape;
}
export interface PayloadShape {
  kind: PayloadShapeKind;
  count?: number;
}
export interface SchemaSimplificationFixture {
  kind: "schema-simplification";
  description: string;
  input: {
    shape: TypeShape;
    options?: SchemaSimplificationOptions;
  };
  expected: SchemaSimplificationExpectation;
}
export interface TypeShape {
  root: TypeNode;
  types: {
    [k: string]: ObjectType;
  };
}
export interface TypeNode {
  kind: TypeKind;
  scalar?: ScalarKind;
  format?: string;
  items?: TypeNode;
  values?: TypeNode;
  keys?: MapKey;
  enumFacts?: EnumFacts;
  ref?: string;
  schema?: JsonSchemaObject;
  reason?: string;
}
export interface MapKey {
  writable: boolean;
  scalar?: ScalarKind;
  format?: string;
}
export interface EnumFacts {
  wireForm: EnumWireForm;
  combinable?: boolean;
  names: string[];
  numbers: number[];
}
export interface ObjectType {
  name: string;
  description?: string;
  wrapper?: boolean;
  members: Member[];
}
export interface Member {
  name: string;
  type: TypeNode;
  required: boolean;
  readOnly: boolean;
  constructorBound: boolean;
  description?: string;
  constraints?: Constraints;
}
export interface Constraints {
  minSize?: number;
  maxSize?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
}
export interface SchemaSimplificationOptions {
  dropReadOnlyProperties?: boolean;
  maxDepth?: number;
}
export interface SchemaSimplificationExpectation {
  schema: JsonSchemaObject;
  diagnostics?: SchemaDiagnosticCode[];
  defsOrder?: string[];
}
export interface CardFixture {
  kind: "card";
  description: string;
  input: {
    tool: ToolDefinition;
    decision?: "allow" | "deny" | "unknown";
  };
  expected: CardExpectation;
}
export interface CardExpectation {
  name: string;
  description: string;
  parameters: string;
  authUncertain?: boolean;
  deprecated?: boolean;
}
export interface DetailFixture {
  kind: "detail";
  description: string;
  input: {
    tool: ToolDefinition;
    decision?: "allow" | "deny" | "unknown";
  };
  expected: DetailExpectation;
}
export interface DetailExpectation {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  outputSchema?: JsonSchemaObject;
  annotations: ToolAnnotations;
  authUncertain?: boolean;
  deprecated?: boolean;
}
export interface OpenApiIngestionFixture {
  kind: "openapi-ingestion";
  description: string;
  input: {
    document: {};
    options?: {
      documentUrl?: string;
      baseUrl?: string;
      strict?: boolean;
      outputSchema?: "document" | "omit";
      hoistPathPrefix?: string;
      requestBodyRequired?: "document" | "always";
    };
  };
  expected: {
    endpoints: {
      key: string;
      baseUrl?: string;
      descriptor: EndpointDescriptor;
    }[];
    diagnostics: {
      code: string;
      at: string;
    }[];
  };
}
