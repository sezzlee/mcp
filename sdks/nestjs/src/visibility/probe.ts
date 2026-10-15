import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { of, type Observable } from "rxjs";
import type { VisibilityDecision } from "@sezzlee/core";
import type { CatalogEntry } from "../catalog.js";
import { SezzleeDispatcher, type ProbeResult } from "../dispatcher.js";
import { SezzleeDispatchAborted } from "../synthetic-context.js";
import {
  isSezzleeProbe,
  markShortCircuited,
  wasShortCircuited,
} from "../markers.js";
import type { OuterRequest, SezzleeOptions } from "../options.js";

@Injectable()
export class SezzleeProbeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request: unknown = context.switchToHttp().getRequest();
    if (!isSezzleeProbe(request)) {
      return next.handle();
    }
    markShortCircuited(request as object);
    return of(undefined);
  }
}

export interface ProbeEvaluator {
  canProbe(entry: CatalogEntry): boolean;
  /**
   * @param signal aborted when the caller cancels the call the probe serves
   * @returns `allow` or `deny` when the pipeline answered for the tool, `unknown` when it did not
   */
  probe(
    entry: CatalogEntry,
    outer: OuterRequest | undefined,
    signal?: AbortSignal,
  ): Promise<VisibilityDecision>;
}

export class SezzleeProbeEvaluator implements ProbeEvaluator {
  private readonly disabled = new Map<string, string>();

  constructor(
    private readonly dispatcher: SezzleeDispatcher,
    private readonly options: SezzleeOptions,
  ) {}

  clearDisabled(): void {
    this.disabled.clear();
  }

  canProbe(entry: CatalogEntry): boolean {
    return entry.template !== undefined && !this.disabled.has(entry.tool.name);
  }

  /**
   * Guard: only an answer that says the probe cannot work for this tool disables it — a route that
   * did not match, or a 2xx the interceptor never marked, which means the handler may have run.
   * Every other answer (429, 5xx, a timeout, a redirect, a 4xx a middleware produced) says nothing
   * about this caller's access and is `unknown`; latching it would take the tool out of search
   * until the catalog changed, after one rate-limited probe. Pinned by test/probe-on-demand.spec.ts.
   */
  async probe(
    entry: CatalogEntry,
    outer: OuterRequest | undefined,
    signal?: AbortSignal,
  ): Promise<VisibilityDecision> {
    const path = this.pathFor(entry);
    const { timeoutMs } = this.options.invoke;
    let result: ProbeResult;
    try {
      result = await this.dispatcher.probe(
        entry.descriptor.method,
        path,
        outer,
        {
          ...(signal === undefined ? {} : { signal }),
          timeoutMs,
        },
      );
    } catch (error) {
      if (error instanceof SezzleeDispatchAborted) {
        return "unknown";
      }
      throw error;
    }

    if (result.status === 401 || result.status === 403) {
      return "deny";
    }
    if (result.shortCircuited) {
      return result.status < 400 ? "allow" : "unknown";
    }
    if (result.status === 404) {
      this.disabled.set(
        entry.tool.name,
        "the probe path did not route; declare a value in visibility.probeValues",
      );
    } else if (result.status >= 200 && result.status < 300) {
      this.disabled.set(
        entry.tool.name,
        "the response came back without the short-circuit marker",
      );
    }
    return "unknown";
  }

  private pathFor(entry: CatalogEntry): string {
    return entry.descriptor.route.replaceAll(
      /\{([^}]+)\}/g,
      (_match, name: string) =>
        encodeURIComponent(
          constantFor(entry, name) ??
            this.options.visibility.probeValues.get(name.toLowerCase()) ??
            placeholderFor(entry, name),
        ),
    );
  }
}

/**
 * Guard: a family member is reachable only through its own key, so a placeholder or a host probe
 * value would probe a different member, or none, and report its verdict for this one.
 */
function constantFor(entry: CatalogEntry, name: string): string | undefined {
  const fill = entry.template?.parameters.find(
    (parameter) => parameter.name === name && parameter.location === "path",
  )?.fill;
  if (fill?.kind !== "constant") {
    return undefined;
  }
  const value: unknown = fill.value;
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : undefined;
}

function placeholderFor(entry: CatalogEntry, name: string): string {
  const parameter = entry.descriptor.parameters?.find(
    (candidate) => candidate.name === name && candidate.in === "path",
  );
  switch (parameter?.schema.type) {
    case "integer":
    case "number":
      return "1";
    case "boolean":
      return "true";
    default:
      break;
  }
  if (parameter?.schema.format === "uuid") {
    return "00000000-0000-0000-0000-000000000000";
  }
  if (parameter?.schema.format === "date-time") {
    return "2000-01-01";
  }
  return "probe";
}

export { wasShortCircuited };
