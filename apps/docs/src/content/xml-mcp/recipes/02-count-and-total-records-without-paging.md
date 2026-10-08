# Count and total records without paging

`aggregate_document` answers "how many", "how many distinct" and "how much" over a repeated element
in one call, with groups, so the agent never pages every record into its context.

Uses the `xml` helper from the [Quickstart](/docs/xml-mcp/quickstart#see-what-the-agent-receives) on
`orders.xml`. The record set and the columns are declared as in [Turn repeated elements into
rows](/docs/xml-mcp/turn-repeated-elements-into-rows).

```sh
ORDERS='{"ancestors":[{"namespaceUri":"urn:example:orders","localName":"orders"}],"name":{"namespaceUri":"urn:example:orders","localName":"order"}}'
```

## Count

The counting metrics work on text and need no conversion. `count` counts records and takes no
column; `countValues` counts the records where the column matched; `countDistinct` counts the
column's distinct values:

```sh
xml aggregate_document --tool-arg filePath=orders.xml "itemAddress=$ORDERS" \
  'columns=[{"label":"region","name":{"namespaceUri":"urn:example:orders","localName":"region"}},{"label":"customer","name":{"namespaceUri":"urn:example:orders","localName":"customer"}}]' \
  'metrics=[{"fn":"count"},{"fn":"countValues","column":"region"},{"fn":"countDistinct","column":"customer"}]' \
  | jq -c '.groups[].metrics'
```

```json
[{"kind":"count","value":6},{"kind":"count","value":5},{"kind":"count","value":4}]
```

Six orders, five with a region, four distinct customers. Without `groupBy` the whole record set is
one group.

## Group

`groupBy` names columns by label. The key of each group is the cell, status included, so records
with a missing value form their own group instead of disappearing:

```sh
xml aggregate_document --tool-arg filePath=orders.xml "itemAddress=$ORDERS" \
  'columns=[{"label":"region","name":{"namespaceUri":"urn:example:orders","localName":"region"}}]' \
  'groupBy=["region"]' 'metrics=[{"fn":"count"}]' \
  | jq -c '.groups[] | [.key[0].value // .key[0].status, .metrics[0].value]'
```

```json
["East",1]
["North",2]
["South",1]
["West",1]
["missing",1]
```

`orderBy: "metric"` with `orderByMetric` and `descending` ranks the groups, and `maxGroups` caps
them, 50 by default and 200 at most. `groupCount` and `matchedItems` always cover the whole scan.

## Total

`sum`, `avg`, `min` and `max` turn text into numbers, and only when the call says so with
`numericMode: "binary64"`. Without it the call is refused:

```sh
xml aggregate_document --tool-arg filePath=orders.xml "itemAddress=$ORDERS" \
  'columns=[{"label":"paid","name":{"namespaceUri":"urn:example:payments","localName":"payment"}}]' \
  'metrics=[{"fn":"sum","column":"paid"}]'
```

```text
{"error":{"code":"tool_is_error","message":"Tool 'aggregate_document' returned isError:true."}}
{
  "error": "invalid_argument",
  "message": "The sum metric converts text to a binary64 number, which this call did not ask for.",
  "recovery": "Pass numericMode: binary64 to accept double precision, or use count, countValues or countDistinct."
}
```

The first line comes from the Inspector; the object under it is the server's answer. With the mode
set:

```sh
xml aggregate_document --tool-arg filePath=orders.xml "itemAddress=$ORDERS" \
  'columns=[{"label":"paid","name":{"namespaceUri":"urn:example:payments","localName":"payment"}}]' \
  'metrics=[{"fn":"sum","column":"paid"},{"fn":"avg","column":"paid"},{"fn":"max","column":"paid"}]' \
  numericMode=binary64 \
  | jq -c '.groups[].metrics[] | {value, counted, skipped, rounded}'
```

```json
{"value":3180,"counted":5,"skipped":1,"rounded":0}
{"value":636,"counted":5,"skipped":1,"rounded":0}
{"value":1000,"counted":5,"skipped":1,"rounded":0}
```

Every numeric metric reports what it used: `counted` values, `skipped` cells that were missing or not
a number, and `rounded` values that a double cannot hold exactly. A `sum` over no values is `0` with
`counted: 0`; an `avg` over no values has no value.

A value with more digits than a double holds is refused, not rounded:

```sh
printf '<ledger><entry amount="12345678901234567890.5"/><entry amount="0.1"/></ledger>\n' \
  > ~/sezzlee-xml/ledger.xml
xml aggregate_document --tool-arg filePath=ledger.xml \
  'itemAddress={"ancestors":[{"namespaceUri":"","localName":"ledger"}],"name":{"namespaceUri":"","localName":"entry"}}' \
  'columns=[{"label":"amount","value":{"from":"attribute","namespaceUri":"","localName":"amount"}}]' \
  'metrics=[{"fn":"sum","column":"amount"}]' numericMode=binary64
```

```text
{"error":{"code":"tool_is_error","message":"Tool 'aggregate_document' returned isError:true."}}
{
  "error": "numeric_precision",
  "message": "The value 12345678901234567890.5 carries more digits than a binary64 number holds, so a numeric metric would change it.",
  "recovery": "Use count, countValues or countDistinct, or project the rows and total them outside this server."
}
```

For money or identifiers where every digit counts, use the counting metrics, or read the values with
`project_records` and total them with exact arithmetic outside the server.

:::details[Why values come back as written]

Everything in XML is text, and every conversion loses something. `010` as a number is `10`, and the
leading zero of a code is gone. `1000.00` becomes `1000`. `12345678901234567890` becomes
`12345678901234567000`, which is a different identifier. None of these changes announce themselves.

So the server converts nothing by default: no trimming, no number or date conversion. Arithmetic is
an explicit acceptance through `numericMode`, and even then a value too precise for a double is
refused, an approximate one is counted in `rounded`, and a non-number is skipped and counted, never
read as zero. Comparisons in `where` stay textual in every mode, so `"010"` never equals `"10"`.

:::
