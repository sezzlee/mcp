# Run the server from source

Try an unreleased change, or point a client at a local build. You need Node.js 22 or later, pnpm and
a clone of the repository.

## Build and run

From the repository root:

```text
pnpm install
pnpm turbo run build --filter=@sezzlee/mssql-mcp
```

Build through Turbo, not `pnpm --filter @sezzlee/mssql-mcp build`. The server depends on
`@sezzlee/db-core` through its built `dist/`, and only Turbo builds it first.

Set the connection variables, then start the build:

```text
SEZZLEE_MSSQL_SERVER=db.example.com SEZZLEE_MSSQL_DATABASE=Sales \
SEZZLEE_MSSQL_USER=mcp_reader SEZZLEE_MSSQL_PASSWORD=... \
node packages/servers/mssql-mcp/dist/cli.js
```

To use the build from a client, set `"command": "node"`, `"args":
["/absolute/path/to/sezzlee/packages/servers/mssql-mcp/dist/cli.js"]` and the same `env` block as for
the published package.

## Call it by hand

```text
npx @modelcontextprotocol/inspector -e SEZZLEE_MSSQL_SERVER=db.example.com -e SEZZLEE_MSSQL_DATABASE=Sales \
  -e SEZZLEE_MSSQL_USER=mcp_reader -e SEZZLEE_MSSQL_PASSWORD=... \
  node packages/servers/mssql-mcp/dist/cli.js
```

The Inspector starts the server with only a few variables of its own environment, so pass the
connection with `-e`. This opens its web interface with the server connected.

## Test it

```text
pnpm turbo run test --filter=@sezzlee/mssql-mcp
pnpm turbo run check-types lint --filter=@sezzlee/mssql-mcp
```

These tests need no database. A live suite checks the catalogue queries and cancellation against a
real server; it runs only with `SEZZLEE_MSSQL_LIVE=1` and the connection variables set. Never point
it at production: it cancels queries and drops connections on purpose.
