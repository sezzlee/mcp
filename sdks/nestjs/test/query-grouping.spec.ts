import "reflect-metadata";
import { Controller, Get, Query } from "@nestjs/common";
import { IsInt, IsOptional, IsString } from "class-validator";
import { beforeAll, describe, expect, it } from "vitest";
import { SezzleeCatalog } from "../src/catalog.js";
import { McpTool } from "../src/decorators.js";
import { SezzleeModule } from "../src/sezzlee.module.js";
import {
  discoverEndpoints,
  type DiscoveryDiagnostic,
} from "../src/discovery/endpoint-discovery.js";
import { Test } from "@nestjs/testing";

class OrderFilter {
  @IsString()
  @IsOptional()
  status?: string;

  @IsInt()
  @IsOptional()
  min?: number;
}

class OpaqueFilter {
  status?: string;
}

@Controller("orders")
@McpTool()
class GroupedController {
  @Get("search")
  search(@Query("filter") _filter: OrderFilter): string {
    return "ok";
  }

  @Get("opaque")
  opaque(@Query("filter") _filter: OpaqueFilter): string {
    return "ok";
  }

  @Get("plain")
  plain(@Query("q") _q: string): string {
    return "ok";
  }
}

function discover(grouping: "flatten" | "group"): {
  routes: Map<string, ReturnType<typeof discoverEndpoints>[number]>;
  diagnostics: DiscoveryDiagnostic[];
} {
  const diagnostics: DiscoveryDiagnostic[] = [];
  const found = discoverEndpoints([{ metatype: GroupedController }], {
    queryGrouping: grouping,
    report: (diagnostic) => diagnostics.push(diagnostic),
  });
  return {
    routes: new Map(found.map((entry) => [entry.handlerName, entry])),
    diagnostics,
  };
}

const parametersOf = (
  result: ReturnType<typeof discover>,
  handler: string,
): unknown => result.routes.get(handler)?.descriptor.parameters;

describe("query grouping", () => {
  it("G1: flatten is the default and changes nothing about today's binding", () => {
    expect(parametersOf(discover("flatten"), "search")).toEqual([
      {
        name: "filter",
        in: "query",
        required: false,
        schema: { type: "string" },
      },
    ]);
  });

  it("G2: group folds a readable DTO into one deepObject parameter", () => {
    expect(parametersOf(discover("group"), "search")).toEqual([
      {
        name: "filter",
        in: "query",
        required: false,
        style: "deepObject",
        objectNotation: "bracket",
        schema: {
          type: "object",
          properties: { status: { type: "string" }, min: { type: "integer" } },
          additionalProperties: false,
        },
      },
    ]);
  });

  it("G3: an unreadable shape declines to group rather than dropping the endpoint", () => {
    const grouped = discover("group");
    expect(parametersOf(grouped, "opaque")).toEqual([
      {
        name: "filter",
        in: "query",
        required: false,
        schema: { type: "string" },
      },
    ]);
    expect(
      grouped.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unbound_query_object" &&
          diagnostic.message.includes(".opaque "),
      ),
    ).toBe(true);
  });

  it("G4: a scalar @Query('q') is untouched in either mode", () => {
    for (const mode of ["flatten", "group"] as const) {
      expect(parametersOf(discover(mode), "plain")).toEqual([
        { name: "q", in: "query", required: false, schema: { type: "string" } },
      ]);
    }
  });
});

describe("the Express query parser guard", () => {
  let catalog: SezzleeCatalog;
  let failure: unknown;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SezzleeModule.forRoot((options) => {
          options.selection.default = "include";
          options.query.grouping = "group";
        }),
      ],
      controllers: [GroupedController],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.getHttpAdapter().getInstance().set("query parser", "simple");
    failure = await app.init().then(
      () => undefined,
      (error: unknown) => error,
    );
    catalog = app.get(SezzleeCatalog);
  });

  /**
   * Guard: Express 5 defaults `query parser` to `simple` and Express 4 to `extended`, so the host
   * sets it explicitly; under `simple` `filter[status]` arrives as one literal key and the DTO binds
   * nothing.
   */
  it("G5: reports query_parser_not_extended on a host that parses queries as simple", () => {
    expect(catalog.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "query_parser_not_extended",
    );
  });

  it("G6: is fatal, so the application refuses to start", () => {
    expect(failure).toMatchObject({
      name: "SezzleeCatalogError",
      code: "query_parser_not_extended",
    });
  });
});
