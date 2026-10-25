import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile


spec = importlib.util.spec_from_file_location("edit_inventory", Path(__file__).with_name("inspect-edit-corpus.py"))
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
STRICT = "http://purl.oclc.org/ooxml/spreadsheetml/main"
TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"


class EditCorpusContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.corpus = self.directory / "corpus"
        self.source = self.corpus / "original"
        (self.source / "files").mkdir(parents=True)

    def tearDown(self):
        self.temporary.cleanup()

    def workbook(self, namespace=MAIN, extra_parts=None):
        file = self.source / "files" / "original.xlsx"
        parts = {
            "[Content_Types].xml": f'<Types xmlns="{TYPES}"><Override PartName="/custom/book.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/custom/grid.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/custom/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
            "custom/book.xml": f'<workbook xmlns="{namespace}"><workbookPr date1904="1"/><sheets><sheet name="Data" sheetId="1" state="hidden"/></sheets><definedNames><definedName name="Total">Data!$A$1</definedName></definedNames></workbook>',
            "custom/grid.xml": f'<worksheet xmlns="{namespace}"><cols><col min="1" max="2" hidden="true"/></cols><sheetData><row r="1" hidden="1"><c r="A1" s="1"><f t="shared" si="0">B1+1</f><v>2</v></c><c r="B1"><v>1</v></c></row></sheetData><mergeCells><mergeCell ref="C1:D1"/></mergeCells><sheetProtection sheet="1"/><extLst/></worksheet>',
            "custom/styles.xml": f'<styleSheet xmlns="{namespace}"/>',
            "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/" TargetMode="External"/></Relationships>',
        }
        parts.update(extra_parts or {})
        with zipfile.ZipFile(file, "w") as package:
            for name, text in parts.items():
                package.writestr(name, text)
        return {"file": "files/original.xlsx", "format": "xlsx", "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}

    def test_counts_namespace_aware_features_and_never_claims_editing_support(self):
        entry = self.workbook()
        original = (self.source / entry["file"]).read_bytes()
        (self.source / "manifest.jsonl").write_text(json.dumps(entry) + "\n")
        out = self.directory / "evidence"
        result = inventory.run(self.corpus, out, [])
        self.assertEqual(result["statuses"], {"inspected": 1})
        self.assertFalse(result["editingSupportClaim"])
        item = json.loads((out / "inventory.jsonl").read_text())
        self.assertEqual(item["policyBlockers"], ["protection_markup"])
        for feature, count in {"cells": 2, "formulas": 1, "formula_shared": 1, "styled_cells": 1, "defined_names": 1, "merges": 1, "hidden_sheets": 1, "hidden_row_elements": 1, "hidden_col_elements": 1, "external_relationships": 1, "date1904": 1, "style_parts": 1}.items():
            self.assertEqual(item["features"][feature], count, feature)
        self.assertEqual((self.source / entry["file"]).read_bytes(), original)

    def test_strict_markup_and_macro_signature_blockers_survive_noncanonical_paths(self):
        entry = self.workbook(STRICT, {"custom/vbaProject.bin": "opaque", "_xmlsignatures/sig1.xml": "<signature/>"})
        entry["format"] = "xlsm"
        result = inventory.inspect_entry("original", self.source, entry)
        self.assertEqual(result["status"], "inspected")
        self.assertEqual(result["features"]["strict_markup"], 1)
        self.assertEqual(result["policyBlockers"], ["macros", "protection_markup", "package_signature", "xlsm_format"])

    def test_hash_mismatch_is_not_inspected(self):
        entry = self.workbook()
        entry["sha256"] = "0" * 64
        self.assertEqual(inventory.inspect_entry("original", self.source, entry)["status"], "sha_mismatch")

    def test_content_type_defaults_select_real_parts_and_overrides_take_precedence(self):
        entry = self.workbook(extra_parts={
            "[Content_Types].xml": f'<Types xmlns="{TYPES}"><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/custom/book.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/custom/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'
        })
        result = inventory.inspect_entry("original", self.source, entry)
        self.assertEqual(result["status"], "inspected")
        self.assertEqual(result["features"]["cells"], 2)
        self.assertEqual(result["features"]["hidden_sheets"], 1)
        self.assertEqual(result["features"]["style_parts"], 1)

    def test_manifest_escape_and_symlink_escape_are_refused(self):
        entry = self.workbook()
        (self.source / "files" / "escape.xlsx").symlink_to(self.directory / "outside.xlsx")
        for file in ["../outside.xlsx", str(self.directory / "outside.xlsx"), "files/escape.xlsx", "..\\outside.xlsx"]:
            self.assertEqual(inventory.inspect_entry("original", self.source, {**entry, "file": file})["status"], "outside_source")

    def test_malformed_manifest_rows_are_recorded_while_csv_is_excluded(self):
        (self.source / "manifest.jsonl").write_text('null\n{\n{"file": 2}\n' + json.dumps({"file": "files/plain.csv", "format": "csv", "sha256": "0" * 64}) + "\n")
        result = inventory.run(self.corpus, self.directory / "evidence", [])
        self.assertEqual(result["statuses"], {"malformed_manifest": 3})

    def test_existing_or_internal_output_is_refused_without_writing(self):
        with self.assertRaisesRegex(ValueError, "outside"):
            inventory.run(self.corpus, self.corpus / "evidence", [])
        with self.assertRaisesRegex(ValueError, "outside"):
            inventory.run(self.corpus, Path(__file__).resolve().parent / "evidence", [])
        with self.assertRaises(FileExistsError):
            inventory.run(self.corpus, self.directory, [])

    def test_corrupt_zip_and_expanded_part_budget_are_explicit_failures(self):
        entry = self.workbook(extra_parts={"large.xml": "0" * 1024})
        previous = inventory.MAX_PART
        try:
            inventory.MAX_PART = 512
            result = inventory.inspect_entry("original", self.source, entry)
            self.assertEqual(result["status"], "inspection_error")
            self.assertEqual(result["reason"], "part_budget")
        finally:
            inventory.MAX_PART = previous
        file = self.source / entry["file"]
        file.write_bytes(b"not a zip")
        entry["sha256"] = hashlib.sha256(file.read_bytes()).hexdigest()
        result = inventory.inspect_entry("original", self.source, entry)
        self.assertEqual(result["status"], "inspection_error")
        self.assertIn("zip", result["reason"].lower())


if __name__ == "__main__":
    unittest.main()
