import type { Vocabulary } from "@sezzlee/file-core";

export const vocabulary = {
  serverName: "excel-mcp",
  subject: "workbook",
  rootLabel: "workbook root",
  readableLabel: "readable spreadsheet",
  listTool: "list_workbooks",
  tooLargeRecovery:
    "Every tool opens the whole file, so no tool on this server can read it; tell the user it is over the limit, or split it into smaller files.",
} as const satisfies Vocabulary<string>;
