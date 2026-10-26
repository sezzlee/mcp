import { createHash } from "node:crypto";
import { redactRoot } from "@sezzlee/file-core";
import { inspectWorkbookEdit } from "../format/edit-inspection.js";
import { formats } from "../platform/formats.js";
import { assertReadableFormat, type WorkbookRoot } from "../platform/paths.js";
import { asExcelError, SezzleeExcelError } from "../platform/errors.js";
import {
  readSourceSnapshot,
  workbookVersionIdSchema,
  type WorkbookOutput,
  type WorkbookSnapshot,
} from "../platform/versions.js";
import { materializeTransfer } from "./transfer.js";
import {
  applyBulkDatasetStep,
  BulkDatasetBudget,
  bulkBudget,
  bulkInvalid,
  type BulkDataset,
} from "./bulk-dataset.js";
import {
  renderBulkOutput,
  type BulkReadBinding,
  type BulkRenderedOutput,
} from "./bulk-output.js";
import {
  bulkGroupReceiptSchema,
  bulkBatchReceiptSchema,
  bulkStoredManifestSchema,
  bulkJobLimits,
  type BulkGroup,
  type BulkJob,
  type BulkGroupReceipt,
  type BulkBatchReceipt,
  type BulkFailure,
  type BulkStepReceipt,
} from "./bulk-job-schemas.js";

type JobId = ReturnType<typeof workbookVersionIdSchema.parse>;
export function bulkIdentity(value: BulkGroup | BulkJob): JobId {
  return workbookVersionIdSchema.parse(
    createHash("sha256")
      .update("sezzlee-bulk-job-v1\0")
      .update(JSON.stringify(value))
      .digest("hex"),
  );
}
function checksum(bytes: Buffer): JobId {
  return workbookVersionIdSchema.parse(
    createHash("sha256").update(bytes).digest("hex"),
  );
}
function jobStore(output: WorkbookOutput) {
  if (output.jobs === undefined)
    throw new SezzleeExcelError(
      "unsupported_platform",
      "This output capability does not support atomic job publication.",
    );
  return output.jobs;
}
function failureOf(root: WorkbookRoot, error: unknown): BulkFailure {
  const failure = asExcelError(error);
  return {
    error: failure.code,
    message: redactRoot(failure.message, root.real).slice(0, 1024),
    observation: "current_attempt",
    diagnosticRetained: false,
  };
}
async function retainedGroup(
  output: WorkbookOutput,
  id: JobId,
): Promise<BulkGroupReceipt | undefined> {
  const store = jobStore(output),
    bytes = await store.read(`job-${id}`, "manifest.json");
  if (bytes === undefined) return undefined;
  const manifest = bulkStoredManifestSchema.parse(
    JSON.parse(bytes.toString("utf8")),
  );
  if (
    manifest.kind !== "group" ||
    manifest.result.jobId !== id ||
    bulkIdentity(manifest.request) !== id
  )
    bulkInvalid("The retained job manifest has inconsistent identity.");
  if (
    manifest.result.outputs.length !== manifest.request.outputs.length ||
    manifest.result.steps.length !== manifest.request.steps.length ||
    manifest.result.outputs.some(
      (item, index) => item.id !== manifest.request.outputs[index]?.id,
    ) ||
    manifest.result.steps.some(
      (item, index) =>
        item.id !== manifest.request.steps[index]?.id ||
        item.kind !== manifest.request.steps[index]?.kind,
    )
  )
    throw new SezzleeExcelError(
      "file_changed",
      "The retained completion inventory does not match its request.",
    );
  for (const item of manifest.result.outputs) {
    const name = `${item.version.versionId}.xlsx`;
    if (item.version.filePath !== `${output.directory}/job-${id}/${name}`)
      bulkInvalid("A retained output has an invalid location.");
    const content = await store.read(`job-${id}`, name);
    if (
      content === undefined ||
      checksum(content) !== item.version.versionId ||
      content.length !== item.sizeBytes
    )
      throw new SezzleeExcelError(
        "file_changed",
        "A retained job output is missing or changed.",
      );
  }
  return manifest.result;
}
async function prepareGroup(
  root: WorkbookRoot,
  group: BulkGroup,
  checkpoint: () => Promise<void>,
) {
  const budget = new BulkDatasetBudget(),
    datasets = new Map<string, BulkDataset>(),
    reads = new Map<string, BulkReadBinding>(),
    snapshots = new Map<string, WorkbookSnapshot>();
  const receipts: BulkStepReceipt[] = [];
  let snapshotBytes = 0;
  for (const step of group.steps) {
    await checkpoint();
    if (datasets.has(step.id))
      bulkInvalid("Bulk step identifiers must be unique.");
    if (step.kind === "read") {
      const key = JSON.stringify(step.source);
      let snapshot = snapshots.get(key);
      if (snapshot === undefined) {
        snapshot = await readSourceSnapshot(
          root,
          step.source.filePath,
          step.source.versionId,
        );
        if (formats.formatFor(snapshot.version.filePath) !== "csv")
          assertReadableFormat(snapshot.bytes, snapshot.version.filePath);
        snapshotBytes += snapshot.bytes.length;
        if (
          snapshotBytes > bulkJobLimits.maxSnapshotBytes ||
          snapshots.size >= 8
        )
          bulkBudget(
            "Bulk source snapshots exceed their count or byte budget.",
          );
        snapshots.set(key, snapshot);
      }
      const transfer = await materializeTransfer(snapshot, step.selection, {
        maxRows: bulkJobLimits.maxRecords,
        maxCells: Math.min(
          1_000_000,
          bulkJobLimits.maxResidentCells - budget.cells,
        ),
        maxTextBytes: bulkJobLimits.maxResidentTextBytes - budget.text,
        retainRowNumbers: true,
      });
      const headers = transfer.headers.map((header) => {
        if (header === null || header === "")
          bulkInvalid("Bulk records require explicit nonempty headers.");
        return header;
      });
      const data = budget.build(
        headers,
        transfer.values.length,
        function* () {
          for (const [i, cells] of transfer.values.entries()) {
            const origin = transfer.rowNumbers?.[i];
            if (origin === undefined)
              bulkInvalid("A source record has no physical row identity.");
            yield { cells, origin };
          }
        },
        { kind: "bound", basis: step.id, removedRows: [], replacement: false },
      );
      datasets.set(step.id, data);
      reads.set(step.id, { step, snapshot, transfer, data });
      receipts.push({
        id: step.id,
        kind: step.kind,
        records: data.rows.length,
        counts: {
          selected: data.rows.length,
          matched: transfer.summary.matchedRows,
          cachedFormulas: transfer.summary.cachedFormulas,
        },
      });
    } else {
      const result = applyBulkDatasetStep(step, datasets, budget);
      datasets.set(step.id, result.data);
      receipts.push(result.receipt);
    }
  }
  const ids = new Set<string>();
  const artifacts: BulkRenderedOutput[] = [];
  let totalBytes = 0;
  for (const output of group.outputs) {
    await checkpoint();
    if (ids.has(output.id))
      bulkInvalid("Bulk output identifiers must be unique.");
    ids.add(output.id);
    if (output.kind !== "new") {
      for (const change of output.kind === "edit" ? [output] : output.changes) {
        const read = reads.get(change.target);
        if (read === undefined)
          bulkInvalid("An edit target must name an original read step.");
        const policy = inspectWorkbookEdit(read.snapshot.bytes, []);
        if (policy.blockers.length > 0)
          bulkInvalid(
            `The target cannot be preserved: ${policy.blockers.map((item) => item.code).join(", ")}.`,
          );
      }
    }
    const artifact = renderBulkOutput(output, datasets, reads);
    totalBytes += artifact.bytes.length;
    if (totalBytes > bulkJobLimits.maxOutputBytes - 256 * 1024)
      bulkBudget("Bulk outputs exceed their combined publication budget.");
    artifacts.push(artifact);
  }
  for (const snapshot of snapshots.values()) {
    await checkpoint();
    await readSourceSnapshot(
      root,
      snapshot.version.filePath,
      snapshot.version.versionId,
    );
  }
  await checkpoint();
  return { artifacts, receipts };
}
function groupReceipt(
  output: WorkbookOutput,
  id: JobId,
  prepared: Awaited<ReturnType<typeof prepareGroup>>,
): BulkGroupReceipt {
  const receipt = bulkGroupReceiptSchema.parse({
    kind: "complete",
    jobId: id,
    steps: prepared.receipts,
    outputs: prepared.artifacts.map((artifact) => {
      const versionId = checksum(artifact.bytes);
      return {
        id: artifact.id,
        version: {
          filePath: `${output.directory}/job-${id}/${versionId}.xlsx`,
          versionId,
        },
        sizeBytes: artifact.bytes.length,
        recalculated: false,
        recalculationRequired: artifact.recalculationRequired,
        refreshRequired: [...new Set(artifact.refreshRequired)],
      };
    }),
  });
  if (
    Buffer.byteLength(JSON.stringify(receipt)) > bulkJobLimits.maxReceiptBytes
  )
    bulkBudget(
      "The group receipt exceeds its byte budget; no output was published.",
    );
  return receipt;
}
async function runGroup(
  root: WorkbookRoot,
  output: WorkbookOutput,
  group: BulkGroup,
  checkpoint: () => Promise<void>,
): Promise<BulkGroupReceipt> {
  const id = bulkIdentity(group),
    existing = await retainedGroup(output, id);
  if (existing !== undefined) return existing;
  const prepared = await prepareGroup(root, group, checkpoint),
    result = groupReceipt(output, id, prepared);
  const entries = new Map<string, Buffer>();
  for (const artifact of prepared.artifacts)
    entries.set(`${checksum(artifact.bytes)}.xlsx`, artifact.bytes);
  const manifest = bulkStoredManifestSchema.parse({
    kind: "group",
    request: group,
    result,
  });
  entries.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  await checkpoint();
  await jobStore(output).publish(
    `job-${id}`,
    [...entries].map(([name, content]) => ({ name, content })),
  );
  const retained = await retainedGroup(output, id);
  if (retained === undefined)
    bulkInvalid("A published job has no completion record.");
  return retained;
}
function checkDescriptor(job: BulkJob): void {
  if (Buffer.byteLength(JSON.stringify(job)) > bulkJobLimits.maxDescriptorBytes)
    bulkBudget("The bulk job descriptor exceeds 64 KiB.");
  if (
    job.kind === "independent" &&
    new Set(job.jobs.map((child) => child.id)).size !== job.jobs.length
  )
    bulkInvalid("Independent job identifiers must be unique.");
}

export async function prepareBulkJob(
  root: WorkbookRoot,
  output: WorkbookOutput,
  job: BulkJob,
  checkpoint: () => Promise<void>,
) {
  checkDescriptor(job);
  const jobId = bulkIdentity(job.kind === "dependent" ? job.group : job);
  const groups =
    job.kind === "dependent" ? [{ id: "job", group: job.group }] : job.jobs;
  const results = [];
  for (const child of groups) {
    try {
      const prepared = await prepareGroup(root, child.group, checkpoint);
      groupReceipt(output, bulkIdentity(child.group), prepared);
      results.push({
        id: child.id,
        kind: "ready" as const,
        jobId: bulkIdentity(child.group),
        steps: prepared.receipts,
        outputs: prepared.artifacts.map((artifact) => ({
          id: artifact.id,
          sizeBytes: artifact.bytes.length,
          versionId: checksum(artifact.bytes),
        })),
      });
    } catch (error) {
      results.push({
        id: child.id,
        kind: "blocked" as const,
        jobId: bulkIdentity(child.group),
        failure: failureOf(root, error),
      });
    }
  }
  return {
    kind: results.every((item) => item.kind === "ready") ? "ready" : "blocked",
    jobId,
    recalculated: false,
    executionAvailable: true,
    jobs: results,
  };
}
async function batchStatus(
  root: WorkbookRoot,
  output: WorkbookOutput,
  job: Extract<BulkJob, { kind: "independent" }>,
  jobId: JobId,
): Promise<BulkBatchReceipt> {
  const results: BulkBatchReceipt["jobs"] = [];
  for (const child of job.jobs) {
    const id = bulkIdentity(child.group);
    try {
      const existing = await retainedGroup(output, id);
      if (existing !== undefined) {
        results.push({
          kind: "complete",
          id: child.id,
          details: "full",
          result: existing,
        });
        continue;
      }
      const failure = await jobStore(output).read(
        `failed-${id}`,
        "manifest.json",
      );
      if (failure !== undefined) {
        const manifest = bulkStoredManifestSchema.parse(
          JSON.parse(failure.toString("utf8")),
        );
        if (manifest.kind !== "failure" || manifest.jobId !== id)
          bulkInvalid("Invalid retained failure identity.");
        results.push({
          kind: "failed",
          id: child.id,
          jobId: id,
          failure: manifest.failure,
        });
      } else results.push({ kind: "pending", id: child.id, jobId: id });
    } catch (error) {
      results.push({
        kind: "failed",
        id: child.id,
        jobId: id,
        failure: failureOf(root, error),
      });
    }
  }
  const complete = results.filter((item) => item.kind === "complete").length,
    failed = results.filter((item) => item.kind === "failed").length;
  return compactBatch(
    bulkBatchReceiptSchema.parse({
      jobId,
      kind:
        complete === results.length
          ? "complete"
          : complete > 0
            ? "partial"
            : failed === results.length
              ? "failed"
              : "pending",
      jobs: results,
    }),
  );
}

function compactBatch(result: BulkBatchReceipt): BulkBatchReceipt {
  if (
    Buffer.byteLength(JSON.stringify(result)) <= bulkJobLimits.maxReceiptBytes
  )
    return result;
  return bulkBatchReceiptSchema.parse({
    ...result,
    jobs: result.jobs.map((child) =>
      child.kind === "complete" && child.details === "full"
        ? {
            kind: "complete",
            id: child.id,
            details: "summary",
            result: { kind: "complete", jobId: child.result.jobId },
            outputCount: child.result.outputs.length,
            stepCount: child.result.steps.length,
          }
        : child,
    ),
  });
}

export async function runBulkJob(
  root: WorkbookRoot,
  output: WorkbookOutput,
  job: BulkJob,
  checkpoint: () => Promise<void>,
): Promise<BulkGroupReceipt | BulkBatchReceipt> {
  checkDescriptor(job);
  const store = jobStore(output);
  if (job.kind === "dependent")
    return runGroup(root, output, job.group, checkpoint);
  const jobId = bulkIdentity(job);
  await checkpoint();
  await store.publish(`batch-${jobId}`, [
    {
      name: "manifest.json",
      content: Buffer.from(
        JSON.stringify(
          bulkStoredManifestSchema.parse({
            kind: "batch",
            request: job,
            jobId,
          }),
        ),
      ),
    },
  ]);
  const failures = new Map<string, BulkFailure>();
  for (const child of job.jobs) {
    await checkpoint();
    try {
      await runGroup(root, output, child.group, checkpoint);
    } catch (error) {
      const id = bulkIdentity(child.group),
        current = failureOf(root, error);
      let diagnosticRetained = false;
      try {
        const retained = await store.read(`failed-${id}`, "manifest.json");
        if (retained === undefined) {
          await store.publish(`failed-${id}`, [
            {
              name: "manifest.json",
              content: Buffer.from(
                JSON.stringify({
                  kind: "failure",
                  jobId: id,
                  failure: {
                    ...current,
                    observation: "first_failed_attempt",
                    diagnosticRetained: true,
                  },
                }),
              ),
            },
          ]);
          diagnosticRetained = true;
        } else {
          const manifest = bulkStoredManifestSchema.parse(
            JSON.parse(retained.toString("utf8")),
          );
          diagnosticRetained =
            manifest.kind === "failure" &&
            manifest.jobId === id &&
            manifest.failure.error === current.error &&
            manifest.failure.message === current.message;
        }
      } catch {
        diagnosticRetained = false;
      }
      failures.set(child.id, { ...current, diagnosticRetained });
    }
  }
  const status = await batchStatus(root, output, job, jobId);
  const jobs = status.jobs.map((child) => {
    const failure = failures.get(child.id);
    return child.kind !== "complete" && failure !== undefined
      ? { kind: "failed" as const, id: child.id, jobId: child.jobId, failure }
      : child;
  });
  const complete = jobs.filter((child) => child.kind === "complete").length,
    failed = jobs.filter((child) => child.kind === "failed").length;
  return bulkBatchReceiptSchema.parse({
    ...status,
    jobs,
    kind:
      complete === jobs.length
        ? "complete"
        : complete > 0
          ? "partial"
          : failed === jobs.length
            ? "failed"
            : "pending",
  });
}

export async function getBulkJob(
  root: WorkbookRoot,
  output: WorkbookOutput,
  jobId: JobId,
): Promise<
  BulkGroupReceipt | BulkBatchReceipt | { kind: "not_found"; jobId: JobId }
> {
  const group = await retainedGroup(output, jobId);
  if (group !== undefined) return group;
  const batch = await jobStore(output).read(`batch-${jobId}`, "manifest.json");
  if (batch === undefined) return { kind: "not_found", jobId };
  const manifest = bulkStoredManifestSchema.parse(
    JSON.parse(batch.toString("utf8")),
  );
  if (
    manifest.kind !== "batch" ||
    manifest.jobId !== jobId ||
    bulkIdentity(manifest.request) !== jobId
  )
    bulkInvalid("The retained batch identity is invalid.");
  return batchStatus(root, output, manifest.request, jobId);
}
