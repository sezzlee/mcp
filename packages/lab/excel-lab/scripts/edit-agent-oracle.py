import hashlib
import json
import sys
import xml.etree.ElementTree as ET
import zipfile


NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def cells(file):
    with zipfile.ZipFile(file) as package:
        assert package.testzip() is None
        result = {}
        root = ET.fromstring(package.read("xl/worksheets/sheet1.xml"))
        strings = []
        if "xl/sharedStrings.xml" in package.namelist():
            strings = ["".join(node.itertext()) for node in ET.fromstring(package.read("xl/sharedStrings.xml"))]
        for cell in root.findall("s:sheetData/s:row/s:c", NS):
            formula = cell.findtext("s:f", namespaces=NS)
            value = cell.findtext("s:v", namespaces=NS)
            kind = cell.attrib.get("t", "n")
            if kind == "s":
                value = strings[int(value)]
                kind = "text"
            if kind == "inlineStr":
                value = "".join(node.text or "" for node in cell.findall("s:is//s:t", NS))
                kind = "text"
            result[cell.attrib["r"]] = {"kind": kind, "value": value, "formula": formula, "style": cell.attrib.get("s", "0")}
        return result


def main(source, output, scenario):
    original = cells(source)
    actual = cells(output)
    if scenario.startswith("transfer_"):
        def value_cell(cell):
            return {"kind": cell["kind"], "value": cell["value"], "formula": None, "style": "0"}
        if scenario == "transfer_range":
            expected = {key: value_cell(value) for key, value in original.items()}
        elif scenario == "transfer_records":
            expected = {"A1": value_cell(original["C1"]), "B1": value_cell(original["A1"]), "A2": value_cell(original["C2"]), "B2": value_cell(original["A2"])}
        elif scenario == "transfer_aggregate":
            assert set(actual) == {"A1", "A2"}
            assert actual["A1"]["kind"] == "text" and actual["A1"]["value"]
            assert actual["A2"] == {"kind": "n", "value": "4", "formula": None, "style": "0"}
        else:
            raise ValueError("Unknown transfer scenario")
        if scenario != "transfer_aggregate":
            assert actual == expected, {"scenario": scenario, "expected": expected, "actual": actual}
        with zipfile.ZipFile(output) as package:
            workbook = ET.fromstring(package.read("xl/workbook.xml"))
            sheets = workbook.findall("s:sheets/s:sheet", NS)
            assert len(sheets) == 1 and sheets[0].attrib["name"] == ("Summary" if scenario == "transfer_aggregate" else "Export")
        print(json.dumps({"status": "passed", "scenario": scenario, "cells": len(actual)}))
        return
    expected = {key: {**value, "value": None if value["formula"] is not None else value["value"]} for key, value in original.items()}
    if scenario == "write":
        expected["B10"] = {"kind": "n", "value": "99", "formula": None, "style": "0"}
    elif scenario == "copy":
        expected["C10"] = {**expected["A1"], "kind": "n"}
        expected["C11"] = expected["A2"]
    elif scenario == "clear":
        expected["A1"] = {"kind": "n", "value": None, "formula": None, "style": expected["A1"]["style"]}
    elif scenario == "rows":
        expected = {key[0] + str(int(key[1:]) + (1 if int(key[1:]) >= 2 else 0)): value for key, value in expected.items()}
    elif scenario == "restore":
        with zipfile.ZipFile(source) as before, zipfile.ZipFile(output) as after:
            assert set(before.namelist()) == set(after.namelist())
            for name in before.namelist():
                assert before.read(name) == after.read(name), ("restore changed part", name)
        expected = original
    else:
        raise ValueError("Unknown scenario")
    assert actual == expected, {"scenario": scenario, "expected": expected, "actual": actual}
    with zipfile.ZipFile(source) as before, zipfile.ZipFile(output) as after:
        for name in ["xl/styles.xml", "xl/sharedStrings.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"]:
            if name in before.namelist():
                assert before.read(name) == after.read(name), ("unrelated part changed", name)
    print(json.dumps({"status": "passed", "scenario": scenario, "cells": len(actual), "outputSha256": hashlib.sha256(open(output, "rb").read()).hexdigest()}))


if __name__ == "__main__":
    main(*sys.argv[1:])
