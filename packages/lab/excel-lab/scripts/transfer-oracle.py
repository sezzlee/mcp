import csv
import hashlib
import json
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


def verify(directory):
    root = Path(directory)
    report = json.loads((root / "transfer-results.json").read_text())
    rows, columns = report["rows"], report["columns"]
    assert rows * columns == report["cells"]
    source = root / "sequence.csv"
    assert hashlib.sha256(source.read_bytes()).hexdigest() == report["sourceSha256"]
    with source.open(newline="") as stream:
        count = 0
        for row, record in enumerate(csv.reader(stream)):
            assert len(record) == columns
            for column, text in enumerate(record):
                assert text == str(row * columns + column)
                count += 1
        assert count == rows * columns
    ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    evidence = []
    for key in ("create", "edit"):
        receipt = report[key]
        output = root / receipt["version"]["filePath"]
        assert hashlib.sha256(output.read_bytes()).hexdigest() == receipt["version"]["versionId"]
        with zipfile.ZipFile(output) as package:
            assert package.testzip() is None
            assert not any("externalLink" in name for name in package.namelist())
            with package.open("xl/worksheets/sheet1.xml") as part:
                count = total = 0
                seen = bytearray(rows * columns)
                for _, cell in ET.iterparse(part, events=("end",)):
                    if cell.tag != "{" + ns["s"] + "}c":
                        continue
                    address = cell.attrib["r"]
                    letters = "".join(c for c in address if c.isalpha())
                    row = int(address[len(letters):])
                    column = 0
                    for letter in letters:
                        column = column * 26 + ord(letter) - ord("A") + 1
                    assert 1 <= row <= rows and 1 <= column <= columns
                    coordinate = (row - 1) * columns + column - 1
                    assert not seen[coordinate], (key, "duplicate cell", address)
                    seen[coordinate] = 1
                    expected = (row - 1) * columns + column - 1
                    if key == "edit" and address == "A1":
                        expected = -1
                    assert cell.attrib.get("t", "n") == "n"
                    assert cell.find("s:f", ns) is None
                    value = cell.find("s:v", ns)
                    assert value is not None and value.text is not None
                    assert int(value.text) == expected, (key, address)
                    count += 1
                    total += int(value.text)
                    cell.clear()
                expected_sum = report["cells"] * (report["cells"] - 1) // 2 - (1 if key == "edit" else 0)
                assert count == rows * columns
                assert total == expected_sum
                evidence.append({"output": key, "cells": count, "sum": total})
    result = {"status": "passed", "oracle": "Python standard-library CSV/ZIP/XML", "evidence": evidence}
    (root / "transfer-oracle.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    verify(sys.argv[1])
