import { invokeLimits, resultLimits } from "@sezzlee/core";
import { z } from "zod";

const secret = z.object({ fromEnv: z.string().min(1) }).strict();

const credential = z.union([
  z.object({ value: secret }).strict(),
  z.object({ username: secret, password: secret }).strict(),
]);

const selectionRule = z
  .object({
    route: z.string().min(1).optional(),
    method: z.string().min(1).optional(),
    decision: z.enum(["include", "exclude"]),
  })
  .strict();

const transport = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stdio") }).strict(),
  z
    .object({
      kind: z.literal("http"),
      host: z.string().min(1).default("127.0.0.1"),
      port: z.number().int().min(0).max(65535).default(8787),
      path: z.string().startsWith("/").default("/mcp"),
      resource: z.url(),
      authorizationServers: z.array(z.url()).min(1),
      allowedHostnames: z.array(z.string().min(1)).default([]),
    })
    .strict(),
]);

const tokenExchange = z
  .object({
    tokenEndpoint: z.url(),
    clientId: z.string().min(1),
    clientSecret: secret,
    clientAuth: z.enum(["basic", "post"]).default("basic"),
    audience: z.string().min(1).optional(),
    resource: z.url().optional(),
    scope: z.string().min(1).optional(),
    schemes: z.array(z.string().min(1)).min(1),
  })
  .strict();

const revisionNumber = z.number().int().min(1);

const operationKey = z
  .string()
  .regex(/^[A-Z]+ \//, "an operation key is METHOD /path");

const minimumReloadSeconds = 10;

export const configSchema = z
  .object({
    transport: transport.default({ kind: "stdio" }),
    tokenExchange: tokenExchange.optional(),
    source: z.string().min(1),
    reload: z
      .object({
        intervalSeconds: z.number().int().min(minimumReloadSeconds).optional(),
        onSignal: z.boolean().default(true),
      })
      .strict()
      .optional(),
    baseUrl: z.url().optional(),
    serverVariables: z.record(z.string(), z.string()).optional(),
    hoistPathPrefix: z.string().startsWith("/").optional(),
    outputSchema: z.enum(["document", "omit"]).default("document"),
    requestBodyRequired: z.enum(["document", "always"]).default("document"),
    strict: z.boolean().default(false),
    selection: z
      .object({
        default: z.enum(["include", "exclude"]).default("exclude"),
        rules: z.array(selectionRule).default([]),
      })
      .strict()
      .default({ default: "exclude", rules: [] }),
    names: z
      .record(z.string(), z.string().regex(/^[a-z][a-z0-9_]{0,255}$/))
      .default({}),
    searchTerms: z.record(z.string(), z.array(z.string())).default({}),
    operations: z
      .record(operationKey, z.record(z.string(), z.json()))
      .default({}),
    revision: z
      .object({
        catalog: revisionNumber.optional(),
        paths: z.record(z.string(), revisionNumber).default({}),
        operations: z.record(z.string(), revisionNumber).default({}),
      })
      .strict()
      .default({ paths: {}, operations: {} }),
    credentials: z.record(z.string(), credential).default({}),
    allowHosts: z.array(z.string().min(1)).default([]),
    /**
     * Guard: kept apart from `allowHosts`. That list is where calls and their
     * credentials may go; this one is where the document's author may make the
     * gateway fetch schemas from. Merging them would let one entry widen both.
     */
    refHosts: z.array(z.string().min(1)).default([]),
    identityCookies: z.array(z.string().min(1)).default([]),
    limits: z
      .object({
        timeoutMs: z
          .number()
          .int()
          .positive()
          .default(invokeLimits.invokeTimeoutMs),
        maxResponseBytes: z
          .number()
          .int()
          .positive()
          .default(invokeLimits.maxResponseBytes),
        maxBufferedBytes: z
          .number()
          .int()
          .positive()
          .default(invokeLimits.maxBufferedBytes),
        maxInlineFileBytes: z
          .number()
          .int()
          .positive()
          .default(invokeLimits.maxInlineFileBytes),
      })
      .strict()
      .default({
        timeoutMs: invokeLimits.invokeTimeoutMs,
        maxResponseBytes: invokeLimits.maxResponseBytes,
        maxBufferedBytes: invokeLimits.maxBufferedBytes,
        maxInlineFileBytes: invokeLimits.maxInlineFileBytes,
      }),
    results: z
      .object({
        enabled: z.boolean().default(true),
        lifetimeMs: z.number().int().min(1000).default(resultLimits.lifetimeMs),
        maxCallerBytes: z
          .number()
          .int()
          .positive()
          .default(resultLimits.maxCallerBytes),
        maxBytes: z.number().int().positive().default(resultLimits.maxBytes),
      })
      .strict()
      .refine((results) => results.maxBytes >= results.maxCallerBytes, {
        message: "results.maxBytes must be at least results.maxCallerBytes",
      })
      .default({
        enabled: true,
        lifetimeMs: resultLimits.lifetimeMs,
        maxCallerBytes: resultLimits.maxCallerBytes,
        maxBytes: resultLimits.maxBytes,
      }),
  })
  .strict();

export type GatewayConfig = z.infer<typeof configSchema>;

export type TokenExchangeConfig = NonNullable<GatewayConfig["tokenExchange"]>;

export type ResolvedCredential =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "exchanged" }
  | {
      readonly kind: "basic";
      readonly username: string;
      readonly password: string;
    };

export type ConfigOutcome =
  | {
      readonly kind: "ok";
      readonly config: GatewayConfig;
      readonly credentials: ReadonlyMap<string, ResolvedCredential>;
      readonly clientSecret?: string;
    }
  | { readonly kind: "invalid"; readonly reason: string };

function duplicatedDeclarations(config: GatewayConfig): string[] {
  const older = [
    { field: "toolName", by: "names", values: config.names },
    { field: "searchTerms", by: "searchTerms", values: config.searchTerms },
    {
      field: "revision",
      by: "revision.operations",
      values: config.revision.operations,
    },
  ];
  return Object.entries(config.operations).flatMap(([key, entry]) =>
    older
      .filter(
        ({ field, values }) =>
          entry[field] !== undefined && values[key] !== undefined,
      )
      .map(
        ({ field, by }) => `${by}["${key}"] and operations["${key}"].${field}`,
      ),
  );
}

/**
 * Parses the config and resolves every secret it names.
 *
 * @param env reads one environment variable; secrets are named in the config, never inlined, so a
 * config file can be committed and shared
 */
export function readConfig(
  raw: unknown,
  env: (name: string) => string | undefined,
): ConfigOutcome {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: "invalid",
      reason: `The config is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`,
    };
  }
  const duplicated = duplicatedDeclarations(parsed.data);
  if (duplicated.length > 0) {
    return {
      kind: "invalid",
      reason: `The config declares the same field twice: ${duplicated.join("; ")}. Keep the operations entry and remove the other.`,
    };
  }
  const credentials = new Map<string, ResolvedCredential>();
  const missing: string[] = [];
  const read = (reference: { fromEnv: string }): string => {
    const value = env(reference.fromEnv);
    if (value === undefined || value === "") {
      missing.push(reference.fromEnv);
      return "";
    }
    return value;
  };
  for (const [scheme, declared] of Object.entries(parsed.data.credentials)) {
    credentials.set(
      scheme,
      "value" in declared
        ? { kind: "value", value: read(declared.value) }
        : {
            kind: "basic",
            username: read(declared.username),
            password: read(declared.password),
          },
    );
  }
  const exchange = parsed.data.tokenExchange;
  for (const scheme of exchange?.schemes ?? []) {
    credentials.set(scheme, { kind: "exchanged" });
  }
  const clientSecret =
    exchange === undefined ? undefined : read(exchange.clientSecret);
  if (missing.length > 0) {
    return {
      kind: "invalid",
      reason: `The config names environment variables that are not set: ${missing.join(", ")}.`,
    };
  }
  const transportConfig = parsed.data.transport;
  if (
    exchange === undefined &&
    transportConfig.kind === "http" &&
    !["127.0.0.1", "::1", "localhost"].includes(transportConfig.host)
  ) {
    return {
      kind: "invalid",
      reason:
        "An http transport without token exchange authenticates no caller, so it may only listen on a loopback host; configure tokenExchange or set host to 127.0.0.1.",
    };
  }
  if (exchange !== undefined && parsed.data.transport.kind !== "http") {
    return {
      kind: "invalid",
      reason:
        "token_exchange_requires_http: token exchange needs the caller's own token, which only the http transport carries; stdio has no caller to exchange for.",
    };
  }
  return {
    kind: "ok",
    config: parsed.data,
    credentials,
    ...(clientSecret === undefined ? {} : { clientSecret }),
  };
}
