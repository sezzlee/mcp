import "reflect-metadata";
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Param,
  ParseIntPipe,
  Post,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { All, Req, Res, type INestApplication } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Request, Response } from "express";
import { IsNotEmpty, IsString } from "class-validator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SezzleeCatalog } from "../src/catalog.js";
import { McpTool } from "../src/decorators.js";
import { SezzleeDispatcher } from "../src/dispatcher.js";
import { extensionTokens } from "../src/extension-points.js";
import type { InvokeResultMapper } from "../src/invoke-result-mapper.js";
import { registerSezzleeTools } from "../src/meta-tools.js";
import { SEZZLEE_OPTIONS, type SezzleeOptions } from "../src/options.js";
import { SezzleeModule } from "../src/sezzlee.module.js";
import {
  SezzleeStreamableHttp,
  type SezzleeRequestHandler,
} from "../src/transport/streamable-http.js";
import type { CallerScopeResolver } from "../src/cache.js";
import { CallerVisibilityProvider } from "../src/visibility/provider.js";

class NoteDto {
  @IsString()
  @IsNotEmpty()
  text!: string;
}

interface Authed {
  user?: { name: string; scopes: string[] };
  headers: Record<string, string | string[] | undefined>;
}

@Injectable()
class TokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Authed>();
    const header = request.headers["authorization"];
    const raw = Array.isArray(header) ? header[0] : header;
    if (raw === undefined || !raw.startsWith("Bearer ")) {
      throw new UnauthorizedException("missing bearer");
    }
    const user = raw.slice("Bearer ".length);
    if (user !== "alice" && user !== "bob") {
      throw new UnauthorizedException("unknown user");
    }
    request.user = {
      name: user,
      scopes: user === "alice" ? ["orders.read"] : [],
    };
    return true;
  }
}

@Injectable()
class OrdersReadGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Authed>();
    if (request.user?.scopes.includes("orders.read") !== true) {
      throw new ForbiddenException("orders.read required");
    }
    return true;
  }
}

@Controller()
@McpTool()
class MatrixController {
  @Get("ping")
  ping(): string {
    return "pong";
  }

  @Get("orders/:id")
  @UseGuards(TokenGuard, OrdersReadGuard)
  getOrder(@Param("id", ParseIntPipe) id: number): { id: number } {
    return { id };
  }

  @Post("orders/:id/notes")
  @UseGuards(TokenGuard, OrdersReadGuard)
  addOrderNote(
    @Param("id", ParseIntPipe) id: number,
    @Body() note: NoteDto,
  ): { id: number; text: string } {
    return { id, text: note.text };
  }
}

interface Wire {
  readonly content: { readonly type: string; readonly text: string }[];
  readonly isError?: boolean;
}

@Controller()
class MetaToolsMcpController {
  private readonly serve: SezzleeRequestHandler;

  constructor(
    private readonly streamableHttp: SezzleeStreamableHttp,
    private readonly catalog: SezzleeCatalog,
    private readonly dispatcher: SezzleeDispatcher,
    private readonly visibility: CallerVisibilityProvider,
  ) {
    this.serve = this.streamableHttp.serve(() => {
      const server = new McpServer({
        name: "nest-matrix",
        version: "0.0.0",
      });
      registerSezzleeTools(server, {
        catalog: this.catalog,
        dispatcher: this.dispatcher,
        mapper: mapper as InvokeResultMapper,
        visibility: this.visibility,
        scopes: scopes as CallerScopeResolver,
        options: options as SezzleeOptions,
      });
      return server;
    });
  }

  @All("mcp")
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.serve(req, res);
  }
}

let mapper: InvokeResultMapper | undefined;
let scopes: CallerScopeResolver | undefined;
let options: SezzleeOptions | undefined;

describe("nest meta-tools", () => {
  let app: INestApplication;
  let baseUrl: string;
  let catalog: SezzleeCatalog;
  const clients = new Map<string, Client>();

  const clientFor = async (bearer?: string): Promise<Client> => {
    const key = bearer ?? "anonymous";
    const existing = clients.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const client = new Client({ name: "probe", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit:
          bearer === undefined
            ? {}
            : { headers: { authorization: `Bearer ${bearer}` } },
      }),
    );
    clients.set(key, client);
    return client;
  };

  const call = async <T>(
    name: string,
    args: Record<string, unknown>,
    bearer?: string,
  ): Promise<{ parsed: T; isError: boolean }> => {
    const client = await clientFor(bearer);
    const result = (await client.callTool({
      name,
      arguments: args,
    })) as unknown as Wire;
    return {
      parsed: JSON.parse(result.content[0]?.text ?? "{}") as T,
      isError: result.isError === true,
    };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SezzleeModule.forRoot((opts) => {
          opts.visibility.tier = "probe";
          opts.cache.lifetimeMs = 0;
        }),
      ],
      controllers: [MatrixController, MetaToolsMcpController],
      providers: [TokenGuard, OrdersReadGuard],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await app.listen(0);
    baseUrl = await app.getUrl();

    catalog = app.get(SezzleeCatalog);
    mapper = app.get<InvokeResultMapper>(extensionTokens.invokeResultMapper);
    scopes = app.get<CallerScopeResolver>(extensionTokens.callerScopeResolver);
    options = app.get<SezzleeOptions>(SEZZLEE_OPTIONS);
  });

  afterAll(async () => {
    for (const client of clients.values()) {
      await client.close();
    }
    await app.close();
  });

  it("lists exactly the three meta-tools", async () => {
    const listed = await (await clientFor("alice")).listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "invoke_tool",
      "load_tool",
      "search_tools",
    ]);
  });

  it("search_tools returns cards with a total", async () => {
    const { parsed } = await call<{
      total: number;
      results: { name: string; parameters: string }[];
    }>("search_tools", { query: "order" }, "alice");
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.total).toBeGreaterThan(0);
    const card = parsed.results.find((r) => r.name.endsWith("get_order"));
    expect(card?.parameters).toBe("id: integer (required)");
  });

  it("search_tools publishes detail as an enum defaulting to card", async () => {
    const listed = await (await clientFor("alice")).listTools();
    const search = listed.tools.find((tool) => tool.name === "search_tools");
    const detail = (
      search?.inputSchema.properties as Record<string, Record<string, unknown>>
    )?.["detail"];
    expect(detail?.["type"]).toBe("string");
    expect(detail?.["enum"]).toEqual(["card", "schema"]);
    expect(detail?.["default"]).toBe("card");
    expect(typeof detail?.["description"]).toBe("string");
  });

  /**
   * The twin of this test is T17 in sdks/dotnet/tests/Sezzlee.Tests/TransportTests.cs, and the
   * description is asserted verbatim in both because nothing else can compare two SDKs running in
   * two processes. The `default` is null rather than an empty array because a C# array parameter's
   * default must be a compile-time constant; zod's `meta` publishes the same null here.
   */
  it("search_tools publishes tags as an optional string array", async () => {
    const listed = await (await clientFor("alice")).listTools();
    const search = listed.tools.find((tool) => tool.name === "search_tools");
    const tags = (
      search?.inputSchema.properties as Record<string, Record<string, unknown>>
    )?.["tags"];
    expect(tags?.["type"]).toBe("array");
    expect(tags?.["items"]).toEqual({ type: "string" });
    expect(tags?.["default"]).toBeNull();
    expect(tags?.["description"]).toBe(
      "Tags every result must carry, matched against the whole tag and insensitive to case and accents. Empty applies no filter; the answer's tags field lists what is available.",
    );
    expect(search?.inputSchema["required"] ?? []).not.toContain("tags");
  });

  /**
   * The twin of T18 in sdks/dotnet/tests/Sezzlee.Tests/TransportTests.cs. `arguments` publishes a
   * description and no `type` on purpose: the argument accepts raw JSON so a non-object value
   * reaches the handler and leaves as an sezzlee envelope rather than a raw MCP validation error.
   */
  it("invoke_tool publishes name and arguments as required and version as an optional string", async () => {
    const listed = await (await clientFor("alice")).listTools();
    const invoke = listed.tools.find((tool) => tool.name === "invoke_tool");
    const properties = invoke?.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties["name"]?.["type"]).toBe("string");
    expect(properties["name"]?.["description"]).toBe(
      "Operation name exactly as returned by search_tools.",
    );
    expect(properties["arguments"]?.["description"]).toBe(
      "Arguments as a JSON object whose keys are the input schema's properties. Send the object itself, not a string containing JSON.",
    );
    expect(properties["arguments"]).not.toHaveProperty("type");
    expect(properties["version"]?.["type"]).toBe("string");
    expect(properties["version"]?.["default"]).toBeNull();
    expect(properties["version"]?.["description"]).toBe(
      "The version load_tool returned for this operation. When present, the call is refused with tool_changed if the operation changed after it was loaded; omit it to skip the check.",
    );
    expect(
      [...((invoke?.inputSchema["required"] as string[]) ?? [])].sort(),
    ).toEqual(["arguments", "name"]);
  });

  /**
   * The twin of T19 in sdks/dotnet/tests/Sezzlee.Tests/TransportTests.cs. The permissive runtime type
   * must not show up in what the agent reads.
   */
  it("load_tool still publishes name as a required string", async () => {
    const listed = await (await clientFor("alice")).listTools();
    const load = listed.tools.find((tool) => tool.name === "load_tool");
    const properties = load?.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties["name"]?.["type"]).toBe("string");
    expect(properties["name"]?.["description"]).toBe(
      "Operation name exactly as returned by search_tools.",
    );
    expect(load?.inputSchema["required"]).toEqual(["name"]);
    expect(load?.inputSchema).not.toHaveProperty("additionalProperties");
  });

  it("load_tool answers a misnamed argument with an envelope", async () => {
    const { parsed, isError } = await call<{
      error: string;
      message: string;
      retryable: boolean;
    }>("load_tool", { operation: "get_order" }, "alice");
    expect(isError).toBe(true);
    expect(parsed.error).toBe("unknown_argument");
    expect(parsed.message).toContain("'name'");
    expect(parsed.retryable).toBe(false);
  });

  it("invoke_tool answers a non-string name with an envelope", async () => {
    const { parsed, isError } = await call<{ error: string; message: string }>(
      "invoke_tool",
      { name: 5, arguments: {} },
      "alice",
    );
    expect(isError).toBe(true);
    expect(parsed.error).toBe("unknown_argument");
    expect(parsed.message).toContain("number");
  });

  it("search_tools with detail schema answers what load_tool would", async () => {
    const name = [...catalog.current.byName.keys()].find((candidate) =>
      candidate.endsWith("get_order"),
    ) as string;
    const { parsed } = await call<{
      results: Record<string, unknown>[];
    }>("search_tools", { query: "order", detail: "schema" }, "alice");
    const entry = parsed.results.find((result) => result["name"] === name);
    const { parsed: loaded } = await call<Record<string, unknown>>(
      "load_tool",
      { name },
      "alice",
    );
    expect(entry).toEqual(loaded);
    expect(entry?.["auth"]).toBeUndefined();
  });

  it("search_tools falls back to cards for any other detail value", async () => {
    const { parsed } = await call<{
      results: Record<string, unknown>[];
    }>("search_tools", { query: "order", detail: "banana" }, "alice");
    expect(parsed.results.length).toBeGreaterThan(0);
    for (const result of parsed.results) {
      expect(typeof result["parameters"]).toBe("string");
      expect(result["inputSchema"]).toBeUndefined();
    }
  });

  it("load_tool returns the schema and never the auth model", async () => {
    const name = [...catalog.current.byName.keys()].find((candidate) =>
      candidate.endsWith("get_order"),
    ) as string;
    const { parsed, isError } = await call<Record<string, unknown>>(
      "load_tool",
      { name },
      "alice",
    );
    expect(isError).toBe(false);
    expect(parsed["inputSchema"]).toBeDefined();
    expect(parsed["auth"]).toBeUndefined();
  });

  it("load_tool answers a nonexistent tool with the unknown_tool envelope", async () => {
    const { parsed, isError } = await call<{ error: string; message: string }>(
      "load_tool",
      { name: "nope" },
      "alice",
    );
    expect(isError).toBe(true);
    expect(parsed.error).toBe("unknown_tool");
    expect(parsed.message).toBe(
      "No operation named 'nope'. Use search_tools to find the exact name.",
    );
  });

  it("invoke_tool reproduces the 200/401/403 matrix through the real pipeline", async () => {
    const name = [...catalog.current.byName.keys()].find((candidate) =>
      candidate.endsWith("get_order"),
    ) as string;

    const anonymous = await call<{ error: string; status: number }>(
      "invoke_tool",
      { name, arguments: { id: 1 } },
    );
    expect(anonymous.isError).toBe(true);
    expect(anonymous.parsed.status).toBe(401);
    expect(anonymous.parsed.error).toBe("unauthenticated");

    const bob = await call<{ error: string; status: number }>(
      "invoke_tool",
      { name, arguments: { id: 1 } },
      "bob",
    );
    expect(bob.isError).toBe(true);
    expect(bob.parsed.status).toBe(403);
    expect(bob.parsed.error).toBe("forbidden");

    const alice = await call<{ status: number; body: { id: number } }>(
      "invoke_tool",
      { name, arguments: { id: 1 } },
      "alice",
    );
    expect(alice.isError).toBe(false);
    expect(alice.parsed.status).toBe(200);
    expect(alice.parsed.body.id).toBe(1);
  });

  it("invoke_tool flattens a body and forwards identity", async () => {
    const name = [...catalog.current.byName.keys()].find((candidate) =>
      candidate.endsWith("add_order_note"),
    ) as string;
    const { parsed, isError } = await call<{
      status: number;
      body: { text: string };
    }>("invoke_tool", { name, arguments: { id: 7, text: "not" } }, "alice");
    expect(isError).toBe(false);
    expect(parsed.status).toBe(201);
    expect(parsed.body.text).toBe("not");
  });

  it("invoke_tool unwraps arguments that arrived as JSON text", async () => {
    const name = [...catalog.current.byName.keys()].find((candidate) =>
      candidate.endsWith("add_order_note"),
    ) as string;
    const { parsed, isError } = await call<{
      status: number;
      body: { text: string };
    }>("invoke_tool", { name, arguments: '{"id": 7, "text": "not"}' }, "alice");
    expect(isError).toBe(false);
    expect(parsed.status).toBe(201);
    expect(parsed.body.text).toBe("not");
  });

  it("invoke_tool reads null arguments as none", async () => {
    const name = [...catalog.current.byName.keys()].find((candidate) =>
      candidate.endsWith("ping"),
    ) as string;
    const { isError } = await call<{ status: number }>(
      "invoke_tool",
      { name, arguments: null },
      "alice",
    );
    expect(isError).toBe(false);
  });

  it("invoke_tool names the kind that arrived when it is not an object", async () => {
    const name = [...catalog.current.byName.keys()].find((candidate) =>
      candidate.endsWith("get_order"),
    ) as string;
    const { parsed, isError } = await call<{
      error: string;
      message: string;
      retryable: boolean;
    }>("invoke_tool", { name, arguments: "id=5" }, "alice");
    expect(isError).toBe(true);
    expect(parsed.error).toBe("invalid_type");
    expect(parsed.message).toContain("received a string");
    expect(parsed.retryable).toBe(false);
  });

  it("invoke_tool rejects an unknown argument before dispatch", async () => {
    const name = [...catalog.current.byName.keys()].find((candidate) =>
      candidate.endsWith("get_order"),
    ) as string;
    const { parsed, isError } = await call<{ error: string }>(
      "invoke_tool",
      { name, arguments: { id: 1, nope: true } },
      "alice",
    );
    expect(isError).toBe(true);
    expect(parsed.error).toBe("unknown_argument");
  });

  it("probe reads a guard rejection as deny: two identities, two lists", async () => {
    const forAlice = await call<{ results: { name: string }[] }>(
      "search_tools",
      { query: "" },
      "alice",
    );
    const forBob = await call<{ results: { name: string }[] }>(
      "search_tools",
      { query: "" },
      "bob",
    );
    const aliceNames = forAlice.parsed.results.map((r) => r.name).sort();
    const bobNames = forBob.parsed.results.map((r) => r.name).sort();
    expect(aliceNames).not.toEqual(bobNames);
    expect(aliceNames.length).toBeGreaterThan(bobNames.length);
  });
});
