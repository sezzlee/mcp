"""Read agent-lab corpus files with Python's standard library alone, without MCP."""

from pathlib import Path
import argparse
import csv
import hashlib
import datetime
import io
import json
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile


MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS = {
    "x": MAIN,
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "p": "http://schemas.openxmlformats.org/package/2006/relationships",
}
REF = re.compile(r"^([A-Z]+)(\d+)$")


def column_index(letters):
    index = 0
    for letter in letters:
        index = index * 26 + ord(letter) - 64
    return index


def column_letters(index):
    letters = ""
    while index > 0:
        index, rest = divmod(index - 1, 26)
        letters = chr(65 + rest) + letters
    return letters


def text_of(node):
    return "".join(part.text or "" for part in node.iter(f"{{{MAIN}}}t"))


class Cell:
    def __init__(self, kind, value, formula=None):
        self.kind = kind
        self.value = value
        self.formula = formula

    def as_json(self):
        out = {"kind": self.kind, "value": self.value}
        if self.formula is not None:
            out["formula"] = self.formula
        return out


class Sheet:
    def __init__(self, name, state, kind, cells, merges, part):
        self.name = name
        self.state = state
        self.kind = kind
        self.cells = cells
        self.merges = merges
        self.part = part

    def rows(self):
        if not self.cells:
            return []
        last_row = max(row for row, _ in self.cells)
        last_column = max(column for _, column in self.cells)
        return [
            [self.cells.get((row, column)) for column in range(1, last_column + 1)]
            for row in range(1, last_row + 1)
        ]

    def column(self, letters, first_row, last_row=None):
        index = column_index(letters)
        end = last_row or max(row for row, _ in self.cells)
        return [self.cells.get((row, index)) for row in range(first_row, end + 1)]


class Workbook:
    def __init__(self, path):
        self.archive = zipfile.ZipFile(path)
        workbook = self.xml("xl/workbook.xml")
        properties = workbook.find("x:workbookPr", NS)
        self.date1904 = properties is not None and properties.attrib.get("date1904") in ("1", "true")
        self.defined_names = {
            node.attrib["name"]: node.text for node in workbook.findall("x:definedNames/x:definedName", NS)
        }
        links = {
            item.attrib["Id"]: item.attrib
            for item in self.xml("xl/_rels/workbook.xml.rels")
        }
        self.shared = self.shared_strings(links)
        self.sheets = []
        for node in workbook.findall("x:sheets/x:sheet", NS):
            link = links[node.attrib[f"{{{NS['r']}}}id"]]
            part = self.resolve("xl", link["Target"])
            kind = "chartsheet" if link["Type"].endswith("/chartsheet") else "worksheet"
            cells, merges = self.read_cells(part) if kind == "worksheet" else ({}, [])
            self.sheets.append(
                Sheet(node.attrib["name"], node.attrib.get("state", "visible"), kind, cells, merges, part)
            )

    def xml(self, path):
        return ET.fromstring(self.archive.read(path))

    @staticmethod
    def resolve(base, target):
        if target.startswith("/"):
            return target.lstrip("/")
        return posixpath.normpath(posixpath.join(base, target))

    def shared_strings(self, links):
        for link in links.values():
            if link["Type"].endswith("/sharedStrings"):
                table = self.xml(self.resolve("xl", link["Target"]))
                return [text_of(item) for item in table.findall("x:si", NS)]
        return []

    def read_cells(self, part):
        root = self.xml(part)
        cells = {}
        for node in root.iterfind("x:sheetData/x:row/x:c", NS):
            match = REF.match(node.attrib.get("r", ""))
            if match is None:
                raise ValueError(f"{part}: cell without a reference")
            kind = node.attrib.get("t", "n")
            formula_node = node.find("x:f", NS)
            formula = None if formula_node is None else (formula_node.text or "")
            raw = node.find("x:v", NS)
            raw_text = None if raw is None else raw.text
            if kind == "s":
                value = self.shared[int(raw_text)]
            elif kind == "inlineStr":
                inline = node.find("x:is", NS)
                value = "" if inline is None else text_of(inline)
                kind = "s"
            elif kind == "b":
                value = None if raw_text is None else raw_text == "1"
            elif kind in ("e", "str"):
                value = raw_text
            else:
                value = None if raw_text is None else float(raw_text)
            if value is None and formula is None:
                continue
            cells[(int(match.group(2)), column_index(match.group(1)))] = Cell(kind, value, formula)
        merges = [node.attrib["ref"] for node in root.iterfind("x:mergeCells/x:mergeCell", NS)]
        return cells, merges

    def sheet(self, name):
        for sheet in self.sheets:
            if sheet.name == name:
                return sheet
        raise KeyError(name)

    def date(self, serial):
        epoch = datetime.date(1904, 1, 1) if self.date1904 else datetime.date(1899, 12, 30)
        return epoch + datetime.timedelta(days=int(serial))


def read_csv(path, encoding="utf-8-sig", delimiter=","):
    text = Path(path).read_bytes().decode(encoding)
    return list(csv.reader(io.StringIO(text, newline=""), delimiter=delimiter))


ORACLES = {}


def oracle(task_id):
    def register(function):
        ORACLES[task_id] = function
        return function

    return register


def number(value):
    return {"kind": "number", "value": value}


def record(**fields):
    return {"kind": "record", "fields": fields}


def cells_text(book):
    return [
        str(cell.value)
        for sheet in book.sheets
        for cell in sheet.cells.values()
        if cell.value is not None
    ]


def trabzon_counts(path):
    rows = Workbook(path).sheets[0].rows()
    data = [row for row in rows if row and row[0] is not None and row[0].kind == "n"]
    totals = [row for row in rows if row and row[0] is not None and row[0].value == "TOPLAM"]
    assert len(totals) == 1, path
    counts = [(row[1].value, row[2].value, row[3].value) for row in data]
    assert sum(entry[1] for entry in counts) == totals[0][2].value, path
    assert sum(entry[2] for entry in counts) == totals[0][3].value, path
    return counts


def trabzon_roads(path):
    sheet = Workbook(path).sheets[0]
    header = [cell.value if cell else None for cell in sheet.rows()[2]]
    assert header == ["SIRA NO", "MAHALLE ADI", "CSBM ADI", "CSBM TÜRÜ"], header
    return [(row[1].value, row[2].value, row[3].value) for row in sheet.rows()[3:] if row and row[0] is not None]


@oracle("trabzon-yomra-buildings")
def _(files):
    return number(sum(entry[1] for entry in trabzon_counts(files["trabzon-yomra"])))


@oracle("trabzon-yomra-top-units")
def _(files):
    ranked = sorted(trabzon_counts(files["trabzon-yomra"]), key=lambda entry: -entry[2])
    assert ranked[2][2] != ranked[3][2]
    return {"kind": "list", "items": [entry[0] for entry in ranked[:3]]}


@oracle("trabzon-yomra-ocak")
def _(files):
    matches = [entry for entry in trabzon_counts(files["trabzon-yomra"]) if entry[0] == "OCAK"]
    assert len(matches) == 1
    return number(matches[0][2])


@oracle("trabzon-three-districts")
def _(files):
    totals = {
        name: sum(entry[1] for entry in trabzon_counts(files[key]))
        for name, key in (("YOMRA", "trabzon-yomra"), ("TONYA", "trabzon-tonya"), ("ÇAYKARA", "trabzon-caykara"))
    }
    best = max(totals, key=totals.get)
    assert sorted(totals.values())[-2] < totals[best]
    return record(district=best, buildings=totals[best])


@oracle("trabzon-hayrat-units")
def _(files):
    return number(sum(entry[2] for entry in trabzon_counts(files["trabzon-hayrat-buildings"])))


@oracle("trabzon-hayrat-avenues")
def _(files):
    return number(sum(1 for road in trabzon_roads(files["trabzon-hayrat-roads"]) if road[2] == "Cadde"))


@oracle("trabzon-hayrat-table")
def _(files):
    archive = zipfile.ZipFile(files["trabzon-hayrat-roads"])
    tables = [name for name in archive.namelist() if name.startswith("xl/tables/table")]
    assert len(tables) == 1
    table = ET.fromstring(archive.read(tables[0]))
    first, last = table.attrib["ref"].split(":")
    rows = int(REF.match(last).group(2)) - int(REF.match(first).group(2))
    return record(name=table.attrib["name"], rows=rows)


@oracle("trabzon-hayrat-neighbourhoods")
def _(files):
    return number(len({road[0] for road in trabzon_roads(files["trabzon-hayrat-roads"])}))


@oracle("trabzon-hayrat-coverage")
def _(files):
    roads = {road[0] for road in trabzon_roads(files["trabzon-hayrat-roads"])}
    buildings = {entry[0] for entry in trabzon_counts(files["trabzon-hayrat-buildings"])}
    return record(onlyInRoads=len(roads - buildings), onlyInBuildings=len(buildings - roads))


@oracle("trabzon-yomra-density")
def _(files):
    ranked = sorted(trabzon_counts(files["trabzon-yomra"]), key=lambda entry: -entry[2] / entry[1])
    return {"kind": "text", "value": ranked[0][0]}


@oracle("trabzon-yomra-permits")
def _(files):
    text = " ".join(cells_text(Workbook(files["trabzon-yomra"]))).casefold()
    assert "ruhsat" not in text and "2020" not in text
    return {"kind": "refusal", "reason": "notInFile"}


def ibb_rows(path):
    rows = read_csv(path, "cp1254", ";")
    header = rows[0]
    assert header[:3] == ["ilce_adi", "mahalle_adi", "mahalle_uavt"], header
    assert all(len(row) == len(header) for row in rows[1:])
    return [dict(zip(header, row)) for row in rows[1:]]


@oracle("ibb-kadikoy-pre1980")
def _(files):
    return number(sum(int(row["1980_oncesi"]) for row in ibb_rows(files["ibb-buildings"]) if row["ilce_adi"] == "KADIKÖY"))


@oracle("ibb-highrise-districts")
def _(files):
    totals = {}
    for row in ibb_rows(files["ibb-buildings"]):
        totals[row["ilce_adi"]] = totals.get(row["ilce_adi"], 0) + int(row["9-19 kat_arasi"])
    ranked = sorted(totals, key=lambda name: -totals[name])
    assert totals[ranked[2]] != totals[ranked[3]]
    return {"kind": "list", "items": ranked[:3]}


@oracle("ibb-median-new-buildings")
def _(files):
    import statistics

    return number(statistics.median(int(row["2000_sonrasi"]) for row in ibb_rows(files["ibb-buildings"])))


@oracle("ibb-no-highrise")
def _(files):
    return number(sum(1 for row in ibb_rows(files["ibb-buildings"]) if int(row["9-19 kat_arasi"]) == 0))


@oracle("ibb-uavt-lookup")
def _(files):
    matches = [row["mahalle_adi"] for row in ibb_rows(files["ibb-buildings"]) if row["mahalle_uavt"] == "40142"]
    assert len(matches) == 1
    return {"kind": "text", "value": matches[0]}


@oracle("ibb-esenyurt-highrise-share")
def _(files):
    rows = [row for row in ibb_rows(files["ibb-buildings"]) if row["ilce_adi"] == "ESENYURT"]
    low, mid, high = (sum(int(row[column]) for row in rows) for column in ("1-4 kat_arasi", "5-9 kat_arasi", "9-19 kat_arasi"))
    return number(round(100 * (mid + high) / (low + mid + high), 1))


@oracle("konya-most-streets")
def _(files):
    rows = read_csv(files["konya-roads"], "cp1254", ",")
    assert rows[0] == ["ILCE", "MAHALLE", "CADDE-SOKAK SAYISI"]
    ranked = sorted(rows[1:], key=lambda row: -int(row[2]))
    assert int(ranked[0][2]) > int(ranked[1][2])
    return record(district=ranked[0][0], neighbourhood=ranked[0][1])


def header_rows(sheet, first_header):
    rows = sheet.rows()
    at = next(index for index, row in enumerate(rows) if row and row[0] is not None and row[0].value == first_header)
    header = [cell.value for cell in rows[at]]
    records = [
        {header[index]: (cell.value if cell else None) for index, cell in enumerate(row) if index < len(header)}
        for row in rows[at + 1 :]
        if row and any(cell is not None for cell in row)
    ]
    return at + 1, records


def nhs_spend(path):
    _, records = header_rows(Workbook(path).sheets[0], "Department Family")
    assert all(isinstance(entry["AP Amount"], float) for entry in records), path
    return records


def money(value):
    return round(value, 2)


@oracle("uk-aug-total")
def _(files):
    return number(money(sum(entry["AP Amount"] for entry in nhs_spend(files["uk-spend-2026-08"]))))


@oracle("uk-aug-top-supplier")
def _(files):
    totals = {}
    for entry in nhs_spend(files["uk-spend-2026-08"]):
        totals[entry["Supplier"]] = totals.get(entry["Supplier"], 0) + entry["AP Amount"]
    ranked = sorted(totals, key=lambda name: -totals[name])
    return {"kind": "list", "items": ranked[:3]}


@oracle("uk-three-months")
def _(files):
    totals = {
        month: money(sum(entry["AP Amount"] for entry in nhs_spend(files[key])))
        for month, key in (("2025-07", "uk-spend-2025-07"), ("2026-08", "uk-spend-2026-08"), ("2026-09", "uk-spend-2026-09"))
    }
    best = max(totals, key=totals.get)
    return record(month=best, total=totals[best])


@oracle("uk-jul-siemens-search")
def _(files):
    return {"kind": "set", "items": sorted({entry["Supplier"] for entry in nhs_spend(files["uk-spend-2025-07"]) if "SIEMENS" in str(entry["Supplier"]).upper()})}


@oracle("uk-jul-invoice-number")
def _(files):
    matches = [
        entry["Purchase Invoice Number"]
        for entry in nhs_spend(files["uk-spend-2025-07"])
        if entry["Supplier"] == "SIEMENS FINANCIAL SERVICES LTD" and entry["AP Amount"] == 97097.5
    ]
    assert len(matches) == 1 and isinstance(matches[0], str)
    return {"kind": "text", "value": matches[0]}


@oracle("uk-aug-big-payments-raise")
def _(files):
    records = nhs_spend(files["uk-spend-2026-08"])
    total = sum(entry["AP Amount"] for entry in records)
    large = sum(entry["AP Amount"] for entry in records if entry["AP Amount"] > 100000)
    return number(money(total + 0.1 * large))


@oracle("uk-aug-add-column")
def _(files):
    assert Path(files["uk-spend-2026-08"]).suffix == ".xlsx"
    return {"kind": "refusal", "reason": "readOnly"}


def glos_invoices(path):
    _, records = header_rows(Workbook(path).sheets[0], "Department Family")
    assert all(isinstance(entry["Transaction Number"], str) for entry in records)
    return records


@oracle("uk-glos-format-rule")
def _(files):
    archive = zipfile.ZipFile(files["uk-glos-invoices"])
    sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
    kinds = {
        rule.attrib["type"]
        for block in sheet.findall("x:conditionalFormatting", NS)
        if any(reference.startswith("G") for reference in block.attrib["sqref"].split())
        for rule in block.findall("x:cfRule", NS)
    }
    assert len(kinds) == 1
    return {"kind": "text", "value": kinds.pop()}


@oracle("uk-glos-duplicate-transaction")
def _(files):
    counts = {}
    for entry in glos_invoices(files["uk-glos-invoices"]):
        counts[entry["Transaction Number"]] = counts.get(entry["Transaction Number"], 0) + 1
    repeated = [number for number, count in counts.items() if count > 1]
    assert len(repeated) == 1
    return {"kind": "text", "value": repeated[0]}


@oracle("uk-glos-transaction-supplier")
def _(files):
    matches = [entry["Supplier"] for entry in glos_invoices(files["uk-glos-invoices"]) if entry["Transaction Number"] == "0041159533"]
    assert len(matches) == 1
    return {"kind": "text", "value": matches[0]}


@oracle("uk-glos-busiest-day")
def _(files):
    totals = {}
    for entry in glos_invoices(files["uk-glos-invoices"]):
        day = datetime.datetime.strptime(entry["Date"], "%d %b %Y").date().isoformat()
        totals[day] = totals.get(day, 0) + entry["AP Amount"]
    ranked = sorted(totals, key=lambda day: -totals[day])
    assert totals[ranked[0]] > totals[ranked[1]]
    return {"kind": "text", "value": ranked[0]}


def fire_data(path):
    book = Workbook(path)
    rows = book.sheet("Data").rows()
    header = [cell.value for cell in rows[0]]
    assert header[:3] == ["FINANCIAL_YEAR", "INCIDENT_TYPE", "CAUSE_ITEM_SPREAD_DESCRIPTION"]
    return book, [{header[index]: cell.value for index, cell in enumerate(row)} for row in rows[1:]]


def fire_sum(records, year, kind, column):
    return sum(entry[column] for entry in records if entry["FINANCIAL_YEAR"] == year and entry["INCIDENT_TYPE"] == kind)


@oracle("fire-dropdown-years")
def _(files):
    book, _ = fire_data(files["uk-fire-0604"])
    sheet = book.sheet("FIRE0604")
    root = ET.fromstring(book.archive.read(sheet.part))
    rules = root.findall("x:dataValidations/x:dataValidation", NS)
    assert len(rules) == 1 and rules[0].attrib["type"] == "list"
    first, last = rules[0].find("x:formula1", NS).text.replace("$", "").split(":")
    column = column_index(REF.match(first).group(1))
    years = [sheet.cells[(row, column)].value for row in range(int(REF.match(first).group(2)), int(REF.match(last).group(2)) + 1)]
    ordered = sorted(years)
    return record(count=len(years), oldest=ordered[0], newest=ordered[-1])


@oracle("fire-2015-dwellings")
def _(files):
    _, records = fire_data(files["uk-fire-0604"])
    return number(fire_sum(records, "2015/16", "Dwellings", "TOTAL_PRIMARY_FIRES"))


@oracle("fire-hidden-sheet")
def _(files):
    hidden = [sheet.name for sheet in Workbook(files["uk-fire-0604"]).sheets if sheet.state != "visible"]
    assert len(hidden) == 1
    return {"kind": "text", "value": hidden[0]}


@oracle("fire-cross-sheet-check")
def _(files):
    book, records = fire_data(files["uk-fire-0604"])
    table = book.sheet("FIRE0604")
    assert table.cells[(3, 1)].value == "2022/23" and table.cells[(6, 1)].value == "Total"
    return record(table=table.cells[(6, 2)].value, data=fire_sum(records, "2022/23", "Dwellings", "TOTAL_PRIMARY_FIRES"))


@oracle("fire-year-type-pivot")
def _(files):
    _, records = fire_data(files["uk-fire-0604"])
    return record(**{
        f"{year} {kind}": fire_sum(records, year, kind, "TOTAL_PRIMARY_FIRES")
        for year in ("2010/11", "2022/23")
        for kind in ("Dwellings", "Other Buildings")
    })


@oracle("fire-deadliest-year")
def _(files):
    _, records = fire_data(files["uk-fire-0604"])
    years = sorted({entry["FINANCIAL_YEAR"] for entry in records})
    totals = {year: fire_sum(records, year, "Dwellings", "TOTAL_FATALITIES") for year in years}
    ranked = sorted(years, key=lambda year: -totals[year])
    assert totals[ranked[0]] > totals[ranked[1]]
    return {"kind": "text", "value": ranked[0]}


@oracle("fire-food-subtotal")
def _(files):
    book, records = fire_data(files["uk-fire-0604"])
    table = book.sheet("FIRE0604")
    assert table.cells[(7, 1)].value == "Food" and table.cells[(3, 1)].value == "2022/23"
    leaves = sum(entry["TOTAL_PRIMARY_FIRES"] for entry in records if entry["FINANCIAL_YEAR"] == "2022/23" and entry["INCIDENT_TYPE"] == "Dwellings" and entry["CAUSE_ITEM_SPREAD_DESCRIPTION"].startswith("Food - "))
    assert leaves == table.cells[(7, 2)].value
    return number(leaves)


def sivas(path):
    book = Workbook(path)
    rows = book.sheet("Sayfa1").rows()
    header = [cell.value if cell else None for cell in rows[0]]
    neighbourhoods = [row for row in rows[1:] if row[0] is not None and row[0].kind == "n"]
    totals = [row for row in rows[1:] if row[1] is not None and row[1].value == "TOPLAM"]
    assert len(totals) == 1
    years = {int(text.split()[0]): index for index, text in enumerate(header) if text and text[:4].isdigit()}
    return book, years, neighbourhoods, totals[0]


@oracle("sivas-chart-peak")
def _(files):
    book, _, _, _ = sivas(files["sivas-population"])
    sheet = book.sheet("Sayfa2")
    links = ET.fromstring(book.archive.read(sheet.part.replace("worksheets/", "worksheets/_rels/") + ".rels"))
    drawing = Workbook.resolve("xl/worksheets", next(item.attrib["Target"] for item in links if item.attrib["Type"].endswith("/drawing")))
    drawing_links = ET.fromstring(book.archive.read(drawing.replace("drawings/", "drawings/_rels/") + ".rels"))
    charts = [Workbook.resolve("xl/drawings", item.attrib["Target"]) for item in drawing_links if item.attrib["Type"].endswith("/chart")]
    assert len(charts) == 1
    chart = book.archive.read(charts[0]).decode("utf-8")
    categories, values = re.findall(r"<c:f>Sayfa2!\$(\w)\$(\d+):\$\w\$(\d+)</c:f>", chart)
    years = [sheet.cells[(row, column_index(categories[0]))].value for row in range(int(categories[1]), int(categories[2]) + 1)]
    populations = [sheet.cells[(row, column_index(values[0]))].value for row in range(int(values[1]), int(values[2]) + 1)]
    return record(years=len(years), peakYear=int(years[populations.index(max(populations))]))


@oracle("sivas-largest-2024")
def _(files):
    _, years, rows, _ = sivas(files["sivas-population"])
    ranked = sorted(rows, key=lambda row: -row[years[2024]].value)
    return {"kind": "list", "items": [row[1].value for row in ranked[:3]]}


@oracle("sivas-2015-total-check")
def _(files):
    _, years, rows, total = sivas(files["sivas-population"])
    column = years[2015]
    return record(fileTotal=total[column].value, sum=sum(row[column].value for row in rows))


@oracle("sivas-growth")
def _(files):
    _, years, rows, _ = sivas(files["sivas-population"])
    ranked = sorted(rows, key=lambda row: -(row[years[2024]].value - row[years[2008]].value))
    return {"kind": "text", "value": ranked[0][1].value}


@oracle("sivas-sheet2-average")
def _(files):
    book, _, _, _ = sivas(files["sivas-population"])
    sheet = book.sheet("Sayfa2")
    left = [sheet.cells[(row, 5)].value for row in range(6, 12)]
    right = [sheet.cells[(row, 10)].value for row in range(6, 12)]
    assert left == right
    return number(sum(left) / len(left))


@oracle("sivas-new-neighbourhoods")
def _(files):
    _, years, rows, _ = sivas(files["sivas-population"])
    return {"kind": "set", "items": sorted(row[1].value for row in rows if row[years[2008]].value == 0)}


def heat_pumps(path):
    rows = Workbook(path).sheet("Table 1.1").rows()
    assert rows[5][9].value.startswith("Total: Government-supported")
    assert "Boiler" in rows[5][1].value
    return [row for row in rows[6:] if row[0] is not None]


@oracle("heatpump-logo")
def _(files):
    book = Workbook(files["uk-heat-pumps"])
    cover = book.sheet("Cover Sheet")
    links = ET.fromstring(book.archive.read(cover.part.replace("worksheets/", "worksheets/_rels/") + ".rels"))
    drawing = Workbook.resolve("xl/worksheets", next(item.attrib["Target"] for item in links if item.attrib["Type"].endswith("/drawing")))
    names = re.findall(r'<xdr:cNvPr [^>]*descr="([^"]*)"', book.archive.read(drawing).decode("utf-8"))
    assert len(names) == 1
    return {"kind": "text", "value": names[0]}


@oracle("heatpump-2024-total")
def _(files):
    return number(sum(row[9].value for row in heat_pumps(files["uk-heat-pumps"]) if row[0].value.startswith("2024")))


@oracle("heatpump-bus-best-quarter")
def _(files):
    ranked = sorted(heat_pumps(files["uk-heat-pumps"]), key=lambda row: -row[1].value)
    assert ranked[0][1].value > ranked[1][1].value
    return {"kind": "text", "value": ranked[0][0].value}


def gaziantep(path):
    rows = read_csv(path, "utf-8-sig", ";")
    header = rows[0]
    assert len(header) == 11 and header[0] == "Oluşturulma Tarihi"
    assert all(len(row) == len(header) for row in rows[1:])
    return [dict(zip(header, row)) for row in rows[1:]]


def gaziantep_time(entry):
    return datetime.datetime.strptime(entry["Oluşturulma Tarihi"], "%d.%m.%Y %H:%M")


def most_common(counts):
    ranked = sorted(counts, key=lambda key: -counts[key])
    assert counts[ranked[0]] > counts[ranked[1]]
    return ranked[0]


def tally(values):
    counts = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return counts


@oracle("gaziantep-busiest-month")
def _(files):
    return {"kind": "text", "value": most_common(tally(gaziantep_time(entry).strftime("%Y-%m") for entry in gaziantep(files["gaziantep-requests"])))}


@oracle("gaziantep-phone-district")
def _(files):
    counts = tally(entry["İlçe"] for entry in gaziantep(files["gaziantep-requests"]) if entry["Kaynak"] == "Telefon (Alo 153)" and entry["İlçe"] != "-")
    return {"kind": "text", "value": most_common(counts)}


@oracle("gaziantep-source-pivot")
def _(files):
    counts = tally((entry["İlçe"], entry["Kaynak"]) for entry in gaziantep(files["gaziantep-requests"]))
    return record(**{
        f"{key}{channel}": counts.get((district, source), 0)
        for key, district in (("sahinbey", "Şahinbey"), ("sehitkamil", "Şehitkamil"))
        for channel, source in (("Web", "Web Sayfası"), ("Phone", "Telefon (Alo 153)"))
    })


@oracle("gaziantep-birth-median")
def _(files):
    import statistics

    years = [int(entry["Doğum Tarihi"]) for entry in gaziantep(files["gaziantep-requests"]) if entry["Doğum Tarihi"].isdigit()]
    return number(statistics.median(years))


@oracle("gaziantep-columns")
def _(files):
    records = gaziantep(files["gaziantep-requests"])
    dated = []
    for column in records[0]:
        values = [entry[column] for entry in records if entry[column] not in ("", "-")]
        if values and all(re.fullmatch(r"\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}", value) for value in values):
            dated.append(column)
    assert len(dated) == 1
    return record(columns=len(records[0]), dateColumn=dated[0])


@oracle("gaziantep-women")
def _(files):
    return number(sum(1 for entry in gaziantep(files["gaziantep-requests"]) if entry["Cinsiyet"] == "female"))


@oracle("gaziantep-latest")
def _(files):
    return {"kind": "text", "value": max(gaziantep_time(entry) for entry in gaziantep(files["gaziantep-requests"])).strftime("%Y-%m-%d %H:%M")}


@oracle("flights-2019-international")
def _(files):
    rows = read_csv(files["flights"])
    assert rows[0] == ["tarih", "havalimani", "hat", "ucus_sayisi"]
    return number(sum(int(row[3]) for row in rows[1:] if row[2] == "Dış" and row[0].startswith("2019-")))


@oracle("izmir-metro-2021")
def _(files):
    rows = read_csv(files["izmir-co2"], "utf-8-sig", ";")
    assert rows[0][:3] == ["YIL", "AY", "IZMIR_METROSU"]
    months = [row for row in rows[1:] if row[0] == "2021"]
    assert sorted(int(row[1]) for row in months) == list(range(1, 13))
    return number(round(sum(float(row[2].replace(",", ".")) for row in months), 2))


def manisa_marital(path):
    sheet = Workbook(path).sheet("İLÇE_MEDENİ DRM_2025")
    assert [sheet.cells[(8, column)].value for column in range(1, 9)] == ["İL KAYIT NO", "İL ADI", "İLÇE KAYIT NO", "İLÇE ADI", "MEDENİ DURUM", "TOPLAM", "ERKEK", "KADIN"]
    district, records = None, []
    for row in range(9, max(number for number, _ in sheet.cells) + 1):
        if (row, 4) in sheet.cells:
            district = sheet.cells[(row, 4)].value
        if (row, 5) in sheet.cells:
            records.append((district, sheet.cells[(row, 5)].value, sheet.cells[(row, 8)].value))
    return records


@oracle("manisa-yunusemre-divorced-women")
def _(files):
    matches = [women for district, status, women in manisa_marital(files["manisa-households"]) if district == "YUNUSEMRE" and status == "BOŞANDI"]
    assert len(matches) == 1
    return number(matches[0])


@oracle("manisa-divorced-women-total")
def _(files):
    return number(sum(women for _, status, women in manisa_marital(files["manisa-households"]) if status == "BOŞANDI"))


@oracle("manisa-single-households")
def _(files):
    sheet = Workbook(files["manisa-households"]).sheet("ILCE_HHS_HHB")
    assert sheet.cells[(4, 7)].value == "Hanehalkı Büyüklüğü" and sheet.cells[(5, 7)].value == 1
    matches = [sheet.cells[(row, 7)].value for row in range(6, 30) if (row, 4) in sheet.cells and sheet.cells[(row, 4)].value == "YUNUSEMRE"]
    assert len(matches) == 1
    return number(matches[0])


@oracle("manisa-oldest-women-2025")
def _(files):
    sheet = Workbook(files["manisa-households"]).sheet("İLÇE_MEDYAN YAŞ 2013-2025")
    year = next(column for (row, column), cell in sheet.cells.items() if row == 8 and cell.value == 2025)
    women = next(column for column in range(year, year + 3) if sheet.cells[(9, column)].value == "KADIN")
    ages = {sheet.cells[(row, 5)].value: sheet.cells[(row, women)].value for row in range(10, 27)}
    ranked = sorted(ages, key=lambda name: -ages[name])
    assert ages[ranked[0]] > ages[ranked[1]]
    return {"kind": "text", "value": ranked[0]}


def manisa_plants(path):
    sheet = Workbook(path).sheets[0]
    category, plants, subtotals, grand = None, [], [], None
    for row in range(3, max(number for number, _ in sheet.cells) + 1):
        label = sheet.cells.get((row, 1)), sheet.cells.get((row, 2))
        texts = [cell.value for cell in label if cell is not None and isinstance(cell.value, str)]
        if any(text.startswith("ARA TOPLAM") for text in texts):
            if (row, 4) in sheet.cells:
                subtotals.append(sheet.cells[(row, 4)].value)
            continue
        if any(text.startswith("GENEL TOPLAM") for text in texts):
            grand = sheet.cells[(row, 4)].value
            continue
        if label[1] is not None and isinstance(label[1].value, str):
            category = label[1].value
        if (row, 3) in sheet.cells:
            plants.append((category, sheet.cells[(row, 3)].value, sheet.cells[(row, 4)].value))
    return sheet, plants, subtotals, grand


@oracle("manisa-plants-most-varieties")
def _(files):
    _, plants, _, _ = manisa_plants(files["manisa-plants"])
    return {"kind": "text", "value": most_common(tally(category for category, _, _ in plants))}


@oracle("manisa-plants-total-check")
def _(files):
    _, plants, subtotals, grand = manisa_plants(files["manisa-plants"])
    assert sum(subtotals) == sum(amount for _, _, amount in plants)
    return record(fileTotal=grand, sum=sum(subtotals))


@oracle("manisa-plants-merged")
def _(files):
    sheet, _, _, _ = manisa_plants(files["manisa-plants"])
    return number(len(sheet.merges))


def grocery(path):
    sheet = Workbook(path).sheet("Sayfa4")
    assert sheet.cells[(1, 1)].value.strip() == "GRUP"
    group, items = None, []
    for row in range(2, max(number for number, _ in sheet.cells) + 1):
        if (row, 1) in sheet.cells:
            group = sheet.cells[(row, 1)].value.strip()
        items.append((group, sheet.cells.get((row, 2)), sheet.cells.get((row, 3)), sheet.cells.get((row, 4))))
    return items


@oracle("grocery-broken-prices")
def _(files):
    return number(sum(1 for *_, price in grocery(files["izmir-grocery"]) if price is not None and price.kind == "e"))


@oracle("grocery-spice-average")
def _(files):
    prices = [price.value for group, _, _, price in grocery(files["izmir-grocery"]) if group == "BAHARAT" and price is not None and price.kind == "n"]
    return number(round(sum(prices) / len(prices), 2))


@oracle("grocery-stock-code")
def _(files):
    matches = [code.value for _, code, name, _ in grocery(files["izmir-grocery"]) if name is not None and name.value == "ACI PUL BIBER 80 GR BOGAZICI"]
    assert len(matches) == 1 and re.fullmatch(r"\d+(\.\d+)+", matches[0])
    return {"kind": "text", "value": matches[0]}


def naep(path):
    sheet = Workbook(path).sheet("Score")
    assert sheet.cells[(2, 1)].value == "Characteristic"
    years = {int(sheet.cells[(2, column)].value): column for column in range(2, 11)}
    labels = {sheet.cells[(row, 1)].value.strip(): row for row in range(3, 31) if (row, 1) in sheet.cells}
    return sheet, years, labels


@oracle("naep-female-2013")
def _(files):
    sheet, years, labels = naep(files["us-naep"])
    return number(round(sheet.cells[(labels["Female"], years[2013])].value, 2))


def naep_row(sheet, section, label):
    rows = sorted(row for (row, column) in sheet.cells if column == 1)
    start = next(row for row in rows if str(sheet.cells[(row, 1)].value).strip() == section)
    heading = lambda row: all(sheet.cells.get((row, column)) is None or sheet.cells[(row, column)].value in (None, "") for column in range(2, 11))
    block = []
    for row in rows:
        if row <= start:
            continue
        if heading(row):
            break
        block.append(row)
    matches = [row for row in block if str(sheet.cells[(row, 1)].value).strip() == label]
    assert len(matches) == 1, (section, label, matches)
    return matches[0]


@oracle("naep-pacific-2013")
def _(files):
    sheet, years, _ = naep(files["us-naep"])
    return number(round(sheet.cells[(naep_row(sheet, "Race/ethnicity", "Pacific Islander, non-Hispanic"), years[2013])].value, 2))


@oracle("naep-pacific-male-2013")
def _(files):
    sheet, years, _ = naep(files["us-naep"])
    marker = sheet.cells[(naep_row(sheet, "Males", "Pacific Islander, non-Hispanic"), years[2013])].value
    notes = [cell.value for (row, column), cell in sheet.cells.items() if column == 1 and isinstance(cell.value, str) and cell.value.startswith(marker + " ")]
    assert marker == "‡" and len(notes) == 1 and "standards not met" in notes[0]
    return {"kind": "refusal", "reason": "suppressed"}


@oracle("naep-gender-gap")
def _(files):
    sheet, years, labels = naep(files["us-naep"])
    gap = {year: sheet.cells[(labels["Male"], years[year])].value - sheet.cells[(labels["Female"], years[year])].value for year in (2005, 2013)}
    return record(gap2005=round(gap[2005], 2), gap2013=round(gap[2013], 2))


@oracle("tariff-arcade-tax")
def _(files):
    texts = [text for text in cells_text(Workbook(files["manisa-tariffs"])) if "Atari" in text]
    assert len(texts) == 1
    line = next(part for part in texts[0].splitlines() if "Atari" in part)
    amount = re.search(r"(\d+(?:,\d+)?) TL", line).group(1)
    return number(float(amount.replace(",", ".")))


@oracle("sample-utf16-izmir")
def _(files):
    rows = read_csv(files["sample-utf16"], "utf-16")
    assert rows[0] == ["Şehir", "İlçe"]
    matches = [row[1] for row in rows[1:] if row[0] == "İZMİR"]
    assert len(matches) == 1
    return {"kind": "text", "value": matches[0]}


@oracle("sample-sep-columns")
def _(files):
    lines = Path(files["sample-sep"]).read_text(encoding="utf-8").splitlines()
    assert lines[0] == "sep=;"
    rows = list(csv.reader(lines[1:], delimiter=";"))
    widths = {len(row) for row in rows}
    assert len(widths) == 1
    return number(widths.pop())


@oracle("sample-formula-phone")
def _(files):
    rows = read_csv(files["sample-formulas"])
    matches = [row[1] for row in rows[1:] if row[0] == "phone"]
    assert len(matches) == 1
    return {"kind": "text", "value": matches[0]}


@oracle("sfo-noise-limit")
def _(files):
    csv_limit = 16 * 1024 * 1024
    assert Path(files["us-sfo-noise"]).stat().st_size > csv_limit
    return {"kind": "refusal", "reason": "limit"}


def boiler_table(path, header_row):
    sheet = Workbook(path).sheet("1.1")
    header = {sheet.cells[(header_row, column)].value.replace("\n", "").replace("  ", " ").strip(): column for column in range(1, 8)}
    rows = {sheet.cells[(row, 1)].value: row for row in range(header_row + 1, header_row + 5)}
    return sheet, header, rows


@oracle("boiler-air-to-water-paid")
def _(files):
    sheet, header, rows = boiler_table(files["uk-boiler"], 5)
    return number(sheet.cells[(rows["Redemptions paid"], header["Air-to-Water Heat Pumps"])].value)


@oracle("boiler-ground-source-share")
def _(files):
    sheet, header, rows = boiler_table(files["uk-boiler"], 5)
    counts = [sheet.cells[(rows["Redemptions paid"], column)].value for column in range(2, 7)]
    share = sheet.cells[(rows["Redemptions paid"], header["Ground Source Heat Pumps"])].value / sum(counts)
    _, percent_header, percent_rows = boiler_table(files["uk-boiler"], 11)
    stored = Workbook(files["uk-boiler"]).sheet("1.1").cells[(percent_rows["Redemptions paid"], percent_header["Ground Source Heat Pumps"])].value
    assert abs(stored - share) < 1e-9
    return number(round(100 * share, 2))


def fhrs_sticker(path):
    book = Workbook(path)
    contents = book.sheet("Contents")
    entries = [row for (row, column), cell in contents.cells.items() if column == 3 and cell.value == "Did you see an FHRS sticker at this outlet?"]
    assert len(entries) == 1
    table = contents.cells[(entries[0], 2)].value
    sheet = book.sheet(table.split()[1])
    labels = {sheet.cells[(row, 2)].value: row for row in range(10, 25) if (row, 2) in sheet.cells}
    return sheet, labels


@oracle("audit-sticker-seen")
def _(files):
    sheet, labels = fhrs_sticker(files["uk-fhrs-audit"])
    seen, total = sheet.cells[(labels["Yes"], 3)].value, sheet.cells[(labels["Total"], 3)].value
    return record(businesses=seen, percent=round(100 * seen / total))


@oracle("audit-rating-four-sticker")
def _(files):
    sheet, labels = fhrs_sticker(files["uk-fhrs-audit"])
    column = next(column for column in range(5, 10) if sheet.cells[(10, column)].value.strip() == "4")
    seen, total = sheet.cells[(labels["Yes"], column)].value, sheet.cells[(labels["Total"], column)].value
    stored = sheet.cells[(labels["Yes"] + 1, column)].value
    assert stored == f"*{round(100 * seen / total)}%"
    return number(round(100 * seen / total))


@oracle("toilets-extract-date")
def _(files):
    rows = read_csv(files["uk-toilets"])
    dates = {row[0] for row in rows[1:]}
    assert rows[0][:3] == ["ExtractDate", "OrganisationURI", "OrganisationLabel"] and len(dates) == 1
    assert {row[2].strip() for row in rows[1:]} == {"Plymouth City Council"}
    day, month, year = (int(part) for part in dates.pop().split("/"))
    return {"kind": "text", "value": f"{year:04d}-{month:02d}-{day:02d}"}


@oracle("ibb-pre1980-p75")
def _(files):
    values = sorted(int(row["1980_oncesi"]) for row in ibb_rows(files["ibb-buildings"]))
    position = (len(values) - 1) * 0.75
    lower = int(position)
    return number(values[lower] + (position - lower) * (values[lower + 1] - values[lower]))


@oracle("uk-glos-total")
def _(files):
    return number(money(sum(entry["AP Amount"] for entry in glos_invoices(files["uk-glos-invoices"]))))


@oracle("flights-airport-count")
def _(files):
    rows = read_csv(files["flights"])
    assert rows[0][1] == "havalimani"
    return number(len({row[1] for row in rows[1:]}))


@oracle("fire-data-rows")
def _(files):
    _, records = fire_data(files["uk-fire-0604"])
    return number(len(records))


@oracle("gaziantep-busiest-hour")
def _(files):
    return number(most_common(tally(gaziantep_time(entry).hour for entry in gaziantep(files["gaziantep-requests"]))))


NUMERIC_KINDS = ("integer", "decimal", "percent")
TEXT_KINDS = ("text", "date", "month", "localDateTime")


def raw_value(field):
    if field["kind"] == "integer" and not isinstance(field["value"], int):
        raise ValueError(f"integer field holds {field['value']!r}")
    return field["value"]


def untyped(answer):
    kind = answer["kind"]
    if kind in NUMERIC_KINDS:
        return {"kind": "number", "value": raw_value(answer)}
    if kind in TEXT_KINDS:
        return {"kind": "text", "value": raw_value(answer)}
    if kind in ("list", "set"):
        return {"kind": kind, "items": [raw_value(item) for item in answer["items"]]}
    if kind == "record":
        return {"kind": "record", "fields": {key: raw_value(field) for key, field in answer["fields"].items()}}
    return answer


def same(expected, actual):
    expected = untyped(expected)
    if expected["kind"] != actual["kind"]:
        return False
    if expected["kind"] == "set":
        return sorted(map(str, expected["items"])) == sorted(map(str, actual["items"]))
    keys = [key for key in expected if key not in ("tolerance", "shape")]
    return {key: expected[key] for key in keys} == {key: actual.get(key) for key in keys}


def verify(args):
    catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    corpus = Path(args.corpus)
    paths = {key: corpus / entry["source"] / entry["file"] for key, entry in catalog["files"].items()}
    report = {"passed": [], "failed": [], "missing": []}
    changed = [key for key, entry in catalog["files"].items() if hashlib.sha256(paths[key].read_bytes()).hexdigest() != entry["sha256"]]
    if changed:
        print(json.dumps({"changedFiles": changed}, indent=1))
        sys.exit(1)
    for task in catalog["tasks"]:
        if task["id"] not in ORACLES:
            report["missing"].append(task["id"])
            continue
        computed = ORACLES[task["id"]]({key: paths[key] for key in task["files"]})
        if same(task["answer"], computed):
            report["passed"].append(task["id"])
        else:
            report["failed"].append({"task": task["id"], "catalog": task["answer"], "oracle": computed})
    unused = sorted(set(ORACLES) - {task["id"] for task in catalog["tasks"]})
    report["unusedOracles"] = unused
    print(json.dumps(report, ensure_ascii=False, indent=1))
    if report["failed"] or report["missing"] or unused:
        sys.exit(1)


def dump(args):
    path = Path(args.file)
    if path.suffix.lower() == ".csv":
        rows = read_csv(path, args.encoding, args.delimiter)
        print(f"--- {len(rows)} records")
        shown = list(enumerate(rows, 1))
        shown = shown[: args.rows] + (shown[-args.tail :] if args.tail and len(shown) > args.rows else [])
        for number, row in shown:
            print(f"{number}: " + " | ".join(row)[: args.width])
        return
    book = Workbook(path)
    print(json.dumps({
        "date1904": book.date1904,
        "definedNames": book.defined_names,
        "sheets": [
            {"name": sheet.name, "state": sheet.state, "kind": sheet.kind, "cells": len(sheet.cells), "merges": len(sheet.merges)}
            for sheet in book.sheets
        ],
    }, ensure_ascii=False, indent=1))
    for sheet in book.sheets:
        if args.sheet is not None and sheet.name != args.sheet:
            continue
        rows = sheet.rows()
        print(f"--- {sheet.name} ({len(rows)} rows) merges={sheet.merges[:12]}")
        shown = list(enumerate(rows, 1))
        shown = shown[: args.rows] + (shown[-args.tail :] if args.tail and len(shown) > args.rows else [])
        for number, row in shown:
            cells = [
                f"{column_letters(column)}{number}={cell.value!r}" + ("ƒ" if cell.formula is not None else "") + ("" if cell.kind in ("n", "s") else f"<{cell.kind}>")
                for column, cell in enumerate(row, 1)
                if cell is not None
            ]
            print(" | ".join(cells)[: args.width])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("dump", help="print a file's sheets and cells")
    inspect.add_argument("file")
    inspect.add_argument("--sheet")
    inspect.add_argument("--rows", type=int, default=15)
    inspect.add_argument("--tail", type=int, default=0)
    inspect.add_argument("--width", type=int, default=400)
    inspect.add_argument("--encoding", default="utf-8-sig")
    inspect.add_argument("--delimiter", default=",")
    check = commands.add_parser("verify", help="recompute every task answer and compare it with the catalog")
    check.add_argument("--catalog", default=str(Path(__file__).resolve().parents[1] / "src/agent/catalog.json"))
    check.add_argument("--corpus", required=True)
    args = parser.parse_args()
    if args.command == "dump":
        dump(args)
    elif args.command == "verify":
        verify(args)
    else:
        sys.exit(f"unknown command {args.command}")


if __name__ == "__main__":
    main()
