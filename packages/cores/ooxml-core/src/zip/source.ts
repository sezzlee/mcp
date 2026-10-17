import { Inflate, unzipSync, type UnzipFileInfo } from "fflate";
import type { OoxmlErrorCode, OoxmlErrorFactory } from "../model/errors.js";
import type { PartEntry, PartSource } from "../model/package.js";
import type { OoxmlLimits } from "../limits.js";
import { crc32 } from "../primitives/crc32.js";
import {
  localDataOffset,
  localHeaderAgrees,
  readDirectory,
} from "./directory.js";

interface Refusal {
  readonly code: OoxmlErrorCode;
  readonly message: string;
}

const stored = 0;
const deflated = 8;
const sliceBytes = 1 << 16;

interface Declared {
  readonly size: number;
  readonly compressedSize: number;
  readonly compression: number;
}
const zipMagic = [0x50, 0x4b] as const;

/**
 * Guard: ECMA-376 Part 2 restricts a part name to the RFC 3986 pchar ASCII
 * subset, so a name outside printable ASCII is refused rather than decoded
 * through a code page. That is what lets this reader skip CP437 entirely, and
 * it also refuses the names that alias another part: a `..` segment, a leading
 * slash, a backslash and a drive letter all resolve somewhere the declaring
 * part did not name.
 */
function nameRefusal(name: string): string | undefined {
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) {
      return "carries a byte outside printable ASCII";
    }
  }
  if (name.startsWith("/")) return "is absolute in the archive";
  if (name.includes("\\")) return "carries a backslash";
  if (/^[A-Za-z]:/.test(name)) return "carries a drive letter";
  if (name.split("/").includes("..")) return "escapes its folder";
  return undefined;
}

function sizeRefusal(
  entry: UnzipFileInfo,
  limits: OoxmlLimits,
): Refusal | undefined {
  if (entry.originalSize > limits.maxPartBytes) {
    return {
      code: "part_too_large",
      message: `'${entry.name}' expands to ${String(entry.originalSize)} bytes, over the ${String(limits.maxPartBytes)} byte part ceiling.`,
    };
  }
  if (
    entry.originalSize > limits.ratioFloorBytes &&
    entry.size > 0 &&
    entry.originalSize / entry.size > limits.maxExpansionRatio
  ) {
    return {
      code: "part_too_large",
      message: `'${entry.name}' expands ${String(Math.round(entry.originalSize / entry.size))}:1, over the ${String(limits.maxExpansionRatio)}:1 ceiling.`,
    };
  }
  return undefined;
}

export interface ZipSourceEnvironment {
  readonly fail: OoxmlErrorFactory;
  readonly limits: OoxmlLimits;
}

/**
 * Indexes a zip container and reads its parts by name.
 *
 * @param bytes the whole container, already resident.
 * @param environment the error factory and the size ceilings to apply.
 * @returns a part source over every entry that passed the reject list.
 */
export function createZipSource(
  bytes: Uint8Array,
  environment: ZipSourceEnvironment,
): PartSource {
  const { fail, limits } = environment;
  const entries: PartEntry[] = [];
  const declared = new Map<string, Declared>();
  let refusal: Refusal | undefined;

  const inspect = (entry: UnzipFileInfo): boolean => {
    if (refusal !== undefined) return false;
    if (entry.name.endsWith("/")) return false;
    const badName = nameRefusal(entry.name);
    if (badName !== undefined) {
      refusal = {
        code: "malformed_part_name",
        message: `The archive names a part that ${badName}.`,
      };
      return false;
    }
    if (entry.compression !== stored && entry.compression !== deflated) {
      refusal = {
        code: "unsupported_zip_feature",
        message: `'${entry.name}' uses compression method ${String(entry.compression)}; only stored and deflate are read.`,
      };
      return false;
    }
    if (declared.has(entry.name)) {
      refusal = {
        code: "corrupt_package",
        message: `The archive carries '${entry.name}' twice.`,
      };
      return false;
    }
    const tooBig = sizeRefusal(entry, limits);
    if (tooBig !== undefined) {
      refusal = tooBig;
      return false;
    }
    declared.set(entry.name, {
      size: entry.originalSize,
      compressedSize: entry.size,
      compression: entry.compression,
    });
    entries.push({ path: entry.name, sizeBytes: entry.originalSize });
    return false;
  };

  /**
   * Guard: the counting pass returns false for every entry, so the directory is
   * indexed and the reject list runs without inflating anything. A size gate
   * applied after inflation is not a gate.
   */
  try {
    unzipSync(bytes, { filter: inspect });
  } catch (error) {
    /**
     * Guard: bytes that open with the zip signature are an archive, so one that
     * fails to index is damaged, not something other than a package; the two
     * call for different advice (re-save it, or check what the file is).
     */
    const signed = zipMagic.every((byte, index) => bytes[index] === byte);
    throw fail(
      signed ? "corrupt_package" : "not_a_package",
      `The archive could not be read: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (refusal !== undefined) throw fail(refusal.code, refusal.message);
  if (entries.length > limits.maxPartCount) {
    throw fail(
      "corrupt_package",
      `The archive carries ${String(entries.length)} parts, over the ${String(limits.maxPartCount)} part ceiling.`,
    );
  }
  const directory = readDirectory(bytes);
  if (directory === undefined) {
    throw fail(
      "corrupt_package",
      "The archive's central directory could not be walked.",
    );
  }

  /**
   * Guard: the inflater's output is handed on only after `push` returns, so
   * an error the consumer throws reaches the caller as itself and is never
   * reported as a failed decompression.
   */
  const stream = (
    path: string,
    onChunk: (chunk: Uint8Array) => void,
  ): boolean => {
    const entry = declared.get(path);
    if (entry === undefined) return false;
    const record = directory.get(path);
    if (record === undefined || !localHeaderAgrees(bytes, path, record)) {
      throw fail(
        "corrupt_package",
        `'${path}' has a local header that disagrees with the central directory.`,
      );
    }
    const start = localDataOffset(bytes, record);
    const end = start + entry.compressedSize;
    if (end > bytes.length) {
      throw fail(
        "corrupt_package",
        `'${path}' could not be decompressed: its data runs past the end of the archive.`,
      );
    }
    let produced = 0;
    let crc = 0;
    /**
     * Guard: the directory's declared size is what every size gate was
     * applied to, so an entry that inflates past it has bypassed them; it is
     * stopped at the first byte over, before the excess is used.
     */
    const take = (chunk: Uint8Array): void => {
      produced += chunk.length;
      if (produced > entry.size) {
        throw fail(
          "corrupt_package",
          `'${path}' declares ${String(entry.size)} bytes but expands to more.`,
        );
      }
      crc = crc32(chunk, crc);
      if (chunk.length > 0) onChunk(chunk);
    };
    if (entry.compression === stored) {
      for (let at = start; at < end; at += sliceBytes) {
        take(bytes.subarray(at, Math.min(end, at + sliceBytes)));
      }
    } else {
      const inflated: Uint8Array[] = [];
      const inflater = new Inflate((chunk) => {
        inflated.push(chunk);
      });
      for (let at = start; ; at += sliceBytes) {
        const next = Math.min(end, at + sliceBytes);
        try {
          inflater.push(bytes.subarray(at, next), next === end);
        } catch (error) {
          throw fail(
            "corrupt_package",
            `'${path}' could not be decompressed: ${error instanceof Error ? error.message : String(error)}.`,
          );
        }
        for (const chunk of inflated.splice(0)) take(chunk);
        if (next === end) break;
      }
    }
    if (produced !== entry.size) {
      throw fail(
        "corrupt_package",
        `'${path}' declares ${String(entry.size)} bytes but expands to ${String(produced)}.`,
      );
    }
    /**
     * Guard: a damaged deflate stream can still inflate to the declared length,
     * and `fflate` checks no CRC, so without this a flipped byte reaches the
     * part readers as a plausible wrong value instead of failing.
     */
    if (crc !== record.crc32) {
      throw fail(
        "corrupt_package",
        `'${path}' fails its CRC-32 check; the archive is damaged.`,
      );
    }
    return true;
  };

  const read = (path: string): Uint8Array | undefined => {
    const entry = declared.get(path);
    if (entry === undefined) return undefined;
    const whole = new Uint8Array(entry.size);
    let at = 0;
    stream(path, (chunk) => {
      whole.set(chunk, at);
      at += chunk.length;
    });
    return whole;
  };

  return { entries, read, stream };
}
