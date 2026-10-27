import importlib.util
import json
import pathlib
import sys

sys.dont_write_bytecode = True

HERE = pathlib.Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


workbook = load('chain_workbook')
CHECKS = {}
for group in ('chain_edit_checks', 'chain_source_checks'):
    if (HERE / f'{group}.py').exists():
        CHECKS.update(load(group).CHECKS)


def verify(scenario, source, output, extra):
    assert scenario in CHECKS, ('unknown scenario', scenario, sorted(CHECKS))
    report = CHECKS[scenario](source, output, extra) or {}
    return {'passed': True, 'scenario': scenario, **report}


if __name__ == '__main__':
    scenario, source, output, extra = sys.argv[1:5]
    print(json.dumps(verify(
        scenario,
        pathlib.Path(source),
        None if output == '-' else pathlib.Path(output),
        json.loads(extra),
    )))
