# Run the server from source

Try an unreleased change, or point a client at a local build. You need Node.js 22 or later, pnpm and
a clone of the repository.

## Build and run

From the repository root:

```text
pnpm install
pnpm turbo run build --filter=@sezzlee/excel-mcp
node packages/servers/excel-mcp/dist/cli.js /absolute/path/to/sheets
```

Build through Turbo, not `pnpm --filter @sezzlee/excel-mcp build`: the server uses
`@sezzlee/file-core` and `@sezzlee/ooxml-core` through their built `dist/`, and only Turbo builds them
first.

In a client configuration, use `"command": "node"` and
`"args": ["/absolute/path/to/sezzlee/packages/servers/excel-mcp/dist/cli.js", "/absolute/path/to/sheets"]`.

## Call it by hand

```text
npx @modelcontextprotocol/inspector node packages/servers/excel-mcp/dist/cli.js /absolute/path/to/sheets
```

This opens the Inspector's web interface with the server connected.

## Test it

```text
pnpm turbo run test --filter=@sezzlee/excel-mcp
pnpm turbo run check-types lint --filter=@sezzlee/excel-mcp
```

The test suite builds its own fixture workbooks and needs no files of yours.
