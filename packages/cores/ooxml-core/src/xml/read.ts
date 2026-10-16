import { SaxesParser, type SaxesAttributeNS } from "saxes";
import type { OoxmlErrorFactory } from "../model/errors.js";
import type { XmlNode, XmlVisitor } from "../model/xml.js";

function nodeFor(
  local: string,
  uri: string,
  attributes: Readonly<Record<string, SaxesAttributeNS>>,
): XmlNode {
  return {
    local,
    uri,
    attr(name, wanted = "") {
      for (const key in attributes) {
        if (!Object.hasOwn(attributes, key)) continue;
        const attribute = attributes[key];
        if (attribute === undefined) continue;
        if (attribute.local === name && attribute.uri === wanted) {
          return attribute.value;
        }
      }
      return undefined;
    },
  };
}

const namespaceAware = { xmlns: true } as const;

export type XmlPartReader = (
  xml: string,
  partName: string,
  visitor: XmlVisitor,
) => void;

/**
 * Builds the part reader.
 *
 * @param fail the consumer's error factory, used for `corrupt_package`.
 * @returns a reader that scans one part in a single forward pass.
 */
export function createXmlPartReader(fail: OoxmlErrorFactory): XmlPartReader {
  /**
   * Guard: `xmlns: true` is what makes every caller match on `(uri, local)`
   * rather than the spelled tag, so a part written with a namespace prefix —
   * `<x:dataValidation>`, which every .NET writer emits — is indistinguishable
   * from the unprefixed form at the call site. Matching the spelled tag is the
   * defect this reader exists to avoid.
   *
   * Guard: a DOCTYPE is refused rather than parsed. ECMA-376 Part 2 forbids a
   * DTD in an OPC part, so its presence means the bytes are not the part they
   * claim to be, and refusing keeps entity resolution off the table entirely.
   *
   * Guard: an error a visitor throws is its own refusal, not a parse failure.
   * It stops the scan and reaches the caller unchanged, instead of being
   * reported as malformed XML under the wrong code. saxes reports its own
   * errors through the handler above, so anything thrown here is the visitor's.
   */
  return function readXmlPart(xml, partName, visitor) {
    const parser = new SaxesParser<typeof namespaceAware>(namespaceAware);
    let failure: string | undefined;
    parser.on("error", (error) => {
      failure ??= error.message;
    });
    parser.on("doctype", () => {
      failure ??= "the part declares a DOCTYPE, which OPC forbids";
    });
    if (visitor.onOpen !== undefined) {
      const onOpen = visitor.onOpen;
      parser.on("opentag", (tag) => {
        if (failure !== undefined) return;
        onOpen(nodeFor(tag.local, tag.uri, tag.attributes));
      });
    }
    if (visitor.onClose !== undefined) {
      const onClose = visitor.onClose;
      parser.on("closetag", (tag) => {
        if (failure !== undefined) return;
        onClose(tag.local, tag.uri);
      });
    }
    if (visitor.onText !== undefined) {
      const onText = visitor.onText;
      parser.on("text", (text) => {
        if (failure !== undefined) return;
        onText(text);
      });
    }
    parser.write(xml).close();
    if (failure !== undefined) {
      throw fail(
        "corrupt_package",
        `'${partName}' is not well-formed XML: ${failure}`,
      );
    }
  };
}
