import { createHash } from "node:crypto";

export interface Attribute {
  readonly uri: string;
  readonly local: string;
  readonly value: string;
}

/**
 * The node `@sezzlee/ooxml-core` hands a visitor, plus every attribute so a
 * fingerprint can compare what two parsers saw.
 */
export interface BenchNode {
  readonly local: string;
  readonly uri: string;
  attr(name: string, uri?: string): string | undefined;
  attributes(): readonly Attribute[];
}

export interface BenchVisitor {
  readonly onOpen?: (node: BenchNode) => void;
  readonly onClose?: (local: string, uri: string) => void;
  readonly onText?: (text: string) => void;
}

/**
 * One parser behind the part reader's contract: a whole decoded part in, one
 * forward pass of events out. `refused` is a failure of the XML itself.
 */
export type PartParser = (
  xml: string,
  visitor: BenchVisitor,
) =>
  | { readonly kind: "read" }
  | { readonly kind: "refused"; readonly reason: string };

export const parserNames = ["saxes", "sax", "own"] as const;
export type ParserName = (typeof parserNames)[number];

/**
 * The events a parser reported, hashed. Adjacent text events are joined
 * before hashing, because parsers split text differently, and text outside
 * the root element is dropped.
 */
export function fingerprintVisitor(): {
  readonly visitor: BenchVisitor;
  digest(): { readonly sha256: string; readonly events: number };
} {
  const hash = createHash("sha256");
  let depth = 0;
  let text = "";
  let events = 0;
  const flush = () => {
    if (text === "") return;
    hash.update(`T${String(text.length)}:${text}\n`);
    events += 1;
    text = "";
  };
  return {
    visitor: {
      onOpen(node) {
        flush();
        const attributes = [...node.attributes()]
          .map(
            (attribute) =>
              `${attribute.uri} ${attribute.local}=${attribute.value}`,
          )
          .sort();
        hash.update(
          `O${node.uri} ${node.local}[${attributes.join("\u0000")}]\n`,
        );
        events += 1;
        depth += 1;
      },
      onClose(local, uri) {
        flush();
        hash.update(`C${uri} ${local}\n`);
        events += 1;
        depth -= 1;
      },
      onText(chunk) {
        if (depth > 0) text += chunk;
      },
    },
    digest() {
      flush();
      return { sha256: hash.digest("hex"), events };
    },
  };
}

/**
 * The work the cell reader does per element: three attribute lookups on every
 * cell, and the text of every value, formula and string run collected.
 */
export interface WorkloadVisitor {
  readonly onOpen: (node: {
    readonly local: string;
    attr(name: string, uri?: string): string | undefined;
  }) => void;
  readonly onClose: (local: string) => void;
  readonly onText: (text: string) => void;
}

export function cellWorkload(): {
  readonly visitor: WorkloadVisitor;
  result(): { readonly cells: number; readonly textLength: number };
} {
  let cells = 0;
  let textLength = 0;
  let capturing = false;
  let buffer = "";
  return {
    visitor: {
      onOpen(node) {
        if (node.local === "c") {
          cells += 1;
          node.attr("r");
          node.attr("t");
          node.attr("s");
          return;
        }
        if (node.local === "v" || node.local === "f" || node.local === "t") {
          capturing = true;
          buffer = "";
        }
      },
      onClose(local) {
        if (local === "v" || local === "f" || local === "t") {
          capturing = false;
          textLength += buffer.length;
        }
      },
      onText(chunk) {
        if (capturing) buffer += chunk;
      },
    },
    result: () => ({ cells, textLength }),
  };
}
