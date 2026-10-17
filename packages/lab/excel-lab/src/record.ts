import { createHash } from "node:crypto";
import { z } from "zod";

export type Sha256 = string & { readonly __brand: "Sha256" };

const sha256Pattern = /^[0-9a-f]{64}$/;

export function isSha256(value: string): value is Sha256 {
  return sha256Pattern.test(value);
}

export const sha256Schema = z.string().refine(isSha256);

export function sha256Of(data: string | Uint8Array): Sha256 {
  const digest = createHash("sha256").update(data).digest("hex");
  if (!isSha256(digest)) {
    throw new Error(`unexpected sha256 digest: ${digest}`);
  }
  return digest;
}

export const probeFormats = ["xlsx", "xlsm", "csv"] as const;
export type ProbeFormat = (typeof probeFormats)[number];

export function isProbeFormat(value: string): value is ProbeFormat {
  return probeFormats.some((format) => format === value);
}

const toolArgs = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
export type ToolArgs = z.infer<typeof toolArgs>;

const callOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok") }),
  z.object({ kind: z.literal("error"), code: z.string() }),
]);
export type CallOutcome = z.infer<typeof callOutcome>;

const callRecord = z.object({
  tool: z.string(),
  args: toolArgs,
  ms: z.number().nonnegative(),
  bytes: z.int().nonnegative(),
  digest: sha256Schema,
  outcome: callOutcome,
  text: z.string(),
});
export type CallRecord = z.infer<typeof callRecord>;

export const probeReportSchema = z.object({
  calls: z.array(callRecord),
  sheetsTotal: z.int().nonnegative(),
  sheetsProbed: z.int().nonnegative(),
  ms: z.number().nonnegative(),
  maxRssKiB: z.int().nonnegative(),
});
export type ProbeReport = z.infer<typeof probeReportSchema>;

export const probeArgvSchema = z.tuple([
  z.string().min(1),
  z.string().min(1),
  z.enum(probeFormats),
]);

export interface CorpusEntry {
  readonly source: string;
  readonly file: string;
  readonly path: string;
  readonly sha256: Sha256;
  readonly bytes: number;
  readonly format: ProbeFormat;
  readonly license: string;
}

export type EntryRef = Omit<CorpusEntry, "path">;

export type CallSummary = Omit<CallRecord, "text">;

export type FileResult =
  | {
      readonly kind: "probed";
      readonly entry: EntryRef;
      readonly calls: readonly CallSummary[];
      readonly sheetsTotal: number;
      readonly sheetsProbed: number;
      readonly ms: number;
      readonly maxRssKiB: number;
    }
  | { readonly kind: "missing"; readonly entry: EntryRef }
  | {
      readonly kind: "sha_mismatch";
      readonly entry: EntryRef;
      readonly actual: Sha256;
    }
  | {
      readonly kind: "timed_out";
      readonly entry: EntryRef;
      readonly ms: number;
    }
  | {
      readonly kind: "crashed";
      readonly entry: EntryRef;
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly stderrTail: string;
    }
  | {
      readonly kind: "bad_report";
      readonly entry: EntryRef;
      readonly stderrTail: string;
    };

export type FileResultKind = FileResult["kind"];
