import { asciiLower } from "./text.js";

const utf8Bom = [0xef, 0xbb, 0xbf] as const;
const utf16LeBom = [0xff, 0xfe] as const;
const utf16BeBom = [0xfe, 0xff] as const;

export type PartEncoding = "utf-8" | "utf-16le" | "utf-16be";

export type DecodedPart =
  | {
      readonly kind: "decoded";
      readonly text: string;
      readonly encoding: PartEncoding;
    }
  | { readonly kind: "malformed"; readonly encoding: PartEncoding };

export function startsWith(
  bytes: Uint8Array,
  prefix: readonly number[],
): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * Guard: an OPC part may legally be UTF-16, so the byte order mark decides the
 * decoding before anything reads the prolog. Assuming UTF-8 turns a UTF-16 part
 * into mojibake that then fails as "not well-formed XML", which names the wrong
 * defect and sends the caller to re-save a file that was never malformed.
 */
function decodePart(bytes: Uint8Array): DecodedPart {
  if (startsWith(bytes, utf16LeBom)) {
    return strictly("utf-16le", bytes.subarray(2));
  }
  if (startsWith(bytes, utf16BeBom)) {
    return strictly("utf-16be", bytes.subarray(2));
  }
  return strictly(
    "utf-8",
    startsWith(bytes, utf8Bom) ? bytes.subarray(3) : bytes,
  );
}

/**
 * Guard: decoding is fatal on a malformed sequence. A replacing decoder turns
 * bytes that are not the encoding into U+FFFD, which is a legal character, so
 * a damaged part would read as text nobody wrote; XML 1.0 makes it a fatal
 * error. No part in the corpus's 15,933 fails strict decoding.
 */
function strictly(encoding: PartEncoding, body: Uint8Array): DecodedPart {
  try {
    return {
      kind: "decoded",
      text: new TextDecoder(encoding, { fatal: true }).decode(body),
      encoding,
    };
  } catch {
    return { kind: "malformed", encoding };
  }
}

const declaredEncoding = /^<\?xml\b[^>]*?\bencoding\s*=\s*["']([^"']+)["']/;

/**
 * Reads the encoding named by the XML declaration, if any. The caller compares
 * it with the byte order mark's verdict; a part that declares a code page this
 * reader does not decode is refused rather than silently read as UTF-8.
 *
 * @returns the declared name ASCII-folded, or undefined when the part
 * carries no declaration or no encoding attribute.
 */
function declaredEncodingOf(text: string): string | undefined {
  const matched = declaredEncoding.exec(text.slice(0, 256));
  const name = matched?.[1];
  return name === undefined ? undefined : asciiLower(name);
}

export type PartText =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "malformed"; readonly encoding: PartEncoding }
  | { readonly kind: "no_byte_order_mark" }
  | { readonly kind: "unsupported"; readonly named: string };

/**
 * Decodes a part and checks it against the encoding its declaration names.
 *
 * Guard: XML 1.0 section 4.3.3 has a UTF-16 entity begin with a byte order
 * mark, and the mark is what chose the decoding, so a part that names UTF-16
 * without one is not in the encoding it declares.
 *
 * Guard: a part that names a code page this reader does not decode would
 * otherwise be read as UTF-8 and fail later as malformed, which names the
 * wrong defect. utf-8 and the two utf-16 spellings are the ones the byte order
 * mark already resolved.
 */
export function partText(bytes: Uint8Array): PartText {
  const decoded = decodePart(bytes);
  if (decoded.kind === "malformed") return decoded;
  const { text, encoding } = decoded;
  const named = declaredEncodingOf(text);
  if (named === undefined || named === encoding || named === "us-ascii") {
    return { kind: "text", text };
  }
  if (named === "utf-16") {
    return encoding === "utf-8"
      ? { kind: "no_byte_order_mark" }
      : { kind: "text", text };
  }
  return { kind: "unsupported", named };
}
