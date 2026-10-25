import { contentFingerprint, json, readOnly } from "@sezzlee/file-core";
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
  readSourceSnapshot,
  type WorkbookOutput,
} from "../platform/versions.js";
import { assertReadableFormat, type WorkbookRoot } from "../platform/paths.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { prepareWorkbookVersion } from "../format/version.js";
import { authoringLimits, newSheetSchema } from "../authoring/workbook.js";
import {
  createAuthoredWorkbook,
  editAuthoredWorkbook,
  serializeAuthoredWorkbook,
  type AuthoredWorkbook,
} from "../format/authoring.js";
import {
  transferSelectionSchema,
  transferReferenceSchema,
  transferTargetSchema,
  transferReceiptSchema,
} from "./transfer-schemas.js";
import { materializeTransfer, transferChanges } from "./transfer.js";
import { PreservedWorkbook } from "../format/preserved-workbook.js";
import { applyWorkbookChanges } from "../format/edit-workbook.js";
import { inspectWorkbookEdit } from "../format/edit-inspection.js";
import {
  prepareEditSchema,
  editPreparationSchema,
  editWireChangesSchema,
  type EditWireChange,
} from "./edit-schemas.js";
import { limits } from "../platform/limits.js";

export const writingToolDefinitions = {
  prepare_edit: {
    description:
      "Inspect an ordered edit request without publishing an output. Accept .xlsx filePath, optional expectedVersion, and changes. Returns exact source {filePath, versionId}, a fingerprint binding normalized changes, source feature counts, and ready or blocked with policy reasons. Pass source and the same changes to edit_workbook. Canonical and preservation-supported external workbooks can be ready. Supports write_cells, clear_contents, add/rename/reorder/copy/delete_sheet, copy_range, move_range and row/column insert/delete. Copy requires explicit values/formulas/formatting/all mode. No source file is changed. Enabled protection, macros, signatures, Strict markup or unsupported affected dependencies refuse editing. Preparation is not permission to edit changed bytes. No recalculation occurs.",
    inputSchema: prepareEditSchema,
    annotations: readOnly,
  },
  prepare_transfer: {
    description:
      'Prepare a complete version-pinned value selection from an .xlsx, .xlsm or CSV without returning its cells. selection must be a JSON object, never a JSON-encoded string: for example {"kind":"range","sheetName":"Sheet1","range":"A1:C5","headerRow":0}. Returns transfer {source, selection} and exact scope/counts; pass transfer unchanged to transfer_data. range preserves its rectangle; records filters complete data rows and can project/reorder selectColumns, includeHeaders or select explicit physical rows with scope {kind: rows, rows: [...]}. Default scope all includes every matching record even if a previous read showed only a preview. Set headerRow: 0 explicitly when there is no header row, so the first record is retained. Record filters use where as an array of {column, op, value}, for example [{column: Amount, op: gte, value: 100}]. For boolean equality use op: eq and a boolean true/false value; filter and equals are not argument names. scope rows contains one-based physical rows, not zero-based indexes. aggregate uses metrics such as [{fn: count}]; omit groupBy for one total and use where for record conditions. aggregate exports a complete grouped summary with headers. Columns are interpreted only when explicit columns specifications request it. Values only: formulas contribute saved results, never recalculated; missing formula caches and unsupported/lossy values fail. No formula/style copying. Available only in explicit writing mode. The source is unchanged.',
    inputSchema: z.strictObject({
      filePath: z.string().min(1).max(32_768),
      selection: transferSelectionSchema,
    }),
    annotations: readOnly,
  },
  transfer_data: {
    description:
      "transfer and target must be JSON objects, never JSON-encoded strings; preserve the nested source and selection objects in the returned transfer reference. Transfer the complete version-pinned value selection from prepare_transfer into a new immutable .xlsx or an existing selected .xlsx target, preserving supported unrelated package content. target new creates a workbook; add_sheet or sheet requires source {filePath,versionId}. sheet uses startCell and optional mapping {kind:headers,headerRow}; choose includeHeaders false when appending. Occupied targets require overwrite true; blank source cells then clear contents. All matching records are transferred, not just an earlier preview. Source and target version changes, unsupported values or preservation failures stop the whole operation. Values only; use explicit edit copy operations for existing formulas and formatting. Nothing is recalculated. Returns provenance/counts, not cell data.",
    inputSchema: z.strictObject({
      transfer: transferReferenceSchema,
      target: transferTargetSchema,
    }),
    annotations: ownOutput,
  },
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
      "Apply an ordered atomic changes list to an exact selected .xlsx source {filePath, versionId}, producing one immutable output. Obtain source from prepare_edit or a prior receipt. write_cells uses explicit typed values and requires overwrite true for occupied targets; clear_contents clears a closed A1 range without shifting or removing styles. add_sheet uses name; rename_sheet uses sheetName/name; reorder_sheet uses one-based position; delete_sheet retains at least one visible sheet; copy_sheet requires name and mode. copy_sheet/copy_range optionally accept from {filePath, versionId} for another workbook; source styles/theme and numeric calendar systems must match, and unsupported external bindings fail. copy_range/move_range use sheetName, range, targetSheet and startCell; copy requires mode values/formulas/formatting/all, and occupied targets require overwrite true. insert_rows/delete_rows/insert_columns/delete_columns use sheetName, at and count. Existing formulas, styles and supported dependent references are preserved or transformed; no new formulas are authored and nothing is calculated. Unsupported impacted references/groups/extensions fail the whole request. Retry identical source and changes for identical output. Select an earlier retained source version to undo or branch. Source and prior outputs remain unchanged.",
    inputSchema: z.strictObject({
      source: workbookVersionSchema,
      changes: editWireChangesSchema,
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
  function checkSelection(input: unknown): void {
    if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024)
      throw new SezzleeExcelError(
        "resource_limit",
        "The transfer selection exceeds its 64 KiB descriptor budget.",
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
  async function copySources(changes: readonly EditWireChange[]) {
    const snapshots: Awaited<ReturnType<typeof readWorkbookSnapshot>>[] = [];
    const buffers = new Map<number, Buffer>();
    let bytes = 0;
    for (const [index, change] of changes.entries()) {
      if (
        (change.kind !== "copy_range" && change.kind !== "copy_sheet") ||
        !("from" in change) ||
        change.from === undefined
      )
        continue;
      const selected = workbookVersionSchema.parse(change.from);
      const snapshot = await readWorkbookSnapshot(
        root,
        selected.filePath,
        selected.versionId,
      );
      assertReadableFormat(snapshot.bytes, snapshot.version.filePath);
      const existing = snapshots.find(
        (prior) =>
          prior.version.filePath === snapshot.version.filePath &&
          prior.version.versionId === snapshot.version.versionId,
      );
      if (existing !== undefined) {
        buffers.set(index, existing.bytes);
        continue;
      }
      bytes += snapshot.bytes.length;
      if (bytes > limits.maxFileBytes)
        throw new SezzleeExcelError(
          "resource_limit",
          "Copy source snapshots exceed the combined byte budget.",
        );
      snapshots.push(snapshot);
      buffers.set(index, snapshot.bytes);
    }
    return { snapshots, buffers };
  }
  return {
    prepare_edit: guardWriting<typeof writingToolDefinitions, "prepare_edit">(
      root,
      "prepare_edit",
      (args, _name, signal) =>
        admitted(async () => {
          checkInput(args);
          await checkpoint(signal);
          const snapshot = await readWorkbookSnapshot(
            root,
            args.filePath,
            args.expectedVersion,
          );
          assertReadableFormat(snapshot.bytes, snapshot.version.filePath);
          const inspection = inspectWorkbookEdit(snapshot.bytes, args.changes);
          const copies =
            inspection.blockers.length === 0
              ? await copySources(args.changes)
              : { snapshots: [], buffers: new Map<number, Buffer>() };
          const prepared =
            inspection.blockers.length === 0
              ? applyWorkbookChanges(
                  snapshot.bytes,
                  args.changes,
                  copies.buffers,
                )
              : undefined;
          await checkpoint(signal);
          await readWorkbookSnapshot(
            root,
            snapshot.version.filePath,
            snapshot.version.versionId,
          );
          for (const source of copies.snapshots)
            await readWorkbookSnapshot(
              root,
              source.version.filePath,
              source.version.versionId,
            );
          await checkpoint(signal);
          const common = {
            source: snapshot.version,
            requestFingerprint: contentFingerprint(
              snapshot.version.filePath,
              snapshot.bytes,
              JSON.stringify(args.changes),
            ),
            operations: args.changes.length,
            cellsRequested: inspection.cellsRequested,
            features: inspection.features,
            recalculated: false,
          };
          return json(
            editPreparationSchema.parse(
              inspection.blockers.length === 0
                ? {
                    kind: "ready",
                    ...common,
                    profile:
                      prepared?.editing === undefined
                        ? "canonical_values"
                        : "preserved_package",
                  }
                : { kind: "blocked", ...common, blockers: inspection.blockers },
            ),
          );
        }),
    ),
    prepare_transfer: guardWriting<
      typeof writingToolDefinitions,
      "prepare_transfer"
    >(root, "prepare_transfer", (args, _name, signal) =>
      admitted(async () => {
        checkSelection(args);
        await checkpoint(signal);
        const snapshot = await readSourceSnapshot(root, args.filePath);
        const data = await materializeTransfer(snapshot, args.selection);
        await checkpoint(signal);
        return json({
          kind: "ready",
          transfer: { source: snapshot.version, selection: args.selection },
          selection: data.summary,
        });
      }),
    ),
    transfer_data: guardWriting<typeof writingToolDefinitions, "transfer_data">(
      root,
      "transfer_data",
      (args, _name, signal) =>
        admitted(async () => {
          checkSelection(args);
          await checkpoint(signal);
          const snapshot = await readSourceSnapshot(
            root,
            args.transfer.source.filePath,
            args.transfer.source.versionId,
          );
          const data = await materializeTransfer(
            snapshot,
            args.transfer.selection,
          );
          const target = args.target;
          const selectedTarget =
            target.kind === "new"
              ? undefined
              : await readWorkbookSnapshot(
                  root,
                  target.source.filePath,
                  target.source.versionId,
                );
          let workbook: AuthoredWorkbook;
          let sheetsAdded = 0;
          if (selectedTarget === undefined) {
            const created = createAuthoredWorkbook([
              { name: target.sheetName, blocks: [] },
            ]);
            workbook = created.workbook;
            sheetsAdded = created.changes.sheetsAdded;
          } else {
            workbook = new PreservedWorkbook(
              selectedTarget.bytes,
            ).transferShape(
              target.kind === "sheet" ? target.sheetName : undefined,
              target.kind === "sheet" && target.mapping.kind === "headers"
                ? target.mapping.headerRow
                : undefined,
            );
          }
          const planned = transferChanges(workbook, data, target);
          const applied =
            selectedTarget === undefined
              ? undefined
              : applyWorkbookChanges(selectedTarget.bytes, planned);
          const changes =
            applied?.changes ?? editAuthoredWorkbook(workbook, planned);
          changes.sheetsAdded += sheetsAdded;
          const bytes = applied?.bytes ?? serializeAuthoredWorkbook(workbook);
          await checkpoint(signal);
          await readSourceSnapshot(
            root,
            snapshot.version.filePath,
            snapshot.version.versionId,
          );
          if (selectedTarget !== undefined)
            await readWorkbookSnapshot(
              root,
              selectedTarget.version.filePath,
              selectedTarget.version.versionId,
            );
          await checkpoint(signal);
          const receipt = await output.publish(
            bytes,
            selectedTarget === undefined
              ? { kind: "new" }
              : { kind: "source", version: selectedTarget.version },
          );
          return json(
            transferReceiptSchema.parse({
              ...receipt,
              changes,
              ...(applied?.editing === undefined
                ? {}
                : { editing: applied.editing }),
              transferSource: snapshot.version,
              transfer: data.summary,
            }),
          );
        }),
    ),
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
          const copies = await copySources(args.changes);
          const applied = applyWorkbookChanges(
            snapshot.bytes,
            args.changes,
            copies.buffers,
          );
          const { changes, bytes } = applied;
          await checkpoint(signal);
          await readWorkbookSnapshot(
            root,
            snapshot.version.filePath,
            snapshot.version.versionId,
          );
          for (const source of copies.snapshots)
            await readWorkbookSnapshot(
              root,
              source.version.filePath,
              source.version.versionId,
            );
          await checkpoint(signal);
          const receipt = await output.publish(bytes, {
            kind: "source",
            version: snapshot.version,
          });
          return json(
            mutationReceiptSchema.parse({
              ...receipt,
              changes,
              ...(applied.editing === undefined
                ? {}
                : { editing: applied.editing }),
            }),
          );
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
