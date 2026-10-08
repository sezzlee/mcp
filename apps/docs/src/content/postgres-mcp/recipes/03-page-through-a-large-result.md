# Page through a large result

`run_query` returns at most 100 rows unless you ask for more, and 1,000 at most. It has no cursor: a
statement is run once and its result is not kept, so you read a longer result in pages you control.

Uses the `sql` helper from the [Quickstart](/docs/postgres-mcp/quickstart#see-what-the-agent-receives)
on the `sezzlee_shop` sample schema.

## See where a result was cut

`maxRows` caps the rows in one answer. When the statement produced more, the answer says so:

```sh
sql run_query --tool-arg sql="SELECT order_id, status FROM sezzlee_shop.orders" maxRows=3 \
  | jq -c '{rows, truncated, truncationReason, hint}'
```

```json
{"rows":[[1001,"shipped"],[1002,"shipped"],[1003,"pending"]],"truncated":true,"truncationReason":"maxRows","hint":"Add ORDER BY and LIMIT with an explicit page boundary to read another page."}
```

`truncated` is `true`, `truncationReason` is `maxRows`, and `hint` names the clauses to add: an
`ORDER BY` and a `LIMIT`. The server reads the result through a cursor, one row past `maxRows` to
learn that more exists, then closes the cursor and ends the transaction, so the rest of the result is
never fetched.

## Read the next page

Order the rows by something unique, and skip the rows already read with `LIMIT` and `OFFSET`:

```sh
sql run_query --tool-arg sql="SELECT order_id, status FROM sezzlee_shop.orders ORDER BY order_id LIMIT 3 OFFSET 3" \
  | jq -c '{rows, truncated}'
```

```json
{"rows":[[1004,"shipped"],[1005,"cancelled"],[1006,"shipped"]],"truncated":false}
```

Raise `OFFSET` by the page size for each page. When a page returns fewer rows than it asked for,
there are no more. Without an `ORDER BY` on a unique key, PostgreSQL may return rows in a different
order each time, and pages can skip or repeat rows.

## Let the database count

A question about totals is cheaper answered by the database than by reading every row:

```sh
sql run_query --tool-arg sql="SELECT status, COUNT(*)::int AS orders FROM sezzlee_shop.orders GROUP BY status ORDER BY status" \
  | jq -c '.rows[]'
```

```json
["cancelled",1]
["pending",2]
["shipped",4]
```

`COUNT(*)` is a `bigint`, which arrives as a string; the cast to `int` makes it a number.
[Read exact numbers, dates and ids](/docs/postgres-mcp/read-exact-numbers-dates-and-ids) explains
which types arrive as strings.

:::details[If the rows are wide]

An answer is also capped at 512 KiB. When the rows fit the row cap but not the size, the answer
stops at the last row that fits, with `truncationReason: "maxPayloadBytes"`. A text value longer than
4,096 characters and a binary value longer than 4,096 bytes are cut in the cell itself. Select only
the columns you need, or `left(column, n)` of the long ones.

:::
