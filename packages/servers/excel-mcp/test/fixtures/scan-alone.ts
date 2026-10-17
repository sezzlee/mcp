import type { OpcPackage } from "../../src/metadata/spreadsheetml/package.js";
import {
  scanPart,
  type PartScan,
} from "../../src/metadata/spreadsheetml/xml.js";

/**
 * One reader's own pass over a part, as each reader scanned before they
 * shared one: the reference the shared pass is held to.
 */
export function scanAlone<T>(
  opc: OpcPackage,
  part: string,
  scan: PartScan<T>,
): T {
  scanPart(opc, part, scan.visitor);
  return scan.finish();
}
