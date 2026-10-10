import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildGatewayCatalog,
  configSchema,
  createBoundedFetch,
  createOpenApiMcpServer,
} from "../src/index.js";
import { createTokenExchange } from "../src/credentials/token-exchange.js";
import { serveHttp } from "../src/transport/http.js";

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(
        `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
      ),
    ),
  );

let backend: Server;
let authorization: Server;
let gateway: Server;
let backendOrigin: string;
let asOrigin: string;
let mcpUrl: string;
const backendSaw: string[] = [];
const exchanges: URLSearchParams[] = [];

beforeAll(async () => {
  backend = createServer((req, res) => {
    backendSaw.push(req.headers.authorization ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  authorization = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      exchanges.push(form);
      const clientOk =
        req.headers.authorization ===
        `Basic ${Buffer.from("gateway:shh").toString("base64")}`;
      if (
        clientOk &&
        form.get("grant_type") ===
          "urn:ietf:params:oauth:grant-type:token-exchange" &&
        form.get("subject_token") === "caller-token"
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "backend-token-for-caller",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 120,
          }),
        );
        return;
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant", detail: "secret" }));
    });
  });
  backendOrigin = await listen(backend);
  asOrigin = await listen(authorization);

  const config = configSchema.parse({
    source: "inline",
    selection: { default: "include" },
    transport: {
      kind: "http",
      port: 0,
      resource: "http://127.0.0.1/mcp",
      authorizationServers: [asOrigin],
    },
    tokenExchange: {
      tokenEndpoint: `${asOrigin}/oauth/token`,
      clientId: "gateway",
      clientSecret: { fromEnv: "UNUSED" },
      audience: "backend",
      schemes: ["Bearer"],
    },
  });
  const catalog = await buildGatewayCatalog(
    {
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: `${backendOrigin}/api` }],
      components: {
        securitySchemes: { Bearer: { type: "http", scheme: "bearer" } },
      },
      security: [{ Bearer: [] }],
      paths: {
        "/me": {
          get: {
            operationId: "me",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    },
    config,
    new Map([["Bearer", { kind: "exchanged" }]]),
    [],
    undefined,
    undefined,
  );
  const exchange = createTokenExchange(
    config.tokenExchange!,
    "shh",
    createBoundedFetch(new Set([new URL(asOrigin).host])),
    2000,
  );
  gateway = await serveHttp(
    () =>
      createOpenApiMcpServer(
        catalog,
        createBoundedFetch(catalog.allowedHosts),
        config.limits,
      ),
    exchange,
    {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      resource: "http://127.0.0.1/mcp",
      authorizationServers: [asOrigin],
      allowedHostnames: [],
    },
  );
  mcpUrl = `http://127.0.0.1:${String((gateway.address() as AddressInfo).port)}/mcp`;
});

afterAll(async () => {
  for (const server of [gateway, backend, authorization]) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("openapi-mcp over http with token exchange", () => {
  it("challenges a call without a token and points at the resource metadata", async () => {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
    const metadata = await fetch(
      new URL("/.well-known/oauth-protected-resource/mcp", mcpUrl),
    );
    expect(await metadata.json()).toEqual({
      resource: "http://127.0.0.1/mcp",
      authorization_servers: [asOrigin],
      bearer_methods_supported: ["header"],
    });
  });

  it("refuses a token the authorization server will not exchange, without echoing its answer", async () => {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer stolen",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("secret");
  });

  it("calls the backend with the exchanged token, never the caller's, and caches the exchange", async () => {
    const before = exchanges.length;
    const client = new Client({ name: "http-spec", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { authorization: "Bearer caller-token" } },
      }),
    );
    const result = await client.callTool({
      name: "invoke_tool",
      arguments: { name: "me", arguments: {} },
    });
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual({ status: 200, body: { ok: true } });
    await client.callTool({
      name: "invoke_tool",
      arguments: { name: "me", arguments: {} },
    });
    await client.close();
    expect(backendSaw.slice(-2)).toEqual([
      "Bearer backend-token-for-caller",
      "Bearer backend-token-for-caller",
    ]);
    expect(backendSaw).not.toContain("Bearer caller-token");
    const made = exchanges
      .slice(before)
      .filter((form) => form.get("subject_token") === "caller-token");
    expect(made.length).toBe(1);
    expect(made[0]?.get("audience")).toBe("backend");
  });

  it("runs a call pinned to the loaded version and refuses a stale one before the backend", async () => {
    const client = new Client({ name: "http-spec", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { authorization: "Bearer caller-token" } },
      }),
    );
    const textOf = (result: unknown): unknown =>
      JSON.parse(
        (result as { content: { text: string }[] }).content[0]?.text ?? "",
      );
    const loaded = textOf(
      await client.callTool({ name: "load_tool", arguments: { name: "me" } }),
    ) as { version: unknown };
    const calls = backendSaw.length;

    const pinned = textOf(
      await client.callTool({
        name: "invoke_tool",
        arguments: { name: "me", arguments: {}, version: loaded.version },
      }),
    );
    const stale = await client.callTool({
      name: "invoke_tool",
      arguments: { name: "me", arguments: {}, version: "0000000000000000" },
    });
    await client.close();

    expect(pinned).toEqual({ status: 200, body: { ok: true } });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toEqual({
      error: "tool_changed",
      message:
        "The tool 'me' changed after it was loaded, so the call was refused before reaching the backend. Load it again with load_tool and retry with the new version.",
      retryable: false,
    });
    expect(backendSaw.length).toBe(calls + 1);
  });
});
