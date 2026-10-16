import { SaxesParser } from "saxes";
import type { XmlNode, XmlVisitor } from "../../src/model/xml.js";
import { namespaceSink } from "../../src/xml/scope.js";
import { createTokenizer, XmlSyntaxError } from "../../src/xml/tokenizer.js";

export type Events =
  | { readonly kind: "read"; readonly events: readonly string[] }
  | { readonly kind: "refused"; readonly reason: string };

type Probe = readonly (readonly [uri: string, local: string])[];

const xmlNamespace = "http://www.w3.org/XML/1998/namespace";

/**
 * Every `(uri, local)` an attribute in `xml` could resolve to: each local name
 * written before an `=`, under no namespace, the XML namespace and every
 * namespace the text declares. `XmlNode` looks attributes up rather than
 * listing them, so both parsers are asked the same questions.
 */
export function probeOf(xml: string): Probe {
  const locals = new Set<string>();
  for (const match of xml.matchAll(/([^\s<>="'/]+)\s*=/g)) {
    const name = match[1] ?? "";
    locals.add(name.slice(name.indexOf(":") + 1));
  }
  const uris = new Set<string>(["", xmlNamespace]);
  for (const match of xml.matchAll(
    /xmlns(?::[^\s=]*)?\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  )) {
    const written = match[1] ?? match[2] ?? "";
    const spaced = written.replace(/\r\n|[\t\n\r]/g, " ");
    uris.add(written).add(spaced).add(spaced.trim());
  }
  const probe: [string, string][] = [];
  for (const uri of uris) for (const local of locals) probe.push([uri, local]);
  return probe;
}

/**
 * Records what a visitor sees. Text outside the root element is whitespace,
 * not content; saxes reports it and the tokenizer does not, so it is dropped
 * for both.
 */
function recorder(probe: Probe): {
  readonly visitor: XmlVisitor;
  finish(): readonly string[];
} {
  const events: string[] = [];
  let text = "";
  let depth = 0;
  const flush = () => {
    if (text !== "") events.push(`text ${JSON.stringify(text)}`);
    text = "";
  };
  const describe = (node: XmlNode): string => {
    const found: string[] = [];
    for (const [uri, local] of probe) {
      const value = node.attr(local, uri);
      if (value !== undefined)
        found.push(`{${uri}}${local}=${JSON.stringify(value)}`);
    }
    return `open {${node.uri}}${node.local} ${found.sort().join(" ")}`.trimEnd();
  };
  return {
    visitor: {
      onOpen(node) {
        flush();
        events.push(describe(node));
        depth += 1;
      },
      onClose(local, uri) {
        flush();
        events.push(`close {${uri}}${local}`);
        depth -= 1;
      },
      onText(chunk) {
        if (depth > 0) text += chunk;
      },
    },
    finish() {
      flush();
      return events;
    },
  };
}

/** The production tokenizer, fed `xml` in chunks of the given sizes in turn. */
export function ours(
  xml: string,
  chunks: readonly number[] = [xml.length],
): Events {
  const record = recorder(probeOf(xml));
  const tokenizer = createTokenizer(namespaceSink(record.visitor));
  try {
    let at = 0;
    let index = 0;
    while (at < xml.length) {
      const size = Math.max(1, chunks[index % chunks.length] ?? xml.length);
      tokenizer.write(xml.slice(at, at + size));
      at += size;
      index += 1;
    }
    tokenizer.end();
  } catch (error) {
    if (error instanceof XmlSyntaxError)
      return { kind: "refused", reason: error.message };
    throw error;
  }
  return { kind: "read", events: record.finish() };
}

/** saxes, namespace-aware, as the oracle; CDATA is reported as text. */
export function oracle(xml: string): Events {
  const parser = new SaxesParser({ xmlns: true });
  const record = recorder(probeOf(xml));
  const { onOpen, onClose, onText } = record.visitor;
  let refused: string | undefined;
  parser.on("error", (error) => {
    refused ??= error.message;
  });
  parser.on("doctype", () => {
    refused ??= "DOCTYPE";
  });
  parser.on("opentag", (tag) => {
    const attributes = Object.values(tag.attributes);
    onOpen?.({
      local: tag.local,
      uri: tag.uri,
      attr: (name, uri = "") =>
        attributes.find(
          (attribute) => attribute.local === name && attribute.uri === uri,
        )?.value,
    });
  });
  parser.on("closetag", (tag) => onClose?.(tag.local, tag.uri));
  parser.on("text", (chunk) => onText?.(chunk));
  parser.on("cdata", (chunk) => onText?.(chunk));
  try {
    parser.write(xml).close();
  } catch (error) {
    refused ??= error instanceof Error ? error.message : String(error);
  }
  return refused === undefined
    ? { kind: "read", events: record.finish() }
    : { kind: "refused", reason: refused };
}

/**
 * The production tokenizer with a visitor that only counts, for inputs whose
 * size would make the probing recorder itself the slow part.
 */
export function countEvents(
  xml: string,
  chunks: readonly number[] = [xml.length],
):
  | { readonly kind: "read"; readonly events: number }
  | { readonly kind: "refused"; readonly reason: string } {
  let events = 0;
  const tokenizer = createTokenizer(
    namespaceSink({
      onOpen: () => {
        events += 1;
      },
      onClose: () => {
        events += 1;
      },
    }),
  );
  try {
    let at = 0;
    let index = 0;
    while (at < xml.length) {
      const size = Math.max(1, chunks[index % chunks.length] ?? xml.length);
      tokenizer.write(xml.slice(at, at + size));
      at += size;
      index += 1;
    }
    tokenizer.end();
  } catch (error) {
    if (error instanceof XmlSyntaxError)
      return { kind: "refused", reason: error.message };
    throw error;
  }
  return { kind: "read", events };
}
