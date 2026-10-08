# Protect the MCP endpoint

`/mcp` is an ordinary endpoint in your application. sezzlee never sets up an identity scheme of its own. You wire two things: require authorization on the endpoint, and advertise where a client gets a token.

## Require authorization

On ASP.NET Core, `MapSezzlee` returns an `IEndpointConventionBuilder`, so your usual conventions compose:

```csharp
app.MapSezzlee("/mcp").RequireAuthorization();
```

On NestJS the MCP endpoint is your own controller, so you protect it as you protect any controller: a guard on the handler, or the resource-server middleware below.

Without this, anyone who can reach the port can call `invoke_tool`. They still get only what the target endpoint's own authorization permits, but an anonymous caller reaching your pipeline is rarely what you want.

## Advertise the authorization server

MCP clients find where to authenticate through RFC 9728 Protected Resource Metadata. Give sezzlee the resource identity and it serves that document:

:::tabs

```csharp title="ASP.NET Core"
builder.Services.AddSezzlee(options =>
{
    options.ResourceServer.Metadata = new ProtectedResourceMetadata
    {
        Resource = "http://127.0.0.1:5178/mcp",
        AuthorizationServers = { "http://127.0.0.1:5178/oauth" },
        BearerMethodsSupported = ["header"],
        ResourceName = "DemoApi",
    };
});
```

```ts title="NestJS"
SezzleeModule.forRoot((options) => {
  options.resourceServer = {
    resource: demoResourceUrl,
    authorizationServers: [demoIssuerUrl],
    resourceName: "demo-api",
    verifier: demoVerifier,
  };
});
```

:::

On NestJS the module installs the middleware itself when `resourceServer` is set, including bearer verification with an audience check against `resource`. On ASP.NET Core the middleware is part of `UseSezzleeCapture()`, so it is already in place.

The document is served at `/.well-known/oauth-protected-resource` concatenated with your MCP path. With the default `/mcp`:

```text
/.well-known/oauth-protected-resource/mcp
```

```json
{
  "resource": "http://127.0.0.1:5178/mcp",
  "authorization_servers": ["http://127.0.0.1:5178/oauth"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": [],
  "resource_name": "DemoApi"
}
```

The bare well-known path is not served and returns `404` on both SDKs.

## Let the 401 carry the pointer

sezzlee issues no challenge of its own. When your authorization returns `401` on the MCP path, the middleware adds a `WWW-Authenticate` header that names the metadata document:

```text
WWW-Authenticate: Bearer resource_metadata="http://127.0.0.1:5178/.well-known/oauth-protected-resource/mcp"
```

A client with no token gets the `401`, reads the header, fetches the metadata and starts the OAuth flow. The example client does exactly that under `SEZZLEE_AUTH=oauth`.

## Verify the result

With the backend running, each half is one request:

```sh
curl -s http://127.0.0.1:5178/.well-known/oauth-protected-resource/mcp
curl -s -i -X POST http://127.0.0.1:5178/mcp -H 'content-type: application/json' -d '{}'
```

The first returns the JSON above. The second returns `401` with the `WWW-Authenticate` header. If the header is missing, `ResourceServer.Metadata` is unset. If the metadata returns `404`, check that the path includes your MCP route.

sezzlee models no scopes. `scopes_supported` is passed through from your options, and what a token may do is decided by your authorization server and your endpoints. The normative transport rules are in [`packages/http/spec/transport.md`](https://github.com/sezzlee/mcp/blob/main/packages/http/spec/transport.md).

:::details[Why GET /mcp returns 405]

The endpoint serves `POST` only. It answers `GET` and `DELETE` with `405`, because there are no sessions to open or terminate. Behind bearer verification you see `401` before that applies, so a `GET /mcp` probe tells you little about whether the endpoint works.

On NestJS this is why the controller uses `@All`: it lets the transport produce the `405` itself instead of Nest answering `404`.

:::
