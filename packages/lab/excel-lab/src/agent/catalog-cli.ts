import { parseArgs } from "node:util";
import { coverageOf, readCatalog } from "./task.ts";
import { buildWorkspace } from "./workspace.ts";

const { values } = parseArgs({
  options: {
    coverage: { type: "boolean" },
    workspace: { type: "string" },
    corpus: { type: "string" },
  },
  strict: true,
});
const catalog = await readCatalog();
if (values.workspace !== undefined) {
  const corpusRoot = values.corpus ?? process.env["SEZZLEE_CORPUS"];
  if (corpusRoot === undefined)
    throw new Error(
      "Pass --corpus <root> or set SEZZLEE_CORPUS to build a workspace.",
    );
  const workspace = await buildWorkspace({
    catalog,
    corpusRoot,
    outRoot: values.workspace,
  });
  process.stdout.write(`${JSON.stringify({ workspace })}\n`);
}
if (values.coverage === true || values.workspace === undefined)
  process.stdout.write(`${JSON.stringify(coverageOf(catalog), null, 1)}\n`);
