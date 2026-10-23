export type ResultReading = InvokeStored | ReadResult;
export type StoredValueKind = "array" | "object" | "string" | "scalar";

export interface InvokeStored {
  status: number;
  contentType?: string;
  location?: string;
  stored: StoredResult;
  message: string;
}
export interface StoredResult {
  handle: string;
  bytes: number;
  limit: number;
  expiresInSeconds: number;
  outline: [OutlineEntry, ...OutlineEntry[]];
}
export interface OutlineEntry {
  path: string;
  kind: StoredValueKind;
  count?: number;
  fields?: [string, ...string[]];
}
export interface ReadResult {
  path: string;
  kind: StoredValueKind;
  total?: number;
  offset?: number;
  nextOffset?: number;
  value: unknown;
}
