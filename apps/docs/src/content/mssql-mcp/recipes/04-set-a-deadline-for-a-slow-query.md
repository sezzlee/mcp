# Set a deadline for a slow query

Every statement runs under a deadline, 30 seconds unless you change it. When it passes, the server
cancels the statement on SQL Server, not only the wait for its answer. Shorten or lengthen the
deadline for one call or for the whole server.

Uses the `sql` helper from the [Quickstart](/docs/mssql-mcp/quickstart#see-what-the-agent-receives).

## For one call

`timeoutMs` sets the deadline of one `run_query` call, from 100 milliseconds to ten minutes. This
statement counts billions of rows, so it cannot finish in one second:

```sh
sql run_query --tool-arg sql="SELECT COUNT_BIG(*) AS n FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b CROSS JOIN sys.all_objects AS c" timeoutMs=1000
```

```text
{"error":{"code":"tool_is_error","message":"Tool 'run_query' returned isError:true."}}
{
  "error": "query_timeout",
  "message": "The query exceeded its 1000 ms deadline. (ETIMEOUT)",
  "recovery": "Narrow the query with a filter or a paging clause, or pass a larger timeoutMs."
}
```

The first line comes from the Inspector; the object under it is the server's answer. The statement
was cancelled on the server after one second and stopped using the database.

## For every call

`SEZZLEE_MSSQL_QUERY_TIMEOUT_MS` sets the deadline for any call that does not pass `timeoutMs`. Add
it to the server's environment, for example to allow two minutes:

```json
{
  "env": {
    "SEZZLEE_MSSQL_QUERY_TIMEOUT_MS": "120000"
  }
}
```

`describe_connection` reports the deadline in force as `limits.queryTimeoutMs`, so an agent can read
it before it writes an expensive query. The same value is the session's `LOCK_TIMEOUT`: a read that
waits on a lock held by a writer gives up at the deadline instead of waiting until the writer is
done.

A short deadline is a good default for an agent. Most of its questions are answered by a filter and a
`GROUP BY`, and a query that needs minutes usually reads a whole table it could have filtered first.

:::details[Why a deadline cancels the statement instead of giving up]

Racing the query against a timer returns an error on time, but SQL Server keeps running the
statement, holding its locks and the connection, and the next call handed that connection reads the
end of someone else's result. The driver's own timeout does not help: on the pinned version, an
800 millisecond request timeout did not interrupt a ten-second `WAITFOR DELAY`. So the deadline is
the server's own timer, and when it fires the server sends SQL Server a cancel.

A cancelled connection returns to the pool only once SQL Server confirms. If that takes more than
five seconds, the connection is closed and a new one opened later, so a late answer never reaches
another call. Each of up to four connections serves one call at a time; up to 32 more calls wait,
and beyond that a call fails with `resource_limit`. A statement stopped at its deadline fails with
`query_timeout`; a call the client cancels fails with `query_cancelled`. Opening a connection is
bounded by `SEZZLEE_MSSQL_CONNECT_TIMEOUT_MS`, 15 seconds by default, and fails with
`connection_failed`.

:::
