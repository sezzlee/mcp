import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  buildGatewayCatalog,
  configSchema,
  createBoundedFetch,
  createCatalogReloader,
  createOpenApiMcpServer,
  fetchDocument,
  type DocumentValidators,
} from "../src/index.js";

interface Served {
  body: string;
  etag: string | undefined;
}

let server: Server;
let origin: string;
let served: Served;
let reads: number;
let conditions: (string | undefined)[];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url !== "/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    reads += 1;
    const condition = req.headers["if-none-match"];
    conditions.push(condition);
    if (served.etag !== undefined && condition === served.etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      ...(served.etag === undefined ? {} : { etag: served.etag }),
    });
    res.end(served.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  reads = 0;
  conditions = [];
});

const ok = { "200": { description: "ok" } };

const documentOf = (
  paths: Record<string, unknown>,
  serverUrl = `${origin}/v1`,
  openapi = "3.1.0",
): string =>
  JSON.stringify({
    openapi,
    info: { title: "t", version: "1" },
    servers: [{ url: serverUrl }],
    security: [],
    paths,
  });

const first = () =>
  documentOf({
    "/a": { get: { operationId: "getA", responses: ok } },
    "/b": { get: { operationId: "getB", responses: ok } },
  });

const second = () =>
  documentOf({
    "/a": {
      get: {
        operationId: "getA",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer" } },
        ],
        responses: ok,
      },
    },
    "/c": { get: { operationId: "getC", responses: ok } },
  });

async function start(body: string, etag: string | undefined = "v1") {
  served = { body, etag };
  const config = configSchema.parse({
    source: `${origin}/openapi.json`,
    selection: { default: "include" },
  });
  const fetch = createBoundedFetch(new Set([new URL(origin).host]));
  const read = (validators: DocumentValidators) =>
    fetchDocument({
      fetch,
      url: new URL(`${origin}/openapi.json`),
      validators,
      timeoutMs: 2000,
      maxBytes: 1024 * 1024,
    });
  const build = (text: string) =>
    buildGatewayCatalog(
      text,
      config,
      new Map(),
      [],
      `${origin}/openapi.json`,
      undefined,
    );
  const opening = await read({});
  if (opening.kind !== "document") {
    throw new Error("the first read must return the document");
  }
  const reloader = createCatalogReloader({
    initial: await build(opening.text),
    text: opening.text,
    validators: opening.validators,
    read,
    build,
    describe: String,
  });
  const mcp = createOpenApiMcpServer(reloader, fetch, config.limits, {
    announce: true,
  });
  const client = new Client({ name: "reload-spec", version: "0.0.0" });
  let announced = 0;
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    announced += 1;
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse(
      (result as { content: { text: string }[] }).content[0]?.text ?? "",
    ) as Record<string, unknown>;
  };
  return { reloader, client, call, announced: () => announced };
}

describe("openapi-mcp document reload", () => {
  it("serves the new document after a reload: a removed tool is unknown and a call pinned to a changed one is refused", async () => {
    const { reloader, client, call } = await start(first());
    const loaded = await call("load_tool", { name: "get_a" });

    served = { body: second(), etag: "v2" };
    const outcome = await reloader.reload();

    expect(outcome.kind).toBe("reloaded");
    expect((await call("load_tool", { name: "get_c" })).error).toBeUndefined();
    expect((await call("load_tool", { name: "get_b" })).error).toBe(
      "unknown_tool",
    );
    expect(
      (
        await call("invoke_tool", {
          name: "get_a",
          arguments: {},
          version: loaded["version"],
        })
      ).error,
    ).toBe("tool_changed");
    await client.close();
  });

  it("stamps the catalog generation on every meta-tool and announces a reload once", async () => {
    const { reloader, client, announced } = await start(first());
    const generations = async () =>
      (await client.listTools()).tools.map(
        (tool) => tool._meta?.["sezzlee/catalogGeneration"],
      );
    const before = await generations();

    served = { body: second(), etag: "v2" };
    await reloader.reload();
    await vi.waitFor(() => {
      expect(announced()).toBeGreaterThan(0);
    });
    const after = await generations();

    expect(before).toEqual([1, 1, 1]);
    expect(after).toEqual([2, 2, 2]);
    expect(announced()).toBe(1);
    await client.close();
  });

  it("asks with the last ETag and treats a 304 as unchanged", async () => {
    const { reloader, client } = await start(first());

    const outcome = await reloader.reload();

    expect(conditions).toEqual([undefined, "v1"]);
    expect(outcome).toEqual({ kind: "unchanged" });
    expect(reloader.current().generation).toBe(1);
    await client.close();
  });

  it("treats an identical body from a source without validators as unchanged", async () => {
    const { reloader, client } = await start(first(), undefined);

    const outcome = await reloader.reload();

    expect(outcome).toEqual({ kind: "unchanged" });
    expect(reloader.current().generation).toBe(1);
    await client.close();
  });

  it("keeps the running catalog when the new document is fatal", async () => {
    const { reloader, client, call } = await start(first());

    served = {
      body: documentOf(
        { "/c": { get: { operationId: "getC", responses: ok } } },
        `${origin}/v1`,
        "9.0.0",
      ),
      etag: "v2",
    };
    const outcome = await reloader.reload();

    expect(outcome.kind === "kept" && outcome.reason).toBe("fatal");
    expect(reloader.current().generation).toBe(1);
    expect((await call("load_tool", { name: "get_b" })).error).toBeUndefined();
    await client.close();
  });

  it("refuses a document that moves its operations to a host the running catalog does not call", async () => {
    const { reloader, client, call } = await start(first());

    served = {
      body: documentOf(
        { "/a": { get: { operationId: "getA", responses: ok } } },
        "http://elsewhere.test/v1",
      ),
      etag: "v2",
    };
    const outcome = await reloader.reload();

    expect(outcome.kind === "kept" && outcome.reason).toBe("widens_egress");
    expect(reloader.current().generation).toBe(1);
    expect((await call("load_tool", { name: "get_b" })).error).toBeUndefined();
    await client.close();
  });

  it("runs one reload at a time and folds a burst of triggers into one more", async () => {
    const { reloader, client } = await start(first());
    const opening = reads;

    served = { body: second(), etag: "v2" };
    await Promise.all([
      reloader.reload(),
      reloader.reload(),
      reloader.reload(),
    ]);

    expect(reads - opening).toBe(2);
    expect(reloader.current().generation).toBe(2);
    await client.close();
  });
});
