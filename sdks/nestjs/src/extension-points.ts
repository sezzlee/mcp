import type { InjectionToken, Provider, Type } from "@nestjs/common";
import type { ResultStore, SezzleeCache, ToolRanker } from "@sezzlee/core";
import type { CallerScopeResolver } from "./cache.js";
import type { InvokeResultMapper } from "./invoke-result-mapper.js";
import type { VisibilityEvaluator } from "./visibility/evaluator.js";
import type { ToolAuthorizer } from "./visibility/authorizer.js";
import type { ProbeEvaluator } from "./visibility/probe.js";

export interface ExtensionPoints {
  cache: SezzleeCache;
  callerScopeResolver: CallerScopeResolver;
  invokeResultMapper: InvokeResultMapper;
  visibilityEvaluator: VisibilityEvaluator;
  probeEvaluator: ProbeEvaluator;
  toolRanker: ToolRanker | null;
  toolAuthorizer: ToolAuthorizer | null;
  resultStore: ResultStore | null;
}

export const extensionTokens = {
  cache: Symbol("SEZZLEE_CACHE"),
  callerScopeResolver: Symbol("SEZZLEE_CALLER_SCOPE_RESOLVER"),
  invokeResultMapper: Symbol("SEZZLEE_INVOKE_RESULT_MAPPER"),
  visibilityEvaluator: Symbol("SEZZLEE_VISIBILITY_EVALUATOR"),
  probeEvaluator: Symbol("SEZZLEE_PROBE_EVALUATOR"),
  toolRanker: Symbol("SEZZLEE_TOOL_RANKER"),
  toolAuthorizer: Symbol("SEZZLEE_TOOL_AUTHORIZER"),
  resultStore: Symbol("SEZZLEE_RESULT_STORE"),
} as const satisfies { readonly [K in keyof ExtensionPoints]: symbol };

export type OverrideProvider<T> =
  | { useClass: Type<T> }
  | {
      useFactory: (...args: never[]) => T | Promise<T>;
      inject?: InjectionToken[];
    }
  | { useValue: T };

export type ExtensionOverrides = Partial<{
  [K in keyof ExtensionPoints]: OverrideProvider<ExtensionPoints[K]>;
}>;

export function toProviders(overrides?: ExtensionOverrides): Provider[] {
  if (overrides === undefined) {
    return [];
  }
  const providers: Provider[] = [];
  for (const key of Object.keys(extensionTokens) as (keyof ExtensionPoints)[]) {
    const override = overrides[key];
    if (override === undefined) {
      continue;
    }
    const token = extensionTokens[key];
    if ("useValue" in override) {
      providers.push({ provide: token, useValue: override.useValue });
    } else if ("useFactory" in override) {
      providers.push({
        provide: token,
        useFactory: override.useFactory,
        inject: override.inject ?? [],
      });
    } else {
      providers.push({ provide: token, useClass: override.useClass });
    }
  }
  return providers;
}
