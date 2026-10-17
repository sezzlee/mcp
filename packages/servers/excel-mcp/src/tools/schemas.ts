import { z } from "zod";

export const filePath = z
  .string()
  .describe(
    "Workbook path relative to the server root, as returned by list_workbooks.",
  );
export const sheetName = z
  .string()
  .optional()
  .describe(
    "Case-sensitive worksheet name with NFC equivalence; no case-insensitive fallback. Defaults to the first visible sheet. Unknown names return available names.",
  );
export const columnRef = z
  .string()
  .describe(
    "Header text of the column, or its A1 letter such as C. Header text is matched case- and accent-insensitively.",
  );
export const drawingKind = z
  .enum(["picture", "chart", "pivotTable", "sparkline"])
  .optional()
  .describe(
    "Drawing kind. Only 'picture' can be read here; use get_charts for charts. Pivot tables and sparklines are refused rather than reported as absent.",
  );

export const delimiter = z
  .enum(["comma", "semicolon", "tab", "pipe"])
  .optional()
  .describe("CSV field separator. Sniffed and echoed back when omitted.");

export const encoding = z
  .enum([
    "utf-8",
    "utf-16le",
    "utf-16be",
    "windows-1254",
    "iso-8859-9",
    "windows-1252",
  ])
  .optional()
  .describe(
    "CSV text encoding. Detected from the byte-order mark, else utf-8.",
  );
