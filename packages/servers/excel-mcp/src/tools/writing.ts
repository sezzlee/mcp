import { json } from "@sezzlee/file-core";
import { z } from "zod";
import {
  guardWriting,
  ownOutput,
  type HandlersOf,
  type ToolCatalog,
} from "../platform/writing.js";
import {
  workbookVersionIdSchema,
  workbookVersionSchema,
  mutationReceiptSchema,
  readWorkbookSnapshot,
  type WorkbookOutput,
} from "../platform/versions.js";
import type { WorkbookRoot } from "../platform/paths.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { prepareWorkbookVersion } from "../format/version.js";
import {
  authoringLimits,
  newSheetSchema,
  workbookChangeSchema,
} from "../authoring/workbook.js";
import {
  createAuthoredWorkbook,
  editAuthoredWorkbook,
  readAuthoredWorkbook,
  serializeAuthoredWorkbook,
} from "../format/authoring.js";

export const writingToolDefinitions = {
  create_workbook: {
    description:
      "Create a new immutable .xlsx from explicitly named sheets and rectangular value blocks at A1 start cells. Provide every cell's kind: text, number, boolean, blank, date or local datetime. Text is literal; formulas are unsupported. At least one sheet is required; omit its blocks for a blank sheet. Rejects duplicate names and overlapping populated targets. Up to 1,000,000 cells per request/workbook, 64 sheets and 128 blocks, with separate byte budgets. Returns a compact version receipt. Identical requests produce the same output version.",
    inputSchema: z.strictObject({
      sheets: z.array(newSheetSchema).min(1).max(authoringLimits.maxSheets),
    }),
    annotations: ownOutput,
  },
  edit_workbook: {
    description:
      "Apply an ordered atomic change list to a selected Phase 1 output version, producing a new immutable .xlsx. source must carry its relative filePath and exact versionId from the receipt. add_sheet adds a new uniquely named sheet; write_cells writes a rectangular typed block at startCell. Occupied cells, including empty text, are rejected unless overwrite is explicitly true; blank then clears a cell. Select an explicit startCell to append records; rows are never inserted. Extra external workbook features are rejected. Retry the identical request against the same source for the same output; never substitute an implicit latest source. All changes succeed together or no completed output is published.",
    inputSchema: z.strictObject({
      source: workbookVersionSchema,
      changes: z
        .array(workbookChangeSchema)
        .min(1)
        .max(authoringLimits.maxOperations),
    }),
    annotations: ownOutput,
  },
  create_workbook_version: {
    description:
      "Prepare an immutable .xlsx output version from an existing source. The source is unchanged. Returns its content version and relative output path, not its cells. Repeating the same content reuses the output. This prepares a version; it does not create a new workbook or edit cells.",
    inputSchema: z.object({
      filePath: z.string().min(1).max(32_768),
      expectedVersion: workbookVersionIdSchema.optional(),
    }),
    annotations: ownOutput,
  },
} as const satisfies ToolCatalog;

export function createWritingHandlers(
  root: WorkbookRoot,
  output: WorkbookOutput,
): HandlersOf<typeof writingToolDefinitions> {
  /**
   * Guard: a preparation retains file-sized source and output buffers, so
   * admission must be bounded before the first source read allocates them.
   */
  let active = false;
  async function admitted<T>(operation: () => Promise<T>): Promise<T> {
    if (active)
      throw new SezzleeExcelError(
        "resource_limit",
        "A version is already being prepared by this server.",
        "Retry after the current preparation completes.",
      );
    active = true;
    try {
      return await operation();
    } finally {
      active = false;
    }
  }
  function checkInput(input: unknown): void {
    if (
      Buffer.byteLength(JSON.stringify(input)) > authoringLimits.maxInputBytes
    )
      throw new SezzleeExcelError(
        "resource_limit",
        "The request exceeds its input byte budget.",
      );
  }
  async function checkpoint(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (signal?.aborted)
      throw new SezzleeExcelError(
        "invalid_argument",
        "The write request was cancelled before publication.",
      );
  }
  return {
    create_workbook: guardWriting<
      typeof writingToolDefinitions,
      "create_workbook"
    >(root, "create_workbook", (args, _name, signal) =>
      admitted(async () => {
        checkInput(args);
        await checkpoint(signal);
        const { workbook, changes } = createAuthoredWorkbook(args.sheets);
        const bytes = serializeAuthoredWorkbook(workbook);
        await checkpoint(signal);
        const receipt = await output.publish(bytes, { kind: "new" });
        return json(mutationReceiptSchema.parse({ ...receipt, changes }));
      }),
    ),
    edit_workbook: guardWriting<typeof writingToolDefinitions, "edit_workbook">(
      root,
      "edit_workbook",
      (args, _name, signal) =>
        admitted(async () => {
          checkInput(args);
          await checkpoint(signal);
          const snapshot = await readWorkbookSnapshot(
            root,
            args.source.filePath,
            args.source.versionId,
          );
          const workbook = readAuthoredWorkbook(snapshot.bytes);
          const changes = editAuthoredWorkbook(workbook, args.changes);
          const bytes = serializeAuthoredWorkbook(workbook);
          await checkpoint(signal);
          const receipt = await output.publish(bytes, {
            kind: "source",
            version: snapshot.version,
          });
          return json(mutationReceiptSchema.parse({ ...receipt, changes }));
        }),
    ),
    create_workbook_version: guardWriting<
      typeof writingToolDefinitions,
      "create_workbook_version"
    >(root, "create_workbook_version", (args, _name, signal) =>
      admitted(async () => {
        return json(
          await prepareWorkbookVersion({
            root,
            output,
            filePath: args.filePath,
            ...(args.expectedVersion === undefined
              ? {}
              : { expectedVersion: args.expectedVersion }),
            ...(signal === undefined ? {} : { signal }),
          }),
        );
      }),
    ),
  };
}
