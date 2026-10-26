import importlib.util
import pathlib
import tempfile
import unittest
import zipfile

SCRIPT = pathlib.Path(__file__).with_name('bulk-agent-oracle.py')
SPEC = importlib.util.spec_from_file_location('bulk_agent_oracle', SCRIPT)
ORACLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ORACLE)


class OracleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        ORACLE.prepare(self.root)
        (self.root / 'out').mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def output(self, replacement):
        output = self.root / 'result.xlsx'
        with zipfile.ZipFile(self.root / 'source.xlsx') as original, zipfile.ZipFile(output, 'w') as archive:
            for name in original.namelist():
                content = original.read(name)
                if name == 'xl/worksheets/sheet1.xml':
                    content = replacement(content.decode()).encode()
                archive.writestr(name, content)
        return output

    def test_known_answer(self):
        output = self.output(lambda xml: xml.replace('<v>10</v>', '<v>99</v>').replace('<v>30</v>', '<v>99</v>'))
        self.assertEqual(ORACLE.verify(self.root, 'update', output), {'passed': True, 'scenario': 'update', 'cellsVerified': 12})

    def test_unchanged_output_is_not_an_update(self):
        output = self.output(lambda xml: xml)
        with self.assertRaisesRegex(AssertionError, 'unexpected complete output'):
            ORACLE.verify(self.root, 'update', output)

    def test_numeric_looking_text_does_not_pass_as_a_number(self):
        output = self.output(lambda xml: xml.replace('<c r="C2"><v>10</v></c>', '<c r="C2" t="inlineStr"><is><t>99</t></is></c>').replace('<v>30</v>', '<v>99</v>'))
        with self.assertRaisesRegex(AssertionError, 'unexpected complete output'):
            ORACLE.verify(self.root, 'update', output)

    def test_source_mutation_is_rejected(self):
        output = self.output(lambda xml: xml.replace('<v>10</v>', '<v>99</v>').replace('<v>30</v>', '<v>99</v>'))
        (self.root / 'right.csv').write_text('changed')
        with self.assertRaisesRegex(AssertionError, 'changed source'):
            ORACLE.verify(self.root, 'update', output)

    def test_protection_refusal_has_no_completed_files(self):
        ORACLE.prepare(self.root, True)
        self.assertEqual(ORACLE.verify(self.root, 'blocked'), {'passed': True, 'scenario': 'blocked'})
        (self.root / 'out' / 'pretend.xlsx').write_text('not a completed report')
        with self.assertRaises(AssertionError):
            ORACLE.verify(self.root, 'blocked')


if __name__ == '__main__':
    unittest.main()
