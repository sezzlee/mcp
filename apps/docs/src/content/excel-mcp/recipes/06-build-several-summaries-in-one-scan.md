# Build several summaries in one scan

Return an overall total and independent country and month breakdowns with one `aggregate_sheet`
call. Conditional metrics let the same result compare all sales with completed sales.

Use the `excel` helper from the [quickstart](/docs/excel-mcp/quickstart), then create this small
CSV in the folder the server reads:

```sh
cat > ~/sezzlee-sheets/dashboard.csv <<'CSV'
Date,Country,Sales,Status
2023-01-15,Japan,10,Paid
2023-01-20,Brazil,20,Paid
2023-02-15,Japan,30,Pending
2024-01-15,Brazil,40,Paid
CSV
```

```sh
excel aggregate_sheet --tool-arg filePath=dashboard.csv compact=true \
  'metrics=[{"fn":"sum","column":"Sales"},{"fn":"sum","column":"Sales","where":[{"column":"Status","op":"eq","value":"Paid"}]}]' \
  'groupingSets=[{"groupBy":["Country"]},{"groupBy":[{"column":"Date","by":"month"}]}]' \
  | jq -c '.rows[], .groupingSets[].rows, {scannedRows, matchedRows}'
```

```text
[100,70]
[["Brazil",60,60],["Japan",40,10]]
[["2023-01",30,30],["2023-02",30,null],["2024-01",40,40]]
{"scannedRows":4,"matchedRows":4}
```

The primary row is the total. Each grouping set has its own rows and column descriptions, in
the order requested. Month keys include the year, so January 2023 and January 2024 stay separate.
The second metric filters only its own input; the other metric still includes pending sales.

:::details[Percentiles, pivots and limits]

Use `median`, `p50`, `p90` or `percentile` for exact inclusive percentiles. A percentile argument
is a fraction between zero and one. Use `pivotBy` to turn another grouping key into columns.
Calendar grouping also supports ISO weeks, quarters, days, weekdays and hours; numeric grouping
supports explicit boundaries or a fixed width. See the generated [tool reference](/docs/excel-mcp/tools).

All sets share the same scan and resource limits. A dense pivot is refused before its row-key ×
pivot-key × metric product exceeds the limit, and a percentile is refused when its exact sample
budget is exhausted. `compact` retains warnings and skipped-value counts; inspect them before
using the totals. See [limits](/docs/excel-mcp/limits).

:::
