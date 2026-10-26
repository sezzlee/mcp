import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET


spec = importlib.util.spec_from_file_location("authoring_oracle", Path(__file__).with_name("authoring-agent-oracle.py"))
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
P = "http://schemas.openxmlformats.org/package/2006/relationships"


def known_book(result):
    names = ["S", "Calc", "Summary"] if result else ["S"]
    workbook = f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets>' + "".join(f'<sheet name="{name}" sheetId="{i}" r:id="rId{i}"/>' for i, name in enumerate(names, 1)) + '</sheets><calcPr fullCalcOnLoad="1" forceFullCalc="1"/></workbook>'
    parts = {
        "_rels/.rels": f'<Relationships xmlns="{P}"><Relationship Id="office" Type="{R}/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        "xl/workbook.xml": workbook,
        "xl/_rels/workbook.xml.rels": f'<Relationships xmlns="{P}">' + "".join(f'<Relationship Id="rId{i}" Type="{R}/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(names) + 1)) + f'<Relationship Id="styles" Type="{R}/styles" Target="styles.xml"/></Relationships>',
        "xl/styles.xml": f'<styleSheet xmlns="{S}"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><cellXfs count="1"><xf/></cellXfs></styleSheet>',
        "xl/worksheets/sheet1.xml": f'<worksheet xmlns="{S}"><sheetData><row r="1"><c r="A1" t="n"><v>1</v></c></row></sheetData></worksheet>',
    }
    if result:
        parts["xl/worksheets/sheet2.xml"] = f'''<worksheet xmlns="{S}"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Qty</t></is></c><c r="B1" t="inlineStr"><is><t>Price</t></is></c><c r="C1" t="inlineStr"><is><t>Gross</t></is></c><c r="E1" t="inlineStr"><is><t>=1+1</t></is></c><c r="F1" t="n"><v>0.18</v></c></row>
<row r="2"><c r="A2" t="n"><v>2</v></c><c r="B2" t="n"><v>10</v></c><c r="C2"><f>A2*B2*(1+$F$1)</f></c></row>
<row r="3"><c r="A3" t="n"><v>3</v></c><c r="B3" t="n"><v>5</v></c><c r="C3"><f>A3*B3*(1+$F$1)</f></c></row>
</sheetData></worksheet>'''
        parts["xl/worksheets/sheet3.xml"] = f'<worksheet xmlns="{S}"><sheetData><row r="1"><c r="A1"><f>SUM(Calc!C2:C3)</f></c></row></sheetData></worksheet>'
    return parts


class AuthoringOracleTests(unittest.TestCase):
    def check_table(self, calculated="B2*C2"):
        parts=known_book(False)
        workbook=ET.fromstring(parts['xl/workbook.xml'])
        ET.SubElement(workbook.find('{'+S+'}sheets'),'{'+S+'}sheet',{'name':'Sales','sheetId':'2','{'+R+'}id':'sales'})
        parts['xl/workbook.xml']=ET.tostring(workbook,encoding='unicode')
        rels=ET.fromstring(parts['xl/_rels/workbook.xml.rels'])
        ET.SubElement(rels,'{'+P+'}Relationship',{'Id':'sales','Type':R+'/worksheet','Target':'worksheets/sales.xml'})
        parts['xl/_rels/workbook.xml.rels']=ET.tostring(rels,encoding='unicode')
        sheet=ET.Element('{'+S+'}worksheet');data=ET.SubElement(sheet,'{'+S+'}sheetData')
        values=[['Item','Qty','Price','Amount'],['A',2,10],['B',3,5],['C',4,2],['Total']]
        for row,entries in enumerate(values,1):
            node=ET.SubElement(data,'{'+S+'}row',{'r':str(row)})
            for col,value in zip('ABCD',entries):
                cell=ET.SubElement(node,'{'+S+'}c',{'r':col+str(row),'t':'inlineStr' if isinstance(value,str) else 'n'})
                ET.SubElement(ET.SubElement(cell,'{'+S+'}is'),'{'+S+'}t').text=value if isinstance(value,str) else ''
                if not isinstance(value,str):
                    cell.remove(cell.find('{'+S+'}is'));ET.SubElement(cell,'{'+S+'}v').text=str(value)
            if row>=2:
                cell=ET.SubElement(node,'{'+S+'}c',{'r':'D'+str(row)})
                ET.SubElement(cell,'{'+S+'}f').text=f'B{row}*C{row}' if row<5 else 'SUBTOTAL(109,SalesData[Amount])'
            if row==1:
                cell=ET.SubElement(node,'{'+S+'}c',{'r':'F1'});ET.SubElement(cell,'{'+S+'}f').text='SUM(SalesData[Amount])'
        ET.SubElement(ET.SubElement(sheet,'{'+S+'}tableParts',{'count':'1'}),'{'+S+'}tablePart',{'{'+R+'}id':'table'})
        parts['xl/worksheets/sales.xml']=ET.tostring(sheet,encoding='unicode')
        parts['xl/worksheets/_rels/sales.xml.rels']=f'<Relationships xmlns="{P}"><Relationship Id="table" Type="{R}/table" Target="../tables/table1.xml"/></Relationships>'
        table=ET.Element('{'+S+'}table',{'id':'1','name':'SalesData','displayName':'SalesData','ref':'A1:D5','totalsRowCount':'1'})
        ET.SubElement(table,'{'+S+'}autoFilter',{'ref':'A1:D4'});columns=ET.SubElement(table,'{'+S+'}tableColumns',{'count':'4'})
        for index,name in enumerate(['Item','Qty','Price','Amount'],1):
            column=ET.SubElement(columns,'{'+S+'}tableColumn',{'id':str(index),'name':name})
            if index==4 and calculated is not None:
                ET.SubElement(column,'{'+S+'}calculatedColumnFormula').text=calculated
        parts['xl/tables/table1.xml']=ET.tostring(table,encoding='unicode')
        with tempfile.TemporaryDirectory() as root:
            source,output=Path(root)/'source.xlsx',Path(root)/'output.xlsx'
            for path,contents in [(source,known_book(False)),(output,parts)]:
                with zipfile.ZipFile(path,'w') as package:
                    for name,body in contents.items():package.writestr(name,body)
            return oracle.verify(source,output,'authoring_table')

    def test_real_calculated_column_accepts_a1_or_structured_metadata(self):
        for formula in ['B2*C2','SalesData[[#This Row],[Qty]]*SalesData[[#This Row],[Price]]']:
            self.assertEqual(self.check_table(formula)['status'],'passed')

    def test_filled_cells_without_calculated_column_metadata_are_rejected(self):
        with self.assertRaisesRegex(AssertionError,'calculated column metadata'):
            self.check_table(None)

    def test_wrong_calculated_column_metadata_is_rejected(self):
        with self.assertRaisesRegex(AssertionError,'D2'):
            self.check_table('B2*C3')

    def check_format(self, currency='0.00 "₺"', blue='1F3864'):
        parts=known_book(False)
        parts['xl/workbook.xml']=parts['xl/workbook.xml'].replace('</sheets>', '<sheet name="Expenses" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="1">Expenses!$A$1:$D$3</definedName></definedNames>')
        parts['xl/_rels/workbook.xml.rels']=parts['xl/_rels/workbook.xml.rels'].replace('</Relationships>', f'<Relationship Id="rId2" Type="{R}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')
        parts['xl/styles.xml']=f'''<styleSheet xmlns="{S}"><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode='{currency}'/><numFmt numFmtId="166" formatCode="0%"/></numFmts><fonts><font/><font><b/><color rgb="FFFFFFFF"/></font></fonts><fills><fill/><fill><patternFill patternType="solid"><fgColor rgb="FF{blue}"/></patternFill></fill></fills><cellXfs><xf/><xf fontId="1" fillId="1"><alignment wrapText="1"/></xf><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/></cellXfs></styleSheet>'''
        def text(cell,value,style=0):
            return f'<c r="{cell}" s="{style}" t="inlineStr"><is><t>{value}</t></is></c>'
        rows=['<row r="1">'+''.join(text(c+'1',v,1) for c,v in zip('ABCD',['Date','Item','Amount','Rate']))+'</row>']
        for row,date,item,amount,rate in [(2,'2026-01-02','Office',20,0.18),(3,'2026-01-03','Travel',50,0.08)]:
            rows.append(f'<row r="{row}"><c r="A{row}" s="2" t="d"><v>{date}T00:00:00.000</v></c>'+text('B'+str(row),item)+f'<c r="C{row}" s="3"><v>{amount}</v></c><c r="D{row}" s="4"><v>{rate}</v></c></row>')
        parts['xl/worksheets/sheet2.xml']=f'<worksheet xmlns="{S}"><sheetViews><sheetView workbookViewId="0"><pane state="frozen" ySplit="1"/></sheetView></sheetViews><cols><col min="1" max="4" width="22"/></cols><sheetData>'+''.join(rows)+'</sheetData><pageSetup orientation="landscape" fitToWidth="1"/></worksheet>'
        with tempfile.TemporaryDirectory() as root:
            source,output=Path(root)/'source.xlsx',Path(root)/'output.xlsx'
            for path,contents in [(source,known_book(False)),(output,parts)]:
                with zipfile.ZipFile(path,'w') as package:
                    for name,body in contents.items():
                        package.writestr(name,body)
            return oracle.verify(source,output,'authoring_format')

    def test_currency_symbol_and_another_dark_blue_are_valid(self):
        self.assertEqual(self.check_format()['status'],'passed')

    def test_wrong_currency_precision_or_light_background_is_rejected(self):
        for currency,blue in [('0 "₺"','1F3864'),('0.000 "TRY"','1F3864'),('0.00 "USD"','1F3864'),('0.00 "TRY"','ADD8E6')]:
            with self.subTest(currency=currency,blue=blue),self.assertRaises(AssertionError):
                self.check_format(currency,blue)

    def test_equivalent_table_body_formulas_keep_row_identity(self):
        expected=['SalesData[[#This Row],[Qty]]*SalesData[[#This Row],[Price]]','B3*C3']
        for actual in expected:
            oracle.formula({'cells':{'D3':{'formula':actual,'value':None}}},'D3',expected)
        with self.assertRaises(AssertionError):
            oracle.formula({'cells':{'D3':{'formula':'B2*C2','value':None}}},'D3',expected)

    def check(self, mutate=None):
        with tempfile.TemporaryDirectory() as root:
            source, output = Path(root) / "source.xlsx", Path(root) / "output.xlsx"
            parts = known_book(True)
            if mutate:
                mutate(parts)
            for path, contents in [(source, known_book(False)), (output, parts)]:
                with zipfile.ZipFile(path, "w") as package:
                    for name, body in contents.items():
                        package.writestr(name, body)
            return oracle.verify(source, output, "authoring_formula")

    def test_known_answer_without_fabricated_results(self):
        self.assertEqual(self.check()["status"], "passed")

    def test_wrong_relative_formula_is_rejected(self):
        def corrupt(parts):
            parts["xl/worksheets/sheet2.xml"] = parts["xl/worksheets/sheet2.xml"].replace("A3*B3", "A2*B3")
        with self.assertRaisesRegex(AssertionError, "C3"):
            self.check(corrupt)

    def test_fabricated_cache_is_rejected(self):
        def corrupt(parts):
            parts["xl/worksheets/sheet2.xml"] = parts["xl/worksheets/sheet2.xml"].replace("A3*B3*(1+$F$1)</f>", "A3*B3*(1+$F$1)</f><v>0</v>")
        with self.assertRaisesRegex(AssertionError, "fabricated formula cache"):
            self.check(corrupt)

    def test_changed_original_cell_is_rejected(self):
        def corrupt(parts):
            parts["xl/worksheets/sheet1.xml"] = parts["xl/worksheets/sheet1.xml"].replace("<v>1</v>", "<v>2</v>")
        with self.assertRaisesRegex(AssertionError, "original scalar changed"):
            self.check(corrupt)

    def test_dangling_relationship_is_rejected(self):
        def corrupt(parts):
            parts["xl/_rels/workbook.xml.rels"] = parts["xl/_rels/workbook.xml.rels"].replace("</Relationships>", f'<Relationship Id="missing" Type="{R}/theme" Target="missing.xml"/></Relationships>')
        with self.assertRaisesRegex(AssertionError, "dangling relationship"):
            self.check(corrupt)

    def test_invalid_style_reference_is_rejected(self):
        def corrupt(parts):
            parts["xl/worksheets/sheet2.xml"] = parts["xl/worksheets/sheet2.xml"].replace('r="C2"', 'r="C2" s="99"')
        with self.assertRaisesRegex(AssertionError, "invalid cell format index"):
            self.check(corrupt)


if __name__ == "__main__":
    unittest.main()
