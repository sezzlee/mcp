import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import ExcelJS from "exceljs";
import JSZip from "jszip";
/**
 * Guard: dist/index.js is the only dist path this fixture may name. It is the
 * entry check-npm-tarballs.py pins, so it survives every src/ folder change; a
 * deep dist specifier goes stale on the next move and the child then exits 1
 * with MODULE_NOT_FOUND, which reads as a resource-limit failure in the spec.
 */
import {
  collectValidations,
  describeOoxml,
  parseCsv,
  parseOoxml,
} from "../../dist/index.js";
const report = {};
let start = performance.now();
const bytes = Buffer.alloc(16 * 1024 * 1024, 0x61);
const csv = await parseCsv(
  bytes,
  bytes.length,
  { delimiter: "comma" },
  "limit.csv",
);
assert.equal(csv.rows[0][0].length, bytes.length);
report.csvBytes = bytes.length;
report.csvParseMs = performance.now() - start;
const record = Buffer.from(Array(16385).fill("x").join(","));
start = performance.now();
await assert.rejects(
  parseCsv(record, record.length, { delimiter: "comma" }, "wide.csv"),
  { code: "file_too_large" },
);
report.wideRejectionMs = performance.now() - start;
const book = new ExcelJS.Workbook();
const sheet = book.addWorksheet("Validation");
sheet.getCell("A1").value = "value";
sheet.getCell("A2").value = 1;
sheet.getCell("A2").dataValidation = {
  type: "whole",
  operator: "between",
  formulae: [1, 9],
};
const zip = await JSZip.loadAsync(await book.xlsx.writeBuffer());
const xml = await zip.file("xl/worksheets/sheet1.xml").async("string");
assert.ok(xml.includes('sqref="A2"'));
zip.file(
  "xl/worksheets/sheet1.xml",
  xml.replace('sqref="A2"', 'sqref="A2:A5002"'),
);
const xlsx = await zip.generateAsync({ type: "nodebuffer" });
start = performance.now();
const parsed = parseOoxml(xlsx, "validation.xlsx");
const describeOptions = { includeDefinedNames: false };
report.validationParseMs = performance.now() - start;
const validations = collectValidations(
  "Validation",
  parsed.facts("Validation").validations,
);
assert.equal(validations.count, 1);
assert.equal(validations.coveredCellCount, 5001);
report.validationCoveredCells = validations.coveredCellCount;
const meta = {
  filePath: "validation.xlsx",
  sizeBytes: xlsx.length,
  modifiedAt: "2026-01-01T00:00:00.000Z",
};
start = performance.now();
const described = describeOoxml(parsed, meta, describeOptions);
report.validationDescribeMs = performance.now() - start;
assert.equal(described.sheets[0].dataValidationRuleCount, 1);
assert.equal(described.sheets[0].dataValidationRuleCountExact, true);
start = performance.now();
describeOoxml(parsed, meta, describeOptions);
report.validationCachedDescribeMs = performance.now() - start;
report.peakRssKiB = process.resourceUsage().maxRSS;
assert.ok(report.peakRssKiB < 1024 * 1024, "resource test exceeded 1 GiB RSS");
console.log(JSON.stringify(report));
