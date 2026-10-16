import {
  createOoxmlReader,
  type XmlNode,
  type XmlPartReader,
} from "@sezzlee/ooxml-core";
import { failOoxml } from "./errors.js";

const reader = createOoxmlReader({ fail: failOoxml });

export const { openPackage: openOpcPackage, zipSource } = reader;

/**
 * ISO/IEC 29500 Strict spells every markup namespace under purl.oclc.org;
 * each maps onto the Transitional namespace the part readers match on.
 */
const transitionalOf: ReadonlyMap<string, string> = new Map([
  [
    "http://purl.oclc.org/ooxml/spreadsheetml/main",
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  ],
  [
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  ],
  [
    "http://purl.oclc.org/ooxml/drawingml/main",
    "http://schemas.openxmlformats.org/drawingml/2006/main",
  ],
  [
    "http://purl.oclc.org/ooxml/drawingml/spreadsheetDrawing",
    "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
  ],
]);

const strictOf: ReadonlyMap<string, string> = new Map(
  [...transitionalOf].map(([strict, transitional]) => [transitional, strict]),
);

function transitional(node: XmlNode): XmlNode {
  return {
    local: node.local,
    uri: transitionalOf.get(node.uri) ?? node.uri,
    attr(name, wanted = "") {
      const value = node.attr(name, wanted);
      if (value !== undefined) return value;
      const strict = strictOf.get(wanted);
      return strict === undefined ? undefined : node.attr(name, strict);
    },
  };
}

/**
 * Scans one part, presenting a Strict-conformant element as its Transitional
 * twin, so every part reader handles both conformance classes unchanged.
 *
 * Guard: an element already in a Transitional namespace is passed through
 * as it is, with no wrapper; this sits on the path of every cell of every
 * sheet, and only Strict files pay for the translation.
 */
export const readXmlPart: XmlPartReader = (xml, partName, visitor) => {
  const { onOpen, onClose, onText } = visitor;
  reader.readXmlPart(xml, partName, {
    ...(onOpen === undefined
      ? {}
      : {
          onOpen: (node) =>
            onOpen(transitionalOf.has(node.uri) ? transitional(node) : node),
        }),
    ...(onClose === undefined
      ? {}
      : {
          onClose: (local, uri) =>
            onClose(local, transitionalOf.get(uri) ?? uri),
        }),
    ...(onText === undefined ? {} : { onText }),
  });
};
