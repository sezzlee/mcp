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

The profiler recommends a date definition only when its explicit reading preserves the sampled
dates. A fixed pattern may reject a different date shape after the sample; raw values remain
available and typed diagnostics count the failure. When a sampled mixture cannot be represented
by one definition, `columns` keeps that column as text and its profile explains why. An explicit
date definition supplied by the caller is preserved; `readAs` and unreadable diagnostics describe
that requested conversion, while the inferred type and confidence describe the observed sample.

Locale-specific digits and grouping require the corresponding column definition. A locale is a
formatting convention, not an instruction to guess which country produced an ambiguous number.
Name the locale the file was written in, never the language of the person asking, and omit it when
you do not know: the column's own values then decide.

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
such as `d MMMM yyyy`. Unsupported locales, numbering systems and non-Gregorian calendar requests
are refused. When a locale's separators read a value as a different number than the column's own
marks do, a warning names that value. See the [tool reference](/docs/excel-mcp/tools).

## Let the column order its dates

A locale never decides whether `03/04/2026` is March or April. A US export read by someone who
names `tr-TR` still takes its order from its own values: `04/13/2026` can only be month first.

```sh
printf 'Date,Amount\n04/13/2026,10\n03/04/2026,20\n' > ~/sezzlee-sheets/us-dates.csv
excel aggregate_sheet --tool-arg filePath=us-dates.csv locale=tr-TR \
  'groupBy=[{"column":"Date","by":"month"}]' 'metrics=[{"fn":"sum","column":"Amount"}]' \
  | jq -c '.rows[]'
```

```text
["2026-03",20]
["2026-04",10]
```

When no value proves the order, the dates are not read and a warning names the `columns` entries
that settle it.

```sh
printf 'Date,Amount\n03/04/2026,10\n05/06/2026,20\n' > ~/sezzlee-sheets/early-dates.csv
excel aggregate_sheet --tool-arg filePath=early-dates.csv locale=tr-TR \
  'groupBy=[{"column":"Date","by":"month"}]' 'metrics=[{"fn":"sum","column":"Amount"}]' \
  | jq -c '{rows,ungroupedRows,warnings}'
```

```text
{"rows":[],"ungroupedRows":2,"warnings":["A: dates such as '03/04/2026' read either day first or month first, so they were not read as dates. Pass columns [{\"column\":\"A\",\"type\":\"date\",\"format\":\"dd/MM/yyyy\"}] or [{\"column\":\"A\",\"type\":\"date\",\"format\":\"MM/dd/yyyy\"}].","Grouping Date (month): 2 cells in A could not be read for this key, such as '03/04/2026', '05/06/2026'; these rows are counted in ungroupedRows for each affected grouping."]}
```

Inferred dotted dates use a day-first convention under every locale. Custom exports can use other
conventions: a dotted column holding a value only month first can read, such as `01.15.2026`, is
reported as ambiguous. A slash or dash date's inferred order does not change dotted dates in the
same column. Date `format` and `order` are mutually exclusive; an explicit `order` also applies to
dotted dates.

:::details[Read dates with literal year, month and day markers]

Some exports need an explicit pattern even when their locale is known. Chinese and Japanese
`年 月 日`, Korean `년 월 일`, and the Russian year marker `г.` are accepted in the closed format
grammar. They are not automatically inferred, and weekday prefixes, eras and arbitrary quoted
literals remain outside that grammar.

```sh
cat > ~/sezzlee-sheets/date-markers.csv <<'CSV'
Chinese;Korean;Russian
2026年3月13日;2026년 3월 13일;13 марта 2026 г.
CSV
excel read_sheet --tool-arg filePath=date-markers.csv includeTyped=true \
  'columns=[{"column":"Chinese","type":"date","locale":"zh-CN","format":"yyyy年M月d日"},{"column":"Korean","type":"date","locale":"ko-KR","format":"yyyy년 M월 d일"},{"column":"Russian","type":"date","locale":"ru-RU","format":"d MMMM yyyy г."}]' \
  | jq -c '.values[], .typedValues[]'
```

```text
["2026年3月13日","2026년 3월 13일","13 марта 2026 г."]
["2026-03-13","2026-03-13","2026-03-13"]
```

The original strings remain in `values`. A string that does not match the explicit pattern becomes
null only in `typedValues`, with an unreadable count and bounded examples.

:::

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
