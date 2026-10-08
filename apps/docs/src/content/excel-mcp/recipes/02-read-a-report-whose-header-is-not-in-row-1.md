# Read a report whose header is not in row 1

Exported reports often start with a title and a blank row. The server assumes the header is row 1
until told otherwise, and says so when that looks wrong. Name the row, or let the server prove it.

Uses the `excel` helper from the [Quickstart](/docs/excel-mcp/quickstart#see-what-the-agent-receives).
Save [report.xlsx](/samples/excel-mcp/report.xlsx) next to `sales.xlsx`: row 1 is a merged title,
row 2 is blank and row 3 holds the headers.

## Spot it

```sh
excel read_sheet --tool-arg filePath=report.xlsx maxCells=16 \
  | jq '{headerRow, headerRowSource, headers: [.columns[].header], warnings}'
```

```json
{
  "headerRow": 1,
  "headerRowSource": "default",
  "headers": [
    "January sales report",
    null,
    null,
    null,
    null,
    null,
    null,
    null
  ],
  "warnings": [
    "headerRow 1 produced no usable header text across columns A..H. Row 3 is the only row in rows 1-15 that qualifies as a header row by text; pass headerRow 3, or headerScan true."
  ]
}
```

`headerRowSource: "default"` with a warning means row 1 was assumed, not established. The warning
names the row that looks right, and appears only when no `range` was passed.

## Name the row

```sh
excel read_sheet --tool-arg filePath=report.xlsx headerRow=3 maxCells=16 \
  | jq -c '.headerRowSource, [.columns[].header], .values[]'
```

```json
"explicit"
["Order","Date","Region","Rep","Product","Units","Unit price","Total"]
[1001,"2026-01-05","North","Ada","Desk",4,250,1000]
[1002,"2026-01-06","South","Emre","Chair",10,85,850]
```

`headerRow` works the same on `aggregate_sheet`:

```sh
excel aggregate_sheet --tool-arg filePath=report.xlsx headerRow=3 \
  'groupBy=["Region"]' 'metrics=[{"fn":"sum","column":"Total"}]' \
  | jq -c '.rows[]'
```

```json
["East",1290]
["North",1660]
["South",1810]
["West",1865]
```

`headerRow: 0` reads with no headers; columns are then named by letter.

## Let the server prove it

```sh
excel read_sheet --tool-arg filePath=report.xlsx headerScan=true maxCells=16 \
  | jq -c '.headerRow, .headerRowSource, [.columns[].header]'
```

```json
3
"scanned"
["Order","Date","Region","Rep","Product","Units","Unit price","Total"]
```

The scan first looks for an Excel Table or autofilter that declares the header, as `sales.xlsx`
does:

```sh
excel read_sheet --tool-arg filePath=sales.xlsx headerScan=true range=A1:H2 \
  | jq -c '.headerRow, .headerRowSource'
```

```json
1
"declared"
```

Without a declaration it needs exactly one row of text headers in the first 20 rows. None fails with
`unknown_header_row`, two or more with `ambiguous_header_row`, quoting the candidates. `headerScan`
cannot be combined with `headerRow` and is not available on CSV files.

:::details[Why the server never guesses]

Every useful answer depends on the header row: `aggregate_sheet` finds `Total` by it, and `where`
names columns by it. A guess that lands on a title band produces data that looks fine and is wrong,
and nothing in the answer says a choice was made. Row 1 by default is wrong on the same sheets, but
predictably, and `headerRowSource` on every answer says who chose the row: `default`, `explicit`,
`declared`, `scanned` or `cursor`. `headerScan` answers only when the file declares the row or only
one row is possible.

:::

:::details[Headers that span merged cells]

Under the default `mergedCells: "master"` a merged header names only its first column. With
`mergedCells: "repeat"` every column the merge covers gets the same header, so a vertically merged
header becomes addressable by name and a horizontal group label names several columns; address those
by letter.

:::
