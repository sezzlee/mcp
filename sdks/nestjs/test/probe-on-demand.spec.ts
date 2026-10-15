import "reflect-metadata";
import {
  All,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Req,
  Res,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { McpServer } from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Request, Response } from "express";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type { CallerScopeResolver } from "../src/cache.js";
import { SezzleeCatalog } from "../src/catalog.js";
import { McpTool } from "../src/decorators.js";
import { SezzleeDispatcher } from "../src/dispatcher.js";
import { extensionTokens } from "../src/extension-points.js";
import type { InvokeResultMapper } from "../src/invoke-result-mapper.js";
import { isSezzleeProbe } from "../src/index.js";
import { registerSezzleeTools } from "../src/meta-tools.js";
import { SEZZLEE_OPTIONS, type SezzleeOptions } from "../src/options.js";
import { SezzleeModule } from "../src/sezzlee.module.js";
import {
  SezzleeStreamableHttp,
  type SezzleeRequestHandler,
} from "../src/transport/streamable-http.js";
import { CallerVisibilityProvider } from "../src/visibility/provider.js";

type Answer = "allow" | "forbid" | "throttle";

const policy: { answer: (user: string, handler: string) => Answer } = {
  answer: () => "allow",
};

const probeHits = new Map<string, number>();

const hitsOf = (user: string, handler: string): number =>
  probeHits.get(`${user}:${handler}`) ?? 0;

const totalHits = (user: string): number =>
  [...probeHits]
    .filter(([key]) => key.startsWith(`${user}:`))
    .reduce((sum, [, count]) => sum + count, 0);

@Injectable()
class PolicyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
    }>();
    const user = (request.headers["authorization"] ?? "").slice(
      "Bearer ".length,
    );
    const handler = context.getHandler().name;
    if (isSezzleeProbe(request)) {
      const key = `${user}:${handler}`;
      probeHits.set(key, (probeHits.get(key) ?? 0) + 1);
    }
    const answer = policy.answer(user, handler);
    if (answer === "forbid") {
      throw new ForbiddenException();
    }
    if (answer === "throttle") {
      throw new HttpException("slow down", 429);
    }
    return true;
  }
}

@Controller("docs")
@UseGuards(PolicyGuard)
class DocsController {
  @Get("d01")
  @McpTool({ name: "doc_01", description: "Document one." })
  d01(): unknown {
    return { doc: 1 };
  }

  @Get("d02")
  @McpTool({ name: "doc_02", description: "Document two." })
  d02(): unknown {
    return { doc: 2 };
  }

  @Get("d03")
  @McpTool({ name: "doc_03", description: "Document three." })
  d03(): unknown {
    return { doc: 3 };
  }

  @Get("d04")
  @McpTool({ name: "doc_04", description: "Document four." })
  d04(): unknown {
    return { doc: 4 };
  }

  @Get("d05")
  @McpTool({ name: "doc_05", description: "Document five." })
  d05(): unknown {
    return { doc: 5 };
  }

  @Get("d06")
  @McpTool({ name: "doc_06", description: "Document six." })
  d06(): unknown {
    return { doc: 6 };
  }

  @Get("d07")
  @McpTool({ name: "doc_07", description: "Document seven." })
  d07(): unknown {
    return { doc: 7 };
  }

  @Get("d08")
  @McpTool({ name: "doc_08", description: "Document eight." })
  d08(): unknown {
    return { doc: 8 };
  }

  @Get("d09")
  @McpTool({ name: "doc_09", description: "Document nine." })
  d09(): unknown {
    return { doc: 9 };
  }

  @Get("d10")
  @McpTool({ name: "doc_10", description: "Document ten." })
  d10(): unknown {
    return { doc: 10 };
  }

  @Get("d11")
  @McpTool({ name: "doc_11", description: "Document eleven." })
  d11(): unknown {
    return { doc: 11 };
  }

  @Get("d12")
  @McpTool({ name: "doc_12", description: "Document twelve." })
  d12(): unknown {
    return { doc: 12 };
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
      const server = new McpServer({
        name: "probe-on-demand",
        version: "0.0.0",
      });
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
  call(
    user: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ parsed: Record<string, unknown>; isError: boolean }>;
  search(user: string, limit: number): Promise<string[]>;
  close(): Promise<void>;
}

async function startHost(
  configure: (options: SezzleeOptions) => void,
): Promise<Host> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      SezzleeModule.forRoot((options) => {
        options.visibility.tier = "probe";
        configure(options);
      }),
    ],
    controllers: [DocsController, McpController],
    providers: [PolicyGuard],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication({
    logger: false,
  });
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

  const call: Host["call"] = async (user, tool, args) => {
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
  };

  return {
    call,
    search: async (user, limit) => {
      const { parsed } = await call(user, "search_tools", { query: "", limit });
      return (parsed["results"] as { name: string }[]).map((card) => card.name);
    },
    close: async () => {
      for (const client of clients.values()) {
        await client.close();
      }
      await app.close();
    },
  };
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 60));

const forbidFirst =
  (count: number) =>
  (_user: string, handler: string): Answer =>
    Number(handler.slice(1)) <= count ? "forbid" : "allow";

describe("probing until the page fills", () => {
  let host: Host;

  beforeEach(() => {
    probeHits.clear();
    policy.answer = () => "allow";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await host.close();
  });

  it("fills the page from allowed tools ranked beyond the first probed ones", async () => {
    host = await startHost((options) => {
      options.visibility.probeConcurrency = 2;
    });
    policy.answer = forbidFirst(9);
    expect(await host.search("carol", 3)).toEqual([
      "doc_10",
      "doc_11",
      "doc_12",
    ]);
  });

  it("stops sending probes once the page is full", async () => {
    host = await startHost((options) => {
      options.visibility.probeConcurrency = 2;
    });
    expect(await host.search("dave", 2)).toEqual(["doc_01", "doc_02"]);
    await settle();
    expect(totalHits("dave")).toBeLessThanOrEqual(3);
  });

  describe("with a cap", () => {
    let warn: MockInstance<Logger["warn"]>;

    beforeEach(() => {
      warn = vi
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => undefined);
    });

    it("returns the page as it stands, applies onUnknown to what was left, and warns once", async () => {
      host = await startHost((options) => {
        options.visibility.maxProbesPerSearch = 4;
        options.visibility.probeConcurrency = 2;
        options.visibility.onUnknown = "hide";
      });
      policy.answer = forbidFirst(9);
      expect(await host.search("gina", 3)).toEqual([]);
      await settle();
      expect(totalHits("gina")).toBe(4);
      const capWarnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes("maxProbesPerSearch"),
      );
      expect(capWarnings).toHaveLength(1);
      expect(String(capWarnings[0]?.[0])).toContain("(4)");
    });

    it("shows the unprobed tools when onUnknown is show", async () => {
      host = await startHost((options) => {
        options.visibility.maxProbesPerSearch = 4;
        options.visibility.onUnknown = "show";
      });
      policy.answer = forbidFirst(9);
      expect(await host.search("hank", 3)).toEqual([
        "doc_05",
        "doc_06",
        "doc_07",
      ]);
    });
  });

  it("reads a 429 as unknown and asks again on the next search", async () => {
    host = await startHost((options) => {
      options.visibility.onUnknown = "hide";
    });
    policy.answer = (_user, handler) =>
      handler === "d01" ? "throttle" : "allow";
    expect((await host.search("erin", 3)).slice(0, 2)).toEqual([
      "doc_02",
      "doc_03",
    ]);
    expect(hitsOf("erin", "d01")).toBe(1);

    policy.answer = () => "allow";
    expect(await host.search("erin", 3)).toEqual([
      "doc_01",
      "doc_02",
      "doc_03",
    ]);
    expect(hitsOf("erin", "d01")).toBe(2);
    expect(hitsOf("erin", "d02")).toBe(1);
  });

  it("answers a second search from the cached verdicts", async () => {
    host = await startHost(() => undefined);
    await host.search("ivy", 2);
    await host.search("ivy", 2);
    expect(hitsOf("ivy", "d01")).toBe(1);
    expect(hitsOf("ivy", "d02")).toBe(1);
  });

  it("probes only the one tool load_tool names", async () => {
    host = await startHost(() => undefined);
    policy.answer = (_user, handler) =>
      handler === "d06" ? "forbid" : "allow";
    const allowed = await host.call("frank", "load_tool", { name: "doc_05" });
    expect(allowed.isError).toBe(false);
    expect(allowed.parsed["name"]).toBe("doc_05");
    const denied = await host.call("frank", "load_tool", { name: "doc_06" });
    expect(denied.parsed["error"]).toBe("unknown_tool");
    expect(hitsOf("frank", "d05")).toBe(1);
    expect(hitsOf("frank", "d06")).toBe(1);
    expect(totalHits("frank")).toBe(2);
  });
});
