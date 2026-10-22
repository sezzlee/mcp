import {
  openRoot,
  type NativeDigest,
  type NativeRoot,
  type NativeSnapshot,
} from "@sezzlee/file-core-native";
import { relative, isAbsolute, sep } from "node:path";
import {
  FileSourceError,
  type CoreErrorCode,
  type ErrorFactory,
} from "./errors.js";

const roots = new Map<string, WeakRef<NativeRoot>>();

/** The configured root is pinned once; cache consumers reuse that capability. */
export function pinRoot(path: string): NativeRoot {
  const existing = roots.get(path)?.deref();
  if (existing !== undefined) return existing;
  try {
    const root = openRoot(path);
    roots.set(path, new WeakRef(root));
    return root;
  } catch (error) {
    throw accessError(
      error,
      (code, message) => new FileSourceError(code, message),
    );
  }
}

export function knownRoot(
  path: string,
): { readonly real: string; readonly access: NativeRoot } | undefined {
  let selected: { real: string; access: NativeRoot } | undefined;
  for (const [real, reference] of roots) {
    const access = reference.deref();
    if (access === undefined) {
      roots.delete(real);
      continue;
    }
    const rest = relative(real, path);
    if (
      rest === "" ||
      (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
    ) {
      if (selected === undefined || real.length > selected.real.length)
        selected = { real, access };
    }
  }
  return selected;
}

export function accessError(
  error: unknown,
  fail: ErrorFactory<CoreErrorCode>,
): FileSourceError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  switch (code) {
    case "file_too_large":
      return fail(code, "The file exceeds the configured byte limit.");
    case "not_a_file":
      return fail(
        code,
        "The requested source is not a regular file or directory of the required kind.",
      );
    case "file_not_found":
      return fail(
        code,
        "The requested source does not exist under the configured root.",
      );
    case "path_outside_root":
      return fail(
        code,
        "The requested path cannot be safely resolved under the configured root.",
      );
    case "file_changed":
      return fail(
        code,
        "The file changed during the read.",
        "Retry the operation from the beginning.",
      );
    case "resource_limit":
      return fail(code, "The secure filesystem resource budget was exceeded.");
    case "unsupported_platform":
      return fail(
        code,
        "Secure filesystem access is unavailable. Install a supported, complete platform package.",
      );
    case "invalid_argument":
      return fail(code, "Invalid secure filesystem argument.");
    default:
      return fail(
        "internal_error",
        "Secure filesystem access failed unexpectedly.",
      );
  }
}

/** Validate the native boundary instead of trusting a declaration or a cast. */
export function assertSnapshot(
  value: unknown,
  maxBytes: number,
): asserts value is NativeSnapshot {
  if (
    typeof value !== "object" ||
    value === null ||
    !("bytes" in value) ||
    !Buffer.isBuffer(value.bytes) ||
    !("size" in value) ||
    !Number.isSafeInteger(value.size) ||
    value.size !== value.bytes.length ||
    value.bytes.length > maxBytes ||
    !("modifiedMs" in value) ||
    typeof value.modifiedMs !== "number" ||
    !Number.isFinite(value.modifiedMs)
  ) {
    throw new FileSourceError(
      "internal_error",
      "The secure reader returned an invalid snapshot.",
    );
  }
}

export function assertDigest(
  value: unknown,
  maxBytes: number,
): asserts value is NativeDigest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("digest" in value) ||
    !Buffer.isBuffer(value.digest) ||
    value.digest.length !== 32 ||
    !("size" in value) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size > maxBytes ||
    !("modifiedMs" in value) ||
    typeof value.modifiedMs !== "number" ||
    !Number.isFinite(value.modifiedMs)
  ) {
    throw new FileSourceError(
      "internal_error",
      "The secure reader returned an invalid digest.",
    );
  }
}
