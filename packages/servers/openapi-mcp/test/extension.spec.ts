import { describe, expect, it } from "vitest";
import { buildGatewayCatalog, configSchema, readConfig } from "../src/index.js";

const ok = { "200": { description: "ok" } };

const document = {
  openapi: "3.1.0",
  info: { title: "t", version: "1" },
  servers: [{ url: "https://api.test" }],
  security: [],
  paths: {
    "/hidden": {
      get: {
        operationId: "hidden",
        responses: ok,
        "x-sezzlee": { tool: false },
      },
    },
    "/marked": {
      get: {
        operationId: "marked",
        responses: ok,
        "x-sezzlee": { tool: true },
      },
    },
    "/reopened": {
      get: {
        operationId: "reopened",
        responses: ok,
        "x-sezzlee": { tool: false },
      },
    },
    "/methods/{methodId}": {
      post: {
        operationId: "invokeMethod",
        parameters: [
          {
            name: "methodId",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        responses: ok,
        "x-sezzlee": {
          family: {
            parameter: "methodId",
            members: [
              {
                key: 1,
                name: "get_customer",
                description: "Reads a customer.",
              },
              { key: 2, name: "list_orders", description: "Lists orders." },
            ],
          },
        },
      },
    },
  },
};

async function build(config: Record<string, unknown>) {
  return buildGatewayCatalog(
    document,
    configSchema.parse({ source: "inline", ...config }),
    new Map(),
    [],
    undefined,
    undefined,
  );
}

describe("gateway x-sezzlee", () => {
  it("lets the operation marker outrank the config's rules and default", async () => {
    const { catalog } = await build({
      selection: {
        default: "include",
        rules: [{ route: "/marked", decision: "exclude" }],
      },
    });

    expect(catalog.byName.has("hidden")).toBe(false);
    expect(catalog.byName.has("marked")).toBe(true);
  });

  it("lets a configured operations entry replace the document's marker", async () => {
    const { catalog } = await build({
      operations: { "GET /reopened": { tool: true } },
    });

    expect(catalog.byName.has("reopened")).toBe(true);
    expect(catalog.byName.has("hidden")).toBe(false);
  });

  it("publishes a document family as its members, never the dispatcher", async () => {
    const { catalog } = await build({ selection: { default: "include" } });

    expect(catalog.byName.has("get_customer")).toBe(true);
    expect(catalog.byName.has("list_orders")).toBe(true);
    expect(catalog.byName.has("invoke_method")).toBe(false);
  });

  it("refuses to serve a config whose operations entry names no operation", async () => {
    const gateway = await build({
      operations: { "GET /hiden": { tool: false } },
    });

    expect(
      gateway.ingestion.map(({ code, severity }) => ({ code, severity })),
    ).toEqual([{ code: "extension_target_unknown", severity: "fatal" }]);
    expect(gateway.catalog.byName.size).toBe(0);
  });

  it.each([
    [
      "names",
      { names: { "GET /marked": "marked_tool" } },
      "toolName",
      "other_tool",
    ],
    [
      "searchTerms",
      { searchTerms: { "GET /marked": ["x"] } },
      "searchTerms",
      ["y"],
    ],
    [
      "revision.operations",
      { revision: { operations: { "GET /marked": 2 } } },
      "revision",
      3,
    ],
  ])(
    "rejects %s beside an operations entry declaring the same field",
    (older, declaration, field, value) => {
      const outcome = readConfig(
        {
          source: "inline",
          ...declaration,
          operations: { "GET /marked": { [field]: value } },
        },
        () => undefined,
      );

      expect(outcome.kind).toBe("invalid");
      expect(outcome.kind === "invalid" ? outcome.reason : "").toContain(
        `${older}["GET /marked"] and operations["GET /marked"].${field}`,
      );
    },
  );
});
