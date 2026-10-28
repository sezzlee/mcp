import { createHash } from "node:crypto";
import { extname, isAbsolute, relative } from "node:path";
import { openOutputRoot } from "@sezzlee/file-core-native";
import { asciiLower } from "@sezzlee/file-core";
import { z } from "zod";
import { SezzleeExcelError, asExcelError } from "./errors.js";
import { limits } from "./limits.js";
import {
  portablePath,
  resolveWorkbookPath,
  type WorkbookRoot,
} from "./paths.js";
import { formats } from "./formats.js";
export const workbookVersionIdSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .brand<"WorkbookVersionId">();
export const workbookVersionSchema = z.strictObject({
  filePath: z.string().min(1).max(32_768),
  versionId: workbookVersionIdSchema,
});

/** An expected version as its id, or as the version object a read or receipt returned. */
export const expectedVersionSchema = z.union([
  workbookVersionIdSchema,
  workbookVersionSchema,
]);

/**
 * The version id an expected version names. Its filePath is not compared:
 * the id is a content hash, so another file's version fails as a change.
 */
export function expectedVersionId(
  expected: z.infer<typeof expectedVersionSchema>,
): z.infer<typeof workbookVersionIdSchema> {
  return typeof expected === "string" ? expected : expected.versionId;
}

export const versionReceiptSchema = z.strictObject({
  kind: z.literal("complete"),
  version: workbookVersionSchema,
  source: workbookVersionSchema.nullable(),
  sizeBytes: z.int().nonnegative().max(limits.maxFileBytes),
});

export const editPlacementSchema = z.strictObject({
  operation: z.int().nonnegative(),
  sheetName: z.string().min(1).max(31),
  range: z.string().min(2).max(21),
});

const sourcedBlock = {
  at: z.string().min(1).max(64),
  rows: z.int().nonnegative(),
  columns: z.int().positive(),
};

export const blockSourceReceiptSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("range"),
    ...sourcedBlock,
    version: workbookVersionSchema,
  }),
  z.strictObject({
    kind: z.literal("records"),
    ...sourcedBlock,
    version: workbookVersionSchema,
  }),
  z.strictObject({
    kind: z.literal("aggregate"),
    ...sourcedBlock,
    version: workbookVersionSchema,
  }),
  z.strictObject({
    kind: z.literal("result"),
    ...sourcedBlock,
    resultId: z.string().min(1).max(128),
  }),
]);

export const mutationReceiptSchema = versionReceiptSchema.extend({
  placements: z.array(editPlacementSchema).min(1).optional(),
  sources: z.array(blockSourceReceiptSchema).min(1).optional(),
  editing: z
    .strictObject({
      operations: z.int().nonnegative(),
      partsChanged: z.int().nonnegative(),
      cellsCleared: z.int().nonnegative(),
      cellsFormatted: z.int().nonnegative().optional(),
      formulasWritten: z.int().nonnegative().optional(),
      mergedValuesCleared: z.int().nonnegative().optional(),
      tablesChanged: z.int().nonnegative().optional(),
      recalculated: z.literal(false),
      recalculationRequired: z.boolean(),
      cachedFormulaValues: z.int().nonnegative().optional(),
      refreshRequired: z
        .array(z.enum(["formulas", "charts", "pivots"]))
        .optional(),
    })
    .optional(),
  changes: z.strictObject({
    sheetsAdded: z.int().nonnegative(),
    blocksWritten: z.int().nonnegative(),
    cellsWritten: z.int().nonnegative(),
  }),
});

export type WorkbookVersionId = z.infer<typeof workbookVersionIdSchema>;
export type WorkbookVersion = z.infer<typeof workbookVersionSchema>;
export type VersionReceipt = z.infer<typeof versionReceiptSchema>;
export type MutationReceipt = z.infer<typeof mutationReceiptSchema>;
export type EditPlacement = z.infer<typeof editPlacementSchema>;
export type BlockSourceReceipt = z.infer<typeof blockSourceReceiptSchema>;

export type WorkbookOrigin =
  | { readonly kind: "new" }
  | { readonly kind: "source"; readonly version: WorkbookVersion };

export interface WorkbookSnapshot {
  readonly version: WorkbookVersion;
  readonly bytes: Buffer;
}

export interface WorkbookOutput {
  readonly directory: string;
  publish(bytes: Buffer, origin: WorkbookOrigin): Promise<VersionReceipt>;
  readonly jobs?: {
    publish(
      name: string,
      files: readonly { readonly name: string; readonly content: Buffer }[],
    ): Promise<void>;
    read(name: string, file: string): Promise<Buffer | undefined>;
  };
}

function versionId(bytes: Buffer): WorkbookVersionId {
  return workbookVersionIdSchema.parse(
    createHash("sha256").update(bytes).digest("hex"),
  );
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function filesystemError(error: unknown): SezzleeExcelError {
  if (error instanceof SezzleeExcelError) return error;
  switch (errorCode(error)) {
    case "path_outside_root":
      return new SezzleeExcelError(
        "path_outside_root",
        "The requested location cannot be safely resolved under the root.",
      );
    case "file_not_found":
      return new SezzleeExcelError(
        "file_not_found",
        "The requested source or output directory does not exist.",
      );
    case "not_a_file":
      return new SezzleeExcelError(
        "not_a_file",
        "The requested source or output location has the wrong kind.",
      );
    case "file_too_large":
      return new SezzleeExcelError(
        "file_too_large",
        "The version exceeds the configured byte limit.",
      );
    case "file_changed":
      return new SezzleeExcelError(
        "file_changed",
        "The source changed during the operation.",
      );
    case "unsupported_platform":
      return new SezzleeExcelError(
        "unsupported_platform",
        "Secure output publication is unavailable. Rebuild or install a complete platform package.",
      );
    case "resource_limit":
      return new SezzleeExcelError(
        "resource_limit",
        "The secure filesystem resource budget was exceeded.",
      );
    default:
      return asExcelError(error);
  }
}

export async function readWorkbookSnapshot(
  root: WorkbookRoot,
  filePath: string,
  expectedVersion?: WorkbookVersionId,
): Promise<WorkbookSnapshot> {
  return readSnapshot(root, filePath, expectedVersion, true);
}

export async function readSourceSnapshot(
  root: WorkbookRoot,
  filePath: string,
  expectedVersion?: WorkbookVersionId,
): Promise<WorkbookSnapshot> {
  return readSnapshot(root, filePath, expectedVersion, false);
}

async function readSnapshot(
  root: WorkbookRoot,
  filePath: string,
  expectedVersion: WorkbookVersionId | undefined,
  workbookOnly: boolean,
): Promise<WorkbookSnapshot> {
  try {
    const path = await resolveWorkbookPath(root, filePath);
    if (workbookOnly && asciiLower(extname(path)) !== ".xlsx")
      throw new SezzleeExcelError(
        "invalid_argument",
        "Version preparation currently accepts .xlsx sources only.",
      );
    const format = formats.formatFor(path);
    const canonical = portablePath(relative(root.real, path));
    const snapshot = await root.access.read(
      canonical,
      format === "csv" ? limits.maxCsvBytes : limits.maxFileBytes,
    );
    const id = versionId(snapshot.bytes);
    if (expectedVersion !== undefined && id !== expectedVersion)
      throw new SezzleeExcelError(
        "file_changed",
        "The source no longer matches the expected version.",
        "Read the source again before preparing another version.",
      );
    return {
      version: workbookVersionSchema.parse({
        filePath: canonical,
        versionId: id,
      }),
      bytes: snapshot.bytes,
    };
  } catch (error) {
    throw filesystemError(error);
  }
}

export async function createWorkbookOutput(
  root: WorkbookRoot,
  requested: string,
): Promise<WorkbookOutput> {
  if (requested === "" || isAbsolute(requested))
    throw new SezzleeExcelError(
      "invalid_argument",
      "The output directory must be an existing directory relative to the workbook root.",
    );
  try {
    const directory = await root.access.resolve(requested);
    if (directory === "" || directory === ".")
      throw new SezzleeExcelError(
        "invalid_argument",
        "Use a dedicated output directory below the workbook root.",
      );
    const output = openOutputRoot(root.access, directory);
    return {
      directory,
      jobs: {
        async publish(name, files) {
          try {
            await output.publishDirectory(name, files, limits.maxFileBytes);
          } catch (error) {
            if (errorCode(error) !== "output_exists")
              throw filesystemError(error);
          }
          for (const file of files) {
            const retained = await root.access.read(
              `${directory}/${name}/${file.name}`,
              limits.maxFileBytes,
            );
            if (!retained.bytes.equals(file.content))
              throw new SezzleeExcelError(
                "file_changed",
                "The retained job contains different content.",
              );
          }
        },
        async read(name, file) {
          if (
            !/^[a-z0-9-]{1,120}$/.test(name) ||
            !/^[a-z0-9][a-z0-9._-]{0,119}$/.test(file)
          )
            throw new SezzleeExcelError(
              "invalid_argument",
              "Invalid job artifact name.",
            );
          try {
            return (
              await root.access.read(
                `${directory}/${name}/${file}`,
                limits.maxFileBytes,
              )
            ).bytes;
          } catch (error) {
            if (errorCode(error) === "file_not_found") return undefined;
            throw filesystemError(error);
          }
        },
      },
      async publish(bytes, origin) {
        if (bytes.length > limits.maxFileBytes)
          throw new SezzleeExcelError(
            "file_too_large",
            "The output exceeds the configured byte limit.",
          );
        const id = versionId(bytes);
        const name = `${id}.xlsx`;
        const filePath = `${directory}/${name}`;
        const version = workbookVersionSchema.parse({
          filePath,
          versionId: id,
        });
        try {
          await output.publish(name, bytes, limits.maxFileBytes);
        } catch (error) {
          if (errorCode(error) !== "output_exists")
            throw filesystemError(error);
        }
        const existing = await root.access.read(filePath, limits.maxFileBytes);
        if (versionId(existing.bytes) !== id)
          throw new SezzleeExcelError(
            "file_changed",
            "The output location contains different content for this version.",
          );
        return versionReceiptSchema.parse({
          kind: "complete",
          version,
          source: origin.kind === "new" ? null : origin.version,
          sizeBytes: existing.size,
        });
      },
    };
  } catch (error) {
    throw filesystemError(error);
  }
}
