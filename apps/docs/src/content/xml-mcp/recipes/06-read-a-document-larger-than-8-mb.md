# Read a document larger than 8 MB

A document up to 8 MB is parsed whole and every tool works on it. Between 8 MB and 50 MB the server
switches to **chunked mode**: it parses one record at a time, so memory stays bounded, and only the
tools that work record by record are available.

Uses the `xml` helper from the [Quickstart](/docs/xml-mcp/quickstart#see-what-the-agent-receives).

## Make a large document

This writes a 9 MB log with one `event` element per request:

```sh
node -e '
const fs = require("fs");
const out = fs.openSync(process.env.HOME + "/sezzlee-xml/events.xml", "w");
fs.writeSync(out, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<log>\n");
let size = 0;
for (let i = 0; size < 9 * 1024 * 1024; i++) {
  const line = `  <event id="${i}" level="${i % 7 === 0 ? "error" : "info"}"><msg>Request ${i} took ${i % 500} ms</msg></event>\n`;
  size += fs.writeSync(out, line);
}
fs.writeSync(out, "</log>\n");
'
```

## Check the mode

```sh
xml describe_document --tool-arg filePath=events.xml \
  | jq -c '{mode, sizeBytes}, (.capabilities | {recordProjection, xpath, literalSearch, aggregation})'
```

```json
{"mode":"chunked","sizeBytes":9437278}
{"recordProjection":true,"xpath":false,"literalSearch":false,"aggregation":false}
```

`describe_document` still reports the structure, including the repeated `event` element. The
capabilities say what the mode allows.

## Read records

`project_records` reads a chunked document the same way as a small one:

```sh
EVENTS='{"ancestors":[{"namespaceUri":"","localName":"log"}],"name":{"namespaceUri":"","localName":"event"}}'
xml project_records --tool-arg filePath=events.xml "itemAddress=$EVENTS" \
  'columns=[{"label":"id","value":{"from":"attribute","namespaceUri":"","localName":"id"}},{"label":"msg","name":{"namespaceUri":"","localName":"msg"}}]' \
  'where=[{"column":"id","op":"in","values":["7","14"]}]' maxRows=2 \
  | jq -c '(.rows[] | [.cells[].value]), {mode, scannedItems, complete, truncated}'
```

```json
["7","Request 7 took 7 ms"]
["14","Request 14 took 14 ms"]
{"mode":"chunked","scannedItems":50000,"complete":false,"truncated":true}
```

One call examines at most 50,000 records, so on a large file the answer has `complete: false` and a
`nextCursor` that continues the scan. A single record larger than 8 MB cannot be read in this mode.

## Know what is refused

`select_xpath`, `find_in_document` and `aggregate_document` need the whole tree and are refused. The
recovery points to what still works:

```sh
xml find_in_document --tool-arg filePath=events.xml query="Request 42 "
```

```text
{"error":{"code":"tool_is_error","message":"Tool 'find_in_document' returned isError:true."}}
{
  "error": "unsupported_for_format",
  "message": "find_in_document is not available for a document read in chunked mode: it needs the whole document resident, and this file is above the 8388608 byte resident budget.",
  "recovery": "Use project_records with an itemAddress and a where condition to filter records by value."
}
```

To search or total a large document, filter it with `project_records` and `where`, page through the
matches and total them on the caller's side, or split the file into parts under 8 MB. Above 50 MB a
file is refused with `file_too_large`.
