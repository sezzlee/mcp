import { asciiLower } from "./text.js";

const utf8Bom = [0xef, 0xbb, 0xbf] as const;
const utf16LeBom = [0xff, 0xfe] as const;
const utf16BeBom = [0xfe, 0xff] as const;

export type PartEncoding = "utf-8" | "utf-16le" | "utf-16be";

export function startsWith(
  bytes: Uint8Array,
  prefix: readonly number[],
): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
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
  { readonly kind: "text"; readonly text: string } | PartTextFault;

export type PartTextFault =
  | { readonly kind: "malformed"; readonly encoding: PartEncoding }
  | { readonly kind: "no_byte_order_mark" }
  | { readonly kind: "unsupported"; readonly named: string };

/**
 * Guard: XML 1.0 section 4.3.3 has a UTF-16 entity begin with a byte order
 * mark, and the mark is what chose the decoding, so a part that names UTF-16
 * without one is not in the encoding it declares.
 *
 * Guard: a part that names a code page this reader does not decode would
 * otherwise be read as UTF-8 and fail later as malformed, which names the
 * wrong defect. utf-8 and the two utf-16 spellings are the ones the byte order
 * mark already resolved.
 */
function declarationFault(
  head: string,
  encoding: PartEncoding,
): PartTextFault | undefined {
  const named = declaredEncodingOf(head);
  if (named === undefined || named === encoding || named === "us-ascii") {
    return undefined;
  }
  if (named === "utf-16") {
    return encoding === "utf-8" ? { kind: "no_byte_order_mark" } : undefined;
  }
  return { kind: "unsupported", named };
}

/**
 * Guard: an OPC part may legally be UTF-16, so the byte order mark decides the
 * decoding before anything reads the prolog. Assuming UTF-8 turns a UTF-16 part
 * into mojibake that then fails as "not well-formed XML", which names the wrong
 * defect and sends the caller to re-save a file that was never malformed.
 */
function encodingOf(bytes: Uint8Array): {
  readonly encoding: PartEncoding;
  readonly body: Uint8Array;
} {
  if (startsWith(bytes, utf16LeBom)) {
    return { encoding: "utf-16le", body: bytes.subarray(2) };
  }
  if (startsWith(bytes, utf16BeBom)) {
    return { encoding: "utf-16be", body: bytes.subarray(2) };
  }
  return {
    encoding: "utf-8",
    body: startsWith(bytes, utf8Bom) ? bytes.subarray(3) : bytes,
  };
}

const markBytes = 3;
const declarationChars = 256;

type DecoderState =
  | { readonly kind: "sniffing"; readonly bytes: Uint8Array }
  | {
      readonly kind: "decoding";
      readonly decoder: TextDecoder;
      readonly encoding: PartEncoding;
      head: string | undefined;
    };

/** A part's bytes, decoded as they arrive. */
export interface PartTextStream {
  /**
   * @returns the fault the bytes so far settle, if any; once a stream has
   *   returned one it emits nothing more and returns it again.
   */
  write(bytes: Uint8Array): PartTextFault | undefined;
  end(): PartTextFault | undefined;
}

/**
 * Decodes a part in pieces, handing its text to `emit` once the encoding its
 * declaration names has been checked against the byte order mark's.
 *
 * Guard: decoding is fatal on a malformed sequence. A replacing decoder turns
 * bytes that are not the encoding into U+FFFD, which is a legal character, so
 * a damaged part would read as text nobody wrote; XML 1.0 makes it a fatal
 * error. No part in the corpus's 15,933 fails strict decoding.
 */
export function partTextStream(emit: (text: string) => void): PartTextStream {
  let state: DecoderState = { kind: "sniffing", bytes: new Uint8Array(0) };
  let refused: PartTextFault | undefined;

  const pass = (
    decoding: Extract<DecoderState, { kind: "decoding" }>,
    text: string,
    final: boolean,
  ): PartTextFault | undefined => {
    if (decoding.head === undefined) {
      if (text !== "") emit(text);
      return undefined;
    }
    const head = decoding.head + text;
    if (head.length < declarationChars && !final) {
      decoding.head = head;
      return undefined;
    }
    decoding.head = undefined;
    const fault = declarationFault(head, decoding.encoding);
    if (fault !== undefined) return fault;
    if (head !== "") emit(head);
    return undefined;
  };

  const feed = (
    bytes: Uint8Array,
    final: boolean,
  ): PartTextFault | undefined => {
    let body = bytes;
    if (state.kind === "sniffing") {
      const seen = new Uint8Array(state.bytes.length + bytes.length);
      seen.set(state.bytes);
      seen.set(bytes, state.bytes.length);
      if (seen.length < markBytes && !final) {
        state = { kind: "sniffing", bytes: seen };
        return undefined;
      }
      const chosen = encodingOf(seen);
      body = chosen.body;
      state = {
        kind: "decoding",
        decoder: new TextDecoder(chosen.encoding, { fatal: true }),
        encoding: chosen.encoding,
        head: "",
      };
    }
    let text: string;
    try {
      text = state.decoder.decode(body, { stream: !final });
    } catch {
      return { kind: "malformed", encoding: state.encoding };
    }
    return pass(state, text, final);
  };

  const settle = (
    fault: PartTextFault | undefined,
  ): PartTextFault | undefined => {
    refused = fault;
    return fault;
  };

  return {
    write: (bytes) => refused ?? settle(feed(bytes, false)),
    end: () => refused ?? settle(feed(new Uint8Array(0), true)),
  };
}

/** Decodes a whole part and checks it against the encoding it declares. */
export function partText(bytes: Uint8Array): PartText {
  const pieces: string[] = [];
  const stream = partTextStream((text) => pieces.push(text));
  const fault = stream.write(bytes) ?? stream.end();
  return fault ?? { kind: "text", text: pieces.join("") };
}
