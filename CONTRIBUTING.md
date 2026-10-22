# Contributing

## Setup

Node.js 24+ and pnpm 11 (`corepack enable`).

```bash
pnpm install
pnpm build          # turbo run build
pnpm lint           # oxlint, fixture validation, content checks, prettier
pnpm check-types
```

## Repository layout

`packages/` is grouped by role, not by dependency:

| Folder               | Holds                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| `packages/http`      | The HTTP catalog line: spec, conformance corpus, core, OpenAPI ingestion |
| `packages/cores`     | Shared machinery for source servers; nothing here runs on its own        |
| `packages/servers`   | The runnable MCP servers, each with a `bin`                              |
| `packages/adapters`  | Pluggable implementations of a server's ports (OCR, rasterizing)         |
| `packages/toolchain` | Shared oxlint and TypeScript configuration                               |
| `packages/lab`       | Evidence harnesses; no shipping surface                                  |
| `sdks/`              | The NestJS SDK                                                           |
| `apps/docs`          | The documentation site                                                   |

Package names are flat (`@sezzlee/excel-mcp`), so `--filter` never mentions a folder. The boundaries
between packages — which may depend on which, and what each must never name — are listed in
[AGENTS.md](AGENTS.md) and enforced by lint.

## Tests

Run tests through Turbo, so dependencies are built first:

```bash
pnpm turbo run test --filter=@sezzlee/excel-mcp
```

`pnpm --filter <pkg> test` skips `dependsOn: ["^build"]` and can test against a stale `dist`.
Prefer a single file or name filter while iterating — the full suite is large.

## Rules that fail the build

- **Lint is a gate.** Every package runs `oxlint --deny-warnings`. Layering rules — which folder may
  import what, which package may reach the network or the filesystem — are lint rules.
- **Spec types are generated.** Change a schema in `packages/http/spec/schemas`, then run
  `pnpm turbo run gen`. `packages/http/core/src/generated/` is committed and never edited by
  hand.
- **A spec change moves a fixture.** If a schema or rule change breaks fixtures, update them in the
  same change; a rule that no fixture pins has not been made.
- **No silent resolution.** A name collision, an unknown argument or an unrepresentable construct is
  an error or a diagnostic, never a quiet fallback.
- **A published package never depends on a private one.** CI's `pack` job checks the tarballs.

## Comments

Most code carries no comments. A comment is written only as a JSDoc/TSDoc block (`/** */`), and only to state **why** where the code is protecting an invariant, a security
property or a measured trap — what the guard is and what breaks without it. No `//` line comments,
no TODOs, no history. Measurements that justify a limit live in the guard comment next to it.

## Documentation

- The spec (`packages/http/spec`) is normative and written in English with RFC 2119 keywords.
- The docs site (`apps/docs`) is English and follows
  [apps/docs/WRITING.md](apps/docs/WRITING.md) (Diátaxis: one page, one mode).
- Package READMEs are English.
- There is no separate design-record tree. A decision lives next to what it constrains: the spec, a
  guard comment or the package README. Work that is planned but not built goes in
  [ROADMAP.md](ROADMAP.md), and leaves it when it ships.
