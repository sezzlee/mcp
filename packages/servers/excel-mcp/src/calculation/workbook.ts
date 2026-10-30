import { fold } from "@sezzlee/file-core";
import { SezzleeExcelError } from "../platform/errors.js";
import { formatCellRef } from "../grid/range.js";
import { unescapeXstring } from "../metadata/spreadsheetml/shared-strings.js";
import {
  PreservedWorkbook,
  gridOf,
  keyOf,
  rowOf,
  columnOf,
  renderGrid,
  rewriteCell,
  boundsOf,
} from "../format/preserved-workbook.js";
import { inspectWorkbookEdit } from "../format/edit-inspection.js";
import {
  xmlNodes,
  spreadsheetNamespace as main,
  setXmlChild,
} from "../format/presentation-xml.js";
import { attribute, xmlEscape, xmlUnescape } from "../format/xml-edit.js";
import { structuredAsA1 } from "../format/formula-authoring.js";
import { mapStructuredFormula } from "../format/structured-reference.js";
import {
  CalculationBudget,
  calculationFunctions,
  calculationLimits,
  parseCalculation,
  UnsupportedCalculation,
} from "./syntax.js";
import {
  evaluateCalculation,
  type CalculationAtom,
  type CalculationValue,
} from "./evaluate.js";

function blocked(reason: string): CalculationAtom {
  return { kind: "unsupported", reason };
}
function failure(code: string): CalculationAtom {
  return { kind: "error", code };
}
function resource(message: string): never {
  throw new SezzleeExcelError("resource_limit", message);
}

function decoded(value: string): string {
  return unescapeXstring(xmlUnescape(value));
}
function encoded(value: string): string {
  return xmlEscape(
    value
      .replace(/_x[0-9a-fA-F]{4}_/g, (match) => `_x005F_${match.slice(1)}`)
      .replace(/[\s\S]/g, (character) => {
        const code = character.charCodeAt(0);
        return (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
          code === 65534 ||
          code === 65535
          ? `_x${code.toString(16).padStart(4, "0")}_`
          : character;
      }),
  );
}

function textNodes(xml: string): string {
  return xmlNodes(xml, "t")
    .filter(
      (node) =>
        node.parent === "is" || node.parent === "si" || node.parent === "r",
    )
    .map((node) => decoded(xml.slice(node.openEnd, node.closeStart)))
    .join("");
}

function dateSerial(value: string, date1904: boolean): CalculationAtom {
  if (
    !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?)?$/.test(
      value,
    )
  )
    return failure("#VALUE!");
  if (!date1904 && /^1900-02-29(?:T|$)/.test(value))
    return blocked(
      "The fictitious 1900 leap day must use its numeric serial representation.",
    );
  const timestamp = Date.parse(
    value.includes("T") && !/(?:Z|[+-]\d\d:\d\d)$/.test(value)
      ? value + "Z"
      : value,
  );
  if (!Number.isFinite(timestamp)) return failure("#VALUE!");
  if (date1904) return (timestamp - Date.UTC(1904, 0, 1)) / 86_400_000;
  return (
    (timestamp - Date.UTC(1899, 11, 31)) / 86_400_000 +
    (timestamp >= Date.UTC(1900, 2, 1) ? 1 : 0)
  );
}

export function calculateWorkbook(bytes: Buffer) {
  const inspection = inspectWorkbookEdit(bytes, []);
  if (inspection.blockers.length > 0)
    throw new SezzleeExcelError(
      "invalid_argument",
      `Calculation cannot safely preserve this source's unsupported editing features: ${inspection.blockers.map((blocker) => blocker.code).join(", ")}.`,
      inspection.blockers.some(
        (blocker) =>
          blocker.code === "protected_sheet" ||
          blocker.code === "protected_workbook",
      )
        ? "For a calculated and protected output, calculate before applying protection. If the task authorizes removing existing protection, use prepare_edit and edit_workbook with unprotect_sheet/unprotect_workbook and any required password, calculate that version, then restore the requested protection. Other listed blockers still apply. Retrying the unchanged protected version cannot resolve this refusal."
        : "Retrying the unchanged source cannot resolve these blockers. Keep the existing output and report that its formulas still require calculation in a compatible spreadsheet application; do not claim that cached values were recalculated.",
    );
  const workbook = new PreservedWorkbook(bytes);
  const workbookPart = workbook.workbookPart(),
    workbookXml = workbook.xml(workbookPart);
  const calc = xmlNodes(workbookXml, "calcPr", "workbook")[0];
  if (
    ["1", "true"].includes(calc?.attributes.get("iterate") ?? "") ||
    calc?.attributes.get("refMode") === "R1C1" ||
    ["0", "false"].includes(calc?.attributes.get("fullPrecision") ?? "")
  )
    throw new SezzleeExcelError(
      "invalid_argument",
      "Iterative calculation, R1C1 formulas and precision-as-displayed are unsupported.",
    );
  const date1904 = ["1", "true"].includes(
    xmlNodes(workbookXml, "workbookPr")[0]?.attributes.get("date1904") ?? "",
  );
  const budget = new CalculationBudget();
  const sheets = workbook.sheets().map((sheet) => ({
    ...sheet,
    grid: gridOf(workbook.xml(sheet.part), sheet.part),
  }));
  if (sheets.length > 128) resource("Calculation exceeds 128 worksheets.");
  if (
    sheets.reduce((count, sheet) => count + sheet.grid.cells.size, 0) >
    calculationLimits.maxCells
  )
    resource("Calculation exceeds 100,000 stored cells.");
  if (
    sheets.some((sheet) =>
      sheet.grid.groups.some(
        (group) => group.kind !== "normal" && group.kind !== "shared",
      ),
    )
  )
    throw new SezzleeExcelError(
      "invalid_argument",
      "Calculation cannot safely update array or data-table formula groups.",
    );
  const sheetMap = new Map(sheets.map((sheet) => [fold(sheet.name), sheet]));
  const sharedPart = [
    ...workbook.opc().relationshipsFor(workbookPart).values(),
  ].find((rel) => rel.type.endsWith("/sharedStrings"));
  const sharedXml =
    sharedPart?.kind === "internal"
      ? workbook.xml(sharedPart.target)
      : undefined;
  const strings =
    sharedXml === undefined
      ? []
      : xmlNodes(sharedXml, "si").map((node) =>
          textNodes(
            `<root xmlns="${main}">${sharedXml.slice(node.start, node.end)}</root>`,
          ),
        );
  const names = xmlNodes(workbookXml, "definedName", "definedNames").map(
    (node) => ({
      name: decoded(node.attributes.get("name") ?? ""),
      sheet: node.attributes.get("localSheetId"),
      reference: xmlUnescape(workbookXml.slice(node.openEnd, node.closeStart)),
    }),
  );
  if (names.length > 10_000)
    resource("Calculation exceeds 10,000 defined names.");
  const cache = new Map<string, CalculationAtom>(),
    active: string[] = [],
    cycles = new Set<string>();
  const dependencies = new Map<string, Set<string>>();
  const identity = (sheet: string, key: number) => `${sheet}\u0000${key}`;
  let formulaCount = 0;
  for (const sheet of sheets)
    for (const cell of sheet.grid.cells.values())
      if (cell.formula !== undefined) formulaCount += 1;
  if (formulaCount > calculationLimits.maxFormulas)
    resource("Calculation exceeds 10,000 formula cells.");

  function cellValue(
    sheet: (typeof sheets)[number],
    key: number,
    depth: number,
  ): CalculationAtom {
    budget.tick(depth);
    const cell = sheet.grid.cells.get(key);
    if (cell === undefined) return null;
    const id = identity(sheet.name, key);
    const prior = cache.get(id);
    if (cache.has(id)) return prior ?? null;
    if (cell.protectedMetadata)
      return blocked("Rich cell metadata is outside the calculation profile.");
    if (cell.formula !== undefined) {
      const cycle = active.indexOf(id);
      if (cycle >= 0) {
        for (const member of active.slice(cycle)) cycles.add(member);
        return {
          kind: "cycle",
          reason: "A circular formula dependency was detected.",
        };
      }
      if (cell.formulaKind !== undefined && cell.formulaKind !== "normal") {
        const result = blocked(
          `Unsupported formula storage: ${cell.formulaKind}.`,
        );
        cache.set(id, result);
        return result;
      }
      active.push(id);
      let value: CalculationAtom;
      try {
        const text = mapStructuredFormula(
          unescapeXstring(cell.formula),
          (ref) =>
            structuredAsA1(
              workbook,
              ref,
              sheet.name,
              rowOf(key),
              columnOf(key),
            ),
        );
        const expression = parseCalculation(text, budget);
        const evaluated = evaluateCalculation(
          expression,
          (ref) => resolve(ref, sheet, id, depth + 1, new Set()),
          budget,
          depth,
        );
        value =
          typeof evaluated === "object" &&
          evaluated !== null &&
          evaluated.kind === "range"
            ? evaluated.values.length === 1
              ? (evaluated.values[0] ?? null)
              : blocked("Array formula results are unsupported.")
            : evaluated;
        if (value === null) value = 0;
        if (cycles.has(id))
          value = {
            kind: "cycle",
            reason: "A circular formula dependency was detected.",
          };
      } catch (error) {
        if (error instanceof UnsupportedCalculation)
          value = blocked(error.message);
        else throw error;
      } finally {
        active.pop();
      }
      cache.set(id, value);
      return value;
    }
    const raw = cell.value === undefined ? "" : decoded(cell.value);
    switch (cell.type) {
      case "s": {
        const index = Number(raw);
        return Number.isInteger(index) && strings[index] !== undefined
          ? (strings[index] ?? null)
          : failure("#VALUE!");
      }
      case "inlineStr":
        return textNodes(
          `<root xmlns="${main}"${[...cell.bindings]
            .filter(([prefix]) => prefix !== "")
            .map(([prefix, uri]) => ` xmlns:${prefix}="${xmlEscape(uri)}"`)
            .join("")}>${cell.raw}</root>`,
        );
      case "str":
        return raw;
      case "b":
        return raw === "1";
      case "e":
        return [
          "#DIV/0!",
          "#VALUE!",
          "#REF!",
          "#NAME?",
          "#NUM!",
          "#N/A",
          "#NULL!",
        ].includes(raw)
          ? failure(raw)
          : blocked("Unsupported cell error code.");
      case "d":
        return dateSerial(raw, date1904);
      case undefined:
      case "n":
        return cell.value === undefined
          ? null
          : raw.trim() !== "" && Number.isFinite(Number(raw))
            ? Number(raw)
            : failure("#VALUE!");
      default:
        return blocked("Unsupported cell value type.");
    }
  }

  function resolve(
    reference: string,
    current: (typeof sheets)[number],
    owner: string,
    depth: number,
    resolvingNames: Set<string>,
  ): CalculationValue {
    budget.tick(depth);
    const match = /^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?([^!]+)$/.exec(reference);
    if (match === null) return blocked("Unsupported reference syntax.");
    const explicitSheet = match[1]?.replace(/''/g, "'") ?? match[2];
    if (explicitSheet !== undefined && /[[\]]/.test(explicitSheet))
      return blocked("External workbook references are unsupported.");
    const sheet =
      explicitSheet === undefined ? current : sheetMap.get(fold(explicitSheet));
    if (sheet === undefined) return failure("#REF!");
    const address = match[3] ?? "";
    if (
      !/^\$?[A-Za-z]{1,3}\$?[1-9]\d*(?::\$?[A-Za-z]{1,3}\$?[1-9]\d*)?$/.test(
        address,
      )
    ) {
      const scope = String(sheets.indexOf(sheet));
      const candidates = names.filter(
        (name) => fold(name.name) === fold(address),
      );
      const named =
        candidates.find((name) => name.sheet === scope) ??
        candidates.find((name) => name.sheet === undefined);
      if (named === undefined) return failure("#NAME?");
      if (resolvingNames.has(`${scope}:${fold(address)}`))
        return blocked("A named-range cycle is unsupported.");
      resolvingNames.add(`${scope}:${fold(address)}`);
      if (
        !/^(?:(?:'(?:[^']|'')+'|[^!,'\s]+)!)?\$?[A-Za-z]{1,3}\$?[1-9]\d*(?::\$?[A-Za-z]{1,3}\$?[1-9]\d*)?$/.test(
          named.reference,
        )
      )
        return blocked("Only static rectangular named ranges are supported.");
      const namedAddress = named.reference.slice(
        named.reference.lastIndexOf("!") + 1,
      );
      if (
        !/^\$[A-Za-z]{1,3}\$[1-9]\d*(?::\$[A-Za-z]{1,3}\$[1-9]\d*)?$/.test(
          namedAddress,
        )
      )
        return blocked(
          "Relative named ranges require an unsupported name anchor.",
        );
      return resolve(named.reference, sheet, owner, depth + 1, resolvingNames);
    }
    let bounds: ReturnType<typeof boundsOf>;
    try {
      bounds = boundsOf(address.replace(/\$/g, ""));
    } catch (error) {
      if (
        error instanceof SezzleeExcelError &&
        error.code === "invalid_argument"
      )
        return failure("#REF!");
      throw error;
    }
    const rows = bounds.bottom - bounds.top + 1,
      columns = bounds.right - bounds.left + 1;
    if (rows * columns > calculationLimits.maxRangeCells)
      resource("A calculation range exceeds 100,000 cells.");
    const values: CalculationAtom[] = [];
    for (let row = bounds.top; row <= bounds.bottom; row += 1)
      for (let column = bounds.left; column <= bounds.right; column += 1) {
        budget.tick(depth);
        const key = keyOf(row, column),
          dependency = identity(sheet.name, key);
        let edges = dependencies.get(owner);
        if (edges === undefined) {
          edges = new Set();
          dependencies.set(owner, edges);
        }
        edges.add(dependency);
        const value = cellValue(sheet, key, depth + 1);
        values.push(
          typeof value === "object" &&
            value !== null &&
            value.kind !== "error" &&
            !cycles.has(owner)
            ? {
                kind: "dependency",
                reason: `Unavailable dependency: ${sheet.name}!${formatCellRef(row, column)} (${value.kind}).`,
              }
            : value,
        );
      }
    return { kind: "range", values, rows, columns };
  }

  const results: {
    sheetName: string;
    cell: string;
    result: CalculationAtom;
  }[] = [];
  for (const sheet of sheets)
    for (const [key, cell] of sheet.grid.cells) {
      if (cell.formula === undefined) continue;
      const result = cellValue(sheet, key, 0);
      if (cell.protectedMetadata)
        throw new SezzleeExcelError(
          "invalid_argument",
          "A rich formula cache cannot be safely replaced.",
        );
      const wrapper = `<root xmlns="${main}"${[...cell.bindings]
        .filter(([prefix]) => prefix !== "")
        .map(([prefix, uri]) => ` xmlns:${prefix}="${xmlEscape(uri)}"`)
        .join("")}>${cell.raw}</root>`;
      const formula = xmlNodes(wrapper, "f", "c")[0];
      if (formula === undefined)
        throw new SezzleeExcelError(
          "invalid_argument",
          "A formula node disappeared during calculation.",
        );
      const formulaXml = wrapper.slice(formula.start, formula.end);
      const available =
        typeof result !== "object" ||
        result === null ||
        result.kind === "error";
      const type =
        typeof result === "string"
          ? "str"
          : typeof result === "boolean"
            ? "b"
            : typeof result === "object" &&
                result !== null &&
                result.kind === "error"
              ? "e"
              : undefined;
      const serialized =
        typeof result === "object" && result !== null
          ? result.kind === "error"
            ? result.code
            : ""
          : result === null
            ? "0"
            : typeof result === "boolean"
              ? result
                ? "1"
                : "0"
              : String(result);
      const reference = formatCellRef(rowOf(key), columnOf(key));
      const raw = rewriteCell(
        cell,
        reference,
        formulaXml +
          (available ? `<v xmlns="${main}">${encoded(serialized)}</v>` : ""),
        type,
        cell.style,
      );
      sheet.grid.cells.set(key, { ...cell, raw });
      results.push({ sheetName: sheet.name, cell: reference, result });
    }
  for (const sheet of sheets) workbook.put(sheet.part, renderGrid(sheet.grid));
  const unavailable = results.filter(
    ({ result }) =>
      typeof result === "object" && result !== null && result.kind !== "error",
  ).length;
  const errors = results.filter(
    ({ result }) =>
      typeof result === "object" && result !== null && result.kind === "error",
  ).length;
  let calculationXml =
    calc === undefined
      ? `<calcPr xmlns="${main}"/>`
      : workbookXml.slice(calc.start, calc.end);
  for (const [name, value] of [
    ["calcId", "0"],
    ["calcMode", "auto"],
    ["fullCalcOnLoad", "1"],
    ["forceFullCalc", "1"],
  ]) {
    if (name !== undefined && value !== undefined)
      calculationXml = attribute(calculationXml, name, value);
  }
  workbook.put(
    workbookPart,
    setXmlChild(workbookXml, "workbook", "calcPr", calculationXml, [
      "fileVersion",
      "fileSharing",
      "workbookPr",
      "workbookProtection",
      "bookViews",
      "sheets",
      "functionGroups",
      "externalReferences",
      "definedNames",
      "calcPr",
      "oleSize",
      "customWorkbookViews",
      "pivotCaches",
      "smartTagPr",
      "smartTagTypes",
      "webPublishing",
      "fileRecoveryPr",
      "webPublishObjects",
      "extLst",
    ]),
  );
  return {
    bytes: workbook.finish(0).bytes,
    calculation: {
      engine: "bounded-excel-v1",
      functions: calculationFunctions,
      dateSystem: date1904 ? "1904" : "1900",
      formulaCells: formulaCount,
      calculatedCells: formulaCount - unavailable,
      errorCells: errors,
      unavailableCells: unavailable,
      complete: unavailable === 0,
      cacheStatus: unavailable === 0 ? "current" : "partial",
      cachedFormulaValues: formulaCount - unavailable,
      recalculationRequired: unavailable > 0,
      recalculationOnOpen: true,
      dependencies: [...dependencies.values()].reduce(
        (total, edges) => total + edges.size,
        0,
      ),
      results: results
        .slice(0, calculationLimits.maxReportedCells)
        .map(({ sheetName, cell, result }) => ({
          sheetName,
          cell,
          result:
            typeof result === "string" && result.length > 256
              ? { kind: "omitted", valueType: "string", length: result.length }
              : typeof result === "object" &&
                  result !== null &&
                  result.kind !== "error" &&
                  result.reason.length > 256
                ? {
                    ...result,
                    reason: result.reason.slice(0, 256),
                    reasonTruncated: true,
                  }
                : result,
        })),
      omittedResults: Math.max(
        0,
        results.length - calculationLimits.maxReportedCells,
      ),
    },
  };
}
