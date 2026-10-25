"""Independent standard-library ZIP/XML oracle for generated Phase 1 outputs."""

import argparse
import hashlib
import json
import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"


def unescape(text):
    return re.sub(r"_x([0-9a-fA-F]{4})_", lambda match: chr(int(match[1], 16)), text)


def verify(filename, expected, rows, columns, edited, dataset):
    with zipfile.ZipFile(filename) as archive:
        assert archive.testzip() is None, "ZIP CRC validation failed"
        names = archive.namelist()
        assert len(names) == len(set(names)), "duplicate package parts"
        assert all(not name.startswith("/") and ".." not in name.split("/") for name in names)
        for name in names:
            if name.endswith(".rels"):
                relationships = ET.fromstring(archive.read(name))
                assert all(item.attrib.get("TargetMode") != "External" for item in relationships)
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        types = ET.fromstring(archive.read("[Content_Types].xml"))
        overrides = {item.attrib["PartName"]: item.attrib["ContentType"] for item in types.findall(f"{{{CONTENT_TYPES}}}Override")}
        assert overrides["/xl/workbook.xml"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
        assert overrides["/xl/styles.xml"] == "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"
        root_relationships = ET.fromstring(archive.read("_rels/.rels"))
        assert any(item.attrib.get("Type") == OFFICE + "/officeDocument" and item.attrib.get("Target") == "xl/workbook.xml" for item in root_relationships)
        styles = ET.fromstring(archive.read("xl/styles.xml"))
        formats = {item.attrib["numFmtId"]: item.attrib["formatCode"] for item in styles.findall(f"{{{MAIN}}}numFmts/{{{MAIN}}}numFmt")}
        assert formats["164"] == "yyyy-mm-dd"
        assert formats["165"] == 'yyyy-mm-dd"T"hh:mm:ss.000'
        cell_styles = styles.findall(f"{{{MAIN}}}cellXfs/{{{MAIN}}}xf")
        assert cell_styles[1].attrib["numFmtId"] == "164" and cell_styles[2].attrib["numFmtId"] == "165"
        sheets = workbook.findall(f"{{{MAIN}}}sheets/{{{MAIN}}}sheet")
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {item.attrib["Id"]: item.attrib["Target"] for item in relationships}
        if expected:
            assert [unescape(sheet.attrib["name"]) for sheet in sheets] == [sheet["name"] for sheet in expected["sheets"]]
        count = 0
        total = 0
        expanded = sum(info.file_size for info in archive.infolist())
        seen = bytearray(rows * columns) if rows else None
        for sheet_index, sheet in enumerate(sheets):
            part = "xl/" + targets[sheet.attrib[f"{{{OFFICE}}}id"]]
            assert overrides["/" + part] == "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
            actual = {}
            with archive.open(part) as stream:
                for _, element in ET.iterparse(stream, events=("end",)):
                    if element.tag != f"{{{MAIN}}}c":
                        if element.tag == f"{{{MAIN}}}row":
                            element.clear()
                        continue
                    reference = element.attrib["r"]
                    kind = element.attrib.get("t")
                    assert element.find(f"{{{MAIN}}}f") is None, "unexpected formula"
                    value = element.findtext(f"{{{MAIN}}}v")
                    if kind == "inlineStr":
                        value = unescape("".join(item.text or "" for item in element.findall(f"{{{MAIN}}}is/{{{MAIN}}}t")))
                        cell = {"kind": "text", "value": value}
                    elif kind == "n":
                        value = float(value)
                        cell = {"kind": "number", "value": value}
                    elif kind == "b":
                        assert value in ("0", "1")
                        cell = {"kind": "boolean", "value": value == "1"}
                    elif kind == "d":
                        cell = {"kind": "date" if element.attrib.get("s") == "1" else "datetime", "value": value}
                    else:
                        raise AssertionError(f"unsupported cell type {kind}")
                    if rows and sheet_index == 0:
                        match = re.fullmatch(r"([A-Z]+)([1-9][0-9]*)", reference)
                        assert match
                        column = 0
                        for letter in match[1]:
                            column = column * 26 + ord(letter) - ord("A") + 1
                        row = int(match[2])
                        assert 1 <= row <= rows and 1 <= column <= columns
                        index = (row - 1) * columns + column - 1
                        assert seen[index] == 0, "duplicate cell coordinates"
                        seen[index] = 1
                        wanted = {"kind": "number", "value": (row - 1) * columns + column - 1}
                        if dataset == "mixed":
                            special = {
                                1: {"kind": "text", "value": str(row - 1).zfill(8)},
                                2: {"kind": "number", "value": (row - 1) / 4},
                                3: {"kind": "boolean", "value": (row - 1) % 2 == 0},
                                5: {"kind": "text", "value": ""},
                                6: {"kind": "date", "value": "2026-10-25"},
                                7: {"kind": "datetime", "value": "2026-10-25T09:30:00.125"},
                                8: {"kind": "text", "value": "  Türkçe 😀 <&> _x000D_\r\n  "},
                            }
                            assert column != 4, "blank cells must not be stored"
                            wanted = special.get(column, wanted)
                        if edited and reference == "A1":
                            wanted = {"kind": "number", "value": -1}
                        assert cell == wanted, (reference, cell, wanted)
                        if cell["kind"] == "number":
                            total += cell["value"]
                        count += 1
                    if expected:
                        assert reference not in actual
                        actual[reference] = cell
                    element.clear()
            if expected:
                wanted = {ref: cell for ref, cell in expected["sheets"][sheet_index]["cells"].items() if cell["kind"] != "blank"}
                assert actual == wanted, (sheet.attrib["name"], actual, wanted)
        if rows:
            size = rows * columns
            stored = size - (rows if dataset == "mixed" and columns >= 4 else 0)
            assert count == stored, (count, stored)
            if dataset == "sequence":
                assert total == size * (size - 1) // 2 - (1 if edited else 0)
        return {"file": str(filename), "sha256": hashlib.sha256(Path(filename).read_bytes()).hexdigest(), "parts": len(names), "expandedBytes": expanded, "checkedCells": count, "sum": total, "status": "passed"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("file", type=Path)
    parser.add_argument("--expected", type=Path)
    parser.add_argument("--sequence-rows", type=int, default=0)
    parser.add_argument("--columns", type=int, default=20)
    parser.add_argument("--edited", action="store_true")
    parser.add_argument("--dataset", choices=("sequence", "mixed"), default="sequence")
    args = parser.parse_args()
    expected = json.loads(args.expected.read_text()) if args.expected else None
    assert expected is not None or args.sequence_rows > 0, "provide independent expected cells or sequence dimensions"
    print(json.dumps(verify(args.file, expected, args.sequence_rows, args.columns, args.edited, args.dataset)))


if __name__ == "__main__":
    main()
