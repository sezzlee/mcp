export type OpenApiExtension = OperationExtension | ScopeExtension;
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
export type FamilyKey = string | number;

export interface OperationExtension {
  tool?: boolean;
  foldedInto?: string;
  toolName?: string;
  containerPrefix?: string;
  description?: string;
  tags?: string[];
  parameters?: ParameterSchema[];
  requestBody?: VariantRequestBody;
  responses?: {
    [k: string]: ResponseBody;
  };
  publishedSchemas?: boolean;
  annotations?: ToolAnnotations;
  anonymous?: true;
  arguments?: ArgumentCuration[];
  variants?: [ToolVariant, ...ToolVariant[]];
  family?: FamilyDeclaration;
  searchTerms?: string[];
  revision?: number;
}
export interface ParameterSchema {
  name: string;
  in: "path" | "query" | "header" | "cookie" | "querystring";
  required: boolean;
  schema: JsonSchemaObject;
  description?: string;
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
export interface VariantRequestBody {
  schema: JsonSchemaObject;
  required?: boolean;
  description?: string;
}
export interface ResponseBody {
  schema?: JsonSchemaObject;
  description?: string;
}
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
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
export interface FamilyDeclaration {
  parameter: string;
  members: FamilyMember[];
}
export interface FamilyMember {
  key: FamilyKey;
  name: string;
  description: string;
  arguments?: ArgumentCuration[];
  requestBody?: VariantRequestBody;
  annotations?: ToolAnnotations;
}
export interface ScopeExtension {
  revision: number;
}
