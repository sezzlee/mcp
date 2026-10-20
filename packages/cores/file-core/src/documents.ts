import { stat } from "node:fs/promises";
import { relative } from "node:path";
import { accessError, assertSnapshot, knownRoot, pinRoot } from "./access.js";
import { contentFingerprint, type Fingerprint } from "@sezzlee/mcp-core";
import { type CoreErrorCode, type ErrorFactory } from "./errors.js";
import { modeFor, type ModePolicy, type SourceMode } from "./mode.js";
import type { SandboxedPath } from "./paths.js";
import type { Vocabulary } from "./vocabulary.js";

const variantSeparator = "\u0000";

/**
 * Names the size and the limit, so a caller learns that no tool of the server
 * can read the file instead of trying the next one.
 *
 * Guard: the size is read after the secure reader refused the file and only
 * words the message; nothing is read or decided on it.
 */
async function tooLargeMessage(
  path: string,
  maxBytes: number,
): Promise<string> {
  const size = await stat(path).then(
    (info) => info.size,
    () => undefined,
  );
  return size === undefined
    ? `The file exceeds the ${maxBytes} byte limit.`
    : `The file is ${size} bytes; the limit is ${maxBytes} bytes.`;
}

export interface OpenedFile {
  readonly stamp: Fingerprint;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly mode: SourceMode;
}

export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

/** Reads a byte range of the opened file. */
export interface SourceReader {
  readonly sizeBytes: number;
  read(range: ByteRange): Promise<Buffer>;
}

interface ParseContextBase extends OpenedFile {
  readonly path: SandboxedPath;
  readonly displayPath: string;
  readonly source: SourceReader;
}

/** Carries `bytes` in the resident tier only; a chunked parse reads `source`. */
export type ParseContext =
  | (ParseContextBase & { readonly mode: "resident"; readonly bytes: Buffer })
  | (ParseContextBase & { readonly mode: "chunked" });

export function bufferSource(bytes: Buffer): SourceReader {
  return {
    sizeBytes: bytes.length,
    read: (range) =>
      Promise.resolve(
        bytes.subarray(range.offset, range.offset + range.length),
      ),
  };
}

export interface DocumentStoreSpec<Loaded, Options> {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxBytesFor?: (path: SandboxedPath, options: Options) => number;
  readonly mode: ModePolicy;
  readonly root?: string;
  readonly vocabulary: Vocabulary<string>;
  readonly fail: ErrorFactory<CoreErrorCode>;
  readonly variantKey: (options: Options) => string;
  readonly parse: (context: ParseContext, options: Options) => Promise<Loaded>;
}

export interface DocumentStore<Loaded, Options> {
  load(path: SandboxedPath, options: Options): Promise<Loaded & OpenedFile>;
  clear(): void;
  readonly size: number;
}

export function createDocumentStore<Loaded, Options>(
  spec: DocumentStoreSpec<Loaded, Options>,
): DocumentStore<Loaded, Options> {
  const cache = new Map<string, Loaded & OpenedFile>();
  const configured =
    spec.root === undefined
      ? undefined
      : { real: spec.root, access: pinRoot(spec.root) };

  function remember(
    key: string,
    document: Loaded & OpenedFile,
  ): Loaded & OpenedFile {
    cache.delete(key);
    cache.set(key, document);
    while (cache.size > spec.maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done === true) {
        break;
      }
      cache.delete(oldest.value);
    }
    return document;
  }

  return {
    get size() {
      return cache.size;
    },
    clear() {
      cache.clear();
    },
    async load(path, options) {
      const key = [path, spec.variantKey(options)].join(variantSeparator);
      const root = configured ?? knownRoot(path);
      if (root === undefined)
        throw spec.fail(
          "invalid_argument",
          "A pinned sandbox root is required to load a document.",
        );
      const displayPath = relative(root.real, path);
      const maxBytes = Math.min(
        spec.maxBytes,
        spec.maxBytesFor?.(path, options) ?? spec.maxBytes,
      );
      let snapshot;
      try {
        snapshot = await root.access.read(displayPath, maxBytes);
        assertSnapshot(snapshot, maxBytes);
      } catch (error) {
        const mapped = accessError(error, spec.fail);
        if (mapped.code === "file_too_large")
          throw spec.fail(
            "file_too_large",
            await tooLargeMessage(path, maxBytes),
            spec.vocabulary.tooLargeRecovery,
          );
        throw mapped;
      }
      const stamp = contentFingerprint(
        path,
        snapshot.bytes,
        spec.variantKey(options),
      );
      const cached = cache.get(key);
      const modifiedAt = new Date(snapshot.modifiedMs).toISOString();
      if (
        cached !== undefined &&
        cached.stamp === stamp &&
        cached.modifiedAt === modifiedAt
      ) {
        return remember(key, cached);
      }
      const opened: OpenedFile = {
        stamp,
        sizeBytes: snapshot.size,
        modifiedAt,
        mode: modeFor(snapshot.size, spec.mode),
      };
      const base = {
        ...opened,
        path,
        displayPath,
        source: bufferSource(snapshot.bytes),
      };
      const parsed = await spec.parse(
        opened.mode === "resident"
          ? { ...base, mode: "resident", bytes: snapshot.bytes }
          : { ...base, mode: "chunked" },
        options,
      );
      return remember(key, { ...parsed, ...opened });
    },
  };
}
