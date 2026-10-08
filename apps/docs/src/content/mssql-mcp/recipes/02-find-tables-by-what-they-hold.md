# Find tables by what they hold

`search_catalog` finds tables and views from a description of what you need, so an agent can work in
a database whose names it has never seen. Search by words, narrow by name or schema, and page through
a large catalogue.

Uses the `sql` helper from the [Quickstart](/docs/mssql-mcp/quickstart#see-what-the-agent-receives)
on the `sezzlee_shop` sample schema.

## Search with words

`query` is a few words. Each is matched against schema, table, view and column names, and against the
descriptions stored with them as `MS_Description` extended properties:

```sh
sql search_catalog --tool-arg query=revenue schema=sezzlee_shop \
  | jq -c '.results[] | {name, kind, matched}'
```

```json
{"name":"order_totals","kind":"view","matched":[{"field":"description","term":"revenue","value":"Revenue per order, summed from its lines."}]}
```

Nothing is named "revenue"; the view's description says it. Descriptions are how a catalogue with
cryptic names becomes searchable, so it pays to write them.

A word also matches names that begin with it, and case and accents are ignored:

```sh
sql search_catalog --tool-arg query=SHIPP schema=sezzlee_shop \
  | jq -c '.results[] | {name, matched: [.matched[] | "\(.field): \(.value)"]}'
```

```json
{"name":"orders","matched":["description: One row per purchase; status is pending, shipped or cancelled.","column: shipped_at","columnDescription: shipped_at"]}
```

Only the beginning of a word is matched, never the middle: `ship` finds `shipped_at`, but `date` does
not find `ordered_on`, and `tarih` does not find `FATURATARIH`. The search reads names and
descriptions, not rows. To find which table holds a given customer, search for `customer`, then query
it.

## Narrow by schema, name or kind

`schema` keeps one schema, `namePattern` is a `LIKE` pattern on the object's name, and
`includeViews=false` leaves views out. With no `query`, the matches are listed by name:

```sh
sql search_catalog --tool-arg schema=sezzlee_shop namePattern="order%" \
  | jq -c '[.results[] | {name, kind}]'
```

```json
[{"name":"order_lines","kind":"table"},{"name":"order_totals","kind":"view"},{"name":"orders","kind":"table"}]
```

## Page through many results

`maxResults` caps one answer, 50 by default and 200 at most. When more remain, `truncated` is `true`
and `nextCursor` continues with the same filters:

```sh
sql search_catalog --tool-arg schema=sezzlee_shop maxResults=2 \
  | jq -c '{names: [.results[].name], truncated}'
```

```json
{"names":["customers","ledger"],"truncated":true}
```

Pass `nextCursor` back with the same `query`, `schema`, `namePattern` and `includeViews`; a cursor
passed with other ones fails with `stale_cursor`.

## After a schema change, or on a large catalogue

The server reads the catalogue once and reuses it for 15 minutes. A table created since then is not
found until the copy expires, or until a search passes `refresh=true`, which reads the catalogue
again and makes earlier cursors stale.

Each answer carries a `catalog` block. Its `complete` is `false` when the database has more than
5,000 tables and views or 50,000 columns, the most the search index holds. A search that finds
nothing may then have missed an object past the cut. `describe_table` still reads any table whose
name you already know.

:::details[Why the search matches word starts and ranks by rarity]

The server indexes names and descriptions as words: `shipped_at` becomes `shipped` and `at`, and
`OrderLines` is filed under `orderlines`, `order` and `lines`. Case and accents are folded. The index
covers only what the login can see.

Each query word is looked up exactly and as the start of longer words, with an exact match counting
twice. A match counts for more when the word is rare in this catalogue, and for more in an object's
own name than in a column name or a description. Every result lists what matched, so the agent can
see why a table was offered.

Matching the middle of words would make every short query match half the catalogue. Synonyms are not
known, so `client` does not find `customer`; a description that uses both words answers both. A
column match lifts its table instead of returning columns, so one word cannot bury the tables. On an
oversized catalogue a table cut in the middle is dropped whole, because a half-indexed table would
answer a search for a missing column with silence.

:::
