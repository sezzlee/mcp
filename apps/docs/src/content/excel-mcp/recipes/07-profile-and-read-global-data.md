# Profile and read global data

Inspect a bounded sample, then reuse its column interpretation for reading and analysis. Use the
`excel` helper from the [quickstart](/docs/excel-mcp/quickstart).

This file declares its separator on the first line. The declaration is removed before the next
record becomes the header; it does not increase the reported record count.

```sh
cat > ~/sezzlee-sheets/typed.csv <<'CSV'
sep=;
Id;Amount;Active;Elapsed
00123;1.234,50;Evet;25:30
00456;N/A;Hayır;PT2H
00789;2.000,00;Evet;00:30
CSV
excel profile_sheet --tool-arg filePath=typed.csv \
  | jq -c '{sampledRows,omittedRows,columnMode,columns,csv:(.csv | {delimiter,delimiterSource,recordCount})}'
```

```text
{"sampledRows":3,"omittedRows":0,"columnMode":"letter","columns":[{"column":"A","type":"text"},{"type":"number","decimal":",","group":".","column":"B","identifiers":"refuse"},{"column":"C","type":"boolean"},{"column":"D","type":"duration"}],"csv":{"delimiter":"semicolon","delimiterSource":"sep","recordCount":4}}
```

The number recommendation refuses identifiers even after the sampled prefix. A sample describes
only the rows it inspected: check `omittedRows`, `omittedColumns`, confidence and the distinct-count
exactness before treating it as a description of the whole file.

```sh
typed_columns=$(excel profile_sheet --tool-arg filePath=typed.csv | jq -c '.columns')
excel read_sheet --tool-arg filePath=typed.csv columnMode=letter includeTyped=true \
  "columns=$typed_columns" | jq -c '.values[], .typedValues[]'
```

```text
["00123","1.234,50","Evet","25:30"]
["00456","N/A","Hayır","PT2H"]
["00789","2.000,00","Evet","00:30"]
["00123",1234.5,true,{"durationSeconds":91800}]
["00456",null,false,{"durationSeconds":7200}]
["00789",2000,true,{"durationSeconds":1800}]
```

Raw `values` retain the original spelling. The added typed grid normalizes readable values and
uses null for missing or unreadable cells; `typed.columns` gives their separate counts and examples.

```sh
excel aggregate_sheet --tool-arg filePath=typed.csv columnMode=letter compact=true \
  "columns=$typed_columns" \
  'metrics=[{"fn":"sum","column":"B"},{"fn":"trueRatio","column":"C"},{"fn":"sum","column":"D"}]' \
  | jq -c '.rows[]'
```

```text
[3234.5,0.6666666666666666,100800]
```

The amount excludes N/A, the ratio uses valid booleans, and the duration total is in seconds.
`countTrue` and `countFalse` are also available. Null and blank text are always missing; pass
`missingValues=[]` to retain the other default missing tokens as literal text.

## Choose a locale explicitly

Locale-specific digits and grouping require the corresponding column definition. A locale is a
formatting convention, not an instruction to guess which country produced an ambiguous number.

```sh
printf 'Amount\n"١٬٢٣٤٫٥٠"\n' > ~/sezzlee-sheets/arabic.csv
excel aggregate_sheet --tool-arg filePath=arabic.csv delimiter=comma compact=true \
  'columns=[{"column":"Amount","type":"number","locale":"ar-EG","numberingSystem":"arab"}]' \
  'metrics=[{"fn":"sum","column":"Amount"}]' | jq -c '.rows[]'
```

```text
[1234.5]
```

`hi-IN` accepts Indian 3+2 grouping; `fr-FR` supplies French Gregorian month names for a format
such as `d MMMM yyyy`. Date `format` and `order` are mutually exclusive. Without either, explicit
date reading accepts only unambiguous dates. Unsupported locales, numbering systems and
non-Gregorian calendar requests are refused. See the [tool reference](/docs/excel-mcp/tools).

## Override a separator declaration

An explicit delimiter takes precedence. A conflicting declaration is still removed and adds a
warning in `csv.warnings`. Both bare and quoted whole-line declarations are accepted, following
the forms documented in [LibreOffice's CSV filter parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/csv_params.html).
This reader always omits a recognized declaration; LibreOffice exposes omission as a starting-row
setting. Only comma, semicolon, an actual tab and pipe are supported. Extra spaces or text and
declarations after the first physical line remain data.

```sh
printf '"sep=;"\r\nName,Amount\r\nOslo,12\r\n' > ~/sezzlee-sheets/declared.csv
excel read_sheet --tool-arg filePath=declared.csv delimiter=comma \
  | jq -c '{delimiter:.csv.delimiter,delimiterSource:.csv.delimiterSource,values}'
```

```text
{"delimiter":"comma","delimiterSource":"explicit","values":[["Oslo","12"]]}
```

Sheet row numbers start after the declaration. Malformed CSV still names the physical file line
where quoting fails, and the declaration's line ending contributes to `csv.lineBreak`.
