import { describe, expect, it } from "vitest";
import { annotateOpenApiDocument } from "../src/index.js";

describe("annotateOpenApiDocument", () => {
  it("excludes every operation the catalog does not name and reports what the document lacks", () => {
    const document = {
      paths: {
        "/orders": {
          parameters: [{ name: "tenant", in: "header" }],
          get: { operationId: "listOrders" },
          post: { operationId: "createOrder" },
        },
        "/mcp": { get: {} },
      },
    };

    const report = annotateOpenApiDocument(document, {
      paths: new Map(),
      operations: new Map([
        ["GET /orders", { tool: true, toolName: "list_orders" }],
        ["GET /orders/export", { tool: true, toolName: "export_orders" }],
        ["GET /stats", { tool: false }],
      ]),
    });

    expect(report).toEqual({
      excluded: ["POST /orders", "GET /mcp"],
      undocumented: ["GET /orders/export"],
    });
    expect(document.paths).toEqual({
      "/orders": {
        parameters: [{ name: "tenant", in: "header" }],
        get: {
          operationId: "listOrders",
          "x-sezzlee": { tool: true, toolName: "list_orders" },
        },
        post: { operationId: "createOrder", "x-sezzlee": { tool: false } },
      },
      "/mcp": { get: { "x-sezzlee": { tool: false } } },
    });
  });
});
