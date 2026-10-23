# Help an agent find the right tool

`search_tools` ranks with BM25 over each operation's name, description, route, arguments and tags. When the agent's words are not in that text, you have three levers: tags to browse by, search terms for extra vocabulary, and your own ranker. Try them in that order.

## Group operations with tags

Every operation already carries the tags `@nestjs/swagger` gives it: the controller's `@ApiTags` followed by the handler's, or, for a controller with no `@ApiTags`, its class name minus the `Controller` suffix. A class name follows your code layout, not the job the agent is doing. Declare your own:

```ts
@Get("orders")
@McpTool({ name: "find_orders", tags: ["billing", "read"] })
list(@Query() query: ListOrdersQuery) { ... }
```

Declare on the class to cover every operation in it. The nearer declaration wins. A declaration replaces the derived tag instead of adding to it, so write the container name out if you want it too.

For containers you cannot decorate, declare a rule centrally. Returning null or `undefined` means no rule here, and the derived tag stands:

```ts
SezzleeModule.forRoot((options) => {
  options.tags = (container) =>
    container.includes("Billing") ? ["billing"] : undefined;
});
```

Every `search_tools` answer carries a `tags` field, the vocabulary of what that caller may see. The agent reads a tag from there and sends it back:

```json
{ "query": "", "tags": ["billing"] }
```

The filter is a conjunction and narrows without reordering. Matching is on the whole tag, ignoring case and accents: `billing` finds `Billing`, but `bill` finds neither. Two tags that differ only in case are one tag, and the SDK reports `duplicate_tag`.

## Add search terms

`searchTerms` is extra vocabulary for words the operation does not contain, such as a synonym, a business term or a second language. It is indexed like the description and never shown to the agent: not on the card, not in `load_tool`, not in `tags`.

```ts
@Get()
@McpTool({
  name: "declares_terms",
  description: "Creates a purchase.",
  searchTerms: ["sipariş", "satın alma"],
})
create(): void {}
```

Declaration works as it does for tags: the method wins over the class, and `options.searchTerms` is the central rule. Unlike tags there is no default. Two terms that fold alike are reported as `duplicate_search_term` and the second is dropped.

## Replace the ranking

If you already run a retriever, such as a vector index or an embedding service, bind it as the ranker. It receives the query and the catalog and returns tool names, most relevant first. This example binds a ranker that answers a fixed list, as the SDK's own tests do. Yours calls your retriever there.

```ts
const ranker: ToolRanker = {
  rank: async () => ["audit_log", "list_orders", "get_order"],
};

SezzleeModule.forRoot(
  (options) => {
    options.search.rankerTimeoutMs = 20;
  },
  { toolRanker: { useValue: ranker } },
);
```

`useClass` and `useFactory` work as for every other extension point. Your controller does not change.

The ranker decides order and relevance. Everything else stays in the SDK:

- A tool the caller may not see is removed from its answer, so a ranker cannot leak one.
- A name that is not in the catalog is dropped, and a repeated name keeps its first position.
- The `tags` filter, `limit`, `total` and the payload budget apply as usual.

The ranker receives documents projected from the published schemas, so a hidden argument never reaches it. It does not receive the caller's identity. An empty query is a listing and never reaches the ranker. `catalog.version` changes whenever the catalog is rebuilt, so re-embed when it changes.

:::details[If the ranker fails]

The ranker runs under its own deadline: 10 seconds by default, zero for none. Past 60 seconds a stock MCP client gives up first. A missed deadline, a throw, or an answer that is not a list of names is a failure. `options.Search.OnRankerFailure` or `options.search.onRankerFailure` decides what happens next:

| Setting              | What the agent gets                                                   |
| -------------------- | --------------------------------------------------------------------- |
| `fallback` (default) | A normal answer ranked by BM25. The failure is logged on the host     |
| `error`              | `search_ranker_unavailable`, `retryable: true`. Nothing else is shown |

If the caller cancels, that is not a failure. The call stops with no fallback and no error.

:::

:::details[Why tags change search]

Tags are search text as well as filter keys. Replacing `Orders` with `billing` removes `order` as a matching term for every operation in that container, so a query of `orders` that used to rank them stops doing so. It also lengthens each document, which lowers every other term's score slightly. Pick tags an agent would plausibly type, and keep them short. For vocabulary that should match but is not a grouping, use search terms.

:::
