import "reflect-metadata";
import {
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Injectable,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { SezzleeCache } from "@sezzlee/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallerScopeResolver } from "../src/cache.js";
import { SezzleeCatalog } from "../src/catalog.js";
import { McpTool } from "../src/decorators.js";
import { extensionTokens } from "../src/extension-points.js";
import { isSezzleeProbe } from "../src/index.js";
import type { OuterRequest, SezzleeOptions } from "../src/options.js";
import { SezzleeModule } from "../src/sezzlee.module.js";
import {
  auditVisibility,
  VisibilityAuditError,
  type AuditCaller,
} from "../src/testing.js";
import type {
  McpToolInfo,
  ToolAccess,
  ToolAuthorizer,
} from "../src/visibility/authorizer.js";
import { CallerVisibilityProvider } from "../src/visibility/provider.js";

type Answer = "allow" | "forbid" | "throttle";

const backend: { answer: (user: string, handler: string) => Answer } = {
  answer: () => "allow",
};

const hostView: { allows: (user: string, handler: string) => boolean } = {
  allows: () => true,
};

const probes = { total: 0, inFlight: 0, peak: 0 };
const probedHandlers = new Set<string>();

const userOf = (headers: { authorization?: string | undefined }): string =>
  (headers.authorization ?? "").slice("Bearer ".length);

@Injectable()
class BackendGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: { authorization?: string } }>();
    const handler = context.getHandler().name;
    if (isSezzleeProbe(request)) {
      probes.total += 1;
      probes.inFlight += 1;
      probes.peak = Math.max(probes.peak, probes.inFlight);
      probedHandlers.add(handler);
      await new Promise((resolve) => setTimeout(resolve, 10));
      probes.inFlight -= 1;
    }
    const answer = backend.answer(userOf(request.headers), handler);
    if (answer === "forbid") {
      throw new ForbiddenException();
    }
    if (answer === "throttle") {
      throw new HttpException("slow down", 429);
    }
    return true;
  }
}

@Controller("reports")
@UseGuards(BackendGuard)
class ReportsController {
  @Get("payroll")
  @McpTool({ name: "payroll_report", description: "Payroll totals." })
  payroll(): unknown {
    return {};
  }

  @Get("sales")
  @McpTool({ name: "sales_report", description: "Sales by region." })
  sales(): unknown {
    return {};
  }

  @Get("notes")
  @McpTool({ name: "open_notes", description: "Shared notes." })
  notes(): unknown {
    return {};
  }

  @Get("audit")
  @McpTool({ name: "audit_log", description: "Audit trail." })
  audit(): unknown {
    return {};
  }

  @Get("throttled")
  @McpTool({ name: "throttled_report", description: "A rate limited one." })
  throttled(): unknown {
    return {};
  }

  @Get("dispatch")
  @McpTool({ name: "method_dispatch", description: "Dispatches a method." })
  dispatch(): unknown {
    return {};
  }
}

const authorizer: ToolAuthorizer = {
  covers: () => true,
  resolve(request: OuterRequest | undefined): Promise<ToolAccess> {
    const user = userOf({ authorization: request?.headers.authorization });
    return Promise.resolve({
      decide: (tool: McpToolInfo) =>
        hostView.allows(user, tool.handler.name) ? "allow" : "deny",
    });
  },
};

const alice: AuditCaller = {
  name: "alice",
  headers: { Authorization: "Bearer alice" },
};
const bob: AuditCaller = {
  name: "bob",
  headers: { Authorization: "Bearer bob" },
};

const handlers = [
  "payroll",
  "sales",
  "notes",
  "audit",
  "throttled",
  "dispatch",
] as const;

let app: INestApplication | undefined;

async function startApp(
  configure: (options: SezzleeOptions) => void = () => undefined,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      SezzleeModule.forRoot(configure, {
        toolAuthorizer: { useValue: authorizer },
      }),
    ],
    controllers: [ReportsController],
    providers: [BackendGuard],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

const diverging = (user: string, handler: string): boolean =>
  user === "bob" && (handler === "payroll" || handler === "audit");

const resetPolicies = (): void => {
  backend.answer = () => "allow";
  hostView.allows = () => true;
  probes.total = 0;
  probes.inFlight = 0;
  probes.peak = 0;
  probedHandlers.clear();
};

describe("visibility audit", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    resetPolicies();
    await app?.close();
    app = undefined;
  });

  it("reports each way a host's visibility can disagree with its pipeline", async () => {
    backend.answer = (user, handler) =>
      handler === "throttled"
        ? "throttle"
        : diverging(user, handler)
          ? "forbid"
          : "allow";
    hostView.allows = (user, handler) => {
      if (handler === "sales") {
        return user !== "alice";
      }
      if (handler === "audit") {
        return user !== "bob";
      }
      if (handler === "dispatch") {
        return user !== "bob";
      }
      return true;
    };
    const report = await auditVisibility(await startApp(), [alice, bob]);

    expect(report.findings).toEqual([
      { caller: "alice", tool: "sales_report", kind: "hiddenButAllowed" },
      {
        caller: "alice",
        tool: "throttled_report",
        kind: "notComparable",
        reason: expect.stringContaining("inconclusive"),
      },
      { caller: "bob", tool: "payroll_report", kind: "listedButDenied" },
      {
        caller: "bob",
        tool: "throttled_report",
        kind: "notComparable",
        reason: expect.stringContaining("inconclusive"),
      },
      { caller: "bob", tool: "method_dispatch", kind: "hiddenButAllowed" },
    ]);
    expect(report.counts).toEqual({
      listedButDenied: 1,
      hiddenButAllowed: 2,
      notComparable: 2,
      excluded: 0,
    });
    expect(report.total).toBe(12);
    expect(report.consistent).toBe(7);
    expect(report.compared).toBe(10);
  });

  it("throws one grouped, readable message from ensureConsistent", async () => {
    backend.answer = (user, handler) =>
      diverging(user, handler) ? "forbid" : "allow";
    hostView.allows = (user, handler) =>
      !(user === "alice" && handler === "sales");
    const report = await auditVisibility(await startApp(), [alice, bob]);

    expect(() => report.ensureConsistent()).toThrow(VisibilityAuditError);
    expect(() => report.ensureConsistent()).toThrow(
      [
        "Visibility audit: 3 of 12 caller and tool pairs are not consistent (2 callers, 6 tools, 0 excluded).",
        "",
        "listedButDenied (2): listed by search_tools and load_tool, but the real pipeline answers 401 or 403",
        "  bob: payroll_report",
        "  bob: audit_log",
        "",
        "hiddenButAllowed (1): hidden by search_tools and load_tool, but the real pipeline lets the caller through",
        "  alice: sales_report",
      ].join("\n"),
    );
  });

  it("passes ensureConsistent when listing and pipeline agree", async () => {
    backend.answer = (user, handler) =>
      diverging(user, handler) ? "forbid" : "allow";
    hostView.allows = (user, handler) => !diverging(user, handler);
    const report = await auditVisibility(await startApp(), [alice, bob]);

    expect(() => report.ensureConsistent()).not.toThrow();
    expect(report.findings).toEqual([]);
    expect(report.consistent).toBe(12);
  });

  it("reports a tool the host excludes for every caller instead of dropping it", async () => {
    backend.answer = () => "allow";
    hostView.allows = (user, handler) =>
      !(user === "bob" && handler === "dispatch");
    const report = await auditVisibility(await startApp(), [alice, bob], {
      exclude: (tool) => tool.name === "method_dispatch",
    });

    expect(report.findings).toEqual([
      { caller: "alice", tool: "method_dispatch", kind: "excluded" },
      { caller: "bob", tool: "method_dispatch", kind: "excluded" },
    ]);
    expect(report.counts.excluded).toBe(2);
    expect(report.consistent).toBe(10);
    expect(report.total).toBe(12);
    expect(() => report.ensureConsistent()).not.toThrow();
  });

  it("probes every tool for every caller whatever the search cap, tier or cache", async () => {
    const report = await auditVisibility(
      await startApp((options) => {
        options.visibility.maxProbesPerSearch = 1;
        options.visibility.tier = "declarative";
      }),
      [alice, bob],
    );

    expect(report.consistent).toBe(12);
    expect(probes.total).toBe(12);
    expect(probedHandlers).toEqual(new Set(handlers));
  });

  it("probes at most `concurrency` requests at a time, four by default", async () => {
    const started = await startApp();
    await auditVisibility(started, [alice, bob], { concurrency: 2 });
    expect(probes.peak).toBe(2);

    probes.peak = 0;
    await auditVisibility(started, [alice, bob]);
    expect(probes.peak).toBe(4);
  });

  it("refuses a concurrency that is not a positive integer and a repeated caller name", async () => {
    const started = await startApp();
    await expect(
      auditVisibility(started, [alice], { concurrency: 0 }),
    ).rejects.toThrow("concurrency must be a positive integer");
    await expect(auditVisibility(started, [alice, alice])).rejects.toThrow(
      "caller name 'alice' is used twice",
    );
  });

  it("neither reads nor overwrites the shared verdict cache", async () => {
    const started = await startApp();
    const cache = started.get<SezzleeCache>(extensionTokens.cache);
    const provider = started.get(CallerVisibilityProvider);
    const scope = started
      .get<CallerScopeResolver>(extensionTokens.callerScopeResolver)
      .resolve({ headers: { authorization: "Bearer bob" } });
    const entry = started.get(SezzleeCatalog).find("sales_report");
    if (entry === undefined) {
      throw new Error("sales_report is not in the catalog");
    }
    await provider.probe(scope, entry, {
      headers: { authorization: "Bearer bob" },
    });
    expect(await provider.cachedProbe(scope, entry)).toBe("allow");

    backend.answer = (user, handler) =>
      user === "bob" && handler === "sales" ? "forbid" : "allow";
    const set = vi.spyOn(cache, "set");
    const report = await auditVisibility(started, [bob]);

    expect(report.findings).toEqual([
      { caller: "bob", tool: "sales_report", kind: "listedButDenied" },
    ]);
    expect(set).not.toHaveBeenCalled();
    expect(await provider.cachedProbe(scope, entry)).toBe("allow");
  });
});
