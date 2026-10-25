import hashlib
import json
import posixpath
import re
import sys
from pathlib import Path
from urllib.parse import unquote
import xml.etree.ElementTree as ET
import zipfile


MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"s": MAIN, "r": REL}


def sha(file):
    value = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def coordinate(address):
    match = re.fullmatch(r"([A-Z]{1,3})([1-9][0-9]*)", address)
    assert match, ("coordinate", address)
    column = 0
    for letter in match[1]:
        column = column * 26 + ord(letter) - 64
    row = int(match[2])
    assert 1 <= row <= 1048576 and 1 <= column <= 16384
    return row, column


def verify(file, expected=None):
    evidence = {"file": str(file), "sha256": sha(file), "cells": 0, "formulas": 0, "relationships": 0}
    with zipfile.ZipFile(file) as package:
        assert package.testzip() is None
        names = package.namelist()
        assert len(names) == len(set(names)), "duplicate archive members"
        styles = {}
        for name in names:
            if name.endswith(".rels"):
                directory = posixpath.dirname(name)
                owner = "" if name == "_rels/.rels" else posixpath.join(posixpath.dirname(directory), posixpath.basename(name)[:-5])
                for relationship in ET.fromstring(package.read(name)):
                    if relationship.tag != "{" + REL + "}Relationship":
                        continue
                    evidence["relationships"] += 1
                    if relationship.attrib.get("TargetMode") == "External":
                        continue
                    target = unquote(relationship.attrib["Target"].split("#")[0])
                    resolved = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(posixpath.dirname(owner), target))
                    assert resolved in names, (name, "missing relationship target", resolved)
            if name.endswith("styles.xml"):
                root = ET.fromstring(package.read(name))
                styles = {i: int(node.attrib.get("numFmtId", "0")) for i, node in enumerate(root.findall("s:cellXfs/s:xf", NS))}
        for name in names:
            if "/worksheets/" not in name or not name.endswith(".xml") or "/_rels/" in name:
                continue
            seen = set()
            with package.open(name) as stream:
                for event, cell in ET.iterparse(stream, events=("end",)):
                    if cell.tag != "{" + MAIN + "}c":
                        continue
                    address = cell.attrib["r"]
                    assert address not in seen, ("duplicate cell", name, address)
                    seen.add(address)
                    row, column = coordinate(address)
                    formula = cell.find("s:f", NS)
                    value = cell.find("s:v", NS)
                    if formula is not None:
                        evidence["formulas"] += 1
                        if expected and expected.get("recalculationRequired"):
                            assert value is None, ("stale formula cache", name, address)
                    if expected and expected.get("dataset") == "sequence" and name == "xl/worksheets/sheet1.xml":
                        original_row, original_column = row, column
                        operation = expected["operation"]
                        if operation == "rows":
                            assert row != expected["at"], "inserted row must be blank"
                            if row > expected["at"]:
                                original_row -= 1
                        if operation == "columns":
                            assert column != expected["at"], "inserted column must be blank"
                            if column > expected["at"]:
                                original_column -= 1
                        if operation == "copy" and 1000 <= row < 1025:
                            original_row = row - 999
                        wanted = (original_row - 1) * expected["columns"] + original_column - 1
                        if operation == "write" and address == "A1":
                            wanted = -1
                        assert formula is None and value is not None and value.text is not None
                        assert int(value.text) == wanted, (name, address, value.text, wanted)
                    evidence["cells"] += 1
                    cell.clear()
        if expected and expected.get("dataset") == "sequence":
            assert evidence["cells"] == expected["rows"] * expected["columns"]
            assert package.read("customXml/retained.xml") == b'<retained xmlns="urn:edit-bench">Keep these exact bytes.</retained>'
    return evidence


def main(directory):
    root = Path(directory)
    report = json.loads((root / "edit-results.json").read_text())
    assert sha(root / "source.xlsx") == report["source"]["versionId"]
    expected = {key: report[key] for key in ("rows", "columns", "operation", "at", "dataset")}
    expected["recalculationRequired"] = True
    output = root / report["edit"]["version"]["filePath"]
    assert sha(output) == report["edit"]["version"]["versionId"]
    evidence = verify(output, expected)
    result = {"status": "passed", "oracle": "independent Python ZIP/XML and coordinate arithmetic", **evidence}
    (root / "edit-oracle.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main(sys.argv[1])
