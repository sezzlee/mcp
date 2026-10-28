import sys
import importlib.util
import pathlib
import tempfile
import unittest

sys.dont_write_bytecode = True

HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('chain_source_checks', HERE / 'chain_source_checks.py')
CHECKS_MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKS_MODULE)
CHECKS = CHECKS_MODULE.CHECKS
build = CHECKS_MODULE.wb.build

SALES = [['Category', 'Amount'], ['Food', 10], ['Toys', 20], ['Food', 5], ['Books', 7], ['Toys', 3], ['Food', 2]]
REGIONS = [['Region', 'Item', 'Amount'], ['North', 'Pens', 10], ['South', 'Paper', 12], ['North', 'Ink', 5], ['East', 'Tape', 3], ['South', 'Desk', 8], ['West', 'Lamp', 7]]


class ChainSourceOracleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.count = 0

    def tearDown(self):
        self.temporary.cleanup()

    def book(self, sheets, extras=None):
        self.count += 1
        path = self.root / f'book{self.count}.xlsx'
        build(path, sheets, extras=extras)
        return path

    def refused(self, scenario, source, output, extra=None):
        with self.assertRaises(AssertionError):
            CHECKS[scenario](source, output, extra or {'given': None, 'outputs': [str(output)]})

    def accepted(self, scenario, source, output, extra=None):
        return CHECKS[scenario](source, output, extra or {'given': None, 'outputs': [str(output)]})

    def test_restructure(self):
        good = [['Item', 'Amount'], ['Pens', 10], ['Paper', 20], ['Ink', 15], ['Staples', 12], ['Tape', 8], ['Total', '=SUM(B2:B6)']]
        self.assertEqual(self.accepted('restructure', None, self.book({'Supplies': good})), {'cells': 13})
        self.refused('restructure', None, self.book({'Draft': good}))
        self.refused('restructure', None, self.book({'Supplies': good[:6] + [['Total', '=SUM(B2:B5)']]}))
        self.refused('restructure', None, self.book({'Supplies': [good[0], good[1], good[2], ['Fax toner', 5]] + good[3:]}))

    def test_insert_formulas(self):
        good = [['Item', 'Qty', 'Price', 'Amount']]
        for row, (item, quantity, price) in enumerate([('Desk', 2, 150), ('Chair', 4, 80), ('Lamp', 3, 40), ('Shelf', 1, 120), ('Rug', 2, 60)], 2):
            good.append([item, quantity, price, f'=B{row}*C{row}'])
        good.append(['Total', None, None, '=SUM(D2:D6)'])
        self.assertEqual(self.accepted('insert-formulas', None, self.book({'Orders': good})), {'formulas': 6})
        stale = good[:6] + [['Total', None, None, '=SUM(D2:D3)']]
        self.refused('insert-formulas', None, self.book({'Orders': stale}))
        literal = [row[:] for row in good]
        literal[3][3] = 120
        self.refused('insert-formulas', None, self.book({'Orders': literal}))

    def test_summary_formulas(self):
        source = self.book({'Sales': SALES})
        summary = [['Category', 'Amount']] + [
            [label, f'=SUMIF(Sales!A2:A7,A{row},Sales!B2:B7)'] for row, label in enumerate(['Food', 'Toys', 'Books'], 2)
        ] + [['Total', '=SUM(Sales!B2:B7)']]
        report = self.accepted('summary-formulas', source, self.book({'Sales': SALES, 'Summary': summary}))
        self.assertEqual(report['evaluated'], False)
        literal = summary[:1] + [['Food', 17]] + summary[2:]
        self.refused('summary-formulas', source, self.book({'Sales': SALES, 'Summary': literal}))
        changed = [row[:] for row in SALES]
        changed[1][1] = 11
        self.refused('summary-formulas', source, self.book({'Sales': changed, 'Summary': summary}))

    def test_summary_total_over_category_cells(self):
        source = self.book({'Sales': SALES})
        categories = [
            [label, f'=SUMIF(Sales!$A$2:$A$1000,$A{row},Sales!$B$2:$B$1000)'] for row, label in enumerate(['Food', 'Toys', 'Books'], 2)
        ]
        summary = [['Category', 'Total']] + categories + [['Grand Total', '=SUM(B2:B4)']]
        self.accepted('summary-formulas', source, self.book({'Sales': SALES, 'Summary': summary}))
        self.refused('summary-formulas', source, self.book({'Sales': SALES, 'Summary': summary[:4] + [['Grand Total', '=SUM(B2:B3)']]}))
        self.refused('summary-formulas', source, self.book({'Sales': SALES, 'Summary': summary + [['Toplam', '=SUM(B2:B4)']]}))

    def test_grouped_report(self):
        source = self.book({'Sales': REGIONS})
        good = [['Region', 'Amount'], ['East', 3], ['North', 15], ['South', 20], ['West', 7]]
        self.assertEqual(self.accepted('grouped-report', source, self.book({'Totals': good})), {'regions': 4, 'exact': True})
        self.refused('grouped-report', source, self.book({'Totals': good[:2] + [['North', 14]] + good[3:]}))
        self.refused('grouped-report', source, self.book({'Totals': good[:4]}))

    def test_records_source(self):
        source = self.book({'Sales': REGIONS})
        good = [REGIONS[0], REGIONS[1], REGIONS[3]]
        self.assertEqual(self.accepted('records-source', source, self.book({'North': good})), {'rows': 2})
        self.refused('records-source', source, self.book({'North': [REGIONS[0], REGIONS[3], REGIONS[1]]}))
        self.refused('records-source', source, self.book({'North': [REGIONS[0], ['North', 'Pens', '10'], REGIONS[3]]}))

    def test_two_files(self):
        first_rows = [['Item', 'Price'], ['Keyboard', 45], ['Mouse', 25], ['Cable', 5]]
        second_rows = first_rows + [['Stand', 30]]
        first = self.book({'Products': first_rows})
        second = self.book({'Products': second_rows})
        fixed_first = self.book({'Products': [row if row[0] != 'Mouse' else ['Mouse', 20] for row in first_rows]})
        fixed_second = self.book({'Products': [row if row[0] != 'Mouse' else ['Mouse', 20] for row in second_rows]})
        given = {'second': str(second), 'secondHash': CHECKS_MODULE.wb.digest(second)}
        extra = {'given': given, 'outputs': [str(fixed_first), str(fixed_second)]}
        self.assertEqual(self.accepted('two-files', first, fixed_second, extra), {'files': 2})
        self.refused('two-files', first, fixed_first, {'given': given, 'outputs': [str(fixed_first)]})
        broken = self.book({'Products': [row if row[0] != 'Cable' else ['Cable', 6] for row in first_rows]})
        self.refused('two-files', first, fixed_second, {'given': given, 'outputs': [str(broken), str(fixed_second)]})


if __name__ == '__main__':
    unittest.main()
