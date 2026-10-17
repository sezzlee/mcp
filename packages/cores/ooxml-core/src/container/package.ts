import type { OoxmlLimits } from "../limits.js";
import type { OoxmlErrorFactory } from "../model/errors.js";
import type { OpcPackage, PartSource, Relationship } from "../model/package.js";
import type { XmlVisitor } from "../model/xml.js";
import {
  partText,
  partTextStream,
  type PartTextFault,
} from "../primitives/bytes.js";
import type { XmlPartReader, XmlPartStreamer } from "../xml/read.js";
import { contentTypesPath, readContentTypes } from "./content-types.js";
import { normalisePartPath, relationshipsPathFor } from "./names.js";
import { readRelationships } from "./relationships.js";

export interface PackageEnvironment {
  readonly fail: OoxmlErrorFactory;
  readonly limits: OoxmlLimits;
  readonly readXmlPart: XmlPartReader;
  readonly streamXmlPart: XmlPartStreamer;
}

/**
 * Opens an OPC package over a part source.
 *
 * @param source the container's parts, already indexed.
 * @param environment the error factory, the ceilings and the part reader.
 * @returns the package, with the text `part` decodes memoised.
 */
export function openPackage(
  source: PartSource,
  environment: PackageEnvironment,
): OpcPackage {
  const { fail, limits, readXmlPart, streamXmlPart } = environment;
  const sizes = new Map(
    source.entries.map((entry) => [entry.path, entry.sizeBytes]),
  );
  const decoded = new Map<string, string>();
  const relationshipCache = new Map<
    string,
    ReadonlyMap<string, Relationship>
  >();
  const charged = new Set<string>();
  let decodedBytes = 0;

  const partBytes = (path: string): Uint8Array | undefined =>
    source.read(normalisePartPath(path));

  const partSize = (path: string): number | undefined =>
    sizes.get(normalisePartPath(path));

  /**
   * Guard: the budget counts every part this package decodes, once however
   * often it is scanned, because the per-part ceiling alone lets a package of
   * many just-under-ceiling parts exhaust memory one legal part at a time.
   */
  const charge = (path: string, size: number): void => {
    if (charged.has(path)) return;
    charged.add(path);
    decodedBytes += size;
    if (decodedBytes > limits.maxDecodedPackageBytes) {
      throw fail(
        "package_too_large",
        `Reading '${path}' takes this package past the ${String(limits.maxDecodedPackageBytes)} byte decoding budget.`,
      );
    }
  };

  const refuse = (path: string, fault: PartTextFault): never => {
    switch (fault.kind) {
      case "malformed":
        throw fail(
          "corrupt_package",
          `'${path}' is not valid ${fault.encoding === "utf-8" ? "UTF-8" : "UTF-16"}.`,
        );
      case "no_byte_order_mark":
        throw fail(
          "corrupt_package",
          `'${path}' declares UTF-16 but carries no byte order mark.`,
        );
      case "unsupported":
        throw fail(
          "unsupported_part_encoding",
          `'${path}' declares encoding '${fault.named}', which is not read.`,
        );
      default: {
        const _exhaustive: never = fault;
        return _exhaustive;
      }
    }
  };

  const part = (path: string): string | undefined => {
    const normalised = normalisePartPath(path);
    const cached = decoded.get(normalised);
    if (cached !== undefined) return cached;
    const size = sizes.get(normalised);
    if (size === undefined) return undefined;
    charge(normalised, size);
    const bytes = source.read(normalised);
    if (bytes === undefined) return undefined;
    const read = partText(bytes);
    if (read.kind !== "text") return refuse(normalised, read);
    decoded.set(normalised, read.text);
    return read.text;
  };

  /**
   * Guard: the part is inflated, decoded and tokenized a chunk at a time and
   * its text is not kept, which is what holds a large sheet's memory to a
   * chunk instead of its whole decoded length, measured at hundreds of MiB.
   */
  const scanPart = (path: string, visitor: XmlVisitor): boolean => {
    const normalised = normalisePartPath(path);
    const cached = decoded.get(normalised);
    if (cached !== undefined) {
      readXmlPart(cached, normalised, visitor);
      return true;
    }
    const size = sizes.get(normalised);
    if (size === undefined) return false;
    charge(normalised, size);
    const scan = streamXmlPart(normalised, visitor);
    const text = partTextStream((chunk) => scan.write(chunk));
    const onChunk = (chunk: Uint8Array): void => {
      const fault = text.write(chunk);
      if (fault !== undefined) refuse(normalised, fault);
    };
    const found =
      source.stream === undefined
        ? wholeAsChunk(normalised, onChunk)
        : source.stream(normalised, onChunk);
    if (!found) return false;
    const fault = text.end();
    if (fault !== undefined) refuse(normalised, fault);
    scan.end();
    return true;
  };

  const wholeAsChunk = (
    path: string,
    onChunk: (chunk: Uint8Array) => void,
  ): boolean => {
    const bytes = source.read(path);
    if (bytes === undefined) return false;
    onChunk(bytes);
    return true;
  };

  const relationshipsFor = (
    partPath: string,
  ): ReadonlyMap<string, Relationship> => {
    const owner = normalisePartPath(partPath);
    const cached = relationshipCache.get(owner);
    if (cached !== undefined) return cached;
    const relsPath = relationshipsPathFor(owner);
    const xml = part(relsPath);
    const resolved =
      xml === undefined
        ? new Map<string, Relationship>()
        : readRelationships({ xml, relsPath, ownerPath: owner }, readXmlPart);
    relationshipCache.set(owner, resolved);
    return resolved;
  };

  const typesXml = part(contentTypesPath);
  if (typesXml === undefined) {
    throw fail(
      "not_a_package",
      `The archive carries no ${contentTypesPath}, so it is not an OOXML package.`,
    );
  }
  const contentTypes = readContentTypes(typesXml, readXmlPart);

  /**
   * Guard: the package-level relationships belong to the root, not to the
   * `_rels` folder that holds them, so their owner is the empty path. Naming
   * `_rels/.rels` as the owner resolves every relative target one folder too
   * deep and the main part is never found.
   */
  const packageRelationships = relationshipsFor("");

  return {
    part,
    scanPart,
    partBytes,
    partSize,
    parts: source.entries,
    relationshipsFor,
    packageRelationships,
    contentTypes,
  };
}
