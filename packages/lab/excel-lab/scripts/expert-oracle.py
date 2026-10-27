import argparse
import hashlib
import json
import math
import re
import sys
import zipfile
from collections import OrderedDict
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
OFFICE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart"
DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
NS = {"m": MAIN, "c": CHART, "d": DRAWING}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def xstring(text):
    return re.sub(r"_x([0-9a-fA-F]{4})_", lambda m: chr(int(m[1], 16)), text or "")


def coordinate(text):
    match = re.fullmatch(r"\$?([A-Za-z]+)\$?([1-9][0-9]*)", text)
    require(match is not None, "Invalid cell reference")
    column = 0
    for char in match[1].upper():
        column = column * 26 + ord(char) - 64
    return int(match[2]), column


def rectangle(text):
    parts = text.split(":")
    top, left = coordinate(parts[0])
    bottom, right = coordinate(parts[-1])
    require(bottom >= top and right >= left, "Unordered rectangle")
    return top, left, bottom, right


class Package:
    def __init__(self, path):
        self.zip = zipfile.ZipFile(path)
        self.names = set(self.zip.namelist())
        self.book_part = next(r["target"] for r in self.relationships(None) if r["type"] == OFFICE + "/officeDocument")
        self.book = self.xml(self.book_part)
        relations = {r["id"]: r for r in self.relationships(self.book_part)}
        self.sheets = OrderedDict()
        for sheet in self.book.findall("m:sheets/m:sheet", NS):
            self.sheets[xstring(sheet.attrib["name"])] = relations[sheet.attrib["{" + OFFICE + "}id"]]["target"]
        strings = next((r["target"] for r in relations.values() if r["type"] == OFFICE + "/sharedStrings"), None)
        self.strings = [] if strings is None else [xstring("".join(n.itertext())) for n in self.xml(strings).findall("m:si", NS)]

    def xml(self, part):
        return ET.fromstring(self.zip.read(part))

    def relationships(self, owner):
        name = "_rels/.rels" if owner is None else str(PurePosixPath(owner).parent / "_rels" / (PurePosixPath(owner).name + ".rels"))
        if name not in self.names:
            return []
        result = []
        for node in self.xml(name):
            target = node.attrib["Target"]
            external = node.attrib.get("TargetMode") == "External"
            if not external:
                pieces = []
                for piece in (str(PurePosixPath(owner).parent) + "/" + target if owner and not target.startswith("/") else target).split("/"):
                    if piece in ("", "."):
                        continue
                    if piece == "..":
                        require(bool(pieces), "Relationship escapes package")
                        pieces.pop()
                    else:
                        pieces.append(piece)
                target = "/".join(pieces)
                require(target in self.names, "Relationship target absent: " + target)
            result.append({"id": node.attrib["Id"], "type": node.attrib["Type"], "target": target, "external": external})
        return result

    def cells(self, sheet):
        result = {}
        for cell in self.xml(self.sheets[sheet]).findall("m:sheetData/m:row/m:c", NS):
            reference = cell.attrib["r"]
            value = cell.findtext("m:v", default=None, namespaces=NS)
            kind = cell.attrib.get("t", "n")
            if kind == "inlineStr":
                value = xstring("".join(n.text or "" for n in cell.findall("m:is//m:t", NS)))
            elif kind == "s":
                value = self.strings[int(value)]
            elif kind == "b":
                value = value == "1"
            elif kind in ("str", "d", "e"):
                value = xstring(value)
            elif value is not None:
                value = float(value)
            result[coordinate(reference)] = {"value": value, "formula": cell.findtext("m:f", default=None, namespaces=NS), "type": kind}
        return result

    def matrix(self, sheet, reference):
        cells = self.cells(sheet)
        top, left, bottom, right = rectangle(reference)
        return [[cells.get((r, c), {}).get("value") for c in range(left, right + 1)] for r in range(top, bottom + 1)]


def equivalent(actual, expected):
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        return isinstance(actual, (int, float)) and not isinstance(actual, bool) and math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-9)
    return actual == expected and type(actual) == type(expected)


def check_pivots(package):
    results = []
    for sheet, sheet_part in package.sheets.items():
        for relation in package.relationships(sheet_part):
            if relation["type"] != OFFICE + "/pivotTable":
                continue
            pivot = package.xml(relation["target"])
            caches = [r for r in package.relationships(relation["target"]) if r["type"] == OFFICE + "/pivotCacheDefinition"]
            require(len(caches) == 1, "Pivot cache relationship must be unique")
            cache = package.xml(caches[0]["target"])
            require(cache.attrib.get("invalid", "0") not in ("1", "true"), "Pivot cache is stale")
            source = cache.find("m:cacheSource/m:worksheetSource", NS)
            require(source is not None, "Pivot worksheet source absent")
            matrix = package.matrix(xstring(source.attrib["sheet"]), source.attrib["ref"])
            headers, records = matrix[0], matrix[1:]
            require(int(cache.attrib["recordCount"]) == len(records), "Pivot record count differs from source")
            cache_fields = cache.findall("m:cacheFields/m:cacheField", NS)
            shared = []
            for field in cache_fields:
                values = []
                for item in field.find("m:sharedItems", NS):
                    kind = item.tag.rsplit("}", 1)[-1]
                    raw = item.attrib.get("v")
                    values.append(None if kind == "m" else float(raw) if kind == "n" else raw == "1" if kind == "b" else xstring(raw))
                shared.append(values)
            record_relation = next(r for r in package.relationships(caches[0]["target"]) if r["type"] == OFFICE + "/pivotCacheRecords")
            saved = [[shared[i][int(item.attrib["v"])] for i, item in enumerate(row)] for row in package.xml(record_relation["target"])]
            require(len(saved) == len(records) and all(len(a) == len(b) and all(equivalent(x, y) for x, y in zip(a, b)) for a, b in zip(saved, records)), "Pivot cache records differ from literal source")
            row_field = int(pivot.find("m:rowFields/m:field", NS).attrib["x"])
            groups = OrderedDict()
            for row in records:
                key = json.dumps([type(row[row_field]).__name__, row[row_field]])
                groups.setdefault(key, []).append(row)
            measures = pivot.findall("m:dataFields/m:dataField", NS)

            def aggregate(rows, measure):
                values = [row[int(measure.attrib["fld"])] for row in rows]
                numeric = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
                fn = measure.attrib.get("subtotal", "sum")
                return {"sum": lambda: sum(numeric), "count": lambda: sum(v is not None and v != "" for v in values), "min": lambda: min(numeric, default=0), "max": lambda: max(numeric, default=0)}[fn]()

            expected = [[headers[row_field]] + [xstring(m.attrib["name"]) for m in measures]]
            expected += [[rows[0][row_field]] + [aggregate(rows, m) for m in measures] for rows in groups.values()]
            expected += [["Grand Total"] + [aggregate(records, m) for m in measures]]
            location = pivot.find("m:location", NS).attrib["ref"]
            actual = package.matrix(sheet, location)
            require(actual and isinstance(actual[-1][0], str) and actual[-1][0].strip(), "Pivot grand-total caption is absent")
            expected[-1][0] = actual[-1][0]
            require(len(actual) == len(expected) and all(len(a) == len(e) and all(equivalent(x, y) for x, y in zip(a, e)) for a, e in zip(actual, expected)), "Materialized pivot results differ from independent aggregation")
            results.append({"name": pivot.attrib["name"], "sheet": sheet, "range": location, "rows": len(records), "result": actual})
    return results


def chart_series(package, chart):
    result = []
    for series in chart.findall(".//c:ser", NS):
        references = []
        values = []
        for role, reference_type, cache_type in [("cat", "strRef", "strCache"), ("val", "numRef", "numCache")]:
            ref = series.find("c:" + role + "/c:" + reference_type, NS)
            require(ref is not None, "Unsupported chart source kind")
            formula = ref.findtext("c:f", namespaces=NS)
            match = re.fullmatch(r"(?:'((?:[^']|'')+)'|([^'!]+))!([A-Za-z$0-9:]+)", formula or "")
            require(match is not None, "Chart source is not a static internal rectangle")
            sheet = match[1].replace("''", "'") if match[1] else match[2]
            source = [v for row in package.matrix(sheet, match[3]) for v in row]
            cache = ref.find("c:" + cache_type, NS)
            require(cache is not None, "Chart cache is unavailable or stale")
            require(int(cache.find("c:ptCount", NS).attrib["val"]) == len(source), "Chart cache point count differs from source")
            points = {int(p.attrib["idx"]): p.findtext("c:v", namespaces=NS) for p in cache.findall("c:pt", NS)}
            require(len(points) == len(cache.findall("c:pt", NS)), "Chart cache point indexes are duplicated")
            for index, expected in enumerate(source):
                if expected is None:
                    require(index not in points, "A blank chart source acquired a cached value")
                elif role == "val":
                    require(index in points and equivalent(float(points[index]), expected), "Chart numeric cache differs from source")
                else:
                    text = str(expected).lower() if isinstance(expected, bool) else str(int(expected)) if isinstance(expected, float) and expected.is_integer() else str(expected)
                    require(points.get(index) == text, "Chart category cache differs from source")
            require(all(0 <= index < len(source) for index in points), "Chart cache contains an out-of-range point")
            references.append(sheet + "!" + match[3].replace("$", ""))
            values.append(source)
        caption = series.findtext("c:tx/c:v", namespaces=NS)
        if caption is None:
            caption = series.findtext("c:tx/c:strRef/c:strCache/c:pt/c:v", namespaces=NS)
        result.append({"name": xstring(caption), "categories": references[0], "values": references[1], "categoryValues": values[0], "numericValues": values[1]})
    return result


def inspect(path):
    package = Package(path)
    for part in package.names:
        if part.endswith(".rels"):
            owner = None if part == "_rels/.rels" else str(PurePosixPath(part).parent.parent / PurePosixPath(part).name[:-5])
            package.relationships(owner)
    charts, images, links, notes, validations, conditions, protected = [], [], [], [], [], [], []
    styles_relation = next((r for r in package.relationships(package.book_part) if r["type"] == OFFICE + "/styles"), None)
    styles = None if styles_relation is None else package.xml(styles_relation["target"])
    cell_styles = [] if styles is None else styles.findall("m:cellXfs/m:xf", NS)
    differentials = [] if styles is None else styles.findall("m:dxfs/m:dxf", NS)
    unlocked = []
    for sheet, part in package.sheets.items():
        root = package.xml(part)
        relations = {r["id"]: r for r in package.relationships(part)}
        if root.find("m:sheetProtection", NS) is not None:
            protected.append(sheet)
        for cell in root.findall("m:sheetData/m:row/m:c", NS):
            index = int(cell.attrib.get("s", "0"))
            protection = cell_styles[index].find("m:protection", NS) if index < len(cell_styles) else None
            if protection is not None and protection.attrib.get("locked") in ("0", "false"):
                unlocked.append({"sheet": sheet, "cell": cell.attrib["r"]})
        for node in root.findall("m:hyperlinks/m:hyperlink", NS):
            identity = node.attrib.get("{" + OFFICE + "}id")
            links.append({"sheet": sheet, "cell": node.attrib["ref"], "target": node.attrib.get("location") if identity is None else relations[identity]["target"]})
        for node in root.findall("m:dataValidations/m:dataValidation", NS):
            validations.append({"sheet": sheet, **node.attrib, "formula1": node.findtext("m:formula1", namespaces=NS)})
        for group in root.findall("m:conditionalFormatting", NS):
            for node in group.findall("m:cfRule", NS):
                differential = differentials[int(node.attrib["dxfId"])] if "dxfId" in node.attrib else None
                fill = None if differential is None else differential.find("m:fill/m:patternFill/m:fgColor", NS)
                if fill is None and differential is not None:
                    fill = differential.find("m:fill/m:patternFill/m:bgColor", NS)
                conditions.append({"sheet": sheet, "range": group.attrib["sqref"], **node.attrib, "formulas": [n.text for n in node.findall("m:formula", NS)], "fill": None if fill is None else fill.attrib.get("rgb")})
        for relation in relations.values():
            if relation["type"] == OFFICE + "/comments":
                comments = package.xml(relation["target"])
                authors = [xstring(n.text) for n in comments.findall("m:authors/m:author", NS)]
                for note in comments.findall("m:commentList/m:comment", NS):
                    notes.append({"sheet": sheet, "cell": note.attrib["ref"], "author": authors[int(note.attrib["authorId"])], "text": xstring("".join(n.text or "" for n in note.findall("m:text//m:t", NS)))})
            if relation["type"] != OFFICE + "/drawing":
                continue
            drawing = package.xml(relation["target"])
            drawing_relations = {r["id"]: r for r in package.relationships(relation["target"])}
            for anchor in drawing:
                identity = anchor.find(".//d:cNvPr", NS)
                name = None if identity is None else xstring(identity.attrib.get("name"))
                for chart in anchor.findall(".//c:chart", NS):
                    target = drawing_relations[chart.attrib["{" + OFFICE + "}id"]]["target"]
                    chart_root = package.xml(target)
                    title = "".join(n.text or "" for n in chart_root.findall(".//c:title//{http://schemas.openxmlformats.org/drawingml/2006/main}t", NS))
                    kind = "column" if chart_root.find(".//c:barChart/c:barDir", NS) is not None and chart_root.find(".//c:barChart/c:barDir", NS).attrib.get("val") == "col" else "bar" if chart_root.find(".//c:barChart", NS) is not None else "line" if chart_root.find(".//c:lineChart", NS) is not None else "pie" if chart_root.find(".//c:pieChart", NS) is not None else "unsupported"
                    charts.append({"sheet": sheet, "name": name, "title": title, "chartType": kind, "part": target, "series": chart_series(package, chart_root)})
                for blip in anchor.findall(".//{http://schemas.openxmlformats.org/drawingml/2006/main}blip", NS):
                    target = drawing_relations[blip.attrib["{" + OFFICE + "}embed"]]["target"]
                    image = package.zip.read(target)
                    images.append({"sheet": sheet, "name": name, "sha256": hashlib.sha256(image).hexdigest(), "bytes": len(image)})
    return {
        "sheets": {name: {f"{row},{column}": cell for (row, column), cell in package.cells(name).items()} for name in package.sheets},
        "names": [dict(n.attrib, ref=n.text) for n in package.book.findall("m:definedNames/m:definedName", NS)],
        "pivots": check_pivots(package),
        "charts": charts,
        "images": images,
        "links": links,
        "notes": notes,
        "validations": validations,
        "conditions": conditions,
        "protectedSheets": protected,
        "workbookProtected": package.book.find("m:workbookProtection", NS) is not None,
        "unlocked": unlocked,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("workbook")
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args()
    try:
        result = inspect(args.workbook)
        if args.summary:
            result.pop("sheets", None)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"passed": False, "error": str(error)}))
        sys.exit(1)
