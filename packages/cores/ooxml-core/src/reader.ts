import { ooxmlLimits, type OoxmlLimits } from "./limits.js";
import type { OoxmlErrorFactory } from "./model/errors.js";
import type { OpcPackage, PartSource } from "./model/package.js";
import type { XmlVisitor } from "./model/xml.js";
import { openPackage } from "./container/package.js";
import { createXmlPartReader, createXmlPartStreamer } from "./xml/read.js";
import { createZipSource } from "./zip/source.js";

export interface OoxmlEnvironment {
  readonly fail: OoxmlErrorFactory;
  readonly limits?: Partial<OoxmlLimits>;
}

export interface OoxmlReader {
  zipSource(bytes: Uint8Array): PartSource;
  openPackage(source: PartSource): OpcPackage;
  readXmlPart(xml: string, partName: string, visitor: XmlVisitor): void;
}

/**
 * Binds the reader to one consumer's error vocabulary.
 *
 * @param environment the error factory, and any ceilings that override the
 * defaults.
 * @returns the three entry points a format server needs.
 */
export function createOoxmlReader(environment: OoxmlEnvironment): OoxmlReader {
  const limits: OoxmlLimits = { ...ooxmlLimits, ...environment.limits };
  const fail = environment.fail;
  const readXmlPart = createXmlPartReader(fail);
  const streamXmlPart = createXmlPartStreamer(fail);
  return {
    zipSource: (bytes) => createZipSource(bytes, { fail, limits }),
    openPackage: (source) =>
      openPackage(source, { fail, limits, readXmlPart, streamXmlPart }),
    readXmlPart,
  };
}
