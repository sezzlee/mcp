import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import $RefParser from "@apidevtools/json-schema-ref-parser";
import { compile } from "json-schema-to-typescript";
import { format, resolveConfig } from "prettier";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.resolve(here, "../../spec/schemas");
const outDir = path.resolve(here, "../src/generated");

const schemas = [
  "protocol-revision.schema.json",
  "endpoint-descriptor.schema.json",
  "tool-definition.schema.json",
  "invoke-result.schema.json",
  "result-reading.schema.json",
  "type-shape.schema.json",
  "fixture.schema.json",
  "openapi-extension.schema.json",
];

await mkdir(outDir, { recursive: true });

for (const file of schemas) {
  const schema = await $RefParser.dereference(path.join(schemasDir, file));
  delete schema.$defs;
  const ts = await compile(schema, schema.title, {
    bannerComment: "",
    additionalProperties: false,
  });
  const stripped = ts.replace(/^\s*\/\*\*[\s\S]*?\*\/\n/gm, "");
  const outFile = path.join(outDir, file.replace(".schema.json", ".ts"));
  const options = await resolveConfig(outFile);
  await writeFile(
    outFile,
    await format(stripped, { ...options, filepath: outFile }),
  );
}
