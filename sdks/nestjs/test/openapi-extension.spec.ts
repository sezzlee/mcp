import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { ToolDefinition } from "@sezzlee/core";
import { buildGatewayCatalog, configSchema } from "@sezzlee/openapi-mcp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SezzleeCatalog } from "../src/catalog.js";
import {
  hidden,
  McpTool,
  McpToolFamily,
  McpVariant,
} from "../src/decorators.js";
import type { McpFamilyMember } from "../src/families.js";
import {
  annotateOpenApiDocument,
  type VisibilityDeclaration,
} from "../src/index.js";
import { SezzleeModule } from "../src/sezzlee.module.js";

class AnonymousGuard {
  canActivate(): boolean {
    return true;
  }

  describeVisibility(): VisibilityDeclaration {
    return { anonymous: "yes", policies: [] };
  }
}

@Controller("orders")
class OrdersController {
  @Get(":orderId")
  @McpTool({
    name: "read_order",
    readOnly: true,
    arguments: {
      orderId: { as: "id", description: "The order number." },
      tenant: hidden.value("acme"),
    },
  })
  @UseGuards(AnonymousGuard)
  read(
    @Param("orderId") _orderId: string,
    @Query("tenant") _tenant?: string,
  ): void {}

  @Get("health")
  @McpTool({ description: "Reports whether the order service is up." })
  @UseGuards(AnonymousGuard)
  health(): void {}

  @Get("internal")
  @UseGuards(AnonymousGuard)
  internal(): void {}
}

@Controller("reports")
class ReportsController {
  @Post()
  @McpTool({ description: "Runs the sales report." })
  @McpVariant({
    name: "sales_report_csv",
    description: "Runs the sales report as CSV.",
    arguments: { format: hidden.value("csv") },
  })
  @McpVariant({
    name: "sales_report",
    description: "Runs the sales report in a chosen format.",
  })
  @UseGuards(AnonymousGuard)
  run(@Query("format") _format?: string): void {}
}

@Controller("methods")
class MethodsController {
  @Post("static/:methodId")
  @McpTool({ description: "Runs a fixed method." })
  @McpToolFamily({ parameter: "methodId" })
  @McpVariant({
    name: "run_alpha",
    description: "Runs the alpha method.",
    arguments: { methodId: hidden.value("alpha") },
  })
  @McpVariant({
    name: "run_beta",
    description: "Runs the beta method.",
    arguments: { methodId: hidden.value("beta") },
  })
  @UseGuards(AnonymousGuard)
  runStatic(@Param("methodId") _methodId: string): void {}

  @Post("legacy/:methodId")
  @McpTool({ description: "Runs a legacy method by its id." })
  @McpToolFamily({ parameter: "methodId", source: "unregistered" })
  @UseGuards(AnonymousGuard)
  runLegacy(
    @Param("methodId") _methodId: string,
    @Body() _body: Record<string, unknown>,
  ): void {}

  @Post("dynamic/:methodId")
  @McpTool({ description: "Runs a method by its id." })
  @McpToolFamily({ parameter: "methodId", source: "methods" })
  @UseGuards(AnonymousGuard)
  runDynamic(
    @Param("methodId") _methodId: string,
    @Body() _body: Record<string, unknown>,
  ): void {}
}

const balances: McpFamilyMember = {
  key: "7",
  name: "list_customer_balances",
  description: "Lists customer balances.",
  body: {
    type: "object",
    properties: { minBalance: { type: "number" } },
  },
  readOnly: true,
};

function surfaceOf(tool: ToolDefinition): Record<string, unknown> {
  return {
    arguments: Object.keys(tool.inputSchema.properties ?? {}).sort(),
    annotations: Object.fromEntries(
      Object.entries(tool.annotations).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      SezzleeModule.forRoot((options) => {
        options.families.provide("methods", () => [balances]);
      }),
    ],
    controllers: [OrdersController, ReportsController, MethodsController],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe("x-sezzlee from the NestJS catalog", () => {
  it("lets the gateway rebuild every tool from the document it annotates, even including by default", async () => {
    const catalog = app.get(SezzleeCatalog);
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    annotateOpenApiDocument(document, catalog.openApiExtensions());

    const gateway = await buildGatewayCatalog(
      JSON.stringify(document),
      configSchema.parse({
        source: "inline",
        baseUrl: "http://localhost",
        selection: { default: "include" },
      }),
      new Map(),
      [],
      undefined,
      undefined,
    );

    const surfaces = (entries: Iterable<[string, { tool: ToolDefinition }]>) =>
      [...entries]
        .map(([name, entry]) => [name, surfaceOf(entry.tool)] as const)
        .sort(([a], [b]) => a.localeCompare(b));
    expect(surfaces(gateway.catalog.byName)).toEqual(
      surfaces(catalog.current.byName),
    );
  });
});
