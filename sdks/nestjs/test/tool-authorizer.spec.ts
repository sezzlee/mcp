import "reflect-metadata";
import {
  All,
  Controller,
  Get,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
  type INestApplication,
  type Type,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { McpServer } from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { SezzleeCatalogError } from "@sezzlee/core";
import type { Request, Response } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SezzleeCacheInvalidator,
  type CallerScopeResolver,
} from "../src/cache.js";
import { SezzleeCatalog } from "../src/catalog.js";
import { McpTool, McpToolFamily } from "../src/decorators.js";
import { SezzleeDispatcher } from "../src/dispatcher.js";
import { extensionTokens } from "../src/extension-points.js";
import type { McpFamilyMember } from "../src/families.js";
import type { InvokeResultMapper } from "../src/invoke-result-mapper.js";
import { registerSezzleeTools } from "../src/meta-tools.js";
import {
  SEZZLEE_OPTIONS,
  type OuterRequest,
  type SezzleeOptions,
} from "../src/options.js";
import { SezzleeModule } from "../src/sezzlee.module.js";
import {
  SezzleeStreamableHttp,
  type SezzleeRequestHandler,
} from "../src/transport/streamable-http.js";
import type {
  McpToolInfo,
  ToolAccess,
  ToolAuthorizer,
} from "../src/visibility/authorizer.js";
import { CallerVisibilityProvider } from "../src/visibility/provider.js";
import type { VisibilityDeclaration } from "../src/index.js";

class AnonymousGuard {
  canActivate(): boolean {
    return true;
  }

  describeVisibility(): VisibilityDeclaration {
    return { anonymous: "yes", policies: [] };
  }
}

const hits = { payroll: 0, sales: 0 };

@Controller("reports")
class ReportsController {
  @Get("payroll")
  @McpTool({
    name: "payroll_report",
    description: "Payroll totals by month.",
    tags: ["hr"],
  })
  @UseGuards(AnonymousGuard)
  payroll(): unknown {
    hits.payroll += 1;
    return { report: "payroll" };
  }

  @Get("salaries")
  @McpTool({
    name: "salary_report",
    description: "Salary bands by grade.",
    tags: ["hr"],
  })
  @UseGuards(AnonymousGuard)
  salaries(): unknown {
    return { report: "salaries" };
  }

  @Get("sales")
  @McpTool({
    name: "sales_report",
    description: "Sales by region.",
    tags: ["finance"],
  })
  @UseGuards(AnonymousGuard)
  sales(): unknown {
    hits.sales += 1;
    return { report: "sales" };
  }

  @Get("invoices")
  @McpTool({
    name: "invoice_report",
    description: "Invoices by customer.",
    tags: ["finance"],
  })
  @UseGuards(AnonymousGuard)
  invoices(): unknown {
    return { report: "invoices" };
  }

  @Get("refunds")
  @McpTool({
    name: "refund_report",
    description: "Refunds by reason.",
    tags: ["finance"],
  })
  @UseGuards(AnonymousGuard)
  refunds(): unknown {
    return { report: "refunds" };
  }

  @Get("notes")
  @McpTool({ name: "open_notes", description: "Shared notes.", tags: ["misc"] })
  @UseGuards(AnonymousGuard)
  notes(): unknown {
    return { report: "notes" };
  }

  @Get("audit")
  @McpTool({ name: "audit_log", description: "Audit trail.", tags: ["audit"] })
  audit(): unknown {
    return { report: "audit" };
  }
}

@Controller("methods")
class DispatchController {
  @Post("invoke/:methodId")
  @McpTool({ description: "Invokes a server method by its id." })
  @McpToolFamily({ parameter: "methodId", source: "methods" })
  @UseGuards(AnonymousGuard)
  invoke(): unknown {
    return { dispatched: true };
  }
}

@Controller("bulk")
class BulkDispatchController {
  @Post("invoke/:methodId")
  @McpTool({ description: "Invokes a bulk method by its id." })
  @McpToolFamily({ parameter: "methodId", source: "bulk" })
  invoke(): unknown {
    return { dispatched: true };
  }
}

const methodMembers: readonly McpFamilyMember[] = [
  {
    key: "k-1",
    name: "list_balances",
    description: "Lists customer balances.",
    body: { type: "object", properties: {} },
  },
  {
    key: "k-2",
    name: "list_delays",
    description: "Lists delayed orders.",
    body: { type: "object", properties: {} },
  },
  {
    key: "k-3",
    name: "close_books",
    description: "Closes the books.",
    body: { type: "object", properties: {} },
  },
];

const bulkMembers: readonly McpFamilyMember[] = Array.from(
  { length: 25 },
  (_, index) => ({
    key: `b-${String(index)}`,
    name: `member_${String(index).padStart(2, "0")}`,
    description: `Bulk member ${String(index)}.`,
    body: { type: "object", properties: {} },
  }),
);

const deniedHandlers: Record<string, readonly string[]> = {
  bob: ["payroll", "salaries"],
};

const allowedMemberKeys: Record<string, readonly string[]> = {
  alice: ["k-1", "k-2"],
  bob: ["k-1"],
};

const userOf = (request: OuterRequest | undefined): string => {
  const header = request?.headers.authorization;
  return typeof header === "string" ? header.slice("Bearer ".length) : "";
};

class TableAuthorizer implements ToolAuthorizer {
  readonly resolutions = new Map<string, number>();
  readonly asked: McpToolInfo[] = [];

  constructor(private readonly covered: (tool: McpToolInfo) => boolean) {}

  covers(tool: McpToolInfo): boolean {
    return this.covered(tool);
  }

  async resolve(request: OuterRequest | undefined): Promise<ToolAccess> {
    const user = userOf(request);
    this.resolutions.set(user, (this.resolutions.get(user) ?? 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    return {
      decide: (tool) => {
        this.asked.push(tool);
        if (tool.member !== undefined) {
          return (allowedMemberKeys[user] ?? []).includes(
            String(tool.member.key),
          )
            ? "allow"
            : "deny";
        }
        if (tool.handler.name === "audit" || tool.handler.name === "notes") {
          return "unknown";
        }
        return (deniedHandlers[user] ?? []).includes(tool.handler.name)
          ? "deny"
          : "allow";
      },
    };
  }
}

@Controller()
class McpController {
  private readonly serve: SezzleeRequestHandler;

  constructor(
    streamableHttp: SezzleeStreamableHttp,
    catalog: SezzleeCatalog,
    dispatcher: SezzleeDispatcher,
    visibility: CallerVisibilityProvider,
    @Inject(extensionTokens.invokeResultMapper) mapper: InvokeResultMapper,
    @Inject(extensionTokens.callerScopeResolver) scopes: CallerScopeResolver,
    @Inject(SEZZLEE_OPTIONS) options: SezzleeOptions,
  ) {
    this.serve = streamableHttp.serve(() => {
      const server = new McpServer({ name: "authorizer", version: "0.0.0" });
      registerSezzleeTools(server, {
        catalog,
        dispatcher,
        mapper,
        visibility,
        scopes,
        options,
      });
      return server;
    });
  }

  @All("mcp")
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.serve(req, res);
  }
}

interface Host {
  readonly app: INestApplication;
  readonly catalog: SezzleeCatalog;
  call(
    user: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ parsed: Record<string, unknown>; isError: boolean }>;
  close(): Promise<void>;
}

interface HostSetup {
  readonly controllers: Type<unknown>[];
  readonly configure?: (options: SezzleeOptions) => void;
  readonly authorizer?: ToolAuthorizer;
}

async function startHost(setup: HostSetup): Promise<Host> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      SezzleeModule.forRoot(
        (options) => {
          options.families.provide("methods", () => methodMembers);
          options.families.provide("bulk", () => bulkMembers);
          setup.configure?.(options);
        },
        setup.authorizer === undefined
          ? undefined
          : { toolAuthorizer: { useValue: setup.authorizer } },
      ),
    ],
    controllers: [...setup.controllers, McpController],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  await app.listen(0);
  const baseUrl = await app.getUrl();
  const clients = new Map<string, Client>();

  const clientFor = async (user: string): Promise<Client> => {
    const existing = clients.get(user);
    if (existing !== undefined) {
      return existing;
    }
    const client = new Client({ name: user, version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${user}` } },
      }),
    );
    clients.set(user, client);
    return client;
  };

  return {
    app,
    catalog: app.get(SezzleeCatalog),
    call: async (user, tool, args) => {
      const result = (await (
        await clientFor(user)
      ).callTool({ name: tool, arguments: args })) as unknown as {
        content: { text: string }[];
        isError?: boolean;
      };
      return {
        parsed: JSON.parse(result.content[0]?.text ?? "{}") as Record<
          string,
          unknown
        >,
        isError: result.isError === true,
      };
    },
    close: async () => {
      for (const client of clients.values()) {
        await client.close();
      }
      await app.close();
    },
  };
}

interface Card {
  readonly name: string;
  readonly authUncertain?: boolean;
}

const searchOf = async (
  host: Host,
  user: string,
  args: Record<string, unknown> = { query: "", limit: 100 },
): Promise<{ total: number; results: Card[]; tags?: string[] }> =>
  (await host.call(user, "search_tools", args)).parsed as unknown as {
    total: number;
    results: Card[];
    tags?: string[];
  };

const namesOf = async (host: Host, user: string): Promise<string[]> =>
  (await searchOf(host, user)).results.map((card) => card.name).sort();

const aliceSees = [
  "invoice_report",
  "list_balances",
  "list_delays",
  "open_notes",
  "payroll_report",
  "refund_report",
  "salary_report",
  "sales_report",
];

const bobSees = [
  "invoice_report",
  "list_balances",
  "open_notes",
  "refund_report",
  "sales_report",
];

describe("host authorizer", () => {
  let host: Host;
  let authorizer: TableAuthorizer;

  beforeAll(async () => {
    authorizer = new TableAuthorizer(() => true);
    host = await startHost({
      controllers: [ReportsController, DispatchController],
      authorizer,
    });
  });

  afterAll(async () => {
    await host.close();
  });

  it("gives two callers different search_tools results", async () => {
    const forAlice = await searchOf(host, "alice");
    const forBob = await searchOf(host, "bob");
    expect(forAlice.results.map((card) => card.name).sort()).toEqual(aliceSees);
    expect(forBob.results.map((card) => card.name).sort()).toEqual(bobSees);
    expect(forAlice.total).toBe(8);
    expect(forBob.total).toBe(5);
  });

  it("fills the limit from tools the caller may use", async () => {
    const forAlice = await searchOf(host, "alice", {
      query: "payroll salary report",
      limit: 2,
    });
    const forBob = await searchOf(host, "bob", {
      query: "payroll salary report",
      limit: 2,
    });
    expect(forAlice.results.map((card) => card.name).sort()).toEqual([
      "payroll_report",
      "salary_report",
    ]);
    expect(forBob.results).toHaveLength(2);
    for (const card of forBob.results) {
      expect(bobSees).toContain(card.name);
    }
  });

  it("builds the tags vocabulary from the tools a caller may use", async () => {
    const forAlice = await searchOf(host, "alice");
    const forBob = await searchOf(host, "bob");
    expect(forAlice.tags).toContain("hr");
    expect(forBob.tags).not.toContain("hr");
    expect(forBob.tags).toContain("finance");
  });

  it("answers load_tool for a denied tool exactly as for an unknown one", async () => {
    const denied = await host.call("bob", "load_tool", {
      name: "payroll_report",
    });
    const unknown = await host.call("bob", "load_tool", {
      name: "no_such_report",
    });
    expect(denied.isError).toBe(true);
    expect(denied.parsed["error"]).toBe("unknown_tool");
    expect(
      String(denied.parsed["message"]).replace("payroll_report", "X"),
    ).toBe(String(unknown.parsed["message"]).replace("no_such_report", "X"));
    const allowed = await host.call("alice", "load_tool", {
      name: "payroll_report",
    });
    expect(allowed.isError).toBe(false);
  });

  it("leaves invoke_tool to the backend pipeline: a tool the authorizer denies is still dispatched", async () => {
    const before = hits.payroll;
    const denied = await host.call("bob", "invoke_tool", {
      name: "payroll_report",
      arguments: {},
    });
    expect(denied.isError).toBe(false);
    expect(hits.payroll).toBe(before + 1);
  });

  it("decides a family member by its key and names the source", async () => {
    const forAlice = await namesOf(host, "alice");
    const forBob = await namesOf(host, "bob");
    expect(forAlice).toContain("list_delays");
    expect(forAlice).not.toContain("close_books");
    expect(forBob).toContain("list_balances");
    expect(forBob).not.toContain("list_delays");

    const refused = await host.call("bob", "load_tool", {
      name: "list_delays",
    });
    expect(refused.parsed["error"]).toBe("unknown_tool");

    const asked = authorizer.asked.find((tool) => tool.name === "list_delays");
    expect(asked?.member).toEqual({ source: "methods", key: "k-2" });
    expect(asked).toMatchObject({
      method: "POST",
      route: "/methods/invoke/{methodId}",
      container: "DispatchController",
    });
    expect(asked?.handler.name).toBe("invoke");
    expect(
      authorizer.asked.find((tool) => tool.name === "sales_report")?.member,
    ).toBeUndefined();
  });

  it("falls an unknown answer through to the declarative tier, then hides what is left", async () => {
    const forAlice = await namesOf(host, "alice");
    expect(forAlice).toContain("open_notes");
    expect(forAlice).not.toContain("audit_log");
    const unknown = await host.call("alice", "load_tool", {
      name: "audit_log",
    });
    expect(unknown.parsed["error"]).toBe("unknown_tool");
  });

  it("resolves once per caller scope inside the cache lifetime", async () => {
    await Promise.all([
      host.call("dave", "search_tools", { query: "" }),
      host.call("dave", "search_tools", { query: "report" }),
      host.call("dave", "load_tool", { name: "sales_report" }),
    ]);
    expect(authorizer.resolutions.get("dave")).toBe(1);

    const scopes = host.app.get<CallerScopeResolver>(
      extensionTokens.callerScopeResolver,
    );
    await host.app
      .get(SezzleeCacheInvalidator)
      .invalidateCaller(
        scopes.resolve({ headers: { authorization: "Bearer dave" } }),
      );
    await host.call("dave", "search_tools", { query: "" });
    expect(authorizer.resolutions.get("dave")).toBe(2);
    expect(authorizer.resolutions.get("erin")).toBeUndefined();

    await host.app.get(SezzleeCacheInvalidator).invalidateTag("tenant:acme");
    await host.call("dave", "search_tools", { query: "" });
    expect(authorizer.resolutions.get("dave")).toBe(3);
  });
});

describe("unknown policy with an authorizer", () => {
  it("shows what no tier decided, flagged uncertain, when onUnknown is show", async () => {
    const host = await startHost({
      controllers: [ReportsController],
      authorizer: new TableAuthorizer(() => true),
      configure: (options) => {
        options.visibility.onUnknown = "show";
      },
    });
    try {
      const cards = (await searchOf(host, "alice")).results;
      expect(
        cards.find((card) => card.name === "audit_log")?.authUncertain,
      ).toBe(true);
    } finally {
      await host.close();
    }
  });

  it("changes nothing for a host without an authorizer", async () => {
    const host = await startHost({ controllers: [ReportsController] });
    try {
      const forBob = await namesOf(host, "bob");
      expect(forBob).toContain("audit_log");
      expect(forBob).toContain("payroll_report");
      const invoked = await host.call("bob", "invoke_tool", {
        name: "payroll_report",
        arguments: {},
      });
      expect(invoked.isError).toBe(false);
    } finally {
      await host.close();
    }
  });
});

describe("visibility coverage", () => {
  const diagnosticOf = (catalog: SezzleeCatalog) =>
    catalog.diagnostics.find(
      (diagnostic) => diagnostic.code === "visibility_uncovered",
    );

  const bootCatalog = async (setup: HostSetup): Promise<SezzleeCatalog> => {
    const host = await startHost(setup);
    await host.close();
    return host.catalog;
  };

  it("reports the tools no tier can decide, once, when an authorizer is bound", async () => {
    const catalog = await bootCatalog({
      controllers: [ReportsController, DispatchController],
      authorizer: new TableAuthorizer((tool) => tool.handler.name !== "audit"),
    });
    const diagnostic = diagnosticOf(catalog);
    expect(diagnostic?.message).toContain("1 selected tool(s)");
    expect(diagnostic?.message).toContain("audit_log");
    expect(diagnostic?.message).not.toContain("sales_report");
    expect(
      catalog.diagnostics.filter(
        (entry) => entry.code === "visibility_uncovered",
      ),
    ).toHaveLength(1);
    expect(() => catalog.ensureValid()).not.toThrow();
  });

  it("stays silent when the authorizer covers every tool", async () => {
    const catalog = await bootCatalog({
      controllers: [ReportsController],
      authorizer: new TableAuthorizer(() => true),
    });
    expect(diagnosticOf(catalog)).toBeUndefined();
  });

  it("stays silent for a host with no authorizer", async () => {
    const catalog = await bootCatalog({ controllers: [ReportsController] });
    expect(diagnosticOf(catalog)).toBeUndefined();
  });

  it("counts a tool the probe tier can reach as covered", async () => {
    const catalog = await bootCatalog({
      controllers: [ReportsController],
      authorizer: new TableAuthorizer(() => false),
      configure: (options) => {
        options.visibility.tier = "probe";
      },
    });
    expect(diagnosticOf(catalog)).toBeUndefined();
  });

  it("names the first twenty tools and counts the rest", async () => {
    const catalog = await bootCatalog({
      controllers: [BulkDispatchController],
      authorizer: new TableAuthorizer(() => false),
    });
    const message = diagnosticOf(catalog)?.message ?? "";
    expect(message).toContain("25 selected tool(s)");
    expect(message).toContain("member_19");
    expect(message).not.toContain("member_20");
    expect(message).toContain("and 5 more");
  });

  it("fails the catalog when onUncovered is fatal, with or without an authorizer", async () => {
    const configure = (options: SezzleeOptions): void => {
      options.visibility.onUncovered = "fatal";
    };
    for (const authorizer of [
      new TableAuthorizer((tool) => tool.handler.name !== "audit"),
      undefined,
    ]) {
      const catalog = await bootCatalog({
        controllers: [ReportsController],
        configure,
        ...(authorizer === undefined ? {} : { authorizer }),
      });
      expect(() => catalog.ensureValid()).toThrow(SezzleeCatalogError);
      expect(catalog.current.fatal.map((entry) => entry.code)).toContain(
        "visibility_uncovered",
      );
    }
  });
});
