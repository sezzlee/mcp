# Read formulas, tables and rules

Beyond its values, a workbook says what the data means: which cells are formulas, which range is a
table, which values a column accepts, which cells are highlighted and why.

Uses the `excel` helper from the [Quickstart](/docs/excel-mcp/quickstart#see-what-the-agent-receives)
on `sales.xlsx`, whose `Total` column is `=F2*G2` and so on, and `report.xlsx` from
[the header recipe](/docs/excel-mcp/read-a-report-whose-header-is-not-in-row-1).

## See what a sheet holds

`describe_workbook` counts each kind per sheet, so an agent skips the calls that would return
nothing:

```sh
excel describe_workbook --tool-arg filePath=sales.xlsx \
  | jq -c '.sheets[] | {name, tableCount, dataValidationRuleCount, conditionalFormatRuleCount, mergeCount, imageCount}'
```

```json
{"name":"Orders","tableCount":1,"dataValidationRuleCount":1,"conditionalFormatRuleCount":1,"mergeCount":0,"imageCount":0}
{"name":"Targets","tableCount":0,"dataValidationRuleCount":0,"conditionalFormatRuleCount":0,"mergeCount":0,"imageCount":0}
```

## Formulas as well as values

```sh
excel read_sheet --tool-arg filePath=sales.xlsx range=F1:H3 valueMode=both \
  | jq '{values, cellNotes}'
```

```json
{
  "values": [
    [
      4,
      250,
      1000
    ],
    [
      10,
      85,
      850
    ]
  ],
  "cellNotes": {
    "H2": {
      "kind": "formula",
      "formula": "=F2*G2",
      "cached": true
    },
    "H3": {
      "kind": "formula",
      "formula": "=F3*G3",
      "cached": true
    }
  }
}
```

`values` keeps the results Excel last saved; `cellNotes` adds each formula. `valueMode: "formulas"`
puts the formula text in `values` instead.

:::details[When a formula has no value]

The server does not calculate. A formula the saving program never calculated, common in files written
by code, has no stored value: its cell is `null`, `cellNotes` marks it `cached: false`, and the answer
carries a warning. `describe_workbook` reports `formulaCellCount` and `cachedFormulaValueCount` per
sheet, so the gap is visible before reading.

:::

## Excel Tables

```sh
excel get_tables --tool-arg filePath=sales.xlsx \
  | jq -c '.tables[] | {name, ref, headerRow, totalsRow}, [.columns[] | "\(.letter)=\(.name)"]'
```

```json
{"name":"Orders","ref":"A1:H13","headerRow":true,"totalsRow":false}
["A=Order","B=Date","C=Region","D=Rep","E=Product","F=Units","G=Unit price","H=Total"]
```

A table's `ref` and column names are what the author declared: the most reliable way to know where a
dataset starts and ends.

## Validation and conditional formatting

```sh
excel get_data_validations --tool-arg filePath=sales.xlsx | jq -c '.rules[]'
```

```json
{"ranges":["C2:C13"],"rangesTruncated":false,"type":"list","formulae":["\"North,South,East,West\""]}
```

```sh
excel get_conditional_formats --tool-arg filePath=sales.xlsx | jq -c '.rules[]'
```

```json
{"ranges":["H2:H13"],"rangesTruncated":false,"type":"cellIs","priority":1,"operator":"greaterThan","formulae":["800"]}
```

A list rule is the set of values a column accepts. A formatting rule is reported as its condition,
here a total over 800, not as the colors it applies.

## Merged cells and pictures

```sh
excel get_merged_ranges --tool-arg filePath=report.xlsx | jq -c '.merges'
```

```json
["A1:H1"]
```

`get_images` lists each embedded picture's anchor, size and extension, not the image itself. Charts,
pivot tables and sparklines are refused:

```sh
excel get_images --tool-arg filePath=sales.xlsx kind=chart
```

```text
{"error":{"code":"tool_is_error","message":"Tool 'get_images' returned isError:true."}}
{
  "error": "unsupported_object_kind",
  "message": "get_images cannot read chart objects; the reader never unzips xl/charts or xl/pivotCache, so an empty list would be a lie rather than an answer.",
  "recovery": "Call describe_workbook and read the capabilities block; charts, pivotTables and sparklines are false for every format."
}
```

:::details[Why charts are refused instead of listed as none]

"This sheet has no charts" and "I cannot see charts" lead an agent to different answers. An empty
list would say the first while meaning the second, so the server refuses, and `describe_workbook`
states the ceiling up front: `charts`, `pivotTables` and `sparklines` are `false` in every file's
`capabilities` block. Absence is reported only when the server looked and found nothing.

:::
