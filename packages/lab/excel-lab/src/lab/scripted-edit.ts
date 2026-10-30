import { z } from "zod";
import type { ToolOutcome } from "./session.ts";

const sourceSchema = z.object({ filePath: z.string(), versionId: z.string() });
const readySchema = z.object({
  kind: z.literal("ready"),
  preparationId: z.string(),
});

/** Expands a scripted fixture's edit descriptor into the two public calls; model calls stay strict. */
export async function scriptedEdit(
  call: (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<ToolOutcome>,
  args: Readonly<Record<string, unknown>>,
): Promise<ToolOutcome> {
  const source = sourceSchema.parse(args["source"]);
  const prepared = await call("prepare_edit", {
    filePath: source.filePath,
    expectedVersion: source.versionId,
    changes: args["changes"],
  });
  if (prepared.isError) return prepared;
  const ready = readySchema.safeParse(prepared.body);
  if (!ready.success) return prepared;
  return call("edit_workbook", { preparationId: ready.data.preparationId });
}
