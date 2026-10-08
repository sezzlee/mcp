# Run the server from source

Try an unreleased change, or point a client at a local build. You need Node.js 22 or later, pnpm and a
clone of the repository.

## Build and run

From the repository root:

```text
pnpm install
pnpm turbo run build --filter=@sezzlee/xml-mcp
node packages/servers/xml-mcp/dist/cli.js /absolute/path/to/documents
```

Build through Turbo, not `pnpm --filter @sezzlee/xml-mcp build`. The server depends on
`@sezzlee/file-core` through its built `dist/`, and only Turbo builds it first. The build also has to
emit the parse worker as `dist/xml-worker.js`; a server started without it cannot parse anything.

In a client configuration, use `"command": "node"` and
`"args": ["/absolute/path/to/sezzlee/packages/servers/xml-mcp/dist/cli.js", "/absolute/path/to/documents"]`.

## Call it by hand

```text
npx @modelcontextprotocol/inspector node packages/servers/xml-mcp/dist/cli.js /absolute/path/to/documents
```

This opens the Inspector's web interface with the server connected, where you can call every tool.

## Test it

```text
pnpm turbo run test --filter=@sezzlee/xml-mcp
pnpm turbo run check-types lint --filter=@sezzlee/xml-mcp
```

Tests on large documents are skipped by default; set `SEZZLEE_XML_LARGE=1` to run them.
