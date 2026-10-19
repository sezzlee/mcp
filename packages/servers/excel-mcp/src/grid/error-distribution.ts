import { truncateWellFormed } from "@sezzlee/file-core";
import { limits } from "../platform/limits.js";
import type { CellError } from "./cell-value.js";

interface ErrorCodeCount {
  readonly code: string;
  count: number;
  readonly examples: string[];
}

interface OtherError {
  readonly cell: string;
  readonly code: string;
  readonly truncatedFrom?: number;
}

export interface ErrorDistribution {
  readonly scope: "metricInputs";
  readonly total: number;
  readonly byCode: readonly {
    readonly code: string;
    readonly count: number;
    readonly examples: readonly string[];
  }[];
  readonly other?: {
    readonly count: number;
    readonly examples: readonly OtherError[];
  };
}

export class ErrorTally {
  #total = 0;
  readonly #codes = new Map<string, ErrorCodeCount>();
  #otherCount = 0;
  readonly #otherExamples: OtherError[] = [];

  add(error: CellError, address: string, weight: number): void {
    this.#total += weight;
    const code = error.error;
    let bucket =
      code.length <= limits.maxErrorCodeChars
        ? this.#codes.get(code)
        : undefined;
    if (
      bucket === undefined &&
      code.length <= limits.maxErrorCodeChars &&
      this.#codes.size < limits.maxErrorCodes
    ) {
      bucket = { code, count: 0, examples: [] };
      this.#codes.set(code, bucket);
    }
    if (bucket !== undefined) {
      bucket.count += weight;
      if (bucket.examples.length < limits.maxErrorExamples)
        bucket.examples.push(address);
      return;
    }
    this.#otherCount += weight;
    if (this.#otherExamples.length < limits.maxErrorExamples) {
      this.#otherExamples.push({
        cell: address,
        code: truncateWellFormed(code, limits.maxErrorCodeChars),
        ...(code.length > limits.maxErrorCodeChars
          ? { truncatedFrom: code.length }
          : {}),
      });
    }
  }

  report(): ErrorDistribution | undefined {
    if (this.#total === 0) return undefined;
    const byCode = [...this.#codes.values()].sort((left, right) =>
      left.code < right.code ? -1 : left.code > right.code ? 1 : 0,
    );
    return {
      scope: "metricInputs",
      total: this.#total,
      byCode,
      ...(this.#otherCount === 0
        ? {}
        : {
            other: { count: this.#otherCount, examples: this.#otherExamples },
          }),
    };
  }
}
