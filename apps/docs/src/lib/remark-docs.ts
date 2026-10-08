interface MdNode {
  type: string;
  value?: string;
  lang?: string | null;
  meta?: string | null;
  name?: string;
  depth?: number;
  attributes?: Record<string, string | null | undefined> | null;
  children?: MdNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
    hChildren?: MdNode[];
    directiveLabel?: boolean;
  };
}

export const BLOCK_DIRECTIVES = ["tabs", "details"] as const;

type BlockDirective = (typeof BLOCK_DIRECTIVES)[number];

function isBlockDirective(name: string): name is BlockDirective {
  return (BLOCK_DIRECTIVES as readonly string[]).includes(name);
}

function textOf(node: MdNode): string {
  if (node.type === "text" || node.type === "inlineCode") {
    return node.value ?? "";
  }
  return (node.children ?? []).map(textOf).join("");
}

export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`'"’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function titleFromMeta(meta: string | null | undefined): string | null {
  return meta?.match(/title="([^"]+)"/)?.[1] ?? null;
}

function docCode(node: MdNode, role: "code" | "command" | "output"): MdNode {
  const properties: Record<string, string> = {
    dataBlock: "code",
    dataRole: role,
    dataLang: node.lang ?? "text",
  };
  const title = titleFromMeta(node.meta);
  if (title !== null) {
    properties.dataTitle = title;
  }
  return {
    type: "docCode",
    lang: node.lang ?? null,
    data: {
      hName: "div",
      hProperties: properties,
      hChildren: [{ type: "text", value: node.value ?? "" }],
    },
  };
}

function markDirective(node: MdNode, name: BlockDirective): void {
  const children = node.children ?? [];
  const labelNode = children.find((child) => child.data?.directiveLabel);
  const label = labelNode === undefined ? "" : textOf(labelNode);
  node.children = children.filter((child) => child !== labelNode);
  node.data = {
    hName: "div",
    hProperties: { dataBlock: name, dataLabel: label },
  };
}

function restoreTextDirective(node: MdNode): MdNode {
  return { type: "text", value: `:${node.name ?? ""}${textOf(node)}` };
}

function transform(parent: MdNode, file: string): void {
  const children = parent.children;
  const pairsOutput = !(
    parent.type === "containerDirective" && parent.name === "tabs"
  );
  if (children === undefined) return;

  let previousLang: string | null | undefined;
  children.forEach((child, index) => {
    const afterLang = previousLang;
    previousLang = child.type === "code" ? (child.lang ?? null) : undefined;
    if (child.type === "textDirective") {
      children[index] = restoreTextDirective(child);
      return;
    }
    if (child.type === "leafDirective" || child.type === "containerDirective") {
      const name = child.name ?? "";
      if (!isBlockDirective(name)) {
        throw new Error(
          `${file}: unknown directive "${name}" (${BLOCK_DIRECTIVES.join(", ")})`,
        );
      }
      markDirective(child, name);
    }
    if (child.type === "heading" && (child.depth === 2 || child.depth === 3)) {
      child.data = { hProperties: { id: headingId(textOf(child)) } };
    }
    if (child.type === "code") {
      const role =
        pairsOutput && afterLang === "sh" && child.lang !== "sh"
          ? "output"
          : child.lang === "sh"
            ? "command"
            : "code";
      children[index] = docCode(child, role);
      return;
    }
    transform(child, file);
  });
}

/**
 * Turns the docs' markdown conventions into tagged `div`s for `DocMarkdown`: code blocks (with
 * the block under an `sh` command marked as its output), `:::tabs`, `:::details[label]` and h2/h3 ids.
 *
 * Guard: a fenced block is replaced by a `docCode` node instead of tagging the `code` node, because
 * `mdast-util-to-hast` applies `hName` to the inner `<code>` and keeps its own `<pre>` around it.
 *
 * Guard: `remark-directive` reads any `:word` in prose as a text directive and drops it from the
 * output, so an unknown text directive is turned back into its literal text; an unknown block
 * directive throws, because a typo there would silently hide a whole section.
 */
export function remarkDocs(file: string) {
  return () => (tree: MdNode) => {
    transform(tree, file);
  };
}
