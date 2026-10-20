import type { HeaderPreview } from "../grid/header.js";
import type { MetadataLimitation } from "./support.js";

export interface DocumentMeta {
  readonly filePath: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
}

export type SheetKind = "worksheet" | "chartsheet";

export interface SheetSummary {
  readonly name: string;
  readonly index: number;
  readonly state: string;
  readonly kind: SheetKind;
  readonly usedRange: string | null;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly declaredRowCount: number | null;
  readonly declaredColumnCount: number | null;
  readonly mergeCount: number | null;
  readonly dataValidationRuleCount: number | null;
  readonly dataValidationRuleCountExact: boolean;
  readonly formulaCellCount: number | null;
  readonly cachedFormulaValueCount: number | null;
  readonly tableCount: number | null;
  readonly conditionalFormatRuleCount: number | null;
  readonly imageCount: number | null;
  readonly imageCountExact: boolean;
  readonly chartCount: number | null;
  readonly autoFilterRef: string | null;
  readonly frozenRowCount: number | null;
  readonly frozenColumnCount: number | null;
  /** The header row a read that names none uses, with its first named columns. */
  readonly header: HeaderPreview | null;
}

export interface WorkbookDescription {
  readonly limitations?: readonly MetadataLimitation[];
  readonly definedNamesComplete?: false;
  readonly filePath: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly dateSystem: "1900" | "1904" | null;
  readonly sheets: readonly SheetSummary[];
  readonly definedNames?: readonly {
    readonly name: string;
    readonly ranges: readonly string[];
  }[];
  readonly guidance?: string;
}
