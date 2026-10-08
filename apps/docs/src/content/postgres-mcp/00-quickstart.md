# Let an agent query your PostgreSQL database

`@sezzlee/postgres-mcp` gives an agent read-only access to one PostgreSQL database. The agent finds
tables by what they hold, reads their columns and keys, and runs `SELECT` statements, each inside a
read-only transaction. It has no tool that writes.

You need Node.js 22 or later and a PostgreSQL database.

## 1. Create a read-only role

The role you connect with decides what the agent can reach, so give it a role of its own that can
read and nothing else; never one another application signs in with. Connected as an administrator:

```text
CREATE ROLE mcp_reader LOGIN PASSWORD 'a long random password';
GRANT CONNECT ON DATABASE sales TO mcp_reader;
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;
```

[Create a read-only role for the server](/docs/postgres-mcp/create-a-read-only-role-for-the-server)
covers tables created later, narrowing the role to some tables, and checking what it holds.

## 2. Add the server to your client

The server reads its connection from environment variables, never from a tool argument, so the agent
cannot see the password or point the server at another database.

:::tabs

```sh title="Claude Code"
claude mcp add sales -e SEZZLEE_POSTGRES_SERVER=db.example.com -e SEZZLEE_POSTGRES_DATABASE=sales \
  -e SEZZLEE_POSTGRES_USER=mcp_reader -e SEZZLEE_POSTGRES_PASSWORD=your_password \
  -- npx -y @sezzlee/postgres-mcp
```

```json title="Claude Desktop"
{
  "mcpServers": {
    "sales": {
      "command": "npx",
      "args": ["-y", "@sezzlee/postgres-mcp"],
      "env": {
        "SEZZLEE_POSTGRES_SERVER": "db.example.com",
        "SEZZLEE_POSTGRES_DATABASE": "sales",
        "SEZZLEE_POSTGRES_USER": "mcp_reader",
        "SEZZLEE_POSTGRES_PASSWORD": "your_password"
      }
    }
  }
}
```

```json title="Cursor"
{
  "mcpServers": {
    "sales": {
      "command": "npx",
      "args": ["-y", "@sezzlee/postgres-mcp"],
      "env": {
        "SEZZLEE_POSTGRES_SERVER": "db.example.com",
        "SEZZLEE_POSTGRES_DATABASE": "sales",
        "SEZZLEE_POSTGRES_USER": "mcp_reader",
        "SEZZLEE_POSTGRES_PASSWORD": "your_password"
      }
    }
  }
}
```

```json title="VS Code"
{
  "inputs": [{ "id": "postgres-password", "type": "promptString", "description": "PostgreSQL password", "password": true }],
  "servers": {
    "sales": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sezzlee/postgres-mcp"],
      "env": {
        "SEZZLEE_POSTGRES_SERVER": "db.example.com",
        "SEZZLEE_POSTGRES_DATABASE": "sales",
        "SEZZLEE_POSTGRES_USER": "mcp_reader",
        "SEZZLEE_POSTGRES_PASSWORD": "${input:postgres-password}"
      }
    }
  }
}
```

:::

Claude Desktop reads `claude_desktop_config.json` (**Settings → Developer → Edit Config**, then
restart). Cursor reads `~/.cursor/mcp.json`; a project's `.cursor/mcp.json` works too, but it is
usually committed and this entry holds a password. VS Code reads `.vscode/mcp.json` and can prompt
for the password instead of storing it. In Claude Code, keep the entry in your user or local scope:
`--scope project` writes `.mcp.json`, which is shared with everyone who clones the repository,
password included.

These configurations follow each client's documented format. The Claude Code command was checked
against `claude mcp add --help`; none of them was loaded into a client for this page.

:::details[Connection settings]

The server stops at startup and names any missing required variable.

| Variable                              | Default       | Meaning                                                        |
| ------------------------------------- | ------------- | -------------------------------------------------------------- |
| `SEZZLEE_POSTGRES_SERVER`             | required      | Host name or address of the PostgreSQL server.                 |
| `SEZZLEE_POSTGRES_DATABASE`           | required      | The one database the server reads.                             |
| `SEZZLEE_POSTGRES_USER`               | required      | PostgreSQL role.                                               |
| `SEZZLEE_POSTGRES_PASSWORD`           | required      | Its password.                                                  |
| `SEZZLEE_POSTGRES_PORT`               | `5432`        | TCP port.                                                      |
| `SEZZLEE_POSTGRES_SSL_MODE`           | `verify-full` | `disable`, `require` or `verify-full`.                         |
| `SEZZLEE_POSTGRES_CONNECT_TIMEOUT_MS` | `30000`       | Time allowed to open a connection.                             |
| `SEZZLEE_POSTGRES_QUERY_TIMEOUT_MS`   | `30000`       | Deadline for a statement when a call does not set `timeoutMs`. |

The default `verify-full` encrypts the connection and checks the server's certificate against the
host name you gave. A development server without TLS needs `SEZZLEE_POSTGRES_SSL_MODE` set to
`disable`, and one with a certificate nothing can verify needs `require`, which encrypts without
checking who answered. [Connect over TLS](/docs/postgres-mcp/connect-over-tls) covers the choice. One
server reads one database: to give an agent two, add two entries with different names and different
`SEZZLEE_POSTGRES_DATABASE` values.

:::

:::details[If the server does not start]

Run the command in a terminal with the same variables set: a missing variable prints its name. A
port or timeout that is not a whole number in range, or an SSL mode that is not one of the three,
stops the server with a message naming the setting. A database that cannot be reached does not:
connecting is lazy, so the server starts, lists its tools, and reports `connection_failed` on the
first call that needs the database.

:::

## 3. Ask

Ask the agent what is in the database, for example **Which tables hold customer orders?** Expect
`search_catalog` to find them from their names and descriptions, `describe_table` to read their
columns and keys, and `run_query` to answer. To check the connection, ask what it is connected to:
`describe_connection` names the database, the role and the server version, and never returns the
password.

## See what the agent receives

The recipes call the tools the way an agent does, through the MCP Inspector, so you can see each
answer exactly. You need [jq](https://jqlang.org) and the server installed once:

```sh
npm install -g @sezzlee/postgres-mcp
```

The examples use a small sample schema. Download [sezzlee-shop.sql](/samples/postgres-mcp/sezzlee-shop.sql)
and run it in a database you may create a schema in, for example with `psql`. It drops and
recreates only `sezzlee_shop`, so you can run it again to start over.

```text
psql -h db.example.com -d YourDatabase -U your_user -v ON_ERROR_STOP=1 -f sezzlee-shop.sql
```

The file grants nothing. If you connect as the role that ran it, that role owns the tables and can
read them. If you connect as another role, such as `mcp_reader`, grant it the schema after each run:

```text
GRANT USAGE ON SCHEMA sezzlee_shop TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA sezzlee_shop TO mcp_reader;
```

The Inspector starts the server from a configuration file. Save this as `~/sezzlee-postgres.json`
with your own values, and make it readable by you alone. Add `SEZZLEE_POSTGRES_SSL_MODE` to `env` if
your server needs something other than `verify-full`:

```json
{
  "mcpServers": {
    "shop": {
      "command": "sezzlee-postgres",
      "env": {
        "SEZZLEE_POSTGRES_SERVER": "db.example.com",
        "SEZZLEE_POSTGRES_DATABASE": "YourDatabase",
        "SEZZLEE_POSTGRES_USER": "your_user",
        "SEZZLEE_POSTGRES_PASSWORD": "your_password"
      }
    }
  }
}
```

```sh
chmod 600 ~/sezzlee-postgres.json
```

Define this helper in your shell. Every tool answers with one text item that holds JSON; the `jq`
unpacks it.

```sh
sql() {
  npx -y @modelcontextprotocol/inspector --cli --config ~/sezzlee-postgres.json --server shop \
    --method tools/call --tool-name "$@" | jq '.content[0].text | fromjson'
}
```

This is the question an agent answers with a join: which customers spent the most.

```sh
sql run_query --tool-arg sql="SELECT c.name, COUNT(*) AS orders, SUM(t.total) AS spent FROM sezzlee_shop.order_totals AS t JOIN sezzlee_shop.customers AS c ON c.customer_id = t.customer_id WHERE t.status <> 'cancelled' GROUP BY c.name ORDER BY spent DESC" \
  | jq -c '.rows[]'
```

```json
["Ada Yılmaz","2","735.00"]
["Emre Kaya","2","620.00"]
["Lena Müller","1","273.00"]
["Zoë Martin","1","215.50"]
```

The counts and sums arrive as strings, not JSON numbers: `COUNT` is a `bigint` and `SUM` of a
`numeric` is a `numeric`, and PostgreSQL's own text is passed on so no digit is lost.
[Read exact numbers, dates and ids](/docs/postgres-mcp/read-exact-numbers-dates-and-ids) shows how
each type arrives and how to get a number when you want one.

## What it can do

- **Find tables by concept**: `search_catalog` matches words against table, view and column names and
  their comments, and says why each result matched.
- **Read a table's shape**: columns with types and nullability, primary, unique and foreign keys.
- **Run one read-only statement**: typed rows, 100 by default and 1,000 at most, under a deadline the
  server enforces by closing the connection.
- **Keep exact values exact**: `bigint`, `numeric`, dates and timestamps arrive as the text
  PostgreSQL wrote, never rounded through a JSON number.

:::details[Why the transaction and the role both matter]

Every query, the catalogue questions included, runs in its own `START TRANSACTION READ ONLY` and
ends in `ROLLBACK`, even after a successful read. PostgreSQL itself refuses an `INSERT`, `UPDATE`,
`DELETE`, `nextval` or schema change inside such a transaction, and the rollback undoes any setting
the statement changed, so nothing outlives the query. The server also refuses to answer while the
connected role is a superuser, can create roles or replicate, or can read or write server files, run
server programs or signal other sessions.

The statement check in front of that reads text, and `describe_connection` calls it advisory: it
refuses a batch, a statement that does not begin with `SELECT` or `WITH`, and a short list of
functions that reach outside the transaction. It cannot see what a view or a function the database
defines calls, and such a function can still open a connection of its own, for example through
`dblink`. A role with `SELECT` and nothing else limits what a call it misses can reach, which is why
the role is the first step.

:::
