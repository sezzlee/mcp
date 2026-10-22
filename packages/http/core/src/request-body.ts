import { SezzleeArgumentError } from "./errors.js";
import { invokeLimits } from "./invoke-guard.js";
import type {
  FileSource,
  FormBinding,
  FormFieldBinding,
  RequestTemplate,
} from "./request-template.js";
import {
  isBinaryMediaType,
  isJsonMediaType,
  jsonMediaType,
  multipartMediaType,
  textMediaType,
  urlEncodedMediaType,
} from "./request-template.js";
import { formatScalar, memberKey, percentEncode } from "./wire-encoding.js";

export type BodyValue =
  Record<string, unknown> | readonly unknown[] | string | number | boolean;

export type FileContent =
  | {
      readonly source: "text";
      readonly text: string;
      readonly filename: string;
      readonly mediaType: string;
    }
  | {
      readonly source: "base64";
      readonly base64: string;
      readonly byteLength: number;
      readonly filename: string;
      readonly mediaType: string;
    }
  | {
      readonly source: "ref";
      readonly ref: string;
      /** What the agent sent; the SDK prefers it over what the resolver reports. */
      readonly filename?: string;
      readonly mediaType?: string;
      /** The last rung of the ladder, after the agent and the resolver. */
      readonly fallbackFilename: string;
      readonly fallbackMediaType: string;
    };

export type ComposedPart =
  | { readonly name: string; readonly value: string }
  | { readonly name: string; readonly file: FileContent };

export type ComposedBody =
  | {
      readonly kind: "json";
      readonly contentType: string;
      readonly value: BodyValue;
    }
  | {
      readonly kind: "text";
      readonly contentType: string;
      readonly value: string;
    }
  | {
      readonly kind: "urlencoded";
      readonly contentType: string;
      readonly encoded: string;
    }
  | {
      readonly kind: "multipart";
      readonly contentType: string;
      readonly parts: readonly ComposedPart[];
    }
  | {
      readonly kind: "binary";
      readonly contentType: string;
      readonly file: FileContent;
    };

export interface ComposeLimits {
  /** Decoded `base64` bytes summed over one call; `text` and `ref` do not count. */
  readonly maxInlineFileBytes?: number;
}

const fileArgumentKeys = [
  "text",
  "base64",
  "ref",
  "name",
  "mediaType",
] as const;

/**
 * Guard: RFC 4648 §4 exactly. `Buffer.from` accepts almost anything, so without one strict gate an
 * argument with stray characters would decode to bytes the agent never sent.
 */
const strictBase64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Guard: the agent's filename reaches the backend's `IFormFile.FileName` / multer's `originalname`,
 * which handlers commonly join onto a directory. A separator or a quote in it is a path traversal
 * or a broken `Content-Disposition`, not a name.
 */
const unsafeFilename = /["\r\n\0/\\]/;

const mediaTypeGrammar =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[^"\r\n\\]*"))*$/;

function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidFile(field: string, detail: string): SezzleeArgumentError {
  return new SezzleeArgumentError(
    "invalid_file_argument",
    `File argument '${field}' ${detail}`,
  );
}

function defaultMediaTypeOf(
  binding: Extract<FormFieldBinding, { kind: "file" }>,
  fallback: string,
): string {
  const declared = binding.mediaType;
  return declared !== undefined &&
    !declared.includes("*") &&
    declared !== "application/octet-stream"
    ? declared
    : fallback;
}

/**
 * Reads one file argument.
 *
 * @param sources the sources this template offers; an unoffered source is an unknown key, so the
 * refusal never mentions `ref` to an agent whose host bound no resolver.
 */
function readFile(
  value: unknown,
  field: string,
  binding: Extract<FormFieldBinding, { kind: "file" }>,
  sources: ReadonlySet<FileSource>,
): FileContent {
  const offered = fileArgumentKeys.filter(
    (key) =>
      (key !== "text" && key !== "base64" && key !== "ref") || sources.has(key),
  );
  const shape = `must be an object with exactly one of ${offered
    .filter((key) => key !== "name" && key !== "mediaType")
    .join(", ")}.`;
  if (!isPlainObject(value)) {
    throw invalidFile(field, shape);
  }
  const unknown = Object.keys(value).filter(
    (key) => !(offered as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw invalidFile(
      field,
      `has unknown key(s): ${unknown.join(", ")}. Allowed: ${offered.join(", ")}.`,
    );
  }
  const present = (["text", "base64", "ref"] as const).filter(
    (key) => value[key] !== undefined,
  );
  if (present.length !== 1) {
    throw invalidFile(field, shape);
  }
  const source = present[0] as FileSource;
  const content = value[source];
  if (typeof content !== "string") {
    throw invalidFile(field, `'${source}' must be a string.`);
  }
  const name = value["name"];
  if (name !== undefined) {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      unsafeFilename.test(name)
    ) {
      throw invalidFile(
        field,
        "'name' must be a non-empty filename without quotes, slashes, backslashes or control characters.",
      );
    }
  }
  const mediaType = value["mediaType"];
  if (mediaType !== undefined) {
    if (typeof mediaType !== "string" || !mediaTypeGrammar.test(mediaType)) {
      throw invalidFile(
        field,
        "'mediaType' must be a media type such as text/csv.",
      );
    }
  }
  switch (source) {
    case "text":
      return {
        source,
        text: content,
        filename: name ?? binding.name,
        mediaType:
          mediaType ?? defaultMediaTypeOf(binding, "text/plain; charset=utf-8"),
      };
    case "base64":
      if (!strictBase64.test(content)) {
        throw invalidFile(
          field,
          "'base64' must be standard base64 (RFC 4648 section 4) with padding and no line breaks.",
        );
      }
      return {
        source,
        base64: content,
        byteLength: base64ByteLength(content),
        filename: name ?? binding.name,
        mediaType:
          mediaType ?? defaultMediaTypeOf(binding, "application/octet-stream"),
      };
    case "ref":
      if (content.length === 0) {
        throw invalidFile(field, "'ref' must not be empty.");
      }
      return {
        source,
        ref: content,
        ...(name === undefined ? {} : { filename: name }),
        ...(mediaType === undefined ? {} : { mediaType }),
        fallbackFilename: binding.name,
        fallbackMediaType: defaultMediaTypeOf(
          binding,
          "application/octet-stream",
        ),
      };
  }
}

type Emit =
  | { readonly name: string; readonly value: string }
  | { readonly name: string; readonly file: FileContent };

/**
 * Walks the typed fields in declaration order and emits one entry per wire key.
 *
 * Both encodings share this walk so a type rule cannot hold for one and not the other; they differ
 * only in how a member key is spelled and whether a file is allowed at all, which the template
 * already refused for urlencoded.
 */
function emitFields(
  form: FormBinding,
  value: Readonly<Record<string, unknown>>,
  sources: ReadonlySet<FileSource>,
  encodeName: (name: string) => string,
): Emit[] {
  const out: Emit[] = [];
  for (const field of form.fields) {
    const item = value[field.name];
    if (item === undefined) {
      continue;
    }
    if (item === null) {
      throw new SezzleeArgumentError(
        "null_not_allowed",
        `Body argument '${field.name}' cannot be null; omit it instead.`,
      );
    }
    switch (field.kind) {
      case "object": {
        if (!isPlainObject(item)) {
          throw new SezzleeArgumentError(
            "invalid_type",
            `Body argument '${field.name}' must be an object.`,
          );
        }
        const declared = new Set(field.members.map((member) => member.name));
        const unknown = Object.keys(item).filter((name) => !declared.has(name));
        if (unknown.length > 0) {
          throw new SezzleeArgumentError(
            "unknown_argument",
            `Unknown argument(s): ${unknown.map((name) => `${field.name}.${name}`).join(", ")}. Allowed: ${field.members
              .map((member) => `${field.name}.${member.name}`)
              .sort()
              .join(", ")}.`,
          );
        }
        for (const member of field.members) {
          const memberValue = item[member.name];
          if (memberValue === undefined) {
            continue;
          }
          const slot = {
            name: `${field.name}.${member.name}`,
            kind: member.kind,
          };
          if (memberValue === null) {
            throw new SezzleeArgumentError(
              "null_not_allowed",
              `Body argument '${slot.name}' cannot be null; omit it instead.`,
            );
          }
          const key = memberKey(
            field.name,
            member.name,
            form.notation,
            encodeName,
          );
          const items = member.isArray === true ? memberValue : [memberValue];
          if (!Array.isArray(items)) {
            throw new SezzleeArgumentError(
              "invalid_type",
              `Body argument '${slot.name}' must be an array.`,
            );
          }
          for (const element of items) {
            out.push({
              name: key,
              value: formatScalar(element, slot, "invalid_type"),
            });
          }
        }
        break;
      }
      case "file": {
        const items = field.isArray === true ? item : [item];
        if (!Array.isArray(items)) {
          throw new SezzleeArgumentError(
            "invalid_type",
            `Body argument '${field.name}' must be an array.`,
          );
        }
        items.forEach((element, index) => {
          const label =
            field.isArray === true ? `${field.name}[${index}]` : field.name;
          out.push({
            name: encodeName(field.name),
            file: readFile(element, label, field, sources),
          });
        });
        break;
      }
      default: {
        const items = field.isArray === true ? item : [item];
        if (!Array.isArray(items)) {
          throw new SezzleeArgumentError(
            "invalid_type",
            `Body argument '${field.name}' must be an array.`,
          );
        }
        for (const element of items) {
          out.push({
            name: encodeName(field.name),
            value: formatScalar(element, field, "invalid_type"),
          });
        }
      }
    }
  }
  return out;
}

function assertInlineBudget(
  emitted: readonly Emit[],
  limits: ComposeLimits | undefined,
  sources: ReadonlySet<FileSource>,
): void {
  const limit = limits?.maxInlineFileBytes ?? invokeLimits.maxInlineFileBytes;
  let total = 0;
  for (const entry of emitted) {
    if ("file" in entry && entry.file.source === "base64") {
      total += entry.file.byteLength;
    }
  }
  if (total > limit) {
    const advice = sources.has("ref")
      ? "Send the file as a 'ref' instead."
      : "Send a smaller file.";
    throw new SezzleeArgumentError(
      "file_too_large",
      `The base64 file arguments decode to ${total} bytes, over the inline limit of ${limit} bytes. ${advice}`,
    );
  }
}

/**
 * Encodes the body value the composer collected into the template's media type.
 *
 * @param value the field-mode object, or the body root argument's value.
 * @returns `undefined` only when `value` is.
 */
export function encodeBody(
  template: RequestTemplate,
  value: unknown,
  limits?: ComposeLimits,
): ComposedBody | undefined {
  if (value === undefined) {
    return undefined;
  }
  const contentType = template.contentType ?? jsonMediaType;
  if (isJsonMediaType(contentType)) {
    return { kind: "json", contentType, value: value as BodyValue };
  }
  if (isBinaryMediaType(contentType)) {
    const sources = template.fileSources ?? new Set<FileSource>();
    const field = template.bodyRoot ?? "body";
    const file = readFile(value, field, { name: field, kind: "file" }, sources);
    assertInlineBudget([{ name: field, file }], limits, sources);
    return { kind: "binary", contentType, file };
  }
  if (contentType === textMediaType) {
    if (typeof value !== "string") {
      throw new SezzleeArgumentError(
        "invalid_type",
        `Argument '${template.bodyRoot ?? "body"}' must be of type string.`,
      );
    }
    return { kind: "text", contentType, value };
  }
  const form = template.form as FormBinding;
  if (!isPlainObject(value)) {
    throw new SezzleeArgumentError(
      "invalid_type",
      `Argument '${template.bodyRoot ?? "body"}' must be an object.`,
    );
  }
  if (template.bodyRoot !== undefined) {
    const declared = new Set(form.fields.map((field) => field.name));
    const unknown = Object.keys(value).filter((name) => !declared.has(name));
    if (unknown.length > 0) {
      throw new SezzleeArgumentError(
        "unknown_argument",
        `Unknown argument(s): ${unknown.map((name) => `${template.bodyRoot}.${name}`).join(", ")}. Allowed: ${[
          ...declared,
        ]
          .map((name) => `${template.bodyRoot}.${name}`)
          .sort()
          .join(", ")}.`,
      );
    }
  }
  const sources = template.fileSources ?? new Set<FileSource>();
  if (contentType === urlEncodedMediaType) {
    const emitted = emitFields(form, value, sources, percentEncode);
    return {
      kind: "urlencoded",
      contentType,
      encoded: emitted
        .map((entry) =>
          "value" in entry ? `${entry.name}=${percentEncode(entry.value)}` : "",
        )
        .join("&"),
    };
  }
  const emitted = emitFields(form, value, sources, (name) => name);
  assertInlineBudget(emitted, limits, sources);
  return { kind: "multipart", contentType: multipartMediaType, parts: emitted };
}
