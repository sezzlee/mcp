import "reflect-metadata";
import type { ServerResponse } from "node:http";
import {
  All,
  Controller,
  Get,
  Inject,
  Req,
  Res,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { McpServer } from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallerScopeResolver } from "../src/cache.js";
import { SezzleeCatalog } from "../src/catalog.js";
import { McpTool } from "../src/decorators.js";
import { SezzleeDispatcher } from "../src/dispatcher.js";
import { extensionTokens } from "../src/extension-points.js";
import type { InvokeResultMapper } from "../src/invoke-result-mapper.js";
import { rateLimitHostTool, registerSezzleeTools } from "../src/meta-tools.js";
import { SEZZLEE_OPTIONS, SezzleeOptions } from "../src/options.js";
import {
  collectConfigurationFailures,
  SezzleeConfigurationError,
} from "../src/options-validation.js";
import {
  createConcurrencyLimiter,
  createFixedWindowLimiter,
} from "../src/rate-limiting/limiters.js";
import type {
  McpCallContext,
  RateLimitPartition,
  RateLimitSettings,
  SezzleeRateLimitingOptions,
} from "../src/rate-limiting/types.js";
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

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const deferred = (): Deferred => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const flow = { entered: deferred(), release: deferred() };

@Controller("reports")
class ReportsController {
  @Get("public")
  @McpTool({ name: "public_report", description: "A report anyone may read." })
  open(): unknown {
    return { report: "public" };
  }

  @Get("secret")
  @McpTool({ name: "secret_report", description: "A report nobody may read." })
  secret(): unknown {
    return { report: "secret" };
  }

  @Get("gated")
  @McpTool({ name: "gated_report", description: "A report that waits." })
  async gated(): Promise<unknown> {
    flow.entered.resolve();
    await flow.release.promise;
    return { report: "gated" };
  }

  @Get("hang")
  @McpTool({ name: "hang_report", description: "A report that never ends." })
  hang(@Res() _res: ServerResponse): undefined {
    flow.entered.resolve();
    return undefined;
  }
}

class DenySecretAuthorizer implements ToolAuthorizer {
  covers(): boolean {
    return true;
  }

  resolve(): Promise<ToolAccess> {
    return Promise.resolve({
      decide: (tool: McpToolInfo) =>
        tool.name === "secret_report" ? "deny" : "allow",
    });
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
      const server = new McpServer({ name: "rate-limits", version: "0.0.0" });
      const deps = {
        catalog,
        dispatcher,
        mapper,
        visibility,
        scopes,
        options,
      };
      registerSezzleeTools(server, deps);
      server.registerTool(
        "host_ping",
        {
          description: "A host tool beside the meta-tools.",
          inputSchema: z.object({}),
        },
        rateLimitHostTool(deps, "host_ping", () =>
          Promise.resolve({
            content: [{ type: "text", text: JSON.stringify({ pong: true }) }],
          }),
        ),
      );
      return server;
    });
  }

  @All("mcp")
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.serve(req, res);
  }
}

interface Answer {
  readonly parsed: Record<string, unknown>;
  readonly isError: boolean;
}

interface Host {
  readonly app: INestApplication;
  readonly baseUrl: string;
  readonly dispatcher: SezzleeDispatcher;
  call(
    user: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Answer>;
}

const hosts: { app: INestApplication; clients: Map<string, Client> }[] = [];

async function startHost(
  rateLimiting: SezzleeRateLimitingOptions | undefined,
): Promise<Host> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      SezzleeModule.forRoot(
        (options) => {
          if (rateLimiting !== undefined) {
            options.rateLimiting = rateLimiting;
          }
        },
        { toolAuthorizer: { useValue: new DenySecretAuthorizer() } },
      ),
    ],
    controllers: [ReportsController, McpController],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  await app.listen(0);
  const baseUrl = await app.getUrl();
  const clients = new Map<string, Client>();
  hosts.push({ app, clients });

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
    baseUrl,
    dispatcher: app.get(SezzleeDispatcher),
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
  };
}

const rawCall = (
  host: Host,
  user: string,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<globalThis.Response> =>
  fetch(`${host.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${user}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
    ...(signal === undefined ? {} : { signal }),
  });

const window60s: RateLimitSettings = {
  kind: "fixedWindow",
  permitLimit: 1,
  windowMs: 60_000,
};

const refusedMessage = (tail: string): string =>
  `The call was refused by this server's rate limit before it ran. ${tail}`;

const invoke = (name: string): Record<string, unknown> => ({
  name,
  arguments: {},
});

let clock = 0;

beforeEach(() => {
  clock = 0;
  flow.entered = deferred();
  flow.release = deferred();
});

afterEach(async () => {
  vi.restoreAllMocks();
  flow.release.resolve();
  for (const { app, clients } of hosts.splice(0)) {
    for (const client of clients.values()) {
      await client.close();
    }
    await app.close();
  }
});

describe("meta-tool rate limiting", () => {
  it("leaves search_tools allowed once invoke_tool is exhausted", async () => {
    const host = await startHost({
      invoke: { ...window60s, permitLimit: 2 },
      now: () => clock,
    });

    const first = await host.call(
      "ann",
      "invoke_tool",
      invoke("public_report"),
    );
    const second = await host.call(
      "ann",
      "invoke_tool",
      invoke("public_report"),
    );
    const third = await host.call(
      "ann",
      "invoke_tool",
      invoke("public_report"),
    );
    const search = await host.call("ann", "search_tools", { query: "report" });

    expect([first.isError, second.isError]).toEqual([false, false]);
    expect(third.parsed["error"]).toBe("rate_limit_exceeded");
    expect(search.isError).toBe(false);
  });

  it("refuses with the pinned envelope and a whole-second retry-after, never an HTTP 429", async () => {
    const host = await startHost({
      invoke: window60s,
      now: () => clock,
    });
    await host.call("bea", "invoke_tool", invoke("public_report"));

    clock = 1_500;
    const refused = await host.call(
      "bea",
      "invoke_tool",
      invoke("public_report"),
    );

    expect(refused.isError).toBe(true);
    expect(refused.parsed).toEqual({
      error: "rate_limit_exceeded",
      message: refusedMessage("Retry after 59 seconds."),
      retryable: true,
      retryAfterSeconds: 59,
    });
    const raw = await rawCall(
      host,
      "bea",
      "invoke_tool",
      invoke("public_report"),
    );
    expect(raw.status).toBe(200);
    expect(await raw.text()).toContain("rate_limit_exceeded");
  });

  it("keeps a bucket per meta-tool section and shares default among the rest, host tools included", async () => {
    const host = await startHost({
      default: window60s,
      search: window60s,
      now: () => clock,
    });

    const firstSearch = await host.call("cat", "search_tools", { query: "" });
    const secondSearch = await host.call("cat", "search_tools", { query: "" });
    const load = await host.call("cat", "load_tool", { name: "public_report" });
    const hostTool = await host.call("cat", "host_ping", {});

    expect(firstSearch.isError).toBe(false);
    expect(secondSearch.parsed["error"]).toBe("rate_limit_exceeded");
    expect(load.isError).toBe(false);
    expect(hostTool.parsed["error"]).toBe("rate_limit_exceeded");
  });

  it("limits each caller scope on its own", async () => {
    const host = await startHost({ invoke: window60s, now: () => clock });

    await host.call("dan", "invoke_tool", invoke("public_report"));
    const other = await host.call(
      "eve",
      "invoke_tool",
      invoke("public_report"),
    );

    expect(other.isError).toBe(false);
  });

  describe("a call naming a tool the caller cannot see", () => {
    const seen: McpCallContext[] = [];

    it.each([
      ["load_tool", "secret_report", "unknown_tool"],
      ["load_tool", "no_such_report", "unknown_tool"],
      ["invoke_tool", "secret_report", undefined],
      ["invoke_tool", "no_such_report", "unknown_tool"],
    ])("%s of %s consumes a permit", async (tool, name, answer) => {
      const args = (target: string): Record<string, unknown> =>
        tool === "load_tool" ? { name: target } : invoke(target);
      const host = await startHost({
        partition: (call) => ({
          key: `${call.metaTool}:${call.callerScope}`,
          create: () => createFixedWindowLimiter(window60s, () => clock),
        }),
      });
      const user = `${tool}-${name}`;

      const hidden = await host.call(user, tool, args(name));
      const visible = await host.call(user, tool, args("public_report"));

      expect(hidden.parsed["error"]).toBe(answer);
      expect(visible.parsed["error"]).toBe("rate_limit_exceeded");
    });

    it("hands the key function the catalog target without consulting visibility", async () => {
      seen.length = 0;
      const host = await startHost({
        invoke: { ...window60s, permitLimit: 5 },
        load: { ...window60s, permitLimit: 5 },
        key: (call) => {
          seen.push(call);
          return call.callerScope;
        },
      });

      await host.call("fay", "load_tool", { name: "secret_report" });
      await host.call("fay", "load_tool", { name: "no_such_report" });
      await host.call("fay", "load_tool", { name: 42 });
      await host.call("fay", "invoke_tool", invoke("public_report"));

      expect(
        seen.map((call) => [call.toolName, call.metaTool, call.target?.name]),
      ).toEqual([
        ["load_tool", "load", "secret_report"],
        ["load_tool", "load", undefined],
        ["load_tool", "load", undefined],
        ["invoke_tool", "invoke", "public_report"],
      ]);
    });
  });

  describe("invokeConcurrency", () => {
    it("refuses a second call while one runs, with no retry-after, and admits the next once it ends", async () => {
      const host = await startHost({ invokeConcurrency: 1 });

      const running = host.call("gus", "invoke_tool", invoke("gated_report"));
      await flow.entered.promise;
      const refused = await host.call(
        "gus",
        "invoke_tool",
        invoke("public_report"),
      );
      flow.release.resolve();
      const finished = await running;
      const next = await host.call(
        "gus",
        "invoke_tool",
        invoke("public_report"),
      );

      expect(refused.parsed).toEqual({
        error: "rate_limit_exceeded",
        message: refusedMessage("Retry later."),
        retryable: true,
      });
      expect(finished.isError).toBe(false);
      expect(next.isError).toBe(false);
    });

    it("releases its slot when the dispatch throws", async () => {
      const host = await startHost({ invokeConcurrency: 1 });
      vi.spyOn(host.dispatcher, "dispatch").mockRejectedValueOnce(
        new Error("boom"),
      );

      const failed = await host.call(
        "hal",
        "invoke_tool",
        invoke("public_report"),
      );
      const next = await host.call(
        "hal",
        "invoke_tool",
        invoke("public_report"),
      );

      expect(failed.parsed["error"]).toBe("internal_error");
      expect(next.isError).toBe(false);
    });

    it("releases its slot when the call is cancelled", async () => {
      const host = await startHost({ invokeConcurrency: 1 });
      const controller = new AbortController();

      const cancelled = rawCall(
        host,
        "ivy",
        "invoke_tool",
        invoke("hang_report"),
        controller.signal,
      ).catch((error: unknown) => error);
      await flow.entered.promise;
      controller.abort();
      await cancelled;

      await vi.waitFor(async () => {
        const next = await host.call(
          "ivy",
          "invoke_tool",
          invoke("public_report"),
        );
        expect(next.isError).toBe(false);
      });
    });
  });

  describe("chained partitions", () => {
    it("refuses with the second partition's retry-after and releases the first partition's permit", async () => {
      const host = await startHost({
        partition: (call): RateLimitPartition[] => [
          {
            key: `slots:${call.callerScope}`,
            create: () => createConcurrencyLimiter({ permitLimit: 1 }),
          },
          {
            key: `rate:${call.callerScope}`,
            create: () => createFixedWindowLimiter(window60s, () => clock),
          },
        ],
      });

      const first = await host.call("jon", "search_tools", { query: "" });
      clock = 10_000;
      const second = await host.call("jon", "search_tools", { query: "" });
      clock = 60_000;
      const third = await host.call("jon", "search_tools", { query: "" });

      expect(first.isError).toBe(false);
      expect(second.parsed).toMatchObject({
        error: "rate_limit_exceeded",
        retryAfterSeconds: 50,
      });
      expect(third.isError).toBe(false);
    });

    it("does not limit a call the function returns no partitions for", async () => {
      const host = await startHost({ partition: () => [] });

      const answers = await Promise.all(
        [1, 2, 3].map(() => host.call("kim", "search_tools", { query: "" })),
      );

      expect(answers.map((answer) => answer.isError)).toEqual([
        false,
        false,
        false,
      ]);
    });
  });

  it("limits nothing when no rate limit is configured", async () => {
    const host = await startHost(undefined);

    const answers = [];
    for (let call = 0; call < 5; call += 1) {
      answers.push(
        await host.call("lee", "invoke_tool", invoke("public_report")),
      );
    }

    expect(answers.map((answer) => answer.isError)).toEqual(
      Array.from({ length: 5 }, () => false),
    );
  });
});

describe("rate limiting configuration", () => {
  const parse = (config: string): SezzleeRateLimitingOptions =>
    JSON.parse(config) as SezzleeRateLimitingOptions;

  it("takes declared limits from parsed configuration data", async () => {
    const config = parse(
      '{"default":{"kind":"tokenBucket","tokenLimit":120,"tokensPerPeriod":2,"periodMs":1000},"invoke":{"kind":"slidingWindow","permitLimit":10,"windowMs":60000,"segmentsPerWindow":6},"invokeConcurrency":4}',
    );
    const moduleRef = await Test.createTestingModule({
      imports: [
        SezzleeModule.forRootAsync({
          useFactory: () => {
            const options = new SezzleeOptions();
            options.rateLimiting = config;
            return options;
          },
        }),
      ],
    }).compile();

    expect(moduleRef.get<SezzleeOptions>(SEZZLEE_OPTIONS).rateLimiting).toEqual(
      config,
    );
    await moduleRef.close();
  });

  it.each([
    [
      "an unknown kind",
      '{"default":{"kind":"leakyBucket"}}',
      'rateLimiting.default.kind must be "tokenBucket", "fixedWindow", "slidingWindow" or "concurrency".',
    ],
    [
      "a token bucket without tokens",
      '{"search":{"kind":"tokenBucket","tokenLimit":0,"tokensPerPeriod":1,"periodMs":1000}}',
      "rateLimiting.search.tokenLimit must be a positive integer.",
    ],
    [
      "a window that is not a duration",
      '{"load":{"kind":"fixedWindow","permitLimit":1,"windowMs":-5}}',
      "rateLimiting.load.windowMs must be a positive number of milliseconds.",
    ],
    [
      "a fractional segment count",
      '{"invoke":{"kind":"slidingWindow","permitLimit":1,"windowMs":1000,"segmentsPerWindow":1.5}}',
      "rateLimiting.invoke.segmentsPerWindow must be a positive integer.",
    ],
    [
      "a zero concurrency",
      '{"invokeConcurrency":0}',
      "rateLimiting.invokeConcurrency must be a positive integer.",
    ],
  ])("refuses %s at startup", (_name, config, message) => {
    const options = new SezzleeOptions();
    options.rateLimiting = parse(config);

    expect(collectConfigurationFailures(options)).toContain(message);
    expect(() =>
      SezzleeModule.forRoot((target) => {
        target.rateLimiting = parse(config);
      }),
    ).toThrow(SezzleeConfigurationError);
  });

  it("refuses a partition function beside declared limits", () => {
    const options = new SezzleeOptions();
    options.rateLimiting = Object.assign(
      parse('{"default":{"kind":"concurrency","permitLimit":1}}'),
      { partition: () => [] },
    );

    expect(collectConfigurationFailures(options)).toEqual([
      "rateLimiting.partition replaces the declared limits (default, search, load, invoke, read, invokeConcurrency, key); set one or the other.",
    ]);
  });

  it("refuses a key function without declared limits", () => {
    const options = new SezzleeOptions();
    options.rateLimiting = { key: (call) => call.callerScope };

    expect(collectConfigurationFailures(options)).toEqual([
      "rateLimiting.key needs a declared limit (default, search, load, invoke, read or invokeConcurrency) to partition.",
    ]);
  });
});
