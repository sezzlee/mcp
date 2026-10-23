import { describe, expect, it } from "vitest";
import {
  createTool,
  createToolDefinition,
  invokeResponse,
  SezzleeTemplateError,
} from "../src/index.js";
import type { EndpointDescriptor, InvokeResult } from "../src/index.js";

const auth = { anonymous: "no", policies: [], imperative: false } as const;

function endpoint(overrides: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    method: "POST",
    route: "/orders/{id}",
    auth,
    ...overrides,
  } as EndpointDescriptor;
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof SezzleeTemplateError ? error.code : undefined;
  }
  return undefined;
}

describe("createToolDefinition", () => {
  it("D1: a parameter description fills only a schema that carries none", () => {
    const tool = createToolDefinition(
      endpoint({
        method: "GET",
        route: "/orders/{id}",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer", description: "kendi aciklamasi" },
            description: "dis aciklama",
          },
        ],
      }),
    );
    expect(tool.inputSchema["properties"]).toEqual({
      id: { type: "integer", description: "kendi aciklamasi" },
    });
  });

  it("D3: a parameter name colliding with a body field takes the root argument", () => {
    const tool = createToolDefinition(
      endpoint({
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        requestBody: {
          schema: {
            type: "object",
            properties: { id: { type: "integer" } },
          },
        },
      }),
    );
    expect(Object.keys(tool.inputSchema["properties"] ?? {})).toEqual([
      "id",
      "body",
    ]);
    expect(tool.inputSchema["required"]).toEqual(["id", "body"]);
  });

  it("D3b: the root argument name itself still collides", () => {
    expect(
      codeOf(() =>
        createToolDefinition(
          endpoint({
            route: "/orders/{body}",
            parameters: [
              {
                name: "body",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            requestBody: {
              schema: { type: "array", items: { type: "integer" } },
            },
          }),
        ),
      ),
    ).toBe("argument_collision");
  });

  it("D4: duplicate entries in the body required list collapse", () => {
    const tool = createToolDefinition(
      endpoint({
        route: "/orders",
        requestBody: {
          schema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text", "text"],
          },
        },
      }),
    );
    expect(tool.inputSchema["required"]).toEqual(["text"]);
  });

  it("D5: the root writes type, properties, required and additionalProperties even when empty", () => {
    const tool = createToolDefinition(
      endpoint({ method: "GET", route: "/ping" }),
    );
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it("D6: a request body without properties contributes nothing but opens the schema", () => {
    const tool = createToolDefinition(
      endpoint({
        route: "/orders",
        requestBody: { schema: { type: "object", additionalProperties: true } },
      }),
    );
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: true,
    });
  });

  it("D6b: an optional object body stops flattening and is not required", () => {
    const tool = createToolDefinition(
      endpoint({
        route: "/orders/cancel",
        requestBody: {
          required: false,
          schema: {
            type: "object",
            properties: { reason: { type: "string" } },
            required: ["reason"],
          },
        },
      }),
    );
    expect(tool.inputSchema.properties).toEqual({
      body: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    });
    expect(tool.inputSchema.required).toEqual([]);
  });

  it("D6c: the same body without required:false flattens and keeps its field required", () => {
    const tool = createToolDefinition(
      endpoint({
        route: "/orders/cancel",
        requestBody: {
          schema: {
            type: "object",
            properties: { reason: { type: "string" } },
            required: ["reason"],
          },
        },
      }),
    );
    expect(tool.inputSchema.properties).toEqual({
      reason: { type: "string" },
    });
    expect(tool.inputSchema.required).toEqual(["reason"]);
  });

  it("D6d: an optional non-object body is still wrapped but no longer required", () => {
    const tool = createToolDefinition(
      endpoint({
        route: "/import",
        requestBody: {
          required: false,
          schema: { type: "array", items: { type: "integer" } },
        },
      }),
    );
    expect(tool.inputSchema.required).toEqual([]);
    expect(tool.inputSchema.properties).toEqual({
      body: { type: "array", items: { type: "integer" } },
    });
  });

  it("D7: a required entry naming an undeclared property is ignored", () => {
    const tool = createToolDefinition(
      endpoint({
        route: "/orders",
        requestBody: {
          schema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text", "ghost"],
          },
        },
      }),
    );
    expect(tool.inputSchema["required"]).toEqual(["text"]);
  });
});

describe("createTool", () => {
  it("D8: definition and template come from one descriptor", () => {
    const tool = createTool(
      endpoint({
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        requestBody: {
          schema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      }),
    );
    expect(tool.definition.inputSchema["required"]).toEqual(["id", "text"]);
    expect(tool.template.hasBody).toBe(true);
    expect([...tool.template.bodyProperties]).toEqual(["text"]);
    expect(tool.template.parameters[0]?.kind).toBe("integer");
  });

  it("D9: both entry points wrap the same collision identically", () => {
    const colliding = endpoint({
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "integer" } },
      ],
      requestBody: {
        schema: { type: "object", properties: { id: { type: "integer" } } },
      },
    });
    const tool = createTool(colliding);
    expect(
      Object.keys(
        createToolDefinition(colliding).inputSchema["properties"] ?? {},
      ),
    ).toEqual(["id", "body"]);
    expect(tool.template.bodyRoot).toBe("body");
    expect([...tool.template.bodyProperties]).toEqual([]);
  });
});

describe("an object-valued query parameter", () => {
  const filter = (
    overrides: Record<string, unknown> = {},
    properties: Record<string, unknown> = {
      status: { type: "string" },
      min: { type: "integer" },
    },
  ): EndpointDescriptor =>
    endpoint({
      method: "GET",
      route: "/orders",
      parameters: [
        {
          name: "filter",
          in: "query",
          required: false,
          style: "deepObject",
          schema: { type: "object", properties },
          ...overrides,
        },
      ],
    } as Partial<EndpointDescriptor>);

  it("publishes one nested property, not one per member", () => {
    const tool = createTool(filter());
    expect(Object.keys(tool.definition.inputSchema.properties ?? {})).toEqual([
      "filter",
    ]);
    expect(tool.definition.inputSchema.properties?.["filter"]).toEqual({
      type: "object",
      properties: { status: { type: "string" }, min: { type: "integer" } },
    });
  });

  it("freezes the descriptor's property order into the binding", () => {
    const tool = createTool(
      filter({}, { z: { type: "string" }, a: { type: "string" } }),
    );
    expect(
      tool.template.parameters[0]?.kind === "object" &&
        tool.template.parameters[0].members.map((m) => m.name),
    ).toEqual(["z", "a"]);
  });

  it("defaults the notation to bracket and carries dot when declared", () => {
    const notationOf = (descriptor: EndpointDescriptor): unknown => {
      const binding = createTool(descriptor).template.parameters[0];
      return binding?.kind === "object" ? binding.notation : undefined;
    };
    expect(notationOf(filter())).toBe("bracket");
    expect(notationOf(filter({ objectNotation: "dot" }))).toBe("dot");
  });

  it("refuses an object schema that does not declare deepObject", () => {
    expect(codeOf(() => createTool(filter({ style: undefined })))).toBe(
      "unsupported_object_style",
    );
  });

  it("refuses deepObject with an explicit explode false", () => {
    expect(codeOf(() => createTool(filter({ explode: false })))).toBe(
      "unsupported_object_style",
    );
  });

  it("refuses a member that is not a query scalar or an array of them", () => {
    for (const member of [
      { type: "object", properties: {} },
      { type: "array", items: { type: "object" } },
      { $ref: "#/$defs/Range" },
    ]) {
      expect(codeOf(() => createTool(filter({}, { range: member })))).toBe(
        "unsupported_object_nesting",
      );
    }
  });

  it("accepts an array-of-scalar member", () => {
    const tool = createTool(
      filter({}, { tags: { type: "array", items: { type: "string" } } }),
    );
    const binding = tool.template.parameters[0];
    expect(binding?.kind === "object" && binding.members).toEqual([
      { name: "tags", kind: "string", isArray: true },
    ]);
  });
});

describe("invokeResponse", () => {
  const listOrders = endpoint({
    method: "GET",
    route: "/orders",
    responses: {
      "200": { schema: { type: "array", items: { type: "object" } } },
    },
  });
  const getOrder = endpoint({
    method: "GET",
    route: "/orders/{id}",
    responses: {
      "200": {
        schema: { type: "object", properties: { id: { type: "integer" } } },
      },
    },
  });
  const ping = endpoint({ method: "GET", route: "/ping" });

  it.each<[string, EndpointDescriptor, InvokeResult, unknown, boolean]>([
    [
      "an array root comes back under result",
      listOrders,
      { status: 200, body: [{ id: 1 }, { id: 2 }] },
      { status: 200, body: { result: [{ id: 1 }, { id: 2 }] } },
      false,
    ],
    [
      "a JSON null under an array schema is wrapped too",
      listOrders,
      { status: 200, body: null },
      { status: 200, body: { result: null } },
      false,
    ],
    [
      "an object root comes back as it is",
      getOrder,
      { status: 200, body: { id: 1 } },
      { status: 200, body: { id: 1 } },
      false,
    ],
    [
      "an endpoint with no declared response is never wrapped",
      ping,
      { status: 200, body: ["pong"] },
      { status: 200, body: ["pong"] },
      false,
    ],
    [
      "a raw-string body the schema does not describe is never wrapped",
      listOrders,
      { status: 200, body: "<html/>", contentType: "text/html" },
      { status: 200, body: "<html/>", contentType: "text/html" },
      false,
    ],
    [
      "an absent body stays absent",
      listOrders,
      { status: 204 },
      { status: 204 },
      false,
    ],
    [
      "a mapped backend error is never wrapped",
      listOrders,
      {
        error: "not_found",
        message: "No such order.",
        status: 404,
        retryable: false,
      },
      {
        error: "not_found",
        message: "No such order.",
        status: 404,
        retryable: false,
      },
      true,
    ],
  ])("%s", (_case, descriptor, outcome, payload, isError) => {
    const entry = {
      tool: createToolDefinition(descriptor),
      descriptor,
      owner: "test",
    };
    const response = invokeResponse(entry, outcome, undefined);
    expect(response.payload).toEqual(payload);
    expect(response.isError).toBe(isError);
  });
});
