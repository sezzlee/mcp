import importlib.util
import pathlib
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET

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

    def report_output(self,blue='1F3864',bold=True):
        output=self.output(lambda xml:xml.replace('<v>10</v>','<v>99</v>').replace('<v>30</v>','<v>99</v>'))
        with zipfile.ZipFile(output) as package:
            parts={name:package.read(name) for name in package.namelist()}
        sheet=ET.fromstring(parts['xl/worksheets/sheet1.xml'])
        cells={cell.attrib['r']:cell for cell in sheet.iter(ORACLE.MAIN+'c')}
        for coordinate in ['A1','B1','C1']:cells[coordinate].set('s','1')
        for coordinate in ['C2','C3','C4']:cells[coordinate].set('s','2')
        row=sheet.find(ORACLE.MAIN+'sheetData/'+ORACLE.MAIN+'row')
        cell=ET.SubElement(row,ORACLE.MAIN+'c',{'r':'E1'});ET.SubElement(cell,ORACLE.MAIN+'f').text='SUM(C2:C4)'
        parts['xl/worksheets/sheet1.xml']=ET.tostring(sheet,encoding='utf-8')
        ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
        parts['xl/styles.xml']=f'<styleSheet xmlns="{ns}"><fonts count="2"><font/><font><b val="{1 if bold else 0}"/><color rgb="FFFFFFFF"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF{blue}"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" fillId="2"/><xf numFmtId="2"/></cellXfs></styleSheet>'.encode()
        rels=parts['xl/_rels/workbook.xml.rels'].decode().replace('</Relationships>','<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
        parts['xl/_rels/workbook.xml.rels']=rels.encode()
        parts['[Content_Types].xml']=parts['[Content_Types].xml'].decode().replace('</Types>','<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>').encode()
        with zipfile.ZipFile(output,'w') as package:
            for name,value in parts.items():package.writestr(name,value)
        return output

    def test_finished_report_accepts_another_dark_blue(self):
        self.assertEqual(ORACLE.verify(self.root,'report',self.report_output())['passed'],True)

    def test_light_background_is_not_a_dark_header(self):
        with self.assertRaises(AssertionError):ORACLE.verify(self.root,'report',self.report_output(blue='ADD8E6'))

    def test_bold_false_is_not_a_bold_header(self):
        with self.assertRaises(AssertionError):ORACLE.verify(self.root,'report',self.report_output(bold=False))

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

    def test_authored_formula_has_no_fabricated_cache(self):
        output = self.output(lambda xml: xml.replace('</row>', '<c r="E1"><f>SUM(C2:C4)</f></c></row>', 1))
        self.assertEqual(len(ORACLE.cells(output, True)), 12)
        output = self.output(lambda xml: xml.replace('</row>', '<c r="E1"><f>SUM(C2:C4)</f><v>218</v></c></row>', 1))
        with self.assertRaisesRegex(AssertionError, 'fabricated formula cache'):
            ORACLE.cells(output, True)

    def test_incorrect_authored_reference_is_rejected(self):
        output = self.output(lambda xml: xml.replace('</row>', '<c r="E1"><f>SUM(C2:C3)</f></c></row>', 1))
        with self.assertRaises(AssertionError):
            ORACLE.cells(output, True)

    def test_data_only_output_is_not_a_finished_report(self):
        output = self.output(lambda xml: xml.replace('<v>10</v>', '<v>99</v>').replace('<v>30</v>', '<v>99</v>'))
        with self.assertRaises(KeyError):
            ORACLE.verify(self.root, 'report', output)

    def test_protection_refusal_has_no_completed_files(self):
        ORACLE.prepare(self.root, True)
        self.assertEqual(ORACLE.verify(self.root, 'blocked'), {'passed': True, 'scenario': 'blocked'})
        (self.root / 'out' / 'pretend.xlsx').write_text('not a completed report')
        with self.assertRaises(AssertionError):
            ORACLE.verify(self.root, 'blocked')


if __name__ == '__main__':
    unittest.main()
