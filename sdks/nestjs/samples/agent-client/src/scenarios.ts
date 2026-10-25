import type { Client } from "@modelcontextprotocol/client";
import type {
  BackendErrorCode,
  InvokeSuccess,
  MappedError,
  ProviderSuccess,
} from "@sezzlee/core";
import { callTool } from "./mcp.js";

export type ScenarioName =
  | "smoke"
  | "validation-retry"
  | "error-envelope"
  | "upload"
  | "family"
  | "provider";

export interface ScenarioOptions {
  readonly baseUrl?: string;
  readonly tool?: string;
  readonly query?: string;
  readonly argumentsJson: string;
  readonly user?: string;
}

export class SetupFailure extends Error {}
export class AssertionFailure extends Error {}

interface SearchResultItem {
  readonly name: string;
  readonly description: string;
  readonly parameters: string;
  readonly authUncertain?: boolean;
}

interface SearchResponse {
  readonly total: number;
  readonly results: readonly SearchResultItem[];
}

interface InputSchemaProperty {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly oneOf?: readonly unknown[];
}

interface InputSchema {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, InputSchemaProperty>>;
  readonly required?: readonly string[];
}

interface LoadSuccess {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly annotations?: unknown;
  readonly authUncertain?: boolean;
}

interface SdkErrorEnvelope {
  readonly error: string;
  readonly message: string;
  readonly retryable: boolean;
}

type LoadResult = LoadSuccess | MappedError | SdkErrorEnvelope;
type InvokeResult = InvokeSuccess | MappedError | SdkErrorEnvelope;

function isErrorEnvelope(
  value: object,
): value is MappedError | SdkErrorEnvelope {
  return "error" in value;
}

function isBackendMappedError(
  value: MappedError | SdkErrorEnvelope,
): value is MappedError {
  return "status" in value;
}

const leakPatterns: readonly RegExp[] = [
  /(^|\s)at\s+[\w$.<>]+[\s.]*\(/,
  /(^|\s)at\s+\S+:\d+:\d+\)?/,
  /Traceback \(most recent call last\):/,
  /\b\w*Exception\b/,
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError)\b/,
  /[A-Za-z]:\\[^\s"]+/,
  /\\\\[^\s\\]+\\[^\s"]+/,
  /\/(?:Users|home|var|usr|opt|srv|app|src|etc|tmp)\/[^\s"]*/,
  /\.(?:cs|ts|tsx|js|jsx|py|java|rb|go|php|cpp|c|h|kt|swift):(?:line )?\d+/i,
  /\b(?:Server|Data Source|Password|User Id|Uid|Pwd|Initial Catalog)\s*=\s*[^;]+;/i,
  /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|mssql):\/\//i,
  /:\/\/[^/\s:@]+:[^/\s:@]+@/,
  /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
];

const maxForwardableLength = 1000;

function containsLeak(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length > maxForwardableLength) {
    return true;
  }
  return leakPatterns.some((pattern) => pattern.test(normalized));
}

const backendErrorCodes: ReadonlySet<BackendErrorCode> = new Set([
  "validation_failed",
  "bad_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "backend_error",
  "backend_unavailable",
]);

const sdkErrorCodes: ReadonlySet<string> = new Set([
  "unknown_argument",
  "invalid_path_type",
  "missing_path_parameter",
  "header_injection",
  "null_not_allowed",
  "invalid_type",
  "unknown_tool",
  "not_invocable",
  "invalid_file_argument",
  "file_too_large",
  "file_unresolved",
]);

interface ChecklistRow {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
}

function printChecklist(rows: readonly ChecklistRow[]): void {
  const stepWidth = Math.max(4, ...rows.map((row) => row.step.length));
  console.log(`${"step".padEnd(stepWidth)}  ok    detail`);
  for (const row of rows) {
    console.log(
      `${row.step.padEnd(stepWidth)}  ${row.ok ? "ok  " : "fail"}  ${row.detail}`,
    );
  }
}

function parseArguments(argumentsJson: string): Record<string, unknown> {
  return JSON.parse(argumentsJson) as Record<string, unknown>;
}

export async function runSmoke(
  client: Client,
  options: ScenarioOptions,
): Promise<void> {
  const rows: ChecklistRow[] = [];

  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  const expectedMetaTools = ["search_tools", "load_tool", "invoke_tool"];
  rows.push({
    step: "tools/list",
    ok: expectedMetaTools.every((name) => names.has(name)),
    detail: [...names].join(", "),
  });

  const query = options.query ?? "sipariş";
  const search = await callTool<SearchResponse>(client, "search_tools", {
    query,
  });
  rows.push({
    step: `search_tools "${query}"`,
    ok: !search.isError,
    detail: `${search.parsed.results.length}/${search.parsed.total} results`,
  });

  const chosen = options.tool ?? search.parsed.results[0]?.name;
  if (chosen === undefined) {
    printChecklist(rows);
    throw new SetupFailure(`no tool matched query "${query}"`);
  }

  const loaded = await callTool<LoadResult>(client, "load_tool", {
    name: chosen,
  });
  if (loaded.isError || isErrorEnvelope(loaded.parsed)) {
    rows.push({
      step: `load_tool ${chosen}`,
      ok: false,
      detail: JSON.stringify(loaded.parsed),
    });
    printChecklist(rows);
    throw new SetupFailure(`load_tool failed for "${chosen}"`);
  }
  rows.push({
    step: `load_tool ${chosen}`,
    ok: true,
    detail: JSON.stringify(loaded.parsed.inputSchema),
  });

  const invoked = await callTool<InvokeResult | ProviderSuccess>(
    client,
    "invoke_tool",
    {
      name: chosen,
      arguments: fillMissingRequired(
        loaded.parsed.inputSchema,
        parseArguments(options.argumentsJson),
      ),
    },
  );
  let invokedOk = false;
  if (!invoked.isError && !isErrorEnvelope(invoked.parsed)) {
    invokedOk = !("status" in invoked.parsed) || invoked.parsed.status < 400;
  }
  rows.push({
    step: `invoke_tool ${chosen}`,
    ok: invokedOk,
    detail: JSON.stringify(invoked.parsed),
  });

  printChecklist(rows);
  if (!invokedOk) {
    throw new AssertionFailure(`invoke_tool did not succeed for "${chosen}"`);
  }
}

function invalidValueFor(type: string | undefined): unknown {
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  return "";
}

function validValueFor(type: string | undefined): unknown {
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return true;
  return "sample";
}

function fillMissingRequired(
  schema: InputSchema,
  provided: Record<string, unknown>,
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...provided };
  for (const name of schema.required ?? []) {
    if (!(name in args)) {
      args[name] = validValueFor(schema.properties?.[name]?.type);
    }
  }
  return args;
}

function probeFieldNames(schema: InputSchema): readonly string[] {
  const required = schema.required ?? [];
  return required.length > 0 ? required : Object.keys(schema.properties ?? {});
}

function buildInvalidArguments(schema: InputSchema): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const name of probeFieldNames(schema)) {
    args[name] = invalidValueFor(schema.properties?.[name]?.type);
  }
  return args;
}

async function pickValidationTool(
  client: Client,
  results: readonly SearchResultItem[],
  requestedTool: string | undefined,
): Promise<
  { readonly name: string; readonly loaded: LoadSuccess } | undefined
> {
  if (requestedTool !== undefined) {
    const loaded = await callTool<LoadResult>(client, "load_tool", {
      name: requestedTool,
    });
    if (loaded.isError || isErrorEnvelope(loaded.parsed)) {
      return undefined;
    }
    return { name: requestedTool, loaded: loaded.parsed };
  }

  for (const result of results) {
    const loaded = await callTool<LoadResult>(client, "load_tool", {
      name: result.name,
    });
    if (loaded.isError || isErrorEnvelope(loaded.parsed)) {
      continue;
    }
    if (probeFieldNames(loaded.parsed.inputSchema).length > 0) {
      return { name: result.name, loaded: loaded.parsed };
    }
  }
  return undefined;
}

export async function runValidationRetry(
  client: Client,
  options: ScenarioOptions,
): Promise<void> {
  const query = options.query ?? "create order";
  const search = await callTool<SearchResponse>(client, "search_tools", {
    query,
  });
  if (search.isError) {
    throw new SetupFailure(`search_tools failed for query "${query}"`);
  }

  const picked = await pickValidationTool(
    client,
    search.parsed.results,
    options.tool,
  );
  if (picked === undefined) {
    throw new SetupFailure(
      `no tool with required input properties matched query "${query}"`,
    );
  }
  const { name, loaded } = picked;
  const schema = loaded.inputSchema;

  const invalidArguments = buildInvalidArguments(schema);
  const firstInvoke = await callTool<InvokeResult>(client, "invoke_tool", {
    name,
    arguments: invalidArguments,
  });

  if (!firstInvoke.isError) {
    throw new AssertionFailure(
      `invoke_tool with deliberately invalid arguments did not report isError for "${name}"`,
    );
  }
  if (!isErrorEnvelope(firstInvoke.parsed)) {
    throw new AssertionFailure(
      `invoke_tool error result for "${name}" did not parse as an error envelope`,
    );
  }
  if (!isBackendMappedError(firstInvoke.parsed)) {
    throw new AssertionFailure(
      `expected a backend error with status for "${name}", got SDK-side error "${firstInvoke.parsed.error}"`,
    );
  }
  const mappedError = firstInvoke.parsed;
  if (mappedError.error !== "validation_failed") {
    throw new AssertionFailure(
      `expected error "validation_failed" for "${name}", got "${mappedError.error}"`,
    );
  }

  const fields = mappedError.fields ?? [];
  if (fields.length === 0) {
    throw new AssertionFailure(
      `validation_failed error for "${name}" carried no fields`,
    );
  }
  const knownProperties = new Set(Object.keys(schema.properties ?? {}));
  for (const field of fields) {
    if (field.name !== undefined && !knownProperties.has(field.name)) {
      throw new AssertionFailure(
        `field error name "${field.name}" is not a property of the input schema of "${name}"`,
      );
    }
    if (containsLeak(field.message)) {
      throw new AssertionFailure(
        `field error message leaked internal detail: ${field.message}`,
      );
    }
  }
  if (containsLeak(mappedError.message)) {
    throw new AssertionFailure(
      `error message leaked internal detail: ${mappedError.message}`,
    );
  }

  const fixedArguments: Record<string, unknown> = { ...invalidArguments };
  for (const field of fields) {
    if (field.name === undefined) {
      continue;
    }
    fixedArguments[field.name] = validValueFor(
      schema.properties?.[field.name]?.type,
    );
  }

  const secondInvoke = await callTool<InvokeResult>(client, "invoke_tool", {
    name,
    arguments: fixedArguments,
  });

  console.log(
    `invoke_tool ${name} (invalid arguments):\n${JSON.stringify(firstInvoke.parsed, null, 2)}`,
  );
  console.log(
    `invoke_tool ${name} (fixed arguments):\n${JSON.stringify(secondInvoke.parsed, null, 2)}`,
  );

  if (secondInvoke.isError || isErrorEnvelope(secondInvoke.parsed)) {
    throw new AssertionFailure(
      `retry with fixed arguments still reported an error for "${name}"`,
    );
  }
  if (secondInvoke.parsed.status < 200 || secondInvoke.parsed.status >= 300) {
    throw new AssertionFailure(
      `retry with fixed arguments returned status ${secondInvoke.parsed.status} for "${name}", expected 2xx`,
    );
  }
}

export async function runErrorEnvelope(
  client: Client,
  options: ScenarioOptions,
): Promise<void> {
  if (options.tool === undefined) {
    throw new SetupFailure("error-envelope scenario requires --tool");
  }
  const tool = options.tool;

  const invoked = await callTool<InvokeResult>(client, "invoke_tool", {
    name: tool,
    arguments: parseArguments(options.argumentsJson),
  });
  console.log(
    `invoke_tool ${tool}:\n${JSON.stringify(invoked.parsed, null, 2)}`,
  );

  if (!invoked.isError) {
    throw new AssertionFailure(
      `invoke_tool did not report isError for "${tool}"`,
    );
  }
  if (!isErrorEnvelope(invoked.parsed)) {
    throw new AssertionFailure(
      `invoke_tool error result for "${tool}" did not parse as an error envelope`,
    );
  }
  const outcome = invoked.parsed;
  const knownCode =
    backendErrorCodes.has(outcome.error as BackendErrorCode) ||
    sdkErrorCodes.has(outcome.error);
  if (!knownCode) {
    throw new AssertionFailure(`unrecognized error code "${outcome.error}"`);
  }
  if (
    backendErrorCodes.has(outcome.error as BackendErrorCode) &&
    !isBackendMappedError(outcome)
  ) {
    throw new AssertionFailure(
      `backend error "${outcome.error}" for "${tool}" is missing a status`,
    );
  }
  if (outcome.message.length === 0) {
    throw new AssertionFailure(`error message is empty for "${outcome.error}"`);
  }
  if (containsLeak(outcome.message)) {
    throw new AssertionFailure(
      `error message leaked internal detail: ${outcome.message}`,
    );
  }
}

function fileFieldOf(schema: InputSchema): string | undefined {
  return Object.entries(schema.properties ?? {}).find(
    ([, property]) =>
      property.type === "object" &&
      property.oneOf !== undefined &&
      property.properties?.["text"] !== undefined,
  )?.[0];
}

interface UploadEcho {
  readonly file?: { readonly name?: string; readonly size?: number } | null;
}

/**
 * Drives one upload tool end to end: a text file, the caller's own ref when the schema offers
 * one, a ref that resolves to nothing, and a malformed file argument. The last two must come back
 * as SDK-side envelopes, never as a backend error the handler produced from an empty part.
 */
export async function runUpload(
  client: Client,
  options: ScenarioOptions,
): Promise<void> {
  const rows: ChecklistRow[] = [];
  const query = options.query ?? "attach file";
  const search = await callTool<SearchResponse>(client, "search_tools", {
    query,
  });
  let picked: { name: string; loaded: LoadSuccess; field: string } | undefined;
  for (const result of options.tool === undefined
    ? search.parsed.results
    : [{ name: options.tool }]) {
    const loaded = await callTool<LoadResult>(client, "load_tool", {
      name: result.name,
    });
    if (loaded.isError || isErrorEnvelope(loaded.parsed)) {
      continue;
    }
    const field = fileFieldOf(loaded.parsed.inputSchema);
    if (field !== undefined) {
      picked = { name: result.name, loaded: loaded.parsed, field };
      break;
    }
  }
  if (picked === undefined) {
    throw new SetupFailure(
      `no tool with a file argument matched query "${query}"`,
    );
  }
  const { name, loaded, field } = picked;
  const base = fillMissingRequired(loaded.inputSchema, {
    ...parseArguments(options.argumentsJson),
    [field]: { text: "line,amount\n1,120\n", name: "rapor-ğ.csv" },
  });

  const text = await callTool<InvokeResult>(client, "invoke_tool", {
    name,
    arguments: base,
  });
  const textOk =
    !text.isError &&
    !isErrorEnvelope(text.parsed) &&
    text.parsed.status < 300 &&
    (text.parsed.body as UploadEcho | undefined)?.file?.name === "rapor-ğ.csv";
  rows.push({
    step: `${name} text file`,
    ok: textOk,
    detail: JSON.stringify(text.parsed),
  });

  const offersRef =
    loaded.inputSchema.properties?.[field]?.properties?.["ref"] !== undefined;
  if (offersRef && options.user !== undefined) {
    const own = await callTool<InvokeResult>(client, "invoke_tool", {
      name,
      arguments: { ...base, [field]: { ref: `att-${options.user}-1` } },
    });
    const ownOk =
      !own.isError && !isErrorEnvelope(own.parsed) && own.parsed.status < 300;
    rows.push({
      step: `${name} own ref`,
      ok: ownOk,
      detail: JSON.stringify(own.parsed),
    });

    const missing = await callTool<InvokeResult>(client, "invoke_tool", {
      name,
      arguments: { ...base, [field]: { ref: "att-nope" } },
    });
    const missingOk =
      missing.isError &&
      isErrorEnvelope(missing.parsed) &&
      !isBackendMappedError(missing.parsed) &&
      missing.parsed.error === "file_unresolved" &&
      !missing.parsed.retryable;
    rows.push({
      step: `${name} unknown ref`,
      ok: missingOk,
      detail: JSON.stringify(missing.parsed),
    });
  }

  const malformed = await callTool<InvokeResult>(client, "invoke_tool", {
    name,
    arguments: { ...base, [field]: { text: "a", base64: "AA==" } },
  });
  const malformedOk =
    malformed.isError &&
    isErrorEnvelope(malformed.parsed) &&
    !isBackendMappedError(malformed.parsed) &&
    malformed.parsed.error === "invalid_file_argument" &&
    !containsLeak(malformed.parsed.message);
  rows.push({
    step: `${name} two sources`,
    ok: malformedOk,
    detail: JSON.stringify(malformed.parsed),
  });

  printChecklist(rows);
  if (!rows.every((row) => row.ok)) {
    throw new AssertionFailure(`upload scenario failed for "${name}"`);
  }
}

const familyMember = "assign_courier";
const familyKey = "e91b3c7f-0d2a-48e5-b6f4-5a1c9d8e2b07";
const siblingKey = "3f2c9a1e-8b4d-4c6a-9e21-7d5b0c4a1f10";

interface DispatchEcho {
  readonly methodId?: string;
  readonly method?: string;
  readonly received?: Readonly<Record<string, unknown>>;
}

function sameFields(
  actual: Readonly<Record<string, unknown>> | undefined,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  const keys = Object.keys(expected);
  return (
    actual !== undefined &&
    Object.keys(actual).length === keys.length &&
    keys.every((key) => actual[key] === expected[key])
  );
}

/**
 * Drives one member of the demos' dispatching endpoint end to end. The backend echoes the key its
 * route received, so a passing invoke proves the hidden constant — not the agent — chose the
 * member ([tool-families.md]).
 */
export async function runFamily(
  client: Client,
  options: ScenarioOptions,
): Promise<void> {
  const rows: ChecklistRow[] = [];

  const query = options.query ?? "courier";
  const search = await callTool<SearchResponse>(client, "search_tools", {
    query,
  });
  const ranked = search.parsed.results.map((result) => result.name);
  rows.push({
    step: `search_tools "${query}"`,
    ok: !search.isError && ranked[0] === familyMember,
    detail: ranked.join(", "),
  });

  const loaded = await callTool<LoadResult>(client, "load_tool", {
    name: familyMember,
  });
  if (loaded.isError || isErrorEnvelope(loaded.parsed)) {
    rows.push({
      step: `load_tool ${familyMember}`,
      ok: false,
      detail: JSON.stringify(loaded.parsed),
    });
    printChecklist(rows);
    throw new SetupFailure(`load_tool failed for "${familyMember}"`);
  }
  const properties = Object.keys(loaded.parsed.inputSchema.properties ?? {});
  const annotations = loaded.parsed.annotations as
    { readonly destructiveHint?: boolean } | undefined;
  rows.push({
    step: `load_tool ${familyMember}`,
    ok:
      !properties.includes("methodId") &&
      properties.includes("orderNumber") &&
      properties.includes("courierCode") &&
      annotations?.destructiveHint === true,
    detail: JSON.stringify({ properties, annotations }),
  });

  const args = { orderNumber: "ORD-1001", courierCode: "COURIER-7" };
  const invoked = await callTool<InvokeResult>(client, "invoke_tool", {
    name: familyMember,
    arguments: args,
  });
  let echoed = false;
  if (
    !invoked.isError &&
    !isErrorEnvelope(invoked.parsed) &&
    invoked.parsed.status < 400
  ) {
    const body = invoked.parsed.body as DispatchEcho | undefined;
    echoed =
      body?.methodId?.toLowerCase() === familyKey &&
      body.method === familyMember &&
      sameFields(body.received, args);
  }
  rows.push({
    step: `invoke_tool ${familyMember}`,
    ok: echoed,
    detail: JSON.stringify(invoked.parsed),
  });

  const smuggled = await callTool<InvokeResult>(client, "invoke_tool", {
    name: familyMember,
    arguments: { ...args, methodId: siblingKey },
  });
  rows.push({
    step: `invoke_tool ${familyMember} + methodId`,
    ok:
      isErrorEnvelope(smuggled.parsed) &&
      !isBackendMappedError(smuggled.parsed) &&
      smuggled.parsed.error === "unknown_argument",
    detail: JSON.stringify(smuggled.parsed),
  });

  const byKey = await callTool<SearchResponse>(client, "search_tools", {
    query: familyKey,
  });
  rows.push({
    step: "search_tools <member key>",
    ok: !byKey.isError && byKey.parsed.results.length === 0,
    detail: `${byKey.parsed.results.length} results`,
  });

  printChecklist(rows);
  if (!rows.every((row) => row.ok)) {
    throw new AssertionFailure(`family scenario failed for "${familyMember}"`);
  }
}

export async function runProvider(
  client: Client,
  options: ScenarioOptions,
): Promise<void> {
  const loaded = await callTool<LoadResult>(client, "load_tool", {
    name: "summarize_note",
  });
  const invoked = await callTool<ProviderSuccess>(client, "invoke_tool", {
    name: "summarize_note",
    arguments: { text: "hello world" },
  });
  const rows: ChecklistRow[] = [
    { step: "load provider", ok: !loaded.isError, detail: "summarize_note" },
    {
      step: "invoke provider",
      ok:
        !invoked.isError &&
        JSON.stringify(invoked.parsed.body) ===
          JSON.stringify({ characters: 11, words: 2 }) &&
        !("status" in invoked.parsed),
      detail: JSON.stringify(invoked.parsed),
    },
  ];
  if (options.baseUrl === undefined)
    throw new SetupFailure("provider scenario needs a base URL");
  const direct = await fetch(`${options.baseUrl}/summarize_note`, {
    method: "POST",
  });
  rows.push({
    step: "no HTTP route",
    ok: direct.status === 404,
    detail: String(direct.status),
  });
  printChecklist(rows);
  if (!rows.every((row) => row.ok))
    throw new AssertionFailure("provider scenario failed");
}

export const scenarios: Readonly<
  Record<
    ScenarioName,
    (client: Client, options: ScenarioOptions) => Promise<void>
  >
> = {
  smoke: runSmoke,
  "validation-retry": runValidationRetry,
  "error-envelope": runErrorEnvelope,
  upload: runUpload,
  family: runFamily,
  provider: runProvider,
};
