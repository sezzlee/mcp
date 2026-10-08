# Forward the caller's identity

An agent call arrives at `/mcp` and is replayed as a synthetic request into your pipeline. For your authentication to recognise the caller, the credential has to travel onto that synthetic request.

By default `Authorization` is forwarded, unchanged, and nothing else. If your backend authenticates from a bearer token in that header, you configure nothing. sezzlee does not mint, refresh, exchange or rewrite tokens. A `401` from your pipeline means your authentication rejected the caller's real credential.

## Add a carrier

A cookie session, an API-key header or a tenant header your middleware reads has to be named:

:::tabs

```csharp title="ASP.NET Core"
builder.Services.AddSezzlee(options =>
{
    options.Identity.Forward("Cookie");
    options.Identity.Forward("X-Api-Key");
});
```

```ts title="NestJS"
SezzleeModule.forRoot((options) => {
  options.identity.forward("cookie").forward("x-api-key");
});
```

:::

Both are fluent and additive, and names are case-insensitive. `Authorization` stays unless you drop it. To forward nothing, call `Clear()` or `clear()` first, then add what you want. Keep the list short: every forwarded header is one your endpoints see on a request they did not originate.

## Project a credential that is not a header

Some backends resolve identity in their own middleware from something the synthetic request cannot inherit by name, such as a value already parsed onto the request object. Project it yourself:

:::tabs

```csharp title="ASP.NET Core"
options.Identity.Project((outer, synthetic) =>
{
    synthetic.Headers["X-Tenant"] = outer.HttpContext.Items["tenant"]?.ToString();
});
```

```ts title="NestJS"
options.identity.project((outer, syntheticHeaders) => {
  syntheticHeaders["x-tenant"] = resolveTenant(outer);
});
```

:::

The projector runs once per synthetic request, with the outer request in hand. Write the value into a header your middleware already understands, rather than teaching sezzlee about your identity model.

## Verify the result

Call an endpoint that echoes the caller. The samples have one:

```sh
SEZZLEE_USER=alice node sdks/nestjs/samples/agent-client/dist/main.js \
  --scenario smoke --query identity --tool orders_me --arguments '{}'
```

```text
search_tools "identity"  ok    3/8 results
load_tool orders_me      ok    {"type":"object","properties":{},"required":[],"additionalProperties":false}
invoke_tool orders_me    ok    {"status":200,"body":{"name":"alice"}}
```

The body names the caller, so the credential arrived and your authentication read it. A `401` means it did not: check that the header your scheme reads is in the carrier list.

:::details[Why forwarding never elevates]

The synthetic request carries the same credential the agent presented, so an agent acting as `bob` is `bob` inside your pipeline. There is no service identity and no impersonation, and sezzlee cannot widen what the caller can do. That property is what makes the visibility filter safe to be approximate.

:::
