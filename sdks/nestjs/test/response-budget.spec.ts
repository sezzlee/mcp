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
import type { SdkError } from "@sezzlee/core";
import { McpTool } from "../src/decorators.js";
import { SEZZLEE_OPTIONS, type SezzleeOptions } from "../src/options.js";
import { SezzleeModule } from "../src/sezzlee.module.js";
import { SezzleeMcpEndpoint } from "../src/transport/mcp-endpoint.js";
import type { SezzleeRequestHandler } from "../src/transport/streamable-http.js";

@Controller()
class BulkController {
  @Get("rows")
  @McpTool({ name: "list_rows" })
  rows(@Query("limit") limit?: string) {
    const count = Number(limit ?? "1");
    return Array.from({ length: count }, (_value, index) => ({
      id: index,
      note: "x".repeat(64),
    }));
  }

  @Post("rows/export")
  @McpTool({ name: "export_rows" })
  exportRows(@Query("limit") limit?: string) {
    return this.rows(limit);
  }

  @Get("slow")
  @McpTool({ name: "slow_call" })
  slow(@Res() res: Response) {
    setTimeout(() => res.json({ eventually: true }), 5_000);
    return undefined;
  }

  @Get("exact")
  @McpTool({ name: "exact_size" })
  exact(@Query("pad") pad?: string) {
    return { pad: "y".repeat(Number(pad ?? "0")) };
  }
}

interface Wire {
  readonly content: { readonly type: string; readonly text: string }[];
  readonly isError?: boolean;
}

@Controller()
class BudgetMcpController {
  private readonly serve: SezzleeRequestHandler;

  constructor(endpoint: SezzleeMcpEndpoint) {
    this.serve = endpoint.serve({ name: "budget", version: "0.0.0" });
  }

  @All("mcp")
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.serve(req, res);
  }
}

describe("response budget and invoke deadline, with no result store bound", () => {
  let app: INestApplication;
  let client: Client;

  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ parsed: SdkError; isError: boolean }> => {
    const result = (await client.callTool({
      name,
      arguments: args,
    })) as unknown as Wire;
    return {
      parsed: JSON.parse(result.content[0]?.text ?? "{}") as SdkError,
      isError: result.isError === true,
    };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        SezzleeModule.forRoot(
          (opts) => {
            opts.invoke.maxResponseBytes = 4_096;
            opts.invoke.timeoutMs = 150;
          },
          { resultStore: { useValue: null } },
        ),
      ],
      controllers: [BulkController, BudgetMcpController],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    await app.listen(0);

    client = new Client({ name: "budget-probe", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${await app.getUrl()}/mcp`)),
    );
  });

  afterAll(async () => {
    await client.close();
    await app.close();
  });

  it("B0 publishes no read_result", async () => {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).not.toContain("read_result");
  });

  it("B1 refuses an oversize response and names the narrowing arguments", async () => {
    const { parsed, isError } = await call("invoke_tool", {
      name: "list_rows",
      arguments: { limit: "200" },
    });
    expect(isError).toBe(true);
    expect(parsed.error).toBe("response_too_large");
    expect(parsed.retryable).toBe(false);
    expect(parsed.payload?.limit).toBe(4_096);
    expect(parsed.payload?.bytes).toBeGreaterThan(4_096);
    expect(parsed.payload?.shape).toEqual({ kind: "array", count: 200 });
    expect(parsed.fields?.map((field) => field.name)).toContain("limit");
    expect(parsed.message).not.toContain("xxxx");
  });

  it("B1b refuses an oversize write without inviting the agent to apply it again", async () => {
    const { parsed, isError } = await call("invoke_tool", {
      name: "export_rows",
      arguments: { limit: "200" },
    });
    expect(isError).toBe(true);
    expect(parsed.error).toBe("response_too_large");
    expect(parsed.fields).toBeUndefined();
    expect(parsed.message).toMatch(
      / The body is an array of 200 items\. The backend already applied the operation; calling it again applies it again\.$/,
    );
  });

  it("B2 admits a response that fits and refuses one byte over", async () => {
    const fits = await call("invoke_tool", {
      name: "exact_size",
      arguments: { pad: "1000" },
    });
    expect(fits.isError).toBe(false);

    const over = await call("invoke_tool", {
      name: "exact_size",
      arguments: { pad: "8000" },
    });
    expect(over.isError).toBe(true);
    expect(over.parsed.error).toBe("response_too_large");
  });

  it("B3 lets a per-endpoint override lower the budget for one tool alone", async () => {
    const live = app.get<SezzleeOptions>(SEZZLEE_OPTIONS);
    live.invoke.maxResponseBytesFor = (target) =>
      target.tool === "exact_size" ? 32 : undefined;
    try {
      const overridden = await call("invoke_tool", {
        name: "exact_size",
        arguments: { pad: "100" },
      });
      expect(overridden.isError).toBe(true);
      expect(overridden.parsed.error).toBe("response_too_large");
      expect(overridden.parsed.payload?.limit).toBe(32);

      const untouched = await call("invoke_tool", {
        name: "list_rows",
        arguments: { limit: "2" },
      });
      expect(untouched.isError).toBe(false);
    } finally {
      live.invoke.maxResponseBytesFor = undefined;
    }
  });

  it("B4 answers a deadline expiry with invoke_timeout", async () => {
    const { parsed, isError } = await call("invoke_tool", {
      name: "slow_call",
      arguments: {},
    });
    expect(isError).toBe(true);
    expect(parsed.error).toBe("invoke_timeout");
    expect(parsed.retryable).toBe(true);
    expect(parsed.message).toContain("150 ms");
  });

  it("B5 never forwards a raw throw from inside the layer", async () => {
    const { parsed, isError } = await call("invoke_tool", {
      name: "list_rows",
      arguments: { limit: { nested: true } },
    });
    expect(isError).toBe(true);
    expect(parsed.message).not.toMatch(/\/Users\//);
    expect(parsed.message).not.toMatch(/\bat \w+\./);
  });
});
