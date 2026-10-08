# Read a CSV export

A `.csv` file is read with the same tools as a workbook. The server detects the delimiter and the
encoding, reports both on every answer, and keeps every value as the exact text in the file.

Uses the `excel` helper from the [Quickstart](/docs/excel-mcp/quickstart#see-what-the-agent-receives).

## Read it

```sh
printf 'Order;Region;Units\n1001;North;4\n1002;South;10\n1003;East;012\n' \
  > ~/sezzlee-sheets/orders.csv
```

```sh
excel read_sheet --tool-arg filePath=orders.csv | jq -c '.values[], .csv'
```

```json
["1001","North","4"]
["1002","South","10"]
["1003","East","012"]
{"delimiter":"semicolon","delimiterSource":"sniffed","encoding":"utf-8","encodingSource":"default","hadBom":false,"lineBreak":"lf","recordCount":4,"columnCount":3,"raggedRecordCount":0,"blankRecordCount":0,"formulaLikeCellCount":0}
```

`"012"` keeps its leading zero and `"4"` stays a string. When two delimiters fit equally well, the
call fails with `ambiguous_delimiter`; pass `delimiter` as `comma`, `semicolon`, `tab` or `pipe`.

## Add up numeric text

A numeric metric skips text, so a CSV column sums to `null` until you ask for numbers:

```sh
excel aggregate_sheet --tool-arg filePath=orders.csv \
  'metrics=[{"fn":"sum","column":"Units"}]' | jq -c '.rows[], .columns[0]'
```

```json
[null]
{"label":"sum(Units)","letter":"C","role":"metric","fn":"sum","counted":0,"skipped":3}
```

```sh
excel aggregate_sheet --tool-arg filePath=orders.csv coerceText=true \
  'metrics=[{"fn":"sum","column":"Units"}]' | jq -c '.rows[], .columns[0]'
```

```json
[26]
{"label":"sum(Units)","letter":"C","role":"metric","fn":"sum","counted":3,"skipped":0}
```

## Fix the encoding

Without a byte-order mark the server assumes UTF-8 and refuses a file that is not, rather than show
broken characters. A file saved by Turkish Excel:

```sh
printf 'Şehir;Adet\nİstanbul;3\nİzmir;5\n' | iconv -f UTF-8 -t WINDOWS-1254 \
  > ~/sezzlee-sheets/cities.csv
excel read_sheet --tool-arg filePath=cities.csv
```

```text
{"error":{"code":"tool_is_error","message":"Tool 'read_sheet' returned isError:true."}}
{
  "error": "undecodable_text",
  "message": "'cities.csv' is not valid utf-8 text.",
  "recovery": "Pass encoding explicitly: 'windows-1254' (Turkish Excel), 'iso-8859-9', 'windows-1252', 'utf-16le' or 'utf-16be'."
}
```

The first line comes from the Inspector; the object under it is the server's answer. Pass the
encoding it suggests:

```sh
excel read_sheet --tool-arg filePath=cities.csv encoding=windows-1254 \
  | jq -c '[.columns[].header], .values[]'
```

```json
["Şehir","Adet"]
["İstanbul","3"]
["İzmir","5"]
```

## Know what a CSV cannot answer

A CSV has no formulas, merged cells, tables, validation rules, formatting or pictures, and asking for
one fails instead of returning an empty list:

```sh
excel get_tables --tool-arg filePath=orders.csv
```

```text
{"error":{"code":"tool_is_error","message":"Tool 'get_tables' returned isError:true."}}
{
  "error": "unsupported_for_format",
  "message": "get_tables is not available for csv files; the format cannot carry that information.",
  "recovery": "Call describe_workbook and read the capabilities block."
}
```

`describe_workbook` lists what each file supports in its `capabilities` block.

:::details[Why CSV values are never converted]

A CSV stores only text, and every conversion loses something: `01234` read as a number drops the
leading zero of a postcode, `03-04-2024` is a different day in different locales, and `1.234` means
two different numbers. The server reports what the file says, and what it detects — delimiter and
encoding — it reports with whether it detected or was told. Where a number is needed, the call says
so with `coerceText`, so the conversion is visible. An `.xlsx` cell has a stored type, so workbook
numbers and dates come back typed.

:::
