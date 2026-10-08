# Answer a question without reading every row

A total, a ranking, a count or the place a value sits is answered on the server in one call, so the
agent never pages thousands of cells into its context.

Uses the `excel` helper from the [Quickstart](/docs/excel-mcp/quickstart#see-what-the-agent-receives)
on `sales.xlsx`.

## One total

Leave out `groupBy`:

```sh
excel aggregate_sheet --tool-arg filePath=sales.xlsx \
  'metrics=[{"fn":"sum","column":"Total"},{"fn":"count"}]' \
  | jq -c '[.columns[].label], .rows[]'
```

```json
["sum(Total)","count"]
[6625,12]
```

`count` counts rows. `countValues` counts a column's non-empty cells and `countDistinct` its
distinct values; `sum`, `avg` and `stddev` read numbers, and `min` and `max` also compare dates or
text.

## Group and filter

```sh
excel aggregate_sheet --tool-arg filePath=sales.xlsx \
  'groupBy=["Product"]' \
  'metrics=[{"fn":"sum","column":"Units"},{"fn":"avg","column":"Total"}]' \
  'where=[{"column":"Region","op":"in","values":["North","South"]}]' \
  | jq -c '[.columns[].label], .rows[], {matchedRows, scannedRows}'
```

```json
["Product","sum(Units)","avg(Total)"]
["Chair",16,680]
["Desk",7,875]
["Lamp",12,180]
{"matchedRows":6,"scannedRows":12}
```

`matchedRows` tells an empty group apart from a filter that matched nothing. A cell of a different
kind from the value never matches; pass `coerceText: true` to read numeric text as a number.

## The top groups

```sh
excel aggregate_sheet --tool-arg filePath=sales.xlsx \
  'groupBy=["Rep"]' 'metrics=[{"fn":"sum","column":"Total"}]' \
  orderBy=metric descending=true maxGroups=2 \
  | jq -c '.rows[], {groupCount, returnedGroups, truncated}'
```

```json
["Omar",1865]
["Emre",1810]
{"groupCount":4,"returnedGroups":2,"truncated":true}
```

## Where a value is

```sh
excel find_in_sheet --tool-arg filePath=sales.xlsx query=Desk matchMode=exact \
  | jq -c '.matches[] | {address, value}'
```

```json
{"address":"E2","value":"Desk"}
{"address":"E6","value":"Desk"}
{"address":"E7","value":"Desk"}
{"address":"E12","value":"Desk"}
```

`matchMode` is `contains` (the default, ignoring case and accents), `exact` or `regex`;
`searchIn: "formulas"` searches formula text instead of values.

## When you do need the rows

`read_sheet` returns at most `maxCells` cells per answer, 2,000 by default and never more than
10,000, cut at a whole row:

```sh
excel read_sheet --tool-arg filePath=sales.xlsx maxCells=40 \
  | jq '{range, returnedRows, truncated, truncationReason, hint}'
```

```json
{
  "range": "A2:H6",
  "returnedRows": 5,
  "truncated": true,
  "truncationReason": "maxCells",
  "hint": "7 rows remain. Prefer aggregate_sheet for totals, find_in_sheet to locate a value, or a narrower range over paging."
}
```

Send `nextCursor` back as `cursor` for the next page:

```sh
excel read_sheet --tool-arg filePath=sales.xlsx maxCells=40 > page1.json
excel read_sheet --tool-arg filePath=sales.xlsx \
  "cursor=$(jq -r .nextCursor page1.json)" \
  | jq '{range, headerRowSource, returnedRows, truncated}'
```

```json
{
  "range": "A7:H13",
  "headerRowSource": "cursor",
  "returnedRows": 7,
  "truncated": false
}
```

:::details[Rules for a cursor]

A later page inherits the first page's header row, `valueMode`, `mergedCells` and CSV options; only
`maxCells` may change, and a `sheetName` or `range` next to a cursor is refused. A cursor is bound to
the file's contents: if the workbook is saved between two pages, the next one fails with
`stale_cursor` instead of mixing two versions. An edited token fails with `invalid_cursor`.

:::
