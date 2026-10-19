"""Inspect fixed CI workbook bytes with Python's ZIP/XML implementation, without MCP."""

from pathlib import Path
import base64
import hashlib
import io
import json
import math
import posixpath
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[4]
FIXTURES = ROOT / "packages/servers/excel-mcp/test/fixtures"
NS = {
    "x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rd": "http://schemas.microsoft.com/office/spreadsheetml/2017/richdata",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "p": "http://schemas.openxmlformats.org/package/2006/relationships",
    "da": "http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray",
}


def required(node, path):
    match = node.find(path, NS)
    assert match is not None, path
    return match


def cell(sheet, address):
    return required(sheet, f"x:sheetData/x:row/x:c[@r='{address}']")


def value(sheet, address):
    return required(cell(sheet, address), "x:v").text


class Workbook:
    def __init__(self, name, sha256, size):
        encoded = (FIXTURES / f"{name}.xlsx.base64").read_bytes()
        data = base64.b64decode(b"".join(encoded.split()), validate=True)
        assert len(data) == size, name
        assert hashlib.sha256(data).hexdigest() == sha256, name
        self.archive = zipfile.ZipFile(io.BytesIO(data))
        self.summary = {"fixture": name, "sha256": sha256, "bytes": size}
        self.relationships = self.xml("xl/_rels/workbook.xml.rels")
        self.metadata = self.related("sheetMetadata")[1]
        self.values = self.related("rdRichValue")[1]
        self.structures = self.related("rdRichValueStructure")[1]

    def xml(self, path):
        return ET.fromstring(self.archive.read(path))

    def related(self, suffix):
        links = [item for item in self.relationships if item.attrib["Type"].endswith("/" + suffix)]
        assert len(links) == 1, suffix
        relationship = links[0]
        assert relationship.attrib.get("TargetMode") != "External"
        target = relationship.attrib["Target"]
        path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
        assert not path.startswith("../")
        return path, self.xml(path)

    def rich(self, sheet, address):
        location = cell(sheet, address)
        assert location.attrib["t"] == "e" and value(sheet, address) == "#VALUE!"
        vm = int(location.attrib["vm"])
        record = required(required(self.metadata, "x:valueMetadata")[vm - 1], "x:rc")
        type_index = int(record.attrib["t"])
        metadata_type = required(self.metadata, "x:metadataTypes")[type_index - 1].attrib["name"]
        assert metadata_type == "XLRICHVALUE"
        future_index = int(record.attrib["v"])
        future = required(self.metadata, "x:futureMetadata[@name='XLRICHVALUE']")
        rich_index = int(required(future[future_index], ".//rd:rvb").attrib["i"])
        rich_value = self.values[rich_index]
        structure_index = int(rich_value.attrib["s"])
        structure = self.structures[structure_index]
        contents = rich_value.findall("rd:v", NS)
        assert len(contents) <= len(structure)
        fields = [(key.attrib["n"], key.attrib.get("t", "n"), content.text)
                  for key, content in zip(structure, contents)]
        return (vm, type_index, future_index, rich_index, structure_index), structure.attrib["t"], fields


original = Workbook("rich-values", "b29d5664bfebd138af4f55135b4470e682065cb0a2fcbfce5a680e5f5c6ff9e3", 11600)
rich = original.xml("xl/worksheets/sheet1.xml")
for address, indices, origin, alt, media in [
    ("A2", (1, 2, 0, 0, 0), "5", "店舗 — München — متجر <A&B>", "9c2cc5a6aa11580f7b76b00fa0878edc89be4a882dc166592dadd00684d951a6"),
    ("A3", (2, 2, 1, 1, 0), "6", None, "b877b4f9531fec4f6a5541bc2a268309efca0b4238f4fc2babb46200430082ea"),
]:
    chain, kind, fields = original.rich(rich, address)
    assert chain == indices and kind == "_localImage"
    data = {name: content for name, _, content in fields}
    assert data["CalcOrigin"] == origin and data.get("Text") == alt
    relation_index = int(data["_rvRel:LocalImageIdentifier"])
    references = original.xml("xl/richData/richValueRel.xml")
    rel_id = references[relation_index].attrib[f"{{{NS['r']}}}id"]
    relations = original.xml("xl/richData/_rels/richValueRel.xml.rels")
    relation = required(relations, f"p:Relationship[@Id='{rel_id}']")
    assert relation.attrib.get("TargetMode") != "External"
    path = posixpath.normpath(posixpath.join("xl/richData", relation.attrib["Target"]))
    assert hashlib.sha256(original.archive.read(path)).hexdigest() == media

anchor = cell(rich, "C2")
assert anchor.attrib["cm"] == "1"
record = required(required(original.metadata, "x:cellMetadata")[0], "x:rc")
assert record.attrib == {"t": "1", "v": "0"}
assert required(original.metadata, "x:metadataTypes")[0].attrib["name"] == "XLDAPR"
properties = required(required(original.metadata, "x:futureMetadata[@name='XLDAPR']")[0], ".//da:dynamicArrayProperties")
assert properties.attrib == {"fDynamic": "1", "fCollapsed": "0"}
formula = required(anchor, "x:f")
assert formula.attrib == {"t": "array", "ref": "C2:C4"}
assert formula.text == "_xlfn.SEQUENCE(3,1,10,10)"
assert [int(value(rich, address)) for address in ["C2", "C3", "C4"]] == [10, 20, 30]
assert cell(rich, "C3").find("x:f", NS) is None and cell(rich, "C4").find("x:f", NS) is None
styles = original.xml("xl/styles.xml")
for address, seconds in [("D2", 129600), ("D3", 5400), ("D4", 1)]:
    style = required(styles, "x:cellXfs")[int(cell(rich, address).attrib["s"])]
    code = required(styles, f"x:numFmts/x:numFmt[@numFmtId='{style.attrib['numFmtId']}']")
    assert code.attrib["formatCode"] == "[h]:mm:ss"
    assert math.isclose(float(value(rich, address)) * 86400, seconds)
for address, error in [("E2", "#DIV/0!"), ("E3", "#N/A"), ("E4", "#NUM!")]:
    assert cell(rich, address).attrib["t"] == "e" and "vm" not in cell(rich, address).attrib
    assert value(rich, address) == error
assert [(cell(rich, address).attrib["t"], value(rich, address)) for address in ["F2", "F3"]] == [("b", "1"), ("b", "0")]
assert [float(value(rich, address)) for address in ["G2", "G3"]] == [0.25, 250]
strings = original.xml("xl/sharedStrings.xml")
assert [required(strings[int(value(rich, address))], "x:t").text for address in ["H2", "H3"]] == ["00123", "1234567890123456789"]
table = original.xml("xl/tables/table1.xml")
assert table.attrib["name"] == "RecordedSales" and table.attrib["ref"] == "A1:D6"
assert table.attrib["totalsRowCount"] == "1" and required(table, "x:autoFilter").attrib["ref"] == "A1:D5"
for path, hidden, total in [("xl/worksheets/sheet2.xml", [3], 80), ("xl/worksheets/sheet3.xml", [3, 5], 40)]:
    sheet = original.xml(path)
    assert [int(row.attrib["r"]) for row in required(sheet, "x:sheetData") if row.attrib.get("hidden") == "1"] == hidden
    assert sum(float(value(sheet, f"B{row}")) for row in [2, 3, 4, 5]) == 100
    assert sum(float(value(sheet, f"B{row}")) for row in [2, 3, 4, 5] if row not in hidden) == total
assert [sheet.attrib["name"] for sheet in required(original.xml("xl/workbook.xml"), "x:sheets") if sheet.attrib.get("state") == "hidden"] == ["Hidden Sheet"]

linked = Workbook("linked-seattle", "537a61c16e9c09a33d405e5f828d0e17b9462a69396e42203cc77706e63c6a12", 8544)
assert linked.related("sheetMetadata")[0] == "xl/metadata1.xml"
chain, kind, fields = linked.rich(linked.related("worksheet")[1], "A1")
assert chain == (1, 1, 0, 0, 0) and kind == "_linkedentity2"
assert fields == [("%EntityServiceId", "i", "536870912"), ("_DisplayString", "s", "Seattle"),
                  ("%EntityId", "s", "5fbba6b8-85e1-4d41-9444-d9055436e473"),
                  ("%EntityCulture", "s", "en-US"), ("_Icon", "s", "Map")]
assert not any(name.startswith("xl/media/") for name in linked.archive.namelist())

errors = Workbook("rich-errors", "9ee3db1974c3bebed188a0e098815806bae179a6b6dca0c453ea01c80b7cdaa1", 11688)
sheet = errors.xml("xl/worksheets/sheet1.xml")
for address, indices, expected, direct, display in [
    ("E5", (3, 2, 2, 2, 1), [("errorType", "i", "8"), ("colOffset", "i", "0"), ("rwOffset", "i", "2")], "F5", "#SPILL!"),
    ("E6", (4, 2, 3, 3, 2), [("errorType", "i", "13")], "F6", "#CALC!"),
]:
    chain, kind, fields = errors.rich(sheet, address)
    assert chain == indices and kind == "_error" and fields == expected
    assert cell(sheet, direct).attrib == {"r": direct, "t": "e"} and value(sheet, direct) == display

print(json.dumps({"status": "passed", "boundary": "fixed independent Python ZIP/XML oracle; no MCP parser",
                  "excelRecalculated": False, "externalLinksFetched": False,
                  "fixtures": [workbook.summary for workbook in [original, linked, errors]]}, indent=2))
