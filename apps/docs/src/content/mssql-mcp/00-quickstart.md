# Let an agent query your SQL Server database

`@sezzlee/mssql-mcp` gives an agent read-only access to one Microsoft SQL Server database. The agent
finds tables by what they hold, reads their columns and keys, and runs `SELECT` statements. It has
no tool that writes.

You need Node.js 22 or later and a SQL Server database. The server was measured against SQL Server
2019 (15.0).

## 1. Create a read-only login

The login you connect with decides what the agent can do, so give it `db_datareader` and nothing
else. Connected as an administrator:

```text
CREATE LOGIN mcp_reader WITH PASSWORD = 'a long random password', CHECK_POLICY = ON;
GO
USE Sales;
GO
CREATE USER mcp_reader FOR LOGIN mcp_reader;
ALTER ROLE db_datareader ADD MEMBER mcp_reader;
GO
```

[Create a read-only login for the server](/docs/mssql-mcp/create-a-read-only-login-for-the-server)
covers narrowing it to some tables and checking what it holds.

## 2. Add the server to your client

The server reads its connection from environment variables, never from a tool argument, so the agent
cannot see the password or point the server at another database.

:::tabs

```sh title="Claude Code"
claude mcp add sales -e SEZZLEE_MSSQL_SERVER=db.example.com -e SEZZLEE_MSSQL_DATABASE=Sales \
  -e SEZZLEE_MSSQL_USER=mcp_reader -e SEZZLEE_MSSQL_PASSWORD=your_password \
  -- npx -y @sezzlee/mssql-mcp
```

```json title="Claude Desktop"
{
  "mcpServers": {
    "sales": {
      "command": "npx",
      "args": ["-y", "@sezzlee/mssql-mcp"],
      "env": {
        "SEZZLEE_MSSQL_SERVER": "db.example.com",
        "SEZZLEE_MSSQL_DATABASE": "Sales",
        "SEZZLEE_MSSQL_USER": "mcp_reader",
        "SEZZLEE_MSSQL_PASSWORD": "your_password"
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
      "args": ["-y", "@sezzlee/mssql-mcp"],
      "env": {
        "SEZZLEE_MSSQL_SERVER": "db.example.com",
        "SEZZLEE_MSSQL_DATABASE": "Sales",
        "SEZZLEE_MSSQL_USER": "mcp_reader",
        "SEZZLEE_MSSQL_PASSWORD": "your_password"
      }
    }
  }
}
```

```json title="VS Code"
{
  "inputs": [{ "id": "mssql-password", "type": "promptString", "description": "SQL Server password", "password": true }],
  "servers": {
    "sales": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sezzlee/mssql-mcp"],
      "env": {
        "SEZZLEE_MSSQL_SERVER": "db.example.com",
        "SEZZLEE_MSSQL_DATABASE": "Sales",
        "SEZZLEE_MSSQL_USER": "mcp_reader",
        "SEZZLEE_MSSQL_PASSWORD": "${input:mssql-password}"
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

| Variable                                 | Default  | Meaning                                                        |
| ---------------------------------------- | -------- | -------------------------------------------------------------- |
| `SEZZLEE_MSSQL_SERVER`                   | required | Host name or address of the SQL Server.                        |
| `SEZZLEE_MSSQL_DATABASE`                 | required | The one database the server reads.                             |
| `SEZZLEE_MSSQL_USER`                     | required | SQL Server login.                                              |
| `SEZZLEE_MSSQL_PASSWORD`                 | required | Its password.                                                  |
| `SEZZLEE_MSSQL_PORT`                     | `1433`   | TCP port.                                                      |
| `SEZZLEE_MSSQL_ENCRYPT`                  | `true`   | Encrypt the connection.                                        |
| `SEZZLEE_MSSQL_TRUST_SERVER_CERTIFICATE` | `false`  | Accept a server certificate that cannot be verified.           |
| `SEZZLEE_MSSQL_CONNECT_TIMEOUT_MS`       | `15000`  | Time allowed to open a connection.                             |
| `SEZZLEE_MSSQL_QUERY_TIMEOUT_MS`         | `30000`  | Deadline for a statement when a call does not set `timeoutMs`. |

A development server with no certificate a client can verify needs
`SEZZLEE_MSSQL_TRUST_SERVER_CERTIFICATE` set to `true`, or `SEZZLEE_MSSQL_ENCRYPT` set to `false` if
it does not offer encryption at all. One server reads one database: to give an agent two, add two
entries with different names and different `SEZZLEE_MSSQL_DATABASE` values.

:::

:::details[If the server does not start]

Run the command in a terminal with the same variables set: a missing variable prints its name. A
port or timeout that is not a positive integer, or a flag that is not `true` or `false`, stops the
server with a message naming the variable. A database that cannot be reached does not: connecting is
lazy, so the server starts, lists its tools, and reports `connection_failed` on the first call that
needs the database.

:::

## 3. Ask

Ask the agent what is in the database, for example **Which tables hold customer orders?** Expect
`search_catalog` to find them from their names and descriptions, `describe_table` to read their
columns and keys, and `run_query` to answer. To check the connection, ask what it is connected to:
`describe_connection` names the database and the login and never returns the password.

## See what the agent receives

The recipes call the tools the way an agent does, through the MCP Inspector, so you can see each
answer exactly. You need [jq](https://jqlang.org) and the server installed once:

```sh
npm install -g @sezzlee/mssql-mcp
```

The examples use a small sample schema. Download [sezzlee-shop.sql](/samples/mssql-mcp/sezzlee-shop.sql)
and run it in a database you may create a schema in, for example with `sqlcmd`. It drops and
recreates only `sezzlee_shop`, so you can run it again to start over.

```text
sqlcmd -S db.example.com -d YourDatabase -U your_user -i sezzlee-shop.sql
```

The Inspector starts the server from a configuration file. Save this as `~/sezzlee-mssql.json` with
your own values, and make it readable by you alone:

```json
{
  "mcpServers": {
    "shop": {
      "command": "sezzlee-mssql",
      "env": {
        "SEZZLEE_MSSQL_SERVER": "db.example.com",
        "SEZZLEE_MSSQL_DATABASE": "YourDatabase",
        "SEZZLEE_MSSQL_USER": "your_user",
        "SEZZLEE_MSSQL_PASSWORD": "your_password"
      }
    }
  }
}
```

```sh
chmod 600 ~/sezzlee-mssql.json
```

Define this helper in your shell. Every tool answers with one text item that holds JSON; the `jq`
unpacks it.

```sh
sql() {
  npx -y @modelcontextprotocol/inspector --cli --config ~/sezzlee-mssql.json --server shop \
    --method tools/call --tool-name "$@" | jq '.content[0].text | fromjson'
}
```

This is the question an agent answers with a join: which customers spent the most.

```sh
sql run_query --tool-arg sql="SELECT c.name, COUNT(*) AS orders, SUM(t.total) AS spent FROM sezzlee_shop.order_totals AS t JOIN sezzlee_shop.customers AS c ON c.customer_id = t.customer_id WHERE t.status <> 'cancelled' GROUP BY c.name ORDER BY spent DESC" \
  | jq -c '.rows[]'
```

```json
["Ada Yılmaz",2,735]
["Emre Kaya",2,620]
["Lena Müller",1,273]
["Zoë Martin",1,215.5]
```

## What it can do

- **Find tables by concept**: `search_catalog` matches words against table, view and column names and
  their descriptions, and says why each result matched.
- **Read a table's shape**: columns with types and nullability, primary, unique and foreign keys.
- **Run one read-only statement**: typed rows, 100 by default and 1,000 at most, under a deadline the
  server enforces by cancelling the statement.
- **Tell exact values from approximate ones**: a column whose values cannot reach JSON intact, such
  as a wide `decimal`, is flagged `lossy` rather than silently rounded.

:::details[Why the database login is the security boundary]

The server refuses a statement that does not begin with `SELECT` or `WITH`, but that check reads
text, and T-SQL has many ways to write that start with `SELECT`. SQL Server has no read-only session
either: `describe_connection` reports `sessionIntent: "none"` and `statementGuard: "advisory"`
rather than claim a guarantee that does not exist. What SQL Server enforces is the permissions of
the login, so a login with `db_datareader` and nothing else cannot write, whatever the statement
looks like. The check exists to give an agent that tries to write a clear early error,
`write_not_permitted`, not to protect the data.

:::
