import "reflect-metadata";
import { Controller, Get, UseGuards } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { SezzleeCatalog } from "../src/catalog.js";
import { McpTool } from "../src/decorators.js";
import { SezzleeModule } from "../src/sezzlee.module.js";
import type { CatalogDiagnostic, VisibilityDeclaration } from "../src/index.js";

class AnonymousGuard {
  canActivate(): boolean {
    return true;
  }

  describeVisibility(): VisibilityDeclaration {
    return { anonymous: "yes", policies: [] };
  }
}

@Controller("declared")
class DeclaresTagsController {
  @Get()
  @McpTool({
    name: "declares_tags",
    description: "Lists rows.",
    tags: ["billing", "orders"],
  })
  @UseGuards(AnonymousGuard)
  list(): void {}

  @Get("duplicate")
  @McpTool({
    name: "duplicate_tags",
    description: "Lists rows.",
    tags: ["Orders", "orders"],
  })
  @UseGuards(AnonymousGuard)
  duplicate(): void {}

  @Get("empty")
  @McpTool({
    name: "empty_tag",
    description: "Lists rows.",
    tags: ["", "orders"],
  })
  @UseGuards(AnonymousGuard)
  empty(): void {}
}

@Controller("inherited")
@McpTool({ tags: ["billing"] })
class TaggedContainerController {
  @Get()
  @McpTool({ name: "inherits_tags", description: "Lists rows." })
  @UseGuards(AnonymousGuard)
  list(): void {}
}

@Controller("undeclared")
class UndeclaredController {
  @Get()
  @McpTool({ name: "undeclared_tags", description: "Lists rows." })
  @UseGuards(AnonymousGuard)
  list(): void {}
}

describe("tag declaration", () => {
  let catalog: SezzleeCatalog;
  let diagnostics: readonly CatalogDiagnostic[];

  const tagsOf = (name: string): readonly string[] | undefined =>
    catalog.current.byName.get(name)?.descriptor.tags;

  const codesFor = (fragment: string): string[] =>
    diagnostics
      .filter((diagnostic) => diagnostic.message.includes(fragment))
      .map((diagnostic) => diagnostic.code)
      .sort();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SezzleeModule.forRoot((options) => {
          options.tags = (container) =>
            container === "UndeclaredController" ? ["central"] : undefined;
        }),
      ],
      controllers: [
        DeclaresTagsController,
        TaggedContainerController,
        UndeclaredController,
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    catalog = app.get(SezzleeCatalog);
    diagnostics = catalog.diagnostics;
  });

  it("replaces the container-derived tag rather than adding to it", () => {
    expect(tagsOf("declares_tags")).toEqual(["billing", "orders"]);
  });

  it("keeps a container's tags when the operation marker declares none", () => {
    expect(tagsOf("inherits_tags")).toEqual(["billing"]);
  });

  it("drops a tag that folds onto an earlier one and says so", () => {
    expect(tagsOf("duplicate_tags")).toEqual(["Orders"]);
    expect(codesFor("'orders' and 'Orders'")).toEqual(["duplicate_tag"]);
  });

  /**
   * Guard: only a tag that folds to the empty string is dropped. Whitespace survives folding on
   * purpose — recognising a blank tag would need a whitespace class the two SDKs do not share,
   * the same reason a tag is never trimmed ([search-semantics.md]).
   */
  it("drops a tag that folds to nothing and says so", () => {
    expect(tagsOf("empty_tag")).toEqual(["orders"]);
    expect(codesFor("empty once folded")).toEqual(["empty_tag"]);
  });

  it("falls back to the host rule, then to the container", () => {
    expect(tagsOf("undeclared_tags")).toEqual(["central"]);
  });
});
