import importlib.util
import pathlib
import sys


def _workbook_module():
    if 'chain_workbook' in sys.modules:
        return sys.modules['chain_workbook']
    path = pathlib.Path(__file__).resolve().with_name('chain_workbook.py')
    spec = importlib.util.spec_from_file_location('chain_workbook', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules['chain_workbook'] = module
    spec.loader.exec_module(module)
    return module


wb = _workbook_module()


def _open(source, output):
    assert output is not None, 'no output'
    return wb.Workbook(source), wb.Workbook(output)


def _same_except(before, after, sheet, changed):
    expected = dict(before.values(sheet))
    expected.update(changed)
    actual = after.values(sheet)
    assert actual == expected, ('values', sheet, sorted(set(actual.items()) ^ set(expected.items())))
    assert {k: wb.normalized(v) for k, v in after.formulas(sheet).items()} == {
        k: wb.normalized(v) for k, v in before.formulas(sheet).items()
    }, ('formulas', sheet)


def version_edit(source, output, extra):
    before, after = _open(source, output)
    _same_except(before, after, 'Sales', {'B4': 1250})
    assert after.order == before.order, 'sheets changed'
    return {'cells': len(after.values('Sales'))}


def stale_recovery(source, output, extra):
    before, after = _open(source, output)
    assert before.values('Sales').get('A8') == 'Jul', 'source is not the newer workbook'
    _same_except(before, after, 'Sales', {'B4': 1250})
    assert after.values('Sales')['A8'] == 'Jul' and after.values('Sales')['B8'] == 1400, 'edit lost the newer rows'
    return {'cells': len(after.values('Sales'))}


def validation_remove(source, output, extra):
    before, after = _open(source, output)
    _same_except(before, after, 'Tasks', {})
    kept = [rule for rule in before.validations('Tasks') if rule['type'] != 'list']
    assert len(kept) < len(before.validations('Tasks')), 'source has no list validation'
    assert after.validations('Tasks') == kept, ('validations', after.validations('Tasks'))
    return {'validations': len(kept)}


def _reference(text):
    target = wb.normalized(text).replace("'", '')
    sheet, _, area = target.rpartition('!')
    start, _, end = area.partition(':')
    return f'{sheet}!{start}' if end in ('', start) else target


def _names(book):
    return sorted((entry['name'], entry['scope'] or '', _reference(entry['text'])) for entry in book.defined_names())


def name_scope(source, output, extra):
    before, after = _open(source, output)
    for sheet in before.order:
        _same_except(before, after, sheet, {})
    expected = [
        (name, scope, 'Q2!B2' if (name, scope) == ('Rate', 'Q2') else text)
        for name, scope, text in _names(before)
    ]
    assert ('Rate', 'Q2', 'Q2!B1') in _names(before), ('source names', _names(before))
    assert _names(after) == sorted(expected), ('names', _names(after))
    return {'names': len(expected)}


def image_remove(source, output, extra):
    before, after = _open(source, output)
    _same_except(before, after, 'Cover', {})
    assert sorted(before.pictures('Cover')) == ['Logo', 'Signature'], before.pictures('Cover')
    assert after.pictures('Cover') == ['Logo'], ('pictures', after.pictures('Cover'))
    return {'pictures': 1}


def cf_priority(source, output, extra):
    before, after = _open(source, output)
    _same_except(before, after, 'Balance', {})
    def shape(rule):
        return (rule['ranges'], rule['type'], wb.normalized(rule['formula']))
    rules = before.conditional_formats('Balance')
    negative = [rule for rule in rules if wb.normalized(rule['formula']) == '0']
    assert len(negative) == 1, ('source rules', rules)
    kept = sorted(shape(rule) for rule in rules if rule is not negative[0])
    assert sorted(shape(rule) for rule in after.conditional_formats('Balance')) == kept, (
        'rules', after.conditional_formats('Balance'))
    return {'rules': len(kept)}


def expected_version(source, output, extra):
    before, after = _open(source, output)
    _same_except(before, after, 'Sales', {'B5': 980})
    return {'cells': len(after.values('Sales'))}


CHECKS = {
    'version-edit': version_edit,
    'stale-recovery': stale_recovery,
    'validation-remove': validation_remove,
    'name-scope': name_scope,
    'image-remove': image_remove,
    'cf-priority': cf_priority,
    'expected-version': expected_version,
}
