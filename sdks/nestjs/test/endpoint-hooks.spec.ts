import "reflect-metadata";
import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiOperation } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { SezzleeCatalog } from "../src/catalog.js";
import { McpTool } from "../src/decorators.js";
import { SezzleeModule } from "../src/sezzlee.module.js";
import type {
  CatalogDiagnostic,
  McpEndpointInfo,
  VisibilityDeclaration,
} from "../src/index.js";

class AnonymousGuard {
  canActivate(): boolean {
    return true;
  }

  describeVisibility(): VisibilityDeclaration {
    return { anonymous: "yes", policies: [] };
  }
}

@Controller("hooks")
class HookedController {
  @Get("declared")
  @McpTool({
    name: "declared_vocabulary",
    description: "Declared.",
    tags: ["declared"],
    searchTerms: ["beyan"],
  })
  @UseGuards(AnonymousGuard)
  declared(): void {}

  @Get("endpoint")
  @McpTool({ name: "endpoint_vocabulary", description: "Endpoint." })
  @ApiOperation({ summary: "Documented elsewhere." })
  @UseGuards(AnonymousGuard)
  endpoint(): void {}

  @Get("abstains")
  @McpTool({ name: "abstaining_endpoint", description: "Abstains." })
  @UseGuards(AnonymousGuard)
  abstains(): void {}

  @Get("duplicate")
  @McpTool({ name: "duplicate_vocabulary", description: "Duplicates." })
  @UseGuards(AnonymousGuard)
  duplicate(): void {}
}

@Controller("plain")
class PlainController {
  @Get()
  @McpTool({ name: "plain_vocabulary", description: "Plain." })
  @UseGuards(AnonymousGuard)
  list(): void {}
}

describe("options.endpointTags and options.endpointSearchTerms", () => {
  let catalog: SezzleeCatalog;
  const asked = new Map<string, McpEndpointInfo>();

  const descriptorOf = (name: string) => catalog.find(name)?.descriptor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SezzleeModule.forRoot((options) => {
          options.endpointTags = (endpoint) => {
            asked.set(endpoint.handler.name, endpoint);
            switch (endpoint.handler.name) {
              case "declared":
              case "endpoint":
                return ["from-endpoint"];
              case "duplicate":
                return ["Orders", "orders"];
              default:
                return undefined;
            }
          };
          options.endpointSearchTerms = (endpoint) => {
            switch (endpoint.handler.name) {
              case "declared":
              case "endpoint":
                return ["uç-nokta"];
              case "duplicate":
                return ["Sipariş", "siparis"];
              default:
                return undefined;
            }
          };
          options.tags = (container) =>
            container === "HookedController" ? ["from-container"] : undefined;
          options.searchTerms = (container) =>
            container === "HookedController" ? ["kap"] : undefined;
        }),
      ],
      controllers: [HookedController, PlainController],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    catalog = app.get(SezzleeCatalog);
  });

  it("ranks a declaration above the hook, the hook above the container rule", () => {
    expect(descriptorOf("declared_vocabulary")?.tags).toEqual(["declared"]);
    expect(descriptorOf("endpoint_vocabulary")?.tags).toEqual([
      "from-endpoint",
    ]);
    expect(descriptorOf("abstaining_endpoint")?.tags).toEqual([
      "from-container",
    ]);
    expect(descriptorOf("declared_vocabulary")?.searchTerms).toEqual(["beyan"]);
    expect(descriptorOf("endpoint_vocabulary")?.searchTerms).toEqual([
      "uç-nokta",
    ]);
    expect(descriptorOf("abstaining_endpoint")?.searchTerms).toEqual(["kap"]);
  });

  it("keeps the container-derived tag and no terms where nothing decides", () => {
    expect(descriptorOf("plain_vocabulary")?.tags).toEqual(["Plain"]);
    expect(descriptorOf("plain_vocabulary")?.searchTerms).toBeUndefined();
  });

  it("cleans a hook's vocabulary like a declaration's, with the same diagnostics", () => {
    expect(descriptorOf("duplicate_vocabulary")?.tags).toEqual(["Orders"]);
    expect(descriptorOf("duplicate_vocabulary")?.searchTerms).toEqual([
      "Sipariş",
    ]);
    const codes = catalog.diagnostics
      .map((diagnostic: CatalogDiagnostic) => diagnostic.code)
      .filter((code) => code.startsWith("duplicate_"))
      .sort();
    expect(codes).toEqual(["duplicate_search_term", "duplicate_tag"]);
  });

  it("hands the hook the endpoint's identity and the description it is published with", () => {
    expect(asked.get("endpoint")).toMatchObject({
      method: "GET",
      route: "/hooks/endpoint",
      container: "HookedController",
      declared: "Endpoint.",
    });
  });
});
