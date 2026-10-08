# Read exact numbers, dates and IDs

A JSON number holds about 15 significant digits, and a JSON date has no time zone. SQL Server holds
more of both. Recognise a value that did not arrive intact, and fetch the exact one instead.

Uses the `sql` helper from the [Quickstart](/docs/mssql-mcp/quickstart#see-what-the-agent-receives)
on the `ledger` table of the `sezzlee_shop` sample schema.

## See which values are approximate

```sh
sql run_query --tool-arg sql="SELECT entry_id, booked_at, amount FROM sezzlee_shop.ledger ORDER BY entry_id" \
  | jq -c '.columns[] | del(.nullable)'
```

```json
{"name":"entry_id","kind":"bigint","nativeType":"BigInt"}
{"name":"booked_at","kind":"timestamptz","nativeType":"DateTimeOffset","lossy":"timezone"}
{"name":"amount","kind":"decimal","nativeType":"Decimal","precision":38,"scale":4,"lossy":"precision"}
```

And the rows those columns describe:

```sh
sql run_query --tool-arg sql="SELECT entry_id, booked_at, amount FROM sezzlee_shop.ledger ORDER BY entry_id" \
  | jq -c '.rows[]'
```

```json
["9007199254740993","2026-01-31T20:30:00.000Z",123456789012345680]
["9007199254740994","2026-01-31T21:10:00.000Z",12.5]
```

Three different things happened:

- **`entry_id` is a `bigint`**, and it arrives as a string. `9007199254740993` is past the largest
  integer a JSON number holds exactly. Every `bigint` is a string, large or not, so its type never
  depends on its value.
- **`amount` is flagged `lossy: "precision"`**. It is a `decimal(38,4)`, and the driver hands such a
  value over as a binary64 number, already rounded: `123456789012345678.1234` arrived as
  `123456789012345680`. Any `decimal` or `numeric` with more than 15 digits of precision carries the
  flag, whether or not a given value was affected.
- **`booked_at` is flagged `lossy: "timezone"`**. It is a `datetimeoffset` stored as 23:30 at +03:00.
  It arrives as the same instant in UTC, 20:30, and the offset is gone.

## Fetch the exact text

Ask SQL Server to turn the value into text. Text reaches the agent unchanged:

```sh
sql run_query --tool-arg sql="SELECT CAST(entry_id AS varchar(20)) AS entry_id, CONVERT(varchar(33), booked_at, 126) AS booked_at, CAST(amount AS varchar(50)) AS amount FROM sezzlee_shop.ledger ORDER BY entry_id" \
  | jq -c '.rows[]'
```

```json
["9007199254740993","2026-01-31T23:30:00+03:00","123456789012345678.1234"]
["9007199254740994","2026-02-01T00:10:00+03:00","12.5000"]
```

The amount keeps all its digits, and style 126 writes the timestamp with its offset. Do arithmetic on
these in SQL, where the value is exact, rather than on the JSON numbers.

## Check a table before querying it

`describe_table` reports the same `lossy` flag for each column, so an agent can see which columns
need a cast before it queries:

```sh
sql describe_table --tool-arg schema=sezzlee_shop table=ledger \
  | jq -c '.columns[] | select(.lossy) | del(.nullable)'
```

```json
{"name":"booked_at","kind":"timestamptz","nativeType":"datetimeoffset","lossy":"timezone"}
{"name":"amount","kind":"decimal","nativeType":"decimal","precision":38,"scale":4,"lossy":"precision"}
```

Other types come back as follows. `date` is `"YYYY-MM-DD"`, and `datetime2` and `datetime` are ISO
8601 timestamps without a zone. `bit` is `true` or `false`. `uniqueidentifier` is a string. Binary
columns are base64. `sql_variant`, whose type changes from row to row, is `kind: "unknown"`.

:::details[Why a value is flagged instead of repaired]

The loss happens before the server sees the value. The `mssql` driver converts each value first: on
the pinned version a wide `decimal` arrives as a binary64 number with its low digits already gone,
and a `datetimeoffset` arrives as a `Date` with the offset dropped. Once the digits are gone nothing
downstream can know what they were. Rendering the damaged number as a string would make a visible
imprecision invisible, so the value passes on as delivered and the column says what happened:
`precision` for a `decimal` or `numeric` above 15 digits, `timezone` for a `datetimeoffset`, and
`representation` for a type the driver turns into a different shape.

The flag belongs to the column, not to each value, because the server cannot tell a rounded value
from one that happened to fit. `bigint` is always a string because the driver delivers it intact,
and a type that depended on a value's size would leave the agent guessing what the column holds.

:::
