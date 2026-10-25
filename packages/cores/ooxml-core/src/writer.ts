import { zipSync, type Zippable } from "fflate";
import { ooxmlLimits, type OoxmlLimits } from "./limits.js";
import type { OoxmlErrorFactory } from "./model/errors.js";
import { normalisePartPath } from "./container/names.js";
import { createZipSource } from "./zip/source.js";

export function createOoxmlWriter(environment: {
  readonly fail: OoxmlErrorFactory;
  readonly limits?: Partial<OoxmlLimits>;
}): {
  zip(parts: ReadonlyMap<string, Uint8Array>, maxBytes: number): Uint8Array;
} {
  const limits: OoxmlLimits = { ...ooxmlLimits, ...environment.limits };
  const { fail } = environment;
  return {
    zip(parts, maxBytes) {
      if (parts.size > limits.maxPartCount)
        throw fail("package_too_large", "The part count exceeds the limit.");
      const input: Zippable = Object.create(null);
      let total = 0;
      for (const [name, bytes] of parts) {
        if (
          normalisePartPath(name) !== name ||
          name === "" ||
          name.endsWith("/") ||
          name
            .split("/")
            .some(
              (segment) =>
                segment === "." || segment === ".." || segment === "",
            )
        )
          throw fail("malformed_part_name", "A part name is not canonical.");
        if (bytes.byteLength > limits.maxPartBytes)
          throw fail("part_too_large", "A part exceeds the byte limit.");
        total += bytes.byteLength;
        if (total > limits.maxDecodedPackageBytes)
          throw fail(
            "package_too_large",
            "The expanded parts exceed the byte limit.",
          );
        input[name] = [bytes, { mtime: new Date(1980, 0, 1), level: 1 }];
      }
      const bytes = zipSync(input);
      if (bytes.byteLength > maxBytes)
        throw fail(
          "package_too_large",
          "The compressed archive exceeds the byte limit.",
        );
      createZipSource(bytes, { fail, limits });
      return bytes;
    },
  };
}
