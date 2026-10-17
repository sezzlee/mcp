export {
  createOoxmlReader,
  type OoxmlEnvironment,
  type OoxmlReader,
} from "./reader.js";
export { classifyContainerMagic } from "./container/magic.js";
export {
  extensionOf,
  normalisePartPath,
  relationshipsPathFor,
  resolveTarget,
} from "./container/names.js";
export { ooxmlNamespaces } from "./xml/namespaces.js";
export { selectAlternateContent } from "./xml/compatibility.js";
export { ooxmlLimits, type OoxmlLimits } from "./limits.js";
export type { XmlPartReader } from "./xml/read.js";
export type { OoxmlErrorCode, OoxmlErrorFactory } from "./model/errors.js";
export type {
  ContainerKind,
  ContentTypes,
  OpcPackage,
  PartEntry,
  PartSource,
  Relationship,
} from "./model/package.js";
export type { XmlNode, XmlVisitor } from "./model/xml.js";
