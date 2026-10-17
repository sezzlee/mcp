import type { OpcPackage } from "./package.js";
import { namespaces, scanPart, type PartScan, type XmlVisitor } from "./xml.js";

export interface OoxmlTableColumn {
  readonly name?: string;
  readonly totalsRowFunction?: string;
  readonly totalsRowLabel?: string;
  readonly filterButton?: boolean;
}

export interface OoxmlTable {
  readonly name: string;
  readonly displayName: string;
  readonly ref: string;
  readonly headerRow: boolean;
  readonly totalsRow: boolean;
  readonly autoFilterRef?: string;
  readonly columns: readonly OoxmlTableColumn[];
}

interface ColumnDraft {
  name?: string;
  totalsRowFunction?: string;
  totalsRowLabel?: string;
  filterButton?: boolean;
}

function readTable(opc: OpcPackage, tablePart: string): OoxmlTable | undefined {
  let name: string | undefined;
  let displayName: string | undefined;
  let ref: string | undefined;
  let headerRow = false;
  let totalsRow = false;
  let autoFilterRef: string | undefined;
  const columns: ColumnDraft[] = [];
  const filterButtons = new Map<number, boolean>();
  let filterColumnOrdinal = 0;
  let inAutoFilter = false;

  scanPart(opc, tablePart, {
    onOpen(node) {
      if (node.uri !== namespaces.spreadsheetml) return;
      switch (node.local) {
        case "table":
          name = node.attr("name");
          displayName = node.attr("displayName") ?? name;
          ref = node.attr("ref");
          headerRow = (node.attr("headerRowCount") ?? "1") !== "0";
          totalsRow = (node.attr("totalsRowCount") ?? "0") !== "0";
          break;
        case "autoFilter":
          inAutoFilter = true;
          autoFilterRef = node.attr("ref");
          break;
        case "filterColumn": {
          if (!inAutoFilter) break;
          /**
           * `colId` is the authoritative zero-based offset into the table's
           * columns; a file may declare a filterColumn for some columns only,
           * so reading them positionally puts the button on the wrong column.
           */
          const declared = node.attr("colId");
          const index =
            declared === undefined
              ? filterColumnOrdinal
              : Number.parseInt(declared, 10);
          filterColumnOrdinal += 1;
          if (Number.isFinite(index)) {
            filterButtons.set(index, node.attr("hiddenButton") !== "1");
          }
          break;
        }
        case "tableColumn":
          columns.push({
            name: node.attr("name"),
            totalsRowFunction: node.attr("totalsRowFunction"),
            totalsRowLabel: node.attr("totalsRowLabel"),
          });
          break;
        default:
          break;
      }
    },
    onClose(local, uri) {
      if (uri === namespaces.spreadsheetml && local === "autoFilter") {
        inAutoFilter = false;
      }
    },
  });

  if (ref === undefined) return undefined;
  const resolvedName = name ?? displayName ?? tablePart;
  return {
    name: resolvedName,
    displayName: displayName ?? resolvedName,
    ref,
    headerRow,
    totalsRow,
    ...(autoFilterRef === undefined ? {} : { autoFilterRef }),
    columns: columns.map((column, index): OoxmlTableColumn => {
      const filterButton = filterButtons.get(index);
      return {
        ...(column.name === undefined ? {} : { name: column.name }),
        ...(column.totalsRowFunction === undefined
          ? {}
          : { totalsRowFunction: column.totalsRowFunction }),
        ...(column.totalsRowLabel === undefined
          ? {}
          : { totalsRowLabel: column.totalsRowLabel }),
        ...(filterButton === undefined ? {} : { filterButton }),
      };
    }),
  };
}

/**
 * A worksheet names its tables only by relationship id, so each one is a second
 * hop through `xl/worksheets/_rels/<sheet>.xml.rels` into its own part. The
 * part name carries no meaning — resolving the relationship is the only correct
 * way to find it.
 */
export function tableScan(
  opc: OpcPackage,
  sheetPart: string,
): PartScan<readonly OoxmlTable[]> {
  const relationshipIds: string[] = [];
  const visitor: XmlVisitor = {
    onOpen(node) {
      if (node.uri !== namespaces.spreadsheetml) return;
      if (node.local !== "tablePart") return;
      const id = node.attr("id", namespaces.officeRelationships);
      if (id !== undefined) relationshipIds.push(id);
    },
  };
  const finish = (): readonly OoxmlTable[] => {
    if (relationshipIds.length === 0) return [];
    const rels = opc.relationshipsFor(sheetPart);
    return relationshipIds
      .map((id) => rels.get(id))
      .filter((relationship) => relationship?.kind === "internal")
      .map((relationship) => readTable(opc, relationship.target))
      .filter((table): table is OoxmlTable => table !== undefined);
  };
  return { visitor, finish };
}
