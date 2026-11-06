# Compute over a retained result

Filter, sort or calculate over every finalized aggregate row with JavaScript. The full result
stays in the server; the agent receives only the value the program returns.

For `smoke.csv` containing `name,value` and rows `a,1` and `b,2`, first retain the aggregate:

```json
{
  "name": "aggregate_sheet",
  "arguments": {
    "filePath": "smoke.csv",
    "groupBy": ["name"],
    "metrics": [{ "fn": "sum", "column": "value" }],
    "resultMode": "retained",
    "maxGroups": 1
  }
}
```

Use the issued `resultId` in the next call:

```json
{
  "name": "execute_result",
  "arguments": {
    "resultId": "<the issued resultId>",
    "code": "return data.rows.reduce((n,r) => n + r[1], 0);"
  }
}
```

The returned `value` is `3`. Both calls run in the clean-install CLI smoke test: the preview
shows one group, while the program sees both. No extra server, client hook or agent prompt is
needed. Tool descriptions explain the arguments and effective execution budgets.

`data` contains aggregate metadata, `columns`, one-based `dateColumns`, exact `rows` and `rowSourceCounts`. Its scope
is the retained aggregate, not the unaggregated worksheet. Later source edits do not change it.
Use `return`, not logging; filesystem, network, imports and other tool calls are unavailable.

:::details[Read a large computed answer]
An answer above the response budget is kept under a new `resultId`. Call `read_result` at
`/value`, selecting fields and paging with `offset` and `limit`. Strings can be paged without
the cell preview's presentation truncation. Another `execute_result` receives the computed
envelope, with its value at `data.value`.

Result-entry, byte and expiry budgets are shared by aggregates and computed JSON. A full store
preserves existing results and refuses the new admission. Executor limits have their own
reasons and recoveries; no failure publishes a partial calculation. The exact defaults and
enforcement are in the
[runtime guide](https://github.com/sezzlee/mcp/tree/main/packages/cores/compute-core#budgets-and-recovery).
:::

:::details[Keep source meaning]
Numbers use binary64. Preserve decimal text and identifiers when every digit matters. Metric
values already carry the aggregate's requested rounding; `rowSourceCounts` says how many
source rows each result row represents. Computing on these rows does not restore the
unaggregated source or missing upstream data.
:::
