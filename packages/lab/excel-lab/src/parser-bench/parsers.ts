import { createRequire } from "node:module";
import { SaxesParser, type SaxesAttributeNS } from "saxes";
import type { Attribute, BenchNode, PartParser, ParserName } from "./events.ts";
import { tokenize, TokenizerError } from "./tokenizer.ts";

/**
 * Guard: sax assigns its exports inside a wrapper Node's CommonJS lexer cannot
 * see through, so an ESM named import finds nothing.
 */
const sax: typeof import("sax") = createRequire(import.meta.url)("sax");

const xmlnsNamespace = "http://www.w3.org/2000/xmlns/";

function lazyNode(
  local: string,
  uri: string,
  list: () => readonly Attribute[],
  find: (name: string, uri: string) => string | undefined,
): BenchNode {
  return {
    local,
    uri,
    attr: (name, wanted = "") => find(name, wanted),
    attributes: list,
  };
}

function saxesNode(
  local: string,
  uri: string,
  attributes: Readonly<Record<string, SaxesAttributeNS>>,
): BenchNode {
  return lazyNode(
    local,
    uri,
    () =>
      Object.values(attributes)
        .filter((attribute) => attribute.uri !== xmlnsNamespace)
        .map(({ uri: at, local: name, value }) => ({
          uri: at,
          local: name,
          value,
        })),
    (name, wanted) => {
      for (const key in attributes) {
        if (!Object.hasOwn(attributes, key)) continue;
        const attribute = attributes[key];
        if (attribute === undefined) continue;
        if (attribute.local === name && attribute.uri === wanted)
          return attribute.value;
      }
      return undefined;
    },
  );
}

const namespaceAware = { xmlns: true } as const;

/**
 * The production reader in `@sezzlee/ooxml-core`, with one difference: CDATA
 * is reported as text here, so every parser reports the same character data.
 */
const saxesParser: PartParser = (xml, visitor) => {
  const parser = new SaxesParser<typeof namespaceAware>(namespaceAware);
  let failure: string | undefined;
  parser.on("error", (error) => {
    failure ??= error.message;
  });
  parser.on("doctype", () => {
    failure ??= "DOCTYPE";
  });
  const { onOpen, onClose, onText } = visitor;
  if (onOpen !== undefined) {
    parser.on("opentag", (tag) => {
      if (failure === undefined)
        onOpen(saxesNode(tag.local, tag.uri, tag.attributes));
    });
  }
  if (onClose !== undefined) {
    parser.on("closetag", (tag) => {
      if (failure === undefined) onClose(tag.local, tag.uri);
    });
  }
  if (onText !== undefined) {
    parser.on("text", (text) => {
      if (failure === undefined) onText(text);
    });
    parser.on("cdata", (text) => {
      if (failure === undefined) onText(text);
    });
  }
  try {
    parser.write(xml).close();
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error);
  }
  return failure === undefined
    ? { kind: "read" }
    : { kind: "refused", reason: failure };
};

const saxParser: PartParser = (xml, visitor) => {
  const parser = sax.parser(true, { xmlns: true });
  let failure: string | undefined;
  const open: { readonly local: string; readonly uri: string }[] = [];
  const { onOpen, onClose, onText } = visitor;
  parser.onerror = (error) => {
    failure ??= error.message;
    throw error;
  };
  parser.ondoctype = () => {
    failure ??= "DOCTYPE";
    throw new Error("DOCTYPE");
  };
  parser.onopentag = (tag) => {
    if (!("uri" in tag)) return;
    const attributes = tag.attributes;
    open.push({ local: tag.local, uri: tag.uri });
    onOpen?.(
      lazyNode(
        tag.local,
        tag.uri,
        () =>
          Object.values(attributes)
            .filter((attribute) => attribute.uri !== xmlnsNamespace)
            .map(({ uri, local, value }) => ({ uri, local, value })),
        (name, wanted) => {
          for (const key in attributes) {
            if (!Object.hasOwn(attributes, key)) continue;
            const attribute = attributes[key];
            if (attribute === undefined) continue;
            if (attribute.local === name && attribute.uri === wanted)
              return attribute.value;
          }
          return undefined;
        },
      ),
    );
  };
  parser.onclosetag = () => {
    const tag = open.pop();
    if (tag !== undefined) onClose?.(tag.local, tag.uri);
  };
  if (onText !== undefined) {
    parser.ontext = onText;
    parser.oncdata = onText;
  }
  try {
    parser.write(xml).close();
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error);
  }
  return failure === undefined
    ? { kind: "read" }
    : { kind: "refused", reason: failure };
};

const ownParser: PartParser = (xml, visitor) => {
  try {
    tokenize(xml, visitor);
    return { kind: "read" };
  } catch (error) {
    if (error instanceof TokenizerError)
      return { kind: "refused", reason: error.message };
    throw error;
  }
};

export const parsers: Readonly<Record<ParserName, PartParser>> = {
  saxes: saxesParser,
  sax: saxParser,
  own: ownParser,
};
