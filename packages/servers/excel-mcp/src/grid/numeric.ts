import { SezzleeExcelError } from "../platform/errors.js";

export interface SumState {
  sum: number;
  compensation: number;
}

export function finite(value: number): number {
  if (!Number.isFinite(value))
    throw new SezzleeExcelError(
      "numeric_overflow",
      "A metric calculation exceeded the finite number range.",
      "Narrow the range or scale the numeric values.",
    );
  return value;
}

export function accumulate(state: SumState, value: number): void {
  const total = finite(state.sum + value);
  state.compensation = finite(
    state.compensation +
      (Math.abs(state.sum) >= Math.abs(value)
        ? state.sum - total + value
        : value - total + state.sum),
  );
  state.sum = total;
}
