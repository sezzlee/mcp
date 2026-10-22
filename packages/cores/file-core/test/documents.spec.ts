import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createDocumentStore,
  type DocumentStore,
  type ParseContext,
} from "../src/documents.js";
import {
  FileSourceError,
  type CoreErrorCode,
  type ErrorFactory,
} from "../src/errors.js";
import type { SandboxedPath } from "../src/paths.js";
import type { Vocabulary } from "../src/vocabulary.js";

const vocabulary: Vocabulary<string> = {
  serverName: "probe-mcp",
  subject: "document",
  rootLabel: "document root",
  readableLabel: "readable document",
  listTool: "list_documents",
  tooLargeRecovery: "Read a smaller file.",
};

const fail: ErrorFactory<CoreErrorCode> = (code, message, recovery) =>
  new FileSourceError(code, message, recovery);

interface Body {
  readonly text: string;
}

interface Options {
  readonly mode?: string;
}

interface Probe {
  readonly store: DocumentStore<Body, Options>;
  parses(): number;
}

function createProbe(
  maxEntries: number,
  maxBytes = 1_000_000,
  root?: string,
): Probe {
  let parses = 0;
  const store = createDocumentStore<Body, Options>({
    maxEntries,
    maxBytes,
    mode: { residentMaxBytes: maxBytes },
    root: root ?? dir,
    vocabulary,
    fail,
    variantKey: (options) => options.mode ?? "",
    parse: async (context: ParseContext, options: Options) => {
      parses += 1;
      const bytes =
        context.mode === "resident"
          ? context.bytes
          : await context.source.read({
              offset: 0,
              length: context.source.sizeBytes,
            });
      return { text: `${options.mode ?? "plain"}:${bytes.toString("utf8")}` };
    },
  });
  return { store, parses: () => parses };
}

let dir: string;
const paths: Record<string, SandboxedPath> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "doc-store-"));
  await mkdir(join(dir, "nested-dir.probe"));
  for (const name of ["a", "b", "c"]) {
    const path = join(dir, `${name}.probe`);
    await writeFile(path, name);
    paths[name] = path as SandboxedPath;
  }
});

describe("the document store", () => {
  it("serves a second read of an unchanged file from the cache", async () => {
    const probe = createProbe(4);
    await probe.store.load(paths["a"]!, {});
    await probe.store.load(paths["a"]!, {});
    expect(probe.parses()).toBe(1);
  });

  it("re-parses after the mtime changes", async () => {
    const probe = createProbe(4);
    const path = join(dir, "touched.probe") as SandboxedPath;
    await writeFile(path, "one");
    await probe.store.load(path, {});
    await utimes(path, new Date(1_000_000), new Date(2_000_000));
    await probe.store.load(path, {});
    expect(probe.parses()).toBe(2);
  });

  it("re-parses when the content size changes", async () => {
    const probe = createProbe(4);
    const path = join(dir, "grown.probe") as SandboxedPath;
    await writeFile(path, "one");
    await probe.store.load(path, {});
    await writeFile(path, "one-two-three");
    const second = await probe.store.load(path, {});
    expect(probe.parses()).toBe(2);
    expect(second.text).toContain("one-two-three");
  });

  it("re-parses a same-size content swap under a restored mtime", async () => {
    const probe = createProbe(4);
    const path = join(dir, "swapped.probe") as SandboxedPath;
    await writeFile(path, "aaaa");
    const before = await stat(path);
    await probe.store.load(path, {});
    await writeFile(path, "bbbb");
    await utimes(path, before.atime, before.mtime);
    const second = await probe.store.load(path, {});
    expect(probe.parses()).toBe(2);
    expect(second.text).toBe("plain:bbbb");
  });

  it("refuses a cached file that grew past maxBytes the way a first read does", async () => {
    const probe = createProbe(4, 8);
    const path = join(dir, "outgrown.probe") as SandboxedPath;
    await writeFile(path, "small");
    await probe.store.load(path, {});
    await writeFile(path, "now too large");
    try {
      await probe.store.load(path, {});
      expect.unreachable();
    } catch (error) {
      const failure = error as FileSourceError;
      expect(failure.code).toBe("file_too_large");
      expect(failure.message).toBe(
        "The file is 13 bytes; the limit is 8 bytes.",
      );
      expect(failure.recovery).toBe("Read a smaller file.");
    }
  });

  it("evicts the least recently used entry at maxEntries", async () => {
    const probe = createProbe(2);
    await probe.store.load(paths["a"]!, {});
    await probe.store.load(paths["b"]!, {});
    await probe.store.load(paths["c"]!, {});
    expect(probe.store.size).toBe(2);
    await probe.store.load(paths["a"]!, {});
    expect(probe.parses()).toBe(4);
  });

  it("keeps a recently used entry alive across an eviction", async () => {
    const probe = createProbe(2);
    await probe.store.load(paths["a"]!, {});
    await probe.store.load(paths["b"]!, {});
    await probe.store.load(paths["a"]!, {});
    await probe.store.load(paths["c"]!, {});
    await probe.store.load(paths["a"]!, {});
    expect(probe.parses()).toBe(3);
  });

  it("gives every parse option its own entry", async () => {
    const probe = createProbe(4);
    const first = await probe.store.load(paths["a"]!, { mode: "one" });
    const second = await probe.store.load(paths["a"]!, { mode: "two" });
    expect(probe.parses()).toBe(2);
    expect(first.text).not.toBe(second.text);
    await probe.store.load(paths["a"]!, { mode: "one" });
    expect(probe.parses()).toBe(2);
  });

  it("does not let two stores evict each other", async () => {
    const left = createProbe(1);
    const right = createProbe(1);
    await left.store.load(paths["a"]!, {});
    await right.store.load(paths["b"]!, {});
    await left.store.load(paths["a"]!, {});
    expect(left.parses()).toBe(1);
    expect(right.parses()).toBe(1);
  });

  it("clears only its own entries", async () => {
    const left = createProbe(4);
    const right = createProbe(4);
    await left.store.load(paths["a"]!, {});
    await right.store.load(paths["a"]!, {});
    left.store.clear();
    expect(left.store.size).toBe(0);
    expect(right.store.size).toBe(1);
  });

  it("refuses a directory and redacts the root from the message", async () => {
    const probe = createProbe(4, 1_000_000, dir);
    try {
      await probe.store.load(
        join(dir, "nested-dir.probe") as SandboxedPath,
        {},
      );
      expect.unreachable();
    } catch (error) {
      const failure = error as FileSourceError;
      expect(failure.code).toBe("not_a_file");
      expect(failure.message).toContain("not a regular file");
      expect(failure.message).not.toContain(dir);
    }
  });

  it("does not expose the absolute path in access errors", async () => {
    const probe = createProbe(4);
    const path = join(dir, "nested-dir.probe") as SandboxedPath;
    try {
      await probe.store.load(path, {});
      expect.unreachable();
    } catch (error) {
      expect((error as FileSourceError).message).not.toContain(path);
    }
  });

  it("refuses a file over maxBytes and names the vocabulary recovery", async () => {
    const probe = createProbe(4, 0);
    try {
      await probe.store.load(paths["a"]!, {});
      expect.unreachable();
    } catch (error) {
      const failure = error as FileSourceError;
      expect(failure.code).toBe("file_too_large");
      expect(failure.message).toBe(
        "The file is 1 bytes; the limit is 0 bytes.",
      );
      expect(failure.recovery).toBe("Read a smaller file.");
      expect(probe.parses()).toBe(0);
    }
  });
});
