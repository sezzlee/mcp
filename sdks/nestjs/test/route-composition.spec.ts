import "reflect-metadata";
import {
  Controller,
  Get,
  HostParam,
  Module,
  Param,
  Sse,
  Version,
  VersioningType,
  type INestApplication,
} from "@nestjs/common";
import { RouterModule } from "@nestjs/core";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import { interval, map, type Observable } from "rxjs";
import { beforeAll, describe, expect, it } from "vitest";
import { SezzleeCatalog } from "../src/catalog.js";
import { discoverEndpoints } from "../src/discovery/endpoint-discovery.js";
import { McpTool } from "../src/decorators.js";
import { SezzleeModule } from "../src/sezzlee.module.js";
import type {
  SezzleeOptions,
  SezzleeResourceServerOptions,
} from "../src/options.js";

@Controller("orders")
@McpTool()
class PrefixedOrdersController {
  @Get(":id")
  getOrder(@Param("id") _id: string): string {
    return "ok";
  }
}

@Controller("health")
@McpTool()
class HealthController {
  @Get()
  check(): string {
    return "ok";
  }
}

@Controller("mcp")
@McpTool()
class LookalikeMcpController {
  @Get()
  handle(): string {
    return "ok";
  }
}

@Controller("mcp-servers")
@McpTool()
class McpServersController {
  @Get()
  list(): string {
    return "ok";
  }
}

@Controller(["orders", "purchases"])
@McpTool()
class MultiPathController {
  @Get(":id")
  getOrder(@Param("id") _id: string): string {
    return "ok";
  }
}

@Controller({ path: "orders", version: "1" })
@McpTool()
class VersionedOrdersController {
  @Get()
  list(): string {
    return "ok";
  }

  @Get("archive")
  @Version("2")
  archive(): string {
    return "ok";
  }
}

@Controller("orders")
@McpTool()
class MountedOrdersController {
  @Get()
  list(): string {
    return "ok";
  }
}

@Controller({ path: "accounts", host: ":account.example.com" })
@McpTool()
class TenantHostController {
  @Get()
  list(@HostParam("account") _account: string): string {
    return "ok";
  }
}

@Controller({ path: "orders", host: "tenant-:account.example.com" })
@McpTool()
class LabelHostController {
  @Get()
  list(@HostParam("account") _account: string): string {
    return "ok";
  }
}

@Controller({ path: "admin", host: "admin.example.com" })
@McpTool()
class AdminHostController {
  @Get()
  list(): string {
    return "ok";
  }
}

@Controller("events")
@McpTool()
class EventsController {
  @Sse("stream")
  stream(): Observable<MessageEvent> {
    return interval(1000).pipe(map(() => ({ data: "tick" }) as MessageEvent));
  }

  @Get()
  list(): string {
    return "ok";
  }
}

@Module({ controllers: [MountedOrdersController] })
class OrdersFeatureModule {}

async function catalogOf(
  build: TestingModuleBuilder,
  prepare?: (app: INestApplication) => void,
): Promise<SezzleeCatalog> {
  const moduleRef = await build.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  prepare?.(app);
  await app.init();
  return app.get(SezzleeCatalog);
}

const routesOf = (catalog: SezzleeCatalog): string[] =>
  catalog.current.entries.map((entry) => entry.descriptor.route).sort();

describe("R1: global prefix", () => {
  let catalog: SezzleeCatalog;

  beforeAll(async () => {
    catalog = await catalogOf(
      Test.createTestingModule({
        imports: [SezzleeModule.forRoot()],
        controllers: [
          PrefixedOrdersController,
          HealthController,
          LookalikeMcpController,
          McpServersController,
        ],
      }),
      (app) => app.setGlobalPrefix("api", { exclude: ["health"] }),
    );
  });

  it("puts the global prefix in the route", () => {
    expect(routesOf(catalog)).toContain("/api/orders/{id}");
  });

  it("honours the prefix exclusion list", () => {
    expect(routesOf(catalog)).toContain("/health");
  });

  it("still filters the reserved mcp path once it carries the prefix", () => {
    expect(routesOf(catalog)).not.toContain("/api/mcp");
  });

  it("keeps a route that only begins with the reserved path's letters", () => {
    expect(routesOf(catalog)).toEqual([
      "/api/mcp-servers",
      "/api/orders/{id}",
      "/health",
    ]);
  });
});

describe("R2: a controller mounted at several paths", () => {
  let catalog: SezzleeCatalog;

  beforeAll(async () => {
    catalog = await catalogOf(
      Test.createTestingModule({
        imports: [SezzleeModule.forRoot()],
        controllers: [MultiPathController],
      }),
    );
  });

  it("produces one tool and invokes the deterministic route", () => {
    expect(catalog.current.entries).toHaveLength(1);
    expect(catalog.current.entries[0]?.descriptor.route).toBe("/orders/{id}");
  });

  it("keeps the folded route in the search index", () => {
    expect(catalog.current.entries[0]?.alternateRoutes).toEqual([
      "/purchases/{id}",
    ]);
    expect(catalog.current.index.search("purchases", 5)).toEqual([
      "multi_path_get_order",
    ]);
  });

  it("reports the folding instead of dropping it silently", () => {
    const folded = catalog.diagnostics.find(
      (diagnostic) => diagnostic.code === "route_folded",
    );
    expect(folded?.message).toContain("/purchases/{id}");
    expect(folded?.message).toContain("/orders/{id}");
  });
});

describe("R3: URI versioning", () => {
  let catalog: SezzleeCatalog;

  beforeAll(async () => {
    catalog = await catalogOf(
      Test.createTestingModule({
        imports: [SezzleeModule.forRoot()],
        controllers: [VersionedOrdersController],
      }),
      (app) => {
        app.setGlobalPrefix("api");
        app.enableVersioning({ type: VersioningType.URI });
      },
    );
  });

  it("writes the version segment the way Nest routes it", () => {
    expect(routesOf(catalog)).toEqual([
      "/api/v1/orders",
      "/api/v2/orders/archive",
    ]);
  });
});

describe("R3b: URI versioning with a default version", () => {
  let catalog: SezzleeCatalog;

  beforeAll(async () => {
    catalog = await catalogOf(
      Test.createTestingModule({
        imports: [SezzleeModule.forRoot()],
        controllers: [HealthController, VersionedOrdersController],
      }),
      (app) => {
        app.enableVersioning({ type: VersioningType.URI, defaultVersion: "3" });
      },
    );
  });

  it("routes an unversioned controller under the default version, as Nest does", () => {
    expect(routesOf(catalog)).toEqual([
      "/v1/orders",
      "/v2/orders/archive",
      "/v3/health",
    ]);
  });
});

describe("R3c: header versioning", () => {
  const catalogUnder = (configure: (options: SezzleeOptions) => void) =>
    catalogOf(
      Test.createTestingModule({
        imports: [SezzleeModule.forRoot(configure)],
        controllers: [HealthController, VersionedOrdersController],
      }),
      (app) => {
        app.enableVersioning({
          type: VersioningType.HEADER,
          header: "X-API-Version",
          defaultVersion: "1",
        });
      },
    );

  it("drops a handler whose version the replayed request cannot carry", async () => {
    const catalog = await catalogUnder(() => {});
    expect(routesOf(catalog)).toEqual(["/health", "/orders"]);
    expect(
      catalog.diagnostics.find(
        (diagnostic) => diagnostic.code === "version_not_carried",
      )?.message,
    ).toBe(
      "VersionedOrdersController.archive answers version 2 under HEADER versioning; the replayed request carries no version, so a call would reach another version's handler.",
    );
  });

  it("keeps it when the host downgrades the code", async () => {
    const catalog = await catalogUnder((options) => {
      options.diagnostics.downgrade.add("version_not_carried");
    });
    expect(routesOf(catalog)).toEqual([
      "/health",
      "/orders",
      "/orders/archive",
    ]);
  });
});

describe("R3d: host-routed controllers", () => {
  it("drops a controller routed on a host pattern and keeps one on a fixed host", async () => {
    const catalog = await catalogOf(
      Test.createTestingModule({
        imports: [SezzleeModule.forRoot()],
        controllers: [
          TenantHostController,
          LabelHostController,
          AdminHostController,
        ],
      }),
    );
    expect(routesOf(catalog)).toEqual(["/admin"]);
    expect(
      catalog.diagnostics
        .filter((diagnostic) => diagnostic.code === "unsupported_binding")
        .map((diagnostic) => diagnostic.message),
    ).toEqual([
      "TenantHostController.list is routed on a host pattern; the replayed request cannot choose the host, so a call would reach another host's handler or none. Endpoint skipped.",
      "LabelHostController.list is routed on a host pattern; the replayed request cannot choose the host, so a call would reach another host's handler or none. Endpoint skipped.",
    ]);
  });
});

describe("R3e: server-sent events", () => {
  it("drops a handler whose response never ends", async () => {
    const catalog = await catalogOf(
      Test.createTestingModule({
        imports: [SezzleeModule.forRoot()],
        controllers: [EventsController],
      }),
    );
    expect(routesOf(catalog)).toEqual(["/events"]);
    expect(
      catalog.diagnostics.find(
        (diagnostic) => diagnostic.code === "unsupported_binding",
      )?.message,
    ).toBe(
      "EventsController.stream streams server-sent events, which never end, so a tool call could only time out; endpoint skipped.",
    );
  });
});

describe("R3f: Express route syntax", () => {
  @Controller()
  @McpTool()
  class SyntaxController {
    @Get("exports/:id.json")
    exported(@Param("id") _id: string): string {
      return "ok";
    }

    @Get("ranges/:from-:to")
    range(@Param("from") _from: string, @Param("to") _to: string): string {
      return "ok";
    }

    @Get("files{/:name}")
    file(@Param("name") _name?: string): string {
      return "ok";
    }

    @Get("legacy/:id(\\d+)/:page?")
    legacy(@Param("id") _id: string, @Param("page") _page?: string): string {
      return "ok";
    }
  }

  const routes = discoverEndpoints([{ metatype: SyntaxController }]).map(
    (endpoint) => [endpoint.handlerName, endpoint.descriptor.route],
  );

  it("writes a parameter followed by literal text inside its segment", () => {
    expect(routes).toContainEqual(["exported", "/exports/{id}.json"]);
    expect(routes).toContainEqual(["range", "/ranges/{from}-{to}"]);
  });

  it("writes an optional part present, so its parameter can be sent", () => {
    expect(routes).toContainEqual(["file", "/files/{name}"]);
    expect(routes).toContainEqual(["legacy", "/legacy/{id}/{page}"]);
    expect(routes).toHaveLength(4);
  });
});

describe("R4: a module mounted through RouterModule", () => {
  let catalog: SezzleeCatalog;

  beforeAll(async () => {
    catalog = await catalogOf(
      Test.createTestingModule({
        imports: [
          SezzleeModule.forRoot(),
          OrdersFeatureModule,
          RouterModule.register([
            { path: "admin", module: OrdersFeatureModule },
          ]),
        ],
      }),
    );
  });

  it("puts the module path in the route", () => {
    expect(routesOf(catalog)).toEqual(["/admin/orders"]);
  });
});

describe("R5: protected-resource metadata under a global prefix", () => {
  const resourceServer = {
    resource: new URL("https://api.example.com/mcp"),
    authorizationServers: [new URL("https://auth.example.com")],
    verifier: { verifyAccessToken: () => Promise.reject(new Error("unused")) },
  } as unknown as SezzleeResourceServerOptions;

  const configure = (options: SezzleeOptions): void => {
    options.resourceServer = resourceServer;
    options.diagnostics.failOn = undefined;
  };

  it("stops startup when the metadata path is not excluded from the prefix", async () => {
    await expect(
      catalogOf(
        Test.createTestingModule({
          imports: [SezzleeModule.forRoot(configure)],
          controllers: [PrefixedOrdersController],
        }),
        (app) => app.setGlobalPrefix("api"),
      ),
    ).rejects.toMatchObject({
      name: "SezzleeCatalogError",
      code: "prm_path_prefixed",
      message: expect.stringMatching(
        /\/\.well-known\/oauth-protected-resource\/mcp.*exclude/,
      ),
    });
  });

  it("is silent once the host excludes it", async () => {
    const catalog = await catalogOf(
      Test.createTestingModule({
        imports: [SezzleeModule.forRoot(configure)],
        controllers: [PrefixedOrdersController],
      }),
      (app) =>
        app.setGlobalPrefix("api", {
          exclude: ["/.well-known/oauth-protected-resource/mcp"],
        }),
    );
    expect(
      catalog.diagnostics.map((diagnostic) => diagnostic.code),
    ).not.toContain("prm_path_prefixed");
  });
});
