# Run the server from source

Try an unreleased change, or point a client at a local build. You need Node.js 22 or later, pnpm and
a clone of the repository, on a platform the PDF engine supports.

## Build and run

From the repository root:

```text
pnpm install
pnpm turbo run build --filter=@sezzlee/pdf-mcp
node packages/servers/pdf-mcp/dist/cli.js /absolute/path/to/documents
```

Build through Turbo, not `pnpm --filter @sezzlee/pdf-mcp build`: the server uses `@sezzlee/file-core`
through its built `dist/`, and only Turbo builds it first.

In a client configuration, use `"command": "node"` and
`"args": ["/absolute/path/to/sezzlee/packages/servers/pdf-mcp/dist/cli.js", "/absolute/path/to/documents"]`.
Add `"--ocr"` and a binding path after the folder to enable OCR.

## Call it by hand

```text
npx @modelcontextprotocol/inspector node packages/servers/pdf-mcp/dist/cli.js /absolute/path/to/documents
```

This opens the Inspector's web interface with the server connected, where you can call every tool.

## Test it

```text
pnpm turbo run test --filter=@sezzlee/pdf-mcp
pnpm turbo run check-types lint --filter=@sezzlee/pdf-mcp
```

The OCR tests run against fake ports. A suite against a real Ollama is skipped unless
`SEZZLEE_PDF_OCR_URL` is set; it reads `SEZZLEE_PDF_OCR_MODEL` too, and defaults to
`deepseek-ocr:3b`.
