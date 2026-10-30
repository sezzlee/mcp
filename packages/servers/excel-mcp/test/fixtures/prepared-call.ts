import type { Client } from "@modelcontextprotocol/client";
import { z } from "zod";

const sourceSchema = z.object({
  filePath: z.unknown(),
  versionId: z.unknown(),
});
const readySchema = z.object({
  kind: z.literal("ready"),
  preparationId: z.string(),
});

/** Executes existing editing fixtures through the two public preparation/application calls. */
export async function preparedCall(
  client: Client,
  request: Parameters<Client["callTool"]>[0],
) {
  if (
    request.name !== "edit_workbook" ||
    request.arguments?.["preparationId"] !== undefined
  )
    return client.callTool(request);
  const source = sourceSchema.parse(request.arguments?.["source"]);
  const prepared = await client.callTool({
    name: "prepare_edit",
    arguments: {
      filePath: source.filePath,
      expectedVersion: source.versionId,
      changes: request.arguments?.["changes"],
    },
  });
  if (prepared.isError) return prepared;
  const text = prepared.content.find((item) => item.type === "text");
  const ready = readySchema.safeParse(
    text?.type === "text" ? JSON.parse(text.text) : null,
  );
  if (!ready.success) return prepared;
  return client.callTool({
    name: "edit_workbook",
    arguments: { preparationId: ready.data.preparationId },
  });
}
