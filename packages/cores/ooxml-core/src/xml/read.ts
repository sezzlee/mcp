import type { OoxmlErrorFactory } from "../model/errors.js";
import type { XmlVisitor } from "../model/xml.js";
import { namespaceSink } from "./scope.js";
import { createTokenizer, XmlSyntaxError } from "./tokenizer.js";

export type XmlPartReader = (
  xml: string,
  partName: string,
  visitor: XmlVisitor,
) => void;

/** One part's scan, fed its text in pieces. */
export interface XmlPartStream {
  write(text: string): void;
  end(): void;
}

export type XmlPartStreamer = (
  partName: string,
  visitor: XmlVisitor,
) => XmlPartStream;

/**
 * Builds the part scanner that takes a part's text in pieces.
 *
 * @param fail the consumer's error factory, used for `corrupt_package`.
 * @returns a scanner per part, in a single forward pass.
 */
export function createXmlPartStreamer(
  fail: OoxmlErrorFactory,
): XmlPartStreamer {
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
  return function streamXmlPart(partName, visitor) {
    const tokenizer = createTokenizer(namespaceSink(visitor));
    const checked = (step: () => void): void => {
      try {
        step();
      } catch (error) {
        if (!(error instanceof XmlSyntaxError)) throw error;
        throw fail(
          "corrupt_package",
          `'${partName}' is not well-formed XML: ${error.message}`,
        );
      }
    };
    return {
      write(text) {
        checked(() => tokenizer.write(text));
      },
      end() {
        checked(() => tokenizer.end());
      },
    };
  };
}

/**
 * Builds the part reader over a whole decoded part.
 *
 * @param fail the consumer's error factory, used for `corrupt_package`.
 * @returns a reader that scans one part in a single forward pass.
 */
export function createXmlPartReader(fail: OoxmlErrorFactory): XmlPartReader {
  const streamXmlPart = createXmlPartStreamer(fail);
  return function readXmlPart(xml, partName, visitor) {
    const stream = streamXmlPart(partName, visitor);
    stream.write(xml);
    stream.end();
  };
}
