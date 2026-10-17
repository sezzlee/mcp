import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SaxesParser } from "saxes";
import { partText } from "../../src/primitives/bytes.js";
import { namespaceSink } from "../../src/xml/scope.js";
import {
  createTokenizer,
  XmlSyntaxError,
  type TokenSink,
} from "../../src/xml/tokenizer.js";

export interface ConformanceCase {
  readonly id: string;
  readonly type: string;
  readonly path: string;
  readonly output: string | undefined;
  readonly scope:
    "in" | "xml-1.1" | "earlier-edition" | "not-namespaced" | "error-type";
}

function attributesOf(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of tag.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) {
    const [, key, value] = match;
    if (key !== undefined && value !== undefined) found.set(key, value);
  }
  return found;
}

/**
 * Lists the suite's test cases. The suite's own manifest pulls its parts in
 * through external entities, which this reader refuses by design, so the
 * entity table and the TEST elements are read with patterns instead.
 */
export function conformanceCases(root: string): readonly ConformanceCase[] {
  const main = readFileSync(join(root, "xmlconf.xml"), "utf8");
  const manifests = [...main.matchAll(/<!ENTITY\s+\S+\s+SYSTEM\s+"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((path): path is string => path !== undefined)
    .map((path) => join(root, path))
    .filter((path) => existsSync(path));
  const cases: ConformanceCase[] = [];
  for (const manifest of manifests) {
    const text = readFileSync(manifest, "utf8");
    for (const match of text.matchAll(/<TEST\s([^>]*)>/g)) {
      const attributes = attributesOf(match[1] ?? "");
      const uri = attributes.get("URI");
      if (uri === undefined) continue;
      const base = dirname(manifest);
      const recommendation = attributes.get("RECOMMENDATION") ?? "XML1.0";
      const edition = attributes.get("EDITION");
      const type = attributes.get("TYPE") ?? "";
      const output = attributes.get("OUTPUT");
      cases.push({
        id: attributes.get("ID") ?? uri,
        type,
        path: resolve(base, uri),
        output: output === undefined ? undefined : resolve(base, output),
        scope:
          recommendation.endsWith("1.1") || attributes.get("VERSION") === "1.1"
            ? "xml-1.1"
            : edition !== undefined && !edition.split(/\s+/).includes("5")
              ? "earlier-edition"
              : attributes.get("NAMESPACE") === "no"
                ? "not-namespaced"
                : type === "error"
                  ? "error-type"
                  : "in",
      });
    }
  }
  return cases;
}

function escaped(text: string): string {
  let out = "";
  for (const character of text) {
    switch (character) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      case "\t":
        out += "&#9;";
        break;
      case "\n":
        out += "&#10;";
        break;
      case "\r":
        out += "&#13;";
        break;
      default:
        out += character;
    }
  }
  return out;
}

/**
 * James Clark's canonical form (xmltest/canonxml.html), built from the
 * tokenizer's events: attributes sorted by name, an empty element written as
 * a start and an end tag, processing instructions kept, comments dropped.
 */
function canonicalSink(): { readonly sink: TokenSink; text(): string } {
  let out = "";
  return {
    sink: {
      startTag(name, attributes, empty) {
        const sorted = [...attributes].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );
        out += `<${name}${sorted.map((attribute) => ` ${attribute.name}="${escaped(attribute.value)}"`).join("")}>`;
        if (empty) out += `</${name}>`;
      },
      endTag(name) {
        out += `</${name}>`;
      },
      text(text) {
        out += escaped(text);
      },
      instruction(target, data) {
        out += `<?${target} ${data}?>`;
      },
    },
    text: () => out,
  };
}

function tee(first: TokenSink, second: TokenSink): TokenSink {
  return {
    startTag(name, attributes, empty) {
      first.startTag(name, attributes, empty);
      second.startTag(name, attributes, empty);
    },
    endTag(name) {
      first.endTag(name);
      second.endTag(name);
    },
    text(text) {
      first.text(text);
      second.text(text);
    },
    instruction(target, data) {
      first.instruction(target, data);
      second.instruction(target, data);
    },
  };
}

function saxesRefuses(text: string): boolean {
  const parser = new SaxesParser({ xmlns: true });
  let refused = false;
  parser.on("error", () => {
    refused = true;
  });
  try {
    parser.write(text).close();
  } catch {
    refused = true;
  }
  return refused;
}

export type CaseOutcome =
  | { readonly kind: "unsupported_encoding"; readonly encoding: string }
  | { readonly kind: "needs_dtd" }
  | { readonly kind: "error_in_dtd" }
  | { readonly kind: "read"; readonly canonical: string }
  | { readonly kind: "refused"; readonly reason: string };

const doctypePattern =
  /<!DOCTYPE\s+[^\s[>]+(\s+[^[>]*)?\s*(?:\[([\s\S]*?)\]\s*)?>/;

/**
 * Removes a DOCTYPE that cannot change what the document says: no external
 * subset, no entity, no attribute list (a default or a tokenized type would
 * change attribute values), no notation (the canonical form keeps it) and no
 * parameter entity reference.
 *
 * @returns the document without it, or undefined when the DTD matters.
 */
function withoutInertDoctype(text: string): string | undefined {
  const found = doctypePattern.exec(text);
  if (found === null) return undefined;
  const [whole, externalId = "", subset = ""] = found;
  if (externalId.trim() !== "") return undefined;
  if (/<!ENTITY|<!ATTLIST|<!NOTATION|%/.test(subset)) return undefined;
  return text.replace(whole, "");
}

/**
 * Reads one case the way a part is read: decoded by its byte order mark,
 * refused when it names an encoding the reader does not decode, then
 * tokenized in chunks of `chunk` characters. With `inertDoctype: "remove"`,
 * a DOCTYPE that cannot change the document is removed first; one that can
 * reports `needs_dtd`. With `"remove-if-body-fails"`, it is removed only when
 * saxes still refuses the document without it, so the case's error lies in
 * the body; otherwise the case reports `error_in_dtd`.
 */
export function runCase(
  path: string,
  chunk: number,
  inertDoctype: "keep" | "remove" | "remove-if-body-fails" = "keep",
): CaseOutcome {
  const read = partText(readFileSync(path));
  if (read.kind === "unsupported") {
    return { kind: "unsupported_encoding", encoding: read.named };
  }
  if (read.kind !== "text") {
    return { kind: "refused", reason: read.kind };
  }
  let text = read.text;
  if (text.includes("<!DOCTYPE") && inertDoctype !== "keep") {
    const stripped = withoutInertDoctype(text);
    if (stripped === undefined) return { kind: "needs_dtd" };
    if (inertDoctype === "remove-if-body-fails" && !saxesRefuses(stripped)) {
      return { kind: "error_in_dtd" };
    }
    text = stripped;
  }
  const canonical = canonicalSink();
  const tokenizer = createTokenizer(tee(namespaceSink({}), canonical.sink));
  try {
    for (let at = 0; at < text.length; at += chunk) {
      tokenizer.write(text.slice(at, at + chunk));
    }
    tokenizer.end();
  } catch (error) {
    if (error instanceof XmlSyntaxError)
      return { kind: "refused", reason: error.message };
    throw error;
  }
  return { kind: "read", canonical: canonical.text() };
}
