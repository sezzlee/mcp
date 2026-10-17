import type { OoxmlErrorCode, OoxmlErrorFactory } from "@sezzlee/ooxml-core";
import {
  SezzleeExcelError,
  type SezzleeExcelErrorCode,
} from "../../platform/errors.js";

interface Mapping {
  readonly code: SezzleeExcelErrorCode;
  readonly recovery: string;
}

const reSave = "Open the file in Excel and re-save it as .xlsx.";
const notASpreadsheet =
  "The file is probably not a spreadsheet; check what it really is before reading it.";

const mappings: Readonly<Record<OoxmlErrorCode, Mapping>> = {
  not_a_package: { code: "not_a_workbook", recovery: notASpreadsheet },
  legacy_binary_container: {
    code: "encrypted_workbook",
    recovery: "Save an unprotected copy in .xlsx format.",
  },
  corrupt_package: { code: "corrupt_workbook", recovery: reSave },
  unsupported_zip_feature: { code: "corrupt_workbook", recovery: reSave },
  malformed_part_name: { code: "corrupt_workbook", recovery: reSave },
  unsupported_part_encoding: { code: "corrupt_workbook", recovery: reSave },
  part_too_large: {
    code: "file_too_large",
    recovery: "Split the sheet, or read a narrower range.",
  },
  package_too_large: {
    code: "file_too_large",
    recovery: "Split the sheet, or read a narrower range.",
  },
};

/**
 * Translates a container failure into this server's vocabulary. The core states
 * the fact and knows no spreadsheet nouns; the code and the recovery advice are
 * chosen here, which is the only place they belong.
 *
 * Guard: this adapter cannot be skipped by accident. Under `strictFunctionTypes`
 * the server's own `ErrorFactory` is not assignable to `OoxmlErrorFactory`,
 * because codes such as `corrupt_package` are not in the server's union.
 */
export const failOoxml: OoxmlErrorFactory = (code, message) => {
  const mapping = mappings[code];
  return new SezzleeExcelError(mapping.code, message, mapping.recovery);
};
