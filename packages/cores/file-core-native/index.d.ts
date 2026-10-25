export interface NativeSnapshot {
  readonly bytes: Buffer;
  readonly size: number;
  readonly modifiedMs: number;
}
export interface NativeEntry {
  readonly path: string;
  readonly size: number;
  readonly modifiedMs: number;
  readonly directory: boolean;
}
export interface NativeScan {
  readonly entries: readonly NativeEntry[];
  readonly visited: number;
  readonly unreadable: number;
  readonly reason: "entries" | "depth" | "time" | null;
}
export interface NativeRange {
  readonly bytes: Buffer;
  readonly size: number;
  readonly modifiedMs: number;
  readonly offset: number;
}
export interface NativeDigest {
  readonly digest: Buffer;
  readonly size: number;
  readonly modifiedMs: number;
}
export interface NativeRoot {
  resolve(path: string): Promise<string>;
  read(path: string, maxBytes: number): Promise<NativeSnapshot>;
  readRange(
    path: string,
    offset: number,
    length: number,
    maxBytes: number,
  ): Promise<NativeRange>;
  digest(path: string, maxBytes: number): Promise<NativeDigest>;
  scan(
    path: string,
    maxEntries: number,
    maxDepth: number,
    maxMs: number,
  ): Promise<NativeScan>;
}
export function openRoot(path: string): NativeRoot;

export interface NativeOutputRoot {
  publish(name: string, content: Buffer, maxBytes: number): Promise<string>;
}
export function openOutputRoot(
  root: NativeRoot,
  directory: string,
): NativeOutputRoot;
