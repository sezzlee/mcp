import "reflect-metadata";
import { createRequire } from "node:module";
import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { McpTool, type McpResponseDeclaration } from "../src/decorators.js";
import {
  discoverEndpoints,
  type DiscoveredEndpoint,
  type DiscoveryDiagnostic,
} from "../src/discovery/endpoint-discovery.js";

const nestMajor = Number(
  (
    createRequire(import.meta.url)("@nestjs/common/package.json") as {
      version: string;
    }
  ).version.split(".")[0],
);

const order = z.object({
  id: z.string(),
  total: z.number().int().min(0),
  note: z.string().optional(),
});

function discover(controller: NewableFunction): {
  endpoints: Map<string, DiscoveredEndpoint>;
  diagnostics: DiscoveryDiagnostic[];
} {
  const diagnostics: DiscoveryDiagnostic[] = [];
  const endpoints = new Map(
    discoverEndpoints([{ metatype: controller }], {
      report: (diagnostic) => diagnostics.push(diagnostic),
    }).map((endpoint) => [endpoint.handlerName, endpoint]),
  );
  return { endpoints, diagnostics };
}

const legacy = {
  "~standard": { version: 1, vendor: "legacy", validate: () => ({ value: 1 }) },
} as unknown as McpResponseDeclaration;

describe("Standard Schema response declarations", () => {
  @Controller("orders")
  @McpTool()
  class ResponsesController {
    @Get(":id")
    @McpTool({ responses: { 200: order, 404: {} } })
    async read(): Promise<unknown> {
      return {};
    }

    @Get()
    @McpTool({ responses: { 200: legacy } })
    list(): unknown {
      return [];
    }
  }

  const { endpoints, diagnostics } = discover(ResponsesController);

  it("publishes the JSON Schema of what the schema produces", () => {
    expect(endpoints.get("read")?.descriptor.responses).toEqual({
      "200": {
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            total: {
              type: "integer",
              minimum: 0,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            note: { type: "string" },
          },
          required: ["id", "total"],
          additionalProperties: false,
        },
      },
      "404": {},
    });
  });

  it("reports a schema it cannot convert and publishes the status without a body schema", () => {
    expect(endpoints.get("list")?.descriptor.responses).toEqual({ "200": {} });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "unreadable_shape",
    ]);
    expect(diagnostics[0]?.message).toContain("ResponsesController.list");
  });
});

describe.runIf(nestMajor >= 12)("Nest 12 argument schemas", () => {
  type Options = { schema: unknown };
  const body = Body as unknown as (options: Options) => ParameterDecorator;
  const query = Query as unknown as (
    nameOrOptions: string | Options,
    options?: Options,
  ) => ParameterDecorator;
  const param = Param as unknown as (
    nameOrOptions: string | Options,
    options?: Options,
  ) => ParameterDecorator;

  @Controller("validated")
  @McpTool()
  class ValidatedController {
    @Post()
    create(@body({ schema: order }) _body: unknown): string {
      return "";
    }

    @Get()
    list(
      @query({
        schema: z.object({
          status: z.enum(["open", "closed"]),
          page: z.coerce.number().int().min(1).optional(),
        }),
      })
      _query: unknown,
    ): string {
      return "";
    }

    @Get("named/:id")
    named(
      @param("id", { schema: z.uuid() }) _id: string,
      @query("q", { schema: z.string().min(2) }) _q: string,
      @query("limit", { schema: z.coerce.number().int().optional() })
      _limit: number,
    ): string {
      return "";
    }

    @Get("whole/:region/:code")
    whole(
      @param({
        schema: z.object({ region: z.enum(["eu", "us"]), code: z.string() }),
      })
      _params: unknown,
    ): string {
      return "";
    }
  }

  const { endpoints, diagnostics } = discover(ValidatedController);
  const descriptorOf = (handler: string) => endpoints.get(handler)?.descriptor;

  it("takes the body schema from @Body({ schema })", () => {
    expect(descriptorOf("create")?.requestBody?.schema).toEqual({
      type: "object",
      properties: {
        id: { type: "string" },
        total: {
          type: "integer",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        note: { type: "string" },
      },
      required: ["id", "total"],
    });
  });

  it("flattens a whole-object @Query({ schema })", () => {
    expect(descriptorOf("list")?.parameters).toEqual([
      {
        name: "status",
        in: "query",
        required: true,
        schema: { type: "string", enum: ["open", "closed"] },
      },
      {
        name: "page",
        in: "query",
        required: false,
        schema: {
          type: "integer",
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        },
      },
    ]);
  });

  it("types named parameters and asks the schema whether a missing one is accepted", () => {
    const byName = new Map(
      descriptorOf("named")?.parameters?.map((p) => [p.name, p]),
    );
    expect(byName.get("id")?.schema).toMatchObject({
      type: "string",
      format: "uuid",
    });
    expect(byName.get("q")).toEqual({
      name: "q",
      in: "query",
      required: true,
      schema: { type: "string", minLength: 2 },
    });
    expect(byName.get("limit")).toEqual({
      name: "limit",
      in: "query",
      required: false,
      schema: {
        type: "integer",
        minimum: Number.MIN_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      },
    });
  });

  it("types path parameters from a whole-object @Param({ schema })", () => {
    expect(descriptorOf("whole")?.parameters).toEqual([
      {
        name: "region",
        in: "path",
        required: true,
        schema: { type: "string", enum: ["eu", "us"] },
      },
      {
        name: "code",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ]);
  });

  it("reports nothing for what it read", () => {
    expect(diagnostics).toEqual([]);
  });
});
