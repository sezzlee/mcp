import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { NativeRoot } from "@sezzlee/file-core-native";
import { createDocumentStore } from "../src/documents.js";
import { FileSourceError } from "../src/errors.js";
import type { SandboxedPath } from "../src/paths.js";

const io = vi.hoisted(() => ({ operations: [] as string[] }));

vi.mock("@sezzlee/file-core-native", async (importOriginal) => {
  const native =
    await importOriginal<typeof import("@sezzlee/file-core-native")>();
  return {
    ...native,
    openRoot: (path: string): NativeRoot => {
      const root = native.openRoot(path);
      return {
        ...root,
        read: (relative, maxBytes) => {
          io.operations.push("read");
          return root.read(relative, maxBytes);
        },
        digest: (relative, maxBytes) => {
          io.operations.push("digest");
          return root.digest(relative, maxBytes);
        },
      };
    },
  };
});

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "doc-io-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  io.operations.length = 0;
});

function createStore() {
  return createDocumentStore<{ readonly text: string }, undefined>({
    maxEntries: 4,
    maxBytes: 1_000_000,
    mode: { residentMaxBytes: 1_000_000 },
    root: dir,
    vocabulary: {
      serverName: "probe-mcp",
      subject: "document",
      rootLabel: "document root",
      readableLabel: "readable document",
      listTool: "list_documents",
      tooLargeRecovery: "Read a smaller file.",
    },
    fail: (code, message, recovery) =>
      new FileSourceError(code, message, recovery),
    variantKey: () => "",
    parse: async (context) => ({
      text: context.mode === "resident" ? context.bytes.toString("utf8") : "",
    }),
  });
}

describe("the document store's file reads", () => {
  it("reads a file it has no entry for once, without a digest pass", async () => {
    const path = join(dir, "first.probe") as SandboxedPath;
    await writeFile(path, "first");
    await createStore().load(path, undefined);
    expect(io.operations).toEqual(["read"]);
  });

  it("serves a hit from a digest alone, never holding the file", async () => {
    const path = join(dir, "hit.probe") as SandboxedPath;
    await writeFile(path, "hit");
    const store = createStore();
    await store.load(path, undefined);
    await store.load(path, undefined);
    expect(io.operations).toEqual(["read", "digest"]);
  });

  it("reads the file again only when the digest disagrees", async () => {
    const path = join(dir, "changed.probe") as SandboxedPath;
    await writeFile(path, "before");
    const store = createStore();
    await store.load(path, undefined);
    await writeFile(path, "after!");
    const reloaded = await store.load(path, undefined);
    expect(io.operations).toEqual(["read", "digest", "read"]);
    expect(reloaded.text).toBe("after!");
  });

  it("reports the SHA-256 of the exact bytes it serves, on a miss, a hit and after a change", async () => {
    const path = join(dir, "digest.probe") as SandboxedPath;
    const sha256 = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    await writeFile(path, "first bytes");
    const store = createStore();
    expect((await store.load(path, undefined)).contentDigest).toBe(
      sha256("first bytes"),
    );
    expect((await store.load(path, undefined)).contentDigest).toBe(
      sha256("first bytes"),
    );
    await writeFile(path, "second bytes");
    expect((await store.load(path, undefined)).contentDigest).toBe(
      sha256("second bytes"),
    );
  });
});
