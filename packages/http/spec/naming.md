# Tool Naming

> Status: **normative** — TS `createToolNames` passes the `naming/` corpus, which the NestJS discovery layer feeds.

Every SDK MUST produce the same names from the same set of endpoints; the `naming/` fixtures in [conformance](../conformance) test this document.

## Rules

1. A tool name MUST match this pattern: `^[a-z][a-z0-9_]{0,255}$`.
2. The name's **body** is the snake_case form of `operationId`, when one is defined.
3. With no `operationId`, the body is generated: `{method}_{static route segments}_by_{path parameters}`.
4. The container prefix goes in front of the body (see the section below).
5. If two endpoints still produce the same name after the prefix is applied, that is an **error** (`name_collision`). The SDK MUST NOT silently append a suffix; it fails loudly at startup or build time. The rationale: a silent `_2` suffix shifts an existing tool's name the moment a neighbouring endpoint is added, and it tells the agent nothing about which tool belongs to which resource — the names agents learn have to stay stable and meaningful.
6. If the produced name does not match the pattern, that is also an error (`invalid_name`); the fix is to define an `operationId` or an explicit name.

## The container prefix

Tool names live in a **flat** namespace while HTTP routes are hierarchical. Moving a hierarchical set into a flat space means either part of the hierarchy enters the name or you collide. `container` is part of the operation's identity ([one operation, one tool](#one-operation-one-tool)), and is therefore part of the produced name too: dropping a field that determines identity from the name would build collisions into the design.

1. Every endpoint that has a container is named `{prefix}_{body}`. The default mode is `Always`.
2. An endpoint with no container (a route handler outside any controller) gets **no** prefix: there is no source for one, and a body generated from the route already carries the hierarchy.
3. Prefix resolution — **most specific wins** (the same pattern as the [selection hierarchy](selection-hierarchy.md)):
   1. If the operation declared an explicit full name, that name is used and no prefix is applied.
   2. If the container declared an explicit prefix, that is used.
   3. If the host supplied a global prefix rule and the rule returned a value for this container, that is used. If the rule returns no value, resolution falls through to the next step.
   4. Otherwise it is derived from the container: take the last segment of the container's name, drop a trailing `Controller`, and convert to snake_case. (`Web.Controllers.PushProviderConfigController` → `push_provider_config`)
4. **Repetition suppression.** If the prefix's token sequence occurs consecutively in the body's token sequence, the prefix is not added. The comparison applies the trailing-`s` folding from the [search semantics](search-semantics.md). The rationale: `SupportRequestController.CreateSupportRequest` would otherwise produce `support_request_create_support_request`, and name length is agent context and search quality. The folding deliberately covers only a trailing `s`: `TaskActivitiesController.SaveTaskActivity` → `task_activities_save_task_activity`. Adding pairs such as `ies`/`y` or `ves`/`f` would turn the SDK into a morphology engine and would still stop at irregular plurals; the escape hatch in those cases is declaring a prefix or a full name.
5. If `PrefixMode = OnCollision` is chosen, the prefix is applied only to endpoints producing the same body — and to **all** of them in that group, not to one. When applied, a non-fatal diagnostic is emitted (`name_disambiguated`). Applying it to one side would be arbitrary: which side keeps the bare name could only be chosen by a meaningless criterion such as alphabetical order, route length or discovery order, and adding a third endpoint would change the winner and shift an existing tool's name.
6. In `Always` mode the prefix is normal behaviour and emits no diagnostic.

Because the prefix's source is `container`, the name carries only **one** level of the hierarchy. The whole route does not enter the name: `{prefix}_{body}` is bounded at two levels, and when the body is generated from the route it already contains the route segments.

## Why the length limit is 256

The pattern was once capped at 64 characters. That number has no counterpart in MCP or in model APIs: in the MCP schema (`schema/2026-07-28`) `Tool.name` is a plain `string` — no `maxLength`, no `minLength`, no `pattern` — and in the Anthropic API the tool-name space is `^[a-zA-Z0-9_-]{1,256}$`.

The two halves of the rule have opposite costs, so they are treated separately:

- **The character set stays strict** (`[a-z]`, `[a-z0-9_]`). The SDK produces the name; lowercasing and mapping to `_` rejects no endpoint, it only guarantees a shape. The uppercase letters and `-` that model APIs permit are deliberately unused.
- **The length limit relaxes.** Unlike the character set, length _rejects_: a ceiling with no basis in the protocol turns a valid endpoint into a build error. Measured: on a real 718-endpoint backend, the route-generation path produced `invalid_name` for 38 endpoints (5.3%) solely because of the 64-character limit.

A long name's real cost is agent context and search quality — that is a quality problem, and it is managed with a **warning** rather than enforcement: the SDK emits a non-fatal diagnostic (`long_tool_name`) for names exceeding 64 characters.

## snake_case conversion

- Everything is lowercased. A `_` is inserted before an uppercase letter **only** in these two cases:
  1. The preceding character is a lowercase letter or a digit (`GetOrder` → `get_order`).
  2. The preceding character is uppercase and the next one is lowercase — that is, a run of consecutive uppercase letters is ending (`GetQRDetails` → `get_qr_details`).
- Non-alphanumeric characters become `_`, consecutive `_` collapse to one, and leading and trailing `_` are dropped.

The abbreviation rule is justified by measurement: the "underscore before every uppercase letter" rule made 29 names (4%) unreadable on a real 718-endpoint backend — `GetMappingDTOProperties` → `get_mapping_d_t_o_properties`, `WS_GetTree` → `w_s_get_tree`, `AIDocument` → `a_i_document`. Since the tool name is the agent's primary search signal, that breaks discovery directly. With the current rule: `get_mapping_dto_properties`, `ws_get_tree`, `ai_document`.

## One operation, one tool

If an operation is bound to more than one route (a legacy path kept for compatibility plus the new path), **one tool** is produced. An operation's identity is the triple `(container, operationId, method)` together with its declared full name (`toolName`), when it declares one; endpoints equal in all of these are the same operation. Two endpoints that declare different full names are different operations whatever their `operationId`: a generator that writes the handler's method name as `operationId` gives two controllers' `list` the same one, and an SDK publishing its catalog names both. The route is chosen deterministically: the shortest route, and on a tie the smallest by ordinal comparison.

The rationale: a tool is an operation, not a route. Compatibility routes are a deployment matter and are none of the agent's business; two nearly identical tools pollute search results. Measured: 10 of the 15 name collisions on the real backend were this case (two route attributes on a single method) — and the "define an `operationId`" fix does not work there, because a single correct `operationId` already exists.

Folding is not silent. The SDK emits a `route_folded` warning naming the operation, the routes that were folded away and the route the tool invokes, and the folded routes are handed to the search index as `alternateRoutes` ([search-semantics.md](search-semantics.md)) so a query naming a compatibility path still finds the tool. A source that folded routes before the catalog saw them, such as an OpenAPI document an SDK annotated with `x-sezzlee.foldedInto` ([openapi-ingestion.md](openapi-ingestion.md)), hands them over the same way. Choosing the route by declaration order instead of the deterministic rule is a defect: the same source then produces different catalogs.

If no `operationId` is defined, no grouping is performed: names generated from routes already differ per route.

Including `container` in the identity is mandatory. Grouping by `(operationId, method)` alone would silently merge two distinct operations that happen to share a name in different containers (a `Delete` action on two different controllers).

## Examples

| Input                                                                       | Name                                  |
| --------------------------------------------------------------------------- | ------------------------------------- |
| `operationId: GetOrder`, no container                                       | `get_order`                           |
| `operationId: GetQRDetailsByToken`, no container                            | `get_qr_details_by_token`             |
| `GET /ping`, no container                                                   | `get_ping`                            |
| `GET /orders/{id}`, no container                                            | `get_orders_by_id`                    |
| `POST /orders/{orderId}/items`, no container                                | `post_orders_items_by_order_id`       |
| `operationId: List`, container `PushProviderConfigController`               | `push_provider_config_list`           |
| `operationId: CreateSupportRequest`, container `SupportRequestController`   | `create_support_request` (suppressed) |
| `operationId: GetOrder`, container `OrdersController`                       | `get_order` (suppressed, `s` folding) |
| `operationId: List`, container `OrdersController`                           | `orders_list`                         |
| `operationId: List`, container `PushProviderConfigController`, prefix `cfg` | `cfg_list`                            |
| `operationId: Save` × POST + PUT, same container                            | error: `name_collision`               |
| `GET /orders/{id}` + `operationId: GetOrdersById`, neither with a container | error: `name_collision`               |
