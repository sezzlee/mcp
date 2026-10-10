# Search Semantics

> Status: **normative** — validated by two independent implementations (ASP.NET `ToolIndex` + TS `search.ts`; the compact card by the `card/` corpus, the loaded shape by the `detail/` corpus, and the three meta-tools publish the same argument set, types and defaults in both frameworks).

What the two frameworks owe each other is that argument set and every answer's shape. The key order of a published input schema, and the JSON Schema dialect decoration around it (`$schema`, the numeric bounds a generator writes for an integer), are framework detail and are not part of this contract.

Defines the three meta-tools of search-first discovery and the ranking rules of `search_tools`. The machine-readable counterpart is the `search` fixture kind in [schemas/fixture.schema.json](schemas/fixture.schema.json); the corpus is [conformance/search/](../conformance/search/).

## Why search-first

`tools/list` returns only the three meta-tools. Hundreds of endpoints MUST NEVER enter the agent's context all at once; the agent searches, loads the schema of what it found, then calls. Because the list almost never changes there is no client cache problem; what varies is the search results, and those are fresh every time.

## Meta-tool contract

| Tool           | Input                                                                                                                                       | Output                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `search_tools` | `query: string` (may be empty), `limit: int` (1-50, default 20), `detail: "card" \| "schema"` (default `card`), `tags: string[]` (optional) | `{ total, tags?, results: Card[] }` or `{ total, tags?, results: ToolDetail[] }` |
| `load_tool`    | `name: string`                                                                                                                              | `ToolDetail` — `{ name, description, inputSchema, outputSchema?, annotations }`  |
| `invoke_tool`  | `name: string`, `arguments: object`                                                                                                         | `InvokeSuccess`, or `CallToolResult.isError = true` + `MappedError`/`SdkError`   |

- In `search_tools` an empty query means **list**: every tool, ordinal sorted by name, up to `limit`. There is no separate `list` tool.
- `tags` narrows the result and never reorders it. It is a filter over a closed vocabulary, not a query term, and it is matched whole rather than tokenized: [Filtering by tag](#filtering-by-tag).
- `search_tools` output carries `tags`: the folded tag vocabulary of the tools this caller may see, deduplicated and ordered by code point. It describes the same population `total` counts — the visible catalog, not the result set — so a caller that narrowed to one tag can still see the others and widen without an exploratory call. It is omitted when that population carries no tags, and omitted rather than truncated when it carries more than an implementation's vocabulary budget: a shortened list would tell an agent that a tag it cannot see does not exist.
- `detail` selects the shape of each entry in `results`: `card` is the compact card, `schema` makes every entry **identical to the `load_tool` answer for that tool**, so an agent that will invoke one of the results immediately spends no turn loading it. It is a projection of the _search results_; an agent that already holds an exact name calls `load_tool` rather than searching for the name it has. Any value other than `schema` — absent, empty, unrecognised, or differing in case — is `card`; the comparison is exact. `detail` constrains the projection and nothing else: ranking, `limit`, `total` and the visibility filter are unaffected, and `authUncertain` appears in either shape. Falling back to `card` is not a silent resolution in the sense [naming.md](naming.md) forbids: that rule is about the catalog, where two endpoints claim one name and a winner would be invented; `detail` is one caller's argument with a declared default, clamped the way `limit` is.
- `load_tool` output does **not** contain `auth` — [visibility.md](visibility.md) invariant 3: policy names MUST NOT leak to the agent. `load_tool` is subject to the visibility filter: for a hidden tool, its answer is identical to the answer for a nonexistent tool.
- `load_tool` carries `outputSchema` only when the endpoint declares a success body
  ([metadata-contract.md](metadata-contract.md)). The compact card does not carry it: the card's
  budget is what keeps a large result set readable, and the schema is one turn away — or none, at the
  agent's choice and its context's expense (`detail`, above).
- In `search_tools` and `load_tool` output, `deprecated: true` marks a deprecated operation, on the card and on the loaded shape alike; `authUncertain: true` says the decision was `unknown`; `total` is the number of tools the declarative layer counted as visible (see below).
- `load_tool`'s answer, and each result under `detail: "schema"`, carries `version` next to the loaded shape; `invoke_tool` accepts it back as an optional `version` string and refuses a call whose version no longer matches with `tool_changed` ([invoke-semantics.md](invoke-semantics.md), "The tool version"). `version` is not a member of the loaded shape: it is derived from it.
- `invoke_tool` takes `name` and `arguments`, both required. `arguments` is published with a description and **no `type`**, on purpose and identically in both frameworks: the argument accepts raw JSON so that a value which is not an object reaches the SDK and comes back as an `invalid_type` envelope ([error-mapping.md](error-mapping.md)). A schema that constrained it to an object would be rejected during the transport's own argument binding, and the caller would get a protocol error carrying neither the envelope nor the leak filter.
- Before composing, `invoke_tool` normalizes the value it received, in two cases and no others. `null` is absence and composes as `{}`: composition only enumerates properties, so no operation can tell the two apart. A **string that parses to a JSON object** composes as that object, and the implementation MUST report the rewrite on a host channel of its own — a log, never the answer. A caller that sends JSON text where an object belongs is defective, and accepting it in silence would let a client double-encode every call unnoticed. Everything else is left alone: a string that is not a JSON object, an array, a number and a boolean still reach the composer and come back as `invalid_type`, whose message names the kind that arrived. All of them keep `retryable: false` — the flag means "this same call may succeed later" ([error-mapping.md](error-mapping.md)), and a call with repaired arguments is a different call.
- A meta-tool argument the caller misnames or omits MUST come back as an `unknown_argument` envelope naming the argument the tool does take. The framework's own binder rejects such a call before the handler, and what it produces is not an sezzlee envelope: it is not JSON the agent can parse, it never passes the leak filter, and it names nothing to repair. Implementations therefore bind these arguments permissively and check them themselves. **What is published MUST NOT change for it**: `name` stays a required string in both frameworks, and the permissive runtime type is invisible to the agent.
- `invoke_tool` MUST NOT consult the visibility filter ([visibility.md](visibility.md) invariant 1); enforcement is in the real pipeline. The result envelope and the error codes (the backend's HTTP errors, the SDK-side `unknown_tool`/`not_invocable`, and the argument codes from [argument-mapping.md](argument-mapping.md)) are normative in [error-mapping.md](error-mapping.md).
- **Every** meta-tool answer passes the payload budget before it is emitted, and `invoke_tool` runs under a deadline: [invoke-semantics.md](invoke-semantics.md). An over-budget `search_tools` answer names `query`, `limit`, `detail` and `tags` as its narrowing arguments; an over-budget `load_tool` answer has none to name. `detail: "schema"` at the default `limit` will often exceed the budget, and the refusal names `detail` so the agent can fall back to cards rather than only shrinking the page. No separate limit applies in schema mode: an implementation MUST NOT reinterpret `limit` according to `detail`. A `limit` that meant twenty cards or five schemas depending on another argument could not be read without counting.
- The meta-tools' own descriptions are in English; that is the SDK's language, not the backend's.

## The compact card

```json
{
  "name": "get_order",
  "description": "Fetches one order by id.",
  "parameters": "id: integer (required)"
}
```

- `description`: the tool description; if it exceeds 160 characters it is cut at the last space and `…` is appended. If the cut point falls before half the budget, no word boundary is awaited.
- `parameters`: built from `inputSchema.properties` as `name: type`, with ` (required)` appended for entries in the `required` list; when there is no `type` (or a type union has no non-null member) it is `any`. Joined with a comma and a space. The full schema is in `load_tool`.
- Like the `parameters` search field, the summary is defined over arbitrary JSON, because `inputSchema` may be a host-supplied verbatim schema: a missing, null or non-object `properties` yields an empty summary; a non-object member is named with the type `any`; a `required` that is not an array of strings marks nothing; and a type union names its first **string** member that is not `null`, skipping any other value. Each unusable shape contributes nothing rather than failing — a malformed member MUST NOT fail the `search_tools` call, which would cost the whole catalog its discovery over one tool.
- Summary order: **integer-like property names first, in ascending numeric order; then the rest in declaration order.** The order rule is normative and matches ECMAScript's object key ordering — in JS, integer-like keys are already hoisted to the front when an object is constructed and declaration order cannot be recovered, so the rule itself has to be this order. The machine-readable counterpart is the `card` fixture kind in [schemas/fixture.schema.json](schemas/fixture.schema.json).

## The loaded shape

```json
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
    "properties": { "id": { "type": "integer" }, "total": { "type": "number" } }
  },
  "annotations": { "readOnlyHint": true, "idempotentHint": true }
}
```

- `description` is carried verbatim. The 160-character budget belongs to the card; this shape has none.
- `inputSchema` is the **published** schema, that is, the schema after argument curation ([argument-curation.md](argument-curation.md)) — the same schema the `parameters` search field is projected from.
- `outputSchema` is present only when the endpoint declares a success body ([metadata-contract.md](metadata-contract.md)); the key is omitted rather than written as null.
- `annotations` carries only the hints that apply to the method. An absent hint MUST NOT be filled in with `false`.
- `auth` is never a member ([visibility.md](visibility.md) invariant 3), and `authUncertain: true` is added for an `unknown` decision exactly as on the card.
- `load_tool` and `search_tools` with `detail: "schema"` MUST produce the identical object for the same tool and the same visibility decision. One projection serves both; its machine-readable counterpart is the `detail` fixture kind in [schemas/fixture.schema.json](schemas/fixture.schema.json), and the corpus is [conformance/detail/](../conformance/detail/).

## Tokenization

The query and the document go through the same process:

1. Every character that is not a letter or a digit is a separator (Unicode; letters from any language are part of a word).
2. An intra-word uppercase boundary is a separator — the same rule as snake_case in [naming.md](naming.md): when the preceding character is lowercase, or the preceding is uppercase **and** the next is lowercase. `GetPortalPresence` → `get`, `portal`, `presence`; `getQRDetails` → `get`, `qr`, `details`.
3. Tokens are **folded**: NFD decomposition → dropping combining marks (`\p{Mn}`) → lowercasing → NFC recomposition. In that order, and on the token as a whole rather than character by character.
4. Tokens shorter than 2 characters are dropped.
5. A token longer than 3 characters and ending in `s` loses that trailing `s` (`orders` → `order`, `notes` → `note`). There is no other stemming.

### Why folding, and its limit

Rule 3 in its "everything is lowercased" form did not say which lowercasing algorithm to use, and the two implementations diverged silently: JS `toLowerCase` does full case mapping and expands `İ` into `i` + U+0307, while .NET `char.ToLowerInvariant` does simple mapping and produced `i`. A description containing `İSTANBUL` did not match the query `istanbul` in TS but did in C# — and both conformed to the old rule.

With NFD applied first, `İ` already decomposes into `I` + U+0307, the combining mark is dropped, and what remains is an `I` that both sides lowercase identically. Accents fall away in the same step (`sipariş` → `siparis`), which strengthens prefix matching in agglutinative languages.

Greek final sigma is the same class of divergence and NFD does not reach it, so folding names it explicitly: after lowercasing, `ς` (U+03C2) becomes `σ` (U+03C3). Greek writes one uppercase sigma and two lowercase ones — medial `σ` and final `ς` — so lowercasing `Σ` is a decision about position rather than about the character, and the two runtimes decide differently: JavaScript's `toLowerCase` applies Unicode's conditional Final_Sigma rule while .NET's invariant lowercasing does not, which indexed `ΟΔΟΣ` as `οδος` on one side and `οδοσ` on the other. Neither sigma decomposes, so unlike `İ` there is no mark for NFD to strip. The direction is Unicode's own (`CaseFolding.txt` maps `03C2` to `03C3`), and it means the two spellings of one word are one term: `ΟΔΟΣ`, `οδος` and `οδοσ` all index and match alike. Pinned by `final-sigma-folds-to-medial-sigma.json` and `tag-filter-folds-final-sigma.json`.

Folding is **language-independent**; there is no Turkish-specific mapping table. Its deliberate limit: the dotless `ı` stays distinct from `i`, and `ß` does not expand to `ss` — because .NET's invariant uppercase table does not convert those two characters, extending the folding there would make the two SDKs diverge. The limit is pinned by the `dotless-i-stays-distinct.json` fixture.

The tag filter folds by this same step and inherits the same limit, which is why it is stated as step 3 rather than as a rule of its own. What it does not inherit is the rest of tokenization, and it does not trim: whitespace is part of a tag, because a trim would have to be the same trim in both implementations and would not be — JavaScript's `String.prototype.trim` strips U+FEFF and .NET's `string.Trim` does not. For the same reason a host's declared tag is dropped only when it folds to the empty string; a tag that is only whitespace is a legal, matchable tag.

## Matching: prefix

If a query token is **at least 3 characters**, it matches when it is a prefix of a document token; a document's `tf` is the summed frequency of every prefix-matching document token, and `df` is the number of documents carrying at least one prefix match. Shorter query tokens match exactly only (`id` does not match `identity`).

The rationale is agglutinative languages. In Turkish descriptions, `siparişi`, `siparişe` and `siparişler` are the same concept; stemming requires grammar, prefix matching does not. In English, `order` → `ordering`, `orders` is naturally covered too. The converse is not covered: if the query is longer than the document token (`siparişleri` vs `siparişi`) there is no match — keeping the query short is the agent's job, and the meta-tool description says so.

## Fields and weights

| Field             | Weight |
| ----------------- | ------ |
| `name`            | 3.0    |
| `description`     | 1.5    |
| `searchTerms`     | 1.5    |
| `tags`            | 1.0    |
| `route`           | 1.0    |
| `alternateRoutes` | 1.0    |
| `parameters`      | 1.0    |

`tags` carries the operation's grouping labels ([metadata-contract.md](metadata-contract.md)). It is read twice, and the two readings are independent. As an index field it is tokenized like every other field, so the tag `Orders` contributes the token `order` and a query for `order` ranks the tool. As a `search_tools` filter key it is **not** tokenized and is compared whole ([Filtering by tag](#filtering-by-tag)). A host that declares tags is therefore editing the search index as well as the browsing vocabulary: replacing `Orders` with `billing` removes `order` as a matching term for every tool in that container, and lengthens the document, which lowers every other term's score on it.

`searchTerms` carries the host's declared search vocabulary ([metadata-contract.md](metadata-contract.md)): words an agent may type that the operation's own text does not contain, such as a synonym, a business term or a second language. It is tokenized like every other field, at the description's weight, because it is text a person chose to describe the operation with; the name still outweighs it. Unlike `tags` it is read **once**: it is never a filter key, never part of the `tags` vocabulary of a `search_tools` answer, and never shown on the card or the loaded shape. An agent cannot see why a term matched, which is the point: the vocabulary exists for the ranker, not for the reader.

`alternateRoutes` carries the routes that were folded away when one operation was bound to several ([naming.md](naming.md)). They are tokenized at the same weight as `route` so a query naming a compatibility path still finds the tool; the tool's own contract still names the single route it invokes.

`parameters` carries the argument vocabulary: for each entry of the tool's **root** `inputSchema.properties`, the property key and, when it carries one, that property's `description`. The two are independent entries and MUST NOT be concatenated — a joined string is tokenized differently from its parts whenever the join point falls inside a word (`ORDER` + `id` yields `order`, `id`, but `ORDERid` yields `orde`, `rid`), so the separator would become a silent part of the contract. Both go into one field at one weight, because an agent searching `customerId` cannot know whether the term it remembers is a name or a phrase from a description.

The depth is deliberately the root object only: no recursion into nested members, no `$ref` or `$defs` resolution. The one exception is a root property the descriptor declared `deepObject` ([argument-mapping.md](argument-mapping.md)): it is a group of addressable query filters folded into one argument, so each member key is indexed as `group.member`, one level down and no further. A nested body object is not an exception, because its members are not addressable filters. That is exactly the key set the compact card names, so what a search matched is what the card will show; going deeper would require a resolver whose reachability and cycle rules two independent implementations would not agree on, and the divergence would be invisible to the reader of a result.

Since `inputSchema` may be a host-supplied verbatim schema that no validator has seen, the projection is defined over arbitrary JSON: a missing, null or non-object `properties` contributes nothing; a non-object member contributes its key alone; a non-string `description` contributes nothing. Each of these contributes nothing rather than failing, in both implementations.

The source is the **published** schema, that is, the schema after argument curation ([argument-curation.md](argument-curation.md)). A hidden argument has no `properties` entry, so its name is structurally absent from the index — no filtering step is involved in `parameters`, and none may be added there. (The `tags` argument of `search_tools` is a filter, but it selects whole documents by a declared key and never removes a term from one; the two are unrelated.) A renamed argument is indexed under its agent name (`as`) alone; its wire name is not a search term. This is narrower than `route`, which still carries a hidden path parameter's wire name: curation withholds a slot, not a vocabulary, and the route is where that remains true. The members of a family are separate documents sharing one route; how that route ranks them, and why a member's key is never a term, is pinned in [tool-families.md](tool-families.md) §Search.

The order in which `parameters` entries are produced is unspecified, and unobservable: `tf`, `df` and document length are all sums over an unordered multiset, and every weight and partial sum is an exact binary fraction, so no ordering of the contributions can change a score. Implementations MUST NOT add an ordering rule for this field. The invariant holds only while the projection stays order-insensitive — introducing any length budget or truncation on `parameters` would make order observable and would have to be pinned here first.

A document's term frequency is the sum of the weights of every field the term occurs in (`tf`). Document length is the sum of all `tf` values; average length is taken over the documents.

## Scoring

BM25 with `k1 = 1.2`, `b = 0.75`:

```text
idf(t)     = ln(1 + (N − df(t) + 0.5) / (df(t) + 0.5))
norm(t, d) = tf · (k1 + 1) / (tf + k1 · (1 − b + b · len(d) / avgLen))
score(q,d) = Σ_{t ∈ q} idf(t) · norm(t, d)
```

`N` is the document count and `df(t)` is the number of documents containing the term. A document scoring zero does not appear in the result. Ordering: score descending, and on a tie name ordinal ascending. Returns up to `limit`.

There is no heavy dependency; the formula is ten lines in any language and is fixed so it can be matched exactly by fixtures. The SDK ships no synonyms, language models or embeddings. A host that has them binds a ranker of its own ([Replaceable ranker](#replaceable-ranker)); declared vocabulary that needs no model belongs in `searchTerms`.

## Filtering by tag

`search_tools` takes an optional `tags` argument: the tags a tool must carry to appear in the result. It changes which tools come back, never the order they come back in.

**Matching is folded equality over the whole tag.** The requested tag and the document's tag each go through folding — step 3 of [Tokenization](#tokenization) — and must then be equal, character for character. Nothing else in tokenization applies: no separator splitting, no intra-word uppercase boundary, no minimum length, no trailing `s`. A tag is one opaque string, whatever is inside it. So `orders` matches `Orders` and `ORDERS`, and `siparis` matches `Sipariş`; but `order` matches neither `Orders` nor `OrderItems`, and `order items` matches `Order Items` and not `OrderItems`. Prefix matching, which the query gets, is deliberately absent: a filter that grew its own matching rule would be a second ranker with none of the ranker's fixtures.

**Every requested tag must be present.** The filter is a conjunction: a tool survives only if it carries a folded tag equal to _every_ entry of `tags`. Order within `tags` is irrelevant and a repeated entry changes nothing. An absent `tags`, or an empty one, filters nothing — an empty conjunction is vacuously true, and implementations MUST reach that result through the semantics rather than by special-casing the empty list. A requested tag that no tool carries yields an empty result: not an error, and not an unfiltered result, because an agent that guessed a tag MUST be able to see that its guess found nothing.

**The filter runs after scoring and before `limit`.** `N`, `df(t)` and `avgLen` are taken over the whole visible corpus, exactly as they are without a filter; the filter is then applied to the ranked list; only then is the list cut to `limit`. Two consequences are normative:

- A `tags` filter never changes the relative order of the tools that survive it. Adding a tag can only remove rows; it can never move one row above another. This is why `df` is not recomputed over the survivors: a filtered `df` would raise the idf of every term the removed documents carried, and the same two tools would come back in a different order for no reason the agent can see.
- Because the cut happens last, `limit` counts survivors. With `limit: 1`, a filter whose only survivor ranked third still returns that tool; it does not return nothing because the top row was filtered away.

The empty-query list mode is filtered too: an empty `query` with a `tags` filter lists every tool carrying those tags, ordinal sorted by name, up to `limit`. That branch does not score, so there is nothing for the filter to reorder; the cut is still last, so the listing walks past the tools the filter removed rather than truncating first.

`total` is unchanged by the filter, for the same reason it does not depend on `limit`: it is the number of tools the declarative layer counted as visible ([Known limits](#known-limits)), not the number that matched.

## Replaceable ranker

A host MAY bind a ranker of its own — a vector index, an embedding retriever, a search service it already runs — in place of the BM25 ranking above. The ranker replaces **one step**: turning a non-empty query into an ordered list of tool names. Everything before and after that step is unchanged and stays in the SDK, because every guarantee of this document and of [visibility.md](visibility.md) lives there.

**What the ranker receives.** The query text as the caller sent it, and the catalog as a list of documents, one per tool, carrying exactly the index fields of [Fields and weights](#fields-and-weights): `name`, `description`, `tags`, `searchTerms`, `route`, `alternateRoutes` and `parameters`, the last one projected from the **published** schema. A hidden argument therefore never reaches the ranker, for the same structural reason it never reaches the index. The catalog carries a `version` that changes whenever the catalog is rebuilt, so a ranker that embeds documents ahead of time knows when to embed them again. The ranker MUST NOT receive the caller's identity, scope or policy results: a ranker that could see the caller would be the natural place to put an authorization rule, and search filtering is not a security mechanism ([visibility.md](visibility.md)). The ranker sees the whole catalog, including tools this caller may not see, exactly as BM25 scores the whole corpus; visibility is applied to its answer.

**When it runs.** Only for a query that yields at least one token ([Tokenization](#tokenization)). A query that yields none is the list mode and never reaches the ranker, bound or not: a listing is ordinal by name and has nothing to rank, and deciding the mode by one predicate for both rankers keeps a query from being a listing under one and a search under the other.

**What it answers.** An ordered list of tool names, most relevant first. A tool it leaves out does not appear in the result — the ranker decides relevance, as a zero BM25 score does — so an empty list is an empty result, not a failure. The SDK then normalizes the answer, and reports each correction on a host channel of its own, never in the answer:

- a name that is not in the catalog is dropped;
- a name that appears again is dropped, and the first position is kept;
- the `tags` filter is applied to what remains, preserving its order ([Filtering by tag](#filtering-by-tag): a filter removes rows and never moves one);
- visibility, the T2 probe, the card or loaded shape, `limit`, `total`, the answer's `tags` vocabulary and the payload budget follow exactly as they do after BM25.

`total` is independent of the ranker for the reason it is independent of `limit`.

**When it fails.** The ranker runs under a deadline of its own, set by the host; zero means none. The default is 10000 ms, and a deadline at or above 60000 ms is unreachable through a stock MCP client for the reason given in [invoke-semantics.md](invoke-semantics.md). The ranker has failed when the deadline expires, when it throws, or when its answer is not a list of strings. What happens next is a host setting with two values:

- `fallback` (the default): the SDK ranks the query with BM25 instead and answers normally, and reports the failure and its reason on its host channel. An agent's discovery does not stop because one retriever did.
- `error`: `search_tools` answers `search_ranker_unavailable`, with `retryable: true` and the standard message

  ```
  Search is unavailable: the ranker did not answer this query. Call search_tools again later.
  ```

The caller's own cancellation is not a ranker failure: it is propagated as cancellation and never falls back or produces `search_ranker_unavailable`, because nobody is left to read either answer.

**What conformance covers.** The order a host's ranker produces is the host's, and no fixture binds it. The normalization around it is the SDK's, and the `ranked-search` fixture kind pins it: given a catalog, a query, a `tags` filter and a ranker's answer verbatim, it fixes the resulting names, whether the answer was rejected, and which names were dropped as unknown or repeated.

## Known limits

- Stemming is only the English plural `s`; other suffixes are handled by prefix matching, and there is no dictionary or language model. The description language is the backend's language; heavy stemming would introduce a language dependency into the SDK.
- A tool with a large documented `inputSchema` carries a long document, and BM25's length normalisation (`b = 0.75`) lowers every one of its terms, including the ones from its name. A wide operation therefore ranks below a narrow one that matches equally well. This is the same effect a long `description` already has. Capping `parameters` was considered and rejected: the cap would be an arbitrary constant two implementations must agree on, and the cut point would itself have to be normative. Narrowing the surface an agent sees is curation's job ([argument-curation.md](argument-curation.md)), not the ranker's.
- A schema-mode page is bounded by the payload budget alone. Raising `limit` in schema mode is the agent's trade to make and the refusal tells it what it cost; the SDK does not make that trade on its behalf.
- A tag filter is exact where the query is prefix-matched, and the asymmetry is deliberate. The query is text the agent half-remembers; a tag is a key it read back out of a previous answer. A prefix-matching filter would make `order` select `Orders` and `OrderItems` together with no way to ask for only one of them.
- Two tags that differ only in case or in combining marks (`Orders`, `ORDERS`, `Ordérs`) are one tag to the filter and two strings in the host's declaration. An SDK folds the collision rather than rejecting it, and reports it; a host that needs the two distinguishable has to make them differ after folding.
- `total` is the number of tools **the declarative layer** counted as visible; the T2 probe does not change it ([visibility.md](visibility.md), T2 "Budget"). Because the probe runs only on the first K candidates after ranking, a probe-aware `total` would depend on `limit` and would be misleading.
