import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  Injectable,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Scope,
  UseGuards,
  type CanActivate,
  type INestApplication,
  type Provider,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from "class-validator";
import { beforeAll, describe, expect, it } from "vitest";
import { SezzleeCatalog } from "../src/catalog.js";
import { McpIgnore, McpTool } from "../src/decorators.js";
import { SezzleeModule } from "../src/sezzlee.module.js";

class NoteDto {
  @IsString()
  @IsNotEmpty()
  text!: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  weight?: number;
}

@Injectable()
class OpaqueGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Injectable()
class DeclaringGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }

  describeVisibility(): { anonymous: "no"; policies: string[] } {
    return { anonymous: "no", policies: ["OrdersRead"] };
  }
}

@Injectable()
class TenantGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }

  describeVisibility(): { anonymous: "no"; policies: string[] } {
    return { anonymous: "no", policies: ["Tenant"] };
  }
}

@Injectable()
class SilentGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }

  describeVisibility(): Record<string, never> {
    return {};
  }
}

@Controller("orders")
@McpTool()
class CatalogOrdersController {
  @Get("ping")
  ping(): string {
    return "ok";
  }

  @Get(":id")
  @UseGuards(DeclaringGuard)
  getOrder(@Param("id", ParseIntPipe) _id: number): string {
    return "ok";
  }

  @Get("secret")
  @McpIgnore()
  secret(): string {
    return "ok";
  }

  @Post(":id/notes")
  @UseGuards(OpaqueGuard)
  addOrderNote(
    @Param("id", ParseIntPipe) _id: number,
    @Query("notify") _notify: boolean,
    @Body() _note: NoteDto,
  ): string {
    return "ok";
  }
}

@Controller("reports")
class UnmarkedController {
  @Get("summary")
  summary(): string {
    return "ok";
  }
}

describe("nest catalog", () => {
  let catalog: SezzleeCatalog;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SezzleeModule.forRoot()],
      controllers: [CatalogOrdersController, UnmarkedController],
      providers: [OpaqueGuard, DeclaringGuard],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    catalog = app.get(SezzleeCatalog);
  });

  it("selects only opted-in operations, most specific marker wins", () => {
    expect([...catalog.current.byName.keys()].sort()).toEqual([
      "catalog_orders_add_order_note",
      "catalog_orders_get_order",
      "catalog_orders_ping",
    ]);
  });

  it("derives the container prefix from the controller class", () => {
    const entry = catalog.find("catalog_orders_get_order");
    expect(entry?.descriptor.container).toBe("CatalogOrdersController");
    expect(entry?.descriptor.operationId).toBe("getOrder");
  });

  it("reads an undeclared guard as imperative with unknown anonymity", () => {
    expect(
      catalog.find("catalog_orders_add_order_note")?.descriptor.auth,
    ).toEqual({
      anonymous: "unknown",
      policies: [],
      imperative: true,
    });
  });

  it("reads a declaring guard into anonymous and policies", () => {
    expect(catalog.find("catalog_orders_get_order")?.descriptor.auth).toEqual({
      anonymous: "no",
      policies: ["OrdersRead"],
      imperative: false,
    });
    expect([...catalog.current.policyNames]).toEqual(["OrdersRead"]);
  });

  it("treats a guardless endpoint as unknown, not anonymous", () => {
    expect(catalog.find("catalog_orders_ping")?.descriptor.auth.anonymous).toBe(
      "unknown",
    );
  });

  it("builds an input schema and a request template", () => {
    const entry = catalog.find("catalog_orders_add_order_note");
    expect(entry?.tool.inputSchema).toEqual({
      type: "object",
      properties: {
        id: { type: "integer" },
        notify: { type: "boolean" },
        text: { type: "string" },
        weight: { type: "integer", minimum: 1 },
      },
      required: ["id", "text"],
      additionalProperties: false,
    });
    expect(entry?.template?.routeTemplate).toBe("/orders/{id}/notes");
  });

  it("reports no diagnostics for a clean host", () => {
    expect(catalog.current.diagnostics).toEqual([]);
    expect(catalog.current.fatal).toEqual([]);
  });
});

describe("nest catalog behind global guards", () => {
  const appWith = async (
    providers: Provider[],
    configure: (app: INestApplication) => void = () => {},
  ): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({
      imports: [SezzleeModule.forRoot()],
      controllers: [CatalogOrdersController],
      providers: [OpaqueGuard, DeclaringGuard, ...providers],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    configure(app);
    await app.init();
    return app;
  };

  it.each<[string, Provider]>([
    ["an APP_GUARD provider", { provide: APP_GUARD, useClass: TenantGuard }],
    [
      "a request-scoped APP_GUARD provider",
      { provide: APP_GUARD, useClass: TenantGuard, scope: Scope.REQUEST },
    ],
  ])("reads %s into every endpoint's auth", async (_case, provider) => {
    const app = await appWith([provider]);
    try {
      const catalog = app.get(SezzleeCatalog);
      expect(catalog.find("catalog_orders_ping")?.descriptor.auth).toEqual({
        anonymous: "no",
        policies: ["Tenant"],
        imperative: false,
      });
      expect(catalog.find("catalog_orders_get_order")?.descriptor.auth).toEqual(
        {
          anonymous: "no",
          policies: ["Tenant", "OrdersRead"],
          imperative: false,
        },
      );
    } finally {
      await app.close();
    }
  });

  it.each<[string, CanActivate, unknown]>([
    [
      "marks every endpoint imperative behind a global guard that does not declare itself",
      new OpaqueGuard(),
      { anonymous: "unknown", policies: [], imperative: true },
    ],
    [
      "keeps a global guard that declares nothing out of the decision",
      new SilentGuard(),
      { anonymous: "unknown", policies: [], imperative: false },
    ],
  ])("%s", async (_case, guard, auth) => {
    const app = await appWith([], (host) => {
      host.useGlobalGuards(guard);
    });
    try {
      expect(
        app.get(SezzleeCatalog).find("catalog_orders_ping")?.descriptor.auth,
      ).toEqual(auth);
    } finally {
      await app.close();
    }
  });

  it("refuses to start on an HTTP adapter other than Express", async () => {
    await expect(
      appWith([], (host) => {
        host.getHttpAdapter().getType = () => "fastify";
      }),
    ).rejects.toMatchObject({ code: "unsupported_http_adapter" });
  });
});
