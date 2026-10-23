import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemasDir = path.resolve(here, "../spec/schemas");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const ajv = new Ajv2020.default({ allErrors: true, strict: true });
addFormats.default(ajv);
ajv.addSchema(readJson(path.join(schemasDir, "protocol-revision.schema.json")));
ajv.addSchema(
  readJson(path.join(schemasDir, "endpoint-descriptor.schema.json")),
);
ajv.addSchema(readJson(path.join(schemasDir, "tool-definition.schema.json")));
ajv.addSchema(readJson(path.join(schemasDir, "invoke-result.schema.json")));
ajv.addSchema(readJson(path.join(schemasDir, "result-reading.schema.json")));
ajv.addSchema(readJson(path.join(schemasDir, "type-shape.schema.json")));
ajv.addSchema(readJson(path.join(schemasDir, "openapi-extension.schema.json")));
const validate = ajv.compile(
  readJson(path.join(schemasDir, "fixture.schema.json")),
);

let checked = 0;
let failed = 0;

const expectedKinds = [
  "argument-mapping",
  "card",
  "detail",
  "error-mapping",
  "metadata-extraction",
  "naming",
  "openapi-ingestion",
  "ranked-search",
  "result-reading",
  "schema-simplification",
  "search",
  "selection",
  "visibility",
];

/**
 * The kind list is derived from disk and compared with `expectedKinds` in both directions: a
 * hardcoded list alone let a whole directory stop being validated the moment it was renamed, and
 * the previous `catch { continue }` swallowed exactly that. A new kind must be declared here, and
 * a declared kind must exist.
 */
const presentKinds = readdirSync(here, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      entry.name !== "node_modules",
  )
  .map((entry) => entry.name)
  .sort();

for (const kind of expectedKinds) {
  if (!presentKinds.includes(kind)) {
    console.error(`FAIL missing fixture directory: ${kind}`);
    failed += 1;
  }
}
for (const kind of presentKinds) {
  if (!expectedKinds.includes(kind)) {
    console.error(`FAIL undeclared fixture directory: ${kind}`);
    failed += 1;
  }
}

for (const dir of expectedKinds.filter((kind) => presentKinds.includes(kind))) {
  const files = readdirSync(path.join(here, dir)).filter((f) =>
    f.endsWith(".json"),
  );
  if (files.length === 0) {
    console.error(`FAIL empty fixture directory: ${dir}`);
    failed += 1;
  }
  for (const file of files) {
    const rel = path.join(dir, file);
    checked += 1;
    const fixture = readJson(path.join(here, rel));
    if (!validate(fixture)) {
      failed += 1;
      console.error(`FAIL ${rel}`);
      for (const err of validate.errors ?? []) {
        console.error(`  ${err.instancePath || "/"} ${err.message}`);
      }
      continue;
    }
    for (const problem of [
      ...bodyProblems(fixture),
      ...familyProblems(fixture),
    ]) {
      failed += 1;
      console.error(`FAIL ${rel}\n  ${problem}`);
    }
  }
}

/**
 * The body rules the schema cannot say: one body expectation per fixture, the one that matches the
 * template's media type, and form fields that name exactly the body's properties. A fixture that
 * broke one would pin a combination the composer can never produce, and pass or fail for the
 * wrong reason.
 */
function bodyProblems(fixture) {
  if (fixture.kind !== "argument-mapping") {
    return [];
  }
  const problems = [];
  const template = fixture.input.template;
  const contentType = template.contentType ?? "application/json";
  const expected = fixture.expected;
  const bodies = ["bodyJson", "bodyText", "bodyForm", "bodyParts"].filter(
    (key) => key in expected,
  );
  if (bodies.length > 1) {
    problems.push(`expects more than one body: ${bodies.join(", ")}`);
  }
  const wanted =
    contentType === "multipart/form-data"
      ? "bodyParts"
      : contentType === "application/x-www-form-urlencoded"
        ? "bodyForm"
        : contentType === "text/plain"
          ? "bodyText"
          : "bodyJson";
  if (bodies.length === 1 && bodies[0] !== wanted) {
    problems.push(
      `a ${contentType} body is expected as ${wanted}, not ${bodies[0]}`,
    );
  }
  if ("contentType" in expected && expected.contentType !== contentType) {
    problems.push(
      `expected contentType ${expected.contentType} differs from the template's ${contentType}`,
    );
  }
  if (template.form !== undefined && template.bodyRoot === undefined) {
    const fields = template.form.fields.map((field) => field.name).sort();
    const properties = [...(template.body?.properties ?? [])].sort();
    if (JSON.stringify(fields) !== JSON.stringify(properties)) {
      problems.push("form fields do not name body.properties");
    }
  }
  return problems;
}

/**
 * The family rules a success fixture could otherwise contradict: one tool per member, no tool that
 * still exposes the dispatch parameter, and every member writing its own distinct key. A fixture
 * that pinned a success breaking one would teach an implementation to publish the dispatcher.
 */
function familyProblems(fixture) {
  if (
    fixture.kind !== "metadata-extraction" ||
    fixture.input.family === undefined ||
    !("tools" in fixture.expected)
  ) {
    return [];
  }
  const problems = [];
  const operation = fixture.input;
  const parameter = operation.family.parameter;
  const variants = operation.variants ?? [];
  if (fixture.expected.tools.length !== variants.length) {
    problems.push("a family must produce exactly one tool per member");
  }
  for (const tool of fixture.expected.tools) {
    if (Object.hasOwn(tool.inputSchema.properties ?? {}, parameter)) {
      problems.push(`tool '${tool.name}' exposes the dispatch parameter`);
    }
  }
  const keys = new Set();
  for (const variant of variants) {
    const record =
      (variant.arguments ?? []).find((a) => a.name === parameter) ??
      (operation.arguments ?? []).find((a) => a.name === parameter);
    if (record?.hidden?.kind !== "constant") {
      problems.push(`member '${variant.name}' does not hide its key`);
      continue;
    }
    const key = JSON.stringify(record.hidden.value);
    if (keys.has(key)) {
      problems.push(`member '${variant.name}' repeats key ${key}`);
    }
    keys.add(key);
  }
  return problems;
}

console.log(`${checked} fixture(s) checked, ${failed} failed`);
if (failed > 0 || checked === 0) process.exit(1);
