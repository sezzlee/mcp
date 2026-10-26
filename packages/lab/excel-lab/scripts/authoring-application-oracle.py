import hashlib
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile


spec = importlib.util.spec_from_file_location("authoring_oracle", Path(__file__).with_name("authoring-agent-oracle.py"))
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ods_cells(path, sheet_names=("Expenses", "Calc", "Summary", "Sales", "Title")):
    with zipfile.ZipFile(path) as package:
        assert package.testzip() is None
        content = ET.fromstring(package.read("content.xml"))
    result = {}
    for sheet in content.iter("{" + TABLE + "}table"):
        name = sheet.attrib.get("{" + TABLE + "}name")
        if name not in sheet_names:
            continue
        cells = {}
        row_index = 1
        for row in sheet.iter("{" + TABLE + "}table-row"):
            repeat_rows = int(row.attrib.get("{" + TABLE + "}number-rows-repeated", "1"))
            if row_index > 10:
                break
            for offset in range(min(repeat_rows, 10 - row_index + 1)):
                column_index = 1
                for cell in row:
                    if cell.tag not in ["{" + TABLE + "}table-cell", "{" + TABLE + "}covered-table-cell"]:
                        continue
                    repeated = int(cell.attrib.get("{" + TABLE + "}number-columns-repeated", "1"))
                    value = cell.attrib.get("{" + OFFICE + "}value")
                    if value is None:
                        value = cell.attrib.get("{" + OFFICE + "}date-value")
                    if value is None:
                        value = "".join(node.text or "" for node in cell.iter("{" + TEXT + "}p"))
                    for col in range(column_index, min(10, column_index + repeated - 1) + 1):
                        cells[chr(64 + col) + str(row_index + offset)] = value
                    column_index += repeated
                    if column_index > 10:
                        break
            row_index += repeat_rows
        result[name] = cells
    return result


def verify_application(directory):
    root = Path(directory)
    manifest = json.loads((root / "manifest.json").read_text())
    records = [json.loads(line) for line in (root / "results.jsonl").read_text().splitlines() if line]
    selected = [record for record in records if record["passed"] and record["scenario"].startswith("authoring_") and record.get("selectedVersion")]
    assert selected, "no successful authoring output"
    results = []
    version = subprocess.run(["soffice", "--version"], text=True, capture_output=True, timeout=30)
    assert version.returncode == 0, version.stderr
    for record in selected:
        trial = Path(record["directory"])
        source, output = trial / "source.xlsx", trial / record["selectedVersion"]["filePath"]
        source_hash, output_hash = sha(source), sha(output)
        assert source_hash == manifest["sourceSha256"]
        assert output_hash == record["selectedVersion"]["versionId"]
        oracle.verify(source, output, record["scenario"])
        target = root / "application" / trial.name
        target.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="excel-authoring-calc-") as profile:
            args = ["soffice", "-env:UserInstallation=" + Path(profile).as_uri(), "--headless", "--convert-to", "ods", "--outdir", str(target), str(output)]
            run = subprocess.run(args, text=True, capture_output=True, timeout=120)
            assert run.returncode == 0, (run.stdout, run.stderr)
        ods = target / (output.stem + ".ods")
        assert ods.exists(), ("application did not emit ODS", run.stdout, run.stderr)
        actual = ods_cells(ods)
        scenario = record["scenario"]
        expected = {}
        if scenario == "authoring_formula":
            expected = {("Calc", "C2"): 23.6, ("Calc", "C3"): 17.7, ("Summary", "A1"): 41.3}
        elif scenario in ["authoring_table", "authoring_continuation"]:
            expected = {("Sales", "D2"): 20, ("Sales", "D3"): 15, ("Sales", "D4"): 8, ("Sales", "D5"): 43, ("Sales", "F1"): 43}
            if scenario == "authoring_continuation":
                expected.update({("Sales", "D4"):12, ("Sales", "D5"):47, ("Sales", "F1"):47})
        elif scenario == "authoring_lifecycle":
            expected = {("Sales", "D2"):20, ("Sales", "D3"):15, ("Sales", "F1"):20}
        elif scenario == "authoring_format":
            expected = {("Expenses", "C2"): 20, ("Expenses", "C3"): 50, ("Expenses", "D2"): 0.18, ("Expenses", "D3"): 0.08}
            assert actual["Expenses"]["A2"].startswith("2026-01-02")
        elif scenario == "authoring_merge":
            assert actual["Title"]["A1"] == "Ad" and not actual["Title"].get("B1")
        for (sheet, cell), value in expected.items():
            assert math.isclose(float(actual[sheet][cell]), value, rel_tol=1e-12, abs_tol=1e-12), ("application calculation/value mismatch", scenario, sheet, cell, actual[sheet][cell], value)
        assert sha(source) == source_hash and sha(output) == output_hash, "application changed an original workbook"
        results.append({"scenario": scenario, "mode": record["mode"], "language": record["language"], "passed": True, "scalarChecks": len(expected), "outputSha256": output_hash, "odsSha256": sha(ods), "ods": str(ods)})
    report = {"status": "passed", "application": version.stdout.strip(), "outputs": results}
    (root / "application-oracle.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": "passed", "outputs": len(results), "scalarChecks": sum(item["scalarChecks"] for item in results)}))


if __name__ == "__main__":
    verify_application(sys.argv[1])
