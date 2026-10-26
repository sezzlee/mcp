import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile


TABLE = '{urn:oasis:names:tc:opendocument:xmlns:table:1.0}'
OFFICE = '{urn:oasis:names:tc:opendocument:xmlns:office:1.0}'
TEXT = '{urn:oasis:names:tc:opendocument:xmlns:text:1.0}'


def coordinates(reference):
    match = re.fullmatch(r'([A-Z]+)([1-9][0-9]*)', reference)
    assert match is not None, reference
    column = 0
    for letter in match[1]:
        column = column * 26 + ord(letter) - 64
    return int(match[2]), column


def ods_values(path):
    values = {}
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        root = ET.fromstring(archive.read('content.xml'))
    sheet = root.find('.//' + TABLE + 'table')
    assert sheet is not None
    row_index = 1
    for row in sheet.iter(TABLE + 'table-row'):
        rows = int(row.attrib.get(TABLE + 'number-rows-repeated', '1'))
        column_index = 1
        for cell in row:
            if cell.tag not in (TABLE + 'table-cell', TABLE + 'covered-table-cell'):
                continue
            columns = int(cell.attrib.get(TABLE + 'number-columns-repeated', '1'))
            kind = cell.attrib.get(OFFICE + 'value-type')
            assert TABLE + 'formula' not in cell.attrib, 'Unexpected application formula'
            value = None
            if kind == 'float':
                value = ('number', float(cell.attrib[OFFICE + 'value']))
            elif kind == 'string':
                value = ('text', '\n'.join(''.join(p.itertext()) for p in cell.findall(TEXT + 'p')))
            else:
                assert kind is None, ('Unexpected application value type', kind)
            if value is not None:
                assert rows * columns + len(values) <= 1_000_000, 'Application output exceeds the cell bound'
                for r in range(row_index, row_index + rows):
                    for c in range(column_index, column_index + columns):
                        values[r, c] = value
            column_index += columns
        row_index += rows
    return values


def main(directory):
    root = Path(directory).resolve()
    spec = importlib.util.spec_from_file_location('bulk_oracle', Path(__file__).with_name('bulk-oracle.py'))
    oracle = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(oracle)
    oracle.verify(root)
    report = json.loads((root / 'bulk-results.json').read_text())
    output = root / 'calc'
    output.mkdir(exist_ok=True)
    version = subprocess.run(['soffice', '--version'], check=True, capture_output=True, text=True).stdout.strip()
    evidence = []
    paths = {item['version']['filePath'] for result in report['results'] for item in result['outputs']}
    for relative in sorted(paths):
        path = root / relative
        original_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        converted = subprocess.run(['soffice', '-env:UserInstallation=' + (output / 'profile').as_uri(), '--headless', '--convert-to', 'ods', '--outdir', str(output), str(path)], check=True, capture_output=True, text=True, timeout=120)
        ods = output / (path.stem + '.ods')
        assert ods.is_file(), ('No application output', converted.stdout, converted.stderr)
        expected = {coordinates(key): value for key, value in oracle.stored(path).items()}
        actual = ods_values(ods)
        assert actual == expected, ('Application scalar mismatch', relative, len(actual), len(expected), list((actual.items() - expected.items()))[:4])
        assert hashlib.sha256(path.read_bytes()).hexdigest() == original_hash, 'Application modified the input workbook'
        evidence.append({'filePath': relative, 'sha256': original_hash, 'cellsVerified': len(expected), 'odsSha256': hashlib.sha256(ods.read_bytes()).hexdigest()})
    result = {'passed': True, 'engine': version, 'oracle': 'independent expected values, raw OOXML and application-produced ODF scalar types/values/order', 'outputs': evidence}
    (root / 'application-oracle.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'passed': True, 'engine': version, 'outputs': len(evidence), 'cellsVerified': sum(item['cellsVerified'] for item in evidence)}))


if __name__ == '__main__':
    main(sys.argv[1])
