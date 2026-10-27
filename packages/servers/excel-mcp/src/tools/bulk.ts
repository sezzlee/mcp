import { contentFingerprint } from "@sezzlee/file-core";
import { bulkLimits } from "../authoring/bulk.js";
import { authoringLimits } from "../authoring/workbook.js";
import type { WriteCell } from "../authoring/values.js";
import {
  canonicalWriteValue as canonicalValue,
  sameWriteValue as sameValue,
} from "../authoring/bulk-key.js";
import { inspectWorkbookEdit } from "../format/edit-inspection.js";
import { assertReadableFormat, type WorkbookRoot } from "../platform/paths.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { formats } from "../platform/formats.js";
import {
  readSourceSnapshot,
  readWorkbookSnapshot,
} from "../platform/versions.js";
import { materializeTransfer, type TransferData } from "./transfer.js";
import {
  bulkPreparationSchema,
  type BulkConflict,
  type BulkKeyAnalysis,
  type BulkPreparation,
  type PrepareBulk,
} from "./bulk-schemas.js";

function budget(message: string): never {
  throw new SezzleeExcelError("resource_limit", message);
}

function analyzeKeys(
  source: TransferData,
  target: TransferData,
  operation: PrepareBulk["operation"],
): BulkKeyAnalysis {
  const conflicts: BulkConflict[] = [];
  let conflictCount = 0;
  function conflict(value: BulkConflict): void {
    conflictCount += 1;
    if (conflicts.length < bulkLimits.maxConflictExamples)
      conflicts.push(value);
  }
  function blocked(): BulkKeyAnalysis {
    return {
      kind: "blocked",
      conflictCount,
      conflicts,
      conflictsTruncated: conflictCount > conflicts.length,
    };
  }
  function headers(data: TransferData, side: "source" | "target") {
    const index = new Map<string, number>();
    for (const [offset, header] of data.headers.entries()) {
      if (header === null || header === "") {
        conflict({ kind: "missing_header", side, column: offset + 1 });
        continue;
      }
      const prior = index.get(header);
      if (prior !== undefined)
        conflict({
          kind: "duplicate_header",
          side,
          column: offset + 1,
          firstColumn: prior + 1,
        });
      else index.set(header, offset);
    }
    return index;
  }
  const sourceHeaders = headers(source, "source");
  const targetHeaders = headers(target, "target");
  function mappings(field: "keys" | "set") {
    const pairs: { source: number; target: number }[] = [];
    for (const [mappingIndex, item] of operation[field].entries()) {
      const left = sourceHeaders.get(item.sourceColumn);
      const right = targetHeaders.get(item.targetColumn);
      if (left === undefined)
        conflict({
          kind: "unknown_column",
          side: "source",
          mapping: field,
          mappingIndex,
        });
      if (right === undefined)
        conflict({
          kind: "unknown_column",
          side: "target",
          mapping: field,
          mappingIndex,
        });
      if (left !== undefined && right !== undefined)
        pairs.push({ source: left, target: right });
    }
    return pairs;
  }
  const keys = mappings("keys");
  const assignments = mappings("set");
  if (conflictCount > 0) return blocked();
  let keyBytes = 0;
  function indexRecords(data: TransferData, side: "source" | "target") {
    const index = new Map<string, number>();
    for (const [offset, row] of data.values.entries()) {
      const components: [
        WriteCell["kind"],
        string | number | boolean | null,
      ][] = [];
      let missing = false;
      for (const pair of keys) {
        const cell = row[pair[side]];
        if (cell === undefined)
          throw new SezzleeExcelError(
            "invalid_argument",
            "A selected record is not rectangular.",
          );
        if (
          cell.kind === "blank" ||
          (cell.kind === "text" && cell.value === "")
        ) {
          missing = true;
          break;
        }
        components.push([cell.kind, canonicalValue(cell)]);
      }
      if (missing) {
        conflict({ kind: "missing_key", side, record: offset + 1 });
        continue;
      }
      const key = JSON.stringify(components);
      keyBytes += Buffer.byteLength(key);
      if (keyBytes > bulkLimits.maxKeyBytes)
        budget("Bulk key indexes exceed their combined byte budget.");
      const prior = index.get(key);
      if (prior !== undefined)
        conflict({
          kind: "duplicate_key",
          side,
          record: offset + 1,
          firstRecord: prior + 1,
        });
      else index.set(key, offset);
    }
    return index;
  }
  const sourceIndex = indexRecords(source, "source");
  const targetIndex = indexRecords(target, "target");
  if (conflictCount > 0) return blocked();
  let matchedRecords = 0;
  let wouldUpdateRecords = 0;
  let unchangedRecords = 0;
  let overwriteRecords = 0;
  for (const [key, sourceOffset] of sourceIndex) {
    const targetOffset = targetIndex.get(key);
    if (targetOffset === undefined) continue;
    matchedRecords += 1;
    let changed = false;
    let occupied = false;
    for (const pair of assignments) {
      const left = source.values[sourceOffset]?.[pair.source];
      const right = target.values[targetOffset]?.[pair.target];
      if (left === undefined || right === undefined)
        throw new SezzleeExcelError(
          "invalid_argument",
          "A selected record is not rectangular.",
        );
      if (sameValue(left, right)) continue;
      changed = true;
      if (right.kind !== "blank") occupied = true;
    }
    if (changed) wouldUpdateRecords += 1;
    else unchangedRecords += 1;
    if (occupied && !operation.overwrite) {
      overwriteRecords += 1;
      conflict({ kind: "overwrite_required", record: targetOffset + 1 });
    }
  }
  const sourceUnmatchedRecords = sourceIndex.size - matchedRecords;
  if (operation.kind === "upsert" && sourceUnmatchedRecords > 0) {
    const mapped = new Set(
      [...keys, ...assignments].map((pair) => pair.target),
    );
    if (mapped.size !== target.headers.length)
      conflict({
        kind: "incomplete_insert_mapping",
        columns: target.headers.length - mapped.size,
      });
  }
  if (overwriteRecords > 0 || conflictCount > 0) return blocked();
  return {
    kind: "ready",
    matchedRecords,
    sourceUnmatchedRecords,
    targetUnmatchedRecords: targetIndex.size - matchedRecords,
    wouldUpdateRecords,
    unchangedRecords,
    wouldInsertRecords:
      operation.kind === "upsert" ? sourceUnmatchedRecords : 0,
  };
}

function checkData(
  data: TransferData,
  used: { cells: number; text: number },
): void {
  if (data.values.length > bulkLimits.maxRecordsPerInput)
    budget("Bulk preparation exceeds 100,000 records per input.");
  used.cells += data.summary.cells;
  if (used.cells > bulkLimits.maxCells)
    budget("Bulk preparation exceeds its combined cell budget.");
  for (const row of data.values)
    for (const cell of row)
      if (cell.kind === "text") used.text += Buffer.byteLength(cell.value);
  if (used.text > bulkLimits.maxTextBytes)
    budget("Bulk preparation exceeds its combined text byte budget.");
}

export async function prepareBulk(
  root: WorkbookRoot,
  args: PrepareBulk,
  checkpoint: () => Promise<void>,
): Promise<BulkPreparation> {
  if (Buffer.byteLength(JSON.stringify(args)) > bulkLimits.maxDescriptorBytes)
    budget("The bulk descriptor exceeds 64 KiB.");
  await checkpoint();
  const source = await readSourceSnapshot(
    root,
    args.source.filePath,
    args.source.versionId,
  );
  if (formats.formatFor(source.version.filePath) !== "csv")
    assertReadableFormat(source.bytes, source.version.filePath);
  const target = await readWorkbookSnapshot(
    root,
    args.target.filePath,
    args.target.versionId,
  );
  assertReadableFormat(target.bytes, target.version.filePath);
  if (source.bytes.length + target.bytes.length > authoringLimits.maxInputBytes)
    budget("Bulk snapshots exceed their combined input byte budget.");
  await checkpoint();
  const common = {
    validation: "keys_and_target_policy" as const,
    executionAvailable: false as const,
    source: source.version,
    target: target.version,
    requestFingerprint: contentFingerprint(
      source.version.filePath,
      source.bytes,
      JSON.stringify({
        source: { ...source.version, selection: args.source.selection },
        target: { ...target.version, selection: args.target.selection },
        operation: args.operation,
      }),
    ),
    recalculated: false as const,
  };
  async function finish(result: unknown): Promise<BulkPreparation> {
    await checkpoint();
    await readSourceSnapshot(
      root,
      source.version.filePath,
      source.version.versionId,
    );
    await readWorkbookSnapshot(
      root,
      target.version.filePath,
      target.version.versionId,
    );
    await checkpoint();
    return bulkPreparationSchema.parse(result);
  }
  const policy = inspectWorkbookEdit(target.bytes, []);
  if (policy.blockers.length > 0)
    return finish({
      kind: "blocked",
      ...common,
      failure: { kind: "target_policy", blockers: policy.blockers },
    });
  const used = { cells: 0, text: 0 };
  const sourceData = await materializeTransfer(source, args.source.selection, {
    maxRows: bulkLimits.maxRecordsPerInput,
    maxCells: bulkLimits.maxCells,
    maxTextBytes: bulkLimits.maxTextBytes,
  });
  checkData(sourceData, used);
  await checkpoint();
  const targetData = await materializeTransfer(target, args.target.selection, {
    maxRows: bulkLimits.maxRecordsPerInput,
    maxCells: bulkLimits.maxCells - used.cells,
    maxTextBytes: bulkLimits.maxTextBytes - used.text,
  });
  checkData(targetData, used);
  await checkpoint();
  const selections = {
    sourceSelection: sourceData.summary,
    targetSelection: targetData.summary,
  };
  const analysis = analyzeKeys(sourceData, targetData, args.operation);
  return finish(
    analysis.kind === "ready"
      ? { kind: "ready", ...common, ...selections, analysis }
      : {
          kind: "blocked",
          ...common,
          failure: { kind: "record_conflicts", ...selections, analysis },
        },
  );
}
