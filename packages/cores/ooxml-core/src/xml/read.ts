import type { OoxmlErrorFactory } from "../model/errors.js";
import type { XmlVisitor } from "../model/xml.js";
import { namespaceSink } from "./scope.js";
import { createTokenizer, XmlSyntaxError } from "./tokenizer.js";

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
   * Guard: the visitor sees `(uri, local)`, never the spelled tag, so a part
   * written with a namespace prefix — `<x:dataValidation>`, which every .NET
   * writer emits — is indistinguishable from the unprefixed form at the call
   * site. Matching the spelled tag is the defect this reader exists to avoid.
   *
   * Guard: an error a visitor throws is its own refusal, not a parse failure.
   * It stops the scan and reaches the caller unchanged, instead of being
   * reported as malformed XML under the wrong code.
   */
  return function readXmlPart(xml, partName, visitor) {
    const tokenizer = createTokenizer(namespaceSink(visitor));
    try {
      tokenizer.write(xml);
      tokenizer.end();
    } catch (error) {
      if (!(error instanceof XmlSyntaxError)) throw error;
      throw fail(
        "corrupt_package",
        `'${partName}' is not well-formed XML: ${error.message}`,
      );
    }
  };
}
