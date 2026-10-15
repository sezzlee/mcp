import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  UseGuards,
  type INestApplication,
} from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { SezzleeArgumentError, SezzleeCatalogError } from "@sezzlee/core";
import { IsInt, IsOptional, IsString } from "class-validator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SezzleeCatalog } from "../src/catalog.js";
import { McpTool, McpToolFamily } from "../src/decorators.js";
import { SezzleeDispatcher } from "../src/dispatcher.js";
import type { McpFamilyMember, McpFamilySource } from "../src/families.js";
import { SezzleeModule } from "../src/sezzlee.module.js";
import type { SezzleeOptions } from "../src/options.js";
import { SezzleeConfigurationError } from "../src/options-validation.js";
import type { VisibilityDeclaration } from "../src/index.js";

class AnonymousGuard {
  canActivate(): boolean {
    return true;
  }

  describeVisibility(): VisibilityDeclaration {
    return { anonymous: "yes", policies: [] };
  }
}

@Controller("Rest")
class DynamicMethodController {
  @Post("InvokeDynamicMethod/:methodId")
  @McpTool({ description: "Invokes a server method by its id." })
  @McpToolFamily({ parameter: "methodId", source: "methods" })
  @UseGuards(AnonymousGuard)
  invoke(
    @Param("methodId") methodId: string,
    @Body() body: Record<string, unknown>,
  ): unknown {
    return { methodId, received: body };
  }
}

@Controller("Legacy")
class UnregisteredSourceController {
  @Post("Invoke/:methodId")
  @McpTool({ description: "Invokes a legacy method by its id." })
  @McpToolFamily({ parameter: "methodId", source: "legacy" })
  @UseGuards(AnonymousGuard)
  invoke(
    @Param("methodId") _methodId: string,
    @Body() _body: Record<string, unknown>,
  ): void {}
}

@Controller("orders")
class OrdersController {
  @Get()
  @McpTool({ name: "list_orders", description: "Siparişleri listeler." })
  @UseGuards(AnonymousGuard)
  list(): unknown[] {
    return [];
  }
}

const balancesKey = "3f2c9a1e-8b4d-4c6a-9e21-7d5b0c4a1f10";

const balances: McpFamilyMember = {
  key: balancesKey,
  name: "list_customer_balances",
  description: "Müşteri bakiyelerini listeler.",
  body: {
    type: "object",
    properties: { minBalance: { type: "number" } },
  },
  readOnly: true,
};

const delayed: McpFamilyMember = {
  key: "b27e5d04-61a3-4f8e-a0c9-2e8d7f13b5a6",
  name: "list_delayed_orders",
  description: "Gecikmiş siparişleri listeler.",
  body: {
    type: "object",
    properties: { days: { type: "integer" } },
    required: ["days"],
  },
};

class DelayedOrdersFilter {
  @IsInt()
  days!: number;

  @IsOptional()
  @IsString()
  region?: string;
}

const delayedByClass: McpFamilyMember = {
  key: "c91d0e72-3a55-4b18-8f6e-5a2f4d7b9e03",
  name: "list_delayed_orders_by_class",
  description: "Gecikmiş siparişleri sınıftan listeler.",
  bodyType: DelayedOrdersFilter,
};

const sequence =
  (...answers: ReadonlyArray<readonly McpFamilyMember[] | Error>) =>
  (): McpFamilySource => {
    let call = 0;
    return () => {
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      if (answer instanceof Error) {
        throw answer;
      }
      return answer as readonly McpFamilyMember[];
    };
  };

let open: INestApplication | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function compile(
  configure: (options: SezzleeOptions) => void,
  controllers: NewableFunction[] = [DynamicMethodController, OrdersController],
): Promise<{ moduleRef: TestingModule; app: INestApplication }> {
  const moduleRef = await Test.createTestingModule({
    imports: [SezzleeModule.forRoot(configure)],
    controllers: controllers as never,
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  open = app;
  return { moduleRef, app };
}

async function start(
  source: McpFamilySource,
  configure: (options: SezzleeOptions) => void = () => {},
): Promise<{ catalog: SezzleeCatalog; dispatcher: SezzleeDispatcher }> {
  const { app } = await compile((options) => {
    options.families.provide("methods", source);
    configure(options);
  });
  await app.init();
  return {
    catalog: app.get(SezzleeCatalog),
    dispatcher: app.get(SezzleeDispatcher),
  };
}

const codesOf = (catalog: SezzleeCatalog): string[] =>
  catalog.current.diagnostics.map((diagnostic) => diagnostic.code);

const namesOf = (catalog: SezzleeCatalog): string[] =>
  [...catalog.current.byName.keys()].sort();

describe("tool families", () => {
  it("publishes one tool per member, searchable by its own terms and never by its key", async () => {
    const { catalog } = await start(() => [balances, delayed]);

    expect(namesOf(catalog)).toEqual([
      "list_customer_balances",
      "list_delayed_orders",
      "list_orders",
    ]);
    expect(catalog.current.index.search("bakiye", 10)[0]).toBe(
      "list_customer_balances",
    );
    expect(catalog.current.index.search(balancesKey, 10)).toEqual([]);
    const tool = catalog.find("list_customer_balances")?.tool;
    expect(tool?.inputSchema.properties).toEqual({
      minBalance: { type: "number" },
    });
    expect(tool?.annotations).toEqual({
      destructiveHint: false,
      readOnlyHint: true,
    });
  });

  it("dispatches a member with its own key and refuses the key as an argument", async () => {
    const { catalog, dispatcher } = await start(() => [balances, delayed]);
    const template = catalog.find("list_customer_balances")?.template;
    if (template === undefined) {
      return expect.unreachable("the member has a template");
    }

    const result = await dispatcher.dispatch(
      template,
      { minBalance: 1000 },
      { headers: {} },
    );

    expect(result.status).toBe(201);
    expect(JSON.parse(result.body)).toEqual({
      methodId: balancesKey,
      received: { minBalance: 1000 },
    });
    await expect(
      dispatcher.dispatch(
        template,
        { minBalance: 1000, methodId: delayed.key },
        { headers: {} },
      ),
    ).rejects.toBeInstanceOf(SezzleeArgumentError);
  });

  it("publishes nothing for a family whose source is not registered", async () => {
    const { app } = await compile(() => {}, [UnregisteredSourceController]);
    await app.init();
    const catalog = app.get(SezzleeCatalog);

    expect(namesOf(catalog)).toEqual([]);
    expect(codesOf(catalog)).toContain("unknown_family_source");
  });

  it("drops an ill-formed member and keeps its siblings", async () => {
    const { catalog } = await start(() => [
      balances,
      { ...delayed, name: "List-Delayed" },
    ]);

    expect(namesOf(catalog)).toEqual(["list_customer_balances", "list_orders"]);
    expect(codesOf(catalog)).toContain("family_member_rejected");
  });

  it("drops the family when its source fails before ever returning", async () => {
    const { catalog } = await start(() => {
      throw new Error("database unreachable");
    });

    expect(namesOf(catalog)).toEqual(["list_orders"]);
    expect(codesOf(catalog)).toContain("family_source_failed");
  });

  it("treats a source that outlives its timeout as failed", async () => {
    const { catalog } = await start(
      () => new Promise<never>(() => {}),
      (options) => {
        options.families.loadTimeoutMs = 20;
      },
    );

    expect(codesOf(catalog)).toContain("family_source_failed");
  });

  it("keeps the last members when a reload's load fails", async () => {
    const { catalog } = await start(
      sequence([balances], new Error("database unreachable"))(),
    );
    const generation = catalog.generation;

    await catalog.reload();

    expect(namesOf(catalog)).toEqual(["list_customer_balances", "list_orders"]);
    expect(codesOf(catalog)).toContain("family_source_stale");
    expect(catalog.generation).toBe(generation + 1);
  });

  it("advances the generation and notifies when membership changes", async () => {
    const { catalog } = await start(
      sequence([balances], [balances, delayed])(),
    );
    let notified = 0;
    catalog.onChange(() => {
      notified += 1;
    });

    await catalog.reload();

    expect(namesOf(catalog)).toContain("list_delayed_orders");
    expect(notified).toBe(1);
  });

  it("refuses a reload that would turn a valid catalog fatal and keeps the current one", async () => {
    const { catalog } = await start(
      sequence([balances], [{ ...delayed, name: "list_orders" }])(),
    );
    const generation = catalog.generation;

    await expect(catalog.reload()).rejects.toBeInstanceOf(SezzleeCatalogError);

    expect(namesOf(catalog)).toEqual(["list_customer_balances", "list_orders"]);
    expect(catalog.generation).toBe(generation);
  });

  it("rebuilds a catalog read before its members loaded", async () => {
    const { moduleRef, app } = await compile((options) => {
      options.families.provide("methods", () => [balances]);
    });
    const catalog = moduleRef.get(SezzleeCatalog);
    expect(codesOf(catalog)).toContain("family_not_loaded");
    const generation = catalog.generation;

    await app.init();

    expect(namesOf(catalog)).toContain("list_customer_balances");
    expect(catalog.generation).toBe(generation + 1);
  });

  it("names the setting to raise when a source outlives its timeout", async () => {
    const { catalog } = await start(
      () => new Promise<never>(() => {}),
      (options) => {
        options.families.loadTimeoutMs = 20;
      },
    );

    const message = catalog.current.diagnostics.find(
      (diagnostic) => diagnostic.code === "family_source_failed",
    )?.message;
    expect(message).toContain(
      `timeout: source 'methods' did not return within families.loadTimeoutMs (20 ms); raise options.families.loadTimeoutMs or set options.families.loadMode to "background"`,
    );
  });

  it("words a timeout the same when the source rejects with the abort reason", async () => {
    const { catalog } = await start(
      ({ signal }) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
      (options) => {
        options.families.loadTimeoutMs = 20;
      },
    );

    expect(
      catalog.current.diagnostics.some((diagnostic) =>
        diagnostic.message.includes(
          "timeout: source 'methods' did not return within families.loadTimeoutMs (20 ms)",
        ),
      ),
    ).toBe(true);
  });

  it("stops startup when a source never returns and onFailure is fatal", async () => {
    const { app } = await compile((options) => {
      options.families.provide("methods", () => {
        throw new Error("database unreachable");
      });
      options.families.onFailure = "fatal";
    });

    const failure: unknown = await app.init().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SezzleeCatalogError);
    expect(failure).toMatchObject({
      code: "family_source_failed",
      message: expect.stringContaining(
        "source 'methods' failed and families.onFailure is \"fatal\": database unreachable",
      ) as string,
    });
  });

  it("refuses fatal with a background load and a refresh interval that is not a whole number", () => {
    const configure = (options: SezzleeOptions): void => {
      options.families.onFailure = "fatal";
      options.families.loadMode = "background";
      options.families.refreshIntervalMs = 1.5;
    };

    let failure: unknown;
    try {
      SezzleeModule.forRoot(configure);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SezzleeConfigurationError);
    expect((failure as SezzleeConfigurationError).failures).toEqual([
      "families.refreshIntervalMs must be zero or a positive integer.",
      'families.onFailure "fatal" requires families.loadMode "blocking": a background load ends after startup, when there is nothing left to stop.',
    ]);
  });

  it("starts without waiting for a background source and joins its members when it returns", async () => {
    let release: (members: readonly McpFamilyMember[]) => void = () => {};
    const gate = new Promise<readonly McpFamilyMember[]>((resolve) => {
      release = resolve;
    });
    const { moduleRef, app } = await compile((options) => {
      options.families.provide("methods", () => gate);
      options.families.loadMode = "background";
    });
    const catalog = moduleRef.get(SezzleeCatalog);
    expect(codesOf(catalog)).toContain("family_not_loaded");
    let notified = 0;
    catalog.onChange(() => {
      notified += 1;
    });

    await app.init();
    expect(namesOf(catalog)).toEqual(["list_orders"]);
    expect(notified).toBe(0);

    release([balances]);
    await vi.waitFor(() => {
      expect(namesOf(catalog)).toContain("list_customer_balances");
    });
    expect(notified).toBe(1);
  });

  it("leaves the catalog and its listeners alone when a refresh returns the same members", async () => {
    const { catalog } = await start(
      sequence(
        [balances],
        [{ ...balances, body: structuredClone(balances.body) }],
        [balances, delayed],
      )(),
    );
    let notified = 0;
    catalog.onChange(() => {
      notified += 1;
    });
    const generation = catalog.generation;

    await catalog.refreshFamilies();
    expect(catalog.generation).toBe(generation);
    expect(notified).toBe(0);

    await catalog.refreshFamilies();
    expect(namesOf(catalog)).toContain("list_delayed_orders");
    expect(catalog.generation).toBe(generation + 1);
    expect(notified).toBe(1);
  });

  it("refuses a refresh that would turn a valid catalog fatal and keeps the current one", async () => {
    const { catalog } = await start(
      sequence([balances], [{ ...delayed, name: "list_orders" }])(),
    );
    const generation = catalog.generation;

    await expect(catalog.refreshFamilies()).rejects.toBeInstanceOf(
      SezzleeCatalogError,
    );

    expect(namesOf(catalog)).toEqual(["list_customer_balances", "list_orders"]);
    expect(catalog.generation).toBe(generation);
  });

  it("refreshes on its interval and stops when the application closes", async () => {
    const answer = vi.fn(sequence([balances], [balances, delayed])());
    const { catalog } = await start(answer, (options) => {
      options.families.refreshIntervalMs = 10;
    });

    await vi.waitFor(() => {
      expect(namesOf(catalog)).toContain("list_delayed_orders");
    });
    await open?.close();
    open = undefined;
    const calls = answer.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(answer.mock.calls.length).toBe(calls);
  });

  it("logs each source's outcome", async () => {
    const info = vi.spyOn(Logger.prototype, "log");
    const warn = vi.spyOn(Logger.prototype, "warn");
    const error = vi.spyOn(Logger.prototype, "error");
    try {
      const { catalog } = await start(
        sequence([balances], new Error("database unreachable"))(),
        (options) => {
          options.families.provide("legacy", () => {
            throw new Error("boom");
          });
        },
      );
      await catalog.reload();

      expect(info).toHaveBeenCalledWith(
        expect.stringMatching(
          /^sezzlee family source 'methods' returned 1 member\(s\) in \d+ ms$/,
        ),
      );
      expect(error).toHaveBeenCalledWith(
        "sezzlee family source 'legacy' failed and has never returned members; the operations it feeds are dropped: boom",
      );
      expect(warn).toHaveBeenCalledWith(
        "sezzlee family source 'methods' failed; the 1 member(s) it last returned stay published: database unreachable",
      );
    } finally {
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("maps a member's bodyType the way an @Body() class is mapped", async () => {
    const { catalog } = await start(() => [delayedByClass]);

    const tool = catalog.find("list_delayed_orders_by_class")?.tool;

    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: { days: { type: "integer" }, region: { type: "string" } },
      required: ["days"],
    });
  });

  it("reports what mapping a bodyType says, prefixed with the member", async () => {
    const { catalog } = await start(() => [
      { ...delayedByClass, bodyType: Object as never },
    ]);

    const prefixed = catalog.current.diagnostics.filter((diagnostic) =>
      diagnostic.message.startsWith(
        "DynamicMethodController.invoke member 'list_delayed_orders_by_class': ",
      ),
    );
    expect(prefixed.length).toBeGreaterThan(0);
  });

  it("drops a member that sets both body and bodyType", async () => {
    const { catalog } = await start(() => [
      { ...delayedByClass, body: { type: "object" } } as never,
    ]);

    expect(codesOf(catalog)).toContain("family_member_rejected");
    expect(namesOf(catalog)).toEqual(["list_orders"]);
  });
});
