import type { PresentationChange } from "../authoring/presentation.js";
import type { PreservedWorkbook } from "./preserved-workbook.js";
import { boundsOf } from "./preserved-workbook.js";
import {
  maxColumn,
  maxRow,
  resolveRange,
  type GridBounds,
} from "../grid/range.js";
import { intersectsRange } from "./presentation-workbook.js";
import { validateAuthoredFormula } from "./formula-authoring.js";
import { StyleAuthoring } from "./style-authoring.js";
import {
  attribute,
  applyXmlPatches,
  replaceElementBody,
  xmlEscape,
} from "./xml-edit.js";
import {
  invalidPresentation,
  presentationBudget,
  setWorksheetChild,
  spreadsheetNamespace as main,
  xmlNodes,
} from "./presentation-xml.js";

type ValidationChange = Extract<
  PresentationChange,
  { kind: "set_validation" | "remove_validation" }
>;
type ConditionalChange = Extract<
  PresentationChange,
  { kind: "set_conditional_format" | "remove_conditional_format" }
>;

const wholeSheet: GridBounds = {
  top: 1,
  left: 1,
  bottom: maxRow,
  right: maxColumn,
};

export function sqrefAreaBounds(area: string): GridBounds {
  return resolveRange(wholeSheet, area.replaceAll("$", ""));
}

function areaKey(bounds: GridBounds): string {
  return `${bounds.top}:${bounds.left}:${bounds.bottom}:${bounds.right}`;
}

function sameAreas(
  left: readonly GridBounds[],
  right: readonly GridBounds[],
): boolean {
  const keys = (areas: readonly GridBounds[]) =>
    [...new Set(areas.map(areaKey))].sort().join(" ");
  return keys(left) === keys(right);
}

export function validationTargets(change: ValidationChange): GridBounds[] {
  if (change.kind === "remove_validation" && change.ranges !== undefined)
    return change.ranges.map(sqrefAreaBounds);
  if (change.range === undefined)
    invalidPresentation("Select the validation rule by range or ranges.");
  return [boundsOf(rectangle(change.range))];
}

function rectangle(range: string): string {
  const bounds = boundsOf(range);
  if (
    (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1) >
    1_000_000
  )
    presentationBudget("A rule exceeds 1,000,000 application cells.");
  return range;
}

export function applyValidationChange(
  workbook: PreservedWorkbook,
  change: ValidationChange,
): void {
  const part = workbook.sheet(change.sheetName).part;
  const targets = validationTargets(change);
  const xml = workbook.xml(part);
  const rules = xmlNodes(xml, "dataValidation", "dataValidations");
  const areasOf = (node: (typeof rules)[number]) =>
    (node.attributes.get("sqref") ?? "")
      .split(/\s+/)
      .filter((area) => area !== "")
      .map(sqrefAreaBounds);
  const overlapping = rules.filter((node) =>
    areasOf(node).some((area) =>
      targets.some((target) => intersectsRange(area, target)),
    ),
  );
  if (
    overlapping.length > 1 ||
    overlapping.some((node) => !sameAreas(areasOf(node), targets))
  )
    invalidPresentation(
      "A validation change must exactly select one existing rule; partial or multi-area overlap is unsupported.",
    );
  if (change.kind === "remove_validation" && overlapping.length !== 1)
    invalidPresentation("No validation rule exists at the selected range.");
  const [target] = targets;
  if (target === undefined)
    invalidPresentation("Select the validation rule by range or ranges.");
  if (
    change.kind === "set_validation" &&
    overlapping.length &&
    !change.overwrite
  )
    invalidPresentation(
      "A validation rule already exists; choose overwrite explicitly.",
    );
  const retained = rules
    .filter((node) => !overlapping.includes(node))
    .map((node) => xml.slice(node.start, node.end));
  if (change.kind === "set_validation") {
    if (retained.length >= 256)
      presentationBudget("A worksheet exceeds 256 validation rules.");
    const rule = change.rule;
    let formulas: string[];
    if (rule.type === "list") {
      const list = rule.items.join(",");
      if (list.length > 253 || rule.items.some((item) => /[,"]/.test(item)))
        invalidPresentation(
          "An inline validation list must fit 255 formula characters and cannot contain commas or quotes.",
        );
      formulas = [`"${list}"`];
    } else if (rule.type === "custom") {
      formulas = [
        validateAuthoredFormula(
          workbook,
          rule.formula,
          change.sheetName,
          target.top,
          target.left,
        ),
      ];
    } else {
      const count =
        rule.operator === "between" || rule.operator === "notBetween" ? 2 : 1;
      if (
        rule.bounds.length !== count ||
        (count === 2 && Number(rule.bounds[0]) > Number(rule.bounds[1]))
      )
        invalidPresentation(
          "Validation bounds must match the operator and be ordered.",
        );
      if (
        (rule.type === "whole" || rule.type === "textLength") &&
        rule.bounds.some((value) => !Number.isInteger(value))
      )
        invalidPresentation(
          "Whole-number and text-length validation require integer bounds.",
        );
      if (rule.type === "textLength" && rule.bounds.some((value) => value < 0))
        invalidPresentation("Text-length bounds cannot be negative.");
      formulas = rule.bounds.map(String);
    }
    let raw = `<dataValidation xmlns="${main}" type="${rule.type}" sqref="${xmlEscape(change.range)}" allowBlank="${change.allowBlank ? 1 : 0}" showErrorMessage="1" errorStyle="${change.errorStyle}"${rule.type === "list" ? ' showDropDown="0"' : ""}${"operator" in rule ? ` operator="${rule.operator}"` : ""}>${formulas.map((formula, i) => `<formula${i + 1}>${xmlEscape(formula)}</formula${i + 1}>`).join("")}</dataValidation>`;
    for (const key of ["errorTitle", "error", "promptTitle", "prompt"] as const)
      if (change[key] !== undefined) raw = attribute(raw, key, change[key]);
    if (change.prompt !== undefined || change.promptTitle !== undefined)
      raw = attribute(raw, "showInputMessage", "1");
    retained.push(raw);
  }
  const container = xmlNodes(xml, "dataValidations", "worksheet")[0];
  const replacement = retained.length
    ? container === undefined
      ? `<dataValidations xmlns="${main}" count="${retained.length}">${retained.join("")}</dataValidations>`
      : attribute(
          replaceElementBody(xml, container, retained.join("")),
          "count",
          String(retained.length),
        )
    : "";
  setWorksheetChild(workbook, part, "dataValidations", replacement);
  workbook.presentationEffect("layout", 0);
}

export function applyConditionalChange(
  workbook: PreservedWorkbook,
  change: ConditionalChange,
): void {
  const part = workbook.sheet(change.sheetName).part;
  let xml = workbook.xml(part);
  const groups = xmlNodes(xml, "conditionalFormatting", "worksheet");
  const rules = xmlNodes(xml, "cfRule", "conditionalFormatting");
  const selected = rules.filter(
    (node) =>
      Number.parseInt(node.attributes.get("priority") ?? "", 10) ===
      change.priority,
  );
  if (selected.length > 1)
    invalidPresentation("The conditional-format priority is ambiguous.");
  if (change.kind === "remove_conditional_format" && !selected.length)
    invalidPresentation("No conditional-format rule exists at that priority.");
  if (
    change.kind === "set_conditional_format" &&
    selected.length &&
    !change.overwrite
  )
    invalidPresentation(
      "A conditional-format priority already exists; choose overwrite explicitly.",
    );
  const kept = groups
    .map((group) => {
      const children = rules.filter(
        (node) => node.start > group.start && node.end < group.end,
      );
      const removed = children.filter((node) => selected.includes(node));
      if (!removed.length) return xml.slice(group.start, group.end);
      if (children.length === removed.length) return "";
      return applyXmlPatches(
        xml.slice(group.start, group.end),
        removed.map((node) => ({
          start: node.start - group.start,
          end: node.end - group.start,
          text: "",
        })),
      );
    })
    .filter(Boolean);
  if (change.kind === "set_conditional_format") {
    if (rules.length - selected.length >= 256)
      presentationBudget("A worksheet exceeds 256 conditional-format rules.");
    const range = rectangle(change.range),
      b = boundsOf(range),
      rule = change.rule;
    const formulas =
      rule.type === "expression" ? [rule.formula] : rule.formulas;
    if (
      rule.type === "cellIs" &&
      formulas.length !==
        (rule.operator === "between" || rule.operator === "notBetween" ? 2 : 1)
    )
      invalidPresentation(
        "Conditional-format formulas must match the comparison operator.",
      );
    const parsed = formulas.map((formula) =>
      validateAuthoredFormula(
        workbook,
        formula,
        change.sheetName,
        b.top,
        b.left,
      ),
    );
    if (
      (change.appearance.font === undefined ||
        change.appearance.font === null) &&
      (change.appearance.fill === undefined || change.appearance.fill === null)
    )
      invalidPresentation(
        "A conditional format requires a font or fill appearance.",
      );
    const styles = new StyleAuthoring(workbook);
    const id = styles.differential(change.appearance);
    styles.finish();
    kept.push(
      `<conditionalFormatting xmlns="${main}" sqref="${xmlEscape(range)}"><cfRule type="${rule.type}" priority="${change.priority}" dxfId="${id}" stopIfTrue="${change.stopIfTrue ? 1 : 0}"${rule.type === "cellIs" ? ` operator="${rule.operator}"` : ""}>${parsed.map((formula) => `<formula>${xmlEscape(formula)}</formula>`).join("")}</cfRule></conditionalFormatting>`,
    );
  }
  xml = applyXmlPatches(
    xml,
    groups.map((group) => ({ start: group.start, end: group.end, text: "" })),
  );
  workbook.put(part, xml);
  setWorksheetChild(workbook, part, "conditionalFormatting", kept.join(""));
  workbook.presentationEffect("layout", 0);
}
