# @sezzlee/postgres-mcp

Read-only PostgreSQL MCP server. Uses the shared database core for four tools: `describe_connection`, `search_catalog`, `describe_table`, and `run_query`.

The database principal must have only the privileges needed to read approved objects. `run_query` measures the principal before it runs a statement and refuses every query while the principal is a superuser, can create roles, replicate, read or write server files, run server programs or signal other backends. Every query, catalogue question included, runs in its own `START TRANSACTION READ ONLY` with transaction-local statement and lock deadlines, `pg_catalog` as its search path and `standard_conforming_strings` on, so no setting outlives the transaction or reaches another client through a transaction pooler; session advisory locks are released before commit, and a connection whose transaction failed is closed rather than reused. Qualify application tables with their schema. The statement guard only refuses a batch, a statement that does not begin with `SELECT` or `WITH`, and an unterminated literal or comment, and says which.

## CLI

Run `sezzlee-postgres` over MCP stdio. Required environment variables:

| Variable                    | Meaning                           |
| --------------------------- | --------------------------------- |
| `SEZZLEE_POSTGRES_SERVER`   | PostgreSQL hostname or IP address |
| `SEZZLEE_POSTGRES_DATABASE` | Exact database name               |
| `SEZZLEE_POSTGRES_USER`     | Reader principal                  |
| `SEZZLEE_POSTGRES_PASSWORD` | Password                          |

Optional variables: `SEZZLEE_POSTGRES_PORT` (5432), `SEZZLEE_POSTGRES_SSL_MODE` (`verify-full`), `SEZZLEE_POSTGRES_CONNECT_TIMEOUT_MS` (30000), and `SEZZLEE_POSTGRES_QUERY_TIMEOUT_MS` (30000). SSL modes are `disable`, `require` (encryption without certificate verification), and `verify-full` (verified certificate chain and original hostname). Configuration parsing is fatal; connection opening is lazy, allowing tool discovery while the database is unavailable.

## Embedding

`createPostgresSource(config, options?)` returns `DbSource<PostgresConfig>`; `createPostgresMcpServer(source)` exposes the shared tools. Configuration fields: `server`, `port`, `database`, `user`, `password`, `sslMode`, `connectTimeoutMs`, `queryTimeoutMs`.

`options.host` overrides the physical dial address, allowing a caller to pin an approved IP. `options.serverName` retains the original certificate hostname independently of that address. Verified TLS uses this original identity for certificate checks; IP identities omit SNI. Callers requiring verified TLS must choose `verify-full`. Test seams `clientFactory` and `cursorFactory` accept structural driver adapters; production defaults use `pg` and `pg-cursor`.

Rows arrive through server cursors in batches of at most 128. One lookahead row proves truncation; the portal is closed and PostgreSQL acknowledges readiness before the connection returns to the shared pool. Caller cancellation and deadlines close the physical connection, which the core quarantines before reuse. Numeric/bigint and temporal text parsers preserve decimal precision, microseconds, and timestamp offsets. Unknown driver type OIDs remain explicitly unknown.

Catalog introspection includes readable tables, partitions, foreign tables, views/materialized views, column descriptions, table descriptions, primary/unique/foreign constraints, and server identity. Names are matched exactly; catalog ordering uses the deterministic `C` collation. Unique indexes that are not constraints are not reported as keys.

## Verification

`pnpm turbo run build check-types lint test --filter=@sezzlee/postgres-mcp` verifies unit and fake-driver lifecycle checks. No live database is needed. Live PostgreSQL protocol/catalog verification requires an existing authorized endpoint and has not been performed for this package.
