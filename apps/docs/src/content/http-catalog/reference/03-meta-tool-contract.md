# Meta-tool contract

`tools/list` returns exactly three tools, whatever the catalog contains. The two SDKs publish the
same argument names, types and defaults. The key order of a published schema, and the dialect
decoration a generator writes around it — a `$schema` keyword, the numeric bounds of an integer —
are framework detail, not contract.

> **Source of truth.** The search and card semantics are normative in
> [`packages/http/spec/search-semantics.md`](https://github.com/sezzlee/mcp/blob/main/packages/http/spec/search-semantics.md)
> and the loaded tool's shape in
> [`tool-definition.schema.json`](https://github.com/sezzlee/mcp/blob/main/packages/http/spec/schemas/tool-definition.schema.json);
> where they differ from this page, they win.

## The three tools

```text
load_tool, search_tools, invoke_tool
```

Every one of them carries a `_meta` stamp naming the catalog generation it was listed for:

```json
{ "sezzlee/catalogGeneration": 0 }
```

When the catalog reloads, the number changes and the server sends `notifications/tools/list_changed`.
A client that caches tool definitions can compare the stamp instead of diffing them.

The number counts reloads inside one server process, and every process starts from the same value,
so it says nothing about whether two replicas hold the same catalog. To make sure a call lands on a
replica that agrees with what the agent read, pin the call to the tool's
[`version`](#invoke-tool).

## `search_tools`

```json
{
  "type": "object",
  "properties": {
    "query": {
      "description": "Keywords matched by prefix against operation names, descriptions, declared search terms, routes, argument names and tag text; keywords rank results, they do not filter them. Empty lists everything. To require a whole tag, use tags.",
      "type": "string",
      "default": ""
    },
    "limit": {
      "description": "Maximum number of results, 1-50.",
      "type": "integer",
      "default": 20
    },
    "detail": {
      "description": "Shape of each result: \"card\" for the compact card, \"schema\" for the full definition load_tool would return. Any other value is card. A schema page is much larger; pair it with a small limit.",
      "type": "string",
      "enum": ["card", "schema"],
      "default": "card"
    },
    "tags": {
      "description": "Tags every result must carry, matched against the whole tag and insensitive to case and accents. Empty applies no filter; the answer's tags field lists what is available.",
      "type": "array",
      "items": { "type": "string" },
      "default": null
    }
  }
}
```

`limit` is clamped to `1..50` rather than rejected, so an out-of-range value returns results
instead of an error. `detail` is clamped the same way: anything that is not exactly `schema` —
absent, empty, misspelled, or `Schema` — is `card`.

`tags` is a conjunction: a result carries every tag in the list. Matching is on the whole tag after
the same folding search uses, so case and accents are ignored, but a tag is never split into words
— `Order Notes` is one tag and not two, and `order` does not match `Orders`. An empty list filters
nothing, and a tag nobody carries returns nothing rather than everything. Unlike `limit`, the list
is not clamped: dropping a tag would widen the answer, so a clamp would return operations the
caller did not ask for.

Its `default` is `null` rather than `[]` in both SDKs. A C# parameter default has to be a
compile-time constant and `null` is the only one an array type has, so the NestJS shape publishes
the same `null` to keep the two schemas identical; both mean "no filter".

The result is a total and a list of compact cards:

```json
{
  "total": 8,
  "tags": ["billing", "orders"],
  "results": [
    {
      "name": "create_order",
      "description": "Creates a new order.",
      "parameters": "item: string (required), quantity: integer"
    },
    {
      "name": "get_order",
      "description": "Fetches one order by id.",
      "parameters": "id: integer (required)"
    }
  ]
}
```

`total` counts what the caller may see, before `limit` is applied. `tags` is the folded tag
vocabulary of that same visible set — the catalog, not the result set — so an agent that narrowed
to one tag still sees its siblings and can widen without an exploratory call. It is omitted when
the visible catalog carries no tags, and omitted rather than shortened when there are more than the
SDK will list, because a shortened list would say that a tag it left out does not exist. `parameters` is a one-line
rendering of the input schema's top level, not the schema — an agent that intends to call has to
`load_tool` first. Card descriptions are truncated at 160 characters on a word boundary.

A card gains `authUncertain: true` when visibility could not be resolved for that caller. The card
never carries policy names; see [visibility decision](/docs/http-catalog/visibility-decision).

### Schemas for the results you searched

With `detail: "schema"` each entry of `results` is exactly what `load_tool` would return for that
tool, so an agent that expects to invoke one of these results calls `invoke_tool` next. The two are
not interchangeable in intent: `detail: "schema"` answers _which of these matches do I want_, while
`load_tool` answers _what does this operation, whose name I already have, take_. Reach for
`load_tool` when you hold a name and have nothing to search for:

```json
{
  "total": 8,
  "results": [
    {
      "name": "get_order",
      "description": "Fetches one order by id.",
      "inputSchema": {
        "type": "object",
        "properties": { "id": { "type": "integer" } },
        "required": ["id"]
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "id": { "type": "integer" },
          "total": { "type": "number" }
        }
      },
      "annotations": { "readOnlyHint": true, "idempotentHint": true }
    }
  ]
}
```

It is a trade, not a free win: a page of schemas is far larger than a page of cards, and `detail`
changes nothing else — ranking, `limit`, `total` and visibility filtering are what they were. At
the default `limit` a schema page will usually exceed the response budget, and the refusal names
`detail` alongside `query` and `limit` so the next call can drop back to cards rather than only
shrink the page. `limit` keeps one meaning: no smaller cap applies in schema mode.

## `load_tool`

Takes `name`, exactly as `search_tools` returned it.

```json
{
  "name": "get_order",
  "description": "Fetches one order by id.",
  "inputSchema": {
    "type": "object",
    "properties": { "id": { "type": "integer", "description": "Order id" } },
    "required": ["id"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "id": { "type": "integer" },
      "item": { "type": "string" },
      "quantity": { "type": "integer" },
      "owner": { "type": "string" }
    },
    "required": ["id", "item", "quantity", "owner"]
  },
  "annotations": { "readOnlyHint": true, "idempotentHint": true },
  "version": "6361f59c4d6b968c"
}
```

`version` is a short fingerprint of everything above it except `authUncertain`. The same definition
gets the same `version` on every replica running the same build, and any change to what the agent
reads — the description, an argument, the output schema, a hint — gives a new one. Treat it as an
opaque string: it is meant to be passed back to `invoke_tool`, not parsed.
`search_tools` with `detail: "schema"` carries it too, because each of those results is the
`load_tool` answer.

`inputSchema` is always a flat object: path, query, header and body members are all top-level
arguments. How a backend type becomes that schema is
[schema conversion](/docs/http-catalog/schema-conversion).

`outputSchema` is what the call returns, so an agent can plan a chain of calls before making the
first one. It is present only when the endpoint declares a success body: the status codes `200`,
`201`, `202` and `204` are tried in that order, then the lowest remaining `2xx`, and a `204` or an
endpoint with no `2xx` at all publishes no `outputSchema`. A response whose root is not an object —
an array, a scalar — is wrapped as `{"type":"object","properties":{"result":…},"required":["result"]}`,
because MCP requires the root to be an object.

Unlike `inputSchema`, a response schema keeps read-only members: a get-only property is a response
field precisely because the server is the one that computes it. Curation does not reach
`outputSchema` either, so every variant of one operation publishes the same one. Where the
declaration comes from is
[telling the agent what a tool returns](/docs/http-catalog/tell-the-agent-what-a-tool-returns).

`annotations` carries only the hints that apply — the field is omitted rather than filled with
`false`. `load_tool` is subject to visibility: a tool the caller cannot see returns `unknown_tool`,
so a hidden tool and a nonexistent one are indistinguishable. `auth` is never included.

## `invoke_tool`

Takes `name` and `arguments`, an object whose keys are the input schema's properties. The call runs
through the backend's own pipeline with the caller's identity.

`arguments` is published with a description and no `type`, so a value that is not an object reaches
the SDK and comes back as an sezzlee envelope instead of a protocol error. Two shapes are accepted
anyway: `null` composes as `{}`, and a string that parses to a JSON object is unwrapped and composed
as that object, with the rewrite written to the server's log. Anything else — a string that is not
JSON, an array, a scalar — is `invalid_type`, and the message names the kind that arrived. The flag
stays `retryable: false`: it describes replaying the same call, not repairing it.

`version` is optional. Pass the `version` that `load_tool` returned, and the call runs only if the
replica that answers holds that same definition. During a rolling deploy an agent can load a tool
from a new replica and have the call answered by an old one; with `version` set, that call is
refused with `tool_changed` before it reaches your backend, and the agent loads the tool again.
Without `version`, nothing is checked. A name that does not exist is `unknown_tool` whatever
`version` says.

```json
{ "name": "get_order", "arguments": { "id": 1 }, "version": "6361f59c4d6b968c" }
```

Success returns the HTTP result:

```json
{
  "status": 200,
  "body": {
    "id": 1,
    "item": "mechanical keyboard",
    "quantity": 2,
    "owner": "alice"
  }
}
```

Failure returns an error envelope with `isError` set. Both layers of that are on
[invoke result envelope](/docs/http-catalog/invoke-result-envelope).

## The envelope every result shares

Results are always JSON serialized into a **single text content block**:

```ts
const payload = JSON.parse(result.content[0].text);
```

There is no `structuredContent` and no multi-block result. `isError` is `true` on failure and
**absent** on success — test it for truthiness, not for `false`.

## Sessions

The transport is Streamable HTTP and there are no sessions: protocol revision `2026-07-28` removed
them along with the `Mcp-Session-Id` header, so every request is served on its own and `GET` and
`DELETE` are answered with `405`. There is no session-mode option on either SDK.

A 2025-era client is still served, per request, through the same endpoint. What it does not get is a
server-to-client channel: catalogue changes reach a `2026-07-28` client that opened a
`subscriptions/listen` stream, and nothing is sent to a client that opened none.
