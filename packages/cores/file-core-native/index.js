import { createRequire } from "node:module";
import { platform, arch } from "node:process";
import { randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);
let binding;
const rootHandles = new WeakMap();

function fail(message) {
  return Object.assign(new Error(message), { code: "unsupported_platform" });
}

function load() {
  if (binding !== undefined) return binding;
  const target = `${platform}-${arch}`;
  if (
    ![
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ].includes(target)
  ) {
    throw fail("Secure filesystem access is unavailable on this platform.");
  }
  if (
    platform === "linux" &&
    !process.report.getReport().header.glibcVersionRuntime
  ) {
    throw fail(
      "Secure filesystem access requires a supported glibc Linux target.",
    );
  }
  try {
    binding = require(`./prebuilds/${target}/secure.node`);
  } catch {
    throw fail(
      "The secure filesystem binary is missing or incompatible. Install a complete platform package.",
    );
  }
  return binding;
}

function pathArgument(path) {
  if (typeof path !== "string" || path.includes("\0") || path.length > 32768) {
    throw new TypeError("Expected a bounded path without NUL bytes.");
  }
}

function budget(value, max) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new TypeError("Invalid secure filesystem budget.");
  }
}

function object(value) {
  return typeof value === "object" && value !== null;
}
function invalidResult() {
  throw Object.assign(new Error("Invalid secure filesystem result."), {
    code: "internal_error",
  });
}

export function openRoot(path) {
  pathArgument(path);
  const api = load();
  const root = api.openRoot(path);
  const view = Object.freeze({
    async resolve(relative) {
      pathArgument(relative);
      const result = await api.run(root, "resolve", relative, 0, 0, 0, 0, 0);
      if (typeof result !== "string" || result.includes("\0")) invalidResult();
      return result;
    },
    async read(relative, maxBytes) {
      pathArgument(relative);
      budget(maxBytes, 50 * 1024 * 1024);
      const result = await api.run(
        root,
        "read",
        relative,
        maxBytes,
        0,
        0,
        0,
        0,
      );
      if (
        !object(result) ||
        !Buffer.isBuffer(result.bytes) ||
        result.bytes.length > maxBytes ||
        result.size !== result.bytes.length ||
        !Number.isFinite(result.modifiedMs)
      )
        invalidResult();
      return result;
    },
    async readRange(relative, offset, length, maxBytes) {
      pathArgument(relative);
      budget(offset, 50 * 1024 * 1024);
      budget(length, 50 * 1024 * 1024);
      budget(maxBytes, 50 * 1024 * 1024);
      const result = await api.run(
        root,
        "readRange",
        relative,
        maxBytes,
        0,
        0,
        offset,
        length,
      );
      if (
        !object(result) ||
        !Buffer.isBuffer(result.bytes) ||
        !Number.isSafeInteger(result.size) ||
        result.size > maxBytes ||
        !Number.isSafeInteger(result.offset) ||
        result.offset !== Math.min(offset, result.size) ||
        result.bytes.length !==
          Math.min(result.offset + length, result.size) - result.offset ||
        !Number.isFinite(result.modifiedMs)
      )
        invalidResult();
      return Object.freeze(result);
    },
    /**
     * The digest must equal Node's createHash("sha256") over the same bytes:
     * every cursor fingerprint is derived from it, so a divergent native hash
     * invalidates issued cursors instead of failing loudly.
     */
    async digest(relative, maxBytes) {
      pathArgument(relative);
      budget(maxBytes, 50 * 1024 * 1024);
      const result = await api.run(
        root,
        "digest",
        relative,
        maxBytes,
        0,
        0,
        0,
        0,
      );
      if (
        !object(result) ||
        !Buffer.isBuffer(result.digest) ||
        result.digest.length !== 32 ||
        !Number.isSafeInteger(result.size) ||
        result.size > maxBytes ||
        !Number.isFinite(result.modifiedMs)
      )
        invalidResult();
      return Object.freeze(result);
    },
    async scan(relative, maxEntries, maxDepth, maxMs) {
      pathArgument(relative);
      budget(maxEntries, 5000);
      budget(maxDepth, 64);
      budget(maxMs, 1000);
      const result = await api.run(
        root,
        "scan",
        relative,
        maxEntries,
        maxDepth,
        maxMs,
        0,
        0,
      );
      if (
        !object(result) ||
        !Array.isArray(result.entries) ||
        result.entries.length > maxEntries ||
        !Number.isSafeInteger(result.visited) ||
        result.visited < 0 ||
        result.visited > maxEntries ||
        !Number.isSafeInteger(result.unreadable) ||
        result.unreadable < 0 ||
        ![null, "entries", "depth", "time"].includes(result.reason) ||
        !result.entries.every(
          (entry) =>
            object(entry) &&
            typeof entry.path === "string" &&
            Number.isSafeInteger(entry.size) &&
            entry.size >= 0 &&
            Number.isFinite(entry.modifiedMs) &&
            typeof entry.directory === "boolean",
        )
      )
        invalidResult();
      return result;
    },
  });
  rootHandles.set(view, root);
  return view;
}

export function openOutputRoot(source, directory) {
  const sourceHandle = rootHandles.get(source);
  if (sourceHandle === undefined)
    throw new TypeError("Expected an open source root.");
  pathArgument(directory);
  const api = load();
  if (
    typeof api.openOutputRoot !== "function" ||
    typeof api.publish !== "function"
  )
    throw fail(
      "The secure filesystem binary does not support output publication. Rebuild or install a complete platform package.",
    );
  const root = api.openOutputRoot(sourceHandle, directory);
  return Object.freeze({
    async publish(name, content, maxBytes) {
      if (
        typeof name !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name)
      )
        throw new TypeError(
          "Expected a bounded output name without path components.",
        );
      if (!Buffer.isBuffer(content))
        throw new TypeError("Expected output bytes.");
      budget(maxBytes, 50 * 1024 * 1024);
      const result = await api.publish(
        root,
        name,
        randomBytes(16).toString("hex"),
        content,
        maxBytes,
      );
      if (result !== name) invalidResult();
      return result;
    },
  });
}
