import type { WriteCell } from "../authoring/values.js";
import { writeCellSchema } from "../authoring/values.js";
import {
  canonicalWriteValue,
  encodeBulkKey,
  sameWriteValue,
} from "../authoring/bulk-key.js";
import { evaluate, validateCondition } from "../grid/predicate.js";
import {
  explicitReading,
  rawReadingFor,
  typedCell,
} from "../grid/column-reading.js";
import { observeTyped } from "../grid/column-plans.js";
import { SezzleeExcelError } from "../platform/errors.js";
import {
  bulkJobLimits,
  type BulkStep,
  type BulkStepReceipt,
} from "./bulk-job-schemas.js";

export interface BulkRow {
  readonly cells: readonly WriteCell[];
  readonly origin: number | null;
}
export type BulkDataset = {
  readonly headers: readonly string[];
  readonly rows: readonly BulkRow[];
} & (
  | { readonly kind: "values" }
  | {
      readonly kind: "bound";
      readonly basis: string;
      readonly removedRows: readonly number[];
      readonly replacement: boolean;
    }
);
type Binding =
  | Pick<
      Extract<BulkDataset, { kind: "bound" }>,
      "kind" | "basis" | "removedRows" | "replacement"
    >
  | { readonly kind: "values" };
export function bulkInvalid(message: string): never {
  throw new SezzleeExcelError("invalid_argument", message);
}
export function bulkBudget(message: string): never {
  throw new SezzleeExcelError("resource_limit", message);
}
export function datasetColumn(data: BulkDataset, name: string): number {
  const index = data.headers.indexOf(name);
  if (index < 0) bulkInvalid(`Unknown selected column '${name.slice(0, 80)}'.`);
  return index;
}
function cellAt(row: BulkRow, column: number): WriteCell {
  const cell = row.cells[column];
  if (cell === undefined) bulkInvalid("A bulk record is not rectangular.");
  return cell;
}
function binding(data: BulkDataset): Binding {
  return data.kind === "values"
    ? { kind: "values" }
    : {
        kind: "bound",
        basis: data.basis,
        removedRows: data.removedRows,
        replacement: data.replacement,
      };
}
export class BulkDatasetBudget {
  cells = 0;
  text = 0;
  comparisons = 0;
  visit(count = 1): void {
    this.comparisons += count;
    if (this.comparisons > bulkJobLimits.maxComparisons)
      bulkBudget("Bulk work exceeds its comparison budget.");
  }
  build(
    headers: readonly string[],
    count: number,
    rows: () => Iterable<BulkRow>,
    bound: Binding = { kind: "values" },
  ): BulkDataset {
    if (
      headers.length === 0 ||
      headers.length > bulkJobLimits.maxColumns ||
      headers.some((h) => h === "") ||
      new Set(headers).size !== headers.length
    )
      bulkInvalid(
        "Bulk output headers must be nonempty and unique within the column budget.",
      );
    const cells = (count + 1) * headers.length;
    if (
      count > bulkJobLimits.maxRecords ||
      cells > 1_000_000 ||
      this.cells + cells > bulkJobLimits.maxResidentCells
    )
      bulkBudget(
        "Bulk datasets exceed their record, cell or combined intermediate budget.",
      );
    this.cells += cells;
    const result: BulkRow[] = [];
    for (const row of rows()) {
      if (row.cells.length !== headers.length || result.length >= count)
        bulkInvalid("Bulk output dimensions do not match their plan.");
      for (const cell of row.cells) {
        if (cell.kind === "text") this.text += Buffer.byteLength(cell.value);
        if (this.text > bulkJobLimits.maxResidentTextBytes)
          bulkBudget("Bulk intermediate text exceeds its byte budget.");
      }
      result.push(row);
    }
    if (result.length !== count)
      bulkInvalid("Bulk output record count does not match its plan.");
    return { ...bound, headers, rows: result };
  }
}

function predicate(
  data: BulkDataset,
  step: Extract<BulkStep, { kind: "update" | "remove" | "filter" }>,
  budget: BulkDatasetBudget,
) {
  const conditions = (step.where ?? []).map((condition) => {
    validateCondition(condition, step.caseSensitive);
    return { condition, index: datasetColumn(data, condition.column) };
  });
  return (row: BulkRow): boolean => {
    const matches = conditions.map(({ condition, index }) => {
      budget.visit();
      const cell = cellAt(row, index);
      const result = evaluate(
        condition,
        typedCell(
          canonicalWriteValue(cell),
          rawReadingFor({ missingValues: [] }),
        ),
        { caseSensitive: step.caseSensitive },
      );
      if (result === "incomparable")
        bulkInvalid(
          "A bulk predicate is incomparable; choose explicit source reading or conversion.",
        );
      return result === "match";
    });
    return (
      matches.length === 0 ||
      (step.match === "all" ? matches.every(Boolean) : matches.some(Boolean))
    );
  };
}

function keyIndex(
  data: BulkDataset,
  columns: readonly number[],
  bytes: { value: number },
  groupMissing = false,
) {
  const index = new Map<string, number[]>();
  const keys: (string | null)[] = [];
  let missing = 0;
  let duplicates = 0;
  for (const [offset, row] of data.rows.entries()) {
    const parts = columns.map((column) => cellAt(row, column));
    const encoded = encodeBulkKey(parts);
    if (encoded === null) missing += 1;
    const key =
      encoded ??
      (groupMissing
        ? JSON.stringify(
            parts.map((cell) => [cell.kind, canonicalWriteValue(cell)]),
          )
        : null);
    keys.push(key);
    if (key === null) continue;
    bytes.value += Buffer.byteLength(key);
    if (bytes.value > bulkJobLimits.maxKeyBytes)
      bulkBudget("Bulk key indexes exceed their byte budget.");
    const group = index.get(key);
    if (group === undefined) index.set(key, [offset]);
    else {
      group.push(offset);
      duplicates += 1;
    }
  }
  return { index, keys, missing, duplicates };
}
function chosen(
  group: readonly number[],
  policy: "error" | "first" | "last",
  many = false,
): readonly number[] {
  if (many) return group;
  const value = policy === "last" ? group.at(-1) : group[0];
  return value === undefined ? [] : [value];
}
function checkConflicts(
  left: ReturnType<typeof keyIndex>,
  right: ReturnType<typeof keyIndex>,
  step: {
    duplicates: "error" | "first" | "last";
    missingKeys: "error" | "skip";
  },
  many = false,
): void {
  if (step.missingKeys === "error" && left.missing + right.missing > 0)
    bulkInvalid(
      `Missing keys: source/left ${left.missing}, target/right ${right.missing}. Choose an explicit missing-key policy.`,
    );
  if (
    !many &&
    step.duplicates === "error" &&
    left.duplicates + right.duplicates > 0
  )
    bulkInvalid(
      `Duplicate key records: source/left ${left.duplicates}, target/right ${right.duplicates}. Choose an explicit duplicate policy.`,
    );
}

export function applyBulkDatasetStep(
  step: Exclude<BulkStep, { kind: "read" }>,
  datasets: ReadonlyMap<string, BulkDataset>,
  budget: BulkDatasetBudget,
): { data: BulkDataset; receipt: BulkStepReceipt } {
  function get(id: string): BulkDataset {
    const data = datasets.get(id);
    if (data === undefined)
      bulkInvalid(`Step '${id}' is not an earlier result.`);
    return data;
  }
  const counts: Record<string, number> = {};
  let result: BulkDataset;
  switch (step.kind) {
    case "update": {
      const source = get(step.input);
      const match = predicate(source, step, budget);
      const assignments = step.set.map((item) => ({
        index: datasetColumn(source, item.column),
        value: item.value,
      }));
      if (new Set(assignments.map((x) => x.index)).size !== assignments.length)
        bulkInvalid("A column may be assigned only once.");
      let matched = 0,
        updated = 0,
        unchanged = 0;
      result = budget.build(
        source.headers,
        source.rows.length,
        function* () {
          for (const row of source.rows) {
            if (!match(row)) {
              yield row;
              continue;
            }
            matched += 1;
            const cells = [...row.cells];
            let changed = false;
            for (const item of assignments) {
              if (!sameWriteValue(cellAt(row, item.index), item.value)) {
                cells[item.index] = item.value;
                changed = true;
              }
            }
            if (changed) updated += 1;
            else unchanged += 1;
            yield changed ? { ...row, cells } : row;
          }
        },
        binding(source),
      );
      Object.assign(counts, {
        matched,
        updated,
        unchanged,
        unmatched: source.rows.length - matched,
      });
      break;
    }
    case "filter":
    case "remove": {
      const source = get(step.input),
        match = predicate(source, step, budget);
      const selected = source.rows.map((row) => match(row));
      const matched = selected.filter(Boolean).length;
      if (
        step.kind === "remove" &&
        step.mode === "delete_rows" &&
        source.kind !== "bound"
      )
        bulkInvalid("Physical removal requires an original bound target.");
      const physical = step.kind === "remove" && step.mode === "delete_rows";
      const bound = binding(source);
      const removed = physical
        ? source.rows.flatMap((row, i) =>
            selected[i] && row.origin !== null ? [row.origin] : [],
          )
        : [];
      result = budget.build(
        source.headers,
        step.kind === "filter"
          ? matched
          : physical
            ? source.rows.length - matched
            : source.rows.length,
        function* () {
          for (const [i, row] of source.rows.entries()) {
            if (step.kind === "filter") {
              if (selected[i]) yield row;
            } else if (!selected[i]) yield row;
            else if (!physical)
              yield {
                ...row,
                cells: row.cells.map(() => ({ kind: "blank" as const })),
              };
          }
        },
        bound.kind === "bound"
          ? {
              ...bound,
              removedRows: [...bound.removedRows, ...removed],
              replacement:
                bound.replacement ||
                (step.kind === "filter" && matched !== source.rows.length),
            }
          : bound,
      );
      Object.assign(counts, {
        matched,
        removed: step.kind === "remove" ? matched : 0,
        unmatched: source.rows.length - matched,
      });
      break;
    }
    case "keyed_update":
    case "upsert": {
      const source = get(step.source),
        target = get(step.target);
      const sourceKeys = step.keys.map((key) =>
          datasetColumn(source, key.sourceColumn),
        ),
        targetKeys = step.keys.map((key) =>
          datasetColumn(target, key.targetColumn),
        );
      const assignments = step.set.map((item) => ({
        source: datasetColumn(source, item.sourceColumn),
        target: datasetColumn(target, item.targetColumn),
      }));
      if (
        new Set(sourceKeys).size !== sourceKeys.length ||
        new Set(targetKeys).size !== targetKeys.length ||
        new Set(assignments.map((p) => p.target)).size !== assignments.length ||
        assignments.some((p) => targetKeys.includes(p.target))
      )
        bulkInvalid(
          "Key and assignment columns must be unique; key fields cannot be reassigned.",
        );
      const bytes = { value: 0 },
        left = keyIndex(source, sourceKeys, bytes),
        right = keyIndex(target, targetKeys, bytes);
      checkConflicts(left, right, step);
      const changes = new Map<number, BulkRow>();
      const appended: BulkRow[] = [];
      let matched = 0,
        updated = 0,
        unchanged = 0,
        unmatched = 0;
      const selected = [...left.index.values()]
        .flatMap((group) => chosen(group, step.duplicates))
        .sort((a, b) => a - b);
      const mapped = new Set([
        ...targetKeys,
        ...assignments.map((p) => p.target),
      ]);
      for (const sourceOffset of selected) {
        budget.visit();
        const row = source.rows[sourceOffset];
        if (row === undefined) bulkInvalid("Missing selected source record.");
        const key = left.keys[sourceOffset];
        const candidates =
          key === null || key === undefined ? undefined : right.index.get(key);
        const targetOffset =
          candidates === undefined
            ? undefined
            : chosen(candidates, step.duplicates)[0];
        if (targetOffset === undefined) {
          unmatched += 1;
          if (step.kind === "upsert") {
            if (mapped.size !== target.headers.length)
              bulkInvalid(
                "Upsert insertions require every target column to be mapped.",
              );
            const cells: WriteCell[] = target.headers.map(() => ({
              kind: "blank",
            }));
            for (const [i, column] of targetKeys.entries()) {
              const from = sourceKeys[i];
              if (from === undefined) bulkInvalid("Missing key mapping.");
              cells[column] = cellAt(row, from);
            }
            for (const pair of assignments)
              cells[pair.target] = cellAt(row, pair.source);
            appended.push({ cells, origin: null });
          }
          continue;
        }
        matched += 1;
        const prior = target.rows[targetOffset];
        if (prior === undefined) bulkInvalid("Missing target record.");
        const cells = [...prior.cells];
        let changed = false;
        for (const pair of assignments) {
          const value = cellAt(row, pair.source);
          if (!sameWriteValue(cellAt(prior, pair.target), value)) {
            changed = true;
            cells[pair.target] = value;
          }
        }
        if (changed) {
          updated += 1;
          changes.set(targetOffset, { ...prior, cells });
        } else unchanged += 1;
      }
      result = budget.build(
        target.headers,
        target.rows.length + appended.length,
        function* () {
          for (const [i, row] of target.rows.entries())
            yield changes.get(i) ?? row;
          yield* appended;
        },
        binding(target),
      );
      Object.assign(counts, {
        matched,
        updated,
        unchanged,
        sourceUnmatched: unmatched,
        targetUnmatched: target.rows.length - matched,
        inserted: appended.length,
        duplicateSourceSkipped: left.duplicates,
        duplicateTargetSkipped: right.duplicates,
        missingSource: left.missing,
        missingTarget: right.missing,
      });
      break;
    }
    case "replace": {
      const source = get(step.source),
        target = get(step.target);
      if (target.kind !== "bound")
        bulkInvalid("List replacement requires a bound target selection.");
      result = budget.build(
        source.headers,
        source.rows.length,
        function* () {
          for (const row of source.rows)
            yield { cells: row.cells, origin: null };
        },
        {
          kind: "bound",
          basis: target.basis,
          removedRows: [],
          replacement: true,
        },
      );
      Object.assign(counts, {
        inserted: Math.max(0, source.rows.length - target.rows.length),
        removed: Math.max(0, target.rows.length - source.rows.length),
        replaced: source.rows.length,
      });
      break;
    }
    case "append": {
      const inputs = step.inputs.map(get),
        maps = inputs.map((data) =>
          step.columns.map((column) => {
            const index = data.headers.indexOf(column);
            if (index < 0 && step.missingColumns === "error")
              bulkInvalid(
                "Append column schemas differ; map/project names or explicitly fill missing columns with blanks.",
              );
            return index;
          }),
        );
      const count = inputs.reduce((sum, data) => sum + data.rows.length, 0);
      result = budget.build(step.columns, count, function* () {
        for (const [i, data] of inputs.entries()) {
          const columns = maps[i];
          if (columns === undefined) bulkInvalid("Missing append mapping.");
          for (const row of data.rows)
            yield {
              origin: null,
              cells: columns.map((column) =>
                column < 0 ? { kind: "blank" } : cellAt(row, column),
              ),
            };
        }
      });
      Object.assign(counts, { inputs: inputs.length, appended: count });
      break;
    }
    case "join": {
      const left = get(step.left),
        right = get(step.right),
        bytes = { value: 0 };
      const li = keyIndex(
          left,
          step.keys.map((k) => datasetColumn(left, k.sourceColumn)),
          bytes,
        ),
        ri = keyIndex(
          right,
          step.keys.map((k) => datasetColumn(right, k.targetColumn)),
          bytes,
        );
      checkConflicts(li, ri, step, step.manyToMany);
      const selectedLeft = new Set(
        [...li.index.values()].flatMap((g) =>
          chosen(g, step.duplicates, step.manyToMany),
        ),
      );
      const selectedRight = new Set(
        [...ri.index.values()].flatMap((g) =>
          chosen(g, step.duplicates, step.manyToMany),
        ),
      );
      const pairs: [number | null, number | null][] = [];
      const matchedRight = new Set<number>();
      let matched = 0;
      const outputWidth = step.columns.length;
      function add(l: number | null, r: number | null): void {
        budget.visit();
        if (
          (pairs.length + 2) * outputWidth > 1_000_000 ||
          pairs.length >= bulkJobLimits.maxRecords
        )
          bulkBudget("Join expansion exceeds its output budget.");
        pairs.push([l, r]);
      }
      for (const [i, key] of li.keys.entries()) {
        if (key !== null && !selectedLeft.has(i)) continue;
        const matches = key === null ? undefined : ri.index.get(key);
        if (matches === undefined) {
          if (step.join !== "inner") add(i, null);
          continue;
        }
        for (const j of chosen(matches, step.duplicates, step.manyToMany)) {
          add(i, j);
          matched += 1;
          matchedRight.add(j);
        }
      }
      if (step.join === "full")
        for (const [j, key] of ri.keys.entries())
          if (!matchedRight.has(j) && (key === null || selectedRight.has(j)))
            add(null, j);
      const mapping = step.columns.map((c) => ({
        side: c.side,
        index: datasetColumn(c.side === "left" ? left : right, c.column),
      }));
      result = budget.build(
        step.columns.map((c) => c.as),
        pairs.length,
        function* () {
          for (const [l, r] of pairs)
            yield {
              origin: null,
              cells: mapping.map((c) => {
                const offset = c.side === "left" ? l : r;
                if (offset === null) return { kind: "blank" };
                const row = (c.side === "left" ? left : right).rows[offset];
                if (row === undefined) bulkInvalid("Missing joined record.");
                return cellAt(row, c.index);
              }),
            };
        },
      );
      Object.assign(counts, {
        matchedPairs: matched,
        leftUnmatched:
          li.missing +
          [...selectedLeft].filter((i) => {
            const k = li.keys[i];
            return k === undefined || k === null || !ri.index.has(k);
          }).length,
        rightUnmatched: ri.missing + selectedRight.size - matchedRight.size,
        duplicateLeftSkipped: step.manyToMany ? 0 : li.duplicates,
        duplicateRightSkipped: step.manyToMany ? 0 : ri.duplicates,
        missingLeft: li.missing,
        missingRight: ri.missing,
      });
      break;
    }
    case "deduplicate": {
      const source = get(step.input),
        index = keyIndex(
          source,
          step.keys.map((k) => datasetColumn(source, k)),
          { value: 0 },
          step.missingKeys === "group",
        );
      if (index.missing > 0 && step.missingKeys === "error")
        bulkInvalid(
          "Deduplication has missing keys; choose explicit keep or group behavior.",
        );
      const keep = new Set<number>();
      let groups = 0;
      for (const group of index.index.values()) {
        if (group.length > 1) groups += 1;
        if (step.keep === "duplicates_only") {
          if (group.length > 1) for (const offset of group) keep.add(offset);
        } else if (step.keep === "report")
          for (const offset of group) keep.add(offset);
        else if (step.keep !== "drop_all" || group.length === 1)
          for (const offset of chosen(
            group,
            step.keep === "last" ? "last" : "first",
          ))
            keep.add(offset);
      }
      if (step.keep !== "duplicates_only")
        for (const [i, key] of index.keys.entries())
          if (key === null) keep.add(i);
      const bound = binding(source);
      result = budget.build(
        source.headers,
        keep.size,
        function* () {
          for (const [i, row] of source.rows.entries())
            if (keep.has(i)) yield row;
        },
        bound.kind === "bound"
          ? {
              ...bound,
              replacement:
                bound.replacement || keep.size !== source.rows.length,
            }
          : bound,
      );
      Object.assign(counts, {
        duplicateGroups: groups,
        duplicateRecords: index.duplicates,
        removed:
          step.keep === "duplicates_only" ? 0 : source.rows.length - keep.size,
        excluded:
          step.keep === "duplicates_only" ? source.rows.length - keep.size : 0,
        missingKeys: index.missing,
      });
      break;
    }
    case "sort": {
      const source = get(step.input),
        order = step.by.map((item) => ({
          ...item,
          index: datasetColumn(source, item.column),
        }));
      let collator: Intl.Collator | undefined;
      if (step.locale !== undefined) {
        if (Intl.Collator.supportedLocalesOf([step.locale]).length !== 1)
          bulkInvalid("The requested sort locale is unavailable.");
        collator = new Intl.Collator(step.locale, {
          usage: "sort",
          sensitivity: "variant",
        });
      }
      const rank = {
        blank: 0,
        boolean: 1,
        number: 2,
        date: 3,
        datetime: 4,
        text: 5,
      };
      const rows = source.rows.map((row, index) => ({ row, index }));
      rows.sort((a, b) => {
        budget.visit();
        for (const item of order) {
          const l = cellAt(a.row, item.index),
            r = cellAt(b.row, item.index);
          const le = l.kind === "blank",
            re = r.kind === "blank";
          if (le || re) {
            if (le !== re)
              return (le ? -1 : 1) * (item.blanks === "first" ? 1 : -1);
            continue;
          }
          let compared = 0;
          if (l.kind !== r.kind) {
            if (step.mixedTypes === "error")
              bulkInvalid(
                "Sorting mixed cell types requires explicit type_order.",
              );
            compared = rank[l.kind] - rank[r.kind];
          } else {
            const x = canonicalWriteValue(l),
              y = canonicalWriteValue(r);
            if (typeof x === "string" && typeof y === "string")
              compared =
                collator?.compare(x, y) ?? (x < y ? -1 : x > y ? 1 : 0);
            else if (typeof x === "number" && typeof y === "number")
              compared = x < y ? -1 : x > y ? 1 : 0;
            else if (typeof x === "boolean" && typeof y === "boolean")
              compared = Number(x) - Number(y);
          }
          if (compared !== 0)
            return compared * (item.direction === "asc" ? 1 : -1);
        }
        return a.index - b.index;
      });
      result = budget.build(
        source.headers,
        rows.length,
        function* () {
          for (const item of rows) yield item.row;
        },
        binding(source),
      );
      Object.assign(counts, { sorted: rows.length });
      break;
    }
    case "project": {
      const source = get(step.input),
        columns = step.columns.map((c) => datasetColumn(source, c.column));
      result = budget.build(
        step.columns.map((c) => c.as),
        source.rows.length,
        function* () {
          for (const row of source.rows)
            yield {
              ...row,
              cells: columns.map((column) => cellAt(row, column)),
            };
        },
        binding(source),
      );
      Object.assign(counts, { columns: columns.length });
      break;
    }
    case "transform": {
      const source = get(step.input),
        headers = [...source.headers];
      const transforms = step.transformations.map((item) => {
        const name = item.kind === "convert" ? item.spec.column : item.column;
        let index = headers.indexOf(name);
        if (index < 0) {
          if (item.kind !== "constant")
            bulkInvalid("Only an explicit constant may add a column.");
          headers.push(name);
          index = headers.length - 1;
        }
        if (item.kind === "case") {
          try {
            if (Intl.Collator.supportedLocalesOf([item.locale]).length !== 1)
              bulkInvalid("The transformation locale is unavailable.");
          } catch {
            bulkInvalid("The transformation locale is invalid or unavailable.");
          }
        }
        if (
          item.kind === "convert" &&
          (item.spec.type === "time" || item.spec.type === "duration")
        )
          bulkInvalid("Time-only and duration output cells are unsupported.");
        return {
          item,
          index,
          reading:
            item.kind === "convert"
              ? explicitReading(item.spec, {})
              : undefined,
        };
      });
      let failures = 0,
        changed = 0;
      result = budget.build(
        headers,
        source.rows.length,
        function* () {
          for (const row of source.rows) {
            const cells = [...row.cells];
            while (cells.length < headers.length) cells.push({ kind: "blank" });
            let rowChanged = false;
            for (const { item, index, reading } of transforms) {
              const prior = cells[index];
              if (prior === undefined)
                bulkInvalid("Missing transformation column.");
              let next: WriteCell = prior;
              try {
                if (item.kind === "constant") next = item.value;
                else if (prior.kind !== "blank") {
                  if (item.kind === "trim" || item.kind === "case") {
                    if (prior.kind !== "text")
                      bulkInvalid(
                        "Text transformations require text cells or explicit conversion.",
                      );
                    next = {
                      kind: "text",
                      value:
                        item.kind === "trim"
                          ? prior.value.trim()
                          : item.direction === "upper"
                            ? prior.value.toLocaleUpperCase(item.locale)
                            : prior.value.toLocaleLowerCase(item.locale),
                    };
                  } else {
                    if (reading === undefined)
                      bulkInvalid("Missing conversion reading.");
                    const value = observeTyped(canonicalWriteValue(prior), {
                      column: index + 1,
                      letter: "",
                      spec: item.spec,
                      reading,
                    });
                    if (value.status === "missing") next = { kind: "blank" };
                    else if (value.status !== "read")
                      bulkInvalid(
                        "A value cannot satisfy the explicit conversion.",
                      );
                    else
                      next = writeCellSchema.parse({
                        kind:
                          item.spec.type === "date" &&
                          typeof value.value === "string" &&
                          value.value.includes("T")
                            ? "datetime"
                            : item.spec.type,
                        value: value.value,
                      });
                  }
                }
              } catch {
                failures += 1;
                if (step.onError === "error")
                  bulkInvalid(
                    `A transformation failed at selected record ${row.origin ?? 0}; no output was published.`,
                  );
                if (step.onError === "blank") next = { kind: "blank" };
              }
              if (!sameWriteValue(prior, next)) rowChanged = true;
              cells[index] = next;
            }
            if (rowChanged) changed += 1;
            yield { ...row, cells };
          }
        },
        binding(source),
      );
      Object.assign(counts, { changed, conversionFailures: failures });
      break;
    }
    default: {
      const exhaustive: never = step;
      return exhaustive;
    }
  }
  return {
    data: result,
    receipt: {
      id: step.id,
      kind: step.kind,
      records: result.rows.length,
      counts,
    },
  };
}
