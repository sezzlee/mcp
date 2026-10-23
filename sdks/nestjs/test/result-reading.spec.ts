import "reflect-metadata";
import {
  All,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Request, Response } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InvokeStored, ReadResult, SdkError } from "@sezzlee/core";
import { McpTool } from "../src/decorators.js";
import type { OuterRequest } from "../src/options.js";
import { SezzleeModule } from "../src/sezzlee.module.js";
import { SezzleeMcpEndpoint } from "../src/transport/mcp-endpoint.js";
import type { SezzleeRequestHandler } from "../src/transport/streamable-http.js";
import type {
  McpToolInfo,
  ToolAccess,
  ToolAuthorizer,
} from "../src/visibility/authorizer.js";

@Controller()
class RowsController {
  @Get("rows")
  @McpTool({ name: "list_rows" })
  rows(@Query("limit") limit?: string) {
    return Array.from({ length: Number(limit ?? "1") }, (_value, id) => ({
      id,
      note: "x".repeat(64),
    }));
  }

  @Post("rows/export")
  @McpTool({ name: "export_rows" })
  exportRows(@Query("limit") limit?: string) {
    return this.rows(limit);
  }
}

class RevocableAuthorizer implements ToolAuthorizer {
  readonly revoked = new Set<string>();

  covers(): boolean {
    return true;
  }

  async resolve(request: OuterRequest | undefined): Promise<ToolAccess> {
    const caller = String(request?.headers["authorization"] ?? "");
    return {
      decide: (tool: McpToolInfo) =>
        this.revoked.has(`${caller} ${tool.name}`) ? "deny" : "allow",
    };
  }
}

@Controller()
class ResultsMcpController {
  private readonly serve: SezzleeRequestHandler;

  constructor(endpoint: SezzleeMcpEndpoint) {
    this.serve = endpoint.serve({ name: "results", version: "0.0.0" });
  }

  @All("mcp")
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.serve(req, res);
  }
}

interface Wire {
  readonly content: { readonly type: string; readonly text: string }[];
  readonly isError?: boolean;
}

describe("over-budget answers kept for read_result", () => {
  let app: INestApplication;
  const authorizer = new RevocableAuthorizer();
  const calls: string[] = [];
  const clients = new Map<string, Client>();

  const call = async <T>(
    caller: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ parsed: T; isError: boolean }> => {
    let client = clients.get(caller);
    if (client === undefined) {
      client = new Client({ name: caller, version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`${await app.getUrl()}/mcp`),
          { requestInit: { headers: { authorization: `Bearer ${caller}` } } },
        ),
      );
      clients.set(caller, client);
    }
    const result = (await client.callTool({
      name,
      arguments: args,
    })) as unknown as Wire;
    return {
      parsed: JSON.parse(result.content[0]?.text ?? "{}") as T,
      isError: result.isError === true,
    };
  };

  const stored = async (
    caller: string,
    name = "list_rows",
  ): Promise<InvokeStored> => {
    const { parsed, isError } = await call<InvokeStored>(
      caller,
      "invoke_tool",
      {
        name,
        arguments: { limit: "200" },
      },
    );
    expect(isError).toBe(false);
    return parsed;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SezzleeModule.forRoot(
          (opts) => {
            opts.invoke.maxResponseBytes = 4_096;
            opts.invoke.maxBufferedBytes = 65_536;
            opts.cache.lifetimeMs = 0;
            opts.rateLimiting = {
              partition: (context) => {
                calls.push(`${context.metaTool}:${context.toolName}`);
                return [];
              },
            };
          },
          { toolAuthorizer: { useValue: authorizer } },
        ),
      ],
      controllers: [RowsController, ResultsMcpController],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    for (const client of clients.values()) {
      await client.close();
    }
    await app.close();
  });

  it("answers an oversize success with a handle and an outline instead of refusing it", async () => {
    const answer = await stored("alice");
    expect(answer.status).toBe(200);
    expect(answer.stored.limit).toBe(4_096);
    expect(answer.stored.bytes).toBeGreaterThan(4_096);
    expect(answer.stored.outline).toEqual([
      { path: "", kind: "array", count: 200, fields: ["id", "note"] },
    ]);
    expect(answer.message).not.toContain("applied");
  });

  it("lets the same caller read a window of the stored body", async () => {
    const answer = await stored("alice");
    const { parsed, isError } = await call<ReadResult>("alice", "read_result", {
      handle: answer.stored.handle,
      select: ["id"],
      offset: 10,
      limit: 3,
    });
    expect(isError).toBe(false);
    expect(parsed).toEqual({
      path: "",
      kind: "array",
      total: 200,
      offset: 10,
      nextOffset: 13,
      value: [{ id: 10 }, { id: 11 }, { id: 12 }],
    });
  });

  it("does not let another caller read the handle", async () => {
    const answer = await stored("alice");
    const { parsed, isError } = await call<SdkError>("bob", "read_result", {
      handle: answer.stored.handle,
    });
    expect(isError).toBe(true);
    expect(parsed.error).toBe("result_unavailable");
  });

  it("stops serving a result once the caller may no longer see its tool", async () => {
    const answer = await stored("carol");
    authorizer.revoked.add("Bearer carol list_rows");
    const { parsed } = await call<SdkError>("carol", "read_result", {
      handle: answer.stored.handle,
      limit: 1,
    });
    expect(parsed.error).toBe("result_unavailable");
  });

  it("keeps the answer of an applied write and says not to apply it again", async () => {
    const answer = await stored("alice", "export_rows");
    expect(answer.status).toBe(201);
    expect(answer.message).toMatch(
      / The backend already applied the operation; read the stored result rather than calling it again\.$/,
    );
  });

  it("refuses unread a body over the read cap", async () => {
    const { parsed, isError } = await call<SdkError>("alice", "invoke_tool", {
      name: "list_rows",
      arguments: { limit: "2000" },
    });
    expect(isError).toBe(true);
    expect(parsed.error).toBe("response_too_large");
    expect(parsed.payload).toBeUndefined();
    expect(parsed.message).toMatch(
      /^The response exceeded 65536 bytes and was not read to the end\./,
    );
  });

  it("classes read_result as the read meta-tool for the rate limit", () => {
    expect(calls).toContain("read:read_result");
  });
});
