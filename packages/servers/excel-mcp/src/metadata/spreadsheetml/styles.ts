import type { WorkbookPackage } from "./package.js";
import { namespaces, readXmlPart } from "./xml.js";

/**
 * The formats ECMA-376 Part 1 §18.8.30 assigns to the built-in ids, as SheetJS
 * spells them, including the ids Excel maps onto another one.
 */
const builtInFormats: Readonly<Record<number, string>> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  5: '"$"#,##0_);\\("$"#,##0\\)',
  6: '"$"#,##0_);[Red]\\("$"#,##0\\)',
  7: '"$"#,##0.00_);\\("$"#,##0.00\\)',
  8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  12: "# ?/?",
  13: "# ??/??",
  14: "m/d/yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yy h:mm",
  23: "General",
  24: "General",
  25: "General",
  26: "General",
  27: "m/d/yy",
  28: "m/d/yy",
  29: "m/d/yy",
  30: "m/d/yy",
  31: "m/d/yy",
  32: "h:mm:ss",
  33: "h:mm:ss",
  34: "h:mm:ss",
  35: "h:mm:ss",
  36: "m/d/yy",
  37: "#,##0 ;(#,##0)",
  38: "#,##0 ;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)',
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
  50: "m/d/yy",
  51: "m/d/yy",
  52: "m/d/yy",
  53: "m/d/yy",
  54: "m/d/yy",
  55: "m/d/yy",
  56: '"上午/下午 "hh"時"mm"分"ss"秒 "',
  57: "m/d/yy",
  58: "m/d/yy",
  59: "0",
  60: "0.00",
  61: "#,##0",
  62: "#,##0.00",
  63: '"$"#,##0_);\\("$"#,##0\\)',
  64: '"$"#,##0_);[Red]\\("$"#,##0\\)',
  65: '"$"#,##0.00_);\\("$"#,##0.00\\)',
  66: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  67: "0%",
  68: "0.00%",
  69: "# ?/?",
  70: "# ??/??",
  71: "m/d/yy",
  72: "m/d/yy",
  73: "d-mmm-yy",
  74: "d-mmm",
  75: "mmm-yy",
  76: "h:mm",
  77: "h:mm:ss",
  78: "m/d/yy h:mm",
  79: "mm:ss",
  80: "[h]:mm:ss",
  81: "mmss.0",
};

/**
 * Format codes third-party writers emit that Excel itself would refuse; each
 * is replaced by the code Excel means by it (Google Sheets writes `d.m`).
 */
const repairedFormats: Readonly<Record<string, string>> = { "d.m": "d\\.m" };

export interface NumberFormats {
  /** @returns the format code a cell with this style index displays with. */
  formatOf(style: number): string;
}

/**
 * Reads the custom number formats and the cell formats (`cellXfs`) of the
 * styles part. A workbook without the part, or a style index past the table,
 * displays as `General`.
 */
export function readNumberFormats(opc: WorkbookPackage): NumberFormats {
  const custom = new Map<number, string>();
  const formatIds: number[] = [];
  const path = opc.stylesPart;
  const xml = path === undefined ? undefined : opc.part(path);
  if (path !== undefined && xml !== undefined) {
    let block: "numFmts" | "cellXfs" | undefined;
    readXmlPart(xml, path, {
      onOpen(node) {
        if (node.uri !== namespaces.spreadsheetml) return;
        if (node.local === "numFmts" || node.local === "cellXfs") {
          block = node.local;
        } else if (block === "numFmts" && node.local === "numFmt") {
          /**
           * Guard: only the `<numFmts>` block defines the workbook's formats.
           * Each differential format under `<dxfs>` carries its own `numFmt`,
           * often reusing a built-in id (`14` as `0.00%`), and reading it here
           * would restyle every date cell. Id 0 stays `General`, as in Excel.
           */
          const id = Number(node.attr("numFmtId"));
          const code = node.attr("formatCode");
          if (Number.isInteger(id) && id > 0 && code !== undefined) {
            custom.set(id, repairedFormats[code] ?? code);
          }
        } else if (block === "cellXfs" && node.local === "xf") {
          const id = Number(node.attr("numFmtId") ?? "0");
          formatIds.push(Number.isInteger(id) && id >= 0 ? id : 0);
        }
      },
      onClose(local, uri) {
        if (uri !== namespaces.spreadsheetml) return;
        if (local === "numFmts" || local === "cellXfs") block = undefined;
      },
    });
  }
  return {
    formatOf(style) {
      const id = formatIds.at(style) ?? 0;
      return custom.get(id) ?? builtInFormats[id] ?? "General";
    },
  };
}
