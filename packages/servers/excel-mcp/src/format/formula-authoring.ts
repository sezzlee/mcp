import { asciiUpper, fold } from "@sezzlee/file-core";
import type { PresentationChange } from "../authoring/presentation.js";
import { presentationLimits } from "../authoring/presentation.js";
import { parseCellRef, formatCellRef, columnToLetters } from "../grid/range.js";
import {
  boundsOf,
  gridOf,
  renderGrid,
  keyOf,
  rowOf,
  columnOf,
  rewriteCell,
  type PreservedWorkbook,
} from "./preserved-workbook.js";
import { xmlEscape } from "./xml-edit.js";
import {
  xmlNodes,
  invalidPresentation,
  presentationBudget,
  spreadsheetNamespace as main,
} from "./presentation-xml.js";
import { copyFormula, transformFormula } from "./formula-edit.js";
import {
  structuredReferenceAt,
  mapStructuredFormula,
  renderStructuredReference,
  type StructuredReference,
} from "./structured-reference.js";
import { workbookTables } from "./table-model.js";
import { occupiedTarget } from "./occupied.js";
import { SezzleeExcelError } from "../platform/errors.js";
import {
  containsCell,
  occupiedCell,
  rangeCells,
} from "./presentation-workbook.js";

export function resolveStructuredReference(
  workbook: PreservedWorkbook,
  ref: StructuredReference,
  sheetName: string,
  row: number,
  column: number,
  allowEmptyRow = false,
) {
  const matches = workbookTables(workbook).filter((t) =>
    ref.name === undefined
      ? t.sheet.name === sheetName &&
        (containsCell(t.bounds, row, column) ||
          (allowEmptyRow &&
            t.bounds.bottom - t.totalsRows === t.bounds.top &&
            row === t.bounds.top + 1 &&
            column >= t.bounds.left &&
            column <= t.bounds.right))
      : fold(t.name) === fold(ref.name) ||
        fold(t.displayName) === fold(ref.name),
  );
  const table = matches[0];
  if (matches.length !== 1 || table === undefined)
    invalidPresentation("A formula refers to a missing or ambiguous table.");
  const columns = ref.columns.map((name) => {
    const index = table.columns.findIndex((c) => fold(c.name) === fold(name));
    if (index < 0)
      invalidPresentation("A formula refers to an unknown table column.");
    return index;
  });
  const first = columns[0] ?? 0,
    last = columns[1] ?? columns[0] ?? table.columns.length - 1;
  if (last < first)
    invalidPresentation("A table column span ends before it starts.");
  let top = table.bounds.top + 1,
    bottom = table.bounds.bottom - table.totalsRows;
  if (ref.selectors.includes("#All")) {
    top = table.bounds.top;
    bottom = table.bounds.bottom;
  } else {
    if (ref.selectors.includes("#Headers")) top = table.bounds.top;
    if (ref.selectors.includes("#Totals")) {
      if (table.totalsRows !== 1)
        invalidPresentation("The formula selects a missing totals row.");
      bottom = table.bounds.bottom;
      if (
        !ref.selectors.includes("#Data") &&
        !ref.selectors.includes("#Headers")
      )
        top = bottom;
    } else if (ref.selectors.length === 1 && ref.selectors[0] === "#Headers")
      bottom = top;
  }
  if (ref.rowContext) {
    const virtualEmpty =
      allowEmptyRow &&
      table.bounds.bottom - table.totalsRows === table.bounds.top &&
      row === table.bounds.top + 1;
    if (
      table.sheet.name !== sheetName ||
      (!virtualEmpty &&
        (row <= table.bounds.top ||
          row > table.bounds.bottom - table.totalsRows))
    )
      invalidPresentation(
        "A table row-context reference must be in that table's data rows.",
      );
    top = row;
    bottom = row;
  }
  return {
    table,
    left: table.bounds.left + first,
    right: table.bounds.left + last,
    top,
    bottom,
  };
}
export function structuredAsA1(
  workbook: PreservedWorkbook,
  ref: StructuredReference,
  sheetName: string,
  row: number,
  column: number,
): string {
  const resolved = resolveStructuredReference(
    workbook,
    ref,
    sheetName,
    row,
    column,
  );
  if (resolved.bottom < resolved.top)
    invalidPresentation(
      "An empty table data reference cannot be converted losslessly to a normal range.",
    );
  const sheet = `'${resolved.table.sheet.name.replace(/'/g, "''")}'!`,
    rowMark = ref.rowContext ? "" : "$";
  const first = `$${columnToLetters(resolved.left)}${rowMark}${resolved.top}`,
    last = `$${columnToLetters(resolved.right)}${rowMark}${resolved.bottom}`;
  return sheet + first + (first === last ? "" : ":" + last);
}
function formulaTokens(text: string) {
  const tokens: {
    kind: "value" | "name" | "operator" | "open" | "close" | "comma";
    text: string;
  }[] = [];
  let at = 0;
  while (at < text.length) {
    const ch = text[at];
    if (ch === undefined) break;
    if (/\s/.test(ch)) {
      at++;
      continue;
    }
    const structured = structuredReferenceAt(text, at);
    if (structured !== undefined) {
      tokens.push({ kind: "value", text: structured.raw });
      at = structured.end;
      continue;
    }
    if (ch === '"') {
      const start = at++;
      let closed = false;
      while (at < text.length) {
        if (text[at++] !== '"') continue;
        if (text[at] === '"') {
          at++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) invalidPresentation("A formula text literal is not closed.");
      tokens.push({ kind: "value", text: text.slice(start, at) });
      continue;
    }
    const reference =
      /^(?:(?:'(?:[^']|'')+'|[\p{L}_\\][\p{L}\p{N}_.\\]*)!)?(?:\$?[A-Za-z]{1,3}\$?[1-9][0-9]*|\$?[A-Za-z]{1,3}(?=:)|\$?[1-9][0-9]*(?=:))/u.exec(
        text.slice(at),
      )?.[0];
    const number = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(at),
    )?.[0];
    const error = /^#(?:REF!|N\/A|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)/.exec(
      text.slice(at),
    )?.[0];
    const name = /^\$?[\p{L}_\\][\p{L}\p{N}_.\\]*|^\$[1-9][0-9]*/u.exec(
      text.slice(at),
    )?.[0];
    const token = reference ?? number ?? error ?? name;
    if (token !== undefined) {
      tokens.push({
        kind:
          reference !== undefined || number !== undefined || error !== undefined
            ? "value"
            : "name",
        text: token,
      });
      at += token.length;
    } else if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push({
        kind: ch === "(" ? "open" : ch === ")" ? "close" : "comma",
        text: ch,
      });
      at++;
    } else {
      const op = /^(?:<>|<=|>=|[+*/^&=<>:%-])/.exec(text.slice(at))?.[0];
      if (op === undefined)
        invalidPresentation(
          "The formula contains unsupported syntax or an external/array reference.",
        );
      tokens.push({ kind: "operator", text: op });
      at += op.length;
    }
    if (tokens.length > presentationLimits.maxFormulaTokens)
      presentationBudget("The formula exceeds its token budget.");
  }
  return tokens;
}
export function validateAuthoredFormula(
  workbook: PreservedWorkbook,
  input: string,
  sheetName: string,
  row: number,
  column: number,
  allowEmptyRow = false,
): string {
  if (
    xmlNodes(workbook.xml(workbook.workbookPart()), "calcPr", "workbook").some(
      (n) => n.attributes.get("refMode") === "R1C1",
    )
  )
    invalidPresentation(
      "Formula authoring requires A1 workbook reference mode.",
    );
  const text = (input.startsWith("=") ? input.slice(1) : input).trim();
  if (
    !text ||
    text.length > presentationLimits.maxFormulaChars ||
    [...text].some((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return (
        (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
        (code >= 0xd800 && code <= 0xdfff) ||
        code === 0xfffe ||
        code === 0xffff
      );
    })
  )
    invalidPresentation(
      "The formula text is empty, too long or not valid XML text.",
    );
  mapStructuredFormula(text, (ref) => {
    resolveStructuredReference(
      workbook,
      ref,
      sheetName,
      row,
      column,
      allowEmptyRow,
    );
    return ref.raw;
  });
  const tokens = formulaTokens(text);
  let at = 0,
    depth = 0;
  const precedence: Readonly<Record<string, number>> = {
    "=": 1,
    "<>": 1,
    "<": 1,
    ">": 1,
    "<=": 1,
    ">=": 1,
    "&": 2,
    "+": 3,
    "-": 3,
    "*": 4,
    "/": 4,
    "^": 5,
    ":": 6,
  };
  function expression(min = 0): void {
    if (++depth > 128)
      presentationBudget("The formula exceeds its nesting budget.");
    let token = tokens[at++];
    if (
      token?.kind === "operator" &&
      (token.text === "+" || token.text === "-")
    ) {
      expression(5);
      token = undefined;
    } else if (token?.kind === "open") {
      expression();
      if (tokens[at++]?.kind !== "close")
        invalidPresentation("A formula parenthesis is not closed.");
    } else if (token?.kind === "value" || token?.kind === "name") {
      if (tokens[at]?.kind === "open") {
        if (
          token.kind !== "name" &&
          !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(token.text)
        )
          invalidPresentation("A function needs an identifier.");
        if (
          /^(?:_xlfn\.)?(?:FILTER|UNIQUE|SORT|SORTBY|SEQUENCE|RANDARRAY|TRANSPOSE|LET|LAMBDA|TAKE|DROP|VSTACK|HSTACK|TOCOL|TOROW)$/i.test(
            token.text,
          )
        )
          invalidPresentation(
            `${asciiUpper(token.text.replace(/^_xlfn\./i, ""))} is a dynamic array or named function, and the server cannot author those formulas.`,
          );
        at++;
        if (tokens[at]?.kind !== "close")
          for (;;) {
            expression();
            if (tokens[at]?.kind !== "comma") break;
            at++;
          }
        if (tokens[at++]?.kind !== "close")
          invalidPresentation("A formula function is not closed.");
      } else if (
        token.kind === "name" &&
        !/^(?:TRUE|FALSE)$/i.test(token.text)
      ) {
        const fullAxis =
          (tokens[at]?.text === ":" || tokens[at - 2]?.text === ":") &&
          /^\$?(?:[A-Za-z]{1,3}|[1-9][0-9]*)$/.test(token.text);
        if (
          !fullAxis &&
          !xmlNodes(
            workbook.xml(workbook.workbookPart()),
            "definedName",
            "definedNames",
          ).some(
            (n) =>
              fold(n.attributes.get("name") ?? "") === fold(token?.text ?? ""),
          )
        ) {
          const unknownName = token.text;
          const table = workbookTables(workbook).find(
            (candidate) =>
              candidate.sheet.name === sheetName &&
              containsCell(candidate.bounds, row, column),
          );
          const tableColumn = table?.columns.find(
            (candidate) => fold(candidate.name) === fold(unknownName),
          );
          throw new SezzleeExcelError(
            "invalid_argument",
            `Formula at ${JSON.stringify(sheetName)}!${formatCellRef(row, column)} refers to unknown defined name ${JSON.stringify(token.text)}.`,
            tableColumn === undefined
              ? "Check describe_workbook definedNames and use an existing name, or define the intended name before authoring this formula."
              : `This is a table column. Use a row-context structured reference such as [@${tableColumn.name}] instead of the bare column name; for example [@Qty]*[@Price].`,
          );
        }
      }
    } else invalidPresentation("The formula needs an operand.");
    while (tokens[at]?.kind === "operator") {
      const op = tokens[at]?.text ?? "";
      if (op === "%") {
        at++;
        continue;
      }
      const level = precedence[op];
      if (level === undefined || level < min) break;
      at++;
      expression(op === "^" ? level : level + 1);
    }
    depth--;
  }
  expression();
  if (at !== tokens.length)
    invalidPresentation("The formula contains trailing or misplaced syntax.");
  transformFormula(text, sheetName, (ref) => {
    if (ref.qualified) workbook.sheet(ref.sheet ?? sheetName);
    return ref;
  });
  return mapStructuredFormula(text, (ref) => {
    const resolved = resolveStructuredReference(
      workbook,
      ref,
      sheetName,
      row,
      column,
      allowEmptyRow,
    );
    return renderStructuredReference(ref, ref.columns, resolved.table.name);
  });
}
export function applyFormulaChange(
  workbook: PreservedWorkbook,
  change: Extract<
    PresentationChange,
    { kind: "write_formula" | "fill_formula" }
  >,
): void {
  const anchorText =
    change.kind === "write_formula" ? change.cell : change.anchor;
  if (anchorText.includes(":"))
    invalidPresentation("A formula anchor must name one cell.");
  const anchor = parseCellRef(anchorText),
    bounds = boundsOf(
      change.kind === "write_formula" ? change.cell : change.range,
    ),
    count = rangeCells(bounds);
  const formula = validateAuthoredFormula(
    workbook,
    change.formula,
    change.sheetName,
    anchor.row,
    anchor.column,
  );
  workbook.guardPresentation(change.sheetName, bounds);
  workbook.presentationEffect("formula", count);
  const part = workbook.sheet(change.sheetName).part,
    grid = gridOf(workbook.xml(part), part),
    tables = workbookTables(workbook);
  workbook.reservePresentationCells(
    count -
      [...grid.cells.keys()].filter((key) =>
        containsCell(bounds, rowOf(key), columnOf(key)),
      ).length,
  );
  for (let row = bounds.top; row <= bounds.bottom; row++)
    for (let column = bounds.left; column <= bounds.right; column++) {
      if (
        tables.some(
          (t) =>
            t.sheet.part === part &&
            row === t.bounds.top &&
            column >= t.bounds.left &&
            column <= t.bounds.right,
        )
      )
        invalidPresentation("An Excel table header must stay literal text.");
      const key = keyOf(row, column),
        cell = grid.cells.get(key);
      if (!change.overwrite && occupiedCell(cell))
        occupiedTarget(change.sheetName, formatCellRef(row, column));
      let text = copyFormula(
        formula,
        change.sheetName,
        row - anchor.row,
        column - anchor.column,
      );
      if (change.kind === "fill_formula" && column !== anchor.column)
        text = mapStructuredFormula(text, (ref) => {
          if (ref.columns.length === 0) return ref.raw;
          const resolved = resolveStructuredReference(
              workbook,
              ref,
              change.sheetName,
              anchor.row,
              anchor.column,
            ),
            shift = column - anchor.column;
          const columns = ref.columns.map(
            (name) =>
              resolved.table.columns[
                resolved.table.columns.findIndex(
                  (c) => fold(c.name) === fold(name),
                ) + shift
              ]?.name,
          );
          if (columns.some((n) => n === undefined)) return "#REF!";
          return renderStructuredReference(
            ref,
            columns.filter((n): n is string => n !== undefined),
          );
        });
      validateAuthoredFormula(workbook, text, change.sheetName, row, column);
      const raw = rewriteCell(
        cell,
        formatCellRef(row, column),
        `<f xmlns="${main}">${xmlEscape(text)}</f>`,
        undefined,
        cell?.style,
      );
      grid.cells.set(key, {
        raw,
        style: cell?.style,
        formula: text,
        formulaKind: undefined,
        formulaRange: undefined,
        sharedIndex: undefined,
        value: undefined,
        type: undefined,
        protectedMetadata: false,
        bindings: cell?.bindings ?? new Map([["", main]]),
      });
    }
  workbook.put(part, renderGrid(grid));
}
