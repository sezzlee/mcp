import { json, measureJson } from "@sezzlee/file-core";
import type { AggregateResult } from "../grid/aggregate.js";
import {
  isCellError,
  isCellImage,
  isCellLinkedValue,
  presentScalar,
  type CellScalar,
} from "../grid/cell-value.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { limits } from "../platform/limits.js";
import { createResultId, resultUtf8Bytes } from "../platform/result-id.js";

export type ResultMetadata = Omit<
  AggregateResult,
  | "rows"
  | "returnedGroups"
  | "returnedMatchedRows"
  | "omittedMatchedRows"
  | "truncated"
  | "truncationReason"
  | "hint"
  | "groupingSets"
> & {
  readonly sourceVersion: string;
  readonly sourcePolicy: "snapshot";
};

interface CapturedRow {
  readonly json: string;
  readonly matchedRows: number;
}

interface CapturedResult {
  readonly rows: readonly CapturedRow[];
  readonly sizeBytes: number;
  readonly width: number | undefined;
}

export interface ResultCapture {
  add(row: readonly CellScalar[], matchedRows: number): void;
  snapshot(): CapturedResult;
}

function resource(message: string, recovery?: string): SezzleeExcelError {
  return new SezzleeExcelError(
    "resource_limit",
    message,
    recovery ?? "Use fewer groups, fewer metrics, or a narrower source range.",
  );
}

export function createResultCapture(): ResultCapture {
  const rows: CapturedRow[] = [];
  let sizeBytes = 2;
  let cells = 0;
  let width: number | undefined;
  let failure: SezzleeExcelError | undefined;
  return {
    add(row, matchedRows) {
      if (failure !== undefined) throw failure;
      if (
        !Number.isSafeInteger(matchedRows) ||
        matchedRows < 0 ||
        (width !== undefined && row.length !== width)
      )
        throw new SezzleeExcelError(
          "internal_error",
          "The calculated result has an inconsistent row shape.",
        );
      const refuse = (message: string): never => {
        failure = resource(message);
        throw failure;
      };
      if (rows.length >= limits.maxResultRows)
        refuse(`A retained result exceeds ${limits.maxResultRows} rows.`);
      if (cells + row.length > limits.maxResultCells)
        refuse(`A retained result exceeds ${limits.maxResultCells} cells.`);
      let remainingTextBytes = limits.maxResultBytes - sizeBytes;
      /**
       * Guard: decoded source strings can exceed the entire result budget.
       * Refuse their cumulative raw text before JSON escaping allocates a copy.
       * Escaping and structural overhead remain subject to the exact byte check.
       */
      const admitText = (text: string | undefined): void => {
        if (text === undefined) return;
        if (text.length > remainingTextBytes)
          refuse(`A retained result exceeds ${limits.maxResultBytes} bytes.`);
        remainingTextBytes -= resultUtf8Bytes(text);
        if (remainingTextBytes < 0)
          refuse(`A retained result exceeds ${limits.maxResultBytes} bytes.`);
      };
      for (const value of row) {
        if (typeof value === "string") admitText(value);
        else if (isCellError(value)) admitText(value.error);
        else if (isCellImage(value)) admitText(value.altText);
        else if (isCellLinkedValue(value)) {
          admitText(value.linkedValue.displayText);
          admitText(value.linkedValue.entityId);
          admitText(value.linkedValue.entityCulture);
        }
      }
      const encoded = JSON.stringify(row);
      const bytes =
        resultUtf8Bytes(encoded) +
        measureJson({ row: [], matchedRows }) -
        2 +
        Number(rows.length > 0);
      if (sizeBytes + bytes > limits.maxResultBytes)
        refuse(`A retained result exceeds ${limits.maxResultBytes} bytes.`);
      rows.push({ json: encoded, matchedRows });
      sizeBytes += bytes;
      cells += row.length;
      width = row.length;
    },
    snapshot() {
      if (failure !== undefined) throw failure;
      return { rows: rows.slice(), sizeBytes, width };
    },
  };
}

export interface ResultQuery {
  readonly resultId: string;
  readonly columns?: readonly number[];
  readonly where?: readonly {
    readonly column: number;
    readonly equals: string | number | boolean | null;
  }[];
  readonly offset?: number;
  readonly maxRows?: number;
}

export interface RetainedPage extends ResultMetadata {
  readonly resultId: string;
  readonly expiresAt: string;
  readonly resultComplete: true;
  readonly sampled: false;
  readonly totalRows: number;
  readonly matchingRows: number;
  readonly matchingSourceRows: number;
  readonly returnedRows: number;
  readonly returnedMatchedRows: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly nextOffset?: number;
  readonly preview: boolean;
  readonly columnNumbers: readonly number[];
  readonly rows: readonly (readonly CellScalar[])[];
  readonly valueTruncation: {
    readonly cells: number;
    readonly maxStringChars: number;
  };
}

interface StoredResult extends CapturedResult {
  readonly id: string;
  readonly expiresAt: number;
  readonly metadata: ResultMetadata;
}

function invalid(message: string, recovery?: string): never {
  throw new SezzleeExcelError("invalid_argument", message, recovery);
}

function pageOf(
  entry: StoredResult,
  query: Omit<ResultQuery, "resultId">,
  preview: boolean,
): RetainedPage {
  const maxRows = query.maxRows ?? limits.maxGroupsDefault;
  const offset = query.offset ?? 0;
  if (
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > limits.maxGroupsHard
  )
    invalid(`maxRows must be between 1 and ${limits.maxGroupsHard}.`);
  if (!Number.isSafeInteger(offset) || offset < 0)
    invalid("offset must be a non-negative integer.");
  const columns =
    query.columns ?? entry.metadata.columns.map((_column, index) => index + 1);
  const validColumn = (column: number): boolean =>
    Number.isSafeInteger(column) &&
    column >= 1 &&
    column <= entry.metadata.columns.length;
  if (
    columns.length === 0 ||
    columns.length > entry.metadata.columns.length ||
    new Set(columns).size !== columns.length ||
    !columns.every(validColumn)
  )
    invalid("columns must contain distinct one-based result column numbers.");
  const where = query.where ?? [];
  if (where.length > limits.maxConditions)
    invalid(`At most ${limits.maxConditions} result filters are accepted.`);
  for (const condition of where) {
    if (!validColumn(condition.column))
      invalid("A filter column is outside the stored result.");
    if (
      typeof condition.equals === "string" &&
      condition.equals.length > limits.maxResultFilterChars
    )
      invalid(
        `A result filter string exceeds ${limits.maxResultFilterChars} characters.`,
      );
    if (
      typeof condition.equals === "number" &&
      !Number.isFinite(condition.equals)
    )
      invalid("Result filters require finite numbers.");
  }

  const matching: CapturedRow[] = [];
  let matchingSourceRows = 0;
  for (const row of entry.rows) {
    if (where.length > 0) {
      const values = JSON.parse(row.json) as CellScalar[];
      if (
        !where.every(
          (condition) => values[condition.column - 1] === condition.equals,
        )
      )
        continue;
    }
    matching.push(row);
    matchingSourceRows += row.matchedRows;
  }
  if (offset > matching.length)
    invalid(
      "offset exceeds the matching result rows.",
      "Start at offset 0 or use nextOffset with the same filters and columns.",
    );
  const descriptors = columns.map((column) => {
    const descriptor = entry.metadata.columns[column - 1];
    if (descriptor === undefined)
      throw new SezzleeExcelError(
        "internal_error",
        "The stored result has no descriptor for a selected column.",
      );
    return descriptor;
  });
  const build = (
    rows: readonly (readonly CellScalar[])[],
    sourceRows: number,
    shortened: number,
  ): RetainedPage => {
    const nextOffset = offset + rows.length;
    const hasMore = nextOffset < matching.length;
    return {
      ...entry.metadata,
      columns: descriptors,
      resultId: entry.id,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      resultComplete: true,
      sampled: false,
      totalRows: entry.rows.length,
      matchingRows: matching.length,
      matchingSourceRows,
      returnedRows: rows.length,
      returnedMatchedRows: sourceRows,
      offset,
      hasMore,
      ...(hasMore ? { nextOffset } : {}),
      preview,
      columnNumbers: columns,
      rows,
      valueTruncation: {
        cells: shortened,
        maxStringChars: limits.maxStringChars,
      },
    };
  };
  const recovery = preview
    ? "Use fewer metrics or shorter group labels so the result preview fits."
    : "Select fewer result columns, or use a filter that selects shorter values.";
  const rows: CellScalar[][] = [];
  let sourceRows = 0;
  let shortened = 0;
  if (
    measureJson(json(build(rows, sourceRows, shortened))) >
    limits.maxResultPageBytes
  )
    throw resource(
      `Result metadata exceeds the ${limits.maxResultPageBytes} byte serialized response budget.`,
      recovery,
    );
  for (const row of matching.slice(offset, offset + maxRows)) {
    const values = JSON.parse(row.json) as CellScalar[];
    let truncated = 0;
    const shown = columns.map((column) => {
      const value = values[column - 1] ?? null;
      const presented = presentScalar(value);
      if (JSON.stringify(value) !== JSON.stringify(presented)) truncated += 1;
      return presented;
    });
    const next = build(
      [...rows, shown],
      sourceRows + row.matchedRows,
      shortened + truncated,
    );
    if (measureJson(json(next)) > limits.maxResultPageBytes) {
      if (rows.length === 0)
        throw resource(
          `The first selected row does not fit in the ${limits.maxResultPageBytes} byte serialized response budget.`,
          recovery,
        );
      break;
    }
    rows.push(shown);
    sourceRows += row.matchedRows;
    shortened += truncated;
  }
  return build(rows, sourceRows, shortened);
}

export interface ResultStore {
  retain(
    capture: ResultCapture,
    metadata: ResultMetadata,
    maxRows: number,
  ): RetainedPage;
  query(query: ResultQuery): RetainedPage;
  clear(): void;
}

export function createResultStore(): ResultStore {
  const entries = new Map<string, StoredResult>();
  let sizeBytes = 0;
  const expire = (now: number): void => {
    for (const [id, entry] of entries)
      if (entry.expiresAt <= now) {
        entries.delete(id);
        sizeBytes -= entry.sizeBytes;
      }
  };
  return {
    retain(capture, metadata, maxRows) {
      const now = Date.now();
      expire(now);
      const captured = capture.snapshot();
      if (
        captured.width !== undefined &&
        captured.width !== metadata.columns.length
      )
        throw new SezzleeExcelError(
          "internal_error",
          "The result columns do not match its captured rows.",
        );
      const bytes = captured.sizeBytes + measureJson(metadata);
      if (bytes > limits.maxResultBytes)
        throw resource(
          `A retained result exceeds ${limits.maxResultBytes} bytes.`,
        );
      if (
        entries.size >= limits.maxResults ||
        sizeBytes + bytes > limits.maxResultStoreBytes
      )
        throw resource(
          `The result store is full (${limits.maxResults} results, ${limits.maxResultStoreBytes} bytes).`,
          "Wait for an existing result to expire, or start a new server instance. Existing results remain readable.",
        );
      const entry: StoredResult = {
        ...captured,
        sizeBytes: bytes,
        id: createResultId(),
        expiresAt: now + limits.resultTtlMs,
        metadata: JSON.parse(JSON.stringify(metadata)) as ResultMetadata,
      };
      const preview = pageOf(entry, { maxRows }, true);
      entries.set(entry.id, entry);
      sizeBytes += bytes;
      return preview;
    },
    query(query) {
      expire(Date.now());
      const entry = entries.get(query.resultId);
      if (entry === undefined)
        throw new SezzleeExcelError(
          "result_unavailable",
          "The result is unknown, expired, or belongs to another server instance.",
          "Run aggregate_sheet with resultMode retained in this server instance to create a new result.",
        );
      return pageOf(entry, query, false);
    },
    clear() {
      entries.clear();
      sizeBytes = 0;
    },
  };
}
