import { readXmlPart } from "../metadata/spreadsheetml/reader.js";
import { SezzleeExcelError } from "../platform/errors.js";

export interface XmlSpan {
  readonly start: number;
  readonly openEnd: number;
  closeStart: number;
  end: number;
  readonly qname: string;
  readonly local: string;
  readonly uri: string;
  readonly depth: number;
  readonly parent: string | undefined;
  readonly attributes: ReadonlyMap<string, string>;
  readonly namespaces: ReadonlyMap<string, string>;
}

export interface XmlPatch {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function* tags(
  xml: string,
): Generator<{ start: number; end: number; text: string }> {
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start === -1) return;
    const special = xml.startsWith("<!--", start)
      ? "-->"
      : xml.startsWith("<![CDATA[", start)
        ? "]]>"
        : xml.startsWith("<?", start)
          ? "?>"
          : undefined;
    if (special !== undefined) {
      const end = xml.indexOf(special, start + 2);
      if (end === -1)
        throw new SezzleeExcelError(
          "corrupt_workbook",
          "An XML construct is incomplete.",
        );
      cursor = end + special.length;
      continue;
    }
    let quote = "";
    cursor = start + 1;
    while (cursor < xml.length) {
      const character = xml[cursor];
      if (quote !== "") {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
      cursor += 1;
    }
    cursor += 1;
    yield { start, end: cursor, text: xml.slice(start, cursor) };
  }
}

export function scanXml(
  xml: string,
  part: string,
  close: (node: XmlSpan) => void,
  open?: (node: XmlSpan) => void,
): void {
  const lexical = tags(xml);
  const stack: XmlSpan[] = [];
  readXmlPart(xml, part, {
    onOpen(node) {
      const token = lexical.next().value;
      if (token === undefined)
        throw new SezzleeExcelError(
          "corrupt_workbook",
          "XML token positions are incomplete.",
        );
      const qname = /^<([^\s/>]+)/.exec(token.text)?.[1];
      if (qname === undefined)
        throw new SezzleeExcelError(
          "corrupt_workbook",
          "An XML name is missing.",
        );
      const attributes = new Map<string, string>();
      let bindings = stack.at(-1)?.namespaces ?? new Map<string, string>();
      const declarations = [
        ...token.text.matchAll(/\sxmlns(?::([^\s=]+))?\s*=/g),
      ];
      if (declarations.length > 0) {
        const next = new Map(bindings);
        for (const declaration of declarations) {
          const prefix = declaration[1] ?? "";
          const uri = node.namespaceOf(prefix);
          if (uri !== undefined) next.set(prefix, uri);
        }
        bindings = next;
      }
      for (const match of token.text.matchAll(
        /([^\s=<>]+)\s*=\s*(?:"[^"]*"|'[^']*')/g,
      )) {
        const name = match[1];
        if (name === undefined || name === "xmlns" || name.startsWith("xmlns:"))
          continue;
        const colon = name.indexOf(":");
        const value =
          colon === -1
            ? node.attr(name)
            : node.attr(
                name.slice(colon + 1),
                node.namespaceOf(name.slice(0, colon)),
              );
        if (value !== undefined) attributes.set(name, value);
      }
      const span: XmlSpan = {
        start: token.start,
        openEnd: token.end,
        closeStart: token.end,
        end: /\/\s*>$/.test(token.text) ? token.end : -1,
        qname,
        local: node.local,
        uri: node.uri,
        depth: stack.length,
        parent: stack.at(-1)?.local,
        attributes,
        namespaces: bindings,
      };
      stack.push(span);
      open?.(span);
    },
    onClose() {
      const span = stack.pop();
      if (span === undefined)
        throw new SezzleeExcelError(
          "corrupt_workbook",
          "An XML close has no owner.",
        );
      if (span.end === -1) {
        const token = lexical.next().value;
        if (token === undefined)
          throw new SezzleeExcelError(
            "corrupt_workbook",
            "An XML close position is missing.",
          );
        span.closeStart = token.start;
        span.end = token.end;
      }
      close(span);
    },
  });
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function xmlUnescape(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g,
    (_match, code: string) => {
      if (code.startsWith("#x"))
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      if (code.startsWith("#"))
        return String.fromCodePoint(Number(code.slice(1)));
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[code] ?? "";
    },
  );
}

export function attribute(
  xml: string,
  name: string,
  value: string | undefined,
): string {
  let end = 1;
  let quote = "";
  for (; end < xml.length; end += 1) {
    const ch = xml[end];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") break;
  }
  let header = xml.slice(0, end + 1);
  let found = false;
  for (const match of header.matchAll(
    /\s([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    if (match[1] !== name) continue;
    if (
      value !== undefined &&
      xmlUnescape(match[2] ?? match[3] ?? "") === value
    )
      return xml;
    header =
      header.slice(0, match.index) +
      (value === undefined ? "" : ` ${name}="${xmlEscape(value)}"`) +
      header.slice(match.index + match[0].length);
    found = true;
    break;
  }
  if (!found && value !== undefined)
    header = header.replace(
      /\/?>(?=$)/,
      (tail) => ` ${name}="${xmlEscape(value)}"${tail}`,
    );
  return header + xml.slice(end + 1);
}

export function applyXmlPatches(
  xml: string,
  patches: readonly XmlPatch[],
): string {
  const sorted = [...patches].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  let at = 0;
  const chunks: string[] = [];
  for (const patch of sorted) {
    if (patch.start < at || patch.end < patch.start)
      throw new SezzleeExcelError(
        "invalid_argument",
        "XML changes overlap; the operation cannot preserve this content.",
      );
    chunks.push(xml.slice(at, patch.start), patch.text);
    at = patch.end;
  }
  chunks.push(xml.slice(at));
  return chunks.join("");
}

export function replaceElementBody(
  xml: string,
  span: XmlSpan,
  body: string,
): string {
  const header = xml.slice(span.start, span.openEnd);
  return /\/\s*>$/.test(header)
    ? header.replace(/\/\s*>$/, ">") + body + `</${span.qname}>`
    : header + body + xml.slice(span.closeStart, span.end);
}
