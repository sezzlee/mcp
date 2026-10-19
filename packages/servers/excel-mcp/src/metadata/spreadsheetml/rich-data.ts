import { SezzleeExcelError } from "../../platform/errors.js";
import type { LinkedValue } from "../../grid/cell-value.js";
import type { WorkbookPackage } from "./package.js";
import { cellText } from "./shared-strings.js";
import { namespaces, scanPart } from "./xml.js";

const richNamespace =
  "http://schemas.microsoft.com/office/spreadsheetml/2017/richdata";
const dynamicNamespace =
  "http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray";
const relationNamespace =
  "http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel";
const maxRecords = 100_000;
const maxFields = 256;
const maxValues = 1_000_000;

export interface DynamicArrayProperties {
  readonly dynamic: boolean;
  readonly collapsed?: boolean;
}

export type RichValue =
  | {
      readonly kind: "image";
      readonly mediaPart: string;
      readonly altText?: string;
      readonly decorative?: boolean;
    }
  | { readonly kind: "linked"; readonly value: LinkedValue }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "unsupported"; readonly type: string };

export interface RichData {
  readonly mediaParts: readonly string[];
  /** Office cell attributes are one-based; zero means no metadata. */
  value(index: number | undefined): RichValue | undefined;
  dynamic(index: number | undefined): DynamicArrayProperties | undefined;
}

export function corruptRich(part: string, detail: string): SezzleeExcelError {
  return new SezzleeExcelError(
    "corrupt_workbook",
    `'${part}' ${detail}.`,
    "Open the file in Excel and re-save it as .xlsx.",
  );
}

export function metadataIndex(
  text: string | undefined,
  part: string,
  field: string,
): number | undefined {
  if (text === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw corruptRich(part, `has an invalid ${field} index`);
  return Number(text);
}

function indexOf(
  text: string | undefined,
  part: string,
  field: string,
): number {
  const index = metadataIndex(text, part, field);
  if (index === undefined) throw corruptRich(part, `is missing ${field}`);
  return index;
}

function bound(count: number, maximum = maxRecords): void {
  if (count > maximum)
    throw new SezzleeExcelError(
      "file_too_large",
      "Rich value metadata exceeds the bounded record budget.",
      "Split the workbook into smaller files.",
    );
}

function flag(text: string | undefined, part: string): boolean | undefined {
  if (text === undefined) return undefined;
  if (text === "1" || text === "true") return true;
  if (text === "0" || text === "false") return false;
  throw corruptRich(part, "has an invalid dynamic array flag");
}

interface MetadataRecord {
  readonly type: number;
  readonly value: number;
}
interface FutureRecord {
  rich?: number;
  dynamic?: DynamicArrayProperties;
}
interface Metadata {
  readonly types: readonly string[];
  readonly future: ReadonlyMap<string, readonly FutureRecord[]>;
  readonly cells: readonly (readonly MetadataRecord[])[];
  readonly values: readonly (readonly MetadataRecord[])[];
}

function readMetadata(
  opc: WorkbookPackage,
  part: string | undefined,
): Metadata {
  const types: string[] = [];
  const future = new Map<string, FutureRecord[]>();
  const cells: MetadataRecord[][] = [];
  const values: MetadataRecord[][] = [];
  if (part === undefined) return { types, future, cells, values };
  const path: string[] = [];
  let futureName: string | undefined;
  let futureBlock: FutureRecord | undefined;
  let records: MetadataRecord[][] | undefined;
  let recordBlock: MetadataRecord[] | undefined;
  let count = 0;
  scanPart(opc, part, {
    onOpen(node) {
      const parent = path.at(-1);
      path.push(`${node.uri}|${node.local}`);
      if (node.uri === namespaces.spreadsheetml) {
        if (
          node.local === "metadataType" &&
          parent === `${namespaces.spreadsheetml}|metadataTypes`
        ) {
          types.push(node.attr("name") ?? "");
          bound(types.length);
        } else if (node.local === "futureMetadata") {
          futureName = node.attr("name");
          if (futureName === undefined || future.has(futureName))
            throw corruptRich(
              part,
              "has missing or duplicate future metadata names",
            );
          future.set(futureName, []);
        } else if (node.local === "cellMetadata") records = cells;
        else if (node.local === "valueMetadata") records = values;
        else if (node.local === "bk") {
          if (
            parent === `${namespaces.spreadsheetml}|futureMetadata` &&
            futureName !== undefined
          ) {
            futureBlock = {};
            future.get(futureName)?.push(futureBlock);
            bound(++count);
          } else if (
            records !== undefined &&
            (parent === `${namespaces.spreadsheetml}|cellMetadata` ||
              parent === `${namespaces.spreadsheetml}|valueMetadata`)
          ) {
            recordBlock = [];
            records.push(recordBlock);
            bound(++count);
          }
        } else if (node.local === "rc" && recordBlock !== undefined) {
          recordBlock.push({
            type: indexOf(node.attr("t"), part, "metadata type"),
            value: indexOf(node.attr("v"), part, "metadata value"),
          });
          bound(recordBlock.length, maxFields);
        }
      } else if (futureBlock !== undefined) {
        if (node.uri === richNamespace && node.local === "rvb") {
          if (futureBlock.rich !== undefined)
            throw corruptRich(part, "has duplicate rich value indices");
          futureBlock.rich = indexOf(node.attr("i"), part, "rich value");
        } else if (
          node.uri === dynamicNamespace &&
          node.local === "dynamicArrayProperties"
        ) {
          const dynamic = flag(node.attr("fDynamic"), part) ?? false;
          const collapsed = flag(node.attr("fCollapsed"), part);
          futureBlock.dynamic = {
            dynamic,
            ...(collapsed === undefined ? {} : { collapsed }),
          };
        }
      }
    },
    onClose(local, uri) {
      path.pop();
      if (uri !== namespaces.spreadsheetml) return;
      if (local === "futureMetadata") futureName = undefined;
      else if (local === "cellMetadata" || local === "valueMetadata")
        records = undefined;
      else if (local === "bk") {
        futureBlock = undefined;
        recordBlock = undefined;
      }
    },
  });
  return { types, future, cells, values };
}

interface RichKey {
  readonly name: string;
  readonly type: string;
}
interface RichStructure {
  readonly type: string;
  readonly keys: RichKey[];
}
interface RichRecord {
  readonly structure: number;
  readonly values: string[];
}

function readStructures(
  opc: WorkbookPackage,
  part: string | undefined,
): readonly RichStructure[] {
  const structures: RichStructure[] = [];
  if (part === undefined) return structures;
  let current: RichStructure | undefined;
  scanPart(opc, part, {
    onOpen(node) {
      if (node.uri !== richNamespace) return;
      if (node.local === "s") {
        current = { type: node.attr("t") ?? "", keys: [] };
        structures.push(current);
        bound(structures.length);
      } else if (node.local === "k" && current !== undefined) {
        current.keys.push({
          name: node.attr("n") ?? "",
          type: node.attr("t") ?? "",
        });
        bound(current.keys.length, maxFields);
      }
    },
    onClose(local, uri) {
      if (uri === richNamespace && local === "s") current = undefined;
    },
  });
  return structures;
}

function readValues(
  opc: WorkbookPackage,
  part: string | undefined,
): readonly RichRecord[] {
  const records: RichRecord[] = [];
  if (part === undefined) return records;
  let current: RichRecord | undefined;
  let text: string | undefined;
  let count = 0;
  scanPart(opc, part, {
    onOpen(node) {
      if (node.uri !== richNamespace) return;
      if (node.local === "rv") {
        current = {
          structure: indexOf(node.attr("s"), part, "rich structure"),
          values: [],
        };
        records.push(current);
        bound(records.length);
      } else if (node.local === "v" && current !== undefined) text = "";
    },
    onText(chunk) {
      if (text !== undefined) text += chunk;
    },
    onClose(local, uri) {
      if (uri !== richNamespace) return;
      if (local === "rv") current = undefined;
      else if (local === "v" && current !== undefined && text !== undefined) {
        current.values.push(cellText(text));
        text = undefined;
        bound(current.values.length, maxFields);
        bound(++count, maxValues);
      }
    },
  });
  return records;
}

function readRelations(
  opc: WorkbookPackage,
  part: string | undefined,
): readonly (string | undefined)[] {
  const ids: (string | undefined)[] = [];
  if (part === undefined) return ids;
  scanPart(opc, part, {
    onOpen(node) {
      if (node.uri === relationNamespace && node.local === "rel") {
        ids.push(node.attr("id", namespaces.officeRelationships));
        bound(ids.length);
      }
    },
  });
  return ids;
}

/**
 * Follows workbook relationships, Office's one-based vm/cm/type indices, and
 * zero-based future/value/structure indices. Structure key names determine
 * meaning; neither part names nor key order is a schema shortcut.
 */
export function readRichData(opc: WorkbookPackage): RichData {
  const partOf = (segment: string): string | undefined => {
    for (const relationship of opc.relationshipsFor("xl/workbook.xml").values())
      if (
        relationship.kind === "internal" &&
        relationship.type.endsWith(`/${segment}`)
      )
        return relationship.target;
    return undefined;
  };
  const metadataPart = partOf("sheetMetadata");
  const metadata = readMetadata(opc, metadataPart);
  const structuresPart = partOf("rdRichValueStructure");
  const valuesPart = partOf("rdRichValue");
  const relationsPart = partOf("richValueRel");
  const structures = readStructures(opc, structuresPart);
  const values = readValues(opc, valuesPart);
  const relationIds = readRelations(opc, relationsPart);
  const relationships =
    relationsPart === undefined
      ? undefined
      : opc.relationshipsFor(relationsPart);
  const mediaParts = new Set<string>();
  for (const id of relationIds) {
    const relationship = id === undefined ? undefined : relationships?.get(id);
    if (
      relationship?.kind === "internal" &&
      relationship.type.endsWith("/image") &&
      opc.partSize(relationship.target) !== undefined
    )
      mediaParts.add(relationship.target);
  }
  const cache = new Map<number, RichValue>();
  const part = metadataPart ?? "workbook metadata";

  const futureOf = (
    index: number | undefined,
    kind: "cells" | "values",
    name: string,
  ): FutureRecord | undefined => {
    if (index === undefined || index === 0) return undefined;
    const records = metadata[kind][index - 1];
    if (records === undefined)
      throw corruptRich(part, `references missing ${kind} metadata ${index}`);
    let found: FutureRecord | undefined;
    for (const record of records) {
      const type = metadata.types[record.type - 1];
      if (type === undefined)
        throw corruptRich(part, "references a missing metadata type");
      if (type !== name) continue;
      const next = metadata.future.get(type)?.[record.value];
      if (next === undefined || found !== undefined)
        throw corruptRich(
          part,
          "references missing or duplicate future metadata",
        );
      found = next;
    }
    return found;
  };
  const richOf = (index: number): RichValue => {
    const known = cache.get(index);
    if (known !== undefined) return known;
    const record = values[index];
    const structure =
      record === undefined ? undefined : structures[record.structure];
    if (record === undefined || structure === undefined)
      throw corruptRich(part, "references a missing rich value or structure");
    const field = (name: string, type: "s" | "i"): string | undefined => {
      let found: string | undefined;
      structure.keys.forEach((key, position) => {
        if (key.name !== name) return;
        if (key.type !== type || found !== undefined)
          throw corruptRich(part, `has an invalid rich field '${name}'`);
        found = record.values[position];
      });
      return found;
    };
    let result: RichValue;
    if (structure.type === "_localImage") {
      const relationIndex = indexOf(
        field("_rvRel:LocalImageIdentifier", "i"),
        part,
        "local image relationship",
      );
      const id = relationIds[relationIndex];
      const relation = id === undefined ? undefined : relationships?.get(id);
      if (
        relation?.kind !== "internal" ||
        !relation.type.endsWith("/image") ||
        opc.partSize(relation.target) === undefined
      )
        throw corruptRich(part, "references a missing or external local image");
      const origin = metadataIndex(
        field("CalcOrigin", "i"),
        part,
        "image origin",
      );
      const altText = field("Text", "s");
      result = {
        kind: "image",
        mediaPart: relation.target,
        ...(altText === undefined ? {} : { altText }),
        ...(origin === undefined ? {} : { decorative: origin === 6 }),
      };
    } else if (structure.type === "_error") {
      const code = indexOf(field("errorType", "i"), part, "rich error type");
      result =
        code === 8
          ? { kind: "error", error: "#SPILL!" }
          : code === 13
            ? { kind: "error", error: "#CALC!" }
            : { kind: "unsupported", type: structure.type };
    } else if (structure.type === "_linkedentity2") {
      const displayText = field("_DisplayString", "s");
      if (displayText === undefined)
        throw corruptRich(
          part,
          "has a linked value without its display string",
        );
      const entityId = field("%EntityId", "s");
      const entityCulture = field("%EntityCulture", "s");
      const serviceId = metadataIndex(
        field("%EntityServiceId", "i"),
        part,
        "entity service",
      );
      result = {
        kind: "linked",
        value: {
          type: "_linkedentity2",
          displayText,
          ...(entityId === undefined ? {} : { entityId }),
          ...(entityCulture === undefined ? {} : { entityCulture }),
          ...(serviceId === undefined ? {} : { serviceId }),
        },
      };
    } else result = { kind: "unsupported", type: structure.type };
    cache.set(index, result);
    return result;
  };
  return {
    mediaParts: [...mediaParts].sort(),
    value(index) {
      const future = futureOf(index, "values", "XLRICHVALUE");
      if (future === undefined) return undefined;
      if (future.rich === undefined)
        throw corruptRich(part, "is missing the rich value binding");
      return richOf(future.rich);
    },
    dynamic(index) {
      return futureOf(index, "cells", "XLDAPR")?.dynamic;
    },
  };
}
