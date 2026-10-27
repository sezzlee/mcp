import argparse
import hashlib
import json
import runpy
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

oracle = runpy.run_path(str(Path(__file__).with_name("expert-oracle.py")))
inspect = oracle["inspect"]
require = oracle["require"]


def check(source, out):
    source = Path(source).resolve()
    out = Path(out).resolve()
    require(source.parent != out, "Application output must use a separate directory")
    out.mkdir(parents=True, exist_ok=False)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    expected = inspect(source)
    binary = shutil.which("soffice")
    require(binary is not None, "LibreOffice is unavailable")
    with tempfile.TemporaryDirectory(prefix="excel-expert-calc-") as profile:
        command = [binary, "-env:UserInstallation=" + Path(profile).as_uri(), "--headless", "--convert-to", "xlsx", "--outdir", str(out), str(source)]
        process = subprocess.run(command, text=True, capture_output=True, timeout=120)
        require(process.returncode == 0, "LibreOffice failed: " + process.stderr[-1000:])
    actual = inspect(out / source.name)
    for sheet, cells in expected["sheets"].items():
        for reference, cell in cells.items():
            if cell["value"] is None:
                continue
            observed = actual["sheets"][sheet].get(reference, {}).get("value")
            if any(p["sheet"] == sheet and reference == str(oracle["rectangle"](p["range"])[2]) + "," + str(oracle["rectangle"](p["range"])[1]) for p in expected["pivots"]):
                require(isinstance(observed, str) and observed, "Application lost the grand-total caption")
            else:
                require(oracle["equivalent"](observed, cell["value"]), "Application changed " + sheet + "!" + reference)
    require([(p["name"], p["rows"]) for p in actual["pivots"]] == [(p["name"], p["rows"]) for p in expected["pivots"]], "Application lost or changed pivot sources")
    require([(c["name"], c["title"], c["chartType"], c["series"]) for c in actual["charts"]] == [(c["name"], c["title"], c["chartType"], c["series"]) for c in expected["charts"]], "Application changed chart types, titles or series")
    require([i["name"] for i in actual["images"]] == [i["name"] for i in expected["images"]], "Application lost images")
    require(actual["links"] == expected["links"], "Application changed hyperlinks")
    require(actual["notes"] == expected["notes"], "Application changed notes")
    normalize_validation = lambda rows: sorted((r["sheet"], r["sqref"], r["type"], r["formula1"]) for r in rows)
    require(normalize_validation(actual["validations"]) == normalize_validation(expected["validations"]), "Application changed validation rules")
    normalize_condition = lambda rows: [(r["sheet"], r["range"], r["type"], tuple(r["formulas"]), r["fill"]) for r in sorted(rows, key=lambda r: (r["sheet"], int(r["priority"])))]
    require(normalize_condition(actual["conditions"]) == normalize_condition(expected["conditions"]), "Application changed conditional-format formulas or effective fill")
    stop_flags = lambda rows: [r.get("stopIfTrue", "0") in ("1", "true") for r in sorted(rows, key=lambda r: (r["sheet"], int(r["priority"])))]
    stop_preserved = stop_flags(actual["conditions"]) == stop_flags(expected["conditions"])
    require(actual["protectedSheets"] == expected["protectedSheets"] and actual["workbookProtected"] == expected["workbookProtected"], "Application changed protection")
    require(actual["unlocked"] == expected["unlocked"], "Application changed unlocked cells")
    require(hashlib.sha256(source.read_bytes()).hexdigest() == before, "Application changed the source")
    return {"passed": True, "output": str(out / source.name), "pivots": len(actual["pivots"]), "charts": len(actual["charts"]), "images": len(actual["images"]), "sourceUnchanged": True, "stopIfTruePreserved": stop_preserved}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("workbook")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(check(args.workbook, args.out)))
    except Exception as error:
        print(json.dumps({"passed": False, "error": str(error)}))
        sys.exit(1)
