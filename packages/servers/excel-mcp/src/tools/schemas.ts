import { z } from "zod";
import { limits } from "../platform/limits.js";

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

const columnSpec = { column: columnRef };

export const columnSpecs = z
  .array(
    z.discriminatedUnion("type", [
      z.object({
        ...columnSpec,
        type: z.literal("number"),
        decimal: z
          .enum([".", ","])
          .describe("Decimal separator of the column's numbers."),
        group: z
          .enum(["none", ".", ",", " ", "'"])
          .optional()
          .describe(
            "Thousands separator. Defaults to '.' for a decimal comma and ',' for a decimal point.",
          ),
      }),
      z.object({
        ...columnSpec,
        type: z.literal("date"),
        format: z
          .string()
          .min(1)
          .max(64)
          .describe(
            "Date pattern such as dd.MM.yyyy, MM/dd/yyyy h:mm a or d MMMM yyyy (yyyy MM M MMM MMMM dd d HH H hh h mm ss a). Month names may be Turkish or English.",
          ),
      }),
      z.object({ ...columnSpec, type: z.literal("text") }),
    ]),
  )
  .min(1)
  .max(limits.maxColumnSpecs)
  .optional()
  .describe(
    "How to read a column's text. Omitted columns are read automatically: text that reads as numbers or dates column by column is compared and summed as such. Use it when a warning names an ambiguous column, or type text to compare a column as written.",
  );
