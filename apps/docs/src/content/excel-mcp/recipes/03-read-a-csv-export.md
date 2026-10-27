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

:::details[What formulaLikeCellCount counts]

A CSV holds no formulas, so a cell that starts with `=` comes back as the text it is.
`formulaLikeCellCount` counts the cells LibreOffice runs as a formula when it opens the file: `=`
followed by anything. Excel may also run a cell that starts with `+`, `-` or `@`, the prefixes
[OWASP lists for CSV injection](https://owasp.org/www-community/attacks/CSV_Injection); those are
not counted, because almost every such cell is a negative number or a dash. Whatever the count,
a cell's text is data for the agent, never an instruction.

:::

## Add up numbers written as text

A CSV stores every value as text. A numeric metric reads the column's text as numbers, deciding the
decimal and thousands separators from the whole column, and `readAs` says how it read them:

```sh
excel aggregate_sheet --tool-arg filePath=orders.csv \
  'metrics=[{"fn":"sum","column":"Units"}]' | jq -c '.rows[], .readAs, .warnings[]'
```

```json
[14]
{"C":[{"type":"number","decimal":".","group":"none"}]}
{"code":"identifier_cells","message":"C: 1 cell looks like an identifier (a leading zero or more than 15 digits), such as '012'; the totals exclude them. If they are quantities, pass columns [{\"column\":\"C\",\"type\":\"number\",\"decimal\":\".\"}].","column":"C"}
```

`012` has a leading zero, the mark of a postcode or an account number, so it is left out and the
warning says so. A value with more than 15 digits is treated the same way. When the column holds
quantities, `columns` says so and every value is summed:

```sh
excel aggregate_sheet --tool-arg filePath=orders.csv \
  'columns=[{"column":"Units","type":"number","decimal":"."}]' \
  'metrics=[{"fn":"sum","column":"Units"}]' | jq -c '.rows[]'
```

```json
[26]
```

`1.234,50`, `1,234.50`, `(100,00)`, `%20` and `₺95` are all read this way. When a column does not
show which separator is the decimal, because every value looks like `1.234`, none of those values is
read and a warning names the `columns` entry that settles it.

Dates follow the same rule against an ISO operand: `02.01.2023` is 2 January, and a column of
`01/02/2023`-style dates is read day first or month first only when one of its values proves which.

To inspect an unfamiliar file first, use [profile_sheet and reuse its columns](/docs/excel-mcp/profile-and-read-global-data).
Explicit locales cover other digit systems, grouping sizes and Gregorian month names. Typed
reading adds a parallel grid while preserving the raw values shown above.

## Fix the encoding

Explicit legacy choices also include Windows-1251/1256, Shift_JIS, GB18030, Big5 and EUC-KR.
No legacy encoding is guessed; truncated multibyte sequences are refused.

Without a byte-order mark the server assumes UTF-8 and refuses a file that is not, rather than show
broken characters. A file saved by Turkish Excel:

```sh
printf 'Şehir;Adet\nİstanbul;3\nİzmir;5\n' | iconv -f UTF-8 -t WINDOWS-1254 \
  > ~/sezzlee-sheets/cities.csv
excel read_sheet --tool-arg filePath=cities.csv || test "$?" -eq 5
```

```text
{"error":{"code":"tool_is_error","message":"Tool 'read_sheet' returned isError:true."}}
{
  "error": "undecodable_text",
  "message": "'cities.csv' is not valid utf-8 text.",
  "recovery": "Pass the file's known encoding explicitly, or save it as UTF-8. Legacy encodings are never guessed."
}
```

The first line comes from the Inspector; the object under it is the server's answer. Pass the
known encoding of this export:

```sh
excel read_sheet --tool-arg filePath=cities.csv encoding=windows-1254 \
  | jq -c '[.columns[].header], .values[]'
```

```json
["Şehir","Adet"]
["İstanbul","3"]
["İzmir","5"]
```

## Find a broken quote

A quote that opens a field must close it, and a quote inside an unquoted field is not allowed. The
server refuses such a file and names the line instead of guessing where the field ends:

```sh
printf 'Order,Note\n1001,"Leave at the door"\n1002,Ring "twice"\n' \
  > ~/sezzlee-sheets/notes.csv
excel read_sheet --tool-arg filePath=notes.csv || test "$?" -eq 5
```

```text
{"error":{"code":"tool_is_error","message":"Tool 'read_sheet' returned isError:true."}}
{
  "error": "corrupt_workbook",
  "message": "'notes.csv' is not well-formed CSV: a quote inside an unquoted field on line 3.",
  "recovery": "Check the quoting around the reported line and re-save the file."
}
```

Quote the whole field and double the quotes inside it:

```sh
printf 'Order,Note\n1001,"Leave at the door"\n1002,"Ring ""twice"""\n' \
  > ~/sezzlee-sheets/notes.csv
excel read_sheet --tool-arg filePath=notes.csv | jq -c '.values[]'
```

```json
["1001","Leave at the door"]
["1002","Ring \"twice\""]
```

:::details[How records are split]

The server reads RFC 4180 quoting: a field is quoted only when its first character is a quote, two
quotes inside it stand for one, and delimiters and line breaks inside it are data. Outside quotes,
CRLF, LF and CR each end a record, even when one file mixes them, so a line break Excel stores
inside a cell (Alt+Enter) stays in its cell. `lineBreak` reports the breaks that end records. A
malformed file is refused rather than repaired, because a repair is a guess about which records
belong together, and a wrong guess shifts every value after it without an error.

:::

## Know what a CSV cannot answer

A CSV has no formulas, merged cells, tables, validation rules, formatting or pictures, and asking for
one fails instead of returning an empty list:

```sh
excel get_tables --tool-arg filePath=orders.csv || test "$?" -eq 5
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
For CSV, `capabilities.typedValues: false` means that cells have no native stored types.
Explicit `columns` with `includeTyped: true` can still add interpreted values alongside the raw
text; see [Profile and read global data](/docs/excel-mcp/profile-and-read-global-data).

:::details[How CSV values are read]

A CSV stores only text, and a careless conversion loses something: `01234` read as a number drops
the leading zero of a postcode, `03-04-2024` is a different day in different locales, and `1.234`
means two different numbers. So `read_sheet` and `find_in_sheet` return the text as the file holds
it. `aggregate_sheet` reads text as a number or a date only where a metric or a filter needs one, decides
the format from the whole column, and reports what it decided in `readAs`. A value it cannot read,
an identifier and a column it cannot decide are counted in `warnings` with examples, never dropped
in silence. An `.xlsx` cell has a stored type, so workbook numbers and dates come back typed.

:::
