# Query a document with XPath

`select_xpath` evaluates one XPath 1.0 expression and returns a typed result. The expression runs
exactly as written: the server never rewrites it, never guesses a namespace, and offers no extension
functions and nothing from XPath 2.0 or later.

Uses the `xml` helper from the [Quickstart](/docs/xml-mcp/quickstart#see-what-the-agent-receives) on
`orders.xml`.

## Bind the namespaces

In XPath 1.0 a name without a prefix matches only elements in **no** namespace. `orders.xml` puts
every element in a default namespace, so the obvious query finds nothing:

```sh
xml select_xpath --tool-arg filePath=orders.xml xpath=//order \
  | jq '{resultType, totalMembers, diagnostics}'
```

```json
{
  "resultType": "nodeset",
  "totalMembers": 0,
  "diagnostics": [
    {
      "code": "default_namespace_unprefixed",
      "message": "The node-set is empty. The document element is in the namespace urn:example:orders, and in XPath 1.0 an unprefixed name test such as order matches only elements in no namespace.",
      "recovery": "Bind it in namespaces; describe_document returns an alias for every namespace in the document."
    }
  ]
}
```

The server says why the result is empty and leaves the query alone. `describe_document` lists every
namespace URI with an alias:

```sh
xml describe_document --tool-arg filePath=orders.xml \
  | jq -c '.namespaces[] | {uri, alias}'
```

```json
{"uri":"urn:example:orders","alias":"ns1"}
{"uri":"urn:example:payments","alias":"pay"}
```

The payments namespace is written with the prefix `pay`, so that is its alias. The orders namespace
is the default and has no prefix, so the server calls it `ns1`. Bind a prefix of your choice to each
URI with `namespaces` and use it in the expression:

```sh
xml select_xpath --tool-arg filePath=orders.xml \
  "xpath=//o:order[not(o:region)]/@id" \
  'namespaces=[{"prefix":"o","uri":"urn:example:orders"}]' \
  | jq -c '.resultType, (.members[] | {kind, localName, value, address: [.address[].occurrence]})'
```

```json
"nodeset"
{"kind":"attribute","localName":"id","value":"1006","address":[1,6]}
```

A prefix used but not bound is an error, and so is a prefix bound twice.

## Read the result type

`resultType` separates the four XPath results, so an empty node-set, an empty string, `false` and `0`
each come back as themselves:

```sh
xml select_xpath --tool-arg filePath=orders.xml \
  "xpath=sum(//o:order[@status='shipped']/p:payment)" \
  'namespaces=[{"prefix":"o","uri":"urn:example:orders"},{"prefix":"p","uri":"urn:example:payments"}]' \
  | jq -c '{resultType, numberKind, value, valueText}'
```

```json
{"resultType":"number","numberKind":"finite","value":2570,"valueText":"2570"}
```

A number carries `numberKind`: `finite`, `nan`, `positiveInfinity` or `negativeInfinity`. JSON has no
`NaN` or infinity, so for those `value` is `null` and `valueText` says which. A node-set member has
an address that `read_node` accepts; a comment before the document element and a namespace node have
none and say `unaddressable`.

## Bound a large node-set

`maxResults` caps the members returned, 50 by default and 200 at most, and `nextCursor` continues. It
bounds the answer, not the work: the engine may still build the whole node-set. On a large document,
narrow the set with a predicate, or use `project_records` for record-shaped data.

A function from XPath 2.0 or later, such as `matches()` or `lower-case()`, fails with
`query_not_supported` instead of being emulated, and so does the `namespace::` axis. XPath is
unavailable on a document read in chunked mode, over 8 MB.

:::details[Why namespaces are never guessed]

The usual reason a query returns nothing is a namespace. A document declares `xmlns="urn:example:orders"`
once, every element below inherits it, and nothing in `<order>` shows that its real name is
`{urn:example:orders}order`.

A server could rewrite `//order` to match any element with that local name. But namespaces exist
because two vocabularies can use the same local name: a SOAP body wraps a payload in another
namespace, and an XHTML page can embed SVG where `title` means something else. Matching by local name
merges them into an answer that is wrong and looks right. A guessed binding works on the document it
was tested on and changes meaning on the next.

So every address names an element by URI and local name, never by prefix, and a prefix that is used
but not bound is refused. When a query is empty for the usual reason, the diagnostic names the
namespace and the fix.

:::
