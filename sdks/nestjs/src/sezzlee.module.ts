import {
  Global,
  Inject,
  Module,
  RequestMethod,
  type DynamicModule,
  type InjectionToken,
  type MiddlewareConsumer,
  type NestModule,
  type Provider,
  type Type,
} from "@nestjs/common";
import { APP_INTERCEPTOR, DiscoveryModule } from "@nestjs/core";
import { requireBearerAuth } from "@modelcontextprotocol/express";
import { MemorySezzleeCache, type SezzleeCache } from "@sezzlee/core";
import { SezzleeCatalog } from "./catalog.js";

const SEZZLEE_PROBE_RESET = Symbol("SEZZLEE_PROBE_RESET");
const SEZZLEE_LIST_CHANGED = Symbol("SEZZLEE_LIST_CHANGED");
import { DeclarativeVisibilityEvaluator } from "./visibility/evaluator.js";
import {
  SezzleeProbeEvaluator,
  SezzleeProbeInterceptor,
  type ProbeEvaluator,
} from "./visibility/probe.js";
import { CallerVisibilityProvider } from "./visibility/provider.js";
import type { VisibilityEvaluator } from "./visibility/evaluator.js";
import type { ToolAuthorizer } from "./visibility/authorizer.js";
import {
  CarrierHashCallerScopeResolver,
  SEZZLEE_CACHE_INVALIDATOR,
  SezzleeCacheInvalidator,
} from "./cache.js";
import { SezzleeDispatcher } from "./dispatcher.js";
import {
  extensionTokens,
  toProviders,
  type ExtensionOverrides,
} from "./extension-points.js";
import { DefaultInvokeResultMapper } from "./invoke-result-mapper.js";
import { SEZZLEE_OPTIONS, SezzleeOptions } from "./options.js";
import { validateSezzleeOptions } from "./options-validation.js";
import { withAudienceCheck } from "./transport/audience.js";
import {
  protectedResourceMetadataHandler,
  protectedResourceMetadataPath,
  protectedResourceMetadataUrl,
} from "./transport/protected-resource-metadata.js";
import { SezzleeStreamableHttp } from "./transport/streamable-http.js";

export interface SezzleeModuleAsyncOptions {
  imports?: DynamicModule["imports"];
  inject?: InjectionToken[];
  useFactory: (...args: never[]) => SezzleeOptions | Promise<SezzleeOptions>;
  overrides?: ExtensionOverrides;
}

function defaultProviders(): Provider[] {
  return [
    {
      provide: extensionTokens.cache,
      useFactory: (options: SezzleeOptions) =>
        new MemorySezzleeCache({
          lifetimeMs: options.cache.lifetimeMs,
          maxCallers: options.cache.maxCallers,
        }),
      inject: [SEZZLEE_OPTIONS],
    },
    {
      provide: extensionTokens.callerScopeResolver,
      useClass: CarrierHashCallerScopeResolver,
    },
    {
      provide: extensionTokens.invokeResultMapper,
      useClass: DefaultInvokeResultMapper,
    },
    {
      provide: extensionTokens.visibilityEvaluator,
      useClass: DeclarativeVisibilityEvaluator,
    },
    { provide: extensionTokens.toolRanker, useValue: null },
    { provide: extensionTokens.toolAuthorizer, useValue: null },
    {
      provide: extensionTokens.probeEvaluator,
      useFactory: (dispatcher: SezzleeDispatcher, options: SezzleeOptions) =>
        new SezzleeProbeEvaluator(dispatcher, options),
      inject: [SezzleeDispatcher, SEZZLEE_OPTIONS],
    },
    {
      provide: SEZZLEE_PROBE_RESET,
      useFactory: (catalog: SezzleeCatalog, prober: ProbeEvaluator) =>
        catalog.onChange(() => {
          if (prober instanceof SezzleeProbeEvaluator) {
            prober.clearDisabled();
          }
        }),
      inject: [SezzleeCatalog, extensionTokens.probeEvaluator],
    },
    {
      provide: CallerVisibilityProvider,
      useFactory: (
        evaluator: VisibilityEvaluator,
        prober: ProbeEvaluator,
        cache: SezzleeCache,
        options: SezzleeOptions,
        authorizer: ToolAuthorizer | null,
      ) =>
        new CallerVisibilityProvider(
          evaluator,
          prober,
          cache,
          options,
          authorizer,
        ),
      inject: [
        extensionTokens.visibilityEvaluator,
        extensionTokens.probeEvaluator,
        extensionTokens.cache,
        SEZZLEE_OPTIONS,
        extensionTokens.toolAuthorizer,
      ],
    },
    {
      /**
       * Guard: the 2026-07-28 revision delivers `tools/list_changed` only on a
       * `subscriptions/listen` stream the client opened, so the notification has to be published on
       * the handler's bus. It cannot be bound per session any more — there are no sessions, and the
       * per-request server the handler builds is gone before the next catalogue reload.
       */
      provide: SEZZLEE_LIST_CHANGED,
      useFactory: (catalog: SezzleeCatalog, transport: SezzleeStreamableHttp) =>
        catalog.onChange(() => {
          transport.notifyToolListChanged();
        }),
      inject: [SezzleeCatalog, SezzleeStreamableHttp],
    },
    { provide: APP_INTERCEPTOR, useClass: SezzleeProbeInterceptor },
    SezzleeCatalog,
    SezzleeDispatcher,
    SezzleeStreamableHttp,
    SezzleeCacheInvalidator,
    {
      provide: SEZZLEE_CACHE_INVALIDATOR,
      useExisting: SezzleeCacheInvalidator,
    },
  ];
}

function moduleExports(): Array<Type<unknown> | InjectionToken> {
  return [
    ...Object.values(extensionTokens),
    CallerVisibilityProvider,
    SezzleeCatalog,
    SezzleeDispatcher,
    SezzleeStreamableHttp,
    SezzleeCacheInvalidator,
    SEZZLEE_CACHE_INVALIDATOR,
    SEZZLEE_OPTIONS,
  ];
}

@Global()
@Module({})
export class SezzleeModule implements NestModule {
  constructor(
    @Inject(SEZZLEE_OPTIONS) private readonly options: SezzleeOptions,
  ) {}

  static forRoot(
    configure?: (options: SezzleeOptions) => void,
    overrides?: ExtensionOverrides,
  ): DynamicModule {
    const options = new SezzleeOptions();
    configure?.(options);
    validateSezzleeOptions(options);
    return {
      module: SezzleeModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: SEZZLEE_OPTIONS, useValue: options },
        ...defaultProviders(),
        ...toProviders(overrides),
      ],
      exports: moduleExports(),
    };
  }

  static forRootAsync(asyncOptions: SezzleeModuleAsyncOptions): DynamicModule {
    return {
      module: SezzleeModule,
      imports: [DiscoveryModule, ...(asyncOptions.imports ?? [])],
      providers: [
        {
          provide: SEZZLEE_OPTIONS,
          useFactory: async (...args: unknown[]) => {
            const options = await asyncOptions.useFactory(...(args as never[]));
            validateSezzleeOptions(options);
            return options;
          },
          inject: asyncOptions.inject ?? [],
        },
        ...defaultProviders(),
        ...toProviders(asyncOptions.overrides),
      ],
      exports: moduleExports(),
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    const resourceServer = this.options.resourceServer;
    if (resourceServer === undefined) {
      return;
    }
    const mcpPath = resourceServer.mcpPath ?? "/mcp";

    consumer.apply(protectedResourceMetadataHandler(resourceServer)).forRoutes({
      path: protectedResourceMetadataPath(mcpPath),
      method: RequestMethod.GET,
    });

    consumer
      .apply(
        requireBearerAuth({
          verifier: withAudienceCheck(
            resourceServer.verifier,
            resourceServer.resource,
          ),
          resourceMetadataUrl: protectedResourceMetadataUrl(
            resourceServer.resource,
            mcpPath,
          ).toString(),
        }),
      )
      .forRoutes({ path: mcpPath, method: RequestMethod.ALL });
  }
}
