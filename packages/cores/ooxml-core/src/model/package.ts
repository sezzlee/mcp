import type { XmlVisitor } from "./xml.js";

export type ContainerKind = "zip" | "cfb" | "unknown";

export interface PartEntry {
  /** Package path: no leading slash, forward slashes, ASCII only. */
  readonly path: string;
  /**
   * Uncompressed size as declared by the container directory. It is verified
   * against the actual length when the part is read; a mismatch is
   * `corrupt_package`, which is what closes the size gate's bypass.
   */
  readonly sizeBytes: number;
}

/**
 * A by-name view over a container's parts. Synchronous because the bytes are
 * already resident: an async shape would spread promises through every part
 * reader for no gain. `read` does not memoise and the returned bytes must not
 * be mutated.
 */
export interface PartSource {
  readonly entries: readonly PartEntry[];
  read(path: string): Uint8Array | undefined;
  /**
   * Hands a part's bytes to `onChunk` in order, holding no more than a chunk of
   * them, and checks the whole as `read` does once the last is handed on. A
   * source without it is read whole and handed on as one chunk.
   *
   * @returns false when the part is absent.
   */
  stream?(path: string, onChunk: (chunk: Uint8Array) => void): boolean;
}

export type Relationship =
  | {
      readonly kind: "internal";
      readonly id: string;
      readonly type: string;
      readonly target: string;
    }
  | {
      readonly kind: "external";
      readonly id: string;
      readonly type: string;
      readonly target: string;
    };

export interface ContentTypes {
  contentTypeOf(partPath: string): string | undefined;
  readonly defaults: ReadonlyMap<string, string>;
  readonly overrides: ReadonlyMap<string, string>;
}

export interface OpcPackage {
  /**
   * Decoded part text, memoised. `undefined` means absent and `""` means present
   * and empty; collapsing the two drops a legal empty part instead of scanning it.
   */
  part(path: string): string | undefined;
  /**
   * Scans a part with the package's XML reader as it is inflated and decoded,
   * keeping none of its text; a part `part` already decoded is scanned from
   * that text.
   *
   * @returns false when the part is absent.
   */
  scanPart(path: string, visitor: XmlVisitor): boolean;
  partBytes(path: string): Uint8Array | undefined;
  partSize(path: string): number | undefined;
  readonly parts: readonly PartEntry[];
  relationshipsFor(partPath: string): ReadonlyMap<string, Relationship>;
  /** The package-level `_rels/.rels`, the entry point to every OOXML format. */
  readonly packageRelationships: ReadonlyMap<string, Relationship>;
  readonly contentTypes: ContentTypes;
}
