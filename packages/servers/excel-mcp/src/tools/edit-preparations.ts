import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { SezzleeExcelError } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import type {
  WorkbookVersion,
  mutationReceiptSchema,
} from "../platform/versions.js";
import type { applyPlannedEdit } from "../format/edit-workbook.js";
import { preparationIdSchema } from "./edit-schemas.js";

type Receipt = z.infer<typeof mutationReceiptSchema>;
type PreparationId = z.infer<typeof preparationIdSchema>;
type PreparedEdit = ReturnType<typeof applyPlannedEdit>;

interface Plan {
  readonly source: WorkbookVersion;
  readonly dependencies: readonly WorkbookVersion[];
  readonly applied: PreparedEdit;
  readonly sources: NonNullable<Receipt["sources"]>;
}

type Entry = {
  readonly expires: number;
  readonly size: number;
} & (
  | { readonly kind: "ready"; readonly plan: Plan }
  | { readonly kind: "published"; readonly receipt: Receipt }
);

/** Holds bounded, materialized edits within one server session. */
export function createEditPreparations() {
  const entries = new Map<PreparationId, Entry>();
  let bytes = 0;
  let closed = false;

  function expire() {
    for (const [id, entry] of entries)
      if (entry.expires <= Date.now()) {
        bytes -= entry.size;
        entries.delete(id);
      }
  }

  function get(id: PreparationId): Entry {
    expire();
    const entry = closed ? undefined : entries.get(id);
    if (entry === undefined)
      throw new SezzleeExcelError(
        "invalid_argument",
        "The edit preparation is missing, expired, or belongs to another server session.",
        "Call prepare_edit again in this session with the intended source and changes.",
      );
    return entry;
  }

  return {
    get,
    add(plan: Plan): PreparationId {
      expire();
      const { bytes: output, ...metadata } = plan.applied;
      const size =
        output.length +
        Buffer.byteLength(
          JSON.stringify({
            source: plan.source,
            dependencies: plan.dependencies,
            sources: plan.sources,
            ...metadata,
          }),
        );
      const pending = [...entries.values()].filter(
        (entry) => entry.kind === "ready",
      ).length;
      if (
        closed ||
        pending >= limits.maxEditPreparations ||
        entries.size >= limits.maxEditPreparationEntries ||
        size > limits.maxEditPreparationBytes ||
        bytes + size > limits.maxEditPreparationStoreBytes
      )
        throw new SezzleeExcelError(
          "resource_limit",
          "The edit preparation store has reached its count or byte budget.",
          "Wait for a preparation to expire or start a new session. Applying a pending preparation releases its output buffer.",
        );
      const id = preparationIdSchema.parse(randomUUID());
      entries.set(id, {
        kind: "ready",
        plan,
        size,
        expires: Date.now() + limits.editPreparationTtlMs,
      });
      bytes += size;
      return id;
    },
    published(id: PreparationId, receipt: Receipt): void {
      const entry = entries.get(id);
      if (closed || entry === undefined) return;
      const size = Buffer.byteLength(JSON.stringify(receipt));
      bytes += size - entry.size;
      entries.set(id, {
        kind: "published",
        receipt,
        size,
        expires: entry.expires,
      });
    },
    clear(): void {
      closed = true;
      entries.clear();
      bytes = 0;
    },
  };
}
