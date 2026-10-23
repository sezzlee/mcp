import { Inject, Injectable } from "@nestjs/common";
import { McpServer } from "@modelcontextprotocol/server";
import type { ResultStore } from "@sezzlee/core";
import type { CallerScopeResolver } from "../cache.js";
import { SezzleeCatalog } from "../catalog.js";
import { SezzleeDispatcher } from "../dispatcher.js";
import { extensionTokens } from "../extension-points.js";
import type { InvokeResultMapper } from "../invoke-result-mapper.js";
import {
  registerSezzleeTools,
  type MetaToolDependencies,
} from "../meta-tools.js";
import { SEZZLEE_OPTIONS, SezzleeOptions } from "../options.js";
import { CallerVisibilityProvider } from "../visibility/provider.js";
import {
  SezzleeStreamableHttp,
  type SezzleeRequestHandler,
} from "./streamable-http.js";

export interface SezzleeEndpointOptions {
  readonly name: string;
  readonly version: string;
  readonly extend?: (server: McpServer, deps: MetaToolDependencies) => void;
}

@Injectable()
export class SezzleeMcpEndpoint {
  private readonly deps: MetaToolDependencies;

  constructor(
    private readonly streamableHttp: SezzleeStreamableHttp,
    catalog: SezzleeCatalog,
    dispatcher: SezzleeDispatcher,
    visibility: CallerVisibilityProvider,
    @Inject(extensionTokens.invokeResultMapper) mapper: InvokeResultMapper,
    @Inject(extensionTokens.callerScopeResolver) scopes: CallerScopeResolver,
    @Inject(SEZZLEE_OPTIONS) options: SezzleeOptions,
    @Inject(extensionTokens.resultStore) results: ResultStore | null,
  ) {
    this.deps = {
      catalog,
      dispatcher,
      mapper,
      visibility,
      scopes,
      options,
      results,
    };
  }

  /**
   * Guard: call once per endpoint and keep the handler, for the reason `SezzleeStreamableHttp.serve`
   * states — a handler built per request owns a change bus nobody publishes on.
   */
  serve(endpoint: SezzleeEndpointOptions): SezzleeRequestHandler {
    return this.streamableHttp.serve(() => {
      const server = new McpServer({
        name: endpoint.name,
        version: endpoint.version,
      });
      registerSezzleeTools(server, this.deps);
      endpoint.extend?.(server, this.deps);
      return server;
    });
  }
}
