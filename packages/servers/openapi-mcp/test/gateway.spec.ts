import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildGatewayCatalog,
  configSchema,
  createBoundedFetch,
  invokeEntry,
  type GatewayCatalog,
} from "../src/index.js";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let origin: string;
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.url?.startsWith("/v1/moved") === true) {
        res.writeHead(302, { location: "http://elsewhere.test/steal" });
        res.end();
        return;
      }
      if (req.url?.startsWith("/v1/big") === true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ blob: "x".repeat(4096) }));
        return;
      }
      if (req.url?.startsWith("/v1/slow") === true) {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        }, 500);
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "backend_session=secret",
      });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const document = () => ({
  openapi: "3.2.0",
  info: { title: "t", version: "1" },
  servers: [{ url: `${origin}/v1` }],
  components: {
    securitySchemes: {
      Key: { type: "apiKey", in: "header", name: "X-API-Key" },
      Session: { type: "apiKey", in: "cookie", name: "sid" },
    },
  },
  security: [{ Key: [], Session: [] }],
  paths: {
    "/items/{ids}": {
      get: {
        operationId: "getItems",
        parameters: [
          {
            name: "ids",
            in: "path",
            required: true,
            style: "matrix",
            schema: { type: "array", items: { type: "integer" } },
          },
          { name: "lang", in: "cookie", schema: { type: "string" } },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/items": {
      post: {
        operationId: "createItem",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
    "/search": {
      query: {
        operationId: "searchItems",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { term: { type: "string" } },
              },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
    "/avatar": {
      put: {
        operationId: "putAvatar",
        requestBody: {
          required: true,
          content: {
            "image/png": { schema: { type: "string", format: "binary" } },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
    "/filtered": {
      get: {
        operationId: "filtered",
        parameters: [
          {
            name: "filter",
            in: "query",
            content: { "application/json": { schema: { type: "object" } } },
          },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/moved": {
      get: {
        operationId: "moved",
        responses: { "200": { description: "ok" } },
      },
    },
    "/big": {
      get: { operationId: "big", responses: { "200": { description: "ok" } } },
    },
    "/slow": {
      get: { operationId: "slow", responses: { "200": { description: "ok" } } },
    },
    "/elsewhere": {
      servers: [{ url: "http://elsewhere.test" }],
      get: {
        operationId: "elsewhere",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

async function gatewayOf(): Promise<GatewayCatalog> {
  const config = configSchema.parse({
    source: "inline",
    selection: { default: "include" },
    credentials: {
      Key: { value: { fromEnv: "KEY" } },
      Session: { value: { fromEnv: "SID" } },
    },
  });
  return buildGatewayCatalog(
    document(),
    config,
    new Map([
      ["Key", { kind: "value", value: "k-123" }],
      ["Session", { kind: "value", value: "s-456" }],
    ]),
    [],
    undefined,
    undefined,
  );
}

const limits = {
  timeoutMs: 5000,
  maxResponseBytes: 1024,
  maxInlineFileBytes: 1024,
};

function payloadOf(response: { payload: unknown }): Record<string, unknown> {
  return response.payload as Record<string, unknown>;
}

describe("openapi-mcp gateway", () => {
  it("drops an operation served by a host outside the allowlist", async () => {
    const gateway = await gatewayOf();
    expect(gateway.dropped.map((d) => d.code)).toEqual([
      "server_host_not_allowed",
    ]);
    expect([...gateway.catalog.byName.keys()].sort()).toEqual([
      "big",
      "create_item",
      "filtered",
      "get_items",
      "moved",
      "put_avatar",
      "search_items",
      "slow",
    ]);
  });

  it("writes path style, credentials and cookies, and never returns the backend's cookie", async () => {
    const gateway = await gatewayOf();
    const fetcher = createBoundedFetch(gateway.allowedHosts);
    const entry = gateway.catalog.byName.get("get_items")!;
    const response = await invokeEntry(
      entry,
      { ids: [1, 2], lang: "tr" },
      fetcher,
      limits,
      undefined,
    );
    expect(response.isError).toBe(false);
    const request = seen.at(-1)!;
    expect(request.url).toBe("/v1/items/;ids=1,2");
    expect(request.headers["x-api-key"]).toBe("k-123");
    expect(request.headers["cookie"]).toBe("sid=s-456; lang=tr");
    expect(JSON.stringify(response.payload)).not.toContain("backend_session");
  });

  it("sends a JSON body", async () => {
    const gateway = await gatewayOf();
    const fetcher = createBoundedFetch(gateway.allowedHosts);
    const response = await invokeEntry(
      gateway.catalog.byName.get("create_item")!,
      { name: "a" },
      fetcher,
      limits,
      undefined,
    );
    expect(response.isError).toBe(false);
    const request = seen.at(-1)!;
    expect(request.method).toBe("POST");
    expect(request.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(JSON.parse(request.body)).toEqual({ name: "a" });
  });

  it("sends a QUERY with a body, a binary body and a JSON-content parameter", async () => {
    const gateway = await gatewayOf();
    const fetcher = createBoundedFetch(gateway.allowedHosts);
    const query = await invokeEntry(
      gateway.catalog.byName.get("search_items")!,
      { term: "x" },
      fetcher,
      limits,
      undefined,
    );
    expect(query.isError).toBe(false);
    expect(seen.at(-1)).toMatchObject({
      method: "QUERY",
      url: "/v1/search",
      body: '{"term":"x"}',
    });

    const avatar = await invokeEntry(
      gateway.catalog.byName.get("put_avatar")!,
      { body: { base64: "aGVsbG8=" } },
      fetcher,
      limits,
      undefined,
    );
    expect(avatar.isError).toBe(false);
    expect(seen.at(-1)?.headers["content-type"]).toBe("image/png");
    expect(seen.at(-1)?.body).toBe("hello");

    const filtered = await invokeEntry(
      gateway.catalog.byName.get("filtered")!,
      { filter: { a: 1 } },
      fetcher,
      limits,
      undefined,
    );
    expect(filtered.isError).toBe(false);
    expect(seen.at(-1)?.url).toBe("/v1/filtered?filter=%7B%22a%22%3A1%7D");
  });

  it("returns a redirect without following it", async () => {
    const gateway = await gatewayOf();
    const fetcher = createBoundedFetch(gateway.allowedHosts);
    const before = seen.length;
    const response = await invokeEntry(
      gateway.catalog.byName.get("moved")!,
      {},
      fetcher,
      limits,
      undefined,
    );
    expect(seen.length).toBe(before + 1);
    expect(JSON.stringify(response.payload)).toContain("elsewhere.test");
  });

  it("stops reading a response over the byte cap", async () => {
    const gateway = await gatewayOf();
    const fetcher = createBoundedFetch(gateway.allowedHosts);
    const response = await invokeEntry(
      gateway.catalog.byName.get("big")!,
      {},
      fetcher,
      limits,
      undefined,
    );
    expect(response.isError).toBe(true);
    expect(payloadOf(response)["error"]).toBe("response_too_large");
  });

  it("abandons a call past the deadline", async () => {
    const gateway = await gatewayOf();
    const fetcher = createBoundedFetch(gateway.allowedHosts);
    const response = await invokeEntry(
      gateway.catalog.byName.get("slow")!,
      {},
      fetcher,
      { ...limits, timeoutMs: 200 },
      undefined,
    );
    expect(response.isError).toBe(true);
    expect(payloadOf(response)["error"]).toBe("invoke_timeout");
  });

  it("never accepts the credential cookie as an argument", async () => {
    const gateway = await gatewayOf();
    const fetcher = createBoundedFetch(gateway.allowedHosts);
    const entry = gateway.catalog.byName.get("get_items")!;
    const response = await invokeEntry(
      entry,
      { ids: [1], lang: "tr" },
      fetcher,
      limits,
      undefined,
    );
    expect(response.isError).toBe(false);
    const unknown = await invokeEntry(
      entry,
      { ids: [1], sid: "x" },
      fetcher,
      limits,
      undefined,
    );
    expect(payloadOf(unknown)["error"]).toBe("unknown_argument");
  });
});
