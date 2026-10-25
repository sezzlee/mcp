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
  type WorkbookOutput,
} from "../platform/versions.js";
import type { WorkbookRoot } from "../platform/paths.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { prepareWorkbookVersion } from "../format/version.js";

export const writingToolDefinitions = {
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
  return {
    create_workbook_version: guardWriting<
      typeof writingToolDefinitions,
      "create_workbook_version"
    >(root, "create_workbook_version", async (args, _name, signal) => {
      if (active)
        throw new SezzleeExcelError(
          "resource_limit",
          "A version is already being prepared by this server.",
          "Retry after the current preparation completes.",
        );
      active = true;
      try {
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
      } finally {
        active = false;
      }
    }),
  };
}
