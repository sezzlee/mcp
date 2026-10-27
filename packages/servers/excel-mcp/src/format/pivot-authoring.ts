import { namespaces } from "../metadata/spreadsheetml/xml.js";
import type { PresentationChange } from "../authoring/presentation.js";
import type { WriteCell } from "../authoring/values.js";
import { formatCellRef, parseCellRef } from "../grid/range.js";
import type { PreservedWorkbook } from "./preserved-workbook.js";
import { boundsOf } from "./preserved-workbook.js";
import { featureData, type FeatureCell } from "./feature-data.js";
import {
  addInternalRelationship,
  addRelatedPart,
  invalidPresentation,
  presentationBudget,
  setXmlChild,
  spreadsheetNamespace as main,
  xmlNodes,
} from "./presentation-xml.js";
import { uniquePart } from "./drawing-authoring.js";
import { xmlEscape } from "./xml-edit.js";
import { sameDefinedName } from "./name-authoring.js";

type PivotChange = Extract<PresentationChange, { kind: "set_pivot" }>;
const office = namespaces.officeRelationships;
const literal = (text: string): string =>
  xmlEscape(text.replace(/_x[0-9a-f]{4}_/gi, (s) => "_x005F_" + s.slice(1)));
const keyOf = (cell: FeatureCell): string =>
  cell.kind === "value"
    ? JSON.stringify([typeof cell.value, cell.value])
    : cell.kind;
const scalar = (cell: FeatureCell | undefined): WriteCell =>
  cell?.kind !== "value"
    ? { kind: "blank" }
    : typeof cell.value === "string"
      ? { kind: "text", value: cell.value }
      : typeof cell.value === "boolean"
        ? { kind: "boolean", value: cell.value }
        : { kind: "number", value: cell.value };

export function applyPivotChange(
  workbook: PreservedWorkbook,
  change: PivotChange,
): void {
  if (change.cell.includes(":"))
    invalidPresentation("Pivot placement requires one cell.");
  const sheet = workbook.sheet(change.sheetName),
    start = parseCellRef(change.cell);
  const data = featureData(workbook, change.sourceSheet, change.sourceRange);
  if (data.flat().some((cell) => cell.kind === "formula"))
    invalidPresentation(
      "Pivot sources require literal values; copy calculated results explicitly before creating or refreshing the pivot.",
    );
  const first = data[0];
  if (
    first === undefined ||
    first.some(
      (cell) =>
        cell.kind !== "value" ||
        typeof cell.value !== "string" ||
        !cell.value.trim(),
    )
  )
    invalidPresentation("Pivot sources require nonempty literal text headers.");
  const headers = first.map((cell) =>
    cell.kind === "value" ? String(cell.value) : "",
  );
  if (
    headers.some((header, i) =>
      headers.slice(0, i).some((other) => sameDefinedName(other, header)),
    )
  )
    invalidPresentation("Pivot source headers must be unique.");
  const rowIndex = headers.indexOf(change.rowColumn);
  const measures = change.measures.map((measure) => ({
    ...measure,
    index: headers.indexOf(measure.column),
  }));
  if (rowIndex < 0 || measures.some((measure) => measure.index < 0))
    invalidPresentation("A pivot grouping or measure column does not exist.");
  if (
    measures.some((measure, i) =>
      measures
        .slice(0, i)
        .some((other) => sameDefinedName(other.name, measure.name)),
    ) ||
    measures.some((measure) => sameDefinedName(measure.name, change.rowColumn))
  )
    invalidPresentation("Pivot output captions must be unique.");
  const records = data.slice(1);
  const groups = new Map<
    string,
    { cell: FeatureCell; records: FeatureCell[][] }
  >();
  for (const row of records) {
    const cell = row[rowIndex] ?? { kind: "blank" };
    const key = keyOf(cell),
      group = groups.get(key) ?? { cell, records: [] };
    group.records.push(row);
    groups.set(key, group);
  }
  if (groups.size > 10_000)
    presentationBudget("A pivot exceeds 10,000 row groups.");
  function aggregate(rows: readonly FeatureCell[][]): WriteCell[] {
    return measures.map((measure) => {
      const cells = rows.map((row) => row[measure.index]);
      const numbers = cells.flatMap((cell) =>
        cell?.kind === "value" && typeof cell.value === "number"
          ? [cell.value]
          : [],
      );
      const value =
        measure.function === "count"
          ? cells.filter((cell) => cell?.kind === "value" && cell.value !== "")
              .length
          : measure.function === "sum"
            ? numbers.reduce((a, b) => a + b, 0)
            : numbers.length === 0
              ? 0
              : measure.function === "min"
                ? Math.min(...numbers)
                : Math.max(...numbers);
      if (!Number.isFinite(value))
        invalidPresentation("Pivot aggregation overflowed a finite number.");
      return { kind: "number", value };
    });
  }
  const output: WriteCell[][] = [
    [
      { kind: "text", value: change.rowColumn },
      ...measures.map((measure): WriteCell => ({
        kind: "text",
        value: measure.name,
      })),
    ],
    ...[...groups.values()].map((group) => [
      scalar(group.cell),
      ...aggregate(group.records),
    ]),
    [{ kind: "text", value: "Grand Total" }, ...aggregate(records)],
  ];
  const bottom = start.row + output.length - 1,
    right = start.column + measures.length;
  const range = `${formatCellRef(start.row, start.column)}:${formatCellRef(bottom, right)}`;
  boundsOf(range);
  if (sheet.name === workbook.sheet(change.sourceSheet).name) {
    const b = boundsOf(change.sourceRange);
    if (
      start.row <= b.bottom &&
      bottom >= b.top &&
      start.column <= b.right &&
      right >= b.left
    )
      invalidPresentation("A pivot output cannot overlap its source.");
  }
  const related = [
    ...workbook.opc().relationshipsFor(sheet.part).values(),
  ].filter((r) => r.type === `${office}/pivotTable`);
  const matches = related.filter(
    (r) =>
      r.kind === "internal" &&
      sameDefinedName(
        xmlNodes(
          workbook.xml(r.target),
          "pivotTableDefinition",
        )[0]?.attributes.get("name") ?? "",
        change.name,
      ),
  );
  if (matches.length > 1) invalidPresentation("The pivot name is ambiguous.");
  const prior = matches[0];
  for (const entry of workbook.opc().parts) {
    if (
      entry.path === (prior?.kind === "internal" ? prior.target : undefined) ||
      !/pivotTable\+xml$/.test(
        workbook.opc().contentTypes.contentTypeOf(entry.path) ?? "",
      )
    )
      continue;
    if (
      sameDefinedName(
        xmlNodes(
          workbook.xml(entry.path),
          "pivotTableDefinition",
        )[0]?.attributes.get("name") ?? "",
        change.name,
      )
    )
      invalidPresentation(
        "A pivot name must be unique throughout the workbook.",
      );
  }
  if (prior && !change.overwrite)
    invalidPresentation(
      "The pivot exists; choose overwrite explicitly to refresh or replace it.",
    );
  if (related.length >= 64 && !prior)
    presentationBudget("A worksheet exceeds 64 pivots.");
  const bookPart = workbook.workbookPart(),
    bookXml = workbook.xml(bookPart);
  const caches = xmlNodes(bookXml, "pivotCache", "pivotCaches");
  let cacheId = 1;
  while (
    caches.some((node) => node.attributes.get("cacheId") === String(cacheId))
  )
    cacheId++;
  let pivotPart = uniquePart(workbook, "xl/pivotTables/pivotTable", "xml");
  let cachePart = uniquePart(
    workbook,
    "xl/pivotCache/pivotCacheDefinition",
    "xml",
  );
  let recordsPart = uniquePart(
    workbook,
    "xl/pivotCache/pivotCacheRecords",
    "xml",
  );
  let recordId: string;
  if (prior?.kind === "internal") {
    pivotPart = prior.target;
    const root = xmlNodes(workbook.xml(pivotPart), "pivotTableDefinition")[0];
    if (
      root === undefined ||
      xmlNodes(workbook.xml(pivotPart), "extLst").length
    )
      invalidPresentation(
        "Refreshing this existing pivot profile is unsupported.",
      );
    cacheId = Number(root.attributes.get("cacheId"));
    const cache = [...workbook.opc().relationshipsFor(pivotPart).values()].find(
      (r) => r.type === `${office}/pivotCacheDefinition`,
    );
    if (cache?.kind !== "internal")
      invalidPresentation("The pivot cache relationship is absent.");
    cachePart = cache.target;
    const records = [
      ...workbook.opc().relationshipsFor(cachePart).values(),
    ].find((r) => r.type === `${office}/pivotCacheRecords`);
    if (records?.kind !== "internal")
      invalidPresentation("The pivot cache records relationship is absent.");
    recordsPart = records.target;
    recordId = records.id;
    const users = workbook
      .opc()
      .parts.filter(
        (p) =>
          /pivotTable\+xml$/.test(
            workbook.opc().contentTypes.contentTypeOf(p.path) ?? "",
          ) &&
          xmlNodes(
            workbook.xml(p.path),
            "pivotTableDefinition",
          )[0]?.attributes.get("cacheId") === String(cacheId),
      );
    if (users.length !== 1)
      invalidPresentation("Refreshing a shared pivot cache is unsupported.");
    const oldRange = xmlNodes(
      workbook.xml(pivotPart),
      "location",
    )[0]?.attributes.get("ref");
    if (!oldRange)
      invalidPresentation("The prior pivot output location is absent.");
    workbook.apply([
      { kind: "clear_contents", sheetName: sheet.name, range: oldRange },
    ]);
  } else {
    recordId = addRelatedPart(
      workbook,
      cachePart,
      recordsPart,
      `${office}/pivotCacheRecords`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml",
      "",
    );
    const cacheRelation = addRelatedPart(
      workbook,
      bookPart,
      cachePart,
      `${office}/pivotCacheDefinition`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml",
      "",
    );
    addRelatedPart(
      workbook,
      sheet.part,
      pivotPart,
      `${office}/pivotTable`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml",
      "",
    );
    const entries = caches.map((node) => bookXml.slice(node.start, node.end));
    entries.push(
      `<pivotCache xmlns:r="${office}" cacheId="${cacheId}" r:id="${cacheRelation}"/>`,
    );
    workbook.put(
      bookPart,
      setXmlChild(
        workbook.xml(bookPart),
        "workbook",
        "pivotCaches",
        `<pivotCaches xmlns="${main}">${entries.join("")}</pivotCaches>`,
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
      ),
    );
    addInternalRelationship(
      workbook,
      pivotPart,
      cachePart,
      `${office}/pivotCacheDefinition`,
    );
  }
  const fields = headers.map((name, column) => {
    const items: FeatureCell[] = [],
      index = new Map<string, number>();
    for (const row of records) {
      const cell = row[column] ?? { kind: "blank" },
        key = keyOf(cell);
      if (!index.has(key)) {
        index.set(key, items.length);
        items.push(cell);
      }
    }
    return { name, items, index };
  });
  const itemXml = (cell: FeatureCell): string =>
    cell.kind !== "value"
      ? "<m/>"
      : typeof cell.value === "string"
        ? `<s v="${literal(cell.value)}"/>`
        : typeof cell.value === "boolean"
          ? `<b v="${cell.value ? 1 : 0}"/>`
          : `<n v="${cell.value}"/>`;
  workbook.put(
    recordsPart,
    `<pivotCacheRecords xmlns="${main}" count="${records.length}">${records.map((row) => `<r>${fields.map((field, column) => `<x v="${field.index.get(keyOf(row[column] ?? { kind: "blank" }))}"/>`).join("")}</r>`).join("")}</pivotCacheRecords>`,
  );
  workbook.put(
    cachePart,
    `<pivotCacheDefinition xmlns="${main}" xmlns:r="${office}" r:id="${recordId}" saveData="1" refreshOnLoad="0" enableRefresh="1" createdVersion="6" refreshedVersion="6" minRefreshableVersion="3" recordCount="${records.length}"><cacheSource type="worksheet"><worksheetSource ref="${change.sourceRange}" sheet="${literal(workbook.sheet(change.sourceSheet).name)}"/></cacheSource><cacheFields count="${fields.length}">${fields.map((field) => `<cacheField name="${literal(field.name)}" numFmtId="0"><sharedItems containsBlank="${field.items.some((cell) => cell.kind === "blank") ? 1 : 0}" containsString="${field.items.some((cell) => cell.kind === "value" && typeof cell.value === "string") ? 1 : 0}" containsNumber="${field.items.some((cell) => cell.kind === "value" && typeof cell.value === "number") ? 1 : 0}" containsMixedTypes="${new Set(field.items.filter((cell) => cell.kind === "value").map((cell) => (cell.kind === "value" ? typeof cell.value : ""))).size > 1 ? 1 : 0}" containsSemiMixedTypes="${field.items.some((cell) => cell.kind !== "value" || typeof cell.value !== "number") ? 1 : 0}" containsNonDate="1" count="${field.items.length}">${field.items.map(itemXml).join("")}</sharedItems></cacheField>`).join("")}</cacheFields></pivotCacheDefinition>`,
  );
  const rowField = fields[rowIndex];
  if (!rowField) invalidPresentation("The pivot row field is absent.");
  const pivotFields = fields.map((field, index) =>
    index === rowIndex
      ? `<pivotField axis="axisRow"${measures.some((m) => m.index === index) ? ' dataField="1"' : ""} showAll="0" defaultSubtotal="0" compact="0" outline="0"><items count="${field.items.length}">${field.items.map((_, i) => `<item x="${i}"/>`).join("")}</items></pivotField>`
      : `<pivotField${measures.some((m) => m.index === index) ? ' dataField="1"' : ""} showAll="0"/>`,
  );
  workbook.put(
    pivotPart,
    `<pivotTableDefinition xmlns="${main}" name="${literal(change.name)}" cacheId="${cacheId}" dataCaption="Values" rowGrandTotals="1" colGrandTotals="1" compact="0" compactData="0" gridDropZones="1" useAutoFormatting="1"><location ref="${range}" firstHeaderRow="0" firstDataRow="1" firstDataCol="1"/><pivotFields count="${fields.length}">${pivotFields.join("")}</pivotFields><rowFields count="1"><field x="${rowIndex}"/></rowFields><rowItems count="${groups.size + 1}">${[...groups.values()].map((group) => `<i><x v="${rowField.index.get(keyOf(group.cell))}"/></i>`).join("")}<i t="grand"><x/></i></rowItems>${measures.length > 1 ? `<colFields count="1"><field x="-2"/></colFields><colItems count="${measures.length}">${measures.map((_, i) => `<i i="${i}"><x v="${i}"/></i>`).join("")}</colItems>` : ""}<dataFields count="${measures.length}">${measures.map((measure) => `<dataField name="${literal(measure.name)}" fld="${measure.index}" subtotal="${measure.function}"/>`).join("")}</dataFields><pivotTableStyleInfo name="PivotStyleLight16" showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0" showLastColumn="1"/></pivotTableDefinition>`,
  );
  workbook.apply([
    {
      kind: "write_cells",
      sheetName: sheet.name,
      startCell: change.cell,
      values: output,
      overwrite: change.overwrite,
    },
  ]);
  workbook.markFeatureCurrent(cachePart);
}
