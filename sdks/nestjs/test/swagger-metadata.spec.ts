import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
  PartialType,
  PickType,
} from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, ValidateNested } from "class-validator";
import { describe, expect, it } from "vitest";
import { McpTool } from "../src/decorators.js";
import {
  discoverEndpoints,
  type DiscoveredEndpoint,
  type DiscoveryDiagnostic,
} from "../src/discovery/endpoint-discovery.js";

enum Status {
  Open = "open",
  Closed = "closed",
}

class LineDto {
  @ApiProperty({ type: "integer", minimum: 1 })
  quantity!: number;
}

class AddressDto {
  @ApiProperty({ description: "Street line." })
  street!: string;

  @ApiPropertyOptional()
  zip?: string;
}

class SearchQuery {
  @ApiProperty({ description: "Customer to list." })
  customerId!: string;

  @ApiPropertyOptional({ type: "integer", minimum: 1 })
  page?: number;

  @ApiProperty({ enum: Status })
  status!: Status;

  @ApiPropertyOptional({ type: [String] })
  ids?: string[];
}

class OrderBody {
  @ApiProperty({ maxLength: 40, pattern: "^[a-z]+$" })
  name!: string;

  @ApiProperty({ type: () => AddressDto })
  address!: AddressDto;

  @ApiProperty({ type: [LineDto] })
  lines!: LineDto[];

  @ApiProperty({ enum: Status, isArray: true })
  statuses!: Status[];

  @ApiPropertyOptional({ type: Date, nullable: true })
  dueAt?: Date | null;
}

class ValidatedBody {
  @ApiProperty({ type: "number", description: "How many." })
  @IsInt()
  count!: number;

  @ApiProperty({ required: false })
  @IsString()
  code!: string;

  @IsOptional()
  @ApiProperty({ type: "integer" })
  limit?: number;

  @ValidateNested()
  @Type(() => LineDto)
  lines!: LineDto[];
}

class PluginBase {
  name!: string;

  static _OPENAPI_METADATA_FACTORY(): Record<string, unknown> {
    return {
      name: { required: true, type: () => String },
      note: { required: true, type: () => String },
    };
  }
}

class PluginBody extends PluginBase {
  lines?: LineDto[];

  static override _OPENAPI_METADATA_FACTORY(): Record<string, unknown> {
    return {
      note: { required: false, type: () => String },
      lines: { required: false, type: () => [LineDto] },
    };
  }
}

class PickedBody extends PickType(OrderBody, ["name", "lines"] as const) {}

class PartialBody extends PartialType(ValidatedBody) {}

class OrderDto {
  @ApiProperty()
  id!: string;
}

@ApiTags("sales", "orders")
@Controller("documented")
@McpTool()
class DocumentedController {
  @Get("search")
  search(@Query() _query: SearchQuery): string {
    return "";
  }

  @Post("order")
  order(@Body() _body: OrderBody): string {
    return "";
  }

  @Post("validated")
  validated(@Body() _body: ValidatedBody): string {
    return "";
  }

  @Post("plugin")
  plugin(@Body() _body: PluginBody): string {
    return "";
  }

  @Post("picked")
  picked(@Body() _body: PickedBody): string {
    return "";
  }

  @Post("partial")
  partial(@Body() _body: PartialBody): string {
    return "";
  }

  @Post("erased")
  @ApiBody({ type: [LineDto] })
  erased(@Body() _body: unknown): string {
    return "";
  }

  @Get("async")
  @ApiTags("reports")
  @ApiOkResponse({ type: () => [OrderDto] })
  async listed(): Promise<OrderDto[]> {
    return [];
  }

  @Get("named/:id/:index")
  @ApiParam({ name: "id", type: "integer", description: "Order id." })
  @ApiParam({ name: "index", type: "string" })
  @ApiQuery({ name: "q", type: Number, description: "Search text." })
  @ApiQuery({ name: "kind", enum: Status, required: false })
  @ApiQuery({ name: "hinted", required: true })
  @ApiHeader({ name: "X-Tenant", required: true, description: "Tenant." })
  @McpTool({ parameters: { hinted: { required: false } } })
  named(
    @Param("id") _id: string,
    @Param("index", ParseIntPipe) _index: number,
    @Query("q") _q: string,
    @Query("kind") _kind: string,
    @Query("hinted") _hinted: string,
    @Headers("x-tenant") _tenant: string,
  ): string {
    return "";
  }
}

@Controller("reports")
@ApiHeader({ name: "X-Report-Format", required: true, enum: ["csv", "json"] })
@ApiHeader({ name: "X-Tenant", required: true, description: "Any tenant." })
@McpTool()
class ReportsController {
  @Get()
  @ApiHeader({ name: "X-Tenant", required: false, description: "Tenant." })
  report(
    @Headers("x-report-format") _format: string,
    @Headers("x-tenant") _tenant: string,
  ): string {
    return "";
  }
}

@Controller("plain")
@McpTool()
class PlainController {
  @Get()
  list(): string {
    return "";
  }
}

const diagnostics: DiscoveryDiagnostic[] = [];
const endpoints = new Map<string, DiscoveredEndpoint>(
  discoverEndpoints(
    [
      { metatype: DocumentedController },
      { metatype: ReportsController },
      { metatype: PlainController },
    ],
    { report: (diagnostic) => diagnostics.push(diagnostic) },
  ).map((endpoint) => [endpoint.handlerName, endpoint]),
);

const descriptorOf = (handler: string) => endpoints.get(handler)?.descriptor;

const line = {
  type: "object",
  properties: { quantity: { type: "integer", minimum: 1 } },
  required: ["quantity"],
};

describe("@nestjs/swagger metadata", () => {
  it("flattens a query DTO only @ApiProperty describes", () => {
    expect(descriptorOf("search")?.parameters).toEqual([
      {
        name: "customerId",
        in: "query",
        required: true,
        schema: { type: "string", description: "Customer to list." },
      },
      {
        name: "page",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1 },
      },
      {
        name: "status",
        in: "query",
        required: true,
        schema: { type: "string", enum: ["open", "closed"] },
      },
      {
        name: "ids",
        in: "query",
        required: false,
        schema: { type: "array", items: { type: "string" } },
      },
    ]);
  });

  it("reads a body DTO only @ApiProperty describes", () => {
    expect(descriptorOf("order")?.requestBody?.schema).toEqual({
      type: "object",
      properties: {
        name: { type: "string", maxLength: 40, pattern: "^[a-z]+$" },
        address: {
          type: "object",
          properties: {
            street: { type: "string", description: "Street line." },
            zip: { type: "string" },
          },
          required: ["street"],
        },
        lines: { type: "array", items: line },
        statuses: {
          type: "array",
          items: { type: "string", enum: ["open", "closed"] },
        },
        dueAt: { type: ["string", "null"], format: "date-time" },
      },
      required: ["name", "address", "lines", "statuses"],
    });
  });

  it("lets class-validator decide type and requiredness, and @ApiProperty describe", () => {
    expect(descriptorOf("validated")?.requestBody?.schema).toEqual({
      type: "object",
      properties: {
        count: { type: "integer", description: "How many." },
        code: { type: "string" },
        limit: { type: "integer" },
        lines: { type: "array", items: line },
      },
      required: ["count", "code", "lines"],
    });
  });

  it("reads the CLI plugin's metadata, a subclass overriding its base", () => {
    expect(descriptorOf("plugin")?.requestBody?.schema).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        note: { type: "string" },
        lines: { type: "array", items: line },
      },
      required: ["name"],
    });
  });

  it("reads the mapped types @nestjs/swagger builds", () => {
    expect(descriptorOf("picked")?.requestBody?.schema).toEqual({
      type: "object",
      properties: {
        name: { type: "string", maxLength: 40, pattern: "^[a-z]+$" },
        lines: { type: "array", items: line },
      },
      required: ["name", "lines"],
    });
    expect(descriptorOf("partial")?.requestBody?.schema).toEqual({
      type: "object",
      properties: {
        count: { type: "integer", description: "How many." },
        code: { type: "string" },
        limit: { type: "integer" },
        lines: { type: "array", items: line },
      },
    });
  });

  it("takes the body type from @ApiBody only where the parameter's own is erased", () => {
    expect(descriptorOf("erased")?.requestBody?.schema).toEqual({
      type: "array",
      items: line,
    });
  });

  it("reads a lazy array response type, which an async handler's return type cannot give", () => {
    expect(descriptorOf("listed")?.responses).toEqual({
      "200": {
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      },
    });
  });

  it("documents named parameters, a pipe and an @McpTool hint taking precedence", () => {
    expect(descriptorOf("named")?.parameters).toEqual([
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "integer" },
        description: "Order id.",
      },
      {
        name: "index",
        in: "path",
        required: true,
        schema: { type: "integer" },
      },
      {
        name: "x-tenant",
        in: "header",
        required: true,
        schema: { type: "string" },
        description: "Tenant.",
      },
      {
        name: "hinted",
        in: "query",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "kind",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["open", "closed"] },
      },
      {
        name: "q",
        in: "query",
        required: true,
        schema: { type: "number" },
        description: "Search text.",
      },
    ]);
  });

  it("documents a header the controller declares, the handler's declaration taking precedence", () => {
    expect(descriptorOf("report")?.parameters).toEqual([
      {
        name: "x-tenant",
        in: "header",
        required: false,
        schema: { type: "string" },
        description: "Tenant.",
      },
      {
        name: "x-report-format",
        in: "header",
        required: true,
        schema: { type: "string", enum: ["csv", "json"] },
      },
    ]);
  });

  it("tags an operation as @nestjs/swagger does", () => {
    expect(descriptorOf("search")?.tags).toEqual(["sales", "orders"]);
    expect(descriptorOf("listed")?.tags).toEqual([
      "sales",
      "orders",
      "reports",
    ]);
    expect(descriptorOf("list")?.tags).toEqual(["Plain"]);
  });

  it("reports nothing for what it read", () => {
    expect(diagnostics).toEqual([]);
  });
});
