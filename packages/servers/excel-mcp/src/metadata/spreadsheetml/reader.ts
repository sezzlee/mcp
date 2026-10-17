import {
  createOoxmlReader,
  type OpcPackage,
  type XmlNode,
  type XmlPartReader,
  type XmlVisitor,
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

/**
 * One part reader's pass: the visitor a scan feeds, and what it read once the
 * scan is over. A part that is absent is never scanned, and `finish` then
 * reports what an empty part holds.
 */
export interface PartScan<T> {
  readonly visitor: XmlVisitor;
  finish(): T;
}

/** @returns a visitor that hands every event to each of `visitors` in turn. */
export function fanOut(visitors: readonly XmlVisitor[]): XmlVisitor {
  const opens = visitors.flatMap(({ onOpen }) =>
    onOpen === undefined ? [] : [onOpen],
  );
  const closes = visitors.flatMap(({ onClose }) =>
    onClose === undefined ? [] : [onClose],
  );
  const texts = visitors.flatMap(({ onText }) =>
    onText === undefined ? [] : [onText],
  );
  return {
    ...(opens.length === 0
      ? {}
      : {
          onOpen(node) {
            for (const open of opens) open(node);
          },
        }),
    ...(closes.length === 0
      ? {}
      : {
          onClose(local, uri) {
            for (const close of closes) close(local, uri);
          },
        }),
    ...(texts.length === 0
      ? {}
      : {
          onText(chunk) {
            for (const text of texts) text(chunk);
          },
        }),
  };
}

/**
 * Scans `part` once with `visitor`, or not at all when the package lacks it.
 *
 * Guard: the readers of a worksheet share a pass through `fanOut`, one for
 * its facts and one for its cells. Tokenizing is the largest share of a
 * profile, and each reader scanning the part on its own tokenized a sheet
 * eight times.
 */
export function scanPart(
  opc: OpcPackage,
  part: string,
  visitor: XmlVisitor,
): void {
  const xml = opc.part(part);
  if (xml !== undefined) readXmlPart(xml, part, visitor);
}
