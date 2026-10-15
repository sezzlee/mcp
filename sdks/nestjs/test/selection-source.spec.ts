import "reflect-metadata";
import { Controller, Get, Logger, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SezzleeCatalogError } from "@sezzlee/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SezzleeCatalog } from "../src/catalog.js";
import { McpIgnore, McpTool } from "../src/decorators.js";
import type { McpEndpointInfo } from "../src/discovery/endpoint-discovery.js";
import type {
  McpSelectionEntry,
  McpSelectionSource,
} from "../src/selection-source.js";
import type { SezzleeOptions } from "../src/options.js";
import { SezzleeConfigurationError } from "../src/options-validation.js";
import { SezzleeModule } from "../src/sezzlee.module.js";

@Controller("reports")
class ReportsController {
  @Get("sales")
  sales(): void {}

  @Get("margins")
  margins(): void {}

  @Get("secrets")
  @McpIgnore()
  secrets(): void {}

  @Get("plain")
  plain(): void {}

  @Get("audit")
  audit(): void {}

  @Get("declared")
  @McpTool({
    name: "declared_report",
    description: "Declared.",
    tags: ["declared"],
    searchTerms: ["beyan"],
  })
  declared(): void {}
}

const row = (
  route: string,
  decision: McpSelectionEntry["decision"],
  more: Partial<McpSelectionEntry> = {},
): McpSelectionEntry => ({ method: "GET", route, decision, ...more });

const sequence =
  (...answers: ReadonlyArray<readonly McpSelectionEntry[] | Error>) =>
  (): McpSelectionSource => {
    let call = 0;
    return () => {
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      if (answer instanceof Error) {
        throw answer;
      }
      return answer as readonly McpSelectionEntry[];
    };
  };

let open: INestApplication | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function compile(configure: (options: SezzleeOptions) => void) {
  const moduleRef = await Test.createTestingModule({
    imports: [SezzleeModule.forRoot(configure)],
    controllers: [ReportsController],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  open = app;
  return { moduleRef, app };
}

async function start(
  source: McpSelectionSource,
  configure: (options: SezzleeOptions) => void = () => {},
): Promise<SezzleeCatalog> {
  const { app } = await compile((options) => {
    options.selection.provide(source);
    configure(options);
  });
  await app.init();
  return app.get(SezzleeCatalog);
}

const targetsOf = (catalog: SezzleeCatalog): string[] =>
  catalog.current.entries
    .map((entry) => entry.descriptor.route.replace("/reports/", ""))
    .sort();

const codesOf = (catalog: SezzleeCatalog): string[] =>
  catalog.current.diagnostics.map((diagnostic) => diagnostic.code);

const entryOf = (catalog: SezzleeCatalog, route: string) =>
  catalog.current.entries.find((entry) => entry.descriptor.route === route);

describe("provided selection levels", () => {
  it("outranks a rule and the default, and loses to a decorator", async () => {
    const catalog = await start(
      () => [
        row("/reports/sales", "include"),
        row("/reports/secrets", "include"),
        row("/reports/declared", "exclude"),
      ],
      (options) => {
        options.selection.rules = [
          { route: "/reports/**", decision: "exclude" },
        ];
      },
    );

    expect(targetsOf(catalog)).toEqual(["declared", "sales"]);
  });

  it("outranks the global include by excluding one endpoint", async () => {
    const catalog = await start(
      () => [row("/reports/plain", "exclude")],
      (options) => {
        options.selection.default = "include";
      },
    );

    expect(targetsOf(catalog)).toEqual([
      "audit",
      "declared",
      "margins",
      "sales",
    ]);
  });

  it("compares the method case-insensitively and the route as the catalog composes it", async () => {
    const catalog = await start(() => [
      { method: " get ", route: "reports//sales/", decision: "include" },
    ]);

    expect(targetsOf(catalog)).toEqual(["declared", "sales"]);
  });
});

describe("provided overrides", () => {
  const margins = row("/reports/margins", "include", {
    name: "margin_report",
    description: "Margins by region.",
    tags: ["finance"],
    searchTerms: ["marj"],
  });

  it("replaces the derived name, the description, the tags and the search terms", async () => {
    const catalog = await start(() => [margins]);

    const entry = entryOf(catalog, "/reports/margins");
    expect(entry?.tool.name).toBe("margin_report");
    expect(entry?.tool.description).toBe("Margins by region.");
    expect(entry?.descriptor.tags).toEqual(["finance"]);
    expect(entry?.descriptor.searchTerms).toEqual(["marj"]);
  });

  it("loses to the decorator's declaration on every field", async () => {
    const catalog = await start(() => [
      row("/reports/declared", "include", {
        name: "other_name",
        description: "Provided.",
        tags: ["provided"],
        searchTerms: ["sağlanan"],
      }),
    ]);

    const entry = entryOf(catalog, "/reports/declared");
    expect(entry?.tool.name).toBe("declared_report");
    expect(entry?.tool.description).toBe("Declared.");
    expect(entry?.descriptor.tags).toEqual(["declared"]);
    expect(entry?.descriptor.searchTerms).toEqual(["beyan"]);
  });

  it("sits above the endpoint hooks and is what they see as the declared description", async () => {
    const seen: Array<string | undefined> = [];
    const catalog = await start(
      () => [
        margins,
        row("/reports/plain", "include", { description: "Plain, provided." }),
        row("/reports/sales", "include"),
      ],
      (options) => {
        options.description = () => "From the hook.";
        options.endpointTags = (info: McpEndpointInfo) => {
          seen.push(info.declared);
          return ["hook"];
        };
      },
    );

    expect(entryOf(catalog, "/reports/margins")?.descriptor.tags).toEqual([
      "finance",
    ]);
    expect(entryOf(catalog, "/reports/plain")?.tool.description).toBe(
      "Plain, provided.",
    );
    expect(entryOf(catalog, "/reports/plain")?.descriptor.tags).toEqual([
      "hook",
    ]);
    expect(seen).toContain("Plain, provided.");
    expect(entryOf(catalog, "/reports/sales")?.tool.description).toBe(
      "From the hook.",
    );
  });
});

describe("the OpenAPI publication", () => {
  it("marks a provided include as a tool, under its provided name, and everything else as not", async () => {
    const catalog = await start(() => [
      row("/reports/margins", "include", { name: "margin_report" }),
      row("/reports/plain", "exclude"),
    ]);

    const { operations } = catalog.openApiExtensions();

    expect(operations.get("GET /reports/margins")).toMatchObject({
      tool: true,
      toolName: "margin_report",
    });
    expect(operations.get("GET /reports/plain")).toEqual({ tool: false });
    expect(operations.get("GET /reports/sales")).toEqual({ tool: false });
  });
});

describe("a defective row", () => {
  it("is reported and the other rows stay in force, and a contested endpoint is excluded under a global include", async () => {
    const catalog = await start(
      () => [
        row("/reports/sales", "include", { name: "Not A Tool Name" }),
        row("/reports/nowhere", "include"),
        row("/reports/plain", "include"),
        row("/reports/plain", "exclude"),
        { method: " ", route: "/reports/audit", decision: "include" },
        row("/reports/margins", "bogus" as never),
      ],
      (options) => {
        options.selection.default = "include";
      },
    );

    const codes = codesOf(catalog);
    expect(codes.filter((code) => code === "selection_target_unknown")).toEqual(
      ["selection_target_unknown"],
    );
    expect(codes.filter((code) => code === "selection_entry_conflict")).toEqual(
      ["selection_entry_conflict"],
    );
    expect(codes.filter((code) => code === "selection_entry_rejected")).toEqual(
      [
        "selection_entry_rejected",
        "selection_entry_rejected",
        "selection_entry_rejected",
      ],
    );
    expect(targetsOf(catalog)).toEqual([
      "audit",
      "declared",
      "margins",
      "sales",
    ]);
    expect(entryOf(catalog, "/reports/sales")?.tool.name).not.toBe(
      "Not A Tool Name",
    );
    expect(() => catalog.ensureValid()).not.toThrow();
  });

  it("is not a fall-through for an exclude whose override is invalid", async () => {
    const catalog = await start(
      () => [row("/reports/plain", "exclude", { description: "  " })],
      (options) => {
        options.selection.default = "include";
      },
    );

    expect(targetsOf(catalog)).not.toContain("plain");
    expect(codesOf(catalog)).toContain("selection_entry_rejected");
  });
});

describe("before the source has returned", () => {
  it("excludes every undecorated endpoint, reports it, and joins the rows when they arrive", async () => {
    let release: (rows: readonly McpSelectionEntry[]) => void = () => {};
    const gate = new Promise<readonly McpSelectionEntry[]>((resolve) => {
      release = resolve;
    });
    const info = vi.spyOn(Logger.prototype, "log");
    const warn = vi.spyOn(Logger.prototype, "warn");
    try {
      const { moduleRef, app } = await compile((options) => {
        options.selection.provide(() => gate);
        options.selection.source.loadMode = "background";
        options.selection.default = "include";
      });
      const catalog = moduleRef.get(SezzleeCatalog);
      let notified = 0;
      catalog.onChange(() => {
        notified += 1;
      });
      expect(targetsOf(catalog)).toEqual(["declared"]);
      expect(codesOf(catalog)).toContain("selection_not_loaded");

      await app.init();
      expect(targetsOf(catalog)).toEqual(["declared"]);
      expect(notified).toBe(0);

      release([row("/reports/audit", "exclude")]);
      await vi.waitFor(() => {
        expect(targetsOf(catalog)).toContain("sales");
      });
      expect(targetsOf(catalog)).toEqual([
        "declared",
        "margins",
        "plain",
        "sales",
      ]);
      expect(codesOf(catalog)).not.toContain("selection_not_loaded");
      expect(notified).toBe(1);
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining("selection source has not returned yet"),
      );
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("selection source"),
      );
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("stays closed, with a warning, when a blocking source never returns", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn");
    try {
      const catalog = await start(
        sequence(new Error("database unreachable"))(),
        (options) => {
          options.selection.default = "include";
        },
      );

      expect(targetsOf(catalog)).toEqual(["declared"]);
      expect(codesOf(catalog)).toContain("selection_not_loaded");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("selection source has never returned"),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("refreshing the provided selection", () => {
  it("leaves the catalog and its listeners alone when the rows are unchanged, in any order", async () => {
    const sales = row("/reports/sales", "include", { tags: ["a"] });
    const plain = row("/reports/plain", "include");
    const catalog = await start(
      sequence(
        [sales, plain],
        [plain, { ...sales, tags: ["a"] }],
        [sales, plain, row("/reports/margins", "include")],
      )(),
    );
    let notified = 0;
    catalog.onChange(() => {
      notified += 1;
    });
    const generation = catalog.generation;

    await catalog.refreshSelection();
    expect(catalog.generation).toBe(generation);
    expect(notified).toBe(0);

    await catalog.refreshSelection();
    expect(targetsOf(catalog)).toContain("margins");
    expect(catalog.generation).toBe(generation + 1);
    expect(notified).toBe(1);
  });

  it("keeps the rows it last returned when a refresh fails", async () => {
    const catalog = await start(
      sequence([row("/reports/sales", "include")], new Error("down"))(),
    );
    const generation = catalog.generation;

    await catalog.refreshSelection();

    expect(targetsOf(catalog)).toEqual(["declared", "sales"]);
    expect(catalog.generation).toBe(generation);
  });

  it("refuses a refresh that would turn a valid catalog fatal and keeps the current one", async () => {
    const catalog = await start(
      sequence(
        [row("/reports/sales", "include")],
        [row("/reports/plain", "include", { name: "declared_report" })],
      )(),
    );
    const generation = catalog.generation;

    await expect(catalog.refreshSelection()).rejects.toBeInstanceOf(
      SezzleeCatalogError,
    );

    expect(targetsOf(catalog)).toEqual(["declared", "sales"]);
    expect(catalog.generation).toBe(generation);
  });

  it("refreshes on its interval and stops when the application closes", async () => {
    const answer = vi.fn(
      sequence(
        [row("/reports/sales", "include")],
        [row("/reports/sales", "include"), row("/reports/plain", "include")],
      )(),
    );
    const catalog = await start(answer, (options) => {
      options.selection.source.refreshIntervalMs = 10;
    });

    await vi.waitFor(() => {
      expect(targetsOf(catalog)).toContain("plain");
    });
    await open?.close();
    open = undefined;
    const calls = answer.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(answer.mock.calls.length).toBe(calls);
  });

  it("drives families and the selection from one catalog", async () => {
    const { app } = await compile((options) => {
      options.selection.provide(() => [row("/reports/sales", "include")]);
      options.families.provide("unused", () => []);
    });
    await app.init();
    const catalog = app.get(SezzleeCatalog);

    await catalog.refreshFamilies();
    await catalog.refreshSelection();
    await catalog.reload();

    expect(targetsOf(catalog)).toEqual(["declared", "sales"]);
  });
});

describe("the selection source's load settings", () => {
  it("names selection.source.loadTimeoutMs when the source outlives it", async () => {
    const error = vi.spyOn(Logger.prototype, "error");
    try {
      await start(
        () => new Promise<never>(() => {}),
        (options) => {
          options.selection.source.loadTimeoutMs = 20;
        },
      );

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(
          `timeout: source 'selection' did not return within selection.source.loadTimeoutMs (20 ms); raise options.selection.source.loadTimeoutMs or set options.selection.source.loadMode to "background"`,
        ),
      );
    } finally {
      error.mockRestore();
    }
  });

  it("stops startup when the source never returns and onFailure is fatal", async () => {
    const { app } = await compile((options) => {
      options.selection.provide(() => {
        throw new Error("database unreachable");
      });
      options.selection.source.onFailure = "fatal";
    });

    const failure: unknown = await app.init().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(failure).toBeInstanceOf(SezzleeCatalogError);
    expect(failure).toMatchObject({
      code: "selection_source_failed",
      message: expect.stringContaining(
        "selection source 'selection' failed and selection.source.onFailure is \"fatal\": database unreachable",
      ) as string,
    });
  });

  it("is validated like the family source, under its own name", () => {
    let failure: unknown;
    try {
      SezzleeModule.forRoot((options) => {
        options.selection.source.loadTimeoutMs = 0;
        options.selection.source.refreshIntervalMs = 1.5;
        options.selection.source.onFailure = "fatal";
        options.selection.source.loadMode = "background";
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SezzleeConfigurationError);
    expect((failure as SezzleeConfigurationError).failures).toEqual([
      "selection.source.loadTimeoutMs must be a positive integer.",
      "selection.source.refreshIntervalMs must be zero or a positive integer.",
      'selection.source.onFailure "fatal" requires selection.source.loadMode "blocking": a background load ends after startup, when there is nothing left to stop.',
    ]);
  });
});
