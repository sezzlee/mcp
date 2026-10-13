# @sezzlee/file-core

Shared machinery for read-only, sandboxed, file-backed MCP servers. `@sezzlee/excel-mcp`,
`@sezzlee/xml-mcp` and `@sezzlee/pdf-mcp` are all built on top of it.

The source-agnostic machinery (`guard`, the response budget, the error envelope, the cursor
codec, the stdio server) **moved to `@sezzlee/mcp-core`**; this package consumes it, adds the
file-specific layer, and re-exports its full surface except the output-writing tool type
(`ownOutput`, `OwnOutputToolDefinition`, `ToolCatalog`, `createMcpOutputServer`).

This package is **not `@sezzlee/core`** and does not depend on it in either direction.
`@sezzlee/core` is the spec's HTTP catalog reference implementation; this package is the machinery
behind local file sources.

## Usage

A file server names only this package (never `@sezzlee/mcp-core` directly): it resolves paths
through `createSandboxRoot`/`resolveSourcePath`, lists sources with `listSources`, opens and caches
documents with `createDocumentStore`, and wraps its handlers with the `guard`/`toToolError` this
package re-exports — both already bound to the root redactor, so no file server can emit an error
envelope carrying an absolute path. `parseServerArgv` reads the single positional sandbox root from
`argv`.

## API

| Module       | Exports                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths`      | The `SandboxedPath` brand, `SandboxRoot`, `isContained`, `createSandboxRoot`, `resolveSourcePath` — an ordered fail-fast chain that never discloses existence |
| `listing`    | `listSources` — glob matching, symlink containment, a scan limit, a count of unreadable entries                                                               |
| `documents`  | `createDocumentStore` — open + fstat + size gate + fingerprint + an instance-scoped LRU; parse and `variantKey` hooks                                         |
| `cursor`     | `fingerprint` — identity from path, mtime and size; content fingerprinting comes from `mcp-core`                                                              |
| `errors`     | `FileSourceError`, `CoreErrorCode`, `redactRoot` — widens `mcp-core`'s base with the file error codes                                                         |
| `formats`    | `FormatRegistry` — extension-to-format mapping, `unsupported_extension`                                                                                       |
| `tools`      | `guard` and `toToolError` wrappers — bind `mcp-core`'s root redactor                                                                                          |
| `cli`        | `parseServerArgv` — pure argv parsing                                                                                                                         |
| `vocabulary` | `Vocabulary<TToolName>` — adds `rootLabel`, `readableLabel`, `tooLargeRecovery` to `mcp-core`'s base                                                          |

## Rules

- **No format-specific vocabulary.** A string literal such as `"workbook"`, `"sheet"`,
  `"spreadsheet"` or `"excel"` inside this package is a defect; user-facing names arrive through
  the injected `Vocabulary`.
- **Error instances come from the injected `ErrorFactory`.** The package never calls
  `new FileSourceError(...)`, which keeps a consumer's own error class and `instanceof` checks
  intact.
- **`zod` and `@modelcontextprotocol/sdk` are peer dependencies.** Two resolved copies would
  break `z.infer` type identity, and the SDK's schema introspection does an `instanceof` check.
- **Root redaction is bound by `guard`, not at call sites.** `redactRoot` plugs into `mcp-core`'s
  `ErrorContext.redact` seam here, so no file server can produce an error envelope carrying an
  absolute path.
- **The `SandboxedPath` brand is declared only here**, and `Fingerprint` only in `mcp-core`. A
  second `unique symbol` declaration is not the same brand.

## What stays here

`cli.ts` (`parseServerArgv`) and `fingerprint(realPath, mtimeMs, size)` stay in this package
rather than in `mcp-core`: the single positional root argument and an identity built from file
metadata are file concepts. The generic `fingerprintFromDigest` and
`contentFingerprint` are in `mcp-core`.

## Development

```bash
pnpm turbo run build check-types lint --filter=@sezzlee/file-core
pnpm turbo run test --filter=@sezzlee/file-core
```

Always build through Turbo, never `pnpm --filter @sezzlee/file-core run build` on its own —
downstream consumers such as `excel-mcp` resolve this package through `exports.default →
./dist/index.js`, so a bare filter can leave them testing against a stale `dist`.
