import {
  parseReadArguments,
  readNarrowing,
  recordOf,
  selectFrom,
} from "../results/reading.js";
import { handlePattern, type ResultShelf } from "../results/store.js";
import {
  errorResult,
  missingArgument,
  textResult,
  type MetaResponse,
} from "./meta-tools.js";

/** The `read_result` arguments as they arrived, before any check. */
export interface ReadResultCall {
  readonly handle: unknown;
  readonly path?: unknown;
  readonly select?: unknown;
  readonly offset?: unknown;
  readonly limit?: unknown;
}

const unavailable = (): MetaResponse<never> =>
  errorResult(
    "result_unavailable",
    "No stored result answers this handle: it expired, was evicted, or was not issued to this caller. Call the operation again for a new one; if it is not read-only, calling it again applies it again.",
  );

/**
 * Answers one `read_result` call.
 *
 * @param visible decides the producing tool for the reading caller as `load_tool` would; a tool
 * that is no longer in the catalog is not visible
 */
export async function readStoredResult(
  call: ReadResultCall,
  shelf: ResultShelf,
  visible: (tool: string) => Promise<boolean>,
): Promise<MetaResponse<never>> {
  const { handle } = call;
  if (handle === undefined || handle === null) {
    return missingArgument("read_result", "handle");
  }
  if (typeof handle !== "string") {
    return errorResult(
      "unknown_argument",
      `Tool 'read_result' takes 'handle' as a string; ${typeof handle} arrived. Call it again with the handle an invoke_tool answer returned.`,
    );
  }
  const request = parseReadArguments(call);
  if ("error" in request) {
    return { payload: request, isError: true };
  }
  if (!handlePattern.test(handle)) {
    return unavailable();
  }
  const value = await shelf.store.get(shelf.partition, handle);
  const record = value === undefined ? undefined : recordOf(value);
  if (record === undefined || !(await visible(record.tool))) {
    return unavailable();
  }
  const read = selectFrom(record.body, request);
  if ("error" in read) {
    return { payload: read, isError: true };
  }
  return textResult(read, false, {
    summaryOf: read.value,
    narrowing: readNarrowing,
  });
}
