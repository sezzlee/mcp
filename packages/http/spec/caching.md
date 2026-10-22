# Caching

> Status: **partly normative.** Key derivation (`digestInput`), namespacing, absolute TTL plus
> negative jitter, the LRU bound, the `_disabled` rule and the in-flight rule are implemented by TS
> `MemorySezzleeCache` + Nest `CallerVisibilityProvider`. **Still one-sided:** the shared-store
> guarantees in the "Distributed deployment" section (per-scope grouped storage, tag → scope set,
> O(1) `clear`) are not implemented — that section is a contract draft for a host writing an adapter,
> not a validated rule.

Caches the two values recomputed over and over during `search_tools`/`load_tool` — the caller's identity facts and the T2 probe verdict — per caller. There is no machine-readable counterpart (this is timing and state behaviour, not a data transformation); validation is by unit tests.

## Scope

Cached per caller scope:

- **`facts`** — the T1 declarative tier's `CallerFacts` (identity `present`/`absent`/`unknown` plus policy results). Today this is recomputed on every search by running the backend's own authentication plus N policy evaluations ([visibility.md](visibility.md), "The platform side").
- **`probe:<toolName>`** — only the T2 probe's `allow`/`deny` verdict (`unknown` is not cached; the probe is not retried anyway — [visibility.md](visibility.md), T2 mechanics).

**Not cached:** tool definitions and the BM25 index (a global, caller-independent snapshot that is already memoized) and the `(caller, query, limit)` result lists themselves (ranking is already sub-millisecond, and caching the result list would needlessly enlarge the invalidation surface). Layering: search always works as `rank(global snapshot) ∩ overlay(caller)`, and `total` semantics do not change.

**Invariant:** the cache is read only under `search_tools`/`load_tool`. **`invoke_tool` MUST NEVER consult the cache** — enforcement is always in the real pipeline ([visibility.md](visibility.md) invariant 1). A cache failure is always a miss; no read failure ever drops a request.

## The key

The cache is keyed by `CallerScope(Key, Tags)`:

- **`Key`** — a 64-character lowercase-hex SHA-256 digest. The digest's input is fixed by this spec: the declared identity carriers are ordinal sorted by their lowercase names, and each is written as a `lowercase(name)=value\n` line (multi-valued headers are joined with `,`; a carrier absent from the outer request leaves its line empty). This digest input (`digestInput`) is public and pure — a host can wrap it and add its own tag.
- Carrier values are **never stored in plain text anywhere** — only the hashed `Key` is stored and logged.
- **`Tags`** — the default resolver produces no tags. Targeted invalidation tags such as `user:42` or `tenant:7` are the host's business (see below). The format is `kind:value` with no whitespace; `Key` contains no `:` (Redis segment safety).

The same carriers produce the same `Key` → they share the same cache entry; a different caller gets a different `Key`. Mechanically this is the generalized form of the "carrier digest plus tool name" principle the T2 probe already used.

## Namespacing

Every key is serialized as `sezzlee:v1:{scope}:{kind}[:{subkey}]` (`{scope}` = `CallerScope.Key`, `{kind}` = `facts` or `probe`, `{subkey}` = the tool name for `probe`, absent for `facts`). The version prefix (`v1`) prevents old entries from being silently misinterpreted when the encoding changes.

## Lifetime

- The lifetime is **absolute from the scope's first write** (not sliding) — this is the upper bound on the accepted staleness.
- On every `set` the SDK applies **up to 10% negative jitter** to the lifetime: actual expiry may be slightly earlier than the declared `lifetimeMs`, never later. The purpose is to break synchronized expiry in a distributed store (multiple instances); the promised upper staleness bound is never exceeded.
- `lifetimeMs == 0` → the cache is fully disabled: `get`/`set` are never called and every request recomputes.
- When `maxCallers` is exceeded, the **least recently used** scope is evicted; eviction is evaluated only **when a new scope is admitted**, not on every write.

## Invalidation

Three operations (`SezzleeCacheInvalidator`):

| Operation          | Effect                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `invalidateCaller` | Every entry of one `CallerScope` (`facts` plus all `probe:*`).                                                                      |
| `invalidateTag`    | Every scope carrying that tag (the host must produce tags — if the default resolver produces none, this operation affects nothing). |
| `invalidateAll`    | The whole cache, every scope.                                                                                                       |

**The signal is always manual** — sezzlee MUST NOT listen for any backend event (an authorization change, a user update) on its own; the host calls one of these three at its own authorization-change point (a role assignment, a permission revoke). The tag bridge closes the "the backend knows the user id, sezzlee only knows the carrier digest" gap: by writing an `CallerScopeResolver` that produces its own `user:{id}` tag, the host can call `invalidateTag("user:42")` with the backend's own user identity.

**The in-flight rule:** once an invalidation call has completed, within this process, no entry written **before** the call is ever observed again for the affected scopes. A computation that is **in flight** during the call (the read has started, the write has not happened yet) MAY complete, but the epoch guard MUST NOT write it back (see below — a cache-aside read writes only if the epoch observed at read time is still current).

**A catalog reload clears everything:** the `SezzleeCatalog.reload()` order is — load family members, if any source is registered → build the new snapshot → keep the current snapshot and fail the reload if the new one is newly fatal ([tool-families.md](tool-families.md) §Membership) → increment `generation` → **signal the change token (increment the epoch)** → call `SezzleeCache.clear()`. The order is normative: the epoch MUST increment **before** the clear, otherwise a computation that began before the reload could write a stale value back into the cleared cache and the in-flight rule would be violated on the reload path. The mechanism that increments the epoch MUST be independent of the authorization-invalidation path (subscribing to the change token is sufficient). This clears **the whole** cache without regard to the `facts`/`probe` distinction; if the catalog changed, a cached verdict for an old tool is meaningless.

**The `_disabled` probe set is cleared only on a catalog change**, never by an authorization-invalidation operation. That set holds the endpoints the probe permanently gave up on (when an ambiguous response such as an unmarked `2xx` was seen — [visibility.md](visibility.md), T2 "Verdict"). Why only the catalog: the set records a **structural fact** (the route did not match, or an unmarked success was seen and the handler may have run), not authorization state; reopening it on an authorization event would reintroduce the risk of the handler running, and for that the catalog must genuinely have changed (a new deployment, a new endpoint registration).

## Invariants

1. `invoke_tool` MUST NEVER consult the cache.
2. The cache is **not** a security boundary; enforcement is always in the real pipeline ([visibility.md](visibility.md), "Two axes").
3. A cache failure (an adapter throwing) is always treated as a **miss** and logged — the request is not dropped, it is recomputed.
4. No implementation is expected to perform **key scanning** (`SCAN`, `KEYS *`); every operation is designed to run in near-O(1) over scope, tag or generation.
5. Concurrent searches share one computation (single-flight, in-process): overlapping searches by the same caller run the same `facts`/`probe` computation once and share the result.

## Distributed deployment

The default implementation (`MemorySezzleeCache`) is per-process: in a multi-instance deployment every instance keeps its own cache and they converge independently within `lifetimeMs` — invalidation calls affect only the process they were called in. A host wanting a shared `SezzleeCache` adapter (Redis or similar) MUST provide these guarantees:

- `get`/`set` carry a string value; sezzlee's own compact encoding is used (`P|OrdersRead=A;Owner=U` for `facts`, a single character `A`/`D` for `probe`) — the adapter needs no general serializer contract.
- Per-scope grouped storage is recommended (for example a Redis `HASH` with field names `kind[:subkey]`): dropping one caller in a single operation (`removeScope`) MUST be O(1).
- The tag → scope set mapping MUST be kept in a separate structure (for example one Redis `SET` per tag); `removeTag` reads that set and drops the relevant scopes rather than scanning the whole key space.
- `clear` SHOULD be as cheap as incrementing a generation/epoch counter; deleting every key one by one is not required (`MemorySezzleeCache` does it by replacing its two maps).

## Mechanics / policy table

The table from decision 003 applies here too: anything whose right answer varies by host is a knob under `options.cache`; anything with one right answer is knob-less mechanics.

| Topic                                                                   | Kind      | Where                                                                               |
| ----------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| Cache lifetime, LRU bound                                               | Policy    | `options.cache.{lifetimeMs, maxCallers}`                                            |
| Key derivation (the digest input)                                       | Mechanics | `digestInput` (`@sezzlee/core`), which `CarrierHashCallerScopeResolver` uses — pure |
| Tag production                                                          | Policy    | Override `CallerScopeResolver` (the default produces none)                          |
| Negative jitter, absolute TTL, the `_disabled` rule, the in-flight rule | Mechanics | Knob-less; an SDK guarantee                                                         |
| The store (in-memory / distributed)                                     | Policy    | Override the `cache` extension point (`SezzleeCache`)                               |
| When the invalidation signal arrives                                    | Policy    | The host's business; the SDK provides only the `SezzleeCacheInvalidator` surface    |

## Relationship to `identity.projector`

What [visibility.md](visibility.md) once described as "disable the cache" is now an invalidation problem: if `identity.projector` derives a value from something other than the outer request (a clock, a counter, a database), that variable does not appear in the carrier digest and `CallerScope.key` does not track it. The correct fix is not disabling the cache but writing an `CallerScopeResolver` that folds that source into the digest too — wrapping `digestInput` and adding one more line is enough.
