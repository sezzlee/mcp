import "reflect-metadata";
import {
  All,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  DocumentBuilder,
  SwaggerModule,
} from "@nestjs/swagger";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  buildGatewayCatalog,
  configSchema,
  createBoundedFetch,
  createOpenApiMcpServer,
} from "@sezzlee/openapi-mcp";
import {
  MemoryResultStore,
  type InvokeStored,
  type ReadResult,
} from "@sezzlee/core";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from "class-validator";
import type { Request, Response } from "express";
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
import { SezzleeMcpEndpoint } from "../src/transport/mcp-endpoint.js";
import type { SezzleeRequestHandler } from "../src/transport/streamable-http.js";

class AnonymousGuard {
  canActivate(): boolean {
    return true;
  }

  describeVisibility(): VisibilityDeclaration {
    return { anonymous: "yes", policies: [] };
  }
}

class AddressDto {
  @ApiProperty({ description: "Street line." })
  @IsString()
  street!: string;

  @ApiProperty()
  @IsString()
  city!: string;
}

class CreateOrderDto {
  @ApiProperty({ description: "The customer placing the order." })
  @IsInt()
  customerId!: number;

  @ApiProperty({ type: AddressDto })
  @ValidateNested()
  @Type(() => AddressDto)
  shipTo!: AddressDto;

  @ApiPropertyOptional({ type: AddressDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  billTo?: AddressDto;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsString({ each: true })
  notes?: string[];
}

class OrderDto {
  @ApiProperty()
  @IsInt()
  id!: number;

  @ApiProperty({ enum: ["open", "closed"] })
  @IsIn(["open", "closed"])
  status!: string;

  @ApiProperty({ type: AddressDto })
  @ValidateNested()
  @Type(() => AddressDto)
  shipTo!: AddressDto;
}

class ListOrdersQuery {
  @ApiPropertyOptional({ description: "Most rows to return." })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({ enum: ["open", "closed"] })
  @IsOptional()
  @IsIn(["open", "closed"])
  status?: string;
}

class ArchiveQuery {
  year?: number;
}

const labelBytes = Buffer.from("JVBERi0xLjcK4uPP0w==", "base64");

const order: OrderDto = {
  id: 7,
  status: "open",
  shipTo: { street: "1 Main", city: "Izmir" },
};

@ApiTags("sales")
@Controller("orders")
@UseGuards(AnonymousGuard)
class OrdersController {
  @Get()
  @ApiOperation({
    summary: "List orders",
    description: "Lists orders, newest first.",
  })
  @ApiOkResponse({ type: [OrderDto] })
  @McpTool({ readOnly: true })
  list(@Query() _query: ListOrdersQuery): OrderDto[] {
    return [order];
  }

  @Get("archive")
  @McpTool({ readOnly: true })
  archive(@Query() _query: ArchiveQuery): OrderDto[] {
    return [];
  }

  @Get("stats")
  stats(): { count: number } {
    return { count: 1 };
  }

  @Get("history")
  @ApiOkResponse({ type: [OrderDto] })
  @McpTool({ readOnly: true, description: "Lists every order ever placed." })
  history(): OrderDto[] {
    return Array.from({ length: 5_000 }, (_value, id) => ({ ...order, id }));
  }

  @Get([":id", "by-id/:id"])
  @ApiOkResponse({ type: OrderDto })
  @McpTool({
    name: "read_order",
    readOnly: true,
    arguments: { id: { as: "orderId", description: "The order number." } },
  })
  read(@Param("id") _id: string): OrderDto {
    return order;
  }

  @Post()
  @ApiOperation({ summary: "Create order" })
  @ApiCreatedResponse({ type: OrderDto })
  @McpTool()
  create(@Body() _dto: CreateOrderDto): OrderDto {
    return order;
  }

  @Delete(":id")
  @HttpCode(204)
  @McpTool({ description: "Cancels an order." })
  cancel(@Param("id") _id: string): void {}

  @Get(":id/label")
  @McpTool({ description: "Downloads an order's shipping label." })
  label(@Param("id") _id: string): StreamableFile {
    return new StreamableFile(labelBytes, { type: "application/pdf" });
  }
}

@ApiTags("sales")
@Controller("customers")
@UseGuards(AnonymousGuard)
class CustomersController {
  @Get()
  @McpTool({ readOnly: true, description: "Lists customers." })
  list(): { id: number }[] {
    return [{ id: 1 }];
  }
}

@Controller("reports")
@UseGuards(AnonymousGuard)
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
  run(@Query("format") format?: string): { format: string | null } {
    return { format: format ?? null };
  }
}

@Controller("methods")
@UseGuards(AnonymousGuard)
class MethodsController {
  @Post("static/:methodId")
  @McpTool({ description: "Runs an order method." })
  @McpToolFamily({ parameter: "methodId" })
  @McpVariant({
    name: "ship_order",
    description: "Ships an order.",
    arguments: { methodId: hidden.value("ship") },
  })
  @McpVariant({
    name: "bill_order",
    description: "Bills an order.",
    arguments: { methodId: hidden.value("bill") },
  })
  runStatic(
    @Param("methodId") methodId: string,
    @Body() _dto: CreateOrderDto,
  ): { ran: string } {
    return { ran: methodId };
  }

  @Post("legacy/:methodId")
  @McpTool({ description: "Runs a legacy method by its id." })
  @McpToolFamily({ parameter: "methodId", source: "unregistered" })
  runLegacy(
    @Param("methodId") _methodId: string,
    @Body() _body: Record<string, unknown>,
  ): void {}

  @Post("dynamic/:methodId")
  @McpTool({ description: "Runs a method by its id." })
  @McpToolFamily({ parameter: "methodId", source: "methods" })
  runDynamic(
    @Param("methodId") methodId: string,
    @Body() _body: Record<string, unknown>,
  ): { ran: string } {
    return { ran: methodId };
  }
}

@Controller()
class McpController {
  private readonly serve: SezzleeRequestHandler;

  constructor(endpoint: SezzleeMcpEndpoint) {
    this.serve = endpoint.serve({ name: "parity", version: "0.0.0" });
  }

  @All("mcp")
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.serve(req, res);
  }
}

const balances: McpFamilyMember = {
  key: "7",
  name: "list_customer_balances",
  description: "Lists customer balances.",
  body: {
    type: "object",
    properties: {
      balance: { $ref: "#/$defs/Range" },
      overdue: { $ref: "#/$defs/Range" },
    },
    $defs: {
      Range: {
        type: "object",
        properties: { min: { type: "number" }, max: { type: "number" } },
      },
    },
  },
  readOnly: true,
};

const members: McpFamilyMember[] = [balances];

interface Wire {
  readonly content: { readonly type: string; readonly text: string }[];
  readonly isError?: boolean;
}

type Mode = "exclude" | "include";

let app: INestApplication;
let origin: string;
let sdk: Client;
const gateways = new Map<Mode, { client: Client; names: string[] }>();
let sdkNames: string[];

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: unknown }> {
  const result = (await client.callTool({
    name,
    arguments: args,
  })) as unknown as Wire;
  return {
    isError: result.isError === true,
    body: JSON.parse(result.content[0]?.text ?? "null") as unknown,
  };
}

async function gatewayCatalog(mode: Mode) {
  const config = configSchema.parse({
    source: "inline",
    baseUrl: origin,
    selection: { default: mode },
  });
  const document = await (await fetch(`${origin}/openapi-json`)).text();
  return {
    config,
    built: await buildGatewayCatalog(
      document,
      config,
      new Map(),
      [],
      undefined,
      undefined,
    ),
  };
}

const gatewayOf = (mode: Mode): Client => {
  const gateway = gateways.get(mode);
  if (gateway === undefined) {
    throw new Error(`no ${mode} gateway`);
  }
  return gateway.client;
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      SezzleeModule.forRoot((options) => {
        options.families.provide("methods", () => [...members]);
      }),
    ],
    controllers: [
      OrdersController,
      CustomersController,
      ReportsController,
      MethodsController,
      McpController,
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix("api");
  const catalog = app.get(SezzleeCatalog);
  SwaggerModule.setup(
    "openapi",
    app,
    SwaggerModule.createDocument(app, new DocumentBuilder().build(), {
      operationIdFactory: (_controller, method) => method,
    }),
    {
      patchDocumentOnRequest: (_req, _res, document) => {
        const annotated = structuredClone(document);
        annotateOpenApiDocument(annotated, catalog.openApiExtensions());
        return annotated;
      },
    },
  );
  await app.listen(0);
  origin = await app.getUrl();

  sdk = new Client({ name: "parity", version: "0.0.0" });
  await sdk.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`)),
  );

  sdkNames = [...catalog.current.byName.keys()].sort();

  for (const mode of ["exclude", "include"] as const) {
    const { config, built } = await gatewayCatalog(mode);
    const server = createOpenApiMcpServer(
      built,
      createBoundedFetch(built.allowedHosts),
      config.limits,
      { results: new MemoryResultStore() },
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "parity", version: "0.0.0" });
    await client.connect(clientSide);
    gateways.set(mode, {
      client,
      names: [...built.catalog.byName.keys()].sort(),
    });
  }
});

afterAll(async () => {
  await sdk.close();
  for (const { client } of gateways.values()) {
    await client.close();
  }
  await app.close();
});

const calls: readonly (readonly [string, Record<string, unknown>])[] = [
  ["orders_list", { limit: 5, status: "open" }],
  ["read_order", { orderId: "7" }],
  ["customers_list", {}],
  [
    "orders_create",
    { customerId: 1, shipTo: { street: "1 Main", city: "Izmir" } },
  ],
  ["orders_cancel", { id: "7" }],
  ["orders_label", { id: "7" }],
  ["sales_report_csv", {}],
  ["sales_report", { format: "pdf" }],
  ["ship_order", { customerId: 1, shipTo: { street: "a", city: "b" } }],
  ["list_customer_balances", { balance: { min: 10 }, overdue: { max: 3 } }],
];

const searches = ["order", "by-id", "address", "report", "balance", "sales"];

/**
 * Every difference between the SDK and a gateway reading the SDK's annotated document, keyed
 * `<tool> <surface>.<field>`; `*` in place of the tool or of the surface matches any. A difference
 * missing from this table fails the test, and so does a row no difference matches, so the table
 * only shrinks.
 */
const accepted: Readonly<Record<string, string>> = {};

function topLevelDifferences(
  tool: string,
  surface: string,
  sdkValue: unknown,
  gatewayValue: unknown,
): string[] {
  const left = (sdkValue ?? {}) as Record<string, unknown>;
  const right = (gatewayValue ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .map((key) => `${tool} ${surface}.${key}`);
}

function isAccepted(difference: string, row: string): boolean {
  const [tool, surface] = difference.split(" ");
  const [rowTool, rowSurface] = row.split(" ");
  return (
    (rowTool === "*" || rowTool === tool) &&
    (rowSurface === "*" || rowSurface === surface)
  );
}

describe("a gateway reading the NestJS SDK's annotated document", () => {
  it.each(["exclude", "include"] as const)(
    "publishes the SDK's tools and nothing else when its selection default is %s",
    (mode) => {
      expect(gateways.get(mode)?.names).toEqual(sdkNames);
    },
  );

  it("reads family members the SDK loaded after the document was first served", async () => {
    const catalog = app.get(SezzleeCatalog);
    members.push({
      key: "8",
      name: "list_dormant_customers",
      description: "Lists customers with no order this year.",
      body: { type: "object", properties: { year: { type: "integer" } } },
      readOnly: true,
    });
    try {
      await catalog.refreshFamilies();

      const { built } = await gatewayCatalog("exclude");

      expect(built.catalog.byName.has("list_dormant_customers")).toBe(true);
    } finally {
      members.pop();
      await catalog.refreshFamilies();
    }
  });

  it("loads, lists and invokes every tool as the SDK does, apart from the accepted differences", async () => {
    const gateway = gatewayOf("exclude");
    const differences: string[] = [];
    const cards = async (client: Client) => {
      const { body } = await call(client, "search_tools", {
        query: "",
        limit: 100,
      });
      const listing = body as { results: { name: string }[]; tags: string[] };
      return {
        tags: listing.tags,
        byName: new Map(listing.results.map((card) => [card.name, card])),
      };
    };
    const sdkCards = await cards(sdk);
    const gatewayCards = await cards(gateway);
    if (JSON.stringify(sdkCards.tags) !== JSON.stringify(gatewayCards.tags)) {
      differences.push("* search.tags");
    }
    for (const query of searches) {
      const ranked = async (client: Client) =>
        (
          (await call(client, "search_tools", { query })).body as {
            results: { name: string }[];
          }
        ).results.map((card) => card.name);
      if (
        JSON.stringify(await ranked(sdk)) !==
        JSON.stringify(await ranked(gateway))
      ) {
        differences.push(`* search.${query}`);
      }
    }
    for (const name of sdkNames) {
      differences.push(
        ...topLevelDifferences(
          name,
          "load",
          (await call(sdk, "load_tool", { name })).body,
          (await call(gateway, "load_tool", { name })).body,
        ),
        ...topLevelDifferences(
          name,
          "card",
          sdkCards.byName.get(name),
          gatewayCards.byName.get(name),
        ),
      );
    }
    for (const [name, args] of calls) {
      const sdkResult = await call(sdk, "invoke_tool", {
        name,
        arguments: args,
      });
      const gatewayResult = await call(gateway, "invoke_tool", {
        name,
        arguments: args,
      });
      expect(sdkResult.isError, name).toBe(false);
      if (JSON.stringify(sdkResult) !== JSON.stringify(gatewayResult)) {
        differences.push(`${name} invoke.result`);
      }
    }

    expect(
      (
        await call(sdk, "invoke_tool", {
          name: "orders_label",
          arguments: { id: "7" },
        })
      ).body,
    ).toEqual({
      status: 200,
      body: "JVBERi0xLjcK4uPP0w==",
      bodyEncoding: "base64",
      contentType: "application/pdf",
    });

    const rows = Object.keys(accepted);
    expect({
      unaccepted: differences.filter(
        (difference) => !rows.some((row) => isAccepted(difference, row)),
      ),
      stale: rows.filter(
        (row) => !differences.some((difference) => isAccepted(difference, row)),
      ),
    }).toEqual({ unaccepted: [], stale: [] });
  });

  it("stores an over-budget answer and reads it back as the SDK does", async () => {
    const gateway = gatewayOf("exclude");
    const storedBy = async (client: Client) => {
      const { isError, body } = await call(client, "invoke_tool", {
        name: "orders_history",
        arguments: {},
      });
      expect(isError).toBe(false);
      return body as InvokeStored;
    };
    const sdkStored = await storedBy(sdk);
    const gatewayStored = await storedBy(gateway);
    const withoutHandle = ({ stored, ...rest }: InvokeStored) => ({
      ...rest,
      stored: { ...stored, handle: "" },
    });
    expect(withoutHandle(gatewayStored)).toEqual(withoutHandle(sdkStored));
    expect(sdkStored.stored.outline[0]).toEqual({
      path: "",
      kind: "object",
      count: 1,
      fields: ["result"],
    });

    const window = {
      path: "/result",
      select: ["id", "status"],
      offset: 4_998,
      limit: 5,
    };
    const readBy = async (client: Client, handle: string) =>
      (await call(client, "read_result", { handle, ...window }))
        .body as ReadResult;
    const sdkRead = await readBy(sdk, sdkStored.stored.handle);
    expect(await readBy(gateway, gatewayStored.stored.handle)).toEqual(sdkRead);
    expect(sdkRead).toEqual({
      path: "/result",
      kind: "array",
      total: 5_000,
      offset: 4_998,
      value: [
        { id: 4_998, status: "open" },
        { id: 4_999, status: "open" },
      ],
    });
  });
});
