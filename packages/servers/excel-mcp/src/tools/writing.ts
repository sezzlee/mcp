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
import { presentationWireChangeSchema } from "../authoring/presentation.js";
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
import { prepareBulkSchema } from "./bulk-schemas.js";
import { prepareBulk } from "./bulk.js";
import {
  bulkJobInputSchema,
  bulkJobStatusInputSchema,
} from "./bulk-job-schemas.js";
import { prepareBulkJob, runBulkJob, getBulkJob } from "./bulk-jobs.js";

const finishAdvice =
  'Optional job.finish is at the job root, never inside group: [{"output":"report","changes":[{"kind":"format_cells","sheetName":"S","range":"C2:C4","style":{"numberFormat":"0.00"}}]}]. For independent jobs each finish entry additionally names job. Changes use edit_workbook authoring kinds and run after data rendering, before the existing atomic publication. Formula changes require formula text and never calculate results. ';
const tableAdvice =
  ' Table ranges include the header and requested totals row. A real calculated column uses calculatedColumns:[{column:"Amount",formula:"[@Qty]*[@Price]"}]; filling cells alone does not define table calculated-column metadata. Bare Qty*Price refers to defined names. Totals labels are explicit, for example totals:[{kind:"label",column:"Item",text:"Total"},{kind:"function",column:"Amount",function:"sum"}]; a sum function does not create a Total label automatically.';

export const writingToolDefinitions = {
  prepare_bulk_job: {
    description:
      finishAdvice +
      'Every step and output uses kind, never op or type. A read step is {kind:read,id:rows,source:{filePath,versionId},selection:{kind:records,sheetName,range,headerRow:1}}; selection is a nested object, never flattened onto the step. update.set is [{column:Flag,value:{kind:boolean,value:true}}], never a bare scalar or a {type:...} cell. CSV fields stay text unless selection.columns explicitly requests reading, e.g. [{column:Total,type:number,decimal:"."}]. keys is an array of {sourceColumn,targetColumn}. A join uses join:left and columns:[{side:left,column:Ticket,as:Ticket}], never joinType or from. For editing an existing workbook choose output kind edit; kind new creates a data-only report and does not preserve unrelated source package parts. Dry-run a complete dependent group or independent batch without writing files. job kind dependent has group {steps,outputs}; independent has jobs [{id,group}]. Steps have unique IDs and reference only earlier IDs. read pins source {filePath,versionId} and a complete records selection with positive headerRow and closed range or table. Conditions use where:[{column:State,op:eq,value:open}], an array of {column,op,value}, never a single object or a string. update.set uses typed cells, for example [{column:Total,value:{kind:number,value:99}}]. Set edit output overwrite:true when replacing occupied values. Operators: update/remove/filter with these where conditions; keyed_update/upsert with source/target step IDs, keys/set column mappings and explicit duplicates/missingKeys policies; replace uses {kind:replace,id:next,input:old,source:fresh}, where old and fresh are dataset IDs; append uses inputs, an array of dataset IDs; join inner/left/full with explicit output column mappings and bounded manyToMany; deduplicate with keep policy; stable sort with directions, blanks and mixedTypes; project; transform constants/trim/locale case/explicit typed conversions. Output new uses sheets [{name,input}]; edit uses target read ID, input dataset ID, mode changed_values or replace_values and overwrite; edit_workbook combines distinct-sheet changes from one exact source. changed_values preserves untouched formulas and row identities; sorting/replacement needs explicit replace_values. Physical delete_rows refuses other content in the same rows. Full editor preservation, budgets, expansion and every ordered step/output are checked. Ready is not publication or authorization. No calculation. Writing mode only.',
    inputSchema: bulkJobInputSchema,
    annotations: readOnly,
  },
  run_bulk_job: {
    description:
      finishAdvice +
      "Execute the same job descriptor used by prepare_bulk_job. All dependent outputs are fully validated in memory, then their files and completion manifest are atomically published as one immutable job directory. Original files and earlier versions never change. Independent jobs commit separately and report complete/partial/failed/pending with per-job status; retry the same descriptor to reuse completed jobs and attempt only unfinished ones. Exact source versions and normalized operations identify each group. A retained result is verified and returned before source rereads, allowing recovery after a lost response or process restart even if an original later changed. Stale sources before first commit refuse. Outputs have exact readable .xlsx versions. Dependent failure publishes no completed group. No formula calculation; explicit value pipelines report saved-cache use. Use get_bulk_job with returned jobId for durable status. Read the prepare_bulk_job description for step/output syntax.",
    inputSchema: bulkJobInputSchema,
    annotations: ownOutput,
  },
  get_bulk_job: {
    description:
      "Read durable bulk completion by jobId without rerunning operations. Verifies the retained manifest and every completed output hash. Returns a complete dependent result, independent batch statuses, or not_found. Missing/changed retained output bytes are an error rather than a successful replay. Writing mode only; no source writes or recalculation.",
    inputSchema: bulkJobStatusInputSchema,
    annotations: readOnly,
  },
  prepare_bulk: {
    description:
      "Analyze complete version-pinned record selections for keyed_update or upsert without writing files. source and target contain filePath, versionId and selection {kind:records, sheetName, range or table, headerRow}; obtain versions from prepare_transfer or prior receipts. Select exactly one closed A1 range or named table, with an explicit positive headerRow. Target is an unfiltered complete .xlsx list; source can be .xlsx, .xlsm or CSV and use record filters/projection. operation has kind, keys and set arrays of {sourceColumn,targetColumn} using exact selected header names. Keys preserve types and case; no implicit trim/coercion. Empty or duplicate keys block; conflictPolicy currently only error. Key columns cannot be reassigned. Set overwrite:true to replace occupied target values. Upsert requires mapping every target column when inserting. Returns bounded counts/conflicts, exact versions and requestFingerprint, never records. Conflict record numbers are one-based positions in the selected records, not worksheet rows. Validation covers keys and target package policy only; executionAvailable:false describes this focused analysis. Use prepare_bulk_job/run_bulk_job for fully validated execution. Preparation never means a completed update or grants permission for changed sources. Writing mode only; no recalculation.",
    inputSchema: prepareBulkSchema,
    annotations: readOnly,
  },
  prepare_edit: {
    description:
      "Inspect an ordered edit request without publishing an output. Accept .xlsx filePath, optional expectedVersion, and changes. Returns exact source {filePath, versionId}, a fingerprint binding normalized changes, source feature counts, and ready or blocked with policy reasons. Pass source and the same changes to edit_workbook. Canonical and preservation-supported external workbooks can be ready. Supports scalar, sheet, copy/move and row/column edits, plus edit_workbook formatting/layout/formula/table authoring. Copy requires explicit values/formulas/formatting/all mode. No source file is changed. Enabled protection, macros, signatures, Strict markup or unsupported affected dependencies refuse editing. Preparation is not permission to edit changed bytes. No recalculation occurs." +
      tableAdvice,
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
      "Create one immutable .xlsx from named sheets and rectangular typed value blocks. Each scalar has kind text/number/boolean/blank/date/datetime; text beginning with = stays literal. Optional changes finish the workbook atomically with formatting, layout, merges, formulas and tables before publication. Formula operations write explicit formula text without calculating it. Table range includes its header and optional totals row; use literal unique headers. At least one sheet, up to 1,000,000 touched/stored cells, 64 sheets and 128 changes. Identical requests retain identical outputs; originals never change." +
      tableAdvice,
    inputSchema: z.strictObject({
      sheets: z.array(newSheetSchema).min(1).max(authoringLimits.maxSheets),
      changes: z
        .array(presentationWireChangeSchema)
        .max(authoringLimits.maxOperations)
        .default([]),
    }),
    annotations: ownOutput,
  },
  edit_workbook: {
    description:
      "Apply ordered atomic changes to source {filePath,versionId}; originals/retained outputs never change. write_cells uses typed literal values; occupied data/formula targets require overwrite:true. clear_contents preserves styles. copy_range/move_range use range,targetSheet,startCell; copy requires mode values/formulas/formatting/all. copy_sheet uses name/mode; copy operations optionally accept from {filePath,versionId}, subject to dependency/style compatibility. Sheet rename/reorder/delete and row/column insert/delete preserve supported references or refuse. format_cells patches only specified style fields; null resets a component. set_columns/set_rows use one-based first/last, width in character units/height in points, hidden; freeze_panes uses row/column counts. set_print_layout margins are inches; choose scale or fitWidth/fitHeight. merge_cells defaults to loss:reject; loss:discard_non_anchor explicitly clears other contents; unmerge_cells retains only the anchor. write_formula uses cell/formula; fill_formula uses anchor/range/formula and relative A1/table references. New formulas have no calculated cache; report recalculation required. create_table range includes header/data/optional totals; headers are unique literal text. edit_table can rename name/columns, resize range, set calculatedColumns/totals/style/filter; shrink preserves excluded values unless clearRemovedValues:true. convert_table preserves supported references/appearance or refuses. Table style is SezzleeBlue or none; filter toggles dropdowns, not dataset filtering. Dynamic arrays/external formula links and unsupported affected preservation refuse the whole request. Use prepare_edit first for scope/effects. Retry the same source/changes for the same result; select an earlier source to undo/branch." +
      tableAdvice,
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
    prepare_bulk_job: guardWriting<
      typeof writingToolDefinitions,
      "prepare_bulk_job"
    >(root, "prepare_bulk_job", (args, _name, signal) =>
      admitted(async () =>
        json(
          await prepareBulkJob(root, output, args.job, () =>
            checkpoint(signal),
          ),
        ),
      ),
    ),
    run_bulk_job: guardWriting<typeof writingToolDefinitions, "run_bulk_job">(
      root,
      "run_bulk_job",
      (args, _name, signal) =>
        admitted(async () =>
          json(
            await runBulkJob(root, output, args.job, () => checkpoint(signal)),
          ),
        ),
    ),
    get_bulk_job: guardWriting<typeof writingToolDefinitions, "get_bulk_job">(
      root,
      "get_bulk_job",
      (args) =>
        admitted(async () => json(await getBulkJob(root, output, args.jobId))),
    ),
    prepare_bulk: guardWriting<typeof writingToolDefinitions, "prepare_bulk">(
      root,
      "prepare_bulk",
      (args, _name, signal) =>
        admitted(async () =>
          json(await prepareBulk(root, args, () => checkpoint(signal))),
        ),
    ),
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
            ...(prepared?.editing === undefined
              ? {}
              : { effects: prepared.editing }),
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
        const initial = serializeAuthoredWorkbook(workbook);
        const applied =
          args.changes.length === 0
            ? undefined
            : applyWorkbookChanges(initial, args.changes);
        const bytes = applied?.bytes ?? initial;
        await checkpoint(signal);
        const receipt = await output.publish(bytes, { kind: "new" });
        return json(
          mutationReceiptSchema.parse({
            ...receipt,
            changes: {
              sheetsAdded: changes.sheetsAdded,
              blocksWritten:
                changes.blocksWritten + (applied?.changes.blocksWritten ?? 0),
              cellsWritten:
                changes.cellsWritten + (applied?.changes.cellsWritten ?? 0),
            },
            ...(applied?.editing === undefined
              ? {}
              : { editing: applied.editing }),
          }),
        );
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
