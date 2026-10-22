import { SezzleeArgumentError } from "./errors.js";
import type { ObjectNotation, ParameterKind } from "./request-template.js";

/**
 * Renders a delimiter for the query string. The caller appends the result raw,
 * never through {@link percentEncode}: encoders disagree on `,`
 * (`encodeURIComponent` leaves it, others escape it to `%2C`), so encoding the
 * delimiter would make the byte string depend on the encoder rather than the
 * spec. A literal space is illegal in a URL, hence `%20`.
 */
export function separatorFor(delimiter: string): string {
  return delimiter === " " ? "%20" : delimiter;
}

const reservedEscapes = /%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B|5B|5D)/g;

/**
 * Guard: `allowReserved` writes RFC 3986 reserved characters raw, except the ones that delimit the
 * query itself — `&`, `=`, `#`, `+` and `%` stay encoded, or a value would split into pairs, end
 * the query or be read back as a space.
 */
export function percentEncodeAllowingReserved(value: string): string {
  return percentEncode(value).replace(reservedEscapes, (escape) =>
    String.fromCharCode(parseInt(escape.slice(1), 16)),
  );
}

export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Guard: the structural character is appended raw, never through
 * {@link percentEncode}, for {@link separatorFor}'s reason — both languages'
 * encoders escape `[` and `]`, so encoding it would change what the backend's
 * parser reads. The group name and the member name each go through `encode`
 * on their own.
 */
export function memberKey(
  group: string,
  member: string,
  notation: ObjectNotation,
  encode: (value: string) => string,
): string {
  return notation === "dot"
    ? `${encode(group)}.${encode(member)}`
    : `${encode(group)}[${encode(member)}]`;
}

export function formatScalar(
  value: unknown,
  parameter: { readonly name: string; readonly kind: ParameterKind },
  errorCode: "invalid_path_type" | "invalid_type",
): string {
  switch (parameter.kind) {
    case "string":
      if (typeof value === "string") {
        return value;
      }
      break;
    case "integer":
      if (typeof value === "number" && Number.isSafeInteger(value)) {
        return String(value);
      }
      break;
    case "number":
      if (typeof value === "number") {
        return String(value);
      }
      break;
    case "boolean":
      if (typeof value === "boolean") {
        return String(value);
      }
      break;
  }
  throw new SezzleeArgumentError(
    errorCode,
    `Argument '${parameter.name}' must be of type ${parameter.kind}.`,
  );
}
