import type { XmlNode, XmlVisitor } from "../model/xml.js";
import { ooxmlNamespaces } from "./namespaces.js";

type Frame =
  | { readonly role: "alternates"; readonly depth: number; chosen: boolean }
  | { readonly role: "branch"; readonly depth: number };

function requiresOnly(
  node: XmlNode,
  understands: (uri: string) => boolean,
): boolean {
  const requires = node.attr("Requires")?.trim();
  if (requires === undefined || requires === "") return false;
  return requires.split(/\s+/).every((prefix) => {
    const uri = node.namespaceOf(prefix);
    return uri !== undefined && understands(uri);
  });
}

/**
 * Applies Markup Compatibility (ECMA-376 Part 3, §10.2) to a part: of each
 * `mc:AlternateContent`, only the first `Choice` whose `Requires` namespaces
 * the reader understands reaches `visitor`, or the `Fallback` when none does.
 * The `mc:` elements themselves never reach it.
 *
 * Guard: a writer puts the same object in several branches, so a reader that
 * walks all of them reports it more than once, and one that walks only a
 * `Fallback` reports the placeholder instead of the object.
 *
 * @param understands whether the reader knows the namespace a `Requires`
 *   prefix names.
 */
export function selectAlternateContent(
  visitor: XmlVisitor,
  understands: (uri: string) => boolean,
): XmlVisitor {
  const { onOpen, onClose, onText } = visitor;
  const frames: Frame[] = [];
  let depth = 0;
  let skipped = 0;

  const isCompatibility = (uri: string): boolean =>
    uri === ooxmlNamespaces.markupCompatibility;

  return {
    onOpen(node) {
      if (skipped > 0) {
        skipped += 1;
        return;
      }
      const top = frames.at(-1);
      if (top?.role === "alternates" && top.depth === depth) {
        const selected =
          !top.chosen &&
          isCompatibility(node.uri) &&
          ((node.local === "Choice" && requiresOnly(node, understands)) ||
            node.local === "Fallback");
        if (selected) {
          top.chosen = true;
          frames.push({ role: "branch", depth });
        } else {
          skipped = 1;
        }
        return;
      }
      if (isCompatibility(node.uri) && node.local === "AlternateContent") {
        frames.push({ role: "alternates", depth, chosen: false });
        return;
      }
      depth += 1;
      onOpen?.(node);
    },
    onClose(local, uri) {
      if (skipped > 0) {
        skipped -= 1;
        return;
      }
      if (frames.at(-1)?.depth === depth) {
        frames.pop();
        return;
      }
      depth -= 1;
      onClose?.(local, uri);
    },
    onText(text) {
      if (skipped > 0) return;
      const top = frames.at(-1);
      if (top?.role === "alternates" && top.depth === depth) return;
      onText?.(text);
    },
  };
}
