import {
  maxColumn,
  maxRow,
  lettersToColumn,
  columnToLetters,
} from "../grid/range.js";
import { SezzleeExcelError } from "../platform/errors.js";
import { structuredReferenceAt } from "./structured-reference.js";

export interface FormulaReference {
  readonly sheet: string | undefined;
  readonly column: number | undefined;
  readonly row: number | undefined;
  readonly absoluteColumn: boolean;
  readonly absoluteRow: boolean;
  readonly boundary: "single" | "start" | "end";
  readonly qualified: boolean;
}
export type ReferenceMapper = (
  reference: FormulaReference,
) => FormulaReference | "#REF!";

function unsupported(): never {
  throw new SezzleeExcelError(
    "invalid_argument",
    "This operation affects an unsupported formula reference (external, 3D, spill or array syntax).",
  );
}

function rendered(ref: FormulaReference, qualified: boolean): string {
  const sheet =
    qualified && ref.sheet !== undefined
      ? `'${ref.sheet.replace(/'/g, "''")}'!`
      : "";
  return (
    sheet +
    (ref.column === undefined
      ? ""
      : `${ref.absoluteColumn ? "$" : ""}${columnToLetters(ref.column)}`) +
    (ref.row === undefined ? "" : `${ref.absoluteRow ? "$" : ""}${ref.row}`)
  );
}

export function transformFormula(
  text: string,
  owner: string,
  map: ReferenceMapper,
  destinationOwner?: string,
): string {
  let at = 0;
  let out = "";
  let inherited: string | undefined;
  let rangeStart:
    { offset: number; reference: FormulaReference | "#REF!" } | undefined;
  while (at < text.length) {
    const ch = text[at];
    if (ch === '"') {
      const start = at++;
      for (;;) {
        if (at >= text.length) unsupported();
        if (text[at++] !== '"') continue;
        if (text[at] !== '"') break;
        at += 1;
      }
      out += text.slice(start, at);
      inherited = undefined;
      continue;
    }
    const previousCharacter = text[at - 1];
    const structured =
      previousCharacter !== undefined &&
      /[\p{L}\p{N}_.\\]/u.test(previousCharacter)
        ? undefined
        : structuredReferenceAt(text, at);
    if (structured !== undefined) {
      out += structured.raw;
      at = structured.end;
      inherited = undefined;
      continue;
    }
    if (
      ch === "[" ||
      ch === "]" ||
      ch === "{" ||
      ch === "}" ||
      (ch === "#" &&
        !/^#(?:REF!|N\/A|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)/.test(
          text.slice(at),
        ))
    )
      unsupported();
    if (ch === "#") {
      const error = /^#(?:REF!|N\/A|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)/.exec(
        text.slice(at),
      )?.[0];
      if (error !== undefined) {
        out += error;
        at += error.length;
        continue;
      }
    }
    if (ch === "!" || (ch === ":" && rangeStart === undefined)) unsupported();
    const before = text[at - 1];
    if (before !== undefined && /[\p{L}\p{N}_.]/u.test(before)) {
      out += ch;
      at += 1;
      continue;
    }
    const rest = text.slice(at);
    const qualifier =
      /^(?:'((?:[^']|'')+)'|([\p{L}_\\][\p{L}\p{N}_.\\]*))!/u.exec(rest);
    const prefix = qualifier?.[0] ?? "";
    const sheet =
      qualifier === null
        ? inherited
        : (qualifier[1]?.replace(/''/g, "'") ?? qualifier[2]);
    if (sheet?.includes(":") || sheet?.includes("[") || sheet?.includes("]"))
      unsupported();
    const coordinate = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]*)/.exec(
      rest.slice(prefix.length),
    );
    const wholeColumn =
      coordinate === null
        ? /^(\$?)([A-Za-z]{1,3})(?=:|$|[),+*/ -])/.exec(
            rest.slice(prefix.length),
          )
        : null;
    const wholeRow =
      coordinate === null && wholeColumn === null
        ? /^(\$?)([1-9][0-9]*)(?=:|$|[),+*/ -])/.exec(rest.slice(prefix.length))
        : null;
    const token = coordinate?.[0] ?? wholeColumn?.[0] ?? wholeRow?.[0];
    const fullAxis = coordinate === null;
    const colonContext =
      text[at + prefix.length + (token?.length ?? 0)] === ":" || before === ":";
    if (
      token === undefined ||
      (fullAxis && !colonContext) ||
      /[\p{L}\p{N}_.(]/u.test(text[at + prefix.length + token.length] ?? "")
    ) {
      if (qualifier !== null) unsupported();
      out += ch;
      at += 1;
      inherited = ch === ":" ? inherited : undefined;
      continue;
    }
    const letters = coordinate?.[2] ?? wholeColumn?.[2];
    let column: number | undefined;
    try {
      column = letters === undefined ? undefined : lettersToColumn(letters);
    } catch {
      out += ch;
      at += 1;
      continue;
    }
    const rowText = coordinate?.[4] ?? wholeRow?.[2];
    const row = rowText === undefined ? undefined : Number(rowText);
    if (row !== undefined && row > maxRow) unsupported();
    const ref: FormulaReference = {
      sheet: sheet ?? owner,
      column,
      row,
      absoluteColumn: (coordinate?.[1] ?? wholeColumn?.[1]) === "$",
      absoluteRow: (coordinate?.[3] ?? wholeRow?.[1]) === "$",
      boundary:
        text[at + prefix.length + token.length] === ":"
          ? "start"
          : before === ":"
            ? "end"
            : "single",
      qualified: qualifier !== null,
    };
    const mapped = map(ref);
    const beginning = out.length;
    const previous = rangeStart;
    const invalidRange =
      ref.boundary === "end" &&
      previous !== undefined &&
      (previous.reference === "#REF!" ||
        mapped === "#REF!" ||
        (previous.reference.column !== undefined &&
          mapped.column !== undefined &&
          previous.reference.column > mapped.column) ||
        (previous.reference.row !== undefined &&
          mapped.row !== undefined &&
          previous.reference.row > mapped.row));
    if (invalidRange && previous !== undefined)
      out = out.slice(0, previous.offset) + "#REF!";
    else if (
      mapped !== "#REF!" &&
      ((mapped.column !== undefined &&
        (mapped.column < 1 || mapped.column > maxColumn)) ||
        (mapped.row !== undefined && (mapped.row < 1 || mapped.row > maxRow)))
    ) {
      out += "#REF!";
    } else if (mapped === "#REF!") out += mapped;
    else if (
      mapped.sheet === ref.sheet &&
      mapped.row === ref.row &&
      mapped.column === ref.column &&
      (destinationOwner === undefined || mapped.sheet === destinationOwner)
    )
      out += prefix + token;
    else if (qualifier !== null && mapped.sheet === ref.sheet)
      out += prefix + rendered(mapped, false);
    else
      out += rendered(
        mapped,
        qualifier !== null ||
          (ref.boundary !== "end" &&
            (mapped.sheet !== ref.sheet ||
              (destinationOwner !== undefined &&
                mapped.sheet !== destinationOwner))),
      );
    if (ref.boundary === "start")
      rangeStart = { offset: beginning, reference: mapped };
    else if (ref.boundary === "end") rangeStart = undefined;
    at += prefix.length + token.length;
    inherited = text[at] === ":" ? ref.sheet : undefined;
  }
  return out;
}

export function copyFormula(
  text: string,
  owner: string,
  rows: number,
  columns: number,
): string {
  return transformFormula(text, owner, (ref) => ({
    ...ref,
    row: ref.row === undefined || ref.absoluteRow ? ref.row : ref.row + rows,
    column:
      ref.column === undefined || ref.absoluteColumn
        ? ref.column
        : ref.column + columns,
  }));
}
