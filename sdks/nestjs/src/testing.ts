import type { INestApplication } from "@nestjs/common";
import { SezzleeCatalog, type CatalogEntry } from "./catalog.js";
import { extensionTokens } from "./extension-points.js";
import type { OuterRequest } from "./options.js";
import { toolInfoOf } from "./visibility/authorizer.js";
import type { McpToolInfo, ToolAuthorizer } from "./visibility/authorizer.js";
import type { VisibilityEvaluator } from "./visibility/evaluator.js";
import type { ProbeEvaluator } from "./visibility/probe.js";
import { CallerVisibilityProvider } from "./visibility/provider.js";

export type { McpToolInfo } from "./visibility/authorizer.js";

/** One identity to audit: the headers its MCP requests carry, as a host's tests would send them. */
export interface AuditCaller {
  readonly name: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface VisibilityAuditOptions {
  /**
   * Tools the audit skips, reported as `excluded` and never silently dropped. Use it for a tool
   * whose access a handler decides, which the probe cannot see.
   */
  readonly exclude?: (tool: McpToolInfo) => boolean;
  /** How many probe requests run at once; a positive integer, default 4. */
  readonly concurrency?: number;
}

export type VisibilityFindingKind =
  "listedButDenied" | "hiddenButAllowed" | "notComparable" | "excluded";

interface FindingBase {
  readonly caller: string;
  readonly tool: string;
}

export type VisibilityFinding =
  | (FindingBase & { readonly kind: "listedButDenied" })
  | (FindingBase & { readonly kind: "hiddenButAllowed" })
  | (FindingBase & {
      readonly kind: "notComparable";
      readonly reason: string;
    })
  | (FindingBase & { readonly kind: "excluded" });

const defaultConcurrency = 4;

const kindOrder: readonly VisibilityFindingKind[] = [
  "listedButDenied",
  "hiddenButAllowed",
  "notComparable",
  "excluded",
];

const kindMeaning: Record<VisibilityFindingKind, string> = {
  listedButDenied:
    "listed by search_tools and load_tool, but the real pipeline answers 401 or 403",
  hiddenButAllowed:
    "hidden by search_tools and load_tool, but the real pipeline lets the caller through",
  notComparable: "the probe could not judge the tool, so nothing was compared",
  excluded: "skipped by the exclude option",
};

/** Thrown by {@link VisibilityAuditReport.ensureConsistent}; carries the report it judged. */
export class VisibilityAuditError extends Error {
  constructor(
    message: string,
    readonly report: VisibilityAuditReport,
  ) {
    super(message);
    this.name = "VisibilityAuditError";
  }
}

export class VisibilityAuditReport {
  readonly counts: Readonly<Record<VisibilityFindingKind, number>>;

  /**
   * @param callers how many callers were audited
   * @param tools how many catalog tools each caller was audited against
   * @param consistent the caller and tool pairs whose listing and probe agreed
   * @param findings every pair that did not end consistent, in caller then catalog order
   */
  constructor(
    readonly callers: number,
    readonly tools: number,
    readonly consistent: number,
    readonly findings: readonly VisibilityFinding[],
  ) {
    const count = (kind: VisibilityFindingKind): number =>
      findings.filter((finding) => finding.kind === kind).length;
    this.counts = {
      listedButDenied: count("listedButDenied"),
      hiddenButAllowed: count("hiddenButAllowed"),
      notComparable: count("notComparable"),
      excluded: count("excluded"),
    };
  }

  /** Every caller and tool pair: `compared + notComparable + excluded`. */
  get total(): number {
    return this.callers * this.tools;
  }

  /** The pairs where both sides gave an answer: the consistent ones and the two divergences. */
  get compared(): number {
    return (
      this.consistent +
      this.counts.listedButDenied +
      this.counts.hiddenButAllowed
    );
  }

  /**
   * Throws when any pair diverged or could not be compared. A pair the probe could not judge fails
   * too, because a green audit that compared nothing would be false confidence; resolve it with
   * `visibility.probeValues`, or skip the tool with `exclude`.
   */
  ensureConsistent(): void {
    const failing = kindOrder.filter(
      (kind) => kind !== "excluded" && this.counts[kind] > 0,
    );
    if (failing.length === 0) {
      return;
    }
    const lines = [
      `Visibility audit: ${String(this.total - this.counts.excluded - this.consistent)} of ${String(this.total)} caller and tool pairs are not consistent (${String(this.callers)} callers, ${String(this.tools)} tools, ${String(this.counts.excluded)} excluded).`,
    ];
    for (const kind of failing) {
      lines.push(
        "",
        `${kind} (${String(this.counts[kind])}): ${kindMeaning[kind]}`,
      );
      for (const finding of this.findings) {
        if (finding.kind === kind) {
          lines.push(`  ${describe(finding)}`);
        }
      }
    }
    throw new VisibilityAuditError(lines.join("\n"), this);
  }
}

function describe(finding: VisibilityFinding): string {
  const subject = `${finding.caller}: ${finding.tool}`;
  return finding.kind === "notComparable"
    ? `${subject} - ${finding.reason}`
    : subject;
}

type Truth =
  | { readonly kind: "decided"; readonly decision: "allow" | "deny" }
  | { readonly kind: "unjudged"; readonly reason: string };

/**
 * Compares, for each caller and each catalog tool, what `search_tools` and `load_tool` would show
 * with what the real pipeline answers.
 *
 * The listing side takes the cheap tiers only: the host authorizer, then the guards' declarations,
 * then `visibility.onUnknown`, through the same code the tools use and without a probe, so the
 * audit measures those tiers. The truth side sends one probe per tool and caller: a request through
 * the host's middleware, guards, pipes and interceptors that stops before the handler. It runs
 * uncached and uncapped, and neither reads nor writes the shared verdict cache or the held
 * authorizer accesses.
 *
 * Limit: the probe never reaches the handler, so a check inside it, such as a dispatcher that
 * validates its target method, is invisible to it. A tool the authorizer hides for that reason
 * shows as `hiddenButAllowed`; skip such tools with `exclude`.
 *
 * A probe that 404s or returns a 2xx without the short-circuit marker disables probing for that
 * tool until the catalog changes, exactly as it would during a search.
 *
 * @param app an initialized application that has {@link SezzleeModule} imported
 * @param callers the identities to audit; names must be unique
 */
export async function auditVisibility(
  app: INestApplication,
  callers: readonly AuditCaller[],
  options: VisibilityAuditOptions = {},
): Promise<VisibilityAuditReport> {
  const concurrency = options.concurrency ?? defaultConcurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(
      `auditVisibility: concurrency must be a positive integer, received ${String(concurrency)}`,
    );
  }
  const duplicate = callers.find(
    (caller, index) =>
      callers.findIndex((other) => other.name === caller.name) !== index,
  );
  if (duplicate !== undefined) {
    throw new Error(
      `auditVisibility: caller name '${duplicate.name}' is used twice; findings would not say which one they mean`,
    );
  }

  const catalog = app.get(SezzleeCatalog, { strict: false });
  catalog.ensureValid();
  const snapshot = catalog.current;
  const provider = app.get(CallerVisibilityProvider, { strict: false });
  const evaluator = app.get<VisibilityEvaluator>(
    extensionTokens.visibilityEvaluator,
    { strict: false },
  );
  const authorizer = app.get<ToolAuthorizer | null>(
    extensionTokens.toolAuthorizer,
    { strict: false },
  );
  const prober = app.get<ProbeEvaluator>(extensionTokens.probeEvaluator, {
    strict: false,
  });

  const excluded = options.exclude ?? (() => false);
  const rows: {
    caller: string;
    tool: string;
    entry: CatalogEntry;
    outer: OuterRequest;
    listed: boolean | undefined;
  }[] = [];

  for (const caller of callers) {
    const outer: OuterRequest = { headers: lowercased(caller.headers) };
    const [facts, access] = await Promise.all([
      evaluator.resolve(outer, snapshot.policyNames),
      authorizer === null ? undefined : authorizer.resolve(outer),
    ]);
    for (const entry of snapshot.entries) {
      rows.push({
        caller: caller.name,
        tool: entry.tool.name,
        entry,
        outer,
        listed: excluded(toolInfoOf(entry))
          ? undefined
          : provider.visible(provider.decideFor(entry, facts, access)),
      });
    }
  }

  const truths = new Map<number, Truth>();
  const pending = rows.flatMap((row, index) =>
    row.listed === undefined ? [] : [index],
  );
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let at = next++; at < pending.length; at = next++) {
      const index = pending[at];
      const row = index === undefined ? undefined : rows[index];
      if (index !== undefined && row !== undefined) {
        truths.set(index, await truthOf(prober, row.entry, row.outer));
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, worker),
  );

  const findings: VisibilityFinding[] = [];
  let consistent = 0;
  rows.forEach((row, index) => {
    const base = { caller: row.caller, tool: row.tool };
    const truth = truths.get(index);
    if (row.listed === undefined || truth === undefined) {
      findings.push({ ...base, kind: "excluded" });
    } else if (truth.kind === "unjudged") {
      findings.push({ ...base, kind: "notComparable", reason: truth.reason });
    } else if (row.listed && truth.decision === "deny") {
      findings.push({ ...base, kind: "listedButDenied" });
    } else if (!row.listed && truth.decision === "allow") {
      findings.push({ ...base, kind: "hiddenButAllowed" });
    } else {
      consistent += 1;
    }
  });
  return new VisibilityAuditReport(
    callers.length,
    snapshot.entries.length,
    consistent,
    findings,
  );
}

function lowercased(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

async function truthOf(
  prober: ProbeEvaluator,
  entry: CatalogEntry,
  outer: OuterRequest,
): Promise<Truth> {
  if (entry.template === undefined) {
    return {
      kind: "unjudged",
      reason:
        "the tool has no request template, so it cannot be dispatched or probed",
    };
  }
  if (!prober.canProbe(entry)) {
    return {
      kind: "unjudged",
      reason:
        "probing is disabled for this tool: an earlier probe did not route or came back without the short-circuit marker; declare a value in visibility.probeValues",
    };
  }
  const decision = await prober.probe(entry, outer);
  if (decision !== "unknown") {
    return { kind: "decided", decision };
  }
  return {
    kind: "unjudged",
    reason: prober.canProbe(entry)
      ? "the probe was inconclusive: a throttle, a server error, a timeout or a redirect says nothing about this caller's access"
      : "the probe disabled itself for this tool: its path did not route or the response came back without the short-circuit marker; declare a value in visibility.probeValues",
  };
}
