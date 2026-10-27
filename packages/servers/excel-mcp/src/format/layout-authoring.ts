import type { PresentationChange } from "../authoring/presentation.js";
import { columnToLetters, formatCellRef } from "../grid/range.js";
import {
  gridOf,
  renderGrid,
  boundsOf,
  type PreservedWorkbook,
} from "./preserved-workbook.js";
import { attribute, xmlEscape, applyXmlPatches } from "./xml-edit.js";
import {
  xmlNodes,
  setXmlChild,
  setWorksheetChild,
  headerWith,
  spreadsheetNamespace as main,
  invalidPresentation,
} from "./presentation-xml.js";

type LayoutChange = Extract<
  PresentationChange,
  {
    kind:
      | "set_columns"
      | "set_rows"
      | "freeze_panes"
      | "set_sheet_visibility"
      | "set_print_layout";
  }
>;
function dimensions(
  workbook: PreservedWorkbook,
  change: Extract<LayoutChange, { kind: "set_columns" | "set_rows" }>,
): void {
  if (change.last < change.first)
    invalidPresentation("The dimension range ends before it starts.");
  if (
    change.kind === "set_columns" &&
    change.width === undefined &&
    change.hidden === undefined
  )
    invalidPresentation("Specify a width or visibility change.");
  if (
    change.kind === "set_rows" &&
    change.height === undefined &&
    change.hidden === undefined
  )
    invalidPresentation("Specify a height or visibility change.");
  workbook.presentationEffect(
    change.hidden === undefined ? "layout" : "visibility",
    change.last - change.first + 1,
  );
  const part = workbook.sheet(change.sheetName).part;
  let xml = workbook.xml(part);
  if (change.kind === "set_columns") {
    const columns = new Map<number, string>();
    for (const node of xmlNodes(xml, "col", "cols")) {
      const first = Number(node.attributes.get("min")),
        last = Number(node.attributes.get("max"));
      if (
        !Number.isInteger(first) ||
        !Number.isInteger(last) ||
        first < 1 ||
        last > 16_384 ||
        last < first
      )
        invalidPresentation("The retained column dimensions are invalid.");
      for (let col = first; col <= last; col++) {
        if (columns.has(col))
          invalidPresentation(
            "Overlapping retained column dimensions cannot be edited.",
          );
        let raw = xml.slice(node.start, node.end);
        for (const [prefix, uri] of node.namespaces)
          raw = attribute(
            raw,
            prefix === "" ? "xmlns" : `xmlns:${prefix}`,
            uri,
          );
        columns.set(col, raw);
      }
    }
    for (let col = change.first; col <= change.last; col++) {
      let raw = columns.get(col) ?? `<col xmlns="${main}"/>`;
      if (change.width !== undefined)
        raw = headerWith(raw, {
          width: change.width === null ? undefined : String(change.width),
          customWidth: change.width === null ? undefined : "1",
          bestFit: undefined,
        });
      if (change.hidden !== undefined)
        raw = attribute(raw, "hidden", change.hidden ? "1" : undefined);
      columns.set(col, raw);
    }
    const entries = [...columns]
      .sort(([a], [b]) => a - b)
      .map(([col, raw]) =>
        headerWith(raw, { min: String(col), max: String(col) }),
      );
    setWorksheetChild(
      workbook,
      part,
      "cols",
      `<cols xmlns="${main}">${entries.join("")}</cols>`,
    );
  } else {
    const grid = gridOf(xml, part);
    for (let row = change.first; row <= change.last; row++)
      if (!grid.rows.has(row)) {
        const raw = `<row xmlns="${main}" r="${row}"/>`,
          span = xmlNodes(raw, "row")[0];
        if (span === undefined)
          invalidPresentation("The row could not be constructed.");
        grid.rows.set(row, { raw, span, cells: [] });
      }
    xml = renderGrid(grid);
    const patches: { start: number; end: number; text: string }[] = [];
    for (const node of xmlNodes(xml, "row", "sheetData")) {
      const row = Number(node.attributes.get("r"));
      if (row < change.first || row > change.last) continue;
      let raw = xml.slice(node.start, node.openEnd);
      if (change.height !== undefined)
        raw = headerWith(raw, {
          ht: change.height === null ? undefined : String(change.height),
          customHeight: change.height === null ? undefined : "1",
        });
      if (change.hidden !== undefined)
        raw = attribute(raw, "hidden", change.hidden ? "1" : undefined);
      patches.push({ start: node.start, end: node.openEnd, text: raw });
    }
    workbook.put(part, applyXmlPatches(xml, patches));
  }
}
function freeze(
  workbook: PreservedWorkbook,
  change: Extract<LayoutChange, { kind: "freeze_panes" }>,
): void {
  const part = workbook.sheet(change.sheetName).part;
  let xml = workbook.xml(part);
  if (xmlNodes(xml, "sheetViews", "worksheet").length === 0) {
    setWorksheetChild(
      workbook,
      part,
      "sheetViews",
      `<sheetViews xmlns="${main}"><sheetView workbookViewId="0"/></sheetViews>`,
    );
    xml = workbook.xml(part);
  }
  const active =
    change.rows && change.columns
      ? "bottomRight"
      : change.rows
        ? "bottomLeft"
        : "topRight";
  let pane = "";
  if (change.rows || change.columns)
    pane = `<pane xmlns="${main}"${change.columns ? ` xSplit="${change.columns}"` : ""}${change.rows ? ` ySplit="${change.rows}"` : ""} topLeftCell="${formatCellRef(change.rows + 1, change.columns + 1)}" activePane="${active}" state="frozen"/>`;
  xml = setXmlChild(xml, "sheetView", "pane", pane, [
    "pane",
    "selection",
    "pivotSelection",
    "extLst",
  ]);
  const selections = xmlNodes(xml, "selection", "sheetView");
  xml = applyXmlPatches(
    xml,
    selections.map((n) => ({ start: n.start, end: n.end, text: "" })),
  );
  xml = setXmlChild(
    xml,
    "sheetView",
    "selection",
    `<selection xmlns="${main}"${pane ? ` pane="${active}"` : ""} activeCell="${formatCellRef(change.rows + 1, change.columns + 1)}" sqref="${formatCellRef(change.rows + 1, change.columns + 1)}"/>`,
    ["pane", "selection", "pivotSelection", "extLst"],
  );
  workbook.put(part, xml);
}
function visibility(
  workbook: PreservedWorkbook,
  change: Extract<LayoutChange, { kind: "set_sheet_visibility" }>,
): void {
  workbook.presentationEffect("visibility", 0);
  const sheet = workbook.sheet(change.sheetName),
    sheets = workbook.sheets();
  if (
    change.state !== "visible" &&
    !sheets.some((s) => s.name !== sheet.name && s.state === "visible")
  )
    invalidPresentation("At least one sheet must remain visible.");
  const part = workbook.workbookPart();
  let xml = workbook.xml(part);
  xml = applyXmlPatches(xml, [
    {
      start: sheet.span.start,
      end: sheet.span.openEnd,
      text: attribute(
        xml.slice(sheet.span.start, sheet.span.openEnd),
        "state",
        change.state === "visible" ? undefined : change.state,
      ),
    },
  ]);
  if (change.state !== "visible") {
    const current = sheets.findIndex((s) => s.name === sheet.name),
      next = sheets.findIndex(
        (s) => s.name !== sheet.name && s.state === "visible",
      );
    xml = applyXmlPatches(
      xml,
      xmlNodes(xml, "workbookView", "bookViews")
        .filter((n) => Number(n.attributes.get("activeTab") ?? 0) === current)
        .map((n) => ({
          start: n.start,
          end: n.openEnd,
          text: attribute(
            xml.slice(n.start, n.openEnd),
            "activeTab",
            String(next),
          ),
        })),
    );
    let sheetXml = workbook.xml(sheet.part);
    sheetXml = applyXmlPatches(
      sheetXml,
      xmlNodes(sheetXml, "sheetView", "sheetViews").map((n) => ({
        start: n.start,
        end: n.openEnd,
        text: attribute(
          sheetXml.slice(n.start, n.openEnd),
          "tabSelected",
          undefined,
        ),
      })),
    );
    workbook.put(sheet.part, sheetXml);
  }
  workbook.put(part, xml);
}
function printNames(
  workbook: PreservedWorkbook,
  change: Extract<LayoutChange, { kind: "set_print_layout" }>,
): void {
  if (
    change.printArea === undefined &&
    change.titleRows === undefined &&
    change.titleColumns === undefined
  )
    return;
  const part = workbook.workbookPart(),
    sheet = workbook.sheet(change.sheetName),
    index = workbook.sheets().findIndex((s) => s.name === sheet.name);
  let xml = workbook.xml(part);
  const names = xmlNodes(xml, "definedName", "definedNames");
  const qualified = `'${sheet.name.replace(/'/g, "''")}'!`;
  const entries = names
    .filter(
      (n) =>
        !(
          n.attributes.get("localSheetId") === String(index) &&
          ((n.attributes.get("name") === "_xlnm.Print_Area" &&
            change.printArea !== undefined) ||
            (n.attributes.get("name") === "_xlnm.Print_Titles" &&
              (change.titleRows !== undefined ||
                change.titleColumns !== undefined)))
        ),
    )
    .map((n) => xml.slice(n.start, n.end));
  const name = (key: string, value: string) =>
    `<definedName xmlns="${main}" name="${key}" localSheetId="${index}">${xmlEscape(value)}</definedName>`;
  if (change.printArea !== undefined && change.printArea !== null) {
    const b = boundsOf(change.printArea);
    entries.push(
      name(
        "_xlnm.Print_Area",
        `${qualified}$${columnToLetters(b.left)}$${b.top}:$${columnToLetters(b.right)}$${b.bottom}`,
      ),
    );
  }
  if (change.titleRows !== undefined || change.titleColumns !== undefined) {
    const existing = names.find(
      (n) =>
        n.attributes.get("name") === "_xlnm.Print_Titles" &&
        n.attributes.get("localSheetId") === String(index),
    );
    const body =
      existing === undefined
        ? ""
        : xml.slice(existing.openEnd, existing.closeStart);
    const oldRows = /\$([1-9][0-9]*):\$([1-9][0-9]*)/.exec(body),
      oldColumns = /\$([A-Z]+):\$([A-Z]+)/.exec(body);
    const row =
      change.titleRows === undefined
        ? oldRows
          ? `${qualified}${oldRows[0]}`
          : ""
        : change.titleRows === null
          ? ""
          : `${qualified}$${change.titleRows.first}:$${change.titleRows.last}`;
    const col =
      change.titleColumns === undefined
        ? oldColumns
          ? `${qualified}${oldColumns[0]}`
          : ""
        : change.titleColumns === null
          ? ""
          : `${qualified}$${columnToLetters(change.titleColumns.first)}:$${columnToLetters(change.titleColumns.last)}`;
    if (
      (change.titleRows && change.titleRows.last < change.titleRows.first) ||
      (change.titleColumns &&
        change.titleColumns.last < change.titleColumns.first)
    )
      invalidPresentation("Print title ranges must be ordered.");
    const value = [row, col].filter(Boolean).join(",");
    if (value) entries.push(name("_xlnm.Print_Titles", value));
  }
  xml = setXmlChild(
    xml,
    "workbook",
    "definedNames",
    entries.length
      ? `<definedNames xmlns="${main}">${entries.join("")}</definedNames>`
      : "",
    [
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
    ],
  );
  workbook.put(part, xml);
}
function printLayout(
  workbook: PreservedWorkbook,
  change: Extract<LayoutChange, { kind: "set_print_layout" }>,
): void {
  if (
    change.scale !== undefined &&
    (change.fitWidth !== undefined || change.fitHeight !== undefined)
  )
    invalidPresentation("Choose scale or fit-to-page, not both.");
  const part = workbook.sheet(change.sheetName).part;
  if (change.margins !== undefined)
    setWorksheetChild(
      workbook,
      part,
      "pageMargins",
      headerWith(
        `<pageMargins xmlns="${main}"/>`,
        Object.fromEntries(
          Object.entries(change.margins).map(([k, v]) => [k, String(v)]),
        ),
      ),
    );
  if (
    change.orientation !== undefined ||
    change.paper !== undefined ||
    change.scale !== undefined ||
    change.fitWidth !== undefined ||
    change.fitHeight !== undefined
  ) {
    const xml = workbook.xml(part),
      node = xmlNodes(xml, "pageSetup", "worksheet")[0];
    let raw =
      node === undefined
        ? `<pageSetup xmlns="${main}"/>`
        : xml.slice(node.start, node.end);
    if (change.orientation !== undefined)
      raw = attribute(raw, "orientation", change.orientation);
    if (change.paper !== undefined)
      raw = attribute(
        raw,
        "paperSize",
        String({ A4: 9, letter: 1, legal: 5 }[change.paper]),
      );
    if (change.scale !== undefined)
      raw = headerWith(raw, {
        scale: String(change.scale),
        fitToWidth: undefined,
        fitToHeight: undefined,
      });
    if (change.fitWidth !== undefined || change.fitHeight !== undefined)
      raw = headerWith(raw, {
        scale: undefined,
        fitToWidth: String(change.fitWidth ?? 1),
        fitToHeight: String(change.fitHeight ?? 0),
      });
    setWorksheetChild(workbook, part, "pageSetup", raw);
    if (
      change.scale !== undefined ||
      change.fitWidth !== undefined ||
      change.fitHeight !== undefined
    ) {
      let current = workbook.xml(part);
      if (xmlNodes(current, "sheetPr", "worksheet").length === 0) {
        setWorksheetChild(
          workbook,
          part,
          "sheetPr",
          `<sheetPr xmlns="${main}"/>`,
        );
        current = workbook.xml(part);
      }
      const prior = xmlNodes(current, "pageSetUpPr", "sheetPr")[0];
      const setup = attribute(
        prior === undefined
          ? `<pageSetUpPr xmlns="${main}"/>`
          : current.slice(prior.start, prior.end),
        "fitToPage",
        change.scale === undefined ? "1" : "0",
      );
      workbook.put(
        part,
        setXmlChild(current, "sheetPr", "pageSetUpPr", setup, [
          "tabColor",
          "outlinePr",
          "pageSetUpPr",
        ]),
      );
    }
  }
  printNames(workbook, change);
}
export function applyLayoutChange(
  workbook: PreservedWorkbook,
  change: LayoutChange,
): void {
  switch (change.kind) {
    case "set_rows":
    case "set_columns":
      dimensions(workbook, change);
      break;
    case "freeze_panes":
      freeze(workbook, change);
      break;
    case "set_sheet_visibility":
      visibility(workbook, change);
      break;
    case "set_print_layout":
      printLayout(workbook, change);
      break;
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}
