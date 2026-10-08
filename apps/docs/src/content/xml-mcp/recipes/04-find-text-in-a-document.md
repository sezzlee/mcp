# Find text in a document

`find_in_document` finds a literal string in a document's text nodes, attribute values or both, and
returns where each match is. The query is never a pattern or a query language.

Uses the `xml` helper from the [Quickstart](/docs/xml-mcp/quickstart#see-what-the-agent-receives) on
`orders.xml`.

## Search text

By default the search covers text nodes and is case-sensitive, because XML is:

```sh
xml find_in_document --tool-arg filePath=orders.xml query=Emre \
  | jq -c '(.matches[] | {matchKind, snippet, address: [.address[] | "\(.localName)[\(.occurrence)]"]}), {totalMatches}'
```

```json
{"matchKind":"text","snippet":"Emre","address":["orders[1]","order[2]","customer[1]"]}
{"matchKind":"text","snippet":"Emre","address":["orders[1]","order[6]","customer[1]"]}
{"totalMatches":2}
```

Each match carries an address that `read_node` accepts, so the agent can open the surrounding record
next.

## Search attribute values

SKUs in `orders.xml` are attributes, so a text search does not see them:

```sh
xml find_in_document --tool-arg filePath=orders.xml query=DESK | jq -c '{totalMatches}'
```

```json
{"totalMatches":0}
```

Pass `searchIn` as `attributes`, or `both`:

```sh
xml find_in_document --tool-arg filePath=orders.xml query=DESK searchIn=attributes \
  | jq -c '.matches[] | {matchKind, attribute: .attribute.localName, snippet, order: .address[1].occurrence}'
```

```json
{"matchKind":"attribute","attribute":"sku","snippet":"DESK","order":1}
{"matchKind":"attribute","attribute":"sku","snippet":"DESK","order":3}
{"matchKind":"attribute","attribute":"sku","snippet":"DESK","order":5}
```

With `both`, a text match and an attribute match on the same element are reported separately.

## Match a whole value

`matchMode: "exact"` matches only a value equal to the query; the default `contains` matches a
substring. There is no case-insensitive mode: search for each spelling you expect, or use
`project_records` with `caseSensitive: false`.

## Narrow the scope

`scopeAddress` limits the scan to one element's subtree. `totalMatches` appears only when the scan
reached the end. When it stopped early, because `maxResults` matches were found (50 by default) or
50,000 nodes were examined, the answer has `complete: false`, reports `matchedSoFar` and
`scannedCount`, and `nextCursor` continues from there. The tool is unavailable on a document read in
chunked mode, over 8 MB.
