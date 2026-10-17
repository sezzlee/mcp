import type { Attribute, BenchNode, BenchVisitor } from "./events.ts";

const xmlNamespace = "http://www.w3.org/XML/1998/namespace";
const xmlnsNamespace = "http://www.w3.org/2000/xmlns/";

export class TokenizerError extends Error {}

const predefined: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

function decode(raw: string, at: number): string {
  if (!raw.includes("&")) return raw;
  let out = "";
  let from = 0;
  for (;;) {
    const amp = raw.indexOf("&", from);
    if (amp === -1) return out + raw.slice(from);
    const semi = raw.indexOf(";", amp);
    if (semi === -1)
      throw new TokenizerError(`unterminated reference at ${String(at + amp)}`);
    const name = raw.slice(amp + 1, semi);
    let replacement: string | undefined;
    if (name.startsWith("#x")) {
      const code = /^[0-9a-fA-F]+$/.test(name.slice(2))
        ? Number.parseInt(name.slice(2), 16)
        : Number.NaN;
      if (isXmlChar(code)) replacement = String.fromCodePoint(code);
    } else if (name.startsWith("#")) {
      const code = /^[0-9]+$/.test(name.slice(1))
        ? Number.parseInt(name.slice(1), 10)
        : Number.NaN;
      if (isXmlChar(code)) replacement = String.fromCodePoint(code);
    } else {
      replacement = predefined[name];
    }
    if (replacement === undefined) {
      throw new TokenizerError(
        `undefined entity '&${name};' at ${String(at + amp)}`,
      );
    }
    out += raw.slice(from, amp) + replacement;
    from = semi + 1;
  }
}

function lineEnds(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x9 || code === 0xa || code === 0xd;
}

function nodeOf(
  local: string,
  uri: string,
  attributes: readonly Attribute[],
): BenchNode {
  return {
    local,
    uri,
    attr(name, wanted = "") {
      for (const attribute of attributes) {
        if (attribute.local === name && attribute.uri === wanted)
          return attribute.value;
      }
      return undefined;
    },
    attributes: () => attributes,
  };
}

interface Open {
  readonly name: string;
  readonly local: string;
  readonly uri: string;
  readonly scope: ReadonlyMap<string, string>;
}

function split(name: string): {
  readonly prefix: string;
  readonly local: string;
} {
  const colon = name.indexOf(":");
  return colon === -1
    ? { prefix: "", local: name }
    : { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
}

/**
 * A namespace-aware tokenizer for the subset of XML an OOXML part is: no DTD,
 * no entity beyond the five predefined ones and character references. It
 * checks nesting, attribute syntax, duplicate attributes, unbound prefixes and
 * references, and normalises line ends and attribute whitespace as XML 1.0
 * requires. It does not check name characters; a production version would.
 */
export function tokenize(xml: string, visitor: BenchVisitor): void {
  const length = xml.length;
  let at = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: Open[] = [];
  let scope: ReadonlyMap<string, string> = new Map([["xml", xmlNamespace]]);
  let sawRoot = false;
  const { onOpen, onClose, onText } = visitor;
  while (at < length) {
    const lt = xml.indexOf("<", at);
    const end = lt === -1 ? length : lt;
    if (end > at) {
      const raw = xml.slice(at, end);
      if (stack.length === 0) {
        for (let index = 0; index < raw.length; index += 1) {
          if (!isSpace(raw.charCodeAt(index))) {
            throw new TokenizerError(
              `text outside the root element at ${String(at)}`,
            );
          }
        }
      } else if (onText !== undefined) {
        onText(decode(lineEnds(raw), at));
      }
    }
    if (lt === -1) break;
    const next = xml.charCodeAt(lt + 1);
    if (next === 0x3f) {
      const close = xml.indexOf("?>", lt + 2);
      if (close === -1)
        throw new TokenizerError(
          `unterminated processing instruction at ${String(lt)}`,
        );
      at = close + 2;
      continue;
    }
    if (next === 0x21) {
      if (xml.startsWith("<!--", lt)) {
        const close = xml.indexOf("-->", lt + 4);
        if (close === -1)
          throw new TokenizerError(`unterminated comment at ${String(lt)}`);
        at = close + 3;
        continue;
      }
      if (xml.startsWith("<![CDATA[", lt)) {
        const close = xml.indexOf("]]>", lt + 9);
        if (close === -1)
          throw new TokenizerError(
            `unterminated CDATA section at ${String(lt)}`,
          );
        if (stack.length === 0)
          throw new TokenizerError(
            `CDATA outside the root element at ${String(lt)}`,
          );
        if (onText !== undefined) onText(lineEnds(xml.slice(lt + 9, close)));
        at = close + 3;
        continue;
      }
      throw new TokenizerError(
        `a DOCTYPE or markup declaration at ${String(lt)}`,
      );
    }
    if (next === 0x2f) {
      const close = xml.indexOf(">", lt + 2);
      if (close === -1)
        throw new TokenizerError(`unterminated end tag at ${String(lt)}`);
      const name = xml.slice(lt + 2, close).trimEnd();
      const open = stack.pop();
      if (open === undefined || open.name !== name) {
        throw new TokenizerError(
          `end tag '${name}' does not match at ${String(lt)}`,
        );
      }
      onClose?.(open.local, open.uri);
      scope = open.scope;
      at = close + 1;
      continue;
    }
    if (sawRoot && stack.length === 0) {
      throw new TokenizerError(`a second root element at ${String(lt)}`);
    }
    let cursor = lt + 1;
    while (cursor < length) {
      const code = xml.charCodeAt(cursor);
      if (isSpace(code) || code === 0x2f || code === 0x3e) break;
      cursor += 1;
    }
    const name = xml.slice(lt + 1, cursor);
    if (name === "")
      throw new TokenizerError(`an empty tag name at ${String(lt)}`);
    const raw: { name: string; value: string }[] = [];
    let selfClosing = false;
    for (;;) {
      while (cursor < length && isSpace(xml.charCodeAt(cursor))) cursor += 1;
      const code = xml.charCodeAt(cursor);
      if (code === 0x3e) {
        cursor += 1;
        break;
      }
      if (code === 0x2f) {
        if (xml.charCodeAt(cursor + 1) !== 0x3e)
          throw new TokenizerError(
            `'/' not closing a tag at ${String(cursor)}`,
          );
        selfClosing = true;
        cursor += 2;
        break;
      }
      if (cursor >= length)
        throw new TokenizerError(`unterminated start tag at ${String(lt)}`);
      if (raw.length > 0 && !isSpace(xml.charCodeAt(cursor - 1))) {
        throw new TokenizerError(
          `attributes not separated by space at ${String(cursor)}`,
        );
      }
      const nameStart = cursor;
      while (cursor < length) {
        const c = xml.charCodeAt(cursor);
        if (c === 0x3d || isSpace(c) || c === 0x3e || c === 0x2f) break;
        cursor += 1;
      }
      const attributeName = xml.slice(nameStart, cursor);
      while (cursor < length && isSpace(xml.charCodeAt(cursor))) cursor += 1;
      if (attributeName === "" || xml.charCodeAt(cursor) !== 0x3d) {
        throw new TokenizerError(
          `an attribute without a value at ${String(nameStart)}`,
        );
      }
      cursor += 1;
      while (cursor < length && isSpace(xml.charCodeAt(cursor))) cursor += 1;
      const quote = xml.charCodeAt(cursor);
      if (quote !== 0x22 && quote !== 0x27)
        throw new TokenizerError(`an unquoted attribute at ${String(cursor)}`);
      const close = xml.indexOf(quote === 0x22 ? '"' : "'", cursor + 1);
      if (close === -1)
        throw new TokenizerError(
          `an unterminated attribute at ${String(cursor)}`,
        );
      const value = xml.slice(cursor + 1, close);
      if (value.includes("<"))
        throw new TokenizerError(
          `'<' in an attribute value at ${String(cursor)}`,
        );
      for (const seen of raw) {
        if (seen.name === attributeName)
          throw new TokenizerError(
            `a repeated attribute '${attributeName}' at ${String(nameStart)}`,
          );
      }
      raw.push({
        name: attributeName,
        value: decode(value.replace(/\r\n|[\t\n\r]/g, " "), cursor + 1),
      });
      cursor = close + 1;
    }
    const outer = scope;
    let declared: Map<string, string> | undefined;
    for (const attribute of raw) {
      if (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:")) {
        declared ??= new Map(outer);
        declared.set(
          attribute.name === "xmlns" ? "" : attribute.name.slice(6),
          attribute.value,
        );
      }
    }
    if (declared !== undefined) scope = declared;
    const element = split(name);
    const uri = scope.get(element.prefix);
    if (uri === undefined && element.prefix !== "") {
      throw new TokenizerError(
        `an unbound prefix '${element.prefix}' at ${String(lt)}`,
      );
    }
    const attributes: Attribute[] = [];
    for (const attribute of raw) {
      if (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:"))
        continue;
      const parts = split(attribute.name);
      if (parts.prefix === "") {
        attributes.push({
          uri: "",
          local: parts.local,
          value: attribute.value,
        });
        continue;
      }
      const attributeUri = scope.get(parts.prefix);
      if (attributeUri === undefined || attributeUri === xmlnsNamespace) {
        throw new TokenizerError(
          `an unbound prefix '${parts.prefix}' at ${String(lt)}`,
        );
      }
      attributes.push({
        uri: attributeUri,
        local: parts.local,
        value: attribute.value,
      });
    }
    sawRoot = true;
    onOpen?.(nodeOf(element.local, uri ?? "", attributes));
    if (selfClosing) {
      onClose?.(element.local, uri ?? "");
      scope = outer;
    } else {
      stack.push({ name, local: element.local, uri: uri ?? "", scope: outer });
    }
    at = cursor;
  }
  if (stack.length > 0)
    throw new TokenizerError("the part ends inside an element");
  if (!sawRoot) throw new TokenizerError("the part has no root element");
}
