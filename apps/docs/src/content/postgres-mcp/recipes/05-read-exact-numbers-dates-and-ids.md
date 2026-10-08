# Read exact numbers, dates and IDs

A JSON number holds about 15 significant digits, and a JSON date has no time zone. PostgreSQL holds
more of both. See how each type reaches the agent, so you know which values are text and which are
numbers.

Uses the `sql` helper from the [Quickstart](/docs/postgres-mcp/quickstart#see-what-the-agent-receives)
on the `ledger` table of the `sezzlee_shop` sample schema.

## See how each type arrives

```sh
sql run_query --tool-arg sql="SELECT entry_id, booked_at, amount FROM sezzlee_shop.ledger ORDER BY entry_id" \
  | jq -c '.columns[] | del(.nullable)'
```

```json

```

And the rows those columns describe:

```sh
sql run_query --tool-arg sql="SELECT entry_id, booked_at, amount FROM sezzlee_shop.ledger ORDER BY entry_id" \
  | jq -c '.rows[]'
```

```json

```

Three types, three behaviors:

- **`entry_id` is a `bigint`**, and it arrives as a string. `9007199254740993` is past the largest
  integer a JSON number holds exactly. Every `bigint` is a string, large or not, so its type never
  depends on its value. That includes the result of `COUNT` and of `SUM` over integers.
- **`amount` is a `numeric(38,4)`**, and it arrives as the string `123456789012345678.1234` with every
  digit and its scale. Every `numeric` is a string, whatever its precision.
- **`booked_at` is a `timestamptz`**, and it arrives as the text PostgreSQL wrote, with its UTC
  offset, in the time zone the session uses. PostgreSQL stores a `timestamptz` as an instant and
  does not keep the offset the value was written with, so the sample's `+03` is not recoverable;
  ask for the zone you want, as below.

No column is flagged as lossy: none of these values is rounded on the way, so there is nothing to
flag. The type is in `kind` and the engine's name for it in `nativeType`; `precision` and `scale`
appear on `numeric` columns that declare them.

## Ask for the zone and the format you need

`AT TIME ZONE` converts a `timestamptz` to the wall-clock time in a named zone:

```sh
sql run_query --tool-arg sql="SELECT entry_id, booked_at AT TIME ZONE 'Europe/Istanbul' AS booked_local FROM sezzlee_shop.ledger ORDER BY entry_id" \
  | jq -c '.rows[]'
```

```json

```

Do arithmetic on these in SQL, where the value is exact, rather than on the strings in the answer: a
`SUM(amount)` stays a `numeric`, and a script that parses `amount` into a JSON number rounds it. For a
count or a small integer you do want as a number, cast it: `COUNT(*)::int`.

## Check a table before querying it

`describe_table` reports the same `kind` and `nativeType` for each column, so an agent can see which
columns arrive as strings before it queries:

```sh
sql describe_table --tool-arg schema=sezzlee_shop table=ledger \
  | jq -c '.columns[] | del(.nullable)'
```

```json

```

Other types come back as follows. `smallint` and `integer` are numbers, and so are `real` and
`double precision`. `boolean` is `true` or `false`. `date`, `time`,
`timetz` and `timestamp` are text in the form the session's `DateStyle` gives. `json` and `jsonb` are
text holding the document, not a parsed value. `uuid` is a string. `bytea` is base64. A type with no
JSON form, such as an array, an `interval` or a range, has `kind: "unknown"` and its values are
returned as text.

:::details[Why the server passes PostgreSQL's text on]

By default the `pg` driver turns values into JavaScript ones: a `date` or `timestamp` becomes a
`Date`, a `json` or `jsonb` becomes parsed output, and an integer or a number past 2^53 can be
rounded. A `Date` has milliseconds and no zone, and a number inside a JSON document is rounded the
same way. Once the digits are gone nothing downstream can tell what they were.

So the server replaces the driver's parser for `int8`, `numeric`, `date`, `time`, `timetz`,
`timestamp`, `timestamptz`, `json` and `jsonb` with one that hands over PostgreSQL's own text
unchanged. That is why there is no `lossy` flag for PostgreSQL: the value on the wire is the value
the agent gets, and a type the server does not recognize says `kind: "unknown"` instead of guessing.

:::
