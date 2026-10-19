# Read pictures and spilled results

A modern workbook keeps pictures inside cells and formulas that spill over several cells. The
server reads both as they were saved, so an agent sees a picture and its alt text instead of
`#VALUE!`, and knows which cells one formula filled.

Uses the `excel` helper from the [Quickstart](/docs/excel-mcp/quickstart#see-what-the-agent-receives)
on [pictures.xlsx](/samples/excel-mcp/pictures.xlsx), a small workbook written with XlsxWriter.

## Find the pictures

`get_images` lists pictures placed inside cells next to pictures floating over the grid. An
in-cell picture names its cell and keeps the alt text its author saved:

```sh
excel get_images --tool-arg filePath=pictures.xlsx sheetName=Rich | jq -c '.images[]'
```

```text
{"imageId":0,"anchor":"inCell","cell":"A2","extension":"png","sizeBytes":73,"altText":"店舗 — München — متجر <A&B>","decorative":false}
{"imageId":1,"anchor":"inCell","cell":"A3","extension":"png","sizeBytes":73,"decorative":true}
```

## Read a picture as a cell value

In the grid, the picture is the cell's value. A decorative picture says so and has no alt text:

```sh
excel read_sheet --tool-arg filePath=pictures.xlsx sheetName=Rich range=A1:B3 \
  | jq -c '.values[]'
```

```text
[{"imageId":0,"altText":"店舗 — München — متجر <A&B>","decorative":false},"Image with independent Unicode alt text"]
[{"imageId":1,"decorative":true},"Decorative image without alt text"]
```

## See which cells a formula filled

A dynamic-array formula is saved once, at its anchor, and its results fill the cells below. Each
filled cell carries a note naming the anchor and the whole range, so an agent does not mistake the
results for typed-in numbers. The values are the ones saved in the file; nothing is recalculated:

```sh
excel read_sheet --tool-arg filePath=pictures.xlsx sheetName=Rich range=C1:C4 valueMode=both \
  | jq -c '.values[], .cellNotes'
```

```text
[10]
[20]
[30]
{"C2":{"kind":"formula","formula":"=SEQUENCE(3,1,10,10)","cached":true,"array":{"anchor":"C2","ref":"C2:C4","dynamic":true,"collapsed":false}},"C3":{"kind":"array","array":{"anchor":"C2","ref":"C2:C4","dynamic":true,"collapsed":false}},"C4":{"kind":"array","array":{"anchor":"C2","ref":"C2:C4","dynamic":true,"collapsed":false}}}
```

:::details[What is not read]

Linked data types (stocks, places) show the label Excel cached when the file was saved; nothing is
fetched again. A rich value of an unknown type keeps the value Excel saved for older readers, with a
note that says so.

:::
