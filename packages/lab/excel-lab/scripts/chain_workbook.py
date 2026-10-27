import hashlib
import posixpath
import re
import zipfile
import xml.etree.ElementTree as ET

MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
M = '{' + MAIN + '}'


def digest(path):
    with open(path, 'rb') as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def text_of(node):
    return ''.join(item.text or '' for item in node.iter(M + 't'))


def unquote(name):
    if name.startswith("'") and name.endswith("'"):
        return name[1:-1].replace("''", "'")
    return name


def normalized(formula):
    return re.sub(r'\s+', '', (formula or '').lstrip('=')).replace('$', '').upper()


class Workbook:
    def __init__(self, path):
        self.archive = zipfile.ZipFile(path)
        assert self.archive.testzip() is None, 'corrupt archive'
        self.names = set(self.archive.namelist())
        self.workbook = ET.fromstring(self.archive.read('xl/workbook.xml'))
        relations = self.relations('xl/workbook.xml')
        self.sheet_parts = {}
        self.order = []
        for sheet in self.workbook.iter(M + 'sheet'):
            target = relations[sheet.attrib['{' + REL + '}id']]
            self.sheet_parts[sheet.attrib['name']] = target
            self.order.append(sheet.attrib['name'])
        self.strings = []
        if 'xl/sharedStrings.xml' in self.names:
            for item in ET.fromstring(self.archive.read('xl/sharedStrings.xml')):
                self.strings.append(text_of(item))

    def close(self):
        self.archive.close()

    def relations(self, part):
        folder, name = posixpath.split(part)
        rels = posixpath.join(folder, '_rels', name + '.rels')
        if rels not in self.names:
            return {}
        result = {}
        for item in ET.fromstring(self.archive.read(rels)):
            if item.attrib.get('TargetMode') == 'External':
                continue
            target = item.attrib['Target']
            result[item.attrib['Id']] = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(folder, target))
        return result

    def sheet(self, name):
        assert name in self.sheet_parts, ('missing sheet', name, self.order)
        return ET.fromstring(self.archive.read(self.sheet_parts[name]))

    def cells(self, name):
        result = {}
        for cell in self.sheet(name).iter(M + 'c'):
            kind = cell.attrib.get('t')
            formula = cell.find(M + 'f')
            value = cell.find(M + 'v')
            if kind == 'inlineStr':
                content = text_of(cell)
            elif kind == 's' and value is not None:
                content = self.strings[int(value.text)]
            elif kind == 'b' and value is not None:
                content = value.text == '1'
            elif kind in ('str', 'e') and value is not None:
                content = value.text
            elif value is not None:
                number = float(value.text)
                content = int(number) if number.is_integer() else number
            else:
                content = None
            if content is None and formula is None:
                continue
            result[cell.attrib['r']] = {
                'value': content,
                'formula': None if formula is None else (formula.text or ''),
                'style': int(cell.attrib.get('s', '0')),
            }
        return result

    def values(self, name):
        return {key: cell['value'] for key, cell in self.cells(name).items() if cell['formula'] is None}

    def formulas(self, name):
        return {key: cell['formula'] for key, cell in self.cells(name).items() if cell['formula'] is not None}

    def defined_names(self):
        result = []
        for item in self.workbook.iter(M + 'definedName'):
            local = item.attrib.get('localSheetId')
            result.append({
                'name': item.attrib['name'],
                'scope': None if local is None else self.order[int(local)],
                'text': item.text or '',
            })
        return result

    def validations(self, name):
        result = []
        for item in self.sheet(name).iter(M + 'dataValidation'):
            formula = item.find(M + 'formula1')
            result.append({
                'ranges': sorted(item.attrib.get('sqref', '').replace('$', '').split()),
                'type': item.attrib.get('type'),
                'formula1': None if formula is None else formula.text,
            })
        return result

    def conditional_formats(self, name):
        result = []
        for block in self.sheet(name).iter(M + 'conditionalFormatting'):
            for rule in block.iter(M + 'cfRule'):
                formula = rule.find(M + 'formula')
                result.append({
                    'ranges': sorted(block.attrib.get('sqref', '').replace('$', '').split()),
                    'priority': int(rule.attrib['priority']),
                    'type': rule.attrib.get('type'),
                    'formula': None if formula is None else formula.text,
                })
        return result

    def pictures(self, name):
        part = self.sheet_parts[name]
        relations = self.relations(part)
        drawing = self.sheet(name).find(M + 'drawing')
        if drawing is None:
            return []
        target = relations[drawing.attrib['{' + REL + '}id']]
        root = ET.fromstring(self.archive.read(target))
        names = []
        for picture in root.iter('{' + DRAWING + '}pic'):
            properties = picture.find('{' + DRAWING + '}nvPicPr/{' + DRAWING + '}cNvPr')
            names.append(properties.attrib.get('name'))
        return names


CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>{sheets}</Types>'


def column_letters(index):
    letters = ''
    while index:
        index, rest = divmod(index - 1, 26)
        letters = chr(65 + rest) + letters
    return letters


def build(path, sheets, defined_names=(), extras=None):
    """Writes a minimal workbook for oracle tests: sheets maps a name to rows of
    plain values, where a string beginning with = is a formula; extras maps a
    sheet name to raw XML appended after sheetData."""
    extras = extras or {}
    with zipfile.ZipFile(path, 'w') as archive:
        overrides = ''.join(
            f'<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            for index in range(1, len(sheets) + 1)
        )
        archive.writestr('[Content_Types].xml', CONTENT_TYPES.format(sheets=overrides))
        archive.writestr('_rels/.rels', f'<Relationships xmlns="{PACKAGE_REL}"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        entries = ''.join(f'<sheet name="{name}" sheetId="{index}" r:id="s{index}"/>' for index, name in enumerate(sheets, 1))
        names = ''.join(
            f'<definedName name="{item["name"]}"' + ('' if item.get('scope') is None else f' localSheetId="{list(sheets).index(item["scope"])}"') + f'>{item["text"]}</definedName>'
            for item in defined_names
        )
        archive.writestr('xl/workbook.xml', f'<workbook xmlns="{MAIN}" xmlns:r="{REL}"><sheets>{entries}</sheets>' + (f'<definedNames>{names}</definedNames>' if names else '') + '</workbook>')
        rels = ''.join(f'<Relationship Id="s{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>' for index in range(1, len(sheets) + 1))
        archive.writestr('xl/_rels/workbook.xml.rels', f'<Relationships xmlns="{PACKAGE_REL}">{rels}</Relationships>')
        for index, (name, rows) in enumerate(sheets.items(), 1):
            body = ''
            for row_index, row in enumerate(rows, 1):
                cells = ''
                for column_index, value in enumerate(row, 1):
                    reference = f'{column_letters(column_index)}{row_index}'
                    if value is None:
                        continue
                    if isinstance(value, str) and value.startswith('='):
                        cells += f'<c r="{reference}"><f>{value[1:]}</f></c>'
                    elif isinstance(value, bool):
                        cells += f'<c r="{reference}" t="b"><v>{int(value)}</v></c>'
                    elif isinstance(value, (int, float)):
                        cells += f'<c r="{reference}"><v>{value}</v></c>'
                    else:
                        cells += f'<c r="{reference}" t="inlineStr"><is><t>{value}</t></is></c>'
                body += f'<row r="{row_index}">{cells}</row>'
            archive.writestr(f'xl/worksheets/sheet{index}.xml', f'<worksheet xmlns="{MAIN}" xmlns:r="{REL}"><sheetData>{body}</sheetData>{extras.get(name, "")}</worksheet>')
