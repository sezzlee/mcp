import { parseArgs } from "node:util";
import {
  generateResultScenario,
  runResultScenario,
} from "./result-scenario.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    root: { type: "string" },
    scenario: { type: "string" },
  },
  strict: true,
});
if (values.out === undefined)
  throw new Error(
    "Pass --out <external directory> for the fixture and reports.",
  );
if ((values.root === undefined) !== (values.scenario === undefined))
  throw new Error(
    "Pass both --root <workbook directory> and --scenario <JSON path> to run your own scenario.",
  );
const selected =
  values.root === undefined || values.scenario === undefined
    ? await generateResultScenario(values.out)
    : { root: values.root, scenario: values.scenario };
process.stdout.write(`${JSON.stringify(selected)}\n`);
const report = await runResultScenario({ ...selected, outRoot: values.out });
process.stdout.write(`${JSON.stringify(report)}\n`);
