# Create a read-only login for the server

The login the server connects with decides what it can do. Give it a login that can read and
nothing else, and no statement the agent writes can change your data.

Not run by us: these statements need permissions our test login does not hold. They follow the SQL
Server documentation for `CREATE LOGIN`, `CREATE USER` and the `db_datareader` role.

## Create the login and the user

Connected as an administrator, create a login on the server and a user for it in the database the
server will read:

```text
CREATE LOGIN mcp_reader WITH PASSWORD = 'a long random password', CHECK_POLICY = ON;
GO
USE Sales;
GO
CREATE USER mcp_reader FOR LOGIN mcp_reader;
ALTER ROLE db_datareader ADD MEMBER mcp_reader;
GO
```

`db_datareader` can `SELECT` from every table and view in that database and nothing more: no
`INSERT`, `UPDATE`, `DELETE`, no schema changes, and no stored procedures. It grants nothing in any
other database.

## Narrow it further

To expose only some tables, leave the role out and grant `SELECT` on a schema or on single objects:

```text
GRANT SELECT ON SCHEMA::reporting TO mcp_reader;
DENY SELECT ON dbo.payroll TO mcp_reader;
```

`search_catalog` lists only what the login can see, so an object it may not read does not appear in
the agent's results at all. A query against it fails with `object_not_found` or `permission_denied`.

## Check what the login can do

Connected as `mcp_reader`, this lists the database roles it belongs to:

```text
SELECT r.name FROM sys.database_role_members AS m
JOIN sys.database_principals AS r ON r.principal_id = m.role_principal_id
WHERE m.member_principal_id = USER_ID();
```

The only row should be `db_datareader`. If `db_owner` or `db_datawriter` appears, a statement that
slips past the server's check will really write.

## See what the server refuses

Uses the `sql` helper from the [Quickstart](/docs/mssql-mcp/quickstart#see-what-the-agent-receives)
on the `sezzlee_shop` sample schema.

```sh
sql run_query --tool-arg sql="DELETE FROM sezzlee_shop.orders WHERE order_id = 1005"
```

```text
{"error":{"code":"tool_is_error","message":"Tool 'run_query' returned isError:true."}}
{
  "error": "write_not_permitted",
  "message": "A read-only statement has to begin with SELECT or WITH; this one begins with delete.",
  "recovery": "Rewrite the request as a SELECT."
}
```

The first line comes from the Inspector; the object under it is the server's answer. The statement
never reached the database. A login limited to `db_datareader` would refuse it there too, which is
the refusal that counts.

:::details[Why the statement check is not the security boundary]

The check masks comments and string literals, then looks at the first word and for write keywords.
That catches honest mistakes. It cannot prove a statement harmless against one written to get past
it: T-SQL offers functions with side effects, `EXEC` built from a string, and features added after
the check was written. SQL Server has no read-only session to fall back on, since
`ApplicationIntent=ReadOnly` only routes to a readable secondary replica. So `describe_connection`
reports `sessionIntent: "none"` and `statementGuard: "advisory"`.

The login's permissions are the guarantee, because SQL Server refuses a write whatever the statement
looks like. The check stays for the agent's sake: `write_not_permitted` says to rewrite the request
as a `SELECT`, where SQL Server's permission error reads as a problem to route around.

:::
