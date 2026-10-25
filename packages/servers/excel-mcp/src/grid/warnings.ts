import { maxRow, type GridBounds } from "./range.js";

/**
 * Every warning a response can carry. A caller branches on the code; the
 * message is for a person and may change wording between releases.
 */
export const warningCodes = [
  "csv_preamble_ignored",
  "csv_blank_first_record",
  "table_missing_names",
  "header_row_mismatch",
  "header_row_unnamed",
  "header_only_range",
  "uncached_formulas",
  "ambiguous_decimal",
  "locale_separator_conflict",
  "ambiguous_day_order",
  "mixed_date_order",
  "distinct_lower_bound",
  "no_majority_type",
  "identifier_text",
  "no_reusable_date_format",
  "prefix_sample",
  "columns_not_profiled",
  "mixed_units",
  "mixed_currencies",
  "case_variant_groups",
  "uncomparable_cells",
  "ungrouped_cells",
  "currencies_added",
  "unread_numbers",
  "identifier_cells",
  "unread_booleans",
  "derived_division_by_zero",
  "row_limit_reached",
] as const;

export type WarningCode = (typeof warningCodes)[number];

export interface Warning {
  readonly code: WarningCode;
  readonly message: string;
  /** The column letter the warning is about, when it is about one. */
  readonly column?: string;
}

export function warning(
  code: WarningCode,
  message: string,
  column?: string,
): Warning {
  return column === undefined ? { code, message } : { code, message, column };
}

export function rowLimitWarnings(bounds: GridBounds): Warning[] {
  return bounds.bottom < maxRow
    ? []
    : [
        warning(
          "row_limit_reached",
          `The data reaches row ${maxRow}, the last row an Excel sheet holds. The file was probably cut there: rows after it are missing, so the last period or group can be incomplete.`,
        ),
      ];
}

export function rowLimitGuidance(sheets: readonly string[]): string {
  return sheets.length === 0
    ? ""
    : ` ${sheets.map((name) => JSON.stringify(name)).join(", ")} ${sheets.length === 1 ? "reaches" : "reach"} row ${maxRow}, the last row an Excel sheet holds; the file was probably cut there, so the last period or group can be incomplete.`;
}

/** The warnings in order, each code, column and message once. */
export function distinctWarnings(warnings: readonly Warning[]): Warning[] {
  const seen = new Set<string>();
  return warnings.filter((entry) => {
    const key = JSON.stringify([entry.code, entry.column, entry.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
