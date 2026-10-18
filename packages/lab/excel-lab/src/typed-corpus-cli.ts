import { parseArgs } from "node:util";
import {
  generateTypedCorpus,
  typedCorpusOptionsSchema,
  verifyTypedCorpus,
} from "./typed-corpus.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    verify: { type: "string" },
    seed: { type: "string" },
    rows: { type: "string" },
    revision: { type: "string" },
  },
  strict: true,
});
if ((values.out === undefined) === (values.verify === undefined))
  throw new Error(
    "Pass --out <external directory> to generate and verify, or --verify <saved run directory> to replay.",
  );
if (
  values.verify !== undefined &&
  (values.seed !== undefined || values.rows !== undefined)
)
  throw new Error("A saved replay already fixes its seed and row count.");
const options = typedCorpusOptionsSchema.parse({
  ...(values.seed === undefined ? {} : { seed: Number(values.seed) }),
  ...(values.rows === undefined ? {} : { rows: Number(values.rows) }),
});
const root =
  values.verify ?? (await generateTypedCorpus(values.out ?? "", options));
process.stdout.write(`${JSON.stringify({ corpus: root })}\n`);
const report = await verifyTypedCorpus(root, values.revision);
process.stdout.write(`${JSON.stringify(report)}\n`);
