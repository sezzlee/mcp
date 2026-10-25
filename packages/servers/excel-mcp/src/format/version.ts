import type { WorkbookRoot } from "../platform/paths.js";
import {
  readWorkbookSnapshot,
  type WorkbookOutput,
  type WorkbookVersionId,
  type VersionReceipt,
} from "../platform/versions.js";
import { parseOoxml } from "./ooxml-workbook.js";

export async function prepareWorkbookVersion({
  root,
  output,
  filePath,
  expectedVersion,
  signal,
}: {
  readonly root: WorkbookRoot;
  readonly output: WorkbookOutput;
  readonly filePath: string;
  readonly expectedVersion?: WorkbookVersionId;
  readonly signal?: AbortSignal;
}): Promise<VersionReceipt> {
  signal?.throwIfAborted();
  const snapshot = await readWorkbookSnapshot(root, filePath, expectedVersion);
  parseOoxml(snapshot.bytes, snapshot.version.filePath);
  signal?.throwIfAborted();
  return output.publish(snapshot.bytes, {
    kind: "source",
    version: snapshot.version,
  });
}
