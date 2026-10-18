import { CsvError } from "csv-parse";
import { parse } from "csv-parse/sync";
import type { CsvFault, CsvRecords } from "../../src/format/csv-tokenizer.js";

export const anyBreak: readonly string[] = ["\r\n", "\n", "\r"];

const faultFor: Readonly<Record<string, CsvFault["kind"]>> = {
  INVALID_OPENING_QUOTE: "stray_quote",
  CSV_INVALID_CLOSING_QUOTE: "text_after_quote",
  CSV_QUOTE_NOT_CLOSED: "unclosed_quote",
};

export type Outcome = string[][] | string;

/**
 * csv-parse 7 read the way excel-mcp read before its own tokenizer, or, with
 * `anyBreak`, ending a record at every line break form: the reading the
 * tokenizer keeps, written by a second implementation.
 */
export function csvParseOracle(
  text: string,
  delimiter: string,
  recordDelimiter?: readonly string[],
): Outcome {
  try {
    return parse(text, {
      delimiter,
      ...(recordDelimiter === undefined
        ? {}
        : { record_delimiter: [...recordDelimiter] }),
      columns: false,
      relax_column_count: true,
      skip_empty_lines: false,
      bom: false,
      cast: false,
    }) as string[][];
  } catch (error) {
    if (error instanceof CsvError) return faultFor[error.code] ?? error.code;
    throw error;
  }
}

export function outcomeOf(result: CsvRecords): Outcome {
  return result.kind === "records" ? result.records : result.fault.kind;
}

/**
 * Where csv-parse 7.0.2 departs from RFC 4180, so a disagreement of this shape
 * is csv-parse's: it appends a NUL that follows a closing quote to the field,
 * while any other character there is refused.
 */
export function knownCsvParseDeviation(
  text: string,
  actual: Outcome,
): string | undefined {
  return actual === "text_after_quote" && text.includes('"\u0000')
    ? "NUL after a closing quote"
    : undefined;
}
