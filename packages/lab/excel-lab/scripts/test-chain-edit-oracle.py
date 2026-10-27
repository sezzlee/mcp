import importlib.util
import pathlib
import shutil
import sys
import tempfile
import unittest
import zipfile

sys.dont_write_bytecode = True

HERE = pathlib.Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


WB = load('chain_workbook', 'chain_workbook.py')
CHECKS = load('chain_edit_checks', 'chain_edit_checks.py').CHECKS

MONTHS = [['Month', 'Amount'], ['Jan', 1100], ['Feb', 1180], ['Mar', 1520], ['Apr', 1340], ['May', 1210], ['Jun', 1290]]
SDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'


def sales(rows, changes=None):
    rows = [list(row) for row in rows]
    for (row, column), value in (changes or {}).items():
        rows[row][column] = value
    return {'Sales': rows + [['Total', f'=SUM(B2:B{len(rows)})']]}


def validations(*rules):
    body = ''.join(
        f'<dataValidation type="{kind}" sqref="{sqref}"' + (' operator="between"' if kind == 'whole' else '') + f'><formula1>{formula}</formula1></dataValidation>'
        for kind, sqref, formula in rules
    )
    return f'<dataValidations count="{len(rules)}">{body}</dataValidations>'


def rules(*items):
    return ''.join(
        f'<conditionalFormatting sqref="B2:B5"><cfRule type="cellIs" priority="{priority}" operator="{operator}"><formula>{formula}</formula></cfRule></conditionalFormatting>'
        for priority, operator, formula in items
    )


def with_pictures(path, names):
    temporary = path.with_suffix('.tmp')
    shutil.move(path, temporary)
    pictures = ''.join(
        f'<xdr:oneCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>{index}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="1" cy="1"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="{index + 2}" name="{name}"/><xdr:cNvPicPr/></xdr:nvPicPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>'
        for index, name in enumerate(names)
    )
    with zipfile.ZipFile(temporary) as original, zipfile.ZipFile(path, 'w') as archive:
        for item in original.namelist():
            content = original.read(item)
            if item == 'xl/worksheets/sheet1.xml':
                content = content.replace(b'</worksheet>', b'<drawing r:id="d1"/></worksheet>')
            archive.writestr(item, content)
        archive.writestr('xl/worksheets/_rels/sheet1.xml.rels', f'<Relationships xmlns="{WB.PACKAGE_REL}"><Relationship Id="d1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>')
        archive.writestr('xl/drawings/drawing1.xml', f'<xdr:wsDr xmlns:xdr="{SDR}">{pictures}</xdr:wsDr>')
    temporary.unlink()


class ChainEditOracleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def book(self, name, sheets, **options):
        path = self.root / f'{name}.xlsx'
        WB.build(path, sheets, **options)
        return path

    def judge(self, scenario, source, good, bad):
        self.assertIsInstance(CHECKS[scenario](source, good, {}), dict)
        with self.assertRaises(AssertionError):
            CHECKS[scenario](source, bad, {})

    def test_version_edit(self):
        source = self.book('source', sales(MONTHS))
        good = self.book('good', sales(MONTHS, {(3, 1): 1250}))
        collateral = self.book('bad', sales(MONTHS, {(3, 1): 1250, (2, 1): 1}))
        self.judge('version-edit', source, good, collateral)
        with self.assertRaises(AssertionError):
            CHECKS['version-edit'](source, source, {})

    def test_stale_recovery(self):
        newer = MONTHS + [['Jul', 1400]]
        source = self.book('source', sales(newer))
        good = self.book('good', sales(newer, {(3, 1): 1250}))
        older = self.book('older', sales(MONTHS, {(3, 1): 1250}))
        self.judge('stale-recovery', source, good, older)

    def test_validation_remove(self):
        rows = {'Tasks': [['Task', 'Status', 'Hours'], ['Draft', 'Open', 3]]}
        source = self.book('source', rows, extras={'Tasks': validations(('list', 'B2:B20', '"Open,Done"'), ('whole', 'C2:C20', '0'))})
        good = self.book('good', rows, extras={'Tasks': validations(('whole', 'C2:C20', '0'))})
        both = self.book('bad', rows, extras={'Tasks': ''})
        self.judge('validation-remove', source, good, both)

    def test_name_scope(self):
        sheets = {'Q1': [['Rate', 0.1], ['Revised rate', 0.12]], 'Q2': [['Rate', 0.2], ['Revised rate', 0.25]]}
        names = lambda q1, q2: [
            {'name': 'Rate', 'scope': 'Q1', 'text': q1},
            {'name': 'Rate', 'scope': 'Q2', 'text': q2},
            {'name': 'Target', 'text': "'Q1'!$B$2:$B$2"},
        ]
        source = self.book('source', sheets, defined_names=names("'Q1'!$B$1:$B$1", "'Q2'!$B$1:$B$1"))
        good = self.book('good', sheets, defined_names=names("'Q1'!$B$1:$B$1", "'Q2'!$B$2"))
        wrong = self.book('bad', sheets, defined_names=names("'Q1'!$B$2", "'Q2'!$B$1:$B$1"))
        self.judge('name-scope', source, good, wrong)

    def test_image_remove(self):
        sheets = {'Cover': [['Quarterly report']]}
        source = self.book('source', sheets)
        with_pictures(source, ['Logo', 'Signature'])
        good = self.book('good', sheets)
        with_pictures(good, ['Logo'])
        wrong = self.book('bad', sheets)
        with_pictures(wrong, ['Signature'])
        self.judge('image-remove', source, good, wrong)

    def test_cf_priority(self):
        rows = {'Balance': [['Account', 'Balance'], ['Cash', 1250], ['Payables', -310]]}
        source = self.book('source', rows, extras={'Balance': rules((1, 'greaterThan', '1000'), (2, 'lessThan', '0'))})
        good = self.book('good', rows, extras={'Balance': rules((1, 'greaterThan', '1000'))})
        wrong = self.book('bad', rows, extras={'Balance': rules((1, 'lessThan', '0'))})
        self.judge('cf-priority', source, good, wrong)

    def test_expected_version(self):
        source = self.book('source', sales(MONTHS))
        good = self.book('good', sales(MONTHS, {(4, 1): 980}))
        collateral = self.book('bad', sales(MONTHS, {(4, 1): 980, (5, 1): 0}))
        self.judge('expected-version', source, good, collateral)


if __name__ == '__main__':
    unittest.main()
