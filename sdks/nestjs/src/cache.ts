import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  createCallerScope,
  deriveCallerScopeKey,
  digestInput,
  type CacheTag,
  type CallerScope,
  type SezzleeCache,
} from "@sezzlee/core";
import { extensionTokens } from "./extension-points.js";
import { CallerVisibilityProvider } from "./visibility/provider.js";
import {
  SEZZLEE_OPTIONS,
  SezzleeOptions,
  type OuterRequest,
} from "./options.js";

export interface CallerScopeResolver {
  resolve(outer: OuterRequest | undefined): CallerScope;
}

@Injectable()
export class CarrierHashCallerScopeResolver implements CallerScopeResolver {
  constructor(
    @Inject(SEZZLEE_OPTIONS) private readonly options: SezzleeOptions,
  ) {}

  resolve(outer: OuterRequest | undefined): CallerScope {
    const carriers = [...this.options.identity.carriers];
    const digest = digestInput(carriers, (name) => outer?.headers[name]);
    return createCallerScope(deriveCallerScopeKey(digest));
  }
}

export const SEZZLEE_CACHE_INVALIDATOR = Symbol("SEZZLEE_CACHE_INVALIDATOR");

@Injectable()
export class SezzleeCacheInvalidator {
  constructor(
    @Inject(extensionTokens.cache) private readonly cache: SezzleeCache,
    @Optional()
    @Inject(CallerVisibilityProvider)
    private readonly visibility: CallerVisibilityProvider | null = null,
  ) {}

  invalidateCaller(scope: CallerScope): Promise<void> {
    this.visibility?.invalidateAccess(scope);
    return this.cache.removeScope(scope.key);
  }

  /**
   * Guard: a held authorizer access is not indexed by tag, so a tag invalidation drops every held
   * access. Dropping none would leave a caller whose permissions changed under that tag seeing the
   * old answer for a whole cache lifetime.
   */
  invalidateTag(tag: CacheTag): Promise<void> {
    this.visibility?.invalidateAccess();
    return this.cache.removeTag(tag);
  }

  invalidateAll(): Promise<void> {
    this.visibility?.invalidateAccess();
    return this.cache.clear();
  }
}
