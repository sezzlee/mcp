import { randomBytes } from "node:crypto";
import type { ComposedBody, FileContent } from "./request-body.js";

export interface ResolvedFile {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mediaType: string;
}

export type RefFile = Extract<FileContent, { source: "ref" }>;

export type RefResolver = (
  file: RefFile,
  field: string,
) => Promise<ResolvedFile>;

export interface WrittenBody {
  readonly contentType: string;
  readonly bytes: Buffer;
}

/**
 * Guard: a `Content-Disposition` quoted-string ends at `"` and a header ends at CR or LF, so each
 * is escaped the way the WHATWG form-data encoder escapes them. Field names come from the backend
 * and filenames from a resolver, neither of which the agent-side filename gate covers.
 */
function quoted(value: string): string {
  return value.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * Guard: multer decodes a bare `filename` as latin1 and mangles UTF-8 (form-body-probe N3), while
 * both multer and ASP.NET decode RFC 5987 `filename*` correctly (N3b).
 * A non-ASCII name therefore travels as an ASCII fallback plus `filename*`.
 */
function dispositionOf(name: string, filename?: string): string {
  const base = `form-data; name="${quoted(name)}"`;
  if (filename === undefined) {
    return base;
  }
  if (/^[\x20-\x7e]*$/.test(filename)) {
    return `${base}; filename="${quoted(filename)}"`;
  }
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_");
  const extended = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${base}; filename="${quoted(fallback)}"; filename*=UTF-8''${extended}`;
}

async function fileBytes(
  file: FileContent,
  field: string,
  resolveRef: RefResolver,
): Promise<ResolvedFile> {
  switch (file.source) {
    case "text":
      return {
        bytes: Buffer.from(file.text, "utf8"),
        filename: file.filename,
        mediaType: file.mediaType,
      };
    case "base64":
      return {
        bytes: Buffer.from(file.base64, "base64"),
        filename: file.filename,
        mediaType: file.mediaType,
      };
    case "ref":
      return resolveRef(file, field);
  }
}

/**
 * Serializes a composed body into the bytes and `Content-Type` the synthetic request carries.
 *
 * Refs are resolved in part order, one at a time: the deadline already bounds the whole call, and
 * resolving in parallel would let one slow ref hold every other resolver's buffer in memory.
 */
export async function writeBody(
  body: ComposedBody,
  resolveRef: RefResolver,
): Promise<WrittenBody> {
  switch (body.kind) {
    case "json":
      return {
        contentType: `${body.contentType}; charset=utf-8`,
        bytes: Buffer.from(JSON.stringify(body.value), "utf8"),
      };
    case "text":
      return {
        contentType: `${body.contentType}; charset=utf-8`,
        bytes: Buffer.from(body.value, "utf8"),
      };
    case "urlencoded":
      return {
        contentType: body.contentType,
        bytes: Buffer.from(body.encoded, "ascii"),
      };
    case "binary": {
      const file = await fileBytes(body.file, "body", resolveRef);
      return { contentType: body.contentType, bytes: Buffer.from(file.bytes) };
    }
    case "multipart": {
      const boundary = `----sezzlee-${randomBytes(16).toString("hex")}`;
      const chunks: Buffer[] = [];
      for (const part of body.parts) {
        chunks.push(Buffer.from(`--${boundary}\r\n`, "ascii"));
        if ("value" in part) {
          chunks.push(
            Buffer.from(
              `Content-Disposition: ${dispositionOf(part.name)}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`,
              "utf8",
            ),
            Buffer.from(part.value, "utf8"),
          );
        } else {
          const file = await fileBytes(part.file, part.name, resolveRef);
          chunks.push(
            Buffer.from(
              `Content-Disposition: ${dispositionOf(part.name, file.filename)}\r\nContent-Type: ${file.mediaType}\r\n\r\n`,
              "utf8",
            ),
            Buffer.from(file.bytes),
          );
        }
        chunks.push(Buffer.from("\r\n", "ascii"));
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`, "ascii"));
      return {
        contentType: `${body.contentType}; boundary=${boundary}`,
        bytes: Buffer.concat(chunks),
      };
    }
  }
}
