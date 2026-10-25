import { Scope, type Type } from "@nestjs/common";
import type { DiscoveryService } from "@nestjs/core";
import {
  armDeadline,
  errorResult,
  forwardable,
  narrowingArguments,
  refuseTimedOutInvoke,
  refuseUnreadResponse,
  SezzleeCatalogError,
  SezzleeDispatchAborted,
  textResult,
  untilAbandoned,
  type DispatchDeadline,
  type MetaResponse,
  type ProviderSuccess,
  type ToolDefinition,
  type VisibilityDecision,
} from "@sezzlee/core";
import {
  readStandardSchema,
  type StandardJsonSchema,
} from "./discovery/standard-schema.js";
import { callerOf, type McpCaller, type OuterRequest } from "./options.js";

export interface ProviderToolContext {
  readonly tool: string;
  readonly caller: McpCaller;
  readonly signal: AbortSignal;
}

export interface ProviderToolSchema<Value> extends StandardJsonSchema {
  readonly "~standard": StandardJsonSchema["~standard"] & {
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: Value; readonly issues?: undefined }
      | { readonly issues: readonly { readonly message: string }[] }
      | Promise<
          | { readonly value: Value; readonly issues?: undefined }
          | { readonly issues: readonly { readonly message: string }[] }
        >;
  };
}

export interface ProviderToolDefinition<Provider, Input, Output> {
  readonly name: string;
  readonly description: string;
  readonly provider: Type<Provider>;
  readonly input: ProviderToolSchema<Input>;
  readonly output?: ProviderToolSchema<Output>;
  readonly annotations?: ToolDefinition["annotations"];
  readonly revision?: number;
  readonly tags?: readonly string[];
  readonly searchTerms?: readonly string[];
  readonly access:
    "public" | ((context: ProviderToolContext) => boolean | Promise<boolean>);
  readonly execute: (
    provider: Provider,
    input: Input,
    context: ProviderToolContext,
  ) => Output | Promise<Output>;
}

export interface ProviderToolEntry {
  readonly kind: "provider";
  readonly tool: ToolDefinition;
  readonly tags: readonly string[];
  readonly searchTerms: readonly string[];
  readonly authorize: (context: ProviderToolContext) => Promise<boolean>;
  readonly execute: (
    input: unknown,
    context: ProviderToolContext,
  ) => Promise<unknown>;
}

export interface ProviderToolRegistration {
  readonly bind: (discovery: DiscoveryService) => ProviderToolEntry;
}

class InvalidProviderInput extends Error {}
class InvalidProviderOutput extends Error {}

/** An intentional business refusal; the message is public and must contain no secrets. */
export class ProviderToolError extends Error {}

function invalid(message: string): never {
  throw new SezzleeCatalogError("provider_registration_invalid", message);
}

function schemaOf(schema: StandardJsonSchema, side: "input" | "output") {
  const reading = readStandardSchema(schema, side);
  if (reading?.kind !== "read") {
    return invalid(`Provider tool ${side} schema is unreadable.`);
  }
  return reading.schema;
}

function assertJson(value: unknown): void {
  const ancestors = new Set<object>();
  const visit = (node: unknown): void => {
    if (
      node === null ||
      typeof node === "string" ||
      typeof node === "boolean"
    ) {
      return;
    }
    if (typeof node === "number" && Number.isFinite(node)) {
      return;
    }
    if (typeof node !== "object" || node === null || ancestors.has(node)) {
      throw new InvalidProviderOutput();
    }
    const prototype: unknown = Object.getPrototypeOf(node);
    if (
      Object.getOwnPropertySymbols(node).length > 0 ||
      (Array.isArray(node) && Object.keys(node).length !== node.length)
    ) {
      throw new InvalidProviderOutput();
    }
    if (
      !Array.isArray(node) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new InvalidProviderOutput();
    }
    ancestors.add(node);
    for (const child of Object.values(node)) {
      visit(child);
    }
    ancestors.delete(node);
  };
  visit(value);
}

/** Registers a singleton Nest provider as an MCP tool without creating an HTTP route. */
export function defineProviderTool<Provider, Input, Output>(
  definition: ProviderToolDefinition<Provider, Input, Output>,
): ProviderToolRegistration {
  return {
    bind: (discovery) => {
      if (
        !/^[a-z][a-z0-9_]{0,255}$/.test(definition.name) ||
        !definition.description.trim()
      ) {
        return invalid(
          "Provider tools need a valid tool name and a nonblank description.",
        );
      }
      if (
        definition.access !== "public" &&
        typeof definition.access !== "function"
      ) {
        return invalid(
          `Provider tool '${definition.name}' needs an explicit access policy.`,
        );
      }
      if (
        typeof definition.input?.["~standard"]?.validate !== "function" ||
        (definition.output !== undefined &&
          typeof definition.output?.["~standard"]?.validate !== "function") ||
        typeof definition.execute !== "function"
      ) {
        return invalid(
          `Provider tool '${definition.name}' needs runtime validators and an execute function.`,
        );
      }
      if (
        definition.revision !== undefined &&
        (!Number.isSafeInteger(definition.revision) || definition.revision < 0)
      ) {
        return invalid(
          `Provider tool '${definition.name}' has an invalid revision.`,
        );
      }
      const wrappers = discovery
        .getProviders()
        .filter((wrapper) => wrapper.token === definition.provider);
      const [wrapper] = wrappers;
      if (
        wrappers.length !== 1 ||
        wrapper === undefined ||
        wrapper.scope === Scope.REQUEST ||
        wrapper.isTransient ||
        !wrapper.isDependencyTreeStatic()
      ) {
        return invalid(
          `Provider tool '${definition.name}' needs one registered singleton provider with a static dependency tree.`,
        );
      }
      const instance: unknown = wrapper.instance;
      if (!(instance instanceof definition.provider)) {
        return invalid(
          `Provider tool '${definition.name}' could not resolve its provider.`,
        );
      }
      const inputSchema = schemaOf(definition.input, "input");
      if (
        inputSchema.type !== "object" ||
        inputSchema.additionalProperties !== false
      ) {
        return invalid(
          `Provider tool '${definition.name}' needs a strict object input schema.`,
        );
      }
      const outputSchema =
        definition.output === undefined
          ? undefined
          : schemaOf(definition.output, "output");
      const access = definition.access;
      const { input, output, execute } = definition;
      return {
        kind: "provider",
        tool: {
          name: definition.name,
          description: definition.description,
          inputSchema,
          ...(outputSchema === undefined
            ? {}
            : {
                outputSchema: {
                  type: "object",
                  required: ["body"],
                  properties: { body: outputSchema },
                  additionalProperties: false,
                },
              }),
          annotations: { readOnlyHint: false, ...definition.annotations },
          auth: {
            anonymous: access === "public" ? "yes" : "unknown",
            policies: [],
            imperative: access !== "public",
          },
          ...(definition.revision === undefined
            ? {}
            : { revision: { operation: definition.revision } }),
        },
        tags: [...(definition.tags ?? [])],
        searchTerms: [...(definition.searchTerms ?? [])],
        authorize: async (context) =>
          access === "public" || (await access(context)) === true,
        execute: async (argumentsValue, context) => {
          const parsed = await input["~standard"].validate(argumentsValue);
          if (parsed.issues !== undefined) {
            throw new InvalidProviderInput();
          }
          context.signal.throwIfAborted();
          const value = await execute(instance, parsed.value, context);
          const result =
            output === undefined
              ? { value, issues: undefined }
              : await output["~standard"].validate(value);
          if (result.issues !== undefined) {
            throw new InvalidProviderOutput();
          }
          assertJson(result.value);
          return result.value;
        },
      };
    },
  };
}

export function providerContext(
  entry: ProviderToolEntry,
  outer: OuterRequest | undefined,
  signal: AbortSignal,
): ProviderToolContext {
  return Object.freeze({
    tool: entry.tool.name,
    caller: callerOf(outer),
    signal,
  });
}

export async function providerDecision(
  entry: ProviderToolEntry,
  outer: OuterRequest | undefined,
  deadline: DispatchDeadline,
): Promise<VisibilityDecision> {
  const state = armDeadline(deadline);
  try {
    state.signal.throwIfAborted();
    const allowed = await untilAbandoned(
      entry.authorize(providerContext(entry, outer, state.signal)),
      state.signal,
      state.reason,
    );
    return allowed ? "allow" : "deny";
  } catch {
    return "deny";
  } finally {
    state.dispose();
  }
}

export async function invokeProvider(
  entry: ProviderToolEntry,
  input: unknown,
  outer: OuterRequest | undefined,
  deadline: DispatchDeadline,
  maxBufferedBytes = Number.MAX_SAFE_INTEGER,
): Promise<MetaResponse<never>> {
  const state = armDeadline(deadline);
  let authorized = false;
  try {
    state.signal.throwIfAborted();
    const context = providerContext(entry, outer, state.signal);
    const allowed = await untilAbandoned(
      entry.authorize(context),
      state.signal,
      state.reason,
    );
    if (!allowed) {
      return errorResult(
        "provider_forbidden",
        "This caller may not invoke the tool.",
      );
    }
    authorized = true;
    state.signal.throwIfAborted();
    const value = await untilAbandoned(
      entry.execute(input, context),
      state.signal,
      state.reason,
    );
    const success: ProviderSuccess = { body: value };
    if (Buffer.byteLength(JSON.stringify(success), "utf8") > maxBufferedBytes) {
      return textResult(
        refuseUnreadResponse({
          limit: maxBufferedBytes,
          narrowing: narrowingArguments(entry.tool.inputSchema),
          applied: entry.tool.annotations.readOnlyHint !== true,
        }),
        true,
      );
    }
    return textResult(success, false, {
      summaryOf: value,
      narrowing: narrowingArguments(entry.tool.inputSchema),
      applied: entry.tool.annotations.readOnlyHint !== true,
      storable: { tool: entry.tool.name, success },
    });
  } catch (error) {
    if (
      state.reason() === "timeout" ||
      (error instanceof SezzleeDispatchAborted && error.reason === "timeout")
    ) {
      return textResult(refuseTimedOutInvoke(deadline.timeoutMs ?? 0), true);
    }
    if (!authorized) {
      return errorResult(
        "provider_forbidden",
        "This caller may not invoke the tool.",
      );
    }
    if (error instanceof InvalidProviderInput) {
      return errorResult(
        "provider_invalid_input",
        "Arguments do not match the tool's input schema.",
      );
    }
    if (error instanceof InvalidProviderOutput) {
      return errorResult(
        "provider_invalid_output",
        "The tool returned an invalid result.",
      );
    }
    if (error instanceof ProviderToolError) {
      return errorResult(
        "provider_business_error",
        forwardable(error.message) ?? "The operation was refused.",
      );
    }
    return errorResult("provider_failed", "The tool did not complete.");
  } finally {
    state.dispose();
  }
}
