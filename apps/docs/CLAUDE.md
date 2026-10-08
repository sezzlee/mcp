# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Scope: `apps/docs`, the Sezzlee MCP documentation site. The repo-root `CLAUDE.md` still applies — this
file adds what is specific to this app and overrides it where stated.

## Commands

Run from the repo root:

- `pnpm --filter @sezzlee/docs dev` — dev server on `http://localhost:5180`
- `pnpm turbo run build --filter=@sezzlee/docs` — production build into `dist/` (Worker in
  `dist/server`, prerendered pages and assets in `dist/client`)
- `pnpm --filter @sezzlee/docs preview` — serve the build locally in `workerd` (requires a build first)
- `pnpm --filter @sezzlee/docs run deploy` — `wrangler deploy` to the `sezzlee-docs` Worker (requires a build first)
- `pnpm --filter @sezzlee/docs lint` / `check-types`

Use turbo for `build` so `^build` dependencies resolve; `dev`, `preview` and `deploy` do not need it.
There are no tests in this app.

## Hosting

The site runs on Cloudflare Workers through `@cloudflare/vite-plugin`; `wrangler.jsonc` is the
config. Every page reachable by a link is prerendered at build time (`prerender.crawlLinks`) and
served as a static asset; the Worker only answers what no file matches — the `/docs` and
`/docs/$product` redirects and 404s. `cloudflare()` must stay first in `vite.config.ts`.

`assets.html_handling` is `drop-trailing-slash` because prerender writes `<route>/index.html` while
every link is slash-less; the default `auto-trailing-slash` would answer each page with a 307 to
`<route>/`.

### Deployment

- Live site: <https://docs.sezzlee.app> — Worker `sezzlee-docs`, Cloudflare account
  `9a3e2156b439a4ae8a2ac5b153252fee`. The custom domain is configured in `wrangler.jsonc`;
  the workers.dev endpoint is disabled.
- **Deploys are manual.** No CI job deploys this site, so a merged content change is not live until
  someone runs `pnpm turbo run build --filter=@sezzlee/docs` and then
  `pnpm --filter @sezzlee/docs run deploy`.
- A change under `apps/docs` is finished only once it is deployed: after the change is committed,
  ask before deploying (it publishes), then deploy, then confirm with
  an HTTPS request to `https://docs.sezzlee.app/docs/<product>/<slug>`
  on a page the change touched.
- The Cloudflare MCP server (`mcp__cloudflare-api__*`) is scoped to the same account: use it to
  read the Worker's state (`/workers/scripts/sezzlee-docs/deployments`, `/workers/domains`), not to
  upload the Worker — `wrangler deploy` is the only deploy path, because it uploads the prerendered
  assets alongside the script.

## Writing documentation

**Read [WRITING.md](WRITING.md) before adding or editing any page.** It is the
binding convention: three sections per product (quickstart, recipes, generated reference), rationale
folded into `:::details` next to what it explains, reference is generated not written, RFC 2119
keywords stay in `packages/http/spec`, every code example must have been run.

Pages are markdown under `src/content/<product>/`: one `00-quickstart.md`, recipes under `recipes/`,
generated pages under `reference/`; no other top-level page and no other folder exists. Order comes from the numeric filename prefix, the title from the
first `#` line, the slug from the filename with that prefix stripped. Slugs must be unique **within a
product** — the route is `/docs/$product/$slug`. A renamed slug goes into `src/content/redirects.json`,
which the `$slug` loader answers with a 301.

Nothing registers a page: `src/lib/content.ts` globs the tree at build time and derives the
sidebar and the home page's recipe list. Adding a **product** is two steps — create
`src/content/<id>/` with at least one page, and add one `{ id, label, goal, tagline }` entry to
`src/content/products.json`; the home page's icon for it is keyed by id in
`src/components/ProductIcon.tsx`. No route file changes; `$product` is a route param, so
`routeTree.gen.ts` is untouched.

Markdown goes through `src/lib/remark-docs.ts` and `src/components/DocMarkdown.tsx`: code blocks
with a copy button, the block under an `sh` command labelled as its output, `:::tabs` (each block
with `title="…"`) and `:::details[label]`. An unknown block directive throws; an unknown `:word` in
prose is kept as text, because `remark-directive` would otherwise drop it.

`pnpm --filter @sezzlee/docs validate` (`scripts/check-content.mjs`) enforces the structural half of
`WRITING.md`: folder/registry agreement, section folder names, one `00-quickstart.md` per product,
numeric prefixes, unique slugs, a `# Title` on every page, the recipe/reference title
patterns, the two known directives with titled tabs, `redirects.json` targets, and that every
internal `/docs/...` link points at a page that exists. It runs inside `pnpm lint` and in CI's node
job.

### Server products: generated reference and runnable examples

A server product (`excel-mcp`, `xml-mcp`, later `pdf-mcp`, `mssql-mcp`, `llm-mcp`) gets its
`reference/` pages from `scripts/gen-reference.mjs` — **never hand-edit them**:

- `01-tools.md` from the built server's own `tools/list` answer, so every argument and description
  is the text the agent reads.
- `02-error-codes.md` from the error-code union types named in `reference/<product>.json`, which
  holds one sentence per code. A code with no sentence, or a sentence for a code that no longer
  exists, fails the script. The example envelope at the top is a live call.
- `03-limits.md` from the package's exported `limits`, with one description per key in the same
  JSON; a key must be described or listed under `hidden` with a reason.

`pnpm --filter @sezzlee/docs gen` rewrites them; `validate` runs `gen --check`, which is why
`validate` depends on `^build` and the servers are `devDependencies` of this app. A product is
generated only once it is registered in `products.json`.

`scripts/run-examples.mjs` is WRITING.md rule 4 made executable. For each non-reference page it runs
every bare `sh` block (a block with `title="…"`, as in `:::tabs`, is never run) in order in one bash session, with `HOME` pointing at a sandbox that holds the
product's samples and a shim that starts the **workspace build** of the server, and compares each
output with the fenced block directly below its command (`--write` fills them in). Volatile values
(`modifiedAt`, `nextCursor`) are masked. A shell helper defined on a page (`excel() { ... }`) must be
byte-identical to the script's preamble. It needs the network for `npx`, so it is not in CI: run it
after any change to a server or a page, and before deploying. It runs servers, not test suites.

A product may define several helpers (`pdf` and `pdfocr`); each helper on a page must equal one of
them. A page listed under the product's `ollama` key (`true` for every page, as for `llm-mcp`) runs only
when `SEZZLEE_DOCS_OLLAMA` is set —
`local` for an Ollama on `127.0.0.1:11434`, or `host:port`, which the script forwards to
`127.0.0.1:11434` for that page, because the Inspector starts the server with a fixed environment
allow-list and the page's binding uses the default address. Without it the page is reported as
`skip`, not `ok`.

Variables a product's pages need are listed under `requires` and skip the page when unset:
`llm-mcp` needs `SEZZLEE_LLM_MODEL`, the model the outputs were produced with (the pages name it).
A product whose server needs credentials names them under `secrets`: `mssql-mcp` pages run only when
`SEZZLEE_DOCS_MSSQL_CONFIG` points at an Inspector configuration file (an `mcpServers.shop` entry
with the `SEZZLEE_MSSQL_*` variables in `env`), which the script copies into the sandbox as
`~/sezzlee-mssql.json` with mode 600 and deletes with it. Pages never contain a connection value, and
their outputs show only the `sezzlee_shop` sample schema (`public/samples/mssql-mcp/sezzlee-shop.sql`),
filtered with `schema=sezzlee_shop` and `jq` so the database and login names stay out.

`scripts/make-samples.mjs` (Excel) and `scripts/make-pdf-samples.mjs` (PDF, whose scanned page is
drawn with `@napi-rs/canvas` from `@sezzlee/pdf-raster-pdfjs`'s dependencies) write the downloadable
samples under `public/samples/<product>/`.
Regenerating them changes byte sizes that appear in page outputs, so rerun `run-examples --write`
afterwards and review the diff.

`.prettierrc.json` turns off embedded-code formatting for `src/content/**/*.md`: Prettier would
otherwise re-wrap measured output blocks, which rule 4 forbids editing.

**Oxlint cannot enforce anything here** — it reads source code, not the content registry. Neither can `vite build`: `content.ts` runs at request time, not build
time, so a `throw` in it fails `dev` but not `build`. The `validate` script is the only gate.

## Language

Site content and UI strings are **English** — this site is sezzlee's public face, and so is
`packages/http/spec`, which these pages link to as normative. There is no i18n layer, by design.

## Style layers — the one thing that breaks silently

`src/styles/app.css` is three lines and all three matter:

```css
@layer theme, base, components, mantine, utilities;
@import "tailwindcss" source("../");
@import "@mantine/core/styles.layer.css";
```

Tailwind preflight lives in `base`, ahead of `mantine`, so it cannot flatten Mantine component
styles. Tailwind utilities live in `utilities`, after `mantine`, so `<Button className="mt-4">`
works. The `@layer` statement must precede the `@import`s (CSS spec), and the first declaration is
what fixes the order.

Import `@mantine/core/styles.layer.css`, never `styles.css`, and never both — Mantine's own docs
forbid the pair. If a Mantine component ever looks unstyled, check this file first.

## Gotchas

- **Router links inside Mantine components**: use Mantine's `renderRoot`, not TanStack's
  `createLink`. `createLink` cannot infer props through Mantine's polymorphic `<C = "a">` generic
  and the component loses its own prop types. See `src/routes/docs.tsx`.
- **`src/routeTree.gen.ts` is generated and committed.** TanStack Router writes it on dev/build.
  Turbo runs `check-types` in parallel with `build`, not after it, so a clean checkout needs the
  file present or `tsc --noEmit` fails. Do not hand-edit it.
- **`viteReact()` must come after `tanstackStart()`** in `vite.config.ts`. Reversing them breaks
  the build.
- **`postcss.config.js` is not for Tailwind.** Tailwind goes through `@tailwindcss/vite`. The
  PostCSS config exists only so `.module.css` files can use Mantine mixins (`@mixin dark`, `rem()`).
- **`tsconfig.json` overrides the shared base to `moduleResolution: Bundler`** because
  `@sezzlee/typescript-config/base.json` is `NodeNext` and TanStack Start requires Bundler. Leave
  `verbatimModuleSyntax` off — Start's docs warn it can leak server bundles into the client.
