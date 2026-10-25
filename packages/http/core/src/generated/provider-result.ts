export type ProviderResult = ProviderSuccess | ProviderStored;
export type StoredValueKind = "array" | "object" | "string" | "scalar";

export interface ProviderSuccess {
  body: unknown;
}
export interface ProviderStored {
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
