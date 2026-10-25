import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile


TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"


def read(file, wanted):
    result = {}
    with zipfile.ZipFile(file) as package:
        root = ET.fromstring(package.read("content.xml"))
        sheet = root.find(".//{" + TABLE + "}table")
        assert sheet is not None
        row_index = 1
        for row in sheet.iter("{" + TABLE + "}table-row"):
            repeat = int(row.attrib.get("{" + TABLE + "}number-rows-repeated", "1"))
            targets = [point for point in wanted if row_index <= point[0] < row_index + repeat]
            if targets:
                column_index = 1
                for cell in row:
                    if cell.tag not in ("{" + TABLE + "}table-cell", "{" + TABLE + "}covered-table-cell"):
                        continue
                    columns = int(cell.attrib.get("{" + TABLE + "}number-columns-repeated", "1"))
                    for point in targets:
                        if column_index <= point[1] < column_index + columns:
                            kind = cell.attrib.get("{" + OFFICE + "}value-type")
                            value = cell.attrib.get("{" + OFFICE + "}boolean-value") if kind == "boolean" else cell.attrib.get("{" + OFFICE + "}value")
                            if kind == "string":
                                value = "\n".join("".join(paragraph.itertext()) for paragraph in cell.findall("{" + TEXT + "}p"))
                            result[point] = (kind, value, cell.attrib.get("{" + TABLE + "}formula"))
                    column_index += columns
            row_index += repeat
    return result


def main(run, ods):
    records = [json.loads(line) for line in (Path(run) / "results.jsonl").read_text().splitlines() if line.strip()]
    evidence = []
    for record in records:
        version = record.get("selectedVersion")
        if record["mode"] != "scripted" or not version:
            continue
        file = Path(ods) / (Path(version["filePath"]).stem + ".ods")
        scenario = record["scenario"]
        expected = {(1, 1): ("boolean", "true"), (2, 1): ("boolean", "true"), (4, 1): ("boolean", "false"), (5, 1): ("boolean", "false")}
        if scenario == "write": expected[(10, 2)] = ("float", "99")
        if scenario == "copy": expected.update({(10, 3): ("boolean", "true"), (11, 3): ("boolean", "true")})
        if scenario == "clear": expected[(1, 1)] = (None, None)
        if scenario == "rows": expected = {(row + (1 if row >= 2 else 0), column): value for (row, column), value in expected.items()}
        actual = read(file, expected)
        for point, value in expected.items():
            assert actual.get(point, (None, None, None))[:2] == value, (scenario, point, actual.get(point), value)
        if scenario == "copy": assert actual[(10, 3)][2] is not None, "Copied formula disappeared"
        evidence.append({"scenario": scenario, "status": "passed", "checks": len(expected), "file": str(file)})
    result = {"status": "passed", "engine": "LibreOffice 26.8.1 Calc", "oracle": "independent ODF XML typed values after application calculation", "evidence": evidence}
    (Path(run) / "libreoffice-oracle.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"status": "passed", "scenarios": len(evidence)}))


if __name__ == "__main__":
    main(*sys.argv[1:])
