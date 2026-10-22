import { asciiUpper } from "@sezzlee/file-core";
import { maxColumn, maxRow } from "../../grid/range.js";
import { SezzleeExcelError } from "../../platform/errors.js";
import { cellText, stringItemVisitor } from "./shared-strings.js";
import { namespaces, type PartScan, type XmlVisitor } from "./xml.js";
import { metadataIndex } from "./rich-data.js";

export type RawValue =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "error"; readonly value: string }
  | { readonly kind: "date"; readonly value: string }
  | { readonly kind: "none" };

/**
 * A formula as the part stores it. A shared formula is written once, on the
 * group's first cell; the other cells of the group carry only its index, so
 * their `text` is undefined until the group is expanded.
 */
export type RawFormula =
  | { readonly kind: "normal"; readonly text: string }
  | {
      readonly kind: "array";
      readonly text: string;
      readonly ref: string | undefined;
    }
  | {
      readonly kind: "shared";
      readonly group: number;
      readonly text: string | undefined;
      readonly ref: string | undefined;
    }
  | { readonly kind: "dataTable"; readonly ref: string | undefined };

export interface RawCell {
  readonly row: number;
  readonly column: number;
  readonly value: RawValue;
  readonly style: number;
  readonly formula?: RawFormula;
  readonly vm?: number;
  readonly cm?: number;
}

const cellReference = /^([A-Za-z]{1,3})([1-9][0-9]*)$/;
const none: RawValue = { kind: "none" };

function corrupt(part: string, detail: string): SezzleeExcelError {
  return new SezzleeExcelError(
    "corrupt_workbook",
    `'${part}' ${detail}.`,
    "Open the file in Excel and re-save it as .xlsx.",
  );
}

function columnOf(letters: string): number {
  let column = 0;
  for (const character of asciiUpper(letters)) {
    column = column * 26 + (character.charCodeAt(0) - 64);
  }
  return column;
}

export function positionOf(
  reference: string,
  part: string,
): { readonly row: number; readonly column: number } {
  const match = cellReference.exec(reference);
  const letters = match?.[1];
  const digits = match?.[2];
  if (letters === undefined || digits === undefined) {
    throw corrupt(
      part,
      `holds a cell at '${reference}', which is not a cell reference`,
    );
  }
  const row = Number(digits);
  const column = columnOf(letters);
  if (row > maxRow || column > maxColumn) {
    throw corrupt(
      part,
      `holds a cell at '${reference}', outside the sheet grid`,
    );
  }
  return { row, column };
}

/**
 * Guard: an unnumbered row or cell follows the one before it, and that count
 * was not bounded the way a written reference is: a cell outside any row took
 * row 0 and was reported in a used range of `A0:…`, and the cell after `XFD`
 * or the row after 1,048,576 landed outside the grid. Each is refused as a
 * written reference outside the grid is.
 */
export function nextPosition(
  row: number,
  column: number,
  part: string,
): { readonly row: number; readonly column: number } {
  if (row < 1 || row > maxRow || column + 1 > maxColumn) {
    throw corrupt(
      part,
      `holds an unnumbered cell after row ${row}, column ${column}, outside the sheet grid`,
    );
  }
  return { row, column: column + 1 };
}

export function rowOf(
  attribute: string | undefined,
  previous: number,
  part: string,
): number {
  if (attribute === undefined) {
    if (previous + 1 > maxRow)
      throw corrupt(
        part,
        `holds an unnumbered row after row ${previous}, outside the sheet grid`,
      );
    return previous + 1;
  }
  const row = Number(attribute);
  if (!Number.isInteger(row) || row < 1 || row > maxRow) {
    throw corrupt(part, `holds a row numbered '${attribute}'`);
  }
  return row;
}

function valueOf(
  type: string,
  text: string | undefined,
  inline: string | undefined,
  strings: readonly string[],
): RawValue {
  switch (type) {
    case "s": {
      if (text === undefined) return none;
      const index = Number(text.trim());
      if (!Number.isInteger(index) || index < 0) return none;
      const value = strings.at(index);
      return value === undefined ? none : { kind: "string", value };
    }
    case "str":
      return text === undefined
        ? none
        : { kind: "string", value: cellText(text) };
    /**
     * Guard: an inline string cell with no `<is>` reads as the empty string, as
     * SheetJS reads it. The used range counts such a cell, and Izmir's
     * open-data exports write 127k of them in one sheet, so `none` would
     * silently shrink those sheets' used ranges during the migration.
     */
    case "inlineStr": {
      const value = inline ?? text ?? "";
      return { kind: "string", value };
    }
    case "b": {
      const flag = text?.trim();
      if (flag === "1" || flag === "true")
        return { kind: "boolean", value: true };
      if (flag === "0" || flag === "false")
        return { kind: "boolean", value: false };
      return none;
    }
    case "e":
      return text === undefined ? none : { kind: "error", value: text.trim() };
    case "d":
      return text === undefined ? none : { kind: "date", value: text.trim() };
    default: {
      const trimmed = text?.trim();
      if (trimmed === undefined || trimmed === "") return none;
      const value = Number(trimmed);
      return Number.isNaN(value) ? none : { kind: "number", value };
    }
  }
}

interface FormulaDraft {
  readonly type: string | undefined;
  readonly group: string | undefined;
  readonly ref: string | undefined;
  text: string;
}

function formulaOf(draft: FormulaDraft): RawFormula {
  switch (draft.type) {
    case "shared": {
      const group = Number(draft.group);
      if (draft.group === undefined || !Number.isInteger(group)) {
        return { kind: "normal", text: draft.text };
      }
      return {
        kind: "shared",
        group,
        text: draft.text === "" ? undefined : draft.text,
        ref: draft.ref,
      };
    }
    case "array":
      return { kind: "array", text: draft.text, ref: draft.ref };
    case "dataTable":
      return { kind: "dataTable", ref: draft.ref };
    default:
      return { kind: "normal", text: draft.text };
  }
}

interface CellDraft {
  readonly row: number;
  readonly column: number;
  readonly type: string;
  readonly style: number;
  readonly vm: number | undefined;
  readonly cm: number | undefined;
  value: string | undefined;
  inline: string | undefined;
  formula: FormulaDraft | undefined;
}

/**
 * Hands every stored cell of one worksheet part to `onCell`, in the order the
 * part stores them. A row or cell without an `r` attribute follows the one
 * before it, as ECMA-376 allows.
 */
export function cellScan(
  sheetPart: string,
  strings: readonly string[],
  onCell: (cell: RawCell) => void,
): PartScan<void> {
  let inSheetData = false;
  let row = 0;
  let column = 0;
  let cell: CellDraft | undefined;
  let capture: "value" | "formula" | undefined;
  let text = "";
  const inline = stringItemVisitor("is", (value) => {
    if (cell !== undefined) cell.inline = value;
  });

  const visitor: XmlVisitor = {
    onOpen(node) {
      if (node.uri !== namespaces.spreadsheetml) return;
      if (cell !== undefined) {
        inline.onOpen(node);
        if (node.local === "v") {
          capture = "value";
          text = "";
        } else if (node.local === "f") {
          capture = "formula";
          text = "";
          cell.formula = {
            type: node.attr("t"),
            group: node.attr("si"),
            ref: node.attr("ref"),
            text: "",
          };
        }
        return;
      }
      if (node.local === "sheetData") {
        inSheetData = true;
      } else if (inSheetData && node.local === "row") {
        row = rowOf(node.attr("r"), row, sheetPart);
        column = 0;
      } else if (inSheetData && node.local === "c") {
        const reference = node.attr("r");
        const position =
          reference === undefined
            ? nextPosition(row, column, sheetPart)
            : positionOf(reference, sheetPart);
        column = position.column;
        const style = Number(node.attr("s") ?? "0");
        cell = {
          row: position.row,
          column: position.column,
          type: node.attr("t") ?? "n",
          style: Number.isInteger(style) && style >= 0 ? style : 0,
          vm: metadataIndex(node.attr("vm"), sheetPart, "value metadata"),
          cm: metadataIndex(node.attr("cm"), sheetPart, "cell metadata"),
          value: undefined,
          inline: undefined,
          formula: undefined,
        };
      }
    },
    onText(chunk) {
      if (cell === undefined) return;
      inline.onText(chunk);
      if (capture !== undefined) text += chunk;
    },
    onClose(local, uri) {
      if (uri !== namespaces.spreadsheetml) return;
      if (cell === undefined) {
        if (local === "sheetData") inSheetData = false;
        return;
      }
      inline.onClose(local, uri);
      if (local === "v" && capture === "value") {
        cell.value = text;
        capture = undefined;
      } else if (local === "f" && capture === "formula") {
        if (cell.formula !== undefined) cell.formula.text = text;
        capture = undefined;
      } else if (local === "c") {
        const value = valueOf(cell.type, cell.value, cell.inline, strings);
        onCell({
          row: cell.row,
          column: cell.column,
          value,
          style: cell.style,
          ...(cell.vm === undefined ? {} : { vm: cell.vm }),
          ...(cell.cm === undefined ? {} : { cm: cell.cm }),
          ...(cell.formula === undefined
            ? {}
            : { formula: formulaOf(cell.formula) }),
        });
        cell = undefined;
      }
    },
  };
  return { visitor, finish: () => undefined };
}
