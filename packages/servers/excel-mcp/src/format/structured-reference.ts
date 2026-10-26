import { invalidPresentation } from "./presentation-xml.js";

export function structuredReferenceAt(text: string, at: number) {
  const name = /^[\p{L}_\\][\p{L}\p{N}_.\\]*/u.exec(text.slice(at))?.[0];
  const start = at + (name?.length ?? 0);
  if (text[start] !== "[") return undefined;
  let end = start,
    depth = 0,
    leaf = "",
    inLeaf = false,
    literalPrefix = false;
  const leaves: { text: string; literalPrefix: boolean }[] = [];
  for (; end < text.length; end++) {
    const ch = text[end];
    if (ch === "'" && depth > 0) {
      const next = text[++end];
      if (next === undefined)
        invalidPresentation("An escaped table column name is incomplete.");
      if (leaf === "") literalPrefix = true;
      leaf += next;
      continue;
    }
    if (ch === "[") {
      depth++;
      leaf = "";
      inLeaf = true;
      literalPrefix = false;
    } else if (ch === "]") {
      if (inLeaf && leaf !== "") leaves.push({ text: leaf, literalPrefix });
      inLeaf = false;
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    } else if (inLeaf) leaf += ch;
  }
  if (depth !== 0 || end === start || text[end] === "]")
    invalidPresentation("A structured table reference is malformed.");
  const raw = text.slice(at, end);
  const selectors = leaves
    .filter((l) => !l.literalPrefix && l.text.startsWith("#"))
    .map((l) => l.text);
  if (
    selectors.some(
      (s) => !["#All", "#Data", "#Headers", "#Totals", "#This Row"].includes(s),
    )
  )
    invalidPresentation("The table reference has an unsupported selector.");
  const rowContext =
    raw.includes("[@[") ||
    leaves.some((l) => !l.literalPrefix && l.text.startsWith("@")) ||
    selectors.includes("#This Row");
  const columns = leaves
    .filter((l) => l.literalPrefix || !l.text.startsWith("#"))
    .map((l) =>
      !l.literalPrefix && l.text.startsWith("@") ? l.text.slice(1) : l.text,
    )
    .filter(Boolean);
  if (columns.length > 2 || (columns.length === 2 && !raw.includes("]:[")))
    invalidPresentation(
      "Only one table column or a contiguous column span is supported.",
    );
  if (name === undefined && text[end] === "!")
    invalidPresentation("External-workbook formula links are unsupported.");
  return {
    start: at,
    end,
    raw,
    name,
    selectors,
    columns,
    rowContext,
    span: columns.length === 2,
  };
}
export type StructuredReference = NonNullable<
  ReturnType<typeof structuredReferenceAt>
>;
export function mapStructuredFormula(
  text: string,
  map: (ref: StructuredReference) => string,
): string {
  let output = "",
    at = 0;
  while (at < text.length) {
    if (text[at] === '"' || text[at] === "'") {
      const quote = text[at],
        start = at++;
      while (at < text.length) {
        if (text[at++] !== quote) continue;
        if (text[at] === quote) {
          at++;
          continue;
        }
        break;
      }
      output += text.slice(start, at);
      continue;
    }
    const before = text[at - 1];
    const ref =
      before !== undefined && /[\p{L}\p{N}_.\\]/u.test(before)
        ? undefined
        : structuredReferenceAt(text, at);
    if (ref !== undefined) {
      output += map(ref);
      at = ref.end;
    } else output += text[at++];
  }
  return output;
}
export function escapedTableColumn(name: string): string {
  return name.replace(/['[\]#@]/g, (ch) => "'" + ch);
}
export function renderStructuredReference(
  ref: StructuredReference,
  columns: readonly string[],
  name = ref.name,
): string {
  const head = name ?? "";
  if (ref.rowContext) {
    const first = columns[0];
    if (first === undefined)
      invalidPresentation("A row reference needs a column.");
    const last = columns[1];
    const span = last === undefined ? "" : `:[${escapedTableColumn(last)}]`;
    return `${head}[[#This Row],[${escapedTableColumn(first)}]${span}]`;
  }
  const first = columns[0],
    last = columns[1];
  if (first === undefined) return `${head}[${ref.selectors[0] ?? "#Data"}]`;
  const col =
    last === undefined
      ? `[${escapedTableColumn(first)}]`
      : `[${escapedTableColumn(first)}]:[${escapedTableColumn(last)}]`;
  return ref.selectors.length
    ? `${head}[${ref.selectors.map((s) => `[${s}]`).join(",")},${col}]`
    : last === undefined
      ? head + col
      : `${head}[${col}]`;
}
