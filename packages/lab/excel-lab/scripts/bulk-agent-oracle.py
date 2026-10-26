import hashlib
import json
import pathlib
import sys
import zipfile
import xml.etree.ElementTree as ET

MAIN = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(root, protected=False):
    root.mkdir(parents=True, exist_ok=True)
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    package = 'http://schemas.openxmlformats.org/package/2006/relationships'
    parts = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        '_rels/.rels': f'<Relationships xmlns="{package}"><Relationship Id="rId1" Type="{rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': f'<workbook xmlns="{ns}" xmlns:r="{rel}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="{package}"><Relationship Id="rId1" Type="{rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'customXml/retained.xml': '<retained xmlns="urn:public-synthetic-fixture">unchanged</retained>',
    }
    rows = [
        '<row r="1"><c r="A1" t="inlineStr"><is><t>Id</t></is></c><c r="B1" t="inlineStr"><is><t>Status</t></is></c><c r="C1" t="inlineStr"><is><t>Amount</t></is></c></row>',
        '<row r="2"><c r="A2" t="inlineStr"><is><t>a</t></is></c><c r="B2" t="inlineStr"><is><t>pending</t></is></c><c r="C2"><v>10</v></c></row>',
        '<row r="3"><c r="A3" t="inlineStr"><is><t>b</t></is></c><c r="B3" t="inlineStr"><is><t>done</t></is></c><c r="C3"><v>20</v></c></row>',
        '<row r="4"><c r="A4" t="inlineStr"><is><t>c</t></is></c><c r="B4" t="inlineStr"><is><t>pending</t></is></c><c r="C4"><v>30</v></c></row>',
    ]
    protection = '<sheetProtection sheet="1"/>' if protected else ''
    parts['xl/worksheets/sheet1.xml'] = f'<worksheet xmlns="{ns}"><sheetData>{"".join(rows)}</sheetData>{protection}</worksheet>'
    with zipfile.ZipFile(root / 'source.xlsx', 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, text in parts.items():
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o600 << 16
            archive.writestr(info, text)
    (root / 'right.csv').write_text('Id,Price\nb,200\nc,300\nz,900\n')
    (root / 'replacement.csv').write_text('Id,Status,Amount\na,new,100\nb,new,200\n')
    hashes = {name: digest(root / name) for name in ['source.xlsx', 'right.csv', 'replacement.csv']}
    (root / 'fixture.json').write_text(json.dumps({'kind': 'public_synthetic', 'inputs': hashes}, indent=2))
    return hashes


def cells(path):
    result = {}
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            for item in ET.fromstring(archive.read('xl/sharedStrings.xml')):
                strings.append(''.join(node.text or '' for node in item.iter(MAIN + 't')))
        sheet = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
        for cell in sheet.iter(MAIN + 'c'):
            key, kind = cell.attrib['r'], cell.attrib.get('t')
            assert cell.find(MAIN + 'f') is None
            value = cell.find(MAIN + 'v')
            if kind == 'inlineStr':
                result[key] = ('text', ''.join(node.text or '' for node in cell.iter(MAIN + 't')))
            elif kind == 's':
                result[key] = ('text', strings[int(value.text)])
            elif value is not None:
                assert kind in (None, 'n')
                result[key] = ('number', float(value.text))
    return result


def verify(root, scenario, output=None):
    fixture = json.loads((root / 'fixture.json').read_text())
    for name, expected in fixture['inputs'].items():
        assert digest(root / name) == expected, ('changed source', name)
    if scenario == 'blocked':
        assert output is None
        assert not list((root / 'out').iterdir())
        return {'passed': True, 'scenario': scenario}
    if scenario in ('update', 'retry'):
        expected = [['Id', 'Status', 'Amount'], ['a', 'pending', 99], ['b', 'done', 20], ['c', 'pending', 99]]
    elif scenario == 'replace':
        expected = [['Id', 'Status', 'Amount'], ['a', 'new', 100], ['b', 'new', 200]]
    elif scenario == 'join':
        expected = [['Id', 'Status', 'Price'], ['a', 'pending', None], ['b', 'done', 200], ['c', 'pending', 300]]
    else:
        raise AssertionError(('unknown scenario', scenario))
    wanted = {f'{chr(65+c)}{r+1}': ('text' if isinstance(value, str) else 'number', value) for r, row in enumerate(expected) for c, value in enumerate(row) if value is not None}
    assert cells(output) == wanted, ('unexpected complete output', scenario)
    if scenario != 'join':
        with zipfile.ZipFile(output) as archive, zipfile.ZipFile(root / 'source.xlsx') as original:
            assert archive.read('customXml/retained.xml') == original.read('customXml/retained.xml')
    return {'passed': True, 'scenario': scenario, 'cellsVerified': len(wanted)}


if __name__ == '__main__':
    mode, directory = sys.argv[1:3]
    root = pathlib.Path(directory).resolve()
    if mode == 'prepare':
        print(json.dumps(prepare(root, len(sys.argv) > 3 and sys.argv[3] == 'blocked')))
    else:
        output = root / sys.argv[4] if len(sys.argv) > 4 else None
        print(json.dumps(verify(root, sys.argv[3], output)))
