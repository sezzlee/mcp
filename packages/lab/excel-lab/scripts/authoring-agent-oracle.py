import hashlib
import json
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile


S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"s": S}


def relationships(parts, owner):
    directory, name = posixpath.split(owner)
    rel = posixpath.join(directory, "_rels", name + ".rels")
    if rel not in parts:
        return {}
    return {
        node.attrib["Id"]: (node.attrib["Type"], posixpath.normpath(posixpath.join(directory, node.attrib["Target"])))
        for node in ET.fromstring(parts[rel])
        if node.attrib.get("TargetMode") != "External"
    }


def read_book(file):
    with zipfile.ZipFile(file) as package:
        assert package.testzip() is None, "ZIP CRC failed"
        assert len(package.namelist()) == len(set(package.namelist())), "duplicate parts"
        assert sum(item.file_size for item in package.infolist()) <= 512 * 1024 * 1024
        parts = {name: package.read(name) for name in package.namelist()}
    root_rels = ET.fromstring(parts["_rels/.rels"])
    workbook_part = next(n.attrib["Target"].lstrip("/") for n in root_rels if n.attrib["Type"].endswith("/officeDocument"))
    workbook = ET.fromstring(parts[workbook_part])
    rels = relationships(parts, workbook_part)
    strings = []
    shared = next((target for kind, target in rels.values() if kind.endswith("/sharedStrings")), None)
    if shared:
        strings = ["".join(n.text or "" for n in item.findall(".//s:t", NS)) for item in ET.fromstring(parts[shared])]
    styles_part = next((target for kind, target in rels.values() if kind.endswith("/styles")), None)
    styles = ET.fromstring(parts[styles_part]) if styles_part else None
    sheets = {}
    for sheet in workbook.findall("s:sheets/s:sheet", NS):
        target = rels[sheet.attrib["{" + R + "}id"]][1]
        xml = ET.fromstring(parts[target])
        cells = {}
        for cell in xml.findall("s:sheetData/s:row/s:c", NS):
            assert cell.attrib["r"] not in cells, "duplicate cell coordinate"
            kind = cell.attrib.get("t", "n")
            value = cell.findtext("s:v", namespaces=NS)
            if kind == "inlineStr":
                value = "".join(n.text or "" for n in cell.findall("s:is//s:t", NS))
                kind = "text"
            elif kind == "s":
                value = strings[int(value)]
                kind = "text"
            cells[cell.attrib["r"]] = {"kind": kind, "value": value, "formula": cell.findtext("s:f", namespaces=NS), "style": int(cell.attrib.get("s", "0"))}
        if styles is not None:
            count = len(list(styles.find("s:cellXfs", NS)))
            assert all(0 <= cell["style"] < count for cell in cells.values()), "invalid cell format index"
        tables = [ET.fromstring(parts[path]) for kind, path in relationships(parts, target).values() if kind.endswith("/table")]
        sheets[sheet.attrib["name"]] = {"xml": xml, "cells": cells, "tables": tables, "part": target}
    for name, body in parts.items():
        if name.endswith(".rels"):
            owner_directory = posixpath.dirname(posixpath.dirname(name))
            for node in ET.fromstring(body):
                if node.attrib.get("TargetMode") == "External":
                    continue
                target = node.attrib["Target"]
                resolved = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(owner_directory, target))
                assert resolved in parts, ("dangling relationship", name, resolved)
    return {"sheets": sheets, "styles": styles, "workbook": workbook, "parts": parts}


def scalar(sheet, coordinate, value):
    cell = sheet["cells"].get(coordinate)
    assert cell is not None and cell["formula"] is None, (coordinate, "missing scalar", cell)
    if isinstance(value, (float, int)):
        assert cell["kind"] == "n" and float(cell["value"]) == value, (coordinate, cell, value)
    else:
        expected = value + "T00:00:00.000" if cell["kind"] == "d" and len(value) == 10 else value
        assert cell["value"] == expected, (coordinate, cell, value)


def formula(sheet, coordinate, expected):
    cell = sheet["cells"].get(coordinate)
    assert cell is not None and cell["formula"] is not None, (coordinate, "missing formula")
    normalize = lambda text: text.replace("'Calc'!", "Calc!").replace("'Sales'!", "Sales!").replace("[@[Qty]]", "[@Qty]").replace("[@[Price]]", "[@Price]").replace(" ", "")
    choices = expected if isinstance(expected, list) else [expected]
    assert normalize(cell["formula"]) in [normalize(value) for value in choices], (coordinate, cell["formula"], expected)
    assert cell["value"] is None, (coordinate, "fabricated formula cache", cell)


def style_of(book, sheet, coordinate):
    styles = book["styles"]
    assert styles is not None
    xf = list(styles.find("s:cellXfs", NS))[sheet["cells"][coordinate]["style"]]
    font = list(styles.find("s:fonts", NS))[int(xf.attrib.get("fontId", "0"))]
    fill = list(styles.find("s:fills", NS))[int(xf.attrib.get("fillId", "0"))]
    formats = {int(n.attrib["numFmtId"]): n.attrib["formatCode"] for n in styles.findall("s:numFmts/s:numFmt", NS)}
    return {"xf": xf, "font": font, "fill": fill, "numberFormat": formats.get(int(xf.attrib.get("numFmtId", "0")), "")}


def verify(source, output, scenario):
    before, book = read_book(source), read_book(output)
    for name, original in before["sheets"].items():
        actual = book["sheets"][name]["cells"]
        assert set(actual) == set(original["cells"]), ("original cell extent changed", name)
        for coordinate, cell in original["cells"].items():
            value = actual[coordinate]
            assert value["formula"] == cell["formula"] and value["style"] == cell["style"], ("original formula/style changed", name, coordinate)
            if cell["formula"] is None:
                assert (value["kind"], value["value"]) == (cell["kind"], cell["value"]), ("original scalar changed", name, coordinate)
    if scenario == "authoring_format":
        sheet = book["sheets"]["Expenses"]
        for cell, value in {"A1": "Date", "B1": "Item", "C1": "Amount", "D1": "Rate", "A2": "2026-01-02", "A3": "2026-01-03", "B2": "Office", "B3": "Travel", "C2": 20, "C3": 50, "D2": 0.18, "D3": 0.08}.items():
            scalar(sheet, cell, value)
        assert sheet["cells"]["A2"]["kind"] == "d"
        assert "%" in style_of(book, sheet, "D2")["numberFormat"]
        currency = style_of(book, sheet, "C2")["numberFormat"]
        assert ("TRY" in currency or "₺" in currency) and re.search(r"0\.00(?![0#])", currency), currency
        assert "yyyy" in style_of(book, sheet, "A2")["numberFormat"]
        for coordinate in ["A1", "B1", "C1", "D1"]:
            style = style_of(book, sheet, coordinate)
            bold = style["font"].find("s:b", NS)
            assert bold is not None and bold.attrib.get('val','1') not in ('0','false','off')
            assert style["font"].find("s:color", NS).attrib["rgb"][-6:] == "FFFFFF"
            rgb = style["fill"].find("s:patternFill/s:fgColor", NS).attrib["rgb"][-6:]
            assert style["fill"].find("s:patternFill",NS).attrib.get('patternType') == 'solid'
            red, green, blue = [int(rgb[i:i+2],16) for i in (0,2,4)]
            assert red < 80 and green < 120 and red < blue < 160, ("expected dark blue", rgb)
            assert style["xf"].find("s:alignment", NS).attrib["wrapText"] == "1"
        columns = sheet["xml"].findall("s:cols/s:col", NS)
        assert all(any(int(n.attrib["min"]) <= col <= int(n.attrib["max"]) and float(n.attrib["width"]) == 22 for n in columns) for col in range(1, 5))
        pane = sheet["xml"].find("s:sheetViews/s:sheetView/s:pane", NS)
        assert pane.attrib["state"] == "frozen" and pane.attrib["ySplit"] == "1"
        setup = sheet["xml"].find("s:pageSetup", NS)
        assert setup.attrib["orientation"] == "landscape" and setup.attrib["fitToWidth"] == "1"
        assert any(n.attrib["name"] == "_xlnm.Print_Area" and "$A$1:$D$3" in (n.text or "") for n in book["workbook"].findall("s:definedNames/s:definedName", NS))
    elif scenario == "authoring_formula":
        sheet = book["sheets"]["Calc"]
        for coordinate, value in {"A1": "Qty", "B1": "Price", "C1": "Gross"}.items():
            scalar(sheet, coordinate, value)
        for coordinate, value in {"A2": 2, "B2": 10, "A3": 3, "B3": 5, "F1": 0.18, "E1": "=1+1"}.items():
            scalar(sheet, coordinate, value)
        formula(sheet, "C2", "A2*B2*(1+$F$1)")
        formula(sheet, "C3", "A3*B3*(1+$F$1)")
        formula(book["sheets"]["Summary"], "A1", "SUM(Calc!C2:C3)")
    elif scenario in ["authoring_table", "authoring_continuation"]:
        sheet = book["sheets"]["Sales"]
        assert len(sheet["tables"]) == 1
        table = sheet["tables"][0]
        assert table.attrib["name"] == "SalesData" and table.attrib["ref"] == "A1:D5" and table.attrib["totalsRowCount"] == "1"
        assert [n.attrib["name"] for n in table.findall("s:tableColumns/s:tableColumn", NS)] == ["Item", "Qty", "Price", "Amount"]
        calculated = table.findall("s:tableColumns/s:tableColumn", NS)[3].find("s:calculatedColumnFormula", NS)
        assert calculated is not None, "missing calculated column metadata"
        formula({"cells":{"D2":{"formula":calculated.text,"value":None}}}, "D2", ["SalesData[[#This Row],[Qty]]*SalesData[[#This Row],[Price]]", "B2*C2", "Sales!B2*Sales!C2", "$B2*$C2"])
        for row, values in [(2, ["A", 2, 10]), (3, ["B", 3, 5]), (4, ["C", 6 if scenario == "authoring_continuation" else 4, 2])]:
            for col, value in zip("ABC", values):
                scalar(sheet, col + str(row), value)
            formula(sheet, "D" + str(row), ["SalesData[[#This Row],[Qty]]*SalesData[[#This Row],[Price]]", f"B{row}*C{row}", f"Sales!B{row}*Sales!C{row}", f"$B{row}*$C{row}"])
        formula(sheet, "F1", "SUM(SalesData[Amount])")
        formula(sheet, "D5", "SUBTOTAL(109,SalesData[Amount])")
        scalar(sheet, "A5", "Total")
        assert table.find("s:autoFilter", NS).attrib["ref"] == "A1:D4"
        if scenario == "authoring_continuation":
            assert sheet["cells"].get("G1", {}).get("value") is None
    elif scenario == "authoring_lifecycle":
        sheet = book["sheets"]["Sales"]
        assert not sheet["tables"]
        for cell, value in {"A1":"Item", "B1":"Quantity", "C1":"Price", "D1":"Amount", "A2":"A", "B2":2, "C2":10, "A3":"B", "B3":3, "C3":5}.items():
            scalar(sheet, cell, value)
        for row in [2,3]:
            formula(sheet, "D"+str(row), [f"'Sales'!$B{row}*'Sales'!$C{row}", f"B{row}*C{row}", f"Sales!B{row}*Sales!C{row}", f"$B{row}*$C{row}"])
        formula(sheet, "F1", ["SUM('Sales'!$D$2)", "SUM(Sales!D2)", "SUM($D$2)", "SUM(D2)", "SUM(D2:D2)"])
    elif scenario == "authoring_merge":
        sheet = book["sheets"]["Title"]
        scalar(sheet, "A1", "Ad")
        assert sheet["cells"].get("B1", {}).get("value") is None
        assert [node.attrib["ref"] for node in sheet["xml"].findall("s:mergeCells/s:mergeCell", NS)] == ["A1:B1"]
        rgb = style_of(book, sheet, "A1")["fill"].find("s:patternFill/s:fgColor", NS).attrib["rgb"][-6:]
        red, green, blue = [int(rgb[i:i+2],16) for i in (0,2,4)]
        assert red >= 200 and green >= 200 and blue < 80, ("expected yellow", rgb)
    else:
        raise ValueError("Unknown authoring scenario")
    for sheet in book["sheets"].values():
        for coordinate, cell in sheet["cells"].items():
            if cell["formula"] is not None:
                assert cell["value"] is None, ("stale formula cache", coordinate)
    calc = book["workbook"].find("s:calcPr", NS)
    assert calc is not None and calc.attrib.get("fullCalcOnLoad") == "1"
    with open(output, "rb") as stream:
        output_hash = hashlib.sha256(stream.read()).hexdigest()
    return {"status": "passed", "scenario": scenario, "outputSha256": output_hash}


if __name__ == "__main__":
    print(json.dumps(verify(*sys.argv[1:])))
