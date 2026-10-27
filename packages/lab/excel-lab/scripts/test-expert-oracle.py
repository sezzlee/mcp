import json
import runpy
import tempfile
import unittest
import zipfile
from pathlib import Path

oracle = runpy.run_path(str(Path(__file__).with_name("expert-oracle.py")))
MAIN = oracle["MAIN"]
OFFICE = oracle["OFFICE"]
REL = "http://schemas.openxmlformats.org/package/2006/relationships"


def relationships(entries):
    return '<Relationships xmlns="' + REL + '">' + "".join('<Relationship Id="' + identity + '" Type="' + OFFICE + '/' + kind + '" Target="' + target + '"/>' for identity, kind, target in entries) + '</Relationships>'


def fixture(path, bad_total=False, bad_cache=False, missing_target=False):
    parts = {
        "_rels/.rels": relationships([("r1", "officeDocument", "xl/workbook.xml")]),
        "xl/workbook.xml": '<workbook xmlns="' + MAIN + '" xmlns:r="' + OFFICE + '"><sheets><sheet name="Data" sheetId="1" r:id="r1"/><sheet name="Report" sheetId="2" r:id="r2"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": relationships([("r1", "worksheet", "worksheets/data.xml"), ("r2", "worksheet", "worksheets/report.xml")]),
        "xl/worksheets/data.xml": '<worksheet xmlns="' + MAIN + '"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Region</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>North</t></is></c><c r="B2"><v>7</v></c></row></sheetData></worksheet>',
        "xl/worksheets/report.xml": '<worksheet xmlns="' + MAIN + '"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Region</t></is></c><c r="B1" t="inlineStr"><is><t>Total</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>North</t></is></c><c r="B2"><v>7</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Grand Total</t></is></c><c r="B3"><v>' + ('99' if bad_total else '7') + '</v></c></row></sheetData></worksheet>',
        "xl/worksheets/_rels/report.xml.rels": relationships([("r1", "pivotTable", "../pivotTables/pivot.xml")]),
        "xl/pivotTables/pivot.xml": '<pivotTableDefinition xmlns="' + MAIN + '" name="Regional" cacheId="1" dataCaption="Values"><location ref="A1:B3"/><rowFields><field x="0"/></rowFields><dataFields><dataField name="Total" fld="1" subtotal="sum"/></dataFields></pivotTableDefinition>',
        "xl/pivotTables/_rels/pivot.xml.rels": relationships([("r1", "pivotCacheDefinition", "../pivotCache/cache.xml")]),
        "xl/pivotCache/cache.xml": '<pivotCacheDefinition xmlns="' + MAIN + '" recordCount="1"><cacheSource><worksheetSource sheet="Data" ref="A1:B2"/></cacheSource><cacheFields><cacheField><sharedItems><s v="North"/></sharedItems></cacheField><cacheField><sharedItems><n v="' + ('9' if bad_cache else '7') + '"/></sharedItems></cacheField></cacheFields></pivotCacheDefinition>',
        "xl/pivotCache/_rels/cache.xml.rels": relationships([("r1", "pivotCacheRecords", "missing.xml" if missing_target else "records.xml")]),
        "xl/pivotCache/records.xml": '<pivotCacheRecords xmlns="' + MAIN + '"><r><x v="0"/><x v="0"/></r></pivotCacheRecords>',
    }
    with zipfile.ZipFile(path, "w") as archive:
        for name, content in parts.items():
            archive.writestr(name, content)


class ExpertOracleTest(unittest.TestCase):
    def inspect(self, **options):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.xlsx"
            fixture(path, **options)
            return oracle["inspect"](path)

    def test_independent_known_total(self):
        self.assertEqual(self.inspect()["pivots"][0]["result"], [["Region", "Total"], ["North", 7], ["Grand Total", 7]])

    def test_corrupt_saved_result_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Materialized pivot"):
            self.inspect(bad_total=True)

    def test_corrupt_cache_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "cache records differ"):
            self.inspect(bad_cache=True)

    def test_broken_relationship_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Relationship target absent"):
            self.inspect(missing_target=True)

    def test_scalar_types_do_not_collapse(self):
        self.assertFalse(oracle["equivalent"](True, 1))
        self.assertFalse(oracle["equivalent"]("7", 7))
        self.assertTrue(oracle["equivalent"](7.0, 7))

    def test_literal_escape_is_decoded_once(self):
        self.assertEqual(oracle["xstring"]("_x005F_x0041_"), "_x0041_")


if __name__ == "__main__":
    unittest.main()
