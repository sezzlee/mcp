import type { BackendResponse } from "./error-mapping.js";

/**
 * Turns a backend's response bytes into the text the mapper reads, or into base64 when they are not
 * text. The charset is the one the content type names, UTF-8 by default, and decoding is strict:
 * a lenient decoder replaces every byte it cannot read with U+FFFD, so an image or a PDF would
 * reach the agent as a string that no longer holds its bytes.
 */
export function decodeResponseBody(
  bytes: Uint8Array,
  contentType: string | undefined,
): Pick<BackendResponse, "body" | "bodyEncoding"> {
  if (bytes.byteLength === 0) {
    return {};
  }
  try {
    return { body: decoderFor(contentType).decode(bytes) };
  } catch {
    return {
      body: Buffer.from(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).toString("base64"),
      bodyEncoding: "base64",
    };
  }
}

function decoderFor(contentType: string | undefined): TextDecoder {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(
    contentType ?? "",
  )?.[1];
  if (charset !== undefined) {
    try {
      return new TextDecoder(charset, { fatal: true });
    } catch {
      return new TextDecoder("utf-8", { fatal: true });
    }
  }
  return new TextDecoder("utf-8", { fatal: true });
}
