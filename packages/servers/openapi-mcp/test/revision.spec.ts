import { describe, expect, it } from "vitest";
import { buildGatewayCatalog, configSchema } from "../src/index.js";

const document = {
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  "x-sezzlee-revision": 1,
  servers: [{ url: "https://api.test/v1" }],
  security: [],
  paths: {
    "/orders": {
      "x-sezzlee-revision": 4,
      post: {
        operationId: "createOrder",
        "x-sezzlee-revision": 2,
        responses: { "200": { description: "ok" } },
      },
      get: {
        operationId: "listOrders",
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

async function build(revision: unknown) {
  return buildGatewayCatalog(
    document,
    configSchema.parse({
      source: "inline",
      selection: { default: "include" },
      ...(revision === undefined ? {} : { revision }),
    }),
    new Map(),
    [],
    undefined,
    undefined,
  );
}

describe("gateway revisions", () => {
  it("carries the document's levels to the tool without one replacing another", async () => {
    const { catalog } = await build(undefined);

    expect(catalog.byName.get("create_order")?.tool.revision).toEqual({
      catalog: 1,
      container: 4,
      operation: 2,
    });
    expect(catalog.byName.get("list_orders")?.tool.revision).toEqual({
      catalog: 1,
      container: 4,
    });
  });

  it("lets the configuration raise a level the document declares, and reports the hidden one", async () => {
    const { catalog } = await build({
      catalog: 3,
      paths: { "/orders": 5 },
      operations: { "GET /orders": 6 },
    });

    expect(catalog.byName.get("list_orders")?.tool.revision).toEqual({
      catalog: 3,
      container: 5,
      operation: 6,
    });
    expect(
      catalog.diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === "revision_overridden" &&
          diagnostic.message.startsWith("POST /orders:"),
      ),
    ).toHaveLength(2);
  });

  it.each([0, -1, 1.5, "2"])(
    "refuses a configured revision of %j at startup",
    (value) => {
      expect(() =>
        configSchema.parse({
          source: "inline",
          revision: { operations: { "GET /orders": value } },
        }),
      ).toThrow(/revision/);
    },
  );
});
