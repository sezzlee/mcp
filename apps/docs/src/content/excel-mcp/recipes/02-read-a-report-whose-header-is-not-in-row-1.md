# Read a report whose header is not in row 1

Exported reports often start with a title and a blank row. The server finds the header row below
them on its own and says how it chose; name the row yourself when the choice is wrong.

Uses the `excel` helper from the [Quickstart](/docs/excel-mcp/quickstart#see-what-the-agent-receives).
Save [report.xlsx](/samples/excel-mcp/report.xlsx) next to `sales.xlsx`: row 1 is a merged title,
row 2 is blank and row 3 holds the headers.

## See which row the server chose

```sh
excel read_sheet --tool-arg filePath=report.xlsx maxCells=16 \
  | jq -c '.headerRow, .headerRowSource, [.columns[].header], .rowNumbers'
```

```json
3
"scanned"
["Order","Date","Region","Rep","Product","Units","Unit price","Total"]
[4,5]
```

`headerRowSource: "scanned"` says no Excel Table or autofilter declared the header, so the server
took the first of the top rows whose cells are all text. `rowNumbers` gives the sheet row of each
returned row. `describe_workbook` reports the same row for every sheet before anything is read:

```sh
excel describe_workbook --tool-arg filePath=report.xlsx | jq -c '.sheets[].header'
```

```json
{"row":3,"source":"scanned","columns":[{"letter":"A","text":"Order"},{"letter":"B","text":"Date"},{"letter":"C","text":"Region"},{"letter":"D","text":"Rep"},{"letter":"E","text":"Product"},{"letter":"F","text":"Units"},{"letter":"G","text":"Unit price"},{"letter":"H","text":"Total"}],"moreColumns":0}
```

Columns are named by that row on every tool, so `aggregate_sheet` needs nothing more:

```sh
excel aggregate_sheet --tool-arg filePath=report.xlsx \
  'groupBy=["Region"]' 'metrics=[{"fn":"sum","column":"Total"}]' \
  | jq -c '.rows[]'
```

```json
["East",1290]
["North",1660]
["South",1810]
["West",1865]
```

## Name the row

When the chosen row is wrong, pass it:

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

`headerRow: 0` reads with no headers; columns are then named by letter.

## Ask for proof

`headerScan: true` runs the same detection strictly: it answers only when one row is possible.

```sh
excel read_sheet --tool-arg filePath=sales.xlsx headerScan=true range=A1:H2 \
  | jq -c '.headerRow, .headerRowSource'
```

```json
1
"declared"
```

No qualifying row fails with `unknown_header_row`, two or more with `ambiguous_header_row`, quoting
the candidates. `headerScan` cannot be combined with `headerRow` and is not available on CSV files.

:::details[How the server picks the row]

A declared Excel Table or autofilter wins. Otherwise the row is the first of the top 20 rows of the
used range whose filled cells are all text, at least two of them and none merged across columns,
with no row of numbers or dates above it, so a merged title and a blank row are skipped and a
placeholder row inside the data is not taken for a header. If no row qualifies, row 1 is used and
`headerRowSource` says `default`. The scan always covers the whole used range, so a call that reads
three rows or a single column gets the same header row as one that reads the whole sheet. A CSV
always reads row 1. Every answer carries `headerRowSource` — `default`, `explicit`, `declared`,
`scanned` or `cursor` — so a choice the caller did not make is never hidden.

:::

:::details[Headers that span merged cells]

Under the default `mergedCells: "master"` a merged header names only its first column. With
`mergedCells: "repeat"` every column the merge covers gets the same header, so a vertically merged
header becomes addressable by name and a horizontal group label names several columns; address those
by letter.

:::
