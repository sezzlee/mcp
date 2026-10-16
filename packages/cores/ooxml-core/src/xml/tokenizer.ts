import { asciiLower } from "../primitives/text.js";

export interface RawAttribute {
  readonly name: string;
  readonly value: string;
}

/** What the tokenizer reports, with names as written and references decoded. */
export interface TokenSink {
  startTag(
    name: string,
    attributes: readonly RawAttribute[],
    empty: boolean,
  ): void;
  endTag(name: string): void;
  text(text: string): void;
  instruction(target: string, data: string): void;
}

/** A failure of the XML itself, at a character offset into the part when known. */
export class XmlSyntaxError extends Error {
  readonly offset: number | undefined;

  constructor(message: string, offset?: number) {
    super(
      offset === undefined
        ? message
        : `${message} at character ${String(offset)}`,
    );
    this.offset = offset;
  }
}

export interface Tokenizer {
  write(chunk: string): void;
  end(): void;
}

/**
 * Guard: a Map, not an object literal, so `&constructor;` finds nothing
 * instead of a property every object inherits.
 */
const predefined: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

const notXmlChar = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const breaks = /[\t\n\r]/;
const declaration =
  /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.[0-9]+"|'1\.[0-9]+')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"[A-Za-z][-A-Za-z0-9._]*"|'[A-Za-z][-A-Za-z0-9._]*'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>$/;

/**
 * Guard: names repeat (`c`, `v`, `row` carry most of a sheet), so a name is
 * checked against the Name production once and remembered. The memory is
 * capped so a part of distinct names cannot grow it without bound.
 */
const maxRememberedNames = 4096;

const nameStartRanges: readonly (readonly [number, number])[] = [
  [0x3a, 0x3a],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
  [0xc0, 0xd6],
  [0xd8, 0xf6],
  [0xf8, 0x2ff],
  [0x370, 0x37d],
  [0x37f, 0x1fff],
  [0x200c, 0x200d],
  [0x2070, 0x218f],
  [0x2c00, 0x2fef],
  [0x3001, 0xd7ff],
  [0xf900, 0xfdcf],
  [0xfdf0, 0xfffd],
  [0x10000, 0xeffff],
];

const nameRanges: readonly (readonly [number, number])[] = [
  ...nameStartRanges,
  [0x2d, 0x2e],
  [0x30, 0x39],
  [0xb7, 0xb7],
  [0x300, 0x36f],
  [0x203f, 0x2040],
];

function within(
  ranges: readonly (readonly [number, number])[],
  code: number,
): boolean {
  for (const [low, high] of ranges) {
    if (code >= low && code <= high) return true;
  }
  return false;
}

/** The Name production of XML 1.0 (Fifth Edition) section 2.3. */
function isName(candidate: string): boolean {
  let first = true;
  for (const character of candidate) {
    const code = character.codePointAt(0) ?? 0;
    if (!within(first ? nameStartRanges : nameRanges, code)) return false;
    first = false;
  }
  return !first;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x9 || code === 0xa || code === 0xd;
}

function isAsciiNameChar(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f ||
    code === 0x3a ||
    code === 0x2d ||
    code === 0x2e
  );
}

function isXmlCharCode(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

function lineEnds(raw: string): string {
  return raw.includes("\r") ? raw.replace(/\r\n?/g, "\n") : raw;
}

/**
 * The XML 1.0 tokenizer for an OOXML part: elements, attributes, text, CDATA,
 * comments and processing instructions, with the five predefined entities and
 * character references. A DOCTYPE is refused, so no other entity can exist.
 *
 * Input may arrive in chunks. A construct cut by a chunk boundary waits for
 * more, and is retried only once the buffer has doubled, so a construct split
 * over many chunks is rescanned a logarithmic number of times, not once per
 * chunk.
 */
export function createTokenizer(sink: TokenSink): Tokenizer {
  let buffer = "";
  let base = 0;
  let prolog: number | undefined;
  let retryAt = 0;
  let ended = false;
  const open: string[] = [];
  let sawRoot = false;
  const names = new Map<string, boolean>();

  const fail = (message: string, at: number): never => {
    throw new XmlSyntaxError(message, base + at);
  };

  const checkName = (candidate: string, at: number): void => {
    const known = names.get(candidate);
    if (known === true) return;
    let ascii = candidate.length > 0;
    const first = candidate.charCodeAt(0);
    if (
      ascii &&
      ((first >= 0x30 && first <= 0x39) || first === 0x2d || first === 0x2e)
    ) {
      fail(`'${candidate}' is not a valid name`, at);
    }
    for (let index = 0; ascii && index < candidate.length; index += 1) {
      if (!isAsciiNameChar(candidate.charCodeAt(index))) ascii = false;
    }
    if (!ascii && !isName(candidate))
      fail(`'${candidate}' is not a valid name`, at);
    if (names.size < maxRememberedNames) names.set(candidate, true);
  };

  const checkChars = (raw: string, at: number): void => {
    const found = notXmlChar.exec(raw);
    if (found !== null) {
      fail(
        `character U+${(found[0].codePointAt(0) ?? 0).toString(16).padStart(4, "0")} is not allowed`,
        at + found.index,
      );
    }
  };

  const decode = (raw: string, at: number): string => {
    let from = raw.indexOf("&");
    if (from === -1) return raw;
    let out = raw.slice(0, from);
    while (from !== -1) {
      const semi = raw.indexOf(";", from + 1);
      if (semi === -1) fail("an unterminated reference", at + from);
      const reference = raw.slice(from + 1, semi);
      let replacement: string | undefined;
      if (reference.startsWith("#x")) {
        const digits = reference.slice(2);
        const code = /^[0-9a-fA-F]+$/.test(digits)
          ? Number.parseInt(digits, 16)
          : Number.NaN;
        if (isXmlCharCode(code)) replacement = String.fromCodePoint(code);
      } else if (reference.startsWith("#")) {
        const digits = reference.slice(1);
        const code = /^[0-9]+$/.test(digits)
          ? Number.parseInt(digits, 10)
          : Number.NaN;
        if (isXmlCharCode(code)) replacement = String.fromCodePoint(code);
      } else {
        replacement = predefined.get(reference);
      }
      if (replacement === undefined)
        fail(
          `'&${reference};' is not a predefined entity or a valid character reference`,
          at + from,
        );
      out += replacement;
      const next = raw.indexOf("&", semi + 1);
      out += raw.slice(semi + 1, next === -1 ? raw.length : next);
      from = next;
    }
    return out;
  };

  const emitText = (raw: string, at: number): void => {
    if (open.length === 0) {
      for (let index = 0; index < raw.length; index += 1) {
        if (!isSpace(raw.charCodeAt(index)))
          fail("text outside the root element", at + index);
      }
      return;
    }
    checkChars(raw, at);
    const close = raw.indexOf("]]>");
    if (close !== -1) fail("']]>' in text", at + close);
    sink.text(decode(lineEnds(raw), at));
  };

  /** @returns the offset after the tag, or -1 when the buffer ends inside it. */
  const startTag = (lt: number): number => {
    const length = buffer.length;
    let cursor = lt + 1;
    while (cursor < length) {
      const code = buffer.charCodeAt(cursor);
      if (isSpace(code) || code === 0x2f || code === 0x3e) break;
      cursor += 1;
    }
    if (cursor >= length) return -1;
    const element = buffer.slice(lt + 1, cursor);
    checkName(element, lt + 1);
    const attributes: RawAttribute[] = [];
    let seen: Set<string> | undefined;
    let empty = false;
    for (;;) {
      const before = cursor;
      while (cursor < length && isSpace(buffer.charCodeAt(cursor))) cursor += 1;
      if (cursor >= length) return -1;
      const code = buffer.charCodeAt(cursor);
      if (code === 0x3e) {
        cursor += 1;
        break;
      }
      if (code === 0x2f) {
        if (cursor + 1 >= length) return -1;
        if (buffer.charCodeAt(cursor + 1) !== 0x3e)
          fail("'/' that does not close the tag", cursor);
        empty = true;
        cursor += 2;
        break;
      }
      if (cursor === before)
        fail("an attribute not separated from what precedes it", cursor);
      const nameStart = cursor;
      while (cursor < length) {
        const c = buffer.charCodeAt(cursor);
        if (c === 0x3d || isSpace(c) || c === 0x3e || c === 0x2f || c === 0x3c)
          break;
        cursor += 1;
      }
      if (cursor >= length) return -1;
      const attribute = buffer.slice(nameStart, cursor);
      checkName(attribute, nameStart);
      while (cursor < length && isSpace(buffer.charCodeAt(cursor))) cursor += 1;
      if (cursor >= length) return -1;
      if (buffer.charCodeAt(cursor) !== 0x3d)
        fail(`attribute '${attribute}' has no value`, cursor);
      cursor += 1;
      while (cursor < length && isSpace(buffer.charCodeAt(cursor))) cursor += 1;
      if (cursor >= length) return -1;
      const quote = buffer.charCodeAt(cursor);
      if (quote !== 0x22 && quote !== 0x27)
        fail(`attribute '${attribute}' is not quoted`, cursor);
      const close = buffer.indexOf(quote === 0x22 ? '"' : "'", cursor + 1);
      if (close === -1) return -1;
      const raw = buffer.slice(cursor + 1, close);
      const angle = raw.indexOf("<");
      if (angle !== -1) fail("'<' in an attribute value", cursor + 1 + angle);
      checkChars(raw, cursor + 1);
      const spaced = breaks.test(raw)
        ? raw.replace(/\r\n|[\t\n\r]/g, " ")
        : raw;
      if (attributes.length < 8) {
        for (const prior of attributes) {
          if (prior.name === attribute)
            fail(`attribute '${attribute}' is repeated`, nameStart);
        }
      } else {
        seen ??= new Set(attributes.map((prior) => prior.name));
        if (seen.has(attribute))
          fail(`attribute '${attribute}' is repeated`, nameStart);
        seen.add(attribute);
      }
      attributes.push({ name: attribute, value: decode(spaced, cursor + 1) });
      cursor = close + 1;
    }
    if (sawRoot && open.length === 0) fail("a second root element", lt);
    sawRoot = true;
    sink.startTag(element, attributes, empty);
    if (!empty) open.push(element);
    return cursor;
  };

  const endTag = (lt: number): number => {
    const close = buffer.indexOf(">", lt + 2);
    if (close === -1) return -1;
    let finish = close;
    while (finish > lt + 2 && isSpace(buffer.charCodeAt(finish - 1)))
      finish -= 1;
    const element = buffer.slice(lt + 2, finish);
    const expected = open.pop();
    if (expected !== element) {
      fail(
        expected === undefined
          ? `end tag '${element}' with no open element`
          : `end tag '${element}' where '${expected}' is open`,
        lt,
      );
    }
    sink.endTag(element);
    return close + 1;
  };

  const instruction = (lt: number): number => {
    const close = buffer.indexOf("?>", lt + 2);
    if (close === -1) return -1;
    const body = buffer.slice(lt + 2, close);
    let split = 0;
    while (split < body.length && !isSpace(body.charCodeAt(split))) split += 1;
    const target = body.slice(0, split);
    if (asciiLower(target) === "xml") {
      const first = base + lt === prolog;
      if (!first || !declaration.test(buffer.slice(lt, close + 2))) {
        fail(
          first
            ? "a malformed XML declaration"
            : "an XML declaration that is not at the start",
          lt,
        );
      }
      return close + 2;
    }
    checkName(target, lt + 2);
    const data = body.slice(split).replace(/^[ \t\r\n]+/, "");
    checkChars(data, lt + 2 + split);
    sink.instruction(target, lineEnds(data));
    return close + 2;
  };

  const comment = (lt: number): number => {
    const close = buffer.indexOf("--", lt + 4);
    if (close === -1) return -1;
    if (close + 2 >= buffer.length) return -1;
    if (buffer.charCodeAt(close + 2) !== 0x3e)
      fail("'--' inside a comment", close);
    checkChars(buffer.slice(lt + 4, close), lt + 4);
    return close + 3;
  };

  const cdata = (lt: number): number => {
    const close = buffer.indexOf("]]>", lt + 9);
    if (close === -1) return -1;
    if (open.length === 0) fail("CDATA outside the root element", lt);
    const raw = buffer.slice(lt + 9, close);
    checkChars(raw, lt + 9);
    sink.text(lineEnds(raw));
    return close + 3;
  };

  const markup = (lt: number): number => {
    const rest = buffer.length - lt;
    if (rest < 2) return -1;
    const next = buffer.charCodeAt(lt + 1);
    if (next === 0x2f) return endTag(lt);
    if (next === 0x3f) return instruction(lt);
    if (next !== 0x21) return startTag(lt);
    for (const opener of ["<!--", "<![CDATA["]) {
      if (rest < opener.length && opener.startsWith(buffer.slice(lt)))
        return -1;
    }
    if (buffer.startsWith("<!--", lt)) return comment(lt);
    if (buffer.startsWith("<![CDATA[", lt)) return cdata(lt);
    if (rest < 9 && "<!DOCTYPE".startsWith(buffer.slice(lt))) return -1;
    return fail(
      buffer.startsWith("<!DOCTYPE", lt)
        ? "the part declares a DOCTYPE, which OPC forbids"
        : "a markup declaration",
      lt,
    );
  };

  const run = (): void => {
    let at = 0;
    if (prolog === undefined) {
      if (buffer.length === 0 && !ended) return;
      prolog = buffer.charCodeAt(0) === 0xfeff ? 1 : 0;
      at = prolog;
    }
    const length = buffer.length;
    while (at < length) {
      const lt = buffer.indexOf("<", at);
      if (lt === -1) {
        if (!ended) break;
        emitText(buffer.slice(at), at);
        at = length;
        break;
      }
      if (lt > at) emitText(buffer.slice(at, lt), at);
      at = lt;
      const after = markup(lt);
      if (after === -1) {
        if (ended) fail("the part ends inside markup", lt);
        break;
      }
      at = after;
    }
    buffer = buffer.slice(at);
    base += at;
    retryAt = buffer.length * 2;
  };

  return {
    write(chunk) {
      buffer += chunk;
      if (buffer.length >= retryAt) run();
    },
    end() {
      ended = true;
      run();
      if (open.length > 0)
        fail(`the part ends inside '${open.at(-1) ?? ""}'`, buffer.length);
      if (!sawRoot) fail("the part has no root element", buffer.length);
    },
  };
}
