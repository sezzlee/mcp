# Schema Conversion Rules

> Status: **the rule layer is normative, binding is partly so.** The TypeShape → JSON Schema rules
> are implemented by TS `simplifySchema`, and the
> [conformance/schema-simplification/](../conformance/schema-simplification/) corpus pins them byte
> for byte. The binding layer is the NestJS SDK's decorator metadata reader; the "source" columns
> in the tables below list its inputs. Binding cannot, by definition, be tested with a pure JSON
> fixture; it is tested by the SDK's own host tests.

Defines how a body or parameter type in the backend's type system is reduced to JSON Schema. The
pipeline is: language type → **TypeShape** → `EndpointDescriptor.requestBody.schema` →
`ToolDefinition.inputSchema` ([metadata-contract.md](metadata-contract.md) defines the last
step; this document defines the first two).

Conversion has two layers, and the split is normative:

- **Binding**: language-specific reflection. Its input is a language type (in Nest, a class's decorator
  record) or a host declaration. Its output is a **TypeShape** conforming to
  [schemas/type-shape.schema.json](schemas/type-shape.schema.json). Tested by the SDK's own host
  tests.
- **Rule**: language-independent. Its input is a TypeShape and its output is JSON Schema. Every SDK
  MUST produce identical output, and the `schema-simplification` fixtures test exactly that.

The boundary was placed here deliberately: you cannot hand a language type to a pure JSON fixture, but
you can hand it a **member list**. That made 22 of the 34 rows in Tables 1-7 fixture-able; the 12
rows left in binding are the ones whose input genuinely is language-specific.

## TypeShape

A named-type table (`types`) and one root node (`root`). Objects have **no inline form**: every
object type lives in `types` and is reached with `{"kind":"ref","ref":"<key>"}`. The `types` key is
**stable and unique** (Nest: `<module>.<ClassName>`), while `ObjectType.name`
is the **simple display name** that becomes the `$defs` key. That separation makes hoisting
deterministic and keeps `$defs` keys language-independent — using the fully qualified name would
produce two different keys in two languages for the same conceptual type.

`TypeNode` is a single flat record discriminated by `kind`; which fields each node kind may and may
not carry is tested by `pnpm validate`'s per-kind shape pass.

## Table 1 — Decision order

The order is normative; the first matching branch wins.

| #   | Branch     | Condition        | Output                                                                      |
| --- | ---------- | ---------------- | --------------------------------------------------------------------------- |
| 0   | verbatim   | `kind: verbatim` | `schema`, deep-copied                                                       |
| 1   | binary     | `kind: binary`   | `{"type":"string","contentEncoding":"base64"}`                              |
| 2   | scalar     | `kind: scalar`   | Table 2                                                                     |
| 3   | enum       | `kind: enum`     | Table 3                                                                     |
| 4   | map        | `kind: map`      | `{"type":"object","additionalProperties":<value schema>}` + `propertyNames` |
| 5   | array      | `kind: array`    | `{"type":"array","items":<element schema>}`                                 |
| 6   | reference  | `kind: ref`      | an inline object, or `{"$ref":"#/$defs/<name>"}` if hoisted                 |
| 7   | unreadable | `kind: unknown`  | `{"type":"object","additionalProperties":true}` + `unreadable_shape`        |

**Map MUST come before array.** Dictionaries also present as an enumerable of key/value pairs; if
the array branch came first, every dictionary would be described as `[{"key":…,"value":…}]` and no
JSON value conforming to that schema could reach the backend. In the IR the distinction is already
settled by `kind` — but **in the binding layer** the distinction MUST still be interface-based: a
real array whose elements happen to be key/value pairs (`List<KeyValuePair<…>>`) is not a map and
MUST stay an array.

The boundary output carries `additionalProperties: true`, which means "an object whose shape is
unknown" and is distinguishable from a declared empty object (`properties: {}`). The distinction is
functional, not cosmetic: `RequestComposer`'s allow-list is fed from this flag, so `properties: {}`
means "no key is accepted." Writing that output for a type whose shape cannot be read would make
the endpoint silently uncallable.

## Table 2 — Scalar dictionary

`ScalarKind` plus an optional `format` → schema. The source columns are binding.

| Schema                                         | `ScalarKind`/`format`  | Nest source                                       |
| ---------------------------------------------- | ---------------------- | ------------------------------------------------- |
| `{"type":"string"}`                            | `string`               | `String`, `@IsString()`, `@IsEmail()`, `@IsUrl()` |
| `{"type":"boolean"}`                           | `boolean`              | `Boolean`, `@IsBoolean()`                         |
| `{"type":"integer"}`                           | `integer`              | `@IsInt()`                                        |
| `{"type":"number"}`                            | `number`               | `Number`, `@IsNumber()`                           |
| `{"type":"string","format":"uuid"}`            | `string` + `uuid`      | `@IsUUID()`                                       |
| `{"type":"string","format":"date-time"}`       | `string` + `date-time` | `Date`, `@IsDate()`, `@IsDateString()`            |
| `{"type":"string","format":"date"}`            | `string` + `date`      | —                                                 |
| `{"type":"string","contentEncoding":"base64"}` | `kind: binary`         | —                                                 |

Types that are absent from the scalar dictionary and are not objects either (`object`, unreadable
members) become an `unknown` node, not an empty object.

## Types whose wire form is not their members

A `verbatim` node is written by a host declaration, or by the binding layer for a type whose
serializer does not write the type's members. Reflecting such a type publishes an object the backend
never accepts, so the binding layer MUST bind it to the schema its serializer actually reads.

**JSON Patch documents.** A framework type for an RFC 6902 patch document, and every type derived
from one, binds to a `verbatim` node carrying the operation array. Nest has no such type, so there
the node comes from a host declaration:

```json
{
  "type": "array",
  "items": {
    "oneOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "required": ["op", "path", "value"],
        "properties": {
          "op": { "type": "string", "enum": ["add", "replace", "test"] },
          "path": { "type": "string" },
          "value": {}
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": ["op", "path", "from"],
        "properties": {
          "op": { "type": "string", "enum": ["move", "copy"] },
          "path": { "type": "string" },
          "from": { "type": "string" }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": ["op", "path"],
        "properties": {
          "op": { "type": "string", "enum": ["remove"] },
          "path": { "type": "string" }
        }
      }
    ]
  }
}
```

- A host declaration for the type still wins; the rule applies only where the host said nothing.
- The schema does not depend on the patched type. RFC 6902 paths are strings; a path the model does not have
  fails when the backend applies the patch, not when the arguments are checked.
- The operation array is a non-object body root, so the tool takes it as the `body` argument
  (Table 6). The media type is chosen by [request-bodies.md](request-bodies.md); an endpoint that
  declares `application/json-patch+json` is sent that type.

## Table 3 — Enum wire form

The wire form is determined **by asking the host's serializer**, never guessed: every member is
serialized with the host's own settings and the type of the result is read. That also captures
member-level renames and the naming policy. Binding writes this measurement into `EnumFacts`
(`wireForm`, `combinable`, `names`, `numbers`); the rule reads only `EnumFacts`.

| `wireForm` / `combinable`   | Schema                                             | Diagnostic               |
| --------------------------- | -------------------------------------------------- | ------------------------ |
| `string`                    | `{"type":"string","enum":[<wire names>]}`          | —                        |
| `integer`                   | `{"type":"integer","enum":[<numeric values>]}`     | —                        |
| `combinable: true` (flags)  | `type` only — `enum` is **not written**            | —                        |
| `unresolved`                | `{"anyOf":[string form, integer form]}`            | `enum_format_unresolved` |
| `unresolved` + `combinable` | `{"anyOf":[{"type":"string"},{"type":"integer"}]}` | `enum_format_unresolved` |

Writing an `enum` list for a flags enum rejects every legal bit combination, so the list is
dropped. For a host that cannot be read, `anyOf` is not a dodge but the correct statement: that host
accepts both the name and the number. Which is also why `anyOf` is **not a universal fallback** — a
host whose policy can be read accepts only one form.

**`unresolved` means the measurement failed, not that the validator is lenient.** A binding layer
whose enum check happens to accept both forms MUST still report the form the handler compares
against. The concrete case is class-validator's `@IsEnum`, which validates against the enum object's
values and therefore also accepts a numeric enum's _member name_; a handler comparing
`x === Status.Active` then takes the wrong branch for an input that passed validation. Reporting
`unresolved` there would publish an `anyOf` inviting exactly that call, so a numeric enum resolves to
`integer`. Reserve `unresolved` for a host whose serializer genuinely could not be read.

## Table 4 — Member rules

The IR carries three binding facts on every member: `readOnly`, `constructorBound`, and the
member's type node. The rule decides from those three.

| `readOnly` | `constructorBound` | Member type      | Behaviour                                                      |
| ---------- | ------------------ | ---------------- | -------------------------------------------------------------- |
| `false`    | —                  | —                | in the schema                                                  |
| `true`     | `false`            | `array` or `map` | in the schema — the serializer populates the existing instance |
| `true`     | `true`             | —                | in the schema — it corresponds to a constructor parameter      |
| `true`     | `false`            | anything else    | **dropped** — a server-computed audit field                    |

The read-only collection exception is mandatory: without it a genuinely writable field falls out of
the schema and therefore out of `RequestComposer`'s allow-list, turning a working argument into
`unknown_argument`.

Dropping can be disabled with `dropReadOnlyProperties` (on by default); indexers and unreadable
members never enter the IR at all, so they are not the rule's concern.

**Table 4 governs schemas the caller sends, never schemas it reads.** `dropReadOnlyProperties` is a
statement about arguments — a server-computed field is noise in an input schema because the caller
cannot set it. In a **response** schema the same field is the payload: a member is read-only
_because_ it is something the server reports. So a `responses[*].schema` MUST be written with
dropping off, whatever the host set `dropReadOnlyProperties` to; the host knob narrows inputs only.
An SDK that writes both from one options instance inverts the rule exactly where it costs most, and
because both directions of one DTO then pass through the same diagnostic sink, it MUST NOT report a
shape diagnostic twice for one endpoint. What is written here is what the agent reads: the primary
success schema becomes the tool's `outputSchema` ([metadata-contract.md](metadata-contract.md)),
so a member dropped here is a field the agent never learns exists.

Member order: base-type members first, then the derived type's; within each type, declaration order.
The order is normative — the `required` array and fixture comparison are order-sensitive, while
reflection's natural order is not guaranteed. **Binding** produces the order, **the rule** preserves
it.

## Table 5 — `required` and constraints

`required` is produced only from an **explicit declaration**. Being non-nullable does **not** by
itself mean `required`: "cannot be null" and "must be sent" are different questions, and frameworks
do not enforce the second one on body fields.

Constraints are carried in the IR under **neutral names**; the mapping to a JSON Schema keyword is a
**rule**, because which keyword it lands on depends on the member's produced type.

| IR constraint         | Produced type                               | JSON Schema                                         | Nest source                                      |
| --------------------- | ------------------------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| `required: true`      | —                                           | a `required` entry                                  | a member without `@IsOptional()`/`@ValidateIf()` |
| `minSize` / `maxSize` | `array`                                     | `minItems` / `maxItems`                             | `@ArrayMinSize()`/`@ArrayMaxSize()`              |
| `minSize` / `maxSize` | anything else                               | `minLength` / `maxLength`                           | `@MinLength()`, `@MaxLength()`                   |
| `minimum` / `maximum` | `integer`, `number`                         | `minimum` / `maximum`                               | `@Min()`, `@Max()`                               |
| `minimum` / `maximum` | anything else                               | **not written**                                     | —                                                |
| `pattern`             | `string`                                    | `pattern`                                           | `@Matches()`                                     |
| `pattern`             | anything else                               | **not written**                                     | —                                                |
| `format`              | `string`, if the schema carries no `format` | `format`                                            | `@IsEmail()` → `email`, `@IsUrl()` → `uri`       |
| `description`         | —                                           | `description`, if the schema carries no description | —                                                |

**Attribute reading MUST NOT stop at the member.** If the serializer picked a parameterized
constructor, the attributes on the name-matched parameter are read too; those on the member win a
conflict. A language that can attach a constraint to the constructor parameter rather than to the member
would otherwise hide it from an implementation that looks only at members.

If constructor selection is ambiguous (several candidates of the same width), correlation is **not**
performed; ambiguity MUST NOT be resolved silently.

`required` is written in nested schemas only when non-empty, while in the root `inputSchema` it is
written even when empty ([metadata-contract.md](metadata-contract.md)). The asymmetry is
deliberate: the root is the agent contract compared byte for byte against a fixture, while nested
schemas are descriptive payload.

Constraints that cannot be translated (`@IsCreditCard()`, `@IsPhoneNumber()`, custom validators)
never enter the IR. An invented translation would lead the client to reject valid input before it
ever reaches the server.

`default` is deliberately not written — there is no such field in the IR, so the rule is structurally
enforced. The rationale: it invites the model to send the default explicitly, whereas in a PATCH body
"absent" and "explicitly the default" are different requests.

## `$defs` and hoisting

There is **no depth limit**. Nesting expands fully; termination is guaranteed by the `$defs` table,
because each named type is written at most once. A cycle is not reduced to an opaque object but
expressed with `$ref` — no information is lost, and `$defs`/`$ref` are core JSON Schema 2020-12
vocabulary.

**Hoisting predicate:** a named object type is moved into `$defs` **if it is used more than once or
participates in a cycle**, and `{"$ref":"#/$defs/<name>"}` is written at the use site. A type used
exactly once and not in a cycle stays inline; keeping a shallow DTO flat is a readability win.

**The root is always inline.** A hoisted root would make `inputSchema` a `{"$ref":…}`, whereas
`inputSchema` is always a plain object (Table 6) and the flattening of body fields to the top level
depends on that. If the root type is also self-recursive it is written into `$defs` **as well**, and
the inner references point there; the cost is one duplicate body per recursive root.

**The counting scope is the whole of one TypeShape per endpoint**, not per schema root. If a query
parameter's type and the body's type each reference the same type once, the count is two and the
type is hoisted. That sentence is normative: an implementation that reads the scope as per-root
passes the entire fixture corpus (every fixture has a single root) but diverges on a real catalog.

`$defs` lives at the root of every schema-valued slot, holding only the subset reachable from that
root. While `inputSchema` is being produced, the bags from the parameter schemas and the body schema
are merged by key: same key plus same body → one survives; same key plus a different body →
`schema_def_conflict`, and the endpoint is dropped.

**A flattened body contributes its bag even though its root is discarded.** Flattening lifts the
body's properties to the top level and emits nothing of the root itself, so the root's `$defs` has no
carrier; but a `$ref` is a **document-root-relative** pointer, and a lifted property still spells it
`#/$defs/<name>` — which now addresses the `inputSchema` root. Merging that bag is therefore what
keeps the pointers resolvable, and skipping it does not weaken the schema, it emits an **invalid**
one. (In root mode the whole body becomes the `body` property, so its bag rides along and is lifted
from there; the two modes must agree.) The merge MUST NOT detach the bag from the descriptor: the
descriptor is shared for the life of a catalog snapshot, so an implementation that strips `$defs`
while reading it produces correct output for the first tool built and dangling `$ref`s for every one
after.

"Same body" is compared **without regard to key order**. Serializers write an identical type in
different key orders routinely, and a comparison that saw those as two schemas would drop an endpoint
over a difference that is not one.

**`$defs` key order is ascending ordinal.** Discovery order would depend on the binder's walk
order; since `$defs` is a bag, sorting it is semantically
free. The order is pinned explicitly in the fixture with `defsOrder`, because neither runner's deep
equality sees object key order.

**Key collisions:** if two hoisted types carry the same simple name, their `types` keys are ordinal
sorted; the first keeps the bare name, later ones get `<Name>_2`, `<Name>_3`, and
`schema_def_name_disambiguated` is emitted. It is not a silent resolution — there is a diagnostic —
and it is not fatal, because a `$defs` key is document-local and cannot misaddress any tool.

`$defs` keys are the simple form of host type names. This is a deliberate trade-off: type names
already reach the agent surface through description text and through tool prefixes derived from
`container`, and [visibility.md](visibility.md) invariant 3 is about **policy** names, not type
names.

## Depth budget (host policy, not a rule)

`maxDepth` is **not a correctness limit**; when unset (the default) depth is unbounded. A host MAY
impose a budget out of concern for context size: a branch that reaches the budget is then reduced to
the boundary object and `schema_depth_truncated` is emitted. Hoisting bounds _recursion_, not
_breadth_ — dozens of distinct single-use DTOs can expand into one large `inputSchema`, and the
budget exists for that.

No SDK SHOULD rely on the budget's existence or on any default value for it.

## Table 6 — Body root

`inputSchema` is always a plain object; MCP tool arguments are a JSON object.

| Body root schema                                                         | Behaviour                                                                                                                                             |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type: object` with `properties`, body required                          | fields flatten to the top level                                                                                                                       |
| `type: object`, `additionalProperties` open, required                    | the body is free-form; unknown keys are forwarded, and a **typed** `additionalProperties` is carried to the root as a schema, not flattened to `true` |
| any root carrying a key outside the flattenable set                      | one synthetic argument `body`; `unflattenable_body_root`                                                                                              |
| `type: object` with neither `properties` nor open `additionalProperties` | one synthetic argument `body`; `unflattenable_body_root`                                                                                              |
| an array or scalar root                                                  | one synthetic argument `body`; `synthetic_body_argument`                                                                                              |
| any root with `requestBody.required: false`                              | one synthetic argument `body`, **not** required; `optional_body_argument`                                                                             |
| a root whose field name collides with a parameter name                   | one synthetic argument `body`; `body_field_collision`                                                                                                 |
| no `type` (host declaration)                                             | treated as an object                                                                                                                                  |
| more than one body declaration                                           | the endpoint is **dropped**, `multiple_body_bindings`                                                                                                 |

`requestBody.required` is the body-level bit and is distinct from the field-level `required` entries
inside `requestBody.schema`. Omitted, it means `true`. A body may be optional while a field inside it
is mandatory — "you need not send a body; if you do, it must carry `reason`" — and the two
requirednesses must not be collapsed into one.

**Flattening is a two-keyword whitelist, so it is allowed only where nothing else is at stake.**
Flattening emits the body's `properties` at the top level and `required` into the root's list; the
body root itself is never written. Anything else the root carried is therefore gone. Rather than
enumerate what may be lost — 2020-12 has some forty keywords and its vocabularies are extensible, so
a keyword nobody listed would default to silently-wrong — the rule flattens only a root whose **every
key** is one of:

`type`, `properties`, `required`, `$defs`, `additionalProperties`, `description`

plus these keys, which annotate without constraining and MUST NOT force the root argument:

`title`, `$schema`, `$comment`, `example`, `examples`, `default`, `deprecated`, `readOnly`,
`writeOnly`, and any key beginning `x-`

The annotation list is normative and has to stay generous, because root mode is not free: an endpoint
that already has a parameter named `body` is **dropped** with `argument_collision`, so a key wrongly
read as a constraint turns a working tool into a missing one. `$schema` earns its place by being
written by default by `zod-to-json-schema` and by any standalone schema serialization; it names a
dialect, and the only keywords flattening reads — `properties` and `required` — mean the same in
every dialect.

**A key that decides where a `$ref` resolves is never an annotation**, however much it reads like
one. `$id` makes the body root its own schema resource and rebases every reference inside it;
`$anchor` declares a plain-name fragment that a `{"$ref":"#Name"}` in a lifted property points at.
Flattening drops the root, so either one leaves the references spelled correctly and aimed at
nothing — the same defect as a lost `$defs` bag, and the reason both take the root argument.
`$dynamicAnchor`, `$recursiveAnchor` and `definitions` are outside every list here and so take it
too, which is the intended default for anything resolution-bearing that nobody enumerated.

The resource boundary binds `$defs` hoisting as well: a property that declares `$id` keeps its own
`$defs`, because a `#/$defs/…` inside it resolves against that `$id` and not against `inputSchema`.
Hoisting such a bag to the root would aim the references at nothing.

`type` is the one safe key whose **value** is checked as well: flattening requires it to be absent or
exactly the string `"object"`. The array form (`["object","null"]`) says a JSON `null` body is
accepted, which flattening cannot express.

The two keywords that show why this is not stylistic are `minProperties` and `propertyNames`: both
apply to _every_ key of the instance, and after flattening the tool root's keys include the path and
query parameters. `minProperties: 1` would start counting `tenantId`; an integer-keyed dictionary's
`propertyNames: {"pattern":"^-?[0-9]+$"}` would reject it outright. `additionalProperties` is the
opposite case and is safe to carry, because it applies only to keys absent from `properties` and
every parameter is named there. (A string-keyed dictionary constrains no key names and so still
flattens as the free-form row above; only a key-constrained one takes the root argument.)

The direction is chosen for its failure mode, not its frequency. Dropping a keyword publishes a
contract the backend does not honour — the agent composes a call the backend rejects, and the schema
never said why. Taking the root argument keeps the body schema **complete and verbatim** under
`properties.body`; the cost is one nesting level and N arguments becoming one. A complete schema that
is less convenient beats an incomplete one that looks convenient.

`unflattenable_body_root` is a warning: the tool is fully callable.

**No flattenable surface.** A root that is neither `properties`-bearing nor open to additional keys
takes the root argument too, and this one is a correctness fix rather than a fidelity fix. A bare
`{"$ref": …}` or a bare `{"type":"object"}` used to flatten into _nothing_: no body field was
declared, the template's `hasBody` came out `false`, and the request went out **with no body at all**.
Note that `{"type":"object","properties":{}}` is a different thing and still flattens — it declares
an object with no fields and sends `{}`.

**Synthetic body root.** A non-object body root (an array or a string) does
not drop the endpoint. `inputSchema` carries a single `body` property whose schema is the root
itself, and it is listed in `required`; `inputSchema.additionalProperties` is `false`. At call time
the `body` argument's value is sent as **the entire body**; if `body` is absent no body is sent at
all and the backend's model binder decides ([argument-mapping.md](argument-mapping.md)).

**An optional body is never flattened.** A body declared `requestBody.required: false` takes the
same synthetic `body` argument even when its root is an object, and that argument is **not** listed
in `required`. The reason is mechanical rather than stylistic: flattening leaves no wrapper to omit,
so field mode always emits at least `{}` — the one shape an optional-body endpoint often rejects.
Routing the body through the root argument is what makes the two states distinguishable, and they
are different requests: `body` absent sends nothing, `body: {}` sends `{}`. The cost is worth naming:
the fields stop being top-level arguments, and an endpoint that also has a parameter named `body`
now collides (`argument_collision`) where the flattened form did not, so flipping this one boolean
can drop such an endpoint.

**A body field whose name collides with a parameter takes the root too.** Flattening merges the
body's field names with the path, query and header parameter names into one namespace, and MCP gives
that namespace no `in` to separate them by. Where two names meet, one value would have to reach two
wire slots, and nothing in the descriptor says whether they are the same thing: in
`POST /orders/{id}` with a body field `id` they are, and in `POST /projects/{id}/members/{memberId}`
with a body field `id` they are not. Sending one value to both is silently wrong wherever the second
reading holds, so the body takes the root argument and `body_field_collision` is emitted. This is the
same rule as every other row of Table 6 — flattening is allowed only where it loses nothing — and not
a special case: `{"id": 7, "body": {"id": 7, …}}` names both slots and neither is guessed.

The check runs on the flattened result, so it sees exactly the names `inputSchema` would carry. A
host that renames fields through `propertyName` is compared on the renamed form.

The name goes through the same collision check as parameter names: if a parameter named `body`
exists, `argument_collision` is emitted and the endpoint is dropped. A template MUST NOT declare
both a body root and body fields at once (`conflicting_body_modes`).

The retired `non_object_body` code MUST NOT be reused: its old meaning was "this endpoint cannot be
called at all," and it can be called now.

`inputSchema.additionalProperties` is **derived** from whether the body is free-form; it is never
written as a constant. The same predicate feeds both the schema and `RequestComposer`'s allow-list —
if those diverged, the schema would declare a contract the composer does not honour. The body root
follows the same discipline: a root schema that triggers the `body` argument also triggers the
composer's second body mode. In root mode the top-level `additionalProperties` is `false` even for a
free-form body, and that is not a contradiction: the only top-level argument is `body`, and the body's
own freedom is carried by the schema of that property.

## Table 7 — Diagnostics

| Code                            | When                                                                                  | Result                         |
| ------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------ |
| `argument_collision`            | a parameter name collides with the body root name `body`                              | the endpoint is dropped        |
| `duplicate_argument`            | two parameters declare the same argument name                                         | the endpoint is dropped        |
| `unsupported_object_style`      | an object-valued parameter's declaration has no wire form                             | the endpoint is dropped        |
| `unsupported_object_nesting`    | an object-valued parameter's member cannot be addressed one level deep                | the endpoint is dropped        |
| `multiple_body_bindings`        | more than one body declaration                                                        | the endpoint is dropped        |
| `unsupported_binding`           | a body media type no writer exists for ([request-bodies.md](request-bodies.md))       | the endpoint is dropped        |
| `unsupported_body_shape`        | a form, multipart or text body whose shape has no wire form                           | the endpoint is dropped        |
| `content_type_not_accepted`     | the host declared a body media type the backend does not accept                       | the endpoint is dropped        |
| `unresolved_file_field`         | a file binding whose multipart field name cannot be read (Nest)                       | the endpoint is dropped        |
| `body_parser_missing`           | a body media type the host registered no parser for (Nest)                            | the endpoint is dropped        |
| `unsupported_method`            | the HTTP method has no counterpart in the neutral model                               | the endpoint is dropped        |
| `schema_def_conflict`           | the same `$defs` key is defined twice with different bodies                           | the endpoint is dropped        |
| `unresolved_query_shape`        | a whole-object query binding whose members cannot be read at all                      | the endpoint is dropped        |
| `synthetic_body_argument`       | a non-object body root was wrapped into a `body` argument                             | warning                        |
| `unflattenable_body_root`       | a body root carried a keyword flattening would discard, or offered nothing to flatten | warning, the body is wrapped   |
| `optional_body_argument`        | a body declared `required: false` was wrapped into an optional `body` argument        | warning                        |
| `body_field_collision`          | a body field name collides with a parameter name                                      | warning, the body is wrapped   |
| `unbound_query_object`          | some members of a whole-object query binding are not expressible                      | warning, those members dropped |
| `query_member_shadowed`         | a flattened query member's name is already claimed by another binding                 | warning, that member dropped   |
| `query_parser_not_extended`     | a bracketed query object on an Express host that does not parse brackets              | fatal                          |
| `unbound_header_object`         | a whole-object header binding                                                         | warning, the binding dropped   |
| `route_folded`                  | one operation was bound to several routes ([naming.md](naming.md))                    | warning                        |
| `unsupported_dictionary_key`    | a dictionary key that cannot be serialized                                            | the value shape is dropped     |
| `unreadable_shape`              | the binding layer could not read the shape                                            | the boundary object is written |
| `schema_def_name_disambiguated` | two hoisted types carry the same simple name                                          | warning, a suffix is added     |
| `schema_depth_truncated`        | the host's depth budget cut a branch                                                  | warning                        |
| `enum_format_unresolved`        | the enum wire form cannot be read                                                     | warning                        |
| `naming_policy_unresolved`      | the field-name policy cannot be read                                                  | warning                        |

Severity has three levels: `Warning`, `EndpointDropped`, `Fatal`. `Fatal` is reserved for codes that
make the whole catalog inconsistent (two endpoints claiming the same name). An argument collision is
**local** — one endpoint is unusable while the rest of the catalog is sound — so it is not `Fatal`;
otherwise a single broken DTO would drop hundreds of tools at once.

`unreadable_shape` is deliberately a **warning** and does not drop the endpoint. It is the inverse of
the retired `non_object_body`: that code dropped because the endpoint could not be called at all,
whereas an opaque body forwards every unknown key thanks to `additionalProperties: true`, so the tool
stays **fully callable** with a weaker contract. Dropping it would be a regression. A host that says
"no opaque bodies in production" adds the code to `Diagnostics.Escalate`.

`unresolved_query_shape` is the case where that reasoning does not hold, which is why it drops the
endpoint instead. Query has no counterpart to `additionalProperties: true`: the composer writes only
the parameters the template declares, so a key the schema never named is not forwarded, it is
discarded. A tool published with an unreadable query object is therefore not a weaker contract but a
**wrong** one — the agent reads "this operation takes no filters", calls it, and silently gets an
unfiltered result set. That is indistinguishable from an operation that genuinely has no filters, and
the two must not produce the same observable outcome. When only _some_ members are unreadable the
endpoint survives with `unbound_query_object`, because the members that were read are real and the
tool is still narrower than no tool. A host that prefers a filterless tool to no tool adds
`unresolved_query_shape` to `Diagnostics.Downgrade`. Both messages MUST name the way out: decorate
the type so the binding layer can read it, or declare the shape through the host's type-shape hook.

Grouping moves neither diagnostic. `unresolved_query_shape` fires on exactly the same condition — a
whole-object binding no member of which can be read — and still drops the endpoint, for the same
reason: the composer writes only the members the template declares, grouped or not, so query has no
`additionalProperties: true` escape in either form. `unbound_query_object` fires on exactly the same
condition and stays a warning; only its message changes, to name the argument the surviving members
landed in. What grouping changes is what the _non-failing_ path produces, never what fails. An SDK
that cannot group a particular binding — because the shape is unreadable, or because every member is
a dictionary or a nested object — falls back to the binding it already produced and says so with
`unbound_query_object`, so turning grouping on cannot drop an endpoint that stands without it.

## Unpinned areas

The following are deliberately undefined or out of scope; an implementation SHOULD NOT rely on them.

- **Nullable representation.** Reference-type nullability is not read; a value-type wrapper is
  unwrapped and `null` does not surface in the schema. The IR has no nullable node. Since `required`
  is not fed from it, there is no correctness dependency either. The second reason for leaving it out
  of scope is structural: in TypeScript there is no such thing as nullability at runtime, so this
  rule cannot be validated by a second implementation.
- **Host documentation comments.** The binding layer MAY read a member description from the host's
  own documentation source; the rule layer sees only the IR's `description` field. Which source is
  read belongs to binding and is not normative.
- **The depth budget's default value** (see above). The budget's _behaviour_ is pinned; its existence
  and its value are host policy.
