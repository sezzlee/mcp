import { createServer, type Server } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
  type AuthInfo,
  type McpServer,
} from "@modelcontextprotocol/server";
import {
  TokenExchangeFailed,
  type TokenExchange,
} from "../credentials/token-exchange.js";
import { exchangedTokenKey } from "../server.js";

export interface HttpTransportOptions {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly resource: string;
  readonly authorizationServers: readonly string[];
  readonly allowedHostnames: readonly string[];
}

export interface ServingHttp {
  readonly server: Server;
  /** Publishes `tools/list_changed` on every `subscriptions/listen` stream a client opened. */
  readonly notifyToolsChanged: () => void;
}

/**
 * Serves the gateway over streamable HTTP, behind a bearer gate when token exchange is configured.
 * Without it the server has no caller to authenticate; the config then only accepts a loopback
 * host, so the operator's credentials are not offered to the network.
 *
 * Guard: the gate's verifier is the token exchange itself. The gateway cannot check a token it
 * holds no key for, and the authorization server that can — it issued the token — does so while
 * exchanging it; a refused exchange is `invalid_token`, so the client is told to re-authorize
 * rather than handed a tool error it cannot act on. The caller's token never leaves this process
 * except to that authorization server.
 *
 * Guard: the handler is built once and its notifier is what `notifyToolsChanged` calls. Each
 * request gets a fresh server from the factory, gone before the next reload, so a change can only
 * reach a listening client through the handler's bus.
 */
export function serveHttp(
  factory: () => McpServer,
  exchange: TokenExchange | undefined,
  options: HttpTransportOptions,
): Promise<ServingHttp> {
  const resource = new URL(options.resource);
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  const metadataPath = new URL(metadataUrl).pathname;
  const metadata = JSON.stringify({
    resource: resource.href,
    authorization_servers: options.authorizationServers,
    bearer_methods_supported: ["header"],
  });
  const handler = createMcpHandler(factory);
  const gate =
    exchange === undefined
      ? undefined
      : requireBearerAuth({
          resourceMetadataUrl: metadataUrl,
          verifier: {
            async verifyAccessToken(token: string): Promise<AuthInfo> {
              try {
                const exchanged = await exchange.exchange(token);
                return {
                  token,
                  clientId: "",
                  scopes: [],
                  expiresAt: exchanged.expiresAt,
                  resource,
                  extra: { [exchangedTokenKey]: exchanged.token },
                };
              } catch (error) {
                if (error instanceof TokenExchangeFailed && error.rejected) {
                  throw new OAuthError(
                    OAuthErrorCode.InvalidToken,
                    "token rejected",
                  );
                }
                throw new OAuthError(
                  OAuthErrorCode.ServerError,
                  "the authorization server is unavailable",
                );
              }
            },
          },
        });
  const hostnames = [
    ...localhostAllowedHostnames(),
    ...options.allowedHostnames,
  ];
  const node = toNodeHandler({
    async fetch(request) {
      const rejected = hostHeaderValidationResponse(request, hostnames);
      if (rejected !== undefined) {
        return rejected;
      }
      const { pathname } = new URL(request.url);
      if (pathname === metadataPath) {
        return new Response(metadata, {
          headers: { "content-type": "application/json" },
        });
      }
      if (pathname !== options.path) {
        return new Response(null, { status: 404 });
      }
      if (gate === undefined) {
        return handler.fetch(request);
      }
      const auth = await gate(request);
      if (auth instanceof Response) {
        return auth;
      }
      return handler.fetch(request, { authInfo: auth });
    },
  });
  const server = createServer((req, res) => {
    void node(req, res);
  });
  return new Promise((resolve) => {
    server.listen(options.port, options.host, () =>
      resolve({
        server,
        notifyToolsChanged: () => {
          handler.notify.toolsChanged();
        },
      }),
    );
  });
}
