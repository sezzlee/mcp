# Declare visibility for a NestJS guard

On NestJS, search results are filtered per caller only if your guards say what they enforce. This page shows how a guard declares itself and what happens when it does not.

## Know the trap

sezzlee reads every guard on an endpoint, global, controller and method, and asks each for a declaration. A guard declares itself with a `describeVisibility()` method. If any guard on the endpoint lacks that method, the endpoint is marked `imperative: true` and its visibility is `unknown`. Declaring the other three guards changes nothing.

`unknown` is not a denial. With the default `visibility.onUnknown: "show"`, the tool still appears in search flagged `authUncertain`, and the caller finds out at invoke time.

## Declare a guard

```ts
@Injectable()
export class OrdersReadGuard implements CanActivate {
  canActivate(): boolean {
    // your real check, unchanged
    return true;
  }

  describeVisibility(): { anonymous: "no"; policies: string[] } {
    return { anonymous: "no", policies: ["OrdersRead"] };
  }
}
```

Both fields are optional. `anonymous` is `"yes"`, `"no"` or `"unknown"`, and `"no"` means the guard requires an identity. `policies` are the named checks the guard applies. They are compared against what the caller satisfies and never reach the agent.

The method must not throw and must not depend on request state. It runs once at catalog build time, with no request in scope. A throw is swallowed and the guard counts as undeclared. Across several guards, `anonymous: "no"` from any guard wins and `policies` are unioned.

Declaring a guard does not change what it does. `describeVisibility()` is read by the catalog and never by `canActivate`, so a wrong declaration makes search results wrong, not your authorization.

## Probe when you cannot declare

If the guards are not yours to change, or the check cannot be summarized, turn on the probe tier:

```ts
SezzleeModule.forRoot((options) => {
  options.visibility.tier = "probe";
});
```

A probe sends a synthetic request that runs your guards and stops before the handler. A `401` or `403` is `deny`. A short-circuit with a status below `400` is `allow`. Anything else is `unknown`, and that tool's probe disables itself.

Probing is budgeted. `visibility.probeTopK` (default 25) caps probes per search and `visibility.probeConcurrency` (default 4) caps parallelism.

## Give the probe path parameters

A route like `/orders/{id}` needs an `id`. sezzlee synthesizes one from the parameter's type, and falls back to the literal `probe`. When that value does not route, the probe returns `unknown` and says why:

```text
the probe path did not route; declare a value in visibility.probeValues
```

Supply one. Keys are lowercased parameter names:

```ts
options.visibility.probeValues.set("id", "1");
options.visibility.probeValues.set("tenantslug", "acme");
```

## Verify the result

Run a search as two callers and compare the counts. This is the NestJS sample, whose four guards are all undeclared:

```sh
SEZZLEE_BASE_URL=http://127.0.0.1:3000 SEZZLEE_AUTH=token SEZZLEE_USER=alice \
  node sdks/nestjs/samples/agent-client/dist/main.js --scenario smoke --query "create order"
```

```text
search_tools "create order"  ok    7/8 results
```

Seven of eight, decided by one synthetic request per candidate on every search. Had the guards declared themselves, those decisions would come from metadata read once at build time. Hiding a tool is still not enforcement: a caller who guesses its name reaches your guards and is rejected there. See [Control what a caller can see](/docs/http-catalog/control-what-a-caller-can-see).

:::details[Why probing is not the default]

One real backend kept authorization in custom JWT middleware, so every endpoint looked anonymous and 250 of them showed up in search for everyone. Enforcement still held, but the agent found out one call at a time. An endpoint with no readable declaration therefore became `unknown`, and probing resolves `unknown`.

On that backend a 50-card search took 1,180 ms under the old rule and 21,978 ms with probing on, with 664 `unknown` endpoints. The cost is each probe's request prologue, and on that host every request opens an NHibernate session. The budget worked: only 25 candidates were probed.

Probing multiplies your own per-request cost by the budget, and only you can measure that. Declare what you can, probe what you cannot. An endpoint with no authorization declaration and no short-circuit point cannot be probed at all, and stays `authUncertain`.

:::
