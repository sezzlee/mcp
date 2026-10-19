import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { limits } from "../src/platform/limits.js";
import { createWorkbookRoot } from "../src/platform/paths.js";
import { createHandlers } from "../src/tools/handlers.js";
import { rawWorkbook } from "./fixtures/raw-workbook.js";

const letters = "ABCDEFGHIJKLMNOP".split("");
const errorText = "X".repeat(32_767);
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "excel-typed-report-budget-"));
  await writeFile(
    join(directory, "errors.xlsx"),
    await rawWorkbook({
      sheetData: [1, 2, 3]
        .map(
          (row) =>
            `<row r="${row}">${letters
              .map(
                (letter) =>
                  `<c r="${letter}${row}" t="e"><v>${errorText}</v></c>`,
              )
              .join("")}</row>`,
        )
        .join(""),
    }),
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("bounds error-cell diagnostic examples when a typed search has no matches", async () => {
  const handlers = createHandlers(await createWorkbookRoot(directory));
  const result = await handlers.find_in_sheet({
    filePath: "errors.xlsx",
    query: "not-present",
    matchMode: "exact",
    headerRow: 0,
    columnMode: "letter",
    columns: letters.map((column) => ({ column, type: "boolean" })),
  });
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Missing JSON response");
  expect(result.isError, content.text.slice(0, 300)).not.toBe(true);
  expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(
    limits.maxPayloadBytes,
  );
  const body = JSON.parse(content.text) as Record<string, unknown>;
  expect(body).toMatchObject({
    total: 0,
    scannedCells: 48,
    matches: [],
    typed: {
      scope: "scannedCells",
      columns: letters.map((column) => ({
        column,
        converted: 0,
        missing: 0,
        unreadable: 3,
        identifiers: 0,
        examples: [1, 2, 3].map((row) => ({
          cell: `${column}${row}`,
          value: { error: "X".repeat(128) },
          reason: "unreadable",
          truncatedFrom: 32_767,
        })),
      })),
    },
  });
});
