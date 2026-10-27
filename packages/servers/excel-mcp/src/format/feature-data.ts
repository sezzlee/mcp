import { unescapeXstring } from "../metadata/spreadsheetml/shared-strings.js";
import { namespaces } from "../metadata/spreadsheetml/xml.js";
import type { PreservedWorkbook } from "./preserved-workbook.js";
import { boundsOf, gridOf, keyOf } from "./preserved-workbook.js";
import {
  xmlNodes,
  invalidPresentation,
  presentationBudget,
} from "./presentation-xml.js";
import { scanXml, xmlEscape, xmlUnescape } from "./xml-edit.js";

export type FeatureCell =
  | { readonly kind: "blank" }
  | { readonly kind: "formula" }
  | { readonly kind: "value"; readonly value: string | number | boolean };

export function featureData(
  workbook: PreservedWorkbook,
  sheetName: string,
  range: string,
): FeatureCell[][] {
  const bounds = boundsOf(range),
    height = bounds.bottom - bounds.top + 1,
    width = bounds.right - bounds.left + 1;
  if (height * width > 100_000)
    presentationBudget("An advanced object's source exceeds 100,000 cells.");
  const part = workbook.sheet(sheetName).part,
    grid = gridOf(workbook.xml(part), part);
  const stringRelation = [
    ...workbook.opc().relationshipsFor(workbook.workbookPart()).values(),
  ].find((r) => r.type === `${namespaces.officeRelationships}/sharedStrings`);
  const text = (xml: string): string => {
    let result = "";
    scanXml(xml, "advanced source", (node) => {
      if (
        node.uri === namespaces.spreadsheetml &&
        node.local === "t" &&
        node.parent !== "rPh"
      )
        result += unescapeXstring(
          xmlUnescape(xml.slice(node.openEnd, node.closeStart)),
        );
    });
    return result;
  };
  let strings: string[] = [];
  if (stringRelation?.kind === "internal") {
    const xml = workbook.xml(stringRelation.target);
    strings = xmlNodes(xml, "si", "sst").map((node) => {
      const contents = xml.slice(node.openEnd, node.closeStart);
      const bindings = [...node.namespaces]
        .map(
          ([prefix, uri]) =>
            ` xmlns${prefix ? ":" + prefix : ""}="${xmlEscape(uri)}"`,
        )
        .join("");
      return text(`<root${bindings}>${contents}</root>`);
    });
  }
  const result: FeatureCell[][] = [];
  for (let row = bounds.top; row <= bounds.bottom; row++) {
    const output: FeatureCell[] = [];
    for (let column = bounds.left; column <= bounds.right; column++) {
      const cell = grid.cells.get(keyOf(row, column));
      if (cell?.protectedMetadata)
        invalidPresentation(
          "Rich metadata is outside the advanced source profile.",
        );
      if (cell?.formula !== undefined) {
        output.push({ kind: "formula" });
        continue;
      }
      if (
        cell === undefined ||
        (cell.value === undefined && cell.type !== "inlineStr")
      ) {
        output.push({ kind: "blank" });
        continue;
      }
      let value: string | number | boolean;
      if (cell.type === "s") {
        const shared = strings[Number(cell.value)];
        if (shared === undefined)
          invalidPresentation(
            "The advanced source has an invalid shared-string index.",
          );
        value = shared;
      } else if (cell.type === "inlineStr") {
        const bindings = [...cell.bindings]
          .map(
            ([prefix, uri]) =>
              ` xmlns${prefix ? ":" + prefix : ""}="${xmlEscape(uri)}"`,
          )
          .join("");
        value = text(`<root${bindings}>${cell.raw}</root>`);
      } else if (cell.type === "b") value = cell.value === "1";
      else if (cell.type === "d")
        invalidPresentation(
          "Advanced sources require dates converted explicitly to numeric serials or literal text.",
        );
      else if (cell.type === "str") value = unescapeXstring(cell.value ?? "");
      else if (cell.type === "e")
        invalidPresentation(
          "Error cells are outside the advanced source profile.",
        );
      else {
        value = Number(cell.value);
        if (!Number.isFinite(value))
          invalidPresentation(
            "The advanced source contains a non-finite number.",
          );
      }
      output.push({ kind: "value", value });
    }
    result.push(output);
  }
  return result;
}
