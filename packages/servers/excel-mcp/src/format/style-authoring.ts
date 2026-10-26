import type { CellStyle } from "../authoring/presentation.js";
import { asciiUpper } from "@sezzlee/file-core";
import { presentationLimits } from "../authoring/presentation.js";
import { namespaces } from "../metadata/spreadsheetml/xml.js";
import type { PreservedWorkbook } from "./preserved-workbook.js";
import { attribute, xmlEscape } from "./xml-edit.js";
import {
  xmlNodes,
  setXmlChild,
  addRelatedPart,
  spreadsheetNamespace as main,
  invalidPresentation,
  presentationBudget,
} from "./presentation-xml.js";

const styleOrder = [
  "numFmts",
  "fonts",
  "fills",
  "borders",
  "cellStyleXfs",
  "cellXfs",
  "cellStyles",
  "dxfs",
  "tableStyles",
  "colors",
  "extLst",
];
const baseStyles = `<styleSheet xmlns="${main}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
const argb = (color: string): string =>
  asciiUpper(color.length === 6 ? "FF" + color : color);
const blueDifferentials = () => [
  `<dxf xmlns="${main}"><font><color rgb="FF000000"/></font><fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill></dxf>`,
  `<dxf xmlns="${main}"><fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/><bgColor indexed="64"/></patternFill></fill></dxf>`,
  `<dxf xmlns="${main}"><font><b/><color rgb="FFFFFFFF"/></font><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill></dxf>`,
  `<dxf xmlns="${main}"><font><b/></font><border><top style="thin"><color rgb="FF1F4E78"/></top></border></dxf>`,
];
function validateNumberFormat(code: string): void {
  let quoted = false,
    bracket = false,
    sections = 1;
  for (let at = 0; at < code.length; at++) {
    const ch = code[at];
    if (ch === "\\" || (!quoted && !bracket && (ch === "_" || ch === "*"))) {
      if (++at >= code.length)
        invalidPresentation(
          "A number-format escape or spacing directive is incomplete.",
        );
      continue;
    }
    if (ch === '"' && !bracket) {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (ch === "[") {
      if (bracket)
        invalidPresentation("Nested number-format brackets are unsupported.");
      bracket = true;
    }
    if (ch === "]") {
      if (!bracket)
        invalidPresentation("A number-format bracket is unmatched.");
      bracket = false;
    }
    if (ch === ";" && !bracket && ++sections > 4)
      invalidPresentation("A number format has more than four sections.");
  }
  if (quoted || bracket)
    invalidPresentation(
      "The number format has an unclosed literal or bracket.",
    );
}

export class StyleAuthoring {
  private readonly part: string;
  private xml: string;
  private readonly cache = new Map<string, string>();
  constructor(private readonly workbook: PreservedWorkbook) {
    const relation = [
      ...workbook.opc().relationshipsFor(workbook.workbookPart()).values(),
    ].find((r) => r.type === `${namespaces.officeRelationships}/styles`);
    if (relation !== undefined && relation.kind !== "internal")
      invalidPresentation("The styles relationship must be internal.");
    if (relation?.kind === "internal") this.part = relation.target;
    else {
      let seq = 1;
      let target = "xl/styles.xml";
      while (workbook.parts.has(target)) target = `xl/styles${seq++}.xml`;
      addRelatedPart(
        workbook,
        workbook.workbookPart(),
        target,
        `${namespaces.officeRelationships}/styles`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
        baseStyles,
      );
      this.part = target;
    }
    this.xml = workbook.xml(this.part);
  }
  private entries(container: string, local: string): string[] {
    return xmlNodes(this.xml, local, container).map((n) => {
      let raw = this.xml.slice(n.start, n.end);
      for (const [prefix, uri] of n.namespaces)
        raw = attribute(raw, prefix === "" ? "xmlns" : `xmlns:${prefix}`, uri);
      return raw;
    });
  }
  private append(container: string, local: string, raw: string): number {
    const entries = this.entries(container, local);
    const normalize = (s: string) =>
      s
        .replace(/ xmlns="[^"]*"/g, "")
        .replace(/\s+\/?>/g, (m) => (m.includes("/") ? "/>" : ">"));
    const found = entries.findIndex((s) => normalize(s) === normalize(raw));
    if (found >= 0) return found;
    const max =
      container === "cellXfs"
        ? presentationLimits.maxStyles
        : presentationLimits.maxComponents;
    if (entries.length >= max)
      presentationBudget(`The ${container} count exceeds the authoring limit.`);
    const replacement = `<${container} xmlns="${main}" count="${entries.length + 1}">${entries.join("")}${raw}</${container}>`;
    this.xml = setXmlChild(
      this.xml,
      "styleSheet",
      container,
      replacement,
      styleOrder,
    );
    return entries.length;
  }
  private component(
    container: string,
    local: string,
    index: string | undefined,
  ): string {
    const value = this.entries(container, local)[Number(index ?? 0)];
    if (value === undefined)
      invalidPresentation(`The source ${local} index is invalid.`);
    return value;
  }
  private patchFont(raw: string, font: NonNullable<CellStyle["font"]>): string {
    if (font.name !== undefined) raw = setXmlChild(raw, "font", "scheme", "");
    for (const [key, local] of [
      ["name", "name"],
      ["size", "sz"],
      ["bold", "b"],
      ["italic", "i"],
      ["underline", "u"],
      ["strike", "strike"],
      ["color", "color"],
    ] as const) {
      const value = font[key];
      if (value === undefined) continue;
      const content =
        typeof value === "boolean"
          ? value
            ? `<${local}/>`
            : `<${local} val="${local === "u" ? "none" : "0"}"/>`
          : `<${local} ${local === "color" ? "rgb" : "val"}="${xmlEscape(local === "color" ? argb(String(value)) : String(value))}"/>`;
      raw = setXmlChild(raw, "font", local, content, [
        "b",
        "i",
        "strike",
        "condense",
        "extend",
        "outline",
        "shadow",
        "u",
        "vertAlign",
        "sz",
        "color",
        "name",
        "family",
        "charset",
        "scheme",
      ]);
    }
    return raw;
  }
  style(source: string | undefined, patch: CellStyle): string {
    const key = JSON.stringify([source ?? "0", patch]);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    let xf = this.component("cellXfs", "xf", source);
    const node = xmlNodes(xf, "xf")[0];
    if (node === undefined) invalidPresentation("No cell format exists.");
    for (const [field, container, local, id, apply] of [
      ["font", "fonts", "font", "fontId", "applyFont"],
      ["fill", "fills", "fill", "fillId", "applyFill"],
      ["border", "borders", "border", "borderId", "applyBorder"],
    ] as const) {
      const value = patch[field];
      if (value === undefined) continue;
      let index = 0;
      if (value !== null) {
        let raw = this.component(container, local, node.attributes.get(id));
        if (field === "font" && patch.font !== undefined && patch.font !== null)
          raw = this.patchFont(raw, patch.font);
        else if (field === "fill" && typeof patch.fill === "string")
          raw = `<fill xmlns="${main}"><patternFill patternType="solid"><fgColor rgb="${argb(patch.fill)}"/><bgColor indexed="64"/></patternFill></fill>`;
        else if (
          field === "border" &&
          patch.border !== undefined &&
          patch.border !== null
        ) {
          for (const [side, spec] of Object.entries(patch.border)) {
            raw = setXmlChild(
              raw,
              "border",
              side,
              `<${side} style="${spec.style}">${spec.color === undefined ? "" : `<color rgb="${argb(spec.color)}"/>`}</${side}>`,
              [
                "start",
                "end",
                "left",
                "right",
                "top",
                "bottom",
                "diagonal",
                "vertical",
                "horizontal",
              ],
            );
          }
        }
        index = this.append(container, local, raw);
      }
      xf = attribute(attribute(xf, id, String(index)), apply, "1");
    }
    if (patch.numberFormat !== undefined) {
      let id = 0;
      if (patch.numberFormat !== null && patch.numberFormat !== "General") {
        validateNumberFormat(patch.numberFormat);
        if (
          [...patch.numberFormat].some((ch) => {
            const code = ch.codePointAt(0) ?? 0;
            return code < 32 && code !== 9 && code !== 10 && code !== 13;
          })
        )
          invalidPresentation(
            "A number format contains invalid XML characters.",
          );
        const formats = xmlNodes(this.xml, "numFmt", "numFmts");
        const existing = formats.find(
          (n) => n.attributes.get("formatCode") === patch.numberFormat,
        );
        if (existing !== undefined)
          id = Number(existing.attributes.get("numFmtId"));
        else {
          if (formats.length >= presentationLimits.maxComponents)
            presentationBudget("Too many custom number formats.");
          const used = new Set(
            formats.map((n) => Number(n.attributes.get("numFmtId"))),
          );
          id = 164;
          while (used.has(id)) id++;
          const entries = formats.map((n) => this.xml.slice(n.start, n.end));
          this.xml = setXmlChild(
            this.xml,
            "styleSheet",
            "numFmts",
            `<numFmts xmlns="${main}" count="${entries.length + 1}">${entries.join("")}<numFmt numFmtId="${id}" formatCode="${xmlEscape(patch.numberFormat)}"/></numFmts>`,
            styleOrder,
          );
        }
      }
      xf = attribute(
        attribute(xf, "numFmtId", String(id)),
        "applyNumberFormat",
        "1",
      );
    }
    if (patch.alignment !== undefined) {
      let alignment = "";
      if (patch.alignment !== null) {
        const current = xmlNodes(xf, "alignment", "xf")[0];
        alignment =
          current === undefined
            ? `<alignment xmlns="${main}"/>`
            : xf.slice(current.start, current.end);
        for (const [name, value] of Object.entries(patch.alignment))
          alignment = attribute(
            alignment,
            name,
            typeof value === "boolean" ? (value ? "1" : "0") : value,
          );
      }
      xf = setXmlChild(xf, "xf", "alignment", alignment, [
        "alignment",
        "protection",
        "extLst",
      ]);
      xf = attribute(
        xf,
        "applyAlignment",
        patch.alignment === null ? undefined : "1",
      );
    }
    const result = String(this.append("cellXfs", "xf", xf));
    this.cache.set(key, result);
    return result;
  }
  finish(): void {
    this.workbook.put(this.part, this.xml);
  }
  defineTableStyle(): void {
    const prior = xmlNodes(this.xml, "tableStyle", "tableStyles").find(
      (n) => n.attributes.get("name") === "SezzleeBlue",
    );
    if (prior !== undefined) {
      this.requireTableStyle();
      return;
    }
    const definitions = blueDifferentials();
    const ids = definitions.map((raw) => this.append("dxfs", "dxf", raw));
    const styles = xmlNodes(this.xml, "tableStyle", "tableStyles").map((n) =>
      this.xml.slice(n.start, n.end),
    );
    styles.push(
      `<tableStyle name="SezzleeBlue" pivot="0" table="1" count="4"><tableStyleElement type="wholeTable" dxfId="${ids[0]}"/><tableStyleElement type="firstRowStripe" size="1" dxfId="${ids[1]}"/><tableStyleElement type="headerRow" dxfId="${ids[2]}"/><tableStyleElement type="totalRow" dxfId="${ids[3]}"/></tableStyle>`,
    );
    this.xml = setXmlChild(
      this.xml,
      "styleSheet",
      "tableStyles",
      `<tableStyles xmlns="${main}" count="${styles.length}">${styles.join("")}</tableStyles>`,
      styleOrder,
    );
  }
  materializeTableStyle(source: string | undefined, patch: CellStyle): string {
    const raw = this.component("cellXfs", "xf", source),
      node = xmlNodes(raw, "xf")[0];
    if (node === undefined) invalidPresentation("No cell style exists.");
    return this.style(source, {
      ...patch,
      ...(node.attributes.get("applyFont") === "1" ||
      Number(node.attributes.get("fontId") ?? 0) !== 0
        ? { font: undefined }
        : {}),
      ...(node.attributes.get("applyFill") === "1" ||
      Number(node.attributes.get("fillId") ?? 0) !== 0
        ? { fill: undefined }
        : {}),
      ...(node.attributes.get("applyBorder") === "1" ||
      Number(node.attributes.get("borderId") ?? 0) !== 0
        ? { border: undefined }
        : {}),
    });
  }
  inheritedFont(source: string | undefined): boolean {
    const raw = this.component("cellXfs", "xf", source),
      node = xmlNodes(raw, "xf")[0];
    return (
      node !== undefined &&
      node.attributes.get("applyFont") !== "1" &&
      Number(node.attributes.get("fontId") ?? 0) === 0
    );
  }
  requireTableStyle(): void {
    const definitions = blueDifferentials(),
      types = ["wholeTable", "firstRowStripe", "headerRow", "totalRow"];
    const matches = xmlNodes(this.xml, "tableStyle", "tableStyles").filter(
        (n) => n.attributes.get("name") === "SezzleeBlue",
      ),
      root = matches[0];
    if (matches.length !== 1 || root === undefined)
      invalidPresentation(
        "The SezzleeBlue style definition is missing or ambiguous.",
      );
    const raw = attribute(this.xml.slice(root.start, root.end), "xmlns", main),
      elements = xmlNodes(raw, "tableStyleElement", "tableStyle"),
      dxfs = this.entries("dxfs", "dxf");
    const normalize = (value: string) =>
      value
        .replace(/ xmlns(?::[^\s=]+)?="[^"]*"/g, "")
        .replace(/\s+\/?>/g, (m) => (m.includes("/") ? "/>" : ">"));
    if (
      elements.length !== 4 ||
      types.some((type, index) => {
        const selected = elements.filter(
            (n) => n.attributes.get("type") === type,
          ),
          element = selected[0],
          expected = definitions[index];
        if (
          selected.length !== 1 ||
          element === undefined ||
          expected === undefined
        )
          return true;
        const actual = dxfs[Number(element.attributes.get("dxfId"))];
        return (
          actual === undefined ||
          normalize(actual) !== normalize(expected) ||
          (type === "firstRowStripe" && element.attributes.get("size") !== "1")
        );
      })
    )
      invalidPresentation(
        "The retained table style differs from the supported SezzleeBlue profile; it cannot be materialized safely.",
      );
  }
}
