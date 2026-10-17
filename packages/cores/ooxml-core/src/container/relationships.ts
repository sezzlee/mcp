import type { Relationship } from "../model/package.js";
import { ooxmlNamespaces } from "../xml/namespaces.js";
import type { XmlPartReader } from "../xml/read.js";
import { resolveTarget } from "./names.js";

/**
 * Reads one `.rels` part.
 *
 * @param part.xml the decoded relationships part.
 * @param part.relsPath the relationships part's own path, which a refusal
 * names.
 * @param part.ownerPath the part the relationships belong to, used to resolve
 * relative targets.
 * @param readXmlPart the part reader to scan it with.
 * @returns the relationships keyed by Id.
 */
export function readRelationships(
  part: {
    readonly xml: string;
    readonly relsPath: string;
    readonly ownerPath: string;
  },
  readXmlPart: XmlPartReader,
): ReadonlyMap<string, Relationship> {
  const { xml, relsPath, ownerPath } = part;
  const resolved = new Map<string, Relationship>();
  readXmlPart(xml, relsPath, {
    onOpen(node) {
      if (
        node.uri !== ooxmlNamespaces.packageRelationships ||
        node.local !== "Relationship"
      ) {
        return;
      }
      const id = node.attr("Id");
      const target = node.attr("Target");
      if (id === undefined || target === undefined) return;
      const type = node.attr("Type") ?? "";
      /**
       * Guard: an external target is a URL, not a package path. Resolving it
       * against the owning part would mangle it, and the discriminant is what
       * stops it being passed where a part path is expected.
       */
      if (node.attr("TargetMode") === "External") {
        resolved.set(id, { kind: "external", id, type, target });
        return;
      }
      const inside = resolveTarget(ownerPath, target);
      if (inside === undefined) return;
      resolved.set(id, { kind: "internal", id, type, target: inside });
    },
  });
  return resolved;
}
