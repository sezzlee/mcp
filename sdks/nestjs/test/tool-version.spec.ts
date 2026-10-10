import "reflect-metadata";
import {
  All,
  Controller,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  Query,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallerScopeResolver } from "../src/cache.js";
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
import { CallerVisibilityProvider } from "../src/visibility/provider.js";

const dispatched: string[] = [];

@Controller()
@McpTool()
class PingController {
  @Get("ping")
  ping(): string {
    return "pong";
  }
}

@Controller()
@McpTool()
class OrdersController {
  @Get("orders/:id")
  getOrder(@Param("id", ParseIntPipe) id: number): { id: number } {
    dispatched.push("orders");
    return { id };
  }
}

@Controller()
@McpTool()
class OrdersWithExpandController {
  @Get("orders/:id")
  getOrder(
    @Param("id", ParseIntPipe) id: number,
    @Query("expand") _expand?: string,
  ): { id: number } {
    dispatched.push("orders-with-expand");
    return { id };
  }
}

@Controller()
class ReplicaMcpController {
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
      const server = new McpServer({ name: "replica", version: "0.0.0" });
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

interface Replica {
  readonly app: INestApplication;
  readonly client: Client;
  readonly orderTool: string;
}

interface Wire {
  readonly content: { readonly text: string }[];
  readonly isError?: boolean;
}

async function startReplica(
  controllers: (new (...args: never[]) => unknown)[],
): Promise<Replica> {
  const moduleRef = await Test.createTestingModule({
    imports: [SezzleeModule.forRoot()],
    controllers: [...controllers, ReplicaMcpController],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  await app.listen(0);
  const client = new Client({ name: "replica-probe", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${await app.getUrl()}/mcp`)),
  );
  const orderTool = [...app.get(SezzleeCatalog).current.byName.keys()].find(
    (name) => name.endsWith("get_order"),
  );
  if (orderTool === undefined) {
    throw new Error("the replica published no get_order tool");
  }
  return { app, client, orderTool };
}

async function call(
  replica: Replica,
  name: string,
  args: Record<string, unknown>,
): Promise<{ parsed: Record<string, unknown>; isError: boolean }> {
  const result = (await replica.client.callTool({
    name,
    arguments: args,
  })) as unknown as Wire;
  return {
    parsed: JSON.parse(result.content[0]?.text ?? "{}") as Record<
      string,
      unknown
    >,
    isError: result.isError === true,
  };
}

async function versionOn(replica: Replica): Promise<unknown> {
  const { parsed } = await call(replica, "load_tool", {
    name: replica.orderTool,
  });
  return parsed["version"];
}

describe("nest tool version across replicas", () => {
  let loadedFrom: Replica;
  let sameBuild: Replica;
  let nextBuild: Replica;

  beforeAll(async () => {
    loadedFrom = await startReplica([OrdersController, PingController]);
    sameBuild = await startReplica([PingController, OrdersController]);
    nextBuild = await startReplica([OrdersWithExpandController]);
  });

  afterAll(async () => {
    for (const replica of [loadedFrom, sameBuild, nextBuild]) {
      await replica.client.close();
      await replica.app.close();
    }
  });

  it("gives one tool one version on replicas that discovered it in another order", async () => {
    const version = await versionOn(loadedFrom);

    expect(typeof version).toBe("string");
    expect(await versionOn(sameBuild)).toBe(version);
  });

  it("runs a call pinned on one replica when another replica of the same build answers", async () => {
    const version = await versionOn(loadedFrom);

    const { parsed, isError } = await call(sameBuild, "invoke_tool", {
      name: sameBuild.orderTool,
      arguments: { id: 7 },
      version,
    });

    expect(isError).toBe(false);
    expect(parsed["body"]).toEqual({ id: 7 });
  });

  it("refuses a call pinned to a version the answering replica does not hold, before dispatch", async () => {
    const version = await versionOn(loadedFrom);
    dispatched.length = 0;

    const { parsed, isError } = await call(nextBuild, "invoke_tool", {
      name: nextBuild.orderTool,
      arguments: { id: 7 },
      version,
    });

    expect(isError).toBe(true);
    expect(parsed).toEqual({
      error: "tool_changed",
      message: `The tool '${nextBuild.orderTool}' changed after it was loaded, so the call was refused before reaching the backend. Load it again with load_tool and retry with the new version.`,
      retryable: false,
    });
    expect(dispatched).toEqual([]);
  });

  it("answers an unknown name with unknown_tool whatever version it pins", async () => {
    const { parsed, isError } = await call(loadedFrom, "invoke_tool", {
      name: "nope",
      arguments: {},
      version: "stale",
    });

    expect(isError).toBe(true);
    expect(parsed["error"]).toBe("unknown_tool");
  });
});
