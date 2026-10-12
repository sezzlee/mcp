import "reflect-metadata";
import { Controller, Get, UseGuards } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { SezzleeCatalog } from "../src/catalog.js";
import { McpTool } from "../src/decorators.js";
import { SezzleeModule } from "../src/sezzlee.module.js";
import type { Revision } from "@sezzlee/core";
import type { CatalogDiagnostic, VisibilityDeclaration } from "../src/index.js";

class AnonymousGuard {
  canActivate(): boolean {
    return true;
  }

  describeVisibility(): VisibilityDeclaration {
    return { anonymous: "yes", policies: [] };
  }
}

@Controller("orders")
@McpTool({ revision: 4 })
class OrdersController {
  @Get()
  @McpTool({ name: "list_orders", description: "Lists orders." })
  @UseGuards(AnonymousGuard)
  list(): void {}

  @Get("cancel")
  @McpTool({
    name: "cancel_order",
    description: "Cancels an order.",
    revision: 2,
  })
  @UseGuards(AnonymousGuard)
  cancel(): void {}
}

@Controller("ruled")
class RuledController {
  @Get()
  @McpTool({ name: "ruled_rows", description: "Lists rows." })
  @UseGuards(AnonymousGuard)
  list(): void {}
}

@Controller("invalid")
class InvalidController {
  @Get()
  @McpTool({ name: "invalid_rows", description: "Lists rows.", revision: 0 })
  @UseGuards(AnonymousGuard)
  list(): void {}
}

async function bootstrap(
  containerRevision: (container: string) => number | undefined,
): Promise<SezzleeCatalog> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      SezzleeModule.forRoot((options) => {
        options.revision = 7;
        options.containerRevision = containerRevision;
      }),
    ],
    controllers: [OrdersController, RuledController, InvalidController],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app.get(SezzleeCatalog);
}

describe("revision declaration", () => {
  let catalog: SezzleeCatalog;
  let diagnostics: readonly CatalogDiagnostic[];

  const revisionOf = (name: string): Revision | undefined =>
    catalog.current.byName.get(name)?.tool.revision;

  beforeAll(async () => {
    catalog = await bootstrap((container) =>
      container === "RuledController" || container === "OrdersController"
        ? 9
        : undefined,
    );
    diagnostics = catalog.diagnostics;
  });

  it("carries every level apart instead of letting the method's replace the controller's", () => {
    expect(revisionOf("cancel_order")).toEqual({
      catalog: 7,
      container: 4,
      operation: 2,
    });
    expect(revisionOf("list_orders")).toEqual({ catalog: 7, container: 4 });
  });

  it("falls back to the host rule for a container without a declaration", () => {
    expect(revisionOf("ruled_rows")).toEqual({ catalog: 7, container: 9 });
  });

  it("reports a host rule that a controller declaration hides", () => {
    expect(
      diagnostics.filter(
        (diagnostic) =>
          diagnostic.code === "revision_overridden" &&
          diagnostic.message.includes("OrdersController"),
      ),
    ).toHaveLength(2);
  });

  it("ignores a revision below 1 and says so", () => {
    expect(revisionOf("invalid_rows")).toEqual({ catalog: 7 });
    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "invalid_revision" &&
          diagnostic.message.startsWith("InvalidController.list:"),
      ),
    ).toBe(true);
  });
});
