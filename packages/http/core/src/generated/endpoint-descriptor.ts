export type Anonymity = "yes" | "no" | "unknown";
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
  revision?: Revision;
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
export interface Revision {
  catalog?: number;
  container?: number;
  operation?: number;
}
export interface ArgumentCuration {
  name: string;
  as?: string;
  description?: string;
  hidden?: ArgumentFill;
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
