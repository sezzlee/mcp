import "reflect-metadata";
import {
  All,
  Controller,
  Get,
  Injectable,
  Req,
  Res,
  Scope,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Request, Response } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineProviderTool,
  McpTool,
  ProviderToolError,
  SezzleeCatalog,
  SezzleeMcpEndpoint,
  SezzleeModule,
  SEZZLEE_OPTIONS,
  type SezzleeOptions,
  type ProviderToolContext,
  type ProviderToolSchema,
  type SezzleeRequestHandler,
} from "../src/index.js";
import { invokeProvider } from "../src/provider-tools.js";

@Injectable()
class NotesService {
  calls = 0;
  cancelled = false;
  allowed = true;

  echo(message: string, context: ProviderToolContext) {
    this.calls += 1;
    return {
      message,
      caller: context.caller.header("authorization") ?? "anonymous",
    };
  }

  async wait(context: ProviderToolContext) {
    this.calls += 1;
    await new Promise<void>((resolve) =>
      context.signal.addEventListener(
        "abort",
        () => {
          this.cancelled = true;
          resolve();
        },
        { once: true },
      ),
    );
    return {};
  }
}

const empty = z.strictObject({});
const checkedOutput: ProviderToolSchema<unknown> = z.strictObject({
  ok: z.boolean(),
});
const echo = defineProviderTool({
  name: "native_echo",
  description: "Echo a message for the caller.",
  provider: NotesService,
  input: z.strictObject({ message: z.string().min(1) }),
  output: z.strictObject({ message: z.string(), caller: z.string() }),
  annotations: { readOnlyHint: true },
  tags: ["native"],
  access: (context) =>
    context.caller.header("authorization") === "Bearer alice",
  execute: (service, input, context) => service.echo(input.message, context),
});

@Controller()
class MixedController {
  @Get("ping")
  @McpTool({ name: "http_ping" })
  ping() {
    return { pong: true };
  }
}

@Controller()
class McpController {
  private readonly serve: SezzleeRequestHandler;
  constructor(endpoint: SezzleeMcpEndpoint) {
    this.serve = endpoint.serve({ name: "provider-test", version: "0.0.0" });
  }
  @All("mcp")
  async handle(@Req() req: Request, @Res() res: Response) {
    await this.serve(req, res);
  }
}

describe("provider tools through MCP", () => {
  let app: INestApplication;
  let base: string;
  let service: NotesService;
  const clients = new Map<string, Client>();
  const clientFor = async (caller = "alice") => {
    const known = clients.get(caller);
    if (known !== undefined) return known;
    const client = new Client({ name: "provider-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${caller}` } },
      }),
    );
    clients.set(caller, client);
    return client;
  };
  const call = async (
    name: string,
    args: Record<string, unknown>,
    caller = "alice",
  ) => {
    const result = await (
      await clientFor(caller)
    ).callTool({ name, arguments: args });
    const content = result.content.find((item) => item.type === "text");
    if (content?.type !== "text") throw new Error("Expected a text envelope");
    const payload: unknown = JSON.parse(content.text);
    return { payload, isError: result.isError === true };
  };
  const invoke = (
    name: string,
    args: Record<string, unknown> = {},
    caller = "alice",
  ) => call("invoke_tool", { name, arguments: args }, caller);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        SezzleeModule.forRoot((options) => {
          options.invoke.timeoutMs = 80;
          options.invoke.maxResponseBytes = 1800;
          options.visibility.tier = "probe";
          options.tools.push(echo);
          options.tools.push(
            defineProviderTool({
              name: "native_policy_error",
              description: "Refuse a failed access decision.",
              provider: NotesService,
              input: empty,
              access: () => {
                throw new Error("private-policy-secret");
              },
              execute: (provider, _input, context) =>
                provider.echo("must not run", context),
            }),
          );
          options.tools.push(
            defineProviderTool({
              name: "native_json",
              description:
                "Exercise JSON compatibility without an output validator.",
              provider: NotesService,
              input: z.strictObject({
                kind: z.enum([
                  "undefined",
                  "bigint",
                  "cycle",
                  "nonfinite",
                  "class",
                ]),
              }),
              access: "public",
              execute: (_provider, input): unknown => {
                switch (input.kind) {
                  case "undefined":
                    return undefined;
                  case "bigint":
                    return 1n;
                  case "nonfinite":
                    return Number.NaN;
                  case "class":
                    return new Date();
                  case "cycle": {
                    const value: { self?: unknown } = {};
                    value.self = value;
                    return value;
                  }
                }
              },
            }),
          );
          options.tools.push(
            defineProviderTool({
              name: "native_identity",
              description: "Read this caller's context.",
              provider: NotesService,
              input: empty,
              access: "public",
              execute: (provider, _input, context) =>
                provider.echo("identity", context),
            }),
          );
          options.tools.push(
            defineProviderTool({
              name: "native_policy_wait",
              description: "Wait for an access decision.",
              provider: NotesService,
              input: empty,
              access: async (context) => {
                await new Promise<void>((resolve) =>
                  context.signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  }),
                );
                return true;
              },
              execute: (provider, _input, context) =>
                provider.echo("must not run", context),
            }),
          );
          options.tools.push(
            defineProviderTool({
              name: "native_rows",
              description: "Read caller rows.",
              provider: NotesService,
              input: empty,
              access: (context) =>
                context.caller.header("authorization") === "Bearer alice" &&
                service.allowed,
              annotations: { readOnlyHint: true },
              execute: () => ({
                rows: Array.from({ length: 100 }, (_, id) => ({
                  id,
                  value: "x".repeat(40),
                })),
              }),
            }),
          );
          options.tools.push(
            defineProviderTool({
              name: "native_wait",
              description: "Wait for cancellation.",
              provider: NotesService,
              input: empty,
              access: "public",
              execute: (provider, _input, context) => provider.wait(context),
            }),
          );
          for (const mode of [
            "secret",
            "invalid",
            "business",
            "business_secret",
          ] as const) {
            options.tools.push(
              defineProviderTool({
                name: `native_${mode}`,
                description: `Exercise ${mode} results.`,
                provider: NotesService,
                input: empty,
                access: "public",
                output: checkedOutput,
                execute: () => {
                  if (mode === "secret") throw new Error("private-token-123");
                  if (mode === "business_secret")
                    throw new ProviderToolError(
                      "postgres://user:secret@db.local/app",
                    );
                  if (mode === "business")
                    throw new ProviderToolError("The note is locked.");
                  return { ok: "wrong" };
                },
              }),
            );
          }
        }),
      ],
      controllers: [McpController, MixedController],
      providers: [NotesService],
    }).compile();
    app = module.createNestApplication({ logger: false });
    service = app.get(NotesService);
    await app.init();
    await app.listen(0);
    base = await app.getUrl();
  });

  afterAll(async () => {
    for (const client of clients.values()) await client.close();
    await app?.close();
  });

  it("searches, loads and invokes a provider alongside HTTP tools without registering its route", async () => {
    expect(
      (await call("search_tools", { tags: ["native"], limit: 1 })).payload,
    ).toMatchObject({ results: [{ name: "native_echo" }] });
    const loaded = await call("load_tool", { name: "native_echo" });
    expect(loaded.payload).toMatchObject({
      name: "native_echo",
      version: expect.any(String),
      outputSchema: { required: ["body"] },
    });
    expect(await invoke("native_echo", { message: "hello" })).toEqual({
      payload: { body: { message: "hello", caller: "Bearer alice" } },
      isError: false,
    });
    expect(await invoke("http_ping")).toMatchObject({
      payload: { status: 200 },
      isError: false,
    });
    for (const method of [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ]) {
      expect((await fetch(`${base}/native_echo`, { method })).status).toBe(404);
    }
    const adapter: {
      router?: { stack: { route?: { path: string } }[] };
      _router?: { stack: { route?: { path: string } }[] };
    } = app.getHttpAdapter().getInstance();
    const routes =
      (adapter._router ?? adapter.router)?.stack.flatMap(
        (layer) => layer.route?.path ?? [],
      ) ?? [];
    expect([...routes].sort()).toEqual(["/mcp", "/ping"]);
    expect(app.get(SezzleeCatalog).openApiExtensions()).not.toHaveProperty(
      "native_echo",
    );
  });

  it.each([{ message: "" }, { message: 1 }, { message: "hi", extra: true }])(
    "rejects invalid input before entering the provider: %j",
    async (args) => {
      const before = service.calls;
      expect(await invoke("native_echo", args)).toMatchObject({
        payload: { error: "provider_invalid_input" },
        isError: true,
      });
      expect(service.calls).toBe(before);
    },
  );

  it("hides a denied tool and rejects a guessed name without entering its handler", async () => {
    const before = service.calls;
    expect(
      (await call("search_tools", { tags: ["native"] }, "bob")).payload,
    ).toMatchObject({ results: [] });
    expect(
      await invoke("native_echo", { message: "hello" }, "bob"),
    ).toMatchObject({
      payload: { error: "provider_forbidden" },
      isError: true,
    });
    expect(service.calls).toBe(before);
  });

  it("stores bounded native results without an HTTP status and rechecks caller access when reading", async () => {
    expect((await call("load_tool", { name: "native_rows" })).isError).toBe(
      false,
    );
    const stored = await invoke("native_rows");
    expect(stored.isError).toBe(false);
    expect(stored.payload).not.toHaveProperty("status");
    expect(stored.payload).toMatchObject({
      stored: { handle: expect.any(String) },
    });
    const parsed = z
      .object({ stored: z.object({ handle: z.string() }) })
      .parse(stored.payload);
    const args = { handle: parsed.stored.handle, path: "/rows", limit: 1 };
    expect((await call("read_result", args)).payload).toMatchObject({
      value: [{ id: 0, value: "x".repeat(40) }],
      total: 100,
    });
    expect((await call("read_result", args, "bob")).isError).toBe(true);
    service.allowed = false;
    try {
      expect(await invoke("native_rows")).toMatchObject({
        payload: { error: "provider_forbidden" },
        isError: true,
      });
      expect((await call("read_result", args)).isError).toBe(true);
    } finally {
      service.allowed = true;
    }
  });

  it("bounds a pending handler and propagates its deadline signal", async () => {
    expect(await invoke("native_wait")).toMatchObject({
      payload: { error: "invoke_timeout" },
      isError: true,
    });
    expect(service.cancelled).toBe(true);
  });

  it("includes an asynchronous access decision in the deadline without entering the handler", async () => {
    const before = service.calls;
    expect(await invoke("native_policy_wait")).toMatchObject({
      payload: { error: "invoke_timeout" },
      isError: true,
    });
    expect(service.calls).toBe(before);
  });

  it("keeps simultaneous callers isolated on a singleton provider", async () => {
    const [alice, bob] = await Promise.all([
      invoke("native_identity"),
      invoke("native_identity", {}, "bob"),
    ]);
    expect(alice.payload).toMatchObject({ body: { caller: "Bearer alice" } });
    expect(bob.payload).toMatchObject({ body: { caller: "Bearer bob" } });
  });

  it("fails closed on an access policy exception without forwarding its details", async () => {
    const before = service.calls;
    expect(await invoke("native_policy_error")).toMatchObject({
      payload: {
        error: "provider_forbidden",
        message: "This caller may not invoke the tool.",
      },
      isError: true,
    });
    expect(service.calls).toBe(before);
  });

  it("refuses a materialized result above the buffer ceiling instead of storing it", async () => {
    const options = app.get<SezzleeOptions>(SEZZLEE_OPTIONS);
    const limit = options.invoke.maxBufferedBytes;
    options.invoke.maxBufferedBytes = 100;
    try {
      const refused = await invoke("native_rows");
      expect(refused.isError).toBe(true);
      expect(refused.payload).not.toHaveProperty("stored");
    } finally {
      options.invoke.maxBufferedBytes = limit;
    }
  });

  it.each([
    ["native_secret", "provider_failed", "The tool did not complete."],
    [
      "native_invalid",
      "provider_invalid_output",
      "The tool returned an invalid result.",
    ],
    ["native_business", "provider_business_error", "The note is locked."],
    [
      "native_business_secret",
      "provider_business_error",
      "The operation was refused.",
    ],
  ])("validates and redacts %s", async (name, error, message) => {
    expect(await invoke(name)).toMatchObject({
      payload: { error, message },
      isError: true,
    });
  });

  it.each(["undefined", "bigint", "cycle", "nonfinite", "class"])(
    "rejects non-JSON %s output without an output schema",
    async (kind) => {
      expect(await invoke("native_json", { kind })).toMatchObject({
        payload: { error: "provider_invalid_output" },
        isError: true,
      });
    },
  );

  it("rejects a pinned version mismatch and a pre-cancelled call before handler entry", async () => {
    const before = service.calls;
    expect(
      await call("invoke_tool", {
        name: "native_echo",
        arguments: { message: "hello" },
        version: "stale",
      }),
    ).toMatchObject({ payload: { error: "tool_changed" }, isError: true });
    const entry = app.get(SezzleeCatalog).findCallable("native_echo");
    if (entry?.kind !== "provider") throw new Error("Missing provider fixture");
    const abort = new AbortController();
    abort.abort();
    expect(
      (
        await invokeProvider(
          entry,
          { message: "hello" },
          { headers: { authorization: "Bearer alice" } },
          { signal: abort.signal },
        )
      ).isError,
    ).toBe(true);
    expect(service.calls).toBe(before);
  });
});

describe("provider registration", () => {
  it("fails startup on a name shared by an HTTP and provider tool", async () => {
    const module = await Test.createTestingModule({
      imports: [
        SezzleeModule.forRoot((options) =>
          options.tools.push(
            defineProviderTool({
              name: "http_ping",
              description: "Collide with HTTP.",
              provider: NotesService,
              input: empty,
              access: "public",
              execute: () => ({}),
            }),
          ),
        ),
      ],
      controllers: [MixedController],
      providers: [NotesService],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    try {
      await expect(app.init()).rejects.toThrow("registered more than once");
    } finally {
      await app.close();
    }
  });

  it("refuses request-scoped provider dependencies", async () => {
    @Injectable({ scope: Scope.REQUEST })
    class RequestService {}
    const module = await Test.createTestingModule({
      imports: [
        SezzleeModule.forRoot((options) =>
          options.tools.push(
            defineProviderTool({
              name: "scoped",
              description: "Reject request scope.",
              provider: RequestService,
              input: empty,
              access: "public",
              execute: () => ({}),
            }),
          ),
        ),
      ],
      providers: [RequestService],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    try {
      await expect(app.init()).rejects.toThrow("singleton provider");
    } finally {
      await app.close();
    }
  });
});
