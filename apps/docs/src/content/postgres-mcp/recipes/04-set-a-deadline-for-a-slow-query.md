# Set a deadline for a slow query

Every statement runs under a deadline, 30 seconds unless you change it. When it passes, the server
closes the connection and PostgreSQL stops the statement, not only the wait for its answer. Shorten
or lengthen the deadline for one call or for the whole server.

Uses the `sql` helper from the [Quickstart](/docs/postgres-mcp/quickstart#see-what-the-agent-receives).

## For one call

`timeoutMs` sets the deadline of one `run_query` call, from 100 milliseconds to ten minutes. This
statement sleeps for ten seconds, so it cannot finish in one:

```sh
sql run_query --tool-arg sql="SELECT pg_sleep(10)" timeoutMs=1000
```

```text

```

The first line comes from the Inspector; the object under it is the server's answer. The statement
was stopped after one second and stopped using the database.

## For every call

`SEZZLEE_POSTGRES_QUERY_TIMEOUT_MS` sets the deadline for any call that does not pass `timeoutMs`,
from 1 millisecond to five minutes. Add it to the server's environment, for example to allow two
minutes:

```json
{
  "env": {
    "SEZZLEE_POSTGRES_QUERY_TIMEOUT_MS": "120000"
  }
}
```

`describe_connection` reports the deadline in force as `limits.queryTimeoutMs`, so an agent can read
it before it writes an expensive query. The same value is the transaction's `statement_timeout` and
`lock_timeout`: a read that waits on a lock held by a writer gives up at the deadline instead of
waiting until the writer is done.

A short deadline is a good default for an agent. Most of its questions are answered by a filter and a
`GROUP BY`, and a query that needs minutes usually reads a whole table it could have filtered first.

:::details[Why a deadline closes the connection instead of giving up]

Racing the query against a timer returns an error on time, but PostgreSQL keeps running the
statement, holding its locks and the connection, and the next call handed that connection waits
behind it. So the deadline is the server's own timer, and when it fires the server closes the
connection to PostgreSQL rather than abandon it. The same deadline is also set inside the
transaction as `statement_timeout`, so PostgreSQL stops the statement on its own clock too.

A connection that was closed this way is never reused: the next call opens a new one. So is a
connection whose transaction failed anywhere, because it may still hold the aborted transaction. Up
to four connections serve one call each at a time; up to 32 more calls wait, and beyond that a call
fails with `resource_limit`. A statement stopped at its deadline fails with `query_timeout`; a call
the client cancels fails with `query_cancelled`. Opening a connection is bounded by
`SEZZLEE_POSTGRES_CONNECT_TIMEOUT_MS`, 30 seconds by default, and fails with `connection_failed`.

:::
