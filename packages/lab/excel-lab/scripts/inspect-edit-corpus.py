import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile


SPREADSHEET = {
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "http://purl.oclc.org/ooxml/spreadsheetml/main",
}
MAX_FILE = 50 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_PART = 64 * 1024 * 1024
MAX_PARTS = 10000
ELEMENTS = {
    "c": "cells",
    "f": "formulas",
    "definedName": "defined_names",
    "mergeCell": "merges",
    "hyperlink": "hyperlinks",
    "dataValidation": "validations",
    "conditionalFormatting": "conditional_formats",
    "sheetProtection": "sheet_protection",
    "workbookProtection": "workbook_protection",
    "drawing": "drawing_references",
    "legacyDrawing": "legacy_drawing_references",
    "tablePart": "table_references",
    "pane": "panes",
    "extLst": "extension_lists",
}
PART_FEATURES = {
    "chart": "chart_parts",
    "drawing": "drawing_parts",
    "table": "table_parts",
    "pivotTable": "pivot_table_parts",
    "pivotCacheDefinition": "pivot_cache_parts",
    "externalLink": "external_link_parts",
    "calcChain": "calculation_chain_parts",
    "comments": "comment_parts",
    "styles": "style_parts",
    "sharedStrings": "shared_string_parts",
    "sheetMetadata": "metadata_parts",
}


def digest(file):
    checksum = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def inspect_package(file):
    features = Counter()
    with zipfile.ZipFile(file) as package:
        infos = package.infolist()
        names = [entry.filename for entry in infos]
        if len(infos) > MAX_PARTS or sum(entry.file_size for entry in infos) > MAX_EXPANDED:
            raise ValueError("expanded_package_budget")
        if any(entry.file_size > MAX_PART for entry in infos):
            raise ValueError("part_budget")
        if len(names) != len(set(names)):
            raise ValueError("duplicate_parts")
        if any(entry.flag_bits & 1 for entry in infos):
            raise ValueError("encrypted_zip")
        features["parts"] = len(infos)
        features["expanded_bytes"] = sum(entry.file_size for entry in infos)
        types = ET.fromstring(package.read("[Content_Types].xml"))
        defaults = {entry.attrib["Extension"]: entry.attrib["ContentType"] for entry in types if entry.tag.endswith("}Default")}
        overrides = {entry.attrib["PartName"].lstrip("/"): entry.attrib["ContentType"] for entry in types if entry.tag.endswith("}Override")}
        selected = set()
        for part in names:
            extension = PurePosixPath(part).suffix.lstrip(".")
            content_type = overrides.get(part, defaults.get(extension, ""))
            if "macroEnabled" in content_type or "vbaProject" in content_type:
                features["macro_content_types"] += 1
            for kind, feature in PART_FEATURES.items():
                if content_type.endswith("." + kind + "+xml"):
                    features[feature] += 1
            if content_type.endswith((".sheet.main+xml", ".sheet.macroEnabled.main+xml", ".worksheet+xml")):
                selected.add(part)
        for name in names:
            if name.lower().endswith("vbaproject.bin"):
                features["vba_parts"] += 1
            if name.startswith("_xmlsignatures/"):
                features["signature_parts"] += 1
            if name.endswith(".rels"):
                with package.open(name) as stream:
                    for _, element in ET.iterparse(stream, events=("end",)):
                        if element.tag == "{http://schemas.openxmlformats.org/package/2006/relationships}Relationship":
                            features["relationships"] += 1
                            if element.attrib.get("TargetMode") == "External":
                                features["external_relationships"] += 1
                        element.clear()
        for part in sorted(selected):
            stack = []
            with package.open(part) as stream:
                for event, element in ET.iterparse(stream, events=("start", "end")):
                    if event == "start":
                        stack.append(element)
                        if element.tag.startswith("{"):
                            namespace, local = element.tag[1:].split("}", 1)
                            if namespace in SPREADSHEET:
                                if namespace.startswith("http://purl."):
                                    features["strict_markup"] = 1
                                if local in ELEMENTS:
                                    features[ELEMENTS[local]] += 1
                                if local == "f":
                                    features["formula_" + element.attrib.get("t", "normal")] += 1
                                if local == "c" and "s" in element.attrib:
                                    features["styled_cells"] += 1
                                if local == "sheet":
                                    features["sheets"] += 1
                                    if element.attrib.get("state", "visible") != "visible":
                                        features["hidden_sheets"] += 1
                                if local in ("row", "col") and element.attrib.get("hidden") in ("1", "true"):
                                    features["hidden_" + local + "_elements"] += 1
                                if local == "workbookPr" and element.attrib.get("date1904") in ("1", "true"):
                                    features["date1904"] = 1
                    else:
                        stack.pop()
                        if stack:
                            stack[-1].remove(element)
                        element.clear()
    blockers = []
    if features["macro_content_types"] or features["vba_parts"]:
        blockers.append("macros")
    if features["sheet_protection"] or features["workbook_protection"]:
        blockers.append("protection_markup")
    if features["signature_parts"]:
        blockers.append("package_signature")
    return {"features": dict(sorted(features.items())), "policyBlockers": blockers}


def inspect_entry(source, directory, entry):
    result = {"source": source, "file": entry["file"], "sha256": entry["sha256"], "format": entry["format"]}
    file_name = entry["file"]
    relative = PurePosixPath(file_name)
    file = (directory / file_name).resolve()
    if relative.is_absolute() or ".." in relative.parts or "\\" in file_name or not file.is_relative_to(directory.resolve()):
        return {**result, "status": "outside_source"}
    try:
        if file.stat().st_size > MAX_FILE:
            return {**result, "status": "file_budget"}
        if digest(file) != entry["sha256"]:
            return {**result, "status": "sha_mismatch"}
        inspected = inspect_package(file)
        if entry["format"] == "xlsm":
            inspected["policyBlockers"].append("xlsm_format")
        if digest(file) != entry["sha256"]:
            return {**result, "status": "source_changed"}
        return {**result, "status": "inspected", **inspected}
    except (OSError, ValueError, KeyError, RuntimeError, NotImplementedError, ET.ParseError, zipfile.BadZipFile) as error:
        return {**result, "status": "inspection_error", "reason": str(error)[:200]}


def valid_entry(entry):
    return (
        isinstance(entry, dict)
        and isinstance(entry.get("file"), str)
        and isinstance(entry.get("format"), str)
        and isinstance(entry.get("sha256"), str)
        and re.fullmatch("[0-9a-f]{64}", entry["sha256"]) is not None
    )


def run(corpus, out, sources):
    if out.is_relative_to(Path(__file__).resolve().parents[4]) or out.is_relative_to(corpus):
        raise ValueError("Output must be outside the repository and corpus")
    folders = sorted(folder for folder in corpus.iterdir() if folder.is_dir() and not folder.name.startswith(("_", ".")))
    unknown = set(sources) - {folder.name for folder in folders}
    if unknown:
        raise ValueError("Unknown corpus sources: " + ", ".join(sorted(unknown)))
    out.mkdir(parents=True, exist_ok=False)
    statuses = Counter()
    feature_files = Counter()
    blockers = Counter()
    examples = {}
    manifest_digests = {}
    with (out / "inventory.jsonl").open("w") as output:
        for folder in folders:
            if sources and folder.name not in sources:
                continue
            manifest = folder / "manifest.jsonl"
            if not manifest.is_file():
                continue
            manifest_digests[folder.name] = digest(manifest)
            with manifest.open() as lines:
                for line_number, line in enumerate(lines, 1):
                    if not line.strip():
                        continue
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        entry = None
                    if not valid_entry(entry):
                        result = {"source": folder.name, "line": line_number, "status": "malformed_manifest"}
                    elif entry["format"] not in ("xlsx", "xlsm"):
                        continue
                    else:
                        result = inspect_entry(folder.name, folder, entry)
                    output.write(json.dumps(result, ensure_ascii=False) + "\n")
                    statuses[result["status"]] += 1
                    for feature, count in result.get("features", {}).items():
                        if count and feature not in ("parts", "expanded_bytes", "cells", "relationships", "sheets"):
                            feature_files[feature] += 1
                            sample = examples.setdefault(feature, [])
                            if len(sample) < 3:
                                sample.append({key: result[key] for key in ("source", "file", "sha256")})
                    blockers.update(result.get("policyBlockers", []))
    summary = {
        "kind": "characterization_only",
        "editingSupportClaim": False,
        "scriptSha256": digest(Path(__file__).resolve()),
        "python": sys.version,
        "manifestSha256": manifest_digests,
        "statuses": dict(statuses),
        "filesWithFeature": dict(sorted(feature_files.items())),
        "filesWithPolicyBlocker": dict(blockers),
        "examples": examples,
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Inventory original OOXML corpus features without editing any workbook.")
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--source", action="append", default=[])
    options = parser.parse_args()
    summary = run(options.corpus.resolve(), options.out.resolve(), options.source)
    print(json.dumps({"out": str(options.out.resolve()), "statuses": summary["statuses"], "editingSupportClaim": False}))
