import type { OpcPackage, PartSource } from "@sezzlee/ooxml-core";
import { openOpcPackage } from "./reader.js";
import { unescapeXstring } from "./shared-strings.js";
import { namespaces, readXmlPart } from "./xml.js";

export type { OpcPackage, PartSource, Relationship } from "@sezzlee/ooxml-core";

export type SheetState = "visible" | "hidden" | "veryHidden";

export interface DefinedName {
  readonly name: string;
  readonly ref: string;
}

interface WorkbookFacts {
  readonly sheetParts: ReadonlyMap<string, string>;
  readonly sheetStates: ReadonlyMap<string, SheetState>;
  /** Sheets that hold a chart and no cell grid. */
  readonly chartSheets: ReadonlySet<string>;
  readonly date1904: boolean;
  /** Every defined name with a formula, in document order, scope dropped. */
  readonly definedNames: readonly DefinedName[];
}

export interface WorkbookPackage extends OpcPackage, WorkbookFacts {
  readonly mediaParts: readonly string[];
  readonly sharedStringsPart: string | undefined;
  readonly stylesPart: string | undefined;
}

const workbookPath = "xl/workbook.xml";
/**
 * Guard: media is selected by this prefix, not by content type. The core carries
 * `ContentTypes`, but switching to it would change this server's result set: an
 * image with no content-type entry would drop out and one outside `xl/media/`
 * would appear.
 */
const mediaPrefix = "xl/media/";

function stateOf(attribute: string | undefined): SheetState {
  return attribute === "hidden" || attribute === "veryHidden"
    ? attribute
    : "visible";
}

function readWorkbookPart(opc: OpcPackage): WorkbookFacts {
  const sheetParts = new Map<string, string>();
  const sheetStates = new Map<string, SheetState>();
  const chartSheets = new Set<string>();
  const definedNames: DefinedName[] = [];
  let date1904 = false;
  const facts = { sheetParts, sheetStates, chartSheets, definedNames };
  const workbookXml = opc.part(workbookPath);
  if (workbookXml === undefined) return { ...facts, date1904 };
  const rels = opc.relationshipsFor(workbookPath);
  let definedName: string | undefined;
  let text = "";
  readXmlPart(workbookXml, workbookPath, {
    onOpen(node) {
      if (node.uri !== namespaces.spreadsheetml) return;
      if (node.local === "workbookPr") {
        const flag = node.attr("date1904");
        date1904 = flag === "1" || flag === "true";
        return;
      }
      if (node.local === "definedName") {
        definedName = node.attr("name");
        text = "";
        return;
      }
      if (node.local !== "sheet") return;
      const stored = node.attr("name");
      const id = node.attr("id", namespaces.officeRelationships);
      if (stored === undefined || id === undefined) return;
      const relationship = rels.get(id);
      if (relationship?.kind !== "internal") return;
      const name = unescapeXstring(stored);
      sheetParts.set(name, relationship.target);
      sheetStates.set(name, stateOf(node.attr("state")));
      if (relationship.type.endsWith("/chartsheet")) chartSheets.add(name);
    },
    onText(chunk) {
      if (definedName !== undefined) text += chunk;
    },
    onClose(local, uri) {
      if (uri !== namespaces.spreadsheetml || local !== "definedName") return;
      if (definedName !== undefined && text !== "") {
        definedNames.push({ name: definedName, ref: unescapeXstring(text) });
      }
      definedName = undefined;
    },
  });
  return { ...facts, date1904 };
}

/**
 * Guard: matched on the type's last segment, because the Transitional and
 * Strict conformance classes spell the relationship type under different
 * namespaces and both end in the same segment (`/sharedStrings`, `/styles`).
 */
function workbookPartOfType(
  opc: OpcPackage,
  segment: string,
): string | undefined {
  for (const relationship of opc.relationshipsFor(workbookPath).values()) {
    if (
      relationship.kind === "internal" &&
      relationship.type.endsWith(`/${segment}`)
    ) {
      return relationship.target;
    }
  }
  return undefined;
}

/**
 * Opens the package and layers the workbook's own vocabulary over it: the sheet
 * list with each sheet's part, state and kind, the date system, the defined
 * names, the media parts, the shared string table and the styles.
 */
export function openPackage(source: PartSource): WorkbookPackage {
  const opc = openOpcPackage(source);
  const mediaParts = opc.parts
    .map((entry) => entry.path)
    .filter((path) => path.startsWith(mediaPrefix))
    .sort();
  return {
    ...opc,
    ...readWorkbookPart(opc),
    mediaParts,
    sharedStringsPart: workbookPartOfType(opc, "sharedStrings"),
    stylesPart: workbookPartOfType(opc, "styles"),
  };
}
