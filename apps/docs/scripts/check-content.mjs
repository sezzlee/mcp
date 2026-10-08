import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const contentDir = path.resolve(here, "../src/content");
const FOLDERS = ["recipes", "reference"];
const KEYS = ["id", "label", "goal", "tagline"];
const DIRECTIVES = ["tabs", "details"];

const problems = [];
const report = (where, message) =>
  problems.push(`src/content/${where}: ${message}`);

const registry = JSON.parse(
  readFileSync(path.join(contentDir, "products.json"), "utf8"),
);

const registered = new Set();
for (const [i, entry] of registry.entries()) {
  for (const key of Object.keys(entry)) {
    if (!KEYS.includes(key)) {
      report("products.json", `entry ${i} has an unknown key "${key}"`);
    }
  }
  for (const key of KEYS) {
    if (typeof entry[key] !== "string" || entry[key].trim() === "") {
      report("products.json", `entry ${i} is missing "${key}"`);
    }
  }
  if (registered.has(entry.id)) {
    report("products.json", `duplicate product id "${entry.id}"`);
  }
  registered.add(entry.id);
}

const dirs = [];
for (const name of readdirSync(contentDir)) {
  if (name === "products.json" || name === "redirects.json") continue;
  if (statSync(path.join(contentDir, name)).isDirectory()) {
    dirs.push(name);
  } else {
    report(
      name,
      "src/content holds one folder per product; move this inside one",
    );
  }
}

for (const dir of dirs) {
  if (!registered.has(dir)) {
    report(`${dir}/`, "no entry in products.json");
  }
}
for (const id of registered) {
  if (!dirs.includes(id)) {
    report("products.json", `lists "${id}" but src/content/${id}/ is missing`);
  }
}

const titleRules = {
  recipes: (t) =>
    t.endsWith("?") || /^How to\b/.test(t)
      ? 'a recipe title states the goal, e.g. "Read a CSV export"'
      : null,
  reference: (t) =>
    t.endsWith("?") || /^(How|Why|What|When)\b/.test(t)
      ? "a reference title is a noun phrase, not a question"
      : null,
};

const allSlugs = new Set();
const links = [];

for (const dir of dirs) {
  const slugs = new Map();

  const walk = (rel, depth) => {
    for (const name of readdirSync(path.join(contentDir, rel))) {
      const childRel = path.posix.join(rel, name);
      const abs = path.join(contentDir, childRel);

      if (statSync(abs).isDirectory()) {
        if (depth > 0) {
          report(
            childRel,
            "content nests at most <product>/<section>/<file>.md",
          );
        } else if (!FOLDERS.includes(name)) {
          report(childRel, `not a section folder (${FOLDERS.join(", ")})`);
        } else {
          walk(childRel, depth + 1);
        }
        continue;
      }

      if (!name.endsWith(".md")) {
        report(childRel, "only .md pages belong under a product folder");
        continue;
      }
      if (depth === 0 && name !== "00-quickstart.md") {
        report(
          childRel,
          "a product's only top-level page is 00-quickstart.md; move this into recipes/",
        );
      }
      if (!/^\d+-/.test(name)) {
        report(childRel, "filename needs a numeric order prefix, e.g. 01-");
      }

      const slug = name.replace(/\.md$/, "").replace(/^\d+-/, "");
      if (slugs.has(slug)) {
        report(
          childRel,
          `slug "${slug}" is already taken by ${slugs.get(slug)}`,
        );
      } else {
        slugs.set(slug, childRel);
      }

      allSlugs.add(`${dir}/${slug}`);

      const text = readFileSync(abs, "utf8");
      for (const match of text.matchAll(/\]\((\/docs\/[^)\s]+)\)/g)) {
        links.push({
          from: childRel,
          target: match[1].replace(/^\/docs\//, "").replace(/#.*$/, ""),
        });
      }

      let fence = null;
      let directive = null;
      for (const line of text.split("\n")) {
        const fenceMatch = line.match(/^(`{3,})(\S*)(.*)$/);
        if (fenceMatch) {
          if (fence === null) {
            fence = fenceMatch[1];
            if (directive === "tabs" && !/title="[^"]+"/.test(fenceMatch[3])) {
              report(
                childRel,
                'every code block inside :::tabs needs title="…"',
              );
            }
          } else if (line.trim() === fence) {
            fence = null;
          }
          continue;
        }
        if (fence !== null) continue;
        const open = line.match(/^:{3,}([A-Za-z][\w-]*)/);
        if (open) {
          if (!DIRECTIVES.includes(open[1])) {
            report(
              childRel,
              `unknown directive ":::${open[1]}" (${DIRECTIVES.join(", ")})`,
            );
          }
          directive = open[1];
        } else if (/^:{3,}\s*$/.test(line)) {
          directive = null;
        }
      }

      const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
      if (!title) {
        report(childRel, "no `# Title` heading");
        continue;
      }
      const violation =
        depth === 1 ? titleRules[path.basename(rel)]?.(title) : null;
      if (violation) {
        report(childRel, `${violation} — got "${title}"`);
      }
    }
  };

  walk(dir, 0);
  if (slugs.size === 0) {
    report(`${dir}/`, "has no pages");
  }
  if (!slugs.has("quickstart")) {
    report(`${dir}/`, "has no 00-quickstart.md");
  }
}

const redirects = JSON.parse(
  readFileSync(path.join(contentDir, "redirects.json"), "utf8"),
);
for (const [product, moves] of Object.entries(redirects)) {
  if (!registered.has(product)) {
    report("redirects.json", `"${product}" is not a product in products.json`);
    continue;
  }
  for (const [from, to] of Object.entries(moves)) {
    if (allSlugs.has(`${product}/${from}`)) {
      report(
        "redirects.json",
        `${product}/${from} is still a page; drop the redirect`,
      );
    }
    if (typeof to !== "string" || !allSlugs.has(`${product}/${to}`)) {
      report(
        "redirects.json",
        `${product}/${from} moves to "${to}", which is not a page`,
      );
    }
  }
}

for (const { from, target } of links) {
  if (!allSlugs.has(target)) {
    report(from, `links to /docs/${target}, which is not a page`);
  }
}

if (problems.length > 0) {
  console.error(`apps/docs content check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`apps/docs content OK — ${registry.length} product(s)`);
