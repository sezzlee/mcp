import csv
import hashlib
import json
import pathlib
import sys
import xml.etree.ElementTree as ET
import zipfile

MAIN = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def table(path):
    with path.open(newline='', encoding='utf-8') as source:
        rows = list(csv.reader(source))
    return rows[0], [[row[0]] + [int(cell) for cell in row[1:]] for row in rows[1:]]


def stored(path):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            for item in ET.fromstring(archive.read('xl/sharedStrings.xml')):
                strings.append(''.join(node.text or '' for node in item.iter(MAIN + 't')))
        sheet = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
        values = {}
        for cell in sheet.iter(MAIN + 'c'):
            reference, kind = cell.attrib['r'], cell.attrib.get('t')
            assert cell.find(MAIN + 'f') is None, reference
            value = cell.find(MAIN + 'v')
            if kind == 'inlineStr':
                values[reference] = ('text', ''.join(node.text or '' for node in cell.iter(MAIN + 't')))
            elif kind == 's':
                values[reference] = ('text', strings[int(value.text)])
            elif value is not None:
                assert kind in (None, 'n'), (reference, kind)
                values[reference] = ('number', float(value.text))
        return values


def letters(index):
    result = ''
    while index:
        index, digit = divmod(index - 1, 26)
        result = chr(65 + digit) + result
    return result


def verify(root):
    report = json.loads((root / 'bulk-results.json').read_text())
    for name, digest in report['inputs'].items():
        assert sha(root / name) == digest, ('changed input', name)
    headers, source = table(root / 'source.csv')
    operation = report['operation']
    expected_headers, expected = headers, source
    if operation == 'update':
        expected = [[row[0], row[1], -1 if row[1] == 3 else row[2]] + row[3:] for row in source]
    elif operation == 'replace':
        expected_headers, expected = table(root / 'replacement.csv')
    elif operation == 'upsert':
        _, changes = table(root / 'changes.csv')
        by_id = {row[0]: list(row) for row in source}
        order = [row[0] for row in source]
        for row in changes:
            if row[0] not in by_id:
                order.append(row[0])
            by_id[row[0]] = row
        expected = [by_id[key] for key in order]
    elif operation == 'append':
        expected = source + source
    elif operation == 'join':
        expected_headers, right = table(root / 'right.csv')
        by_id = {row[0]: row for row in right}
        expected = [by_id[row[0]] for row in source]
    elif operation == 'sort':
        expected = sorted(source, key=lambda row: row[2], reverse=True)
    elif operation == 'deduplicate':
        expected_headers, duplicates = table(root / 'duplicates.csv')
        final = {row[0]: index for index, row in enumerate(duplicates)}
        expected = [row for index, row in enumerate(duplicates) if final[row[0]] == index]
    count = 0
    for result_index, result in enumerate(report['results']):
        for output in result['outputs']:
            path = root / output['version']['filePath']
            assert sha(path) == output['version']['versionId']
            assert path.stat().st_size == output['sizeBytes']
            actual = stored(path)
            selected_headers, selected = expected_headers, expected
            if operation == 'atomic' and output['id'] == 'summary':
                selected_headers, selected = headers[:3], [row[:3] for row in source]
            if operation == 'independent':
                selected_headers, selected = headers + ['Batch'], [row + [result_index] for row in source]
            wanted = {}
            for r, row in enumerate([selected_headers] + selected, 1):
                for c, value in enumerate(row, 1):
                    wanted[f'{letters(c)}{r}'] = ('text' if isinstance(value, str) else 'number', value)
            assert actual == wanted, ('unexpected coordinate/value/type', operation, len(actual), len(wanted))
            count += len(wanted)
    print(json.dumps({'operation': operation, 'outputs': sum(len(r['outputs']) for r in report['results']), 'cellsVerified': count, 'passed': True}))


if __name__ == '__main__':
    verify(pathlib.Path(sys.argv[1]).resolve())
