# Visibility

> Status: **normative** — TS `evaluateVisibility` passes the `visibility/` corpus; T0/T1/T2 are implemented in the NestJS SDK, with platform-specific behaviour named explicitly in the text.

Defines how `search_tools` results are filtered against the caller's authorization. The machine-readable counterpart is the `visibility` fixture kind in [schemas/fixture.schema.json](schemas/fixture.schema.json); the corpus is [conformance/visibility/](../conformance/visibility/).

## Two axes, two different responsibilities

|                        | Enforcement (`invoke_tool`) | Visibility (`search_tools`)        |
| ---------------------- | --------------------------- | ---------------------------------- |
| Where it happens       | The backend's real pipeline | The SDK                            |
| Verified on every call | **Yes, unconditionally**    | No — best-effort                   |
| Must it be correct     | Required; security is here  | No; if wrong, invoke still rejects |
| Purpose                | Security                    | UX + preventing existence leaks    |

## The decision is three-valued

`allow` (show) · `deny` (hide) · `unknown` (could not be evaluated).

Forcing `unknown` into two values is wrong in both directions: collapsing it to `deny` makes an endpoint the caller genuinely can use invisible (it destroys capability), and collapsing it to `allow` hides the uncertainty from the agent. The third value is carried through and surfaces on the card as `authUncertain`.

## Optimistic semantics

The real authorization function is `auth(endpoint, caller, resource, env)`. At list time there is no `resource` — there are no arguments at all. Two different questions can be asked:

- **Optimistic:** is there _some_ resource this caller could use this endpoint for?
- **Pessimistic:** could they use it for every resource?

Visibility answers the **optimistic** question. The pessimistic question would hide every endpoint that shows callers their own records, which is the opposite of what the filter is for.

The optimistic question is answerable under one condition: that authorization factors into a **resource-independent gate** (scope, claim, role, tenant, license) and a **resource-dependent refinement** (row level, ownership). Real systems are built this way: the gate on the endpoint, the refinement inside the handler.

> **Normative:** Visibility evaluates only authorization's resource-independent gate. Resource-dependent refinements are assumed _satisfiable_; that decision is deferred to invoke time.

The mechanical counterpart maps one-to-one: the resource-independent gate is everything that runs before the handler.

## A pure core

Evaluation splits in two. That split is the precondition for being fixture-able.

**The platform side (impure, SDK-specific)** answers two questions — "does the caller have an identity?" and "is policy P satisfied?" — and writes the answers into `CallerFacts`.

- Identity is resolved by running the backend's own authentication over a synthetic request built with the **same** composition invoke uses (NestJS: running the guard in a synthetic context). The result is three-valued: `present` (identity resolved), `absent` (no identity, or an invalid one), `unknown` (the backend has no authentication that can be asked this way — identity lives in custom middleware). The SDK MUST NOT collapse `unknown` to `absent`: if it did, every tool requiring identity would be hidden on a backend with no authentication scheme.
- Policy answers are only requested while identity is `present`; with no identity, or an unknown one, no policy result is reported.

**The pure side (specified, language-independent):** `(auth, callerFacts) → decision`. Rules are applied **in order**, and the first match wins:

1. `auth.anonymous` is `no` and `callerFacts.identity` is `absent` → `deny`
2. any name in `auth.policies` resolves to `deny` → `deny`
3. `auth.imperative` is true → `unknown`
4. `auth.anonymous` is `unknown` → `unknown`
5. `auth.anonymous` is `no` and `callerFacts.identity` is `unknown` → `unknown`
6. any name in `auth.policies` has no reported result, or resolves to `unknown` → `unknown`
7. otherwise → `allow`

Why that order:

- **1 comes first:** an absent identity is the cheapest and most certain rejection.
- **2 before 3:** policy combination is AND, so one certain denial settles the result regardless of any uncertainty elsewhere. The reverse order would drop an endpoint we know something certain about into uncertainty.
- **3, 4, 5 and 6** all produce `unknown`; their relative order does not change the outcome and is fixed for readability.
- **A policy with no reported result is not treated as `allow`** (rule 6). The SDK MUST NOT invent values — this is the visibility form of the "no invention" invariant. The same principle is rule 5 for identity and rule 4 for anonymity.

`auth.anonymous` is about **identity** only, not about the whole of authorization: an anonymous endpoint can still sit behind an imperative check such as a license or feature gate. That is why `yes` alone does not produce `allow`; it only lets the later rules run.

## The evaluation ladder

The tiers are defined over framework contracts; the SDK MUST NOT recognize any host-specific type. The one tier the host writes itself, the authorizer, sits above them.

| Tier            | What it reads                                                                                      | What it produces                |
| --------------- | -------------------------------------------------------------------------------------------------- | ------------------------------- |
| Host authorizer | The host's own answer for the caller, per tool                                                     | `allow` / `deny` / `unknown`    |
| T0 anonymous    | The framework's anonymous/authorization markers in endpoint metadata                               | `auth.anonymous` (three-valued) |
| T1 declarative  | The framework's declarative authorization data → combined policy → evaluable requirements          | `policyResults` entries         |
| T2 probe        | A synthetic request enters the real pipeline and is cut **before the handler**; the status is read | `allow` / `deny`                |
| T3              | Nothing above decided                                                                              | `unknown`                       |

T0 reads three-valued, because what the metadata says and what the backend does are not the same thing:

| Endpoint metadata                                                           | `auth.anonymous` | Why                                                                                      |
| --------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| An anonymous marker is present                                              | `yes`            | Certain knowledge: the framework lets this endpoint through without looking for identity |
| Declarative authorization data is present, or the app has a fallback policy | `no`             | Certain knowledge: the framework looks for identity                                      |
| Neither                                                                     | `unknown`        | **No knowledge**                                                                         |

That third row was the rule this spec got wrong most easily. An earlier version treated it as `yes`, justified by the framework's own behaviour: an endpoint with no declarative authorization and no fallback is never evaluated by the framework's authorization layer. That is true but **narrow**: it speaks only about the framework's authorization layer, and it does not say "nothing stops this endpoint."

Protection may well live outside the framework. Middleware **does not write** to endpoint metadata, it only reads it: a global middleware attaches to the pipeline, not to an endpoint, so there is no marker saying "this middleware protects me." On a backend that establishes identity in a global middleware, metadata carries only negative markers (anonymous exemptions) and never a positive one. Measured: on a real 718-endpoint backend, all 698 tools came out `yes`; 447 of them fell to `unknown` anyway because they carried an imperative marker, but the remaining 251 appeared as `allow`, entered an unauthenticated caller's list, and returned 401 at invoke time.

`unknown` represents that ignorance honestly and hands the decision to the probe: the synthetic request enters the real pipeline, the custom middleware's 401 is observed **with no cut marker set**, and is read as `deny`. In other words, protection that cannot be read is measured by running it. A backend that declares authorization declaratively pays nothing: as long as its authorization and anonymous markers are written, the answer is static.

The deliberate limit **varies by platform**: endpoints with no probe cut point stay `unknown` and are shown with `authUncertain`. On NestJS that class of endpoint **does not exist**: every discovered endpoint is a controller route, and the SDK's cut layer is installed for all of them, so every endpoint can be probed.

Roles are declarative and evaluable: a framework's role requirement is written into `auth.policies` as a name of the form `roles:<name>[,<name>]`, and T1 recognizes that prefix and builds a role policy. This only works on platforms where **the framework carries a declarative role contract**; on a platform that does not (NestJS), `policies` stays empty and the decision is handed to T2 ([metadata-contract.md](metadata-contract.md)).

Blind evaluation at T1 is forbidden: running a requirement that needs a resource without one can produce a false `deny`. Only the resource-independent requirement kinds the framework itself recognizes are evaluated; the rest is `unknown`.

T2 is opt-in and its cost is bounded by the page, not by the catalog: candidates are probed **after ranking**, in rank order, only until the page is full, so cost grows with the limit and the denials on the way rather than with the number of endpoints. A probe cannot have side effects — the cut point is before the handler, and no probe is issued unless the cut layer is proven to be installed for that endpoint.

## The host authorizer

Some backends authorize with code no tier can read or reach: permission keys from their own database checked in a custom filter, or a dispatcher that checks the target method inside the handler, where a probe cut before the handler answers `allow` for every member. For those, the host MAY register an authorizer (NestJS: `ToolAuthorizer`). It has two parts:

- **Coverage** is caller-independent: whether the authorizer decides a given tool. The startup coverage check reads it.
- **Access** is resolved once per caller and then queried per tool, synchronously. It answers `allow`, `deny` or `unknown`; `allow` and `deny` are final, `unknown` falls through to T0–T2.

The tool it is asked about carries the method, route, container, the handler and its metadata, and for a family member the source and the member's key, so a host can decide per dispatched method.

An exception from the authorizer fails the call rather than deciding anything; nothing is cached for it. A resolved access is cached per caller scope for the cache lifetime ([caching.md](caching.md)), single-flight per scope, in process memory: it is an object, not a serialized verdict. The caller scope is the host's to define; a scope that includes the caller's permission version invalidates on a permission change without any other signal.

## Coverage

When a host authorizer is registered, or the host made coverage fatal, the SDK counts after each catalog build the selected tools whose visibility no tier can decide without a caller: not covered by the authorizer, not decidable by T0/T1 (`auth.imperative`, or `auth.anonymous` is `unknown`), and not reachable by T2. It reports them once as `visibility_uncovered` (warning) with the count and the first names. A host MAY make it fatal (`OnUncovered = Fatal` / `onUncovered: "fatal"`), which makes startup fail while any selected tool is uncovered. Without either, the check does not run: a host that never opted in sees no new diagnostic.

## T2 probe: mechanics

For an endpoint the declarative tier left as `unknown`, the probe obtains the framework's real verdict: a synthetic request (with the same identity composition as invoke) enters the real pipeline and is cut immediately after the authorization decision, **before** the handler.

- **The cost policy belongs to the host.** How aggressively the probe should run varies by backend: database load, rate limiters and acceptable search latency differ in every deployment. The SDK offers two settings with reasonable defaults: a per-search cap on probes (`maxProbesPerSearch`, 0 keeps search from probing) and concurrency (`probeConcurrency`, 1 = sequential). A verdict served from the cache costs nothing against the cap. T2 verdicts are additionally cached per caller; key derivation, namespacing, lifetime/jitter and invalidation are now normative in a separate document, [caching.md](caching.md). If `identity.projector` derives a value from something other than the outer request (a clock, a counter, a database), the correct lever — as [caching.md](caching.md) also notes — is to override `CallerScopeResolver`, not to disable the cache.
- **The flag lives in the request context, not in a header** (Nest: a symbol-keyed property of the synthetic request). An outer request MUST NOT be able to turn probe mode on. The host SHOULD use the flag to skip side effects such as rate limiting, audit logs and last-seen updates (Nest: `isSezzleeProbe(request)`): a probe that spends the caller's rate limit turns into a 429, which is no verdict at all. For skips that are not probe-specific, the synthetic-request marker is used instead (Nest: `isSezzleeRequest(request)`) — that marker is also carried at invoke time.
- **Cut point:** a global interceptor (`SezzleeProbeInterceptor`), which Nest runs after every guard and before pipes and the handler. A guard's rejection is therefore observed as a rejection, and an imperative check in a guard always runs before the cut; on a probe that passed every guard the interceptor records the cut marker and returns without calling the handler.
- **Eligibility (framework-neutral):** the endpoint MUST be known to routing **and** the SDK's cut layer MUST be **proven** installed for that endpoint — that is, the endpoint's execution must pass through a stage where the SDK registered a cut point, running after all authorization and before the handler. Without that proof a probe is issued only if the endpoint carries declarative authorization data **and** its method is safe (GET/HEAD).

  **Guarantee:** the handler of an unsafe method **never runs under any circumstances**. In the unproven branch, a safe method's handler MAY run **at most once** per endpoint: the moment an unmarked response is observed, the probe is permanently disabled for that endpoint (see "Verdict" below). That second sentence is not a relaxation but an honest statement of the guarantee an implementation can actually provide — an endpoint _declaring_ authorization does not prove the cut layer is _installed_ in the pipeline.

  | Platform | Cut layer proven                                    | Is the fallback branch used |
  | -------- | --------------------------------------------------- | --------------------------- |
  | NestJS   | **every catalog entry** (all are controller routes) | No                          |

- **Verdict:** `401`/`403` → `deny`, with or without the cut marker: if a middleware rejected before the authorization layer, the handler did not run (this is the path for backends whose auth lives in custom middleware). Cut marker plus success → `allow`. A `429`, a `5xx` or a probe that times out says nothing about authorization: it is `unknown` and **transient**, so the tool is probed again next time. An unmarked success (a `2xx` or `3xx` with no cut marker) → `unknown`, and the probe is permanently disabled for that endpoint with a warning, because the handler may have run and MUST NOT be tried a second time. An unmarked `404` means the route did not match: the probe is disabled for that endpoint and the host declares the placeholder value.
- **Budget:** only after ranking, only for those left as `unknown`, in rank order, and only until the page holds `limit` visible results; probes run `probeConcurrency` at a time. A per-search cap stops it on a caller who may use almost nothing: the page returns as it stands, the unprobed candidates follow the `unknown` policy and a warning is logged. `load_tool` probes the one tool it is asked for. `total` is the declarative count, and the `tags` vocabulary is built without probing; the probe changes neither.
- **Request shape:** path parameters are filled with a placeholder derived from the route constraint (numeric → `1`, guid → the empty guid, bool → `true`, date → `2000-01-01`, otherwise → `probe`); the host MAY declare a value by parameter name. A path parameter hidden with a constant is written with that constant instead of either, because it is the only value that routes to the tool ([tool-families.md](tool-families.md)). Query and body are not sent — the cut is before model binding, so no formatter runs.

## `load_tool` is subject to visibility

Filtering search results while handing the schema to everyone makes hiding meaningless: the agent guesses the name and `load_tool` confirms existence. So `load_tool` applies the same decision — for a `deny` tool its answer is **identical** to the answer for a nonexistent tool (`unknown_tool`). An `unknown` tool is returned and carries `authUncertain`, unless the `unknown` policy hides it. Per invariant 1, `invoke_tool` stays untouched: calling a hidden tool is the pipeline's business.

## The `unknown` policy

Without a host authorizer the default is **show** plus `authUncertain`. Rationale: preserve capability, and rely on enforcement being guaranteed at invoke time. With a host authorizer the default is **hide**: a host that wrote its own per-tool answer has said which tools a caller may use, and a tool it left undecided is closer to "not this caller's" than to "unknown". Either default MAY be overridden — the policy belongs to whoever writes the code.

## Invariants

1. **Invoke MUST NEVER consult the visibility filter**, a host authorizer included. If it did there would be two sources of truth, and they would diverge over time. Even if the agent guesses a hidden tool's name and calls it, the pipeline stops it; a host that wants agents held to a narrower rule than its users enforces that rule in the pipeline, where every caller meets it.
2. **Visibility MUST use exactly the same identity composition as invoke** (the same carrier list, the same projector). If they diverge, the filter and enforcement contradict each other, and that is the most confusing class of error a user encounters.
3. **Policy names MUST NOT leak to the agent.** `auth` is an internal model; only `authUncertain` reaches the MCP surface.
4. **Hiding MUST NOT report a reason.** A filtered endpoint is removed from the result; saying "you are not authorized" discloses its existence.
5. Visibility **is not a security mechanism.** This document does not define an authorization model; it reads the backend's own decisions.
