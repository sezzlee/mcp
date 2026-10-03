# Tools

> Generated from the `tools/list` answer (server name `sezzlee-mssql`) of `@sezzlee/mssql-mcp` 0.2.0.

The descriptions are the text the server publishes to every client, so your agent reads exactly what this page shows. Every input schema is closed: an argument a tool does not list here, or a value of the wrong type, is refused with `invalid_argument` and never silently ignored.

4 tools: `describe_connection`, `search_catalog`, `describe_table`, `run_query`.

## `describe_connection`

Report which database this server is connected to, what the connection may do, and the limits every other tool is bound by. Takes no arguments and never returns credentials.

Annotations: read-only, idempotent, closed world.

Takes no arguments.

## `search_catalog`

Find the tables and views this connection can read by concept rather than by exact name: the query is matched against schema, object and column names and against whatever descriptions the catalogue carries, and each result says which of them matched. Leave query empty to page through the catalogue instead. Start here — the names it returns are the ones describe_table and run_query accept.

Annotations: read-only, idempotent, closed world.

| Argument       | Type                   | Required | Description                                                                                                                                                       |
| -------------- | ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`        | string (≤ 256 chars)   |          | Words describing what you are looking for, such as customer orders. Matched against names and descriptions, ignoring case and accents. Omit to list every object. |
| `schema`       | string (1–256 chars)   |          | Keep only objects in this schema. Case-insensitive.                                                                                                               |
| `namePattern`  | string (1–256 chars)   |          | Keep only objects whose name matches this LIKE pattern: % stands for any run of characters and _ for one. Case- and accent-insensitive.                           |
| `includeViews` | boolean                |          | Include views as well as tables, default true.                                                                                                                    |
| `maxResults`   | integer (1–200)        |          | Maximum objects returned, default 50.                                                                                                                             |
| `cursor`       | string (1–16384 chars) |          | nextCursor from a previous search with the same query, schema, namePattern and includeViews, to continue its results.                                             |
| `refresh`      | boolean                |          | Read the catalogue again instead of using the cached copy, default false. Use it after a schema change; it invalidates earlier cursors.                           |

## `describe_table`

Report one table's columns with their types and nullability, plus its primary, unique and foreign keys. Read this before writing a query against the table.

Annotations: read-only, idempotent, closed world.

| Argument | Type                 | Required | Description                                               |
| -------- | -------------------- | -------- | --------------------------------------------------------- |
| `schema` | string (1–256 chars) | yes      | Schema of the table, as search_catalog returned it.       |
| `table`  | string (1–256 chars) | yes      | Name of the table or view, as search_catalog returned it. |

## `run_query`

Run one read-only SQL statement and return its rows. Writes are refused. The response is capped and there is no cursor, so walk a large result by adding your own ordering and paging clause; a truncated response says which clause this engine uses.

Annotations: read-only, idempotent, closed world.

| Argument    | Type                   | Required | Description                                                                                                                                      |
| ----------- | ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sql`       | string (1–20000 chars) | yes      | One read-only statement in this engine's SQL dialect. A statement that writes, or more than one statement, is refused.                           |
| `maxRows`   | integer (1–1000)       |          | Maximum rows returned. Defaults to defaultRows from describe_connection. A longer result is cut and says so.                                     |
| `timeoutMs` | integer (100–600000)   |          | Deadline for the statement in milliseconds; the server cancels it when the deadline passes. Defaults to queryTimeoutMs from describe_connection. |
