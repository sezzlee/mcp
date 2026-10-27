import { relationshipsPathFor } from "@sezzlee/ooxml-core";
import type { PresentationChange } from "../authoring/presentation.js";
import { formatCellRef, parseCellRef } from "../grid/range.js";
import { namespaces } from "../metadata/spreadsheetml/xml.js";
import type { PreservedWorkbook } from "./preserved-workbook.js";
import { boundsOf, gridOf, keyOf, renderGrid } from "./preserved-workbook.js";
import { sameDefinedName } from "./name-authoring.js";
import {
  addRelatedPart,
  invalidPresentation,
  presentationBudget,
  removeRelationship,
  setWorksheetChild,
  spreadsheetNamespace as main,
  xmlNodes,
} from "./presentation-xml.js";
import {
  applyXmlPatches,
  attribute,
  replaceElementBody,
  scanXml,
  xmlEscape,
  type XmlSpan,
} from "./xml-edit.js";
import {
  appendDrawing,
  artNamespace,
  drawingFor,
  drawingIdentity,
  drawingNamespace,
  drawingNodes,
  removeDrawingDependencies,
  uniquePart,
} from "./drawing-authoring.js";
import { validatedImage } from "./image-data.js";

type ContentChange = Extract<
  PresentationChange,
  {
    kind:
      | "set_hyperlink"
      | "remove_hyperlink"
      | "set_note"
      | "remove_note"
      | "set_image"
      | "remove_image";
  }
>;
const office = namespaces.officeRelationships;
const vml = "urn:schemas-microsoft-com:vml";
const excel = "urn:schemas-microsoft-com:office:excel";
const literal = (text: string): string =>
  xmlEscape(text.replace(/_x[0-9a-f]{4}_/gi, (s) => "_x005F_" + s.slice(1)));

function singleCell(cell: string): string {
  if (cell.includes(":"))
    invalidPresentation("This content operation requires one cell.");
  const parsed = parseCellRef(cell);
  return formatCellRef(parsed.row, parsed.column);
}

function ensureCell(
  workbook: PreservedWorkbook,
  part: string,
  reference: string,
): void {
  const cell = parseCellRef(reference),
    grid = gridOf(workbook.xml(part), part),
    key = keyOf(cell.row, cell.column);
  if (grid.cells.has(key)) return;
  workbook.reservePresentationCells(1);
  grid.cells.set(key, {
    raw: `<c xmlns="${main}" r="${reference}"/>`,
    style: undefined,
    formula: undefined,
    formulaKind: undefined,
    formulaRange: undefined,
    sharedIndex: undefined,
    value: undefined,
    type: undefined,
    protectedMetadata: false,
    bindings: new Map([["", main]]),
  });
  workbook.put(part, renderGrid(grid));
}

function externalRelationship(
  workbook: PreservedWorkbook,
  owner: string,
  url: string,
): string {
  const part = relationshipsPathFor(owner);
  const xml = workbook.parts.has(part)
    ? workbook.xml(part)
    : `<Relationships xmlns="${namespaces.packageRelationships}"/>`;
  let root: XmlSpan | undefined;
  scanXml(xml, part, (node) => {
    if (node.depth === 0) root = node;
  });
  if (root === undefined) invalidPresentation("A relationship root is absent.");
  const ids = workbook.opc().relationshipsFor(owner);
  let id = 1;
  while (ids.has(`rId${id}`)) id++;
  workbook.put(
    part,
    replaceElementBody(
      xml,
      root,
      xml.slice(root.openEnd, root.closeStart) +
        `<Relationship xmlns="${namespaces.packageRelationships}" Id="rId${id}" Type="${office}/hyperlink" Target="${xmlEscape(url)}" TargetMode="External"/>`,
    ),
  );
  return `rId${id}`;
}

function hyperlink(
  workbook: PreservedWorkbook,
  change: Extract<
    ContentChange,
    { kind: "set_hyperlink" | "remove_hyperlink" }
  >,
): void {
  const part = workbook.sheet(change.sheetName).part,
    xml = workbook.xml(part),
    cell = singleCell(change.cell);
  const links = xmlNodes(xml, "hyperlink", "hyperlinks");
  const matches = links.filter((node) => node.attributes.get("ref") === cell);
  if (matches.length > 1)
    invalidPresentation("The selected hyperlink is ambiguous.");
  for (const node of links) {
    const ref = node.attributes.get("ref") ?? "";
    if (ref.includes(":"))
      invalidPresentation(
        "Editing hyperlinks with retained range anchors is unsupported.",
      );
  }
  if (change.kind === "remove_hyperlink" && !matches.length)
    invalidPresentation("No hyperlink exists at the selected cell.");
  if (change.kind === "set_hyperlink" && matches.length && !change.overwrite)
    invalidPresentation("A hyperlink exists; choose overwrite explicitly.");
  const entries = links
    .filter((node) => !matches.includes(node))
    .map((node) => xml.slice(node.start, node.end));
  if (change.kind === "set_hyperlink") {
    if (entries.length >= 4096)
      presentationBudget("A worksheet exceeds 4,096 authored hyperlinks.");
    const target = change.target;
    let attributes: string;
    if (target.kind === "external") {
      const url = new URL(target.url);
      if (url.protocol !== "https:" || url.username || url.password)
        invalidPresentation(
          "External hyperlinks require HTTPS without embedded credentials.",
        );
      attributes = `xmlns:r="${office}" r:id="${externalRelationship(workbook, part, target.url)}"`;
    } else {
      const match = /^(?:'((?:[^']|'')+)'|([^'![\]]+))!([A-Za-z$0-9:]+)$/.exec(
        target.location,
      );
      if (match) {
        const sheet = match[1]?.replace(/''/g, "'") ?? match[2];
        if (sheet === undefined)
          invalidPresentation("The hyperlink location has no sheet.");
        workbook.sheet(sheet);
        boundsOf((match[3] ?? "").replace(/\$/g, ""));
      } else if (
        !xmlNodes(
          workbook.xml(workbook.workbookPart()),
          "definedName",
          "definedNames",
        ).some(
          (node) =>
            !node.attributes.has("localSheetId") &&
            sameDefinedName(node.attributes.get("name") ?? "", target.location),
        )
      )
        invalidPresentation(
          "Internal hyperlinks require an existing worksheet A1 range or workbook-scoped defined name.",
        );
      attributes = `location="${xmlEscape(target.location)}"`;
    }
    entries.push(
      `<hyperlink xmlns="${main}" ref="${cell}" ${attributes}${change.tooltip === undefined ? "" : ` tooltip="${literal(change.tooltip)}"`}/>`,
    );
  }
  setWorksheetChild(
    workbook,
    part,
    "hyperlinks",
    entries.length
      ? `<hyperlinks xmlns="${main}">${entries.join("")}</hyperlinks>`
      : "",
  );
  for (const selected of matches) {
    for (const [attribute, id] of selected.attributes) {
      if (!attribute.endsWith(":id")) continue;
      if (
        !xmlNodes(workbook.xml(part), "hyperlink", "hyperlinks").some((node) =>
          [...node.attributes].some(
            ([name, value]) => name.endsWith(":id") && value === id,
          ),
        )
      )
        removeRelationship(workbook, part, id);
    }
  }
  if (change.kind === "set_hyperlink") {
    const position = parseCellRef(cell),
      stored = gridOf(workbook.xml(part), part).cells.get(
        keyOf(position.row, position.column),
      );
    if (
      change.display !== undefined ||
      stored === undefined ||
      (stored.formula === undefined &&
        stored.value === undefined &&
        stored.type !== "inlineStr")
    ) {
      const value =
        change.display ??
        (change.target.kind === "external"
          ? change.target.url
          : change.target.location);
      workbook.apply([
        {
          kind: "write_cells",
          sheetName: change.sheetName,
          startCell: cell,
          values: [[{ kind: "text", value }]],
          overwrite: change.overwrite,
        },
      ]);
    }
  }
}

function note(
  workbook: PreservedWorkbook,
  change: Extract<ContentChange, { kind: "set_note" | "remove_note" }>,
): void {
  const sheet = workbook.sheet(change.sheetName),
    cell = singleCell(change.cell),
    parsed = parseCellRef(cell);
  const relations = [...workbook.opc().relationshipsFor(sheet.part).values()];
  if (relations.some((r) => /threadedComment|person/i.test(r.type)))
    invalidPresentation(
      "Threaded comments are outside the legacy-note authoring profile.",
    );
  const comments = relations.filter((r) => r.type === `${office}/comments`),
    drawings = relations.filter((r) => r.type === `${office}/vmlDrawing`);
  if (comments.length > 1 || drawings.length > 1)
    invalidPresentation("The note relationships are ambiguous.");
  const prior = comments[0],
    priorDrawing = drawings[0];
  if (
    (prior && prior.kind !== "internal") ||
    (priorDrawing && priorDrawing.kind !== "internal")
  )
    invalidPresentation("Note parts must be internal.");
  const part =
    prior?.kind === "internal"
      ? prior.target
      : uniquePart(workbook, "xl/comments", "xml");
  const xml = prior
    ? workbook.xml(part)
    : `<comments xmlns="${main}"><authors/><commentList/></comments>`;
  const notes = xmlNodes(xml, "comment", "commentList"),
    selected = notes.filter((node) => node.attributes.get("ref") === cell);
  if (selected.length > 1)
    invalidPresentation("The selected note is ambiguous.");
  if (change.kind === "remove_note" && !selected.length)
    invalidPresentation("No note exists at the selected cell.");
  if (change.kind === "set_note" && selected.length && !change.overwrite)
    invalidPresentation("A note exists; choose overwrite explicitly.");
  if (!priorDrawing && prior && notes.length)
    invalidPresentation(
      "Existing notes without a VML drawing cannot be safely authored.",
    );
  const drawing =
    priorDrawing?.kind === "internal"
      ? priorDrawing.target
      : uniquePart(workbook, "xl/drawings/vmlDrawing", "vml");
  let drawingXml = priorDrawing
    ? workbook.xml(drawing)
    : `<xml xmlns:v="${vml}" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="${excel}"><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype></xml>`;
  const shapes: XmlSpan[] = [];
  scanXml(drawingXml, drawing, (node) => {
    if (node.uri === vml && node.local === "shape") shapes.push(node);
  });
  const selectedShapes = shapes.filter((shape) => {
    let row: number | undefined, column: number | undefined;
    scanXml(drawingXml, drawing, (node) => {
      if (
        node.uri !== excel ||
        node.start < shape.start ||
        node.end > shape.end
      )
        return;
      const raw = drawingXml.slice(node.openEnd, node.closeStart);
      if (node.local === "Row") row = Number(raw);
      if (node.local === "Column") column = Number(raw);
    });
    return row === parsed.row - 1 && column === parsed.column - 1;
  });
  if (
    selectedShapes.length > 1 ||
    (selected.length && selectedShapes.length !== 1)
  )
    invalidPresentation("The selected note's VML anchor is unsupported.");
  drawingXml = applyXmlPatches(
    drawingXml,
    selectedShapes.map((node) => ({
      start: node.start,
      end: node.end,
      text: "",
    })),
  );
  const authors = xmlNodes(xml, "authors")[0],
    list = xmlNodes(xml, "commentList")[0];
  if (authors === undefined || list === undefined)
    invalidPresentation("A note container is absent.");
  let authorBody = xml.slice(authors.openEnd, authors.closeStart);
  const entries = notes
    .filter((node) => !selected.includes(node))
    .map((node) => xml.slice(node.start, node.end));
  if (change.kind === "set_note") {
    if (entries.length >= 4096)
      presentationBudget("A worksheet exceeds 4,096 notes.");
    const authorId = xmlNodes(xml, "author", "authors").length;
    if (authorId >= 4096)
      presentationBudget("The note author count exceeds 4,096.");
    authorBody += `<author xmlns="${main}">${literal(change.author)}</author>`;
    entries.push(
      `<comment xmlns="${main}" ref="${cell}" authorId="${authorId}"><text><r><t xml:space="preserve">${literal(change.text)}</t></r></text></comment>`,
    );
    let root: XmlSpan | undefined;
    scanXml(drawingXml, drawing, (node) => {
      if (node.depth === 0) root = node;
    });
    if (root === undefined)
      invalidPresentation("The note drawing has no root.");
    const ids = new Set(shapes.map((shape) => shape.attributes.get("id")));
    let id = 1025;
    while (ids.has(`_x0000_s${id}`)) id++;
    const shape = `<v:shape xmlns:v="${vml}" xmlns:x="${excel}" id="_x0000_s${id}" type="#_x0000_t202" style="position:absolute;width:144pt;height:79pt;visibility:hidden" fillcolor="#ffffe1"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path xmlns:o="urn:schemas-microsoft-com:office:office" o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"/></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:AutoFill>False</x:AutoFill><x:Row>${parsed.row - 1}</x:Row><x:Column>${parsed.column - 1}</x:Column></x:ClientData></v:shape>`;
    drawingXml = replaceElementBody(
      drawingXml,
      root,
      drawingXml.slice(root.openEnd, root.closeStart) + shape,
    );
  }
  const next = applyXmlPatches(xml, [
    {
      start: authors.start,
      end: authors.end,
      text: replaceElementBody(xml, authors, authorBody),
    },
    {
      start: list.start,
      end: list.end,
      text: replaceElementBody(xml, list, entries.join("")),
    },
  ]);
  if (!prior)
    addRelatedPart(
      workbook,
      sheet.part,
      part,
      `${office}/comments`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml",
      next,
    );
  else workbook.put(part, next);
  if (!priorDrawing) {
    const id = addRelatedPart(
      workbook,
      sheet.part,
      drawing,
      `${office}/vmlDrawing`,
      "application/vnd.openxmlformats-officedocument.vmlDrawing",
      drawingXml,
    );
    setWorksheetChild(
      workbook,
      sheet.part,
      "legacyDrawing",
      `<legacyDrawing xmlns="${main}" xmlns:r="${office}" r:id="${id}"/>`,
    );
  } else workbook.put(drawing, drawingXml);
  if (change.kind === "set_note") ensureCell(workbook, sheet.part, cell);
}

function image(
  workbook: PreservedWorkbook,
  change: Extract<ContentChange, { kind: "set_image" | "remove_image" }>,
): void {
  const part = drawingFor(
    workbook,
    change.sheetName,
    change.kind === "set_image",
  );
  let xml = workbook.xml(part);
  const properties = drawingNodes(xml, "cNvPr").filter(
    (node) => node.attributes.get("name") === change.name,
  );
  if (properties.length > 1)
    invalidPresentation("The selected drawing name is ambiguous.");
  const anchors = ["oneCellAnchor", "twoCellAnchor", "absoluteAnchor"].flatMap(
    (local) => drawingNodes(xml, local),
  );
  const property = properties[0];
  const selected =
    property === undefined
      ? undefined
      : anchors.find(
          (node) => node.start < property.start && node.end > property.end,
        );
  if (
    property !== undefined &&
    (selected === undefined ||
      !drawingNodes(xml, "pic").some(
        (node) => node.start > selected.start && node.end < selected.end,
      ))
  )
    invalidPresentation("The drawing name belongs to an unsupported object.");
  if (change.kind === "remove_image" && !selected)
    invalidPresentation("The named image does not exist.");
  if (change.kind === "set_image" && selected && !change.overwrite)
    invalidPresentation("The image exists; choose overwrite explicitly.");
  const identity = drawingIdentity(xml);
  const removedAnchor =
    selected === undefined
      ? undefined
      : [...selected.namespaces].reduce(
          (raw, [prefix, uri]) =>
            attribute(raw, prefix ? `xmlns:${prefix}` : "xmlns", uri),
          xml.slice(selected.start, selected.end),
        );
  if (selected)
    xml = applyXmlPatches(xml, [
      { start: selected.start, end: selected.end, text: "" },
    ]);
  workbook.put(part, xml);
  if (removedAnchor !== undefined)
    removeDrawingDependencies(workbook, part, removedAnchor);
  if (change.kind === "remove_image") return;
  const cell = parseCellRef(singleCell(change.cell));
  const data = validatedImage(change.data, change.mime);
  const mediaBytes = [...workbook.parts]
    .filter(([p]) => /\/media\//.test(p))
    .reduce((total, [, bytes]) => total + bytes.byteLength, 0);
  if (mediaBytes + data.length > 20 * 1024 * 1024)
    presentationBudget("The workbook's embedded media exceeds 20 MiB.");
  const media = uniquePart(
    workbook,
    "xl/media/sezzleeImage",
    change.mime === "image/png" ? "png" : "jpeg",
  );
  const id = addRelatedPart(
    workbook,
    part,
    media,
    `${office}/image`,
    change.mime,
    "",
  );
  workbook.parts.set(media, data);
  appendDrawing(
    workbook,
    part,
    `<xdr:oneCellAnchor xmlns:xdr="${drawingNamespace}" xmlns:a="${artNamespace}" xmlns:r="${office}"><xdr:from><xdr:col>${cell.column - 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${cell.row - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="${change.width * 9525}" cy="${change.height * 9525}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${identity}" name="${literal(change.name)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`,
  );
}

export function applyContentChange(
  workbook: PreservedWorkbook,
  change: ContentChange,
): void {
  switch (change.kind) {
    case "set_hyperlink":
    case "remove_hyperlink":
      hyperlink(workbook, change);
      break;
    case "set_note":
    case "remove_note":
      note(workbook, change);
      break;
    case "set_image":
    case "remove_image":
      image(workbook, change);
      break;
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
  workbook.presentationEffect("layout", 0);
}
