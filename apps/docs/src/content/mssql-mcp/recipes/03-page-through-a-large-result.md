# Page through a large result

`run_query` returns at most 100 rows unless you ask for more, and 1,000 at most. It has no cursor: a
statement is run once and its result is not kept, so you read a longer result in pages you control.

Uses the `sql` helper from the [Quickstart](/docs/mssql-mcp/quickstart#see-what-the-agent-receives)
on the `sezzlee_shop` sample schema.

## See where a result was cut

`maxRows` caps the rows in one answer. When the statement produced more, the answer says so:

```sh
sql run_query --tool-arg sql="SELECT order_id, status FROM sezzlee_shop.orders" maxRows=3 \
  | jq -c '{rows, truncated, truncationReason, hint}'
```

```json
{"rows":[[1001,"shipped"],[1002,"shipped"],[1003,"pending"]],"truncated":true,"truncationReason":"maxRows","hint":"Add an ORDER BY with OFFSET ... ROWS FETCH NEXT ... ROWS ONLY and read the next page yourself."}
```

`truncated` is `true`, `truncationReason` is `maxRows`, and `hint` names the paging clause SQL Server
uses. Once it has the rows it needs, the server cancels the rest of the statement.

## Read the next page

Order the rows by something unique, and skip the rows already read with `OFFSET` and `FETCH`:

```sh
sql run_query --tool-arg sql="SELECT order_id, status FROM sezzlee_shop.orders ORDER BY order_id OFFSET 3 ROWS FETCH NEXT 3 ROWS ONLY" \
  | jq -c '{rows, truncated}'
```

```json
{"rows":[[1004,"shipped"],[1005,"cancelled"],[1006,"shipped"]],"truncated":false}
```

Raise `OFFSET` by the page size for each page. When a page returns fewer rows than it asked for,
there are no more. Without an `ORDER BY` on a unique key, SQL Server may return rows in a different
order each time, and pages can skip or repeat rows.

## Let the database count

A question about totals is cheaper answered by the database than by reading every row:

```sh
sql run_query --tool-arg sql="SELECT status, COUNT(*) AS orders FROM sezzlee_shop.orders GROUP BY status ORDER BY status" \
  | jq -c '.rows[]'
```

```json
["cancelled",1]
["pending",2]
["shipped",4]
```

:::details[If the rows are wide]

An answer is also capped at 512 KiB. When the rows fit the row cap but not the size, the answer
stops at the last row that fits, with `truncationReason: "maxPayloadBytes"`. A text value longer than
4,096 characters and a binary value longer than 4,096 bytes are cut in the cell itself. Select only
the columns you need, or `LEFT(column, n)` of the long ones.

:::
