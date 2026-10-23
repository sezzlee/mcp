import "reflect-metadata";
import { Controller, Get, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { SezzleeCatalog } from "../src/catalog.js";
import { McpTool } from "../src/decorators.js";
import { SezzleeModule } from "../src/sezzlee.module.js";

@Controller("admin")
class AdminController {
  @Get("users")
  users(): void {}

  @Get("health")
  @McpTool({ name: "admin_health", description: "Reports health." })
  health(): void {}
}

@Controller("orders")
class OrdersController {
  @Get()
  list(): void {}

  @Post()
  create(): void {}
}

const targetsOf = (catalog: SezzleeCatalog): string[] =>
  catalog.current.entries
    .map((entry) => `${entry.descriptor.method} ${entry.descriptor.route}`)
    .sort();

describe("selection rules", () => {
  let catalog: SezzleeCatalog;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SezzleeModule.forRoot((options) => {
          options.selection.default = "include";
          options.selection.rules = [
            { route: "/admin/**", decision: "exclude" },
            { method: "POST", decision: "exclude" },
          ];
        }),
      ],
      controllers: [AdminController, OrdersController],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    catalog = app.get(SezzleeCatalog);
  });

  it("carves a route subtree out of a global include without an attribute", () => {
    expect(targetsOf(catalog)).not.toContain("GET /admin/users");
  });

  /**
   * Guard: an operation marker is the only place a carve-out can be written, because equally specific rules that
   * disagree are a build error rather than a silent winner.
   */
  it("loses to an operation marker inside the excluded subtree", () => {
    expect(targetsOf(catalog)).toContain("GET /admin/health");
  });

  it("narrows by method alone", () => {
    expect(targetsOf(catalog)).toEqual(["GET /admin/health", "GET /orders"]);
  });
});

describe("selection rules that disagree", () => {
  let conflicted: SezzleeCatalog;
  let failure: unknown;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SezzleeModule.forRoot((options) => {
          options.selection.default = "include";
          options.selection.rules = [
            { route: "/admin/**", decision: "exclude" },
            { route: "/admin/users", decision: "include" },
          ];
        }),
      ],
      controllers: [AdminController, OrdersController],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    failure = await app.init().then(
      () => undefined,
      (error: unknown) => error,
    );
    conflicted = app.get(SezzleeCatalog);
  });

  it("reports ambiguous_selection rather than picking one", () => {
    const codes = conflicted.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("ambiguous_selection");
  });

  it("is fatal, so the application refuses to start", () => {
    expect(failure).toMatchObject({
      name: "SezzleeCatalogError",
      code: "ambiguous_selection",
    });
    expect((failure as Error).message).toMatch(/equal specificity disagree/);
  });
});

describe("a blank rule field", () => {
  /**
   * Guard: omitting a field is the catch-all; a blank one matches nothing, so it would decide nothing and say so
   * nowhere.
   */
  it("is a configuration failure, not a catch-all", () => {
    expect(() =>
      SezzleeModule.forRoot((options) => {
        options.selection.rules = [{ route: "  ", decision: "exclude" }];
      }),
    ).toThrow(/must not be blank/);
  });
});
