import "reflect-metadata";
import {
  ClassSerializerInterceptor,
  Controller,
  Get,
  SerializeOptions,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ApiOkResponse, ApiProperty } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import { Exclude, Expose } from "class-transformer";
import { IsInt, IsString } from "class-validator";
import { map, type Observable } from "rxjs";
import { describe, expect, it } from "vitest";
import type { JsonSchemaObject } from "@sezzlee/core";
import { SezzleeCatalog } from "../src/catalog.js";
import { McpTool } from "../src/decorators.js";
import { SezzleeModule } from "../src/sezzlee.module.js";

class UserDto {
  @IsInt()
  id!: number;

  @IsString()
  @Expose({ name: "displayName" })
  name!: string;

  @IsString()
  @Exclude()
  password!: string;

  @Expose()
  get initials(): string {
    return this.name.slice(0, 1);
  }
}

@Exclude()
class BadgeDto {
  @Expose()
  @ApiProperty()
  label!: string;

  @ApiProperty()
  secret!: string;
}

class Envelope implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(map((data: unknown) => ({ data })));
  }

  describeResponse(schema: JsonSchemaObject): JsonSchemaObject {
    return {
      type: "object",
      properties: { data: schema },
      required: ["data"],
    };
  }
}

class Opaque implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle();
  }

  describeResponse(): undefined {
    return undefined;
  }
}

@Controller("users")
@McpTool()
class UsersController {
  @Get("me")
  @ApiOkResponse({ type: UserDto })
  me(): UserDto {
    return new UserDto();
  }

  @Get("badge")
  @ApiOkResponse({ type: BadgeDto })
  @UseInterceptors(Envelope)
  badge(): BadgeDto {
    return new BadgeDto();
  }

  @Get("plain")
  @ApiOkResponse({ type: [BadgeDto] })
  @SerializeOptions({ strategy: "exposeAll" })
  plain(): BadgeDto[] {
    return [];
  }

  @Get("opaque")
  @ApiOkResponse({ type: BadgeDto })
  @UseInterceptors(Opaque)
  opaque(): BadgeDto {
    return new BadgeDto();
  }

  @Get("declared")
  @UseInterceptors(Envelope)
  @McpTool({ responses: { 200: UserDto } })
  declared(): UserDto {
    return new UserDto();
  }
}

async function responsesOf(): Promise<Map<string | undefined, unknown>> {
  const moduleRef = await Test.createTestingModule({
    imports: [SezzleeModule.forRoot()],
    controllers: [UsersController],
    providers: [
      { provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  const catalog = app.get(SezzleeCatalog);
  const responses = new Map(
    catalog.current.entries.map((entry) => [
      entry.descriptor.operationId,
      entry.descriptor.responses,
    ]),
  );
  await app.close();
  return responses;
}

describe("interceptors that change the response", async () => {
  const responses = await responsesOf();

  it("writes what ClassSerializerInterceptor sends: excluded, renamed and exposed members", () => {
    expect(responses.get("me")).toEqual({
      "200": {
        schema: {
          type: "object",
          properties: {
            id: { type: "integer" },
            displayName: { type: "string" },
            initials: { type: "string" },
          },
          required: ["id", "displayName"],
        },
      },
    });
  });

  it("applies a class-level @Exclude() and passes the body through describeResponse", () => {
    expect(responses.get("badge")).toEqual({
      "200": {
        schema: {
          type: "object",
          properties: {
            data: {
              type: "object",
              properties: { label: { type: "string" } },
              required: ["label"],
            },
          },
          required: ["data"],
        },
      },
    });
  });

  it("lets a class-level decorator outrank the @SerializeOptions strategy, as class-transformer does", () => {
    expect(responses.get("plain")).toEqual({
      "200": {
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
          },
        },
      },
    });
  });

  it("drops the body schema an interceptor cannot describe", () => {
    expect(responses.get("opaque")).toEqual({ "200": {} });
  });

  it("leaves an @McpTool({ responses }) declaration as declared", () => {
    expect(responses.get("declared")).toEqual({
      "200": {
        schema: {
          type: "object",
          properties: {
            id: { type: "integer" },
            name: { type: "string" },
            password: { type: "string" },
          },
          required: ["id", "name", "password"],
        },
      },
    });
  });
});
