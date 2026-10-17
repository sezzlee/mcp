import type { WorkbookPackage } from "./package.js";
import { namespaces, scanPart, type XmlVisitor } from "./xml.js";

const escapedCharacter = /_x([0-9A-Fa-f]{4})_/g;

/**
 * Decodes the ST_Xstring escape Excel writes for characters XML cannot carry
 * (`_x000D_` for a carriage return).
 *
 * Guard: one left-to-right pass, because `_x005F_` escapes the underscore that
 * would otherwise start an escape: `_x005F_x000D_` is the literal text
 * `_x000D_`, and a second pass would wrongly turn it into a carriage return.
 */
export function unescapeXstring(text: string): string {
  return text.replace(escapedCharacter, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * The text a cell shows for a stored string: escapes decoded, then every CRLF
 * pair folded to a line feed.
 *
 * Guard: the fold is what SheetJS does to every cell string (`unescapexml(…,
 * true)`, unchanged on its master branch), and a line break typed in Excel is a
 * lone line feed; keeping the CR would change these cells' text, length and
 * truncation while the reader is replaced.
 */
export function cellText(stored: string): string {
  return unescapeXstring(stored).replace(/\r\n/g, "\n");
}

/**
 * Collects the visible text of each plain or rich string item named
 * `container` (`si` in the shared string table, `is` in an inline cell):
 * every `<t>` run except those under `<rPh>`, which are phonetic reading
 * guides shown above the text, not part of the value.
 */
export function stringItemVisitor(
  container: string,
  onItem: (text: string) => void,
): Required<XmlVisitor> {
  let inItem = false;
  let phoneticDepth = 0;
  let inText = false;
  let text = "";
  return {
    onOpen(node) {
      if (node.uri !== namespaces.spreadsheetml) return;
      if (node.local === container) {
        inItem = true;
        phoneticDepth = 0;
        text = "";
      } else if (node.local === "rPh") {
        phoneticDepth += 1;
      } else if (node.local === "t" && inItem && phoneticDepth === 0) {
        inText = true;
      }
    },
    onText(chunk) {
      if (inText) text += chunk;
    },
    onClose(local, uri) {
      if (uri !== namespaces.spreadsheetml) return;
      if (local === "t") {
        inText = false;
      } else if (local === "rPh") {
        phoneticDepth -= 1;
      } else if (local === container && inItem) {
        inItem = false;
        onItem(cellText(text));
      }
    },
  };
}

/**
 * Reads the shared string table in document order; a cell of type `s` holds an
 * index into it. A workbook without the part has an empty table.
 */
export function readSharedStrings(opc: WorkbookPackage): readonly string[] {
  const path = opc.sharedStringsPart;
  if (path === undefined) return [];
  const strings: string[] = [];
  scanPart(
    opc,
    path,
    stringItemVisitor("si", (text) => strings.push(text)),
  );
  return strings;
}
