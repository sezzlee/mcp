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
  readonly memberSourceVersions?: readonly string[];
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

interface PageFields {
  readonly resultId: string;
  readonly expiresAt: string;
  readonly totalRows: number;
  readonly totalColumns?: number;
  readonly matchingRows: number;
  readonly matchingSourceRows: number;
  readonly returnedRows: number;
  readonly returnedMatchedRows: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly nextOffset?: number;
  readonly columnNumbers: readonly number[];
  readonly rows: readonly (readonly CellScalar[])[];
  readonly valueTruncation: {
    readonly cells: number;
    readonly maxStringChars: number;
  };
}

export type RetainedPage = ResultMetadata & {
  readonly resultComplete: true;
  readonly sampled: false;
  readonly preview: boolean;
} & PageFields;

export type GroupingSetPreview = Pick<
  ResultMetadata,
  "columns" | "groupCount" | "ungroupedRows" | "pivotBy"
> &
  PageFields;

export type RetainedPreview = RetainedPage & {
  readonly groupingSets?: readonly GroupingSetPreview[];
};

export interface RetainRequest {
  readonly capture: ResultCapture;
  readonly metadata: ResultMetadata;
  readonly dateColumns?: readonly number[];
}

interface StoredResult extends CapturedResult {
  readonly id: string;
  readonly expiresAt: number;
  readonly metadata: ResultMetadata;
  readonly dateColumns: ReadonlySet<number>;
  index?: ReadonlyMap<string, readonly number[]>;
}

export interface ResultRowsQuery extends Omit<ResultQuery, "maxRows"> {
  readonly maxRows?: number;
}

export interface ResultRows {
  readonly resultId: string;
  readonly labels: readonly string[];
  readonly dates: readonly boolean[];
  readonly rows: readonly (readonly CellScalar[])[];
}

interface Selection {
  readonly columns: readonly number[];
  readonly offset: number;
  readonly matching: readonly CapturedRow[];
  readonly matchingSourceRows: number;
}

interface Candidate {
  readonly values: readonly CellScalar[];
  readonly shortened: readonly boolean[];
  readonly matchedRows: number;
}

interface PagePlan {
  readonly entry: StoredResult;
  readonly columns: readonly number[];
  readonly offset: number;
  readonly matchingRows: number;
  readonly matchingSourceRows: number;
  readonly candidates: readonly Candidate[];
}

interface PageShape {
  readonly width: number;
  readonly rows: number;
}

interface Slot {
  readonly plan: PagePlan;
  shape: PageShape;
}

function invalid(message: string, recovery?: string): never {
  throw new SezzleeExcelError("invalid_argument", message, recovery);
}

function selectionOf(
  entry: StoredResult,
  query: Omit<ResultRowsQuery, "resultId" | "maxRows">,
): Selection {
  const offset = query.offset ?? 0;
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
  return { columns, offset, matching, matchingSourceRows };
}

function planOf(
  entry: StoredResult,
  query: Omit<ResultQuery, "resultId">,
): PagePlan {
  const maxRows = query.maxRows ?? limits.maxGroupsDefault;
  if (
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > limits.maxGroupsHard
  )
    invalid(`maxRows must be between 1 and ${limits.maxGroupsHard}.`);
  const { columns, offset, matching, matchingSourceRows } = selectionOf(
    entry,
    query,
  );
  const candidates = matching
    .slice(offset, offset + maxRows)
    .map((row): Candidate => {
      const stored = JSON.parse(row.json) as CellScalar[];
      const values: CellScalar[] = [];
      const shortened: boolean[] = [];
      for (const column of columns) {
        const value = stored[column - 1] ?? null;
        const presented = presentScalar(value);
        values.push(presented);
        shortened.push(JSON.stringify(value) !== JSON.stringify(presented));
      }
      return { values, shortened, matchedRows: row.matchedRows };
    });
  return {
    entry,
    columns,
    offset,
    matchingRows: matching.length,
    matchingSourceRows,
    candidates,
  };
}

function descriptorsOf({ plan, shape }: Slot): ResultMetadata["columns"] {
  return plan.columns.slice(0, shape.width).map((column) => {
    const descriptor = plan.entry.metadata.columns[column - 1];
    if (descriptor === undefined)
      throw new SezzleeExcelError(
        "internal_error",
        "The stored result has no descriptor for a selected column.",
      );
    return descriptor;
  });
}

function pagingOf({ plan, shape }: Slot): PageFields {
  const shown = plan.candidates.slice(0, shape.rows);
  const nextOffset = plan.offset + shown.length;
  const hasMore = nextOffset < plan.matchingRows;
  let returnedMatchedRows = 0;
  let cells = 0;
  for (const row of shown) {
    returnedMatchedRows += row.matchedRows;
    for (const shortened of row.shortened.slice(0, shape.width))
      if (shortened) cells += 1;
  }
  return {
    resultId: plan.entry.id,
    expiresAt: new Date(plan.entry.expiresAt).toISOString(),
    totalRows: plan.entry.rows.length,
    ...(shape.width < plan.columns.length
      ? { totalColumns: plan.entry.metadata.columns.length }
      : {}),
    matchingRows: plan.matchingRows,
    matchingSourceRows: plan.matchingSourceRows,
    returnedRows: shown.length,
    returnedMatchedRows,
    offset: plan.offset,
    hasMore,
    ...(hasMore ? { nextOffset } : {}),
    columnNumbers: plan.columns.slice(0, shape.width),
    rows: shown.map((row) => row.values.slice(0, shape.width)),
    valueTruncation: { cells, maxStringChars: limits.maxStringChars },
  };
}

function pageOf(slot: Slot, preview: boolean): RetainedPage {
  return {
    ...slot.plan.entry.metadata,
    columns: descriptorsOf(slot),
    resultComplete: true,
    sampled: false,
    preview,
    ...pagingOf(slot),
  };
}

function groupingSetOf(slot: Slot): GroupingSetPreview {
  const { groupCount, ungroupedRows, pivotBy } = slot.plan.entry.metadata;
  return {
    columns: descriptorsOf(slot),
    groupCount,
    ...(ungroupedRows === undefined ? {} : { ungroupedRows }),
    ...(pivotBy === undefined ? {} : { pivotBy }),
    ...pagingOf(slot),
  };
}

function fitsPage(response: unknown): boolean {
  return measureJson(json(response)) <= limits.maxResultPageBytes;
}

function largest(
  low: number,
  high: number,
  fits: (value: number) => boolean,
): number {
  let found = low;
  let lower = low + 1;
  let upper = high;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (fits(middle)) {
      found = middle;
      lower = middle + 1;
    } else upper = middle - 1;
  }
  return found;
}

function fit(
  slots: readonly Slot[],
  narrow: boolean,
  fits: () => boolean,
  recovery: string,
): void {
  for (const slot of slots)
    slot.shape = { width: narrow ? 1 : slot.plan.columns.length, rows: 0 };
  if (!fits())
    throw resource(
      `Result metadata exceeds the ${limits.maxResultPageBytes} byte serialized response budget.`,
      recovery,
    );
  for (const slot of slots)
    slot.shape = {
      ...slot.shape,
      rows: Math.min(1, slot.plan.candidates.length),
    };
  if (!fits())
    throw resource(
      `The first selected row does not fit in the ${limits.maxResultPageBytes} byte serialized response budget.`,
      recovery,
    );
  /**
   * Guard: the full width drops totalColumns and the last row can drop
   * nextOffset, so size is monotone only below the top value. Try the top
   * first, then search the monotone part.
   */
  const grow = (
    slot: Slot,
    low: number,
    high: number,
    shapeOf: (value: number) => PageShape,
  ): void => {
    const trial = (value: number): boolean => {
      slot.shape = shapeOf(value);
      return fits();
    };
    slot.shape = shapeOf(trial(high) ? high : largest(low, high - 1, trial));
  };
  if (narrow)
    for (const slot of slots) {
      const { width, rows } = slot.shape;
      grow(slot, width, slot.plan.columns.length, (next) => ({
        width: next,
        rows,
      }));
    }
  for (const slot of slots) {
    const { width, rows } = slot.shape;
    grow(slot, rows, slot.plan.candidates.length, (next) => ({
      width,
      rows: next,
    }));
  }
}

const maxCandidates = 8;
const maxComparedCells = 64;
const repeatedRun = 3;

function scalarKey(value: CellScalar): string {
  return JSON.stringify(value);
}

function indexOf(entry: StoredResult): ReadonlyMap<string, readonly number[]> {
  if (entry.index !== undefined) return entry.index;
  const index = new Map<string, number[]>();
  for (const [at, row] of entry.rows.entries()) {
    const first = (JSON.parse(row.json) as CellScalar[])[0];
    if (first === undefined || first === null) continue;
    const key = scalarKey(first);
    const bucket = index.get(key) ?? [];
    if (bucket.length < maxCandidates) bucket.push(at);
    index.set(key, bucket);
  }
  entry.index = index;
  return index;
}

/**
 * Guard: a written row counts as a copy only when it holds at least two
 * values and every one of them appears in one stored row, so a single total
 * or a coincidental label never refuses a write. Lookups use the stored row's
 * first value, a bounded number of candidates and a bounded width, keeping
 * the check linear in the written rows.
 */
function copiesRow(
  entry: StoredResult,
  index: ReadonlyMap<string, readonly number[]>,
  row: readonly CellScalar[],
): boolean {
  const written = row
    .slice(0, maxComparedCells)
    .filter((value) => value !== null)
    .map(scalarKey);
  if (written.length < 2) return false;
  for (const key of written)
    for (const at of index.get(key) ?? []) {
      const stored = entry.rows[at];
      if (stored === undefined) continue;
      const remaining = new Map<string, number>();
      for (const value of JSON.parse(stored.json) as CellScalar[]) {
        const valueKey = scalarKey(value);
        remaining.set(valueKey, (remaining.get(valueKey) ?? 0) + 1);
      }
      if (
        written.every((valueKey) => {
          const left = remaining.get(valueKey) ?? 0;
          remaining.set(valueKey, left - 1);
          return left > 0;
        })
      )
        return true;
    }
  return false;
}

function slotOf(plan: PagePlan): Slot {
  return { plan, shape: { width: plan.columns.length, rows: 0 } };
}

export interface ResultStore {
  retain(
    requests: readonly [RetainRequest, ...RetainRequest[]],
    maxRows: number,
  ): RetainedPreview;
  query(query: ResultQuery): RetainedPage;
  rows(query: ResultRowsQuery): ResultRows;
  repeated(rows: readonly (readonly CellScalar[])[]): string | undefined;
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
  const live = (resultId: string): StoredResult => {
    expire(Date.now());
    const entry = entries.get(resultId);
    if (entry === undefined)
      throw new SezzleeExcelError(
        "result_unavailable",
        "The result is unknown, expired, or belongs to another server instance.",
        "Run aggregate_sheet with resultMode retained in this server instance to create a new result.",
      );
    return entry;
  };
  return {
    retain([first, ...rest], maxRows) {
      const now = Date.now();
      expire(now);
      const prepare = ({
        capture,
        metadata,
        dateColumns = [],
      }: RetainRequest): StoredResult => {
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
        return {
          ...captured,
          sizeBytes: bytes,
          id: createResultId(),
          expiresAt: now + limits.resultTtlMs,
          metadata: JSON.parse(JSON.stringify(metadata)) as ResultMetadata,
          dateColumns: new Set(dateColumns),
        };
      };
      const primary = prepare(first);
      const sets = rest.map(prepare);
      const admitted = [primary, ...sets];
      const bytes = admitted.reduce((sum, entry) => sum + entry.sizeBytes, 0);
      if (
        entries.size + admitted.length > limits.maxResults ||
        sizeBytes + bytes > limits.maxResultStoreBytes
      )
        throw resource(
          `The result store is full (${limits.maxResults} results, ${limits.maxResultStoreBytes} bytes).`,
          "Wait for an existing result to expire, or start a new server instance. Existing results remain readable.",
        );
      const head = slotOf(planOf(primary, { maxRows }));
      const tail = sets.map((entry) => slotOf(planOf(entry, { maxRows })));
      const previewOf = (): RetainedPreview => ({
        ...pageOf(head, true),
        ...(tail.length === 0 ? {} : { groupingSets: tail.map(groupingSetOf) }),
      });
      fit(
        [head, ...tail],
        true,
        () => fitsPage(previewOf()),
        "Use fewer metrics or shorter group labels so the result preview fits.",
      );
      const preview = previewOf();
      for (const entry of admitted) entries.set(entry.id, entry);
      sizeBytes += bytes;
      return preview;
    },
    query(query) {
      const entry = live(query.resultId);
      const slot = slotOf(planOf(entry, query));
      fit(
        [slot],
        false,
        () => fitsPage(pageOf(slot, false)),
        "Select fewer result columns, or use a filter that selects shorter values.",
      );
      return pageOf(slot, false);
    },
    rows(query) {
      const entry = live(query.resultId);
      const maxRows = query.maxRows ?? limits.maxResultRows;
      if (
        !Number.isSafeInteger(maxRows) ||
        maxRows < 1 ||
        maxRows > limits.maxResultRows
      )
        invalid(`maxRows must be between 1 and ${limits.maxResultRows}.`);
      const { columns, offset, matching } = selectionOf(entry, query);
      return {
        resultId: entry.id,
        labels: columns.map(
          (column) => entry.metadata.columns[column - 1]?.label ?? "",
        ),
        dates: columns.map((column) => entry.dateColumns.has(column)),
        rows: matching.slice(offset, offset + maxRows).map((row) => {
          const stored = JSON.parse(row.json) as CellScalar[];
          return columns.map((column) => stored[column - 1] ?? null);
        }),
      };
    },
    repeated(rows) {
      expire(Date.now());
      for (const entry of entries.values()) {
        const index = indexOf(entry);
        let run = 0;
        for (const row of rows) {
          run = copiesRow(entry, index, row) ? run + 1 : 0;
          if (run >= repeatedRun) return entry.id;
        }
      }
      return undefined;
    },
    clear() {
      entries.clear();
      sizeBytes = 0;
    },
  };
}
