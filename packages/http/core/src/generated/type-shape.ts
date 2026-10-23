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
  nullable?: boolean;
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
