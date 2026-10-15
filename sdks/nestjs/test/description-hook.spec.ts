import "reflect-metadata";
import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiOperation } from "@nestjs/swagger";
import { Test } from "@nestjs/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { SezzleeCatalog } from "../src/catalog.js";
import { McpTool } from "../src/decorators.js";
import { SezzleeModule } from "../src/sezzlee.module.js";
import type { McpEndpointInfo, VisibilityDeclaration } from "../src/index.js";

class AnonymousGuard {
  canActivate(): boolean {
    return true;
  }

  describeVisibility(): VisibilityDeclaration {
    return { anonymous: "yes", policies: [] };
  }
}

@Controller("things")
class ThingsController {
  @Get("declared")
  @McpTool({ name: "declared_wins", description: "From McpTool." })
  @ApiOperation({ description: "From ApiOperation." })
  @UseGuards(AnonymousGuard)
  declared(): void {}

  @Get("hooked")
  @McpTool({ name: "hook_wins" })
  @ApiOperation({ description: "From ApiOperation." })
  @UseGuards(AnonymousGuard)
  hooked(): void {}

  @Get("blank")
  @McpTool({ name: "blank_keeps_declared" })
  @ApiOperation({ summary: "From the summary." })
  @UseGuards(AnonymousGuard)
  blank(): void {}

  @Get("bare")
  @McpTool({ name: "hook_only" })
  @UseGuards(AnonymousGuard)
  bare(): void {}
}

describe("options.description", () => {
  let catalog: SezzleeCatalog;
  const seen = new Map<string, McpEndpointInfo>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SezzleeModule.forRoot((options) => {
          options.description = (endpoint) => {
            seen.set(endpoint.handler.name, endpoint);
            return endpoint.handler.name === "blank" ? "   " : "From the hook.";
          };
        }),
      ],
      controllers: [ThingsController],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    catalog = app.get(SezzleeCatalog);
  });

  const descriptionOf = (name: string): string | undefined =>
    catalog.find(name)?.tool.description;

  it("sits below @McpTool({ description }) and above @ApiOperation", () => {
    expect(descriptionOf("declared_wins")).toBe("From McpTool.");
    expect(descriptionOf("hook_wins")).toBe("From the hook.");
    expect(descriptionOf("hook_only")).toBe("From the hook.");
  });

  it("keeps the declared text when the hook returns a blank", () => {
    expect(descriptionOf("blank_keeps_declared")).toBe("From the summary.");
  });

  it("hands the hook the endpoint and the description it would otherwise carry", () => {
    expect(seen.get("hooked")).toMatchObject({
      method: "GET",
      route: "/things/hooked",
      container: "ThingsController",
      declared: "From ApiOperation.",
    });
    expect(seen.get("bare")?.declared).toBeUndefined();
  });
});
