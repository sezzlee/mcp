# Create a read-only role for the server

The role the server connects with decides what it can reach. Give it a role that can read and nothing
else, so that a statement the server's checks miss has little to reach.

Not run by us: these statements need permissions our test role does not hold. They follow the
PostgreSQL documentation for `CREATE ROLE`, `GRANT` and `ALTER DEFAULT PRIVILEGES`.

## Create the role and grant it reads

Connected as an administrator, create a role that can sign in, and let it connect and read one
schema:

```text
CREATE ROLE mcp_reader LOGIN PASSWORD 'a long random password';
GRANT CONNECT ON DATABASE sales TO mcp_reader;
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;
```

`GRANT SELECT ON ALL TABLES` covers the tables and views that exist now. A table created later is not
covered until it is granted too, unless you set a default for the role that creates them:

```text
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public GRANT SELECT ON TABLES TO mcp_reader;
```

Without `FOR ROLE`, the default applies to objects created by the role that runs the statement.

The role has no `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE`, cannot create objects, and has no access
to a schema you did not name. It must not be a superuser, hold `CREATEROLE` or `REPLICATION`, or be a
member of `pg_read_server_files`, `pg_write_server_files`, `pg_execute_server_program` or
`pg_signal_backend`: `run_query` refuses every query while the role is any of these. On PostgreSQL 14
and later, `GRANT pg_read_all_data TO mcp_reader` reads every schema in one statement.

## Narrow it further

To expose only some tables, grant `SELECT` on single objects instead of a whole schema:

```text
GRANT USAGE ON SCHEMA reporting TO mcp_reader;
GRANT SELECT ON reporting.sales_summary, reporting.regions TO mcp_reader;
```

`search_catalog` lists only the tables and views the role can read in a schema it may use, so an
object it may not read does not appear in the agent's results at all. A query against it fails with
`permission_denied`.

## Check what the role can do

Ask the server what it measured. `principalPosture` is `read_only` when the role can write nothing
and administer nothing:

```sh
sql describe_connection | jq -c '.readOnly | {sessionIntent, principalPosture, statementGuard}'
```

```json
{"sessionIntent":"read_only","principalPosture":"read_only","statementGuard":"advisory"}
```

`administrator` means the role is one of the roles `run_query` refuses, and `writable` means it can
create objects or change a table. A `writable` role can still query, because the read-only
transaction contains it, but the role is wider than the server needs. The server measures the role
once and reuses the answer for five minutes, so a grant you change shows up in `principalPosture`
after that.

:::details[If principalPosture says writable]

The measurement asks four questions: may the role create in the database, may it create in any
schema outside the system ones, may it change any table, and is it an administrator. Three things
commonly answer yes by accident.

- **The role owns tables.** An owner can change them. Connect as a different role from the one that
  owns the data.
- **PostgreSQL 14 and earlier give every role `CREATE` on schema `public`** through `PUBLIC`. Run
  `REVOKE CREATE ON SCHEMA public FROM PUBLIC;` as the database owner, or keep the data in another
  schema.
- **A grant to `PUBLIC`.** `INSERT` on a table granted to `PUBLIC` reaches every role. Revoke it from
  `PUBLIC`; revoking it from `mcp_reader` does nothing.

:::

## See what the server refuses

Uses the `sql` helper from the [Quickstart](/docs/postgres-mcp/quickstart#see-what-the-agent-receives)
on the `sezzlee_shop` sample schema.

```sh
sql run_query --tool-arg sql="DELETE FROM sezzlee_shop.orders WHERE order_id = 1005"
```

```text
{"error":{"code":"tool_is_error","message":"Tool 'run_query' returned isError:true."}}
{
  "error": "write_not_permitted",
  "message": "A query has to begin with SELECT or WITH; this one begins with DELETE.",
  "recovery": "Rewrite the request as a SELECT."
}
```

The first line comes from the Inspector; the object under it is the server's answer. The statement
never reached the database: the check in front of it refuses anything that does not begin with
`SELECT` or `WITH`. A statement that does begin that way can still write, for example by deleting
inside a `WITH`:

```sh
sql run_query --tool-arg sql="WITH gone AS (DELETE FROM sezzlee_shop.orders WHERE order_id = 1005 RETURNING order_id) SELECT order_id FROM gone"
```

```text
{"error":{"code":"tool_is_error","message":"Tool 'run_query' returned isError:true."}}
{
  "error": "write_not_permitted",
  "message": "cannot execute SELECT in a read-only transaction (25006)",
  "recovery": "Narrow the SELECT or correct the statement using catalog metadata."
}
```

That one passes the check and reaches PostgreSQL, which refuses it because the statement runs in a
read-only transaction. The row is still there.

:::details[Why the role matters when the transaction already refuses writes]

The read-only transaction is enforced by PostgreSQL for every role, superusers included, and it ends
in a rollback. It stops changes to data, and nothing a statement sets lasts beyond it. It does not
stop everything a statement can do. A function the database defines can reach outside the
transaction, for example through `dblink` or a connection it opens itself, and a role may cancel or
end other sessions of the same role without `pg_signal_backend`. The statement check refuses the
built-in functions that do these things, but it cannot see what a view or a function you wrote calls.

A role that can only read narrows what a call the check missed can reach, and a role of its own
narrows it to this server's own sessions. That is why the server also refuses to answer for a
superuser or a role that can read server files, and why `describe_connection` reports
`statementGuard: "advisory"` instead of claiming the check is a guarantee.

:::
