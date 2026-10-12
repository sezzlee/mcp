export type Anonymity = "yes" | "no" | "unknown";

export interface ToolDefinition {
  name: string;
  description: string;
  deprecated?: boolean;
  inputSchema: JsonSchemaObject;
  outputSchema?: JsonSchemaObject;
  annotations: ToolAnnotations;
  auth: Auth;
  revision?: Revision;
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
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
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
