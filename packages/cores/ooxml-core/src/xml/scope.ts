import type { XmlNode, XmlVisitor } from "../model/xml.js";
import {
  XmlSyntaxError,
  type RawAttribute,
  type TokenSink,
} from "./tokenizer.js";

const xmlNamespace = "http://www.w3.org/XML/1998/namespace";
const xmlnsNamespace = "http://www.w3.org/2000/xmlns/";

class Element implements XmlNode {
  readonly local: string;
  readonly uri: string;
  readonly #attributes: readonly string[];
  readonly #bindings: ReadonlyMap<string, string>;

  constructor(
    local: string,
    uri: string,
    attributes: readonly string[],
    bindings: ReadonlyMap<string, string>,
  ) {
    this.local = local;
    this.uri = uri;
    this.#attributes = attributes;
    this.#bindings = bindings;
  }

  namespaceOf(prefix: string): string | undefined {
    return this.#bindings.get(prefix);
  }

  attr(name: string, uri = ""): string | undefined {
    const attributes = this.#attributes;
    for (let index = 0; index < attributes.length; index += 3) {
      if (attributes[index] === name && attributes[index + 1] === uri) {
        return attributes[index + 2];
      }
    }
    return undefined;
  }
}

interface Opened {
  readonly local: string;
  readonly uri: string;
  readonly restore:
    readonly (readonly [string, string | undefined])[] | undefined;
}

function refuse(message: string): never {
  throw new XmlSyntaxError(message);
}

function split(qualified: string): readonly [string, string] {
  const colon = qualified.indexOf(":");
  if (colon === -1) return ["", qualified];
  const prefix = qualified.slice(0, colon);
  const local = qualified.slice(colon + 1);
  if (prefix === "" || local === "" || local.includes(":")) {
    refuse(`'${qualified}' is not a qualified name`);
  }
  return [prefix, local];
}

/**
 * Resolves names against Namespaces in XML 1.0 and hands the visitor
 * `(uri, local)` pairs, so a prefixed part reads the same as an unprefixed one.
 *
 * Guard: bindings live in one map, and an element that declares a prefix
 * records what it replaced and restores it when it closes. A lookup is one map
 * read however deep the nesting, so a part that declares a namespace on every
 * level cannot make resolution quadratic.
 */
export function namespaceSink(visitor: XmlVisitor): TokenSink {
  const bindings = new Map<string, string>([["xml", xmlNamespace]]);
  const opened: Opened[] = [];
  const { onOpen, onClose, onText } = visitor;

  const declare = (
    attributes: readonly RawAttribute[],
  ): readonly (readonly [string, string | undefined])[] | undefined => {
    let restore: [string, string | undefined][] | undefined;
    for (const { name, value } of attributes) {
      let prefix: string;
      if (name === "xmlns") prefix = "";
      else if (name.startsWith("xmlns:")) prefix = name.slice(6);
      else continue;
      if (name !== "xmlns" && prefix === "")
        refuse("'xmlns:' declares an empty prefix");
      if (prefix === "xmlns") refuse("the prefix 'xmlns' is declared");
      if (prefix === "xml" ? value !== xmlNamespace : value === xmlNamespace) {
        refuse(`the prefix '${prefix}' is bound to the XML namespace wrongly`);
      }
      if (value === xmlnsNamespace)
        refuse(`'${name}' binds the xmlns namespace`);
      if (prefix !== "" && value === "")
        refuse(`'${name}' undeclares a prefix`);
      if (prefix !== "") split(`${prefix}:x`);
      restore ??= [];
      restore.push([prefix, bindings.get(prefix)]);
      if (value === "") bindings.delete(prefix);
      else bindings.set(prefix, value);
    }
    return restore;
  };

  const undo = (restore: Opened["restore"]): void => {
    if (restore === undefined) return;
    for (let index = restore.length - 1; index >= 0; index -= 1) {
      const entry = restore[index];
      if (entry === undefined) continue;
      const [prefix, previous] = entry;
      if (previous === undefined) bindings.delete(prefix);
      else bindings.set(prefix, previous);
    }
  };

  return {
    startTag(name, attributes, empty) {
      const restore = declare(attributes);
      const [prefix, local] = split(name);
      const uri = bindings.get(prefix);
      if (uri === undefined && prefix !== "")
        refuse(`the prefix '${prefix}' is not declared`);
      const resolved: string[] = [];
      let prefixed = 0;
      for (const attribute of attributes) {
        const qualified = attribute.name;
        if (qualified === "xmlns" || qualified.startsWith("xmlns:")) continue;
        const [attributePrefix, attributeLocal] = split(qualified);
        let attributeUri = "";
        if (attributePrefix !== "") {
          const bound = bindings.get(attributePrefix);
          if (bound === undefined)
            refuse(`the prefix '${attributePrefix}' is not declared`);
          attributeUri = bound;
          prefixed += 1;
        }
        resolved.push(attributeLocal, attributeUri, attribute.value);
      }
      /**
       * Guard: the tokenizer already refused two attributes written alike, so
       * two that resolve alike need two prefixes bound to one namespace; with
       * fewer than two prefixed attributes the check cannot fire.
       */
      if (prefixed > 1) {
        const keys = new Set<string>();
        for (let index = 0; index < resolved.length; index += 3) {
          const key = `${resolved[index + 1] ?? ""}\u0000${resolved[index] ?? ""}`;
          if (keys.has(key))
            refuse(
              `'${name}' has two attributes named '${resolved[index] ?? ""}' in one namespace`,
            );
          keys.add(key);
        }
      }
      const node = new Element(local, uri ?? "", resolved, bindings);
      onOpen?.(node);
      if (empty) {
        onClose?.(node.local, node.uri);
        undo(restore);
      } else {
        opened.push({ local, uri: node.uri, restore });
      }
    },
    endTag() {
      const element = opened.pop();
      if (element === undefined) return;
      onClose?.(element.local, element.uri);
      undo(element.restore);
    },
    text(text) {
      onText?.(text);
    },
    instruction(target) {
      if (target.includes(":"))
        refuse(`the processing instruction target '${target}' has a colon`);
    },
  };
}
