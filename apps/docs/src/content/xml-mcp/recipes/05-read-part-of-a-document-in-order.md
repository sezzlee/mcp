# Read part of a document in order

`read_node` returns a subtree as flat records in document order: elements, text, CDATA, comments and
processing instructions, each with its position. Use it to see a record whole, to read narrative
content where order matters, or to look around a match from `find_in_document` or `select_xpath`.

Uses the `xml` helper from the [Quickstart](/docs/xml-mcp/quickstart#see-what-the-agent-receives) on
`orders.xml`.

## Point at an element

`address` is a path of steps from the document element, each a namespace URI, a local name and an
`occurrence` among siblings of that name, counting from 1. Every tool that reports a node gives you
an address to pass straight back. This is the third order:

```sh
ORDER3='[{"namespaceUri":"urn:example:orders","localName":"orders"},{"namespaceUri":"urn:example:orders","localName":"order","occurrence":3}]'
xml read_node --tool-arg filePath=orders.xml "address=$ORDER3" \
  | jq -c '.records[] | [.nodeId, .kind, (.localName // .value), ([.attributes[]? | "\(.localName)=\(.value)"] | join(" "))]'
```

```json
["1.6","element","order","id=1003 status=pending"]
["1.6.1","text","\n    ",""]
["1.6.2","element","date",""]
["1.6.2.1","text","2026-01-08",""]
["1.6.3","text","\n    ",""]
["1.6.4","element","region",""]
["1.6.4.1","text","East",""]
["1.6.5","text","\n    ",""]
["1.6.6","element","customer",""]
["1.6.6.1","text","Lena",""]
["1.6.7","text","\n    ",""]
["1.6.8","element","line","sku=LAMP qty=12 price=30.00"]
["1.6.9","text","\n    ",""]
["1.6.10","element","line","sku=DESK qty=1 price=250.00"]
["1.6.11","text","\n    ",""]
["1.6.12","element","payment","method=card"]
["1.6.12.1","text","610.00",""]
["1.6.13","text","\n  ",""]
```

Every record has a `nodeId`, the path of child positions from the document element (`"1.6.9"` is the
ninth child of the sixth child of the root), plus `parentId` and `childIndex`. The whitespace between
elements is text in the document, so it comes back as `text` records; values are never trimmed.

## Limit the depth

`maxDepth` is how many levels below the addressed element to descend; `0` returns the element alone.
An element whose children were cut off says so with `childrenOmitted`:

```sh
xml read_node --tool-arg filePath=orders.xml "address=$ORDER3" maxDepth=1 \
  | jq -c '.records[] | select(.kind == "element") | [.nodeId, .localName, .childrenOmitted]'
```

```json
["1.6","order",null]
["1.6.2","date",true]
["1.6.4","region",true]
["1.6.6","customer",true]
["1.6.8","line",null]
["1.6.10","line",null]
["1.6.12","payment",true]
```

## Page through a long subtree

`maxNodes` caps a page, 50 by default and 200 at most, and the 512 KB response budget can stop it
sooner. A longer subtree returns `nextCursor`; pass it back as `cursor` with the same `filePath`. Each
record carries its `nodeId` and `parentId`, so pages join back into the tree without gaps or
duplicates. A cursor cannot be combined with `address`, expires after ten minutes, and fails with
`stale_cursor` if the document changed.

The ordered view starts at the document element. A comment or processing instruction before it, in
the prolog, is not addressable in this version, and `describe_document` says so in its `notes`.
