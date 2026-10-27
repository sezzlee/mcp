import importlib.util
import pathlib
import re
import sys


def workbook_module():
    if 'chain_workbook' in sys.modules:
        return sys.modules['chain_workbook']
    path = pathlib.Path(__file__).resolve().with_name('chain_workbook.py')
    spec = importlib.util.spec_from_file_location('chain_workbook', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules['chain_workbook'] = module
    spec.loader.exec_module(module)
    return module


wb = workbook_module()


def split(reference):
    match = re.fullmatch(r'([A-Z]+)([0-9]+)', reference)
    letters, row = match.groups()
    column = 0
    for letter in letters:
        column = column * 26 + ord(letter) - 64
    return int(row), column


def rows(values):
    grid = {}
    for reference, value in values.items():
        row, column = split(reference)
        grid.setdefault(row, {})[column] = value
    if not grid:
        return []
    width = max(max(columns) for columns in grid.values())
    return [[grid.get(row, {}).get(column) for column in range(1, width + 1)] for row in range(1, max(grid) + 1)]


def opened(path):
    assert path is not None, 'no output'
    return wb.Workbook(path)


def restructure(source, output, extra):
    book = opened(output)
    assert book.order == ['Supplies'], ('sheet names', book.order)
    assert book.values('Supplies') == {
        'A1': 'Item', 'B1': 'Amount',
        'A2': 'Pens', 'B2': 10,
        'A3': 'Paper', 'B3': 20,
        'A4': 'Ink', 'B4': 15,
        'A5': 'Staples', 'B5': 12,
        'A6': 'Tape', 'B6': 8,
        'A7': 'Total',
    }, ('layout', book.values('Supplies'))
    formulas = {key: wb.normalized(value) for key, value in book.formulas('Supplies').items()}
    assert formulas == {'B7': 'SUM(B2:B6)'}, ('total formula', formulas)
    return {'cells': 13}


def insert_formulas(source, output, extra):
    book = opened(output)
    assert book.order == ['Orders'], ('sheet names', book.order)
    expected = {'A1': 'Item', 'B1': 'Qty', 'C1': 'Price', 'D1': 'Amount', 'A7': 'Total'}
    for row, (item, quantity, price) in enumerate(
        [('Desk', 2, 150), ('Chair', 4, 80), ('Lamp', 3, 40), ('Shelf', 1, 120), ('Rug', 2, 60)], 2
    ):
        expected.update({f'A{row}': item, f'B{row}': quantity, f'C{row}': price})
    assert book.values('Orders') == expected, ('values', book.values('Orders'))
    formulas = {key: wb.normalized(value) for key, value in book.formulas('Orders').items()}
    wanted = {f'D{row}': f'B{row}*C{row}' for row in range(2, 7)}
    wanted['D7'] = 'SUM(D2:D6)'
    assert formulas == wanted, ('formulas', formulas)
    return {'formulas': len(wanted)}


def summary_formulas(source, output, extra):
    original = opened(source)
    book = opened(output)
    assert book.values('Sales') == original.values('Sales'), 'sales data changed'
    assert 'Summary' in book.order, ('no Summary sheet', book.order)
    cells = book.cells('Summary')
    labels = {}
    for reference, cell in cells.items():
        if cell['formula'] is None and isinstance(cell['value'], str):
            labels[cell['value'].strip().casefold()] = split(reference)
    linked = {}
    for label in ('food', 'toys', 'books', 'total'):
        assert label in labels, ('missing label', label, sorted(labels))
        row, column = labels[label]
        found = [
            wb.normalized(cell['formula'])
            for reference, cell in cells.items()
            if split(reference)[0] == row and split(reference)[1] > column and cell['formula'] is not None
        ]
        assert len(found) == 1, ('one formula beside', label, found)
        formula = found[0]
        assert 'SALES!' in formula, ('not linked to Sales', label, formula)
        if label == 'total':
            assert 'SUM' in formula, ('total is not a sum', formula)
        else:
            assert 'SUMIF' in formula, ('category total is not conditional', label, formula)
        linked[label] = formula
    numbers = [
        reference for reference, cell in cells.items()
        if cell['formula'] is None and isinstance(cell['value'], (int, float)) and not isinstance(cell['value'], bool)
    ]
    assert not numbers, ('literal numbers in Summary', numbers)
    return {'linked': linked, 'evaluated': False}


def region_totals(path, sheet):
    totals = {}
    for row in rows(opened(path).values(sheet))[1:]:
        region, amount = row[0], row[2]
        if isinstance(region, str) and isinstance(amount, (int, float)):
            totals[region] = totals.get(region, 0) + amount
    return totals


def grouped_report(source, output, extra):
    expected = region_totals(source, 'Sales')
    book = opened(output)
    found = {}
    for name in book.order:
        for row in rows(book.values(name)):
            texts = [value for value in row if isinstance(value, str) and value in expected]
            numbers = [value for value in row if isinstance(value, (int, float)) and not isinstance(value, bool)]
            if len(texts) == 1 and len(numbers) == 1:
                assert texts[0] not in found, ('region repeated', texts[0])
                found[texts[0]] = numbers[0]
    assert found == expected, ('totals', found, expected)
    return {'regions': len(expected), 'exact': True}


def records_source(source, output, extra):
    table = rows(opened(source).values('Sales'))
    expected = [table[0]] + [row for row in table[1:] if row[0] == 'North']
    book = opened(output)
    assert len(book.order) == 1, ('one sheet expected', book.order)
    assert book.formulas(book.order[0]) == {}, 'formulas in output'
    actual = rows(book.values(book.order[0]))
    assert actual == expected, ('rows', actual, expected)
    return {'rows': len(expected) - 1}


def fixed(path):
    table = rows(opened(path).values('Products'))
    return [[row[0], 20 if row[0] == 'Mouse' else row[1]] for row in table]


def two_files(source, output, extra):
    given = extra['given']
    second = pathlib.Path(given['second'])
    assert wb.digest(second) == given['secondHash'], 'second source changed'
    outputs = [pathlib.Path(path) for path in extra['outputs']]
    matched = []
    for original in (source, second):
        expected = fixed(original)
        assert expected != rows(opened(original).values('Products')), 'source has no wrong price'
        hits = [path for path in outputs if opened(path).order == ['Products'] and rows(opened(path).values('Products')) == expected]
        assert hits, ('no fixed output for', original.name)
        matched.append(hits[-1])
    assert matched[0] != matched[1], 'one output for both files'
    return {'files': 2}


CHECKS = {
    'restructure': restructure,
    'insert-formulas': insert_formulas,
    'summary-formulas': summary_formulas,
    'grouped-report': grouped_report,
    'records-source': records_source,
    'two-files': two_files,
}
