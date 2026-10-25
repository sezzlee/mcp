import JSZip from "jszip";

const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const office =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rel = "http://schemas.openxmlformats.org/package/2006/relationships";
const types = "http://schemas.openxmlformats.org/package/2006/content-types";

export async function preservationWorkbook(
  dependencies = false,
): Promise<Buffer> {
  const zip = new JSZip();
  const parts: Record<string, string> = {
    "[Content_Types].xml": `<Types xmlns="${types}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${[1, 2, 3].map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}${dependencies ? '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ""}</Types>`,
    "_rels/.rels": `<Relationships xmlns="${rel}"><Relationship Id="book" Type="${office}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<workbook xmlns="${main}" xmlns:r="${office}"><workbookPr date1904="0"/><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="Data" sheetId="1" r:id="s1"/><sheet name="Other" sheetId="2" r:id="s2"/><sheet name="Notes" sheetId="3" r:id="s3"/></sheets><definedNames><definedName name="Amounts">Data!$B$2:$B$3</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$E$5</definedName></definedNames></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="${rel}">${[1, 2, 3].map((i) => `<Relationship Id="s${i}" Type="${office}/worksheet" Target="worksheets/sheet${i}.xml"/>`).join("")}<Relationship Id="style" Type="${office}/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<styleSheet xmlns="${main}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFF0000"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="2" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="${main}" xmlns:r="${office}"><dimension ref="A1:E5"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c><c r="C1" t="inlineStr"><is><t>Total</t></is></c><c r="E1"><v>2</v></c></row><row r="2" ht="24" customHeight="1"><c r="A2" t="inlineStr"><is><t>One</t></is></c><c r="B2" s="1"><v>10</v></c><c r="C2" s="1"><f>B2*$E$1+Other!A1</f><v>25</v></c></row><row r="3" hidden="1"><c r="A3" t="inlineStr"><is><t>Two</t></is></c><c r="B3" s="1"><v>20</v></c><c r="C3"><f>SUM(B2:B3)</f><v>30</v></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>Unrelated note</t></is></c></row></sheetData><conditionalFormatting sqref="B2:B3"><cfRule type="expression" priority="1"><formula>B2&gt;15</formula></cfRule></conditionalFormatting><dataValidations count="1"><dataValidation type="whole" sqref="B2:B3"><formula1>1</formula1><formula2>100</formula2></dataValidation></dataValidations>${dependencies ? '<drawing r:id="draw"/><tableParts count="1"><tablePart r:id="table"/></tableParts>' : ""}</worksheet>`,
    "xl/worksheets/sheet2.xml": `<worksheet xmlns="${main}"><sheetData><row r="1"><c r="A1"><v>5</v></c><c r="B1"><f>Data!B2+Data!$C$3</f><v>40</v></c></row></sheetData></worksheet>`,
    "xl/worksheets/sheet3.xml": `<worksheet xmlns="${main}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Keep these exact bytes.</t></is></c></row></sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`,
    "customXml/item1.xml":
      '<unrelated xmlns="urn:independent"><value literal="&amp;">Keep me exactly.</value><!-- retained comment --></unrelated>',
  };
  if (dependencies)
    Object.assign(parts, {
      "xl/worksheets/_rels/sheet1.xml.rels": `<Relationships xmlns="${rel}"><Relationship Id="table" Type="${office}/table" Target="../tables/table1.xml"/><Relationship Id="draw" Type="${office}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
      "xl/tables/table1.xml": `<table xmlns="${main}" id="1" name="Items" displayName="Items" ref="A1:C3" totalsRowShown="0"><autoFilter ref="A1:C3"/><tableColumns count="3"><tableColumn id="1" name="Item"/><tableColumn id="2" name="Amount"/><tableColumn id="3" name="Total"/></tableColumns></table>`,
      "xl/drawings/drawing1.xml": `<xdr:wsDr xmlns:xdr="${namespacesDrawing()}"><xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" x="0" y="0"/><a:ext xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" cx="0" cy="0"/></xdr:xfrm><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${office}" r:id="chart"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`,
      "xl/drawings/_rels/drawing1.xml.rels": `<Relationships xmlns="${rel}"><Relationship Id="chart" Type="${office}/chart" Target="../charts/chart1.xml"/></Relationships>`,
      "xl/charts/chart1.xml":
        '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numRef><c:f>Data!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart></c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>',
    });
  for (const [name, xml] of Object.entries(parts)) zip.file(name, xml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function namespacesDrawing(): string {
  return "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
}
