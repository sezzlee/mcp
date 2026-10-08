import registry from "../content/products.json";
import redirectTable from "../content/redirects.json";
import { headingId } from "./remark-docs";

const modules = import.meta.glob("../content/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export type SectionKey = "recipes" | "reference";

const SECTION_ORDER = [
  "recipes",
  "reference",
] as const satisfies readonly SectionKey[];

const SECTION_LABELS: Record<SectionKey, string> = {
  recipes: "Recipes",
  reference: "Reference",
};

export interface ProductMeta {
  id: string;
  label: string;
  goal: string;
  tagline: string;
}

const PRODUCT_META = registry satisfies ProductMeta[];

export interface DocHeading {
  depth: 2 | 3;
  text: string;
  id: string;
}

export interface DocEntry {
  product: string;
  section: SectionKey | null;
  slug: string;
  title: string;
  navLabel: string;
  summary: string;
  headings: DocHeading[];
  body: string;
}

export interface DocGroup {
  key: SectionKey | null;
  label: string;
  docs: DocEntry[];
}

export interface Product extends ProductMeta {
  docs: DocEntry[];
  groups: DocGroup[];
  firstSlug: string;
}

function isSectionKey(value: string): value is SectionKey {
  return (SECTION_ORDER as readonly string[]).includes(value);
}

function fail(message: string): never {
  throw new Error(`apps/docs src/content: ${message}`);
}

function parsePath(
  path: string,
): Pick<DocEntry, "product" | "section" | "slug"> {
  const rel = path.replace("../content/", "");
  const segments = rel.split("/");
  const file = segments.pop();
  const [product, section, ...rest] = segments;

  if (file === undefined || product === undefined) {
    fail(`${rel} is not inside a product folder; expected <product>/...`);
  }
  if (rest.length > 0) {
    fail(
      `${rel} is nested too deep; expected <product>/<file>.md or <product>/<section>/<file>.md`,
    );
  }
  if (section !== undefined && !isSectionKey(section)) {
    fail(
      `${rel} sits in "${section}", which is not a section (${SECTION_ORDER.join(", ")})`,
    );
  }

  return {
    product,
    section: section ?? null,
    slug: file.replace(/\.md$/, "").replace(/^\d+-/, ""),
  };
}

function titleFromBody(body: string, fallback: string): string {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? fallback;
}

function summaryFromBody(body: string): string {
  const afterTitle = body.replace(/^[\s\S]*?^#\s+.+$/m, "");
  const paragraph = afterTitle
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block !== "" && /^[A-Za-z`*[]/.test(block));
  return (paragraph ?? "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ");
}

function headingsOf(body: string): DocHeading[] {
  const headings: DocHeading[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const opener = line.match(/^(`{3,})/)?.[1];
    if (opener !== undefined) {
      fence = fence === null ? opener : line.trim() === fence ? null : fence;
      continue;
    }
    if (fence !== null) continue;
    const match = line.match(/^(##|###)\s+(.+?)\s*$/);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const text = match[2]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[`*]/g, "");
    headings.push({
      depth: match[1] === "##" ? 2 : 3,
      text,
      id: headingId(text),
    });
  }
  return headings;
}

function sectionRank(section: SectionKey | null): number {
  return section === null ? -1 : SECTION_ORDER.indexOf(section);
}

const parsed = Object.entries(modules)
  .map(([path, body]) => {
    const base = parsePath(path);
    return {
      ...base,
      path,
      body,
      title: titleFromBody(body, base.slug),
      navLabel:
        base.section === null && base.slug === "quickstart"
          ? "Quickstart"
          : titleFromBody(body, base.slug),
      summary: summaryFromBody(body),
      headings: headingsOf(body),
    };
  })
  .sort(
    (a, b) =>
      sectionRank(a.section) - sectionRank(b.section) ||
      a.path.localeCompare(b.path),
  );

const registered = new Set(PRODUCT_META.map((meta) => meta.id));

for (const doc of parsed) {
  if (!registered.has(doc.product)) {
    fail(`${doc.product}/ has no entry in src/content/products.json`);
  }
}

function buildProduct(meta: ProductMeta): Product {
  const docs = parsed
    .filter((doc) => doc.product === meta.id)
    .map(
      ({
        product,
        section,
        slug,
        title,
        navLabel,
        summary,
        headings,
        body,
      }) => ({
        product,
        section,
        slug,
        title,
        navLabel,
        summary,
        headings,
        body,
      }),
    );

  const first = docs[0];
  if (first === undefined) {
    fail(`products.json lists "${meta.id}" but ${meta.id}/ has no pages`);
  }

  const seen = new Set<string>();
  for (const doc of docs) {
    if (seen.has(doc.slug)) {
      fail(`${meta.id}/ has two pages with the slug "${doc.slug}"`);
    }
    seen.add(doc.slug);
  }

  return {
    ...meta,
    docs,
    firstSlug: first.slug,
    groups: [null, ...SECTION_ORDER]
      .map((key) => ({
        key,
        label: key === null ? "" : SECTION_LABELS[key],
        docs: docs.filter((doc) => doc.section === key),
      }))
      .filter((group) => group.docs.length > 0),
  };
}

export const products: Product[] = PRODUCT_META.map(buildProduct);

const byProductId = new Map(products.map((product) => [product.id, product]));

const byProductSlug = new Map(
  products.flatMap((product) =>
    product.docs.map((doc) => [`${product.id}/${doc.slug}`, doc] as const),
  ),
);

export function getProduct(id: string): Product | undefined {
  return byProductId.get(id);
}

export function getDoc(product: string, slug: string): DocEntry | undefined {
  return byProductSlug.get(`${product}/${slug}`);
}

export const defaultProduct: Product | undefined = products[0];

const REDIRECTS: Readonly<Record<string, Readonly<Record<string, string>>>> =
  redirectTable;

for (const [product, moves] of Object.entries(REDIRECTS)) {
  for (const [from, to] of Object.entries(moves)) {
    if (byProductSlug.has(`${product}/${from}`)) {
      fail(`redirects.json moves ${product}/${from}, which is still a page`);
    }
    if (!byProductSlug.has(`${product}/${to}`)) {
      fail(
        `redirects.json moves ${product}/${from} to ${to}, which is not a page`,
      );
    }
  }
}

/**
 * The page a retired slug moved to, so links to it keep working.
 *
 * @returns The new slug within the same product, or `undefined` when the slug never moved.
 */
export function getRedirect(product: string, slug: string): string | undefined {
  return REDIRECTS[product]?.[slug];
}
