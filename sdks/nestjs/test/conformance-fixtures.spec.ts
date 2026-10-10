import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compose,
  createCard,
  createDetail,
  createRequestTemplate,
  createRequestTemplateFromEndpoint,
  createToolDefinition,
  createToolNames,
  expandToolProductions,
  routePlaceholderNames,
  evaluateVisibility,
  isSelected,
  isBinaryMediaType,
  mergeCookieHeader,
  serializationFor,
  resolveRules,
  describePayload,
  mapInvokeResult,
  refuseOversizeResponse,
  refuseChangedTool,
  refuseRankerUnavailable,
  refuseTimedOutInvoke,
  refuseUnresolvedFile,
  isListQuery,
  normalizeRanking,
  searchParameters,
  sdkError,
  simplifySchema,
  SezzleeArgumentError,
  SezzleeCatalogError,
  SezzleeTemplateError,
  ToolIndex,
  type ArgumentFill,
  type BackendResponse,
  type InvokeResult,
  type CurationRelief,
  type ComposedBody,
  type EndpointDescriptor,
  type FileOptions,
  type FileSource,
  type Fixture,
  type FormFieldBinding,
  type ParameterBinding,
  type RequestTemplate,
  type ToolDefinition,
} from "@sezzlee/core";

type FixtureOf<K extends Fixture["kind"]> = Extract<Fixture, { kind: K }>;

function fixturesOf<K extends Fixture["kind"]>(
  kind: K,
): Array<[string, FixtureOf<K>]> {
  const dir = fileURLToPath(
    new URL(`../../../packages/http/conformance/${kind}/`, import.meta.url),
  );
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  return files.map((file) => {
    const fixture = JSON.parse(
      readFileSync(join(dir, file), "utf8"),
    ) as Fixture;
    expect(fixture.kind).toBe(kind);
    return [file, fixture as FixtureOf<K>];
  });
}

function catalogErrorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SezzleeCatalogError);
    return (error as SezzleeCatalogError).code;
  }
  return expect.unreachable("expected a catalog error");
}

const unusedAuth: EndpointDescriptor["auth"] = {
  anonymous: "yes",
  policies: [],
  imperative: false,
};

function templateFrom(
  spec: FixtureOf<"argument-mapping">["input"]["template"],
): RequestTemplate {
  const bodyAliases = new Map<string, string>();
  const bodyFills = new Map<string, ArgumentFill>();
  for (const record of spec.body?.curation ?? []) {
    if (record.as !== undefined) {
      bodyAliases.set(record.as, record.name);
    }
    if (record.fill !== undefined) {
      bodyFills.set(record.name, record.fill as ArgumentFill);
    }
  }
  return createRequestTemplate({
    method: spec.method,
    route: spec.route,
    parameters: (spec.parameters ?? []).map((p): ParameterBinding => {
      const named = {
        name: p.name,
        location: p.in,
        ...(p.as === undefined ? {} : { argument: p.as }),
      };
      if (p.contentType !== undefined) {
        return {
          ...named,
          kind: "content",
          mediaType: p.contentType,
          ...(p.members === undefined
            ? {}
            : {
                members: p.members.map((member) => ({
                  name: member.name,
                  kind: member.type,
                  ...(member.array === true ? { isArray: true } : {}),
                })),
              }),
          ...(p.fill === undefined ? {} : { fill: p.fill as ArgumentFill }),
        };
      }
      if (p.type === "object") {
        return {
          ...named,
          kind: "object",
          notation: p.notation ?? "bracket",
          members: (p.members ?? []).map((member) => ({
            name: member.name,
            kind: member.type,
            ...(member.array === true ? { isArray: true } : {}),
          })),
        };
      }
      const isArray = p.array === true;
      return {
        ...named,
        kind: p.type as Exclude<typeof p.type, "object" | "json">,
        isArray,
        ...serializationFor(
          p.in,
          p.style,
          p.explode,
          isArray,
          p.name,
          p.allowReserved,
        ),
        ...(p.fill === undefined ? {} : { fill: p.fill as ArgumentFill }),
      };
    }),
    ...(spec.bodyRoot === undefined
      ? {
          bodyProperties: spec.body?.properties,
          bodyAllowsAdditionalProperties:
            spec.body?.additionalProperties === true,
          ...(bodyAliases.size === 0 ? {} : { bodyAliases }),
          ...(bodyFills.size === 0 ? {} : { bodyFills }),
        }
      : {
          bodyRoot: spec.bodyRoot,
          ...(spec.contentType !== undefined &&
          isBinaryMediaType(spec.contentType)
            ? { binaryBody: true }
            : {}),
          ...(spec.rootFill === undefined
            ? {}
            : { rootFill: spec.rootFill as ArgumentFill }),
        }),
    ...(spec.contentType === undefined
      ? {}
      : { contentType: spec.contentType }),
    ...(spec.form === undefined
      ? {}
      : {
          form: {
            notation: spec.form.notation ?? "bracket",
            fields: spec.form.fields.map((field): FormFieldBinding => {
              if (field.type === "object") {
                return {
                  name: field.name,
                  kind: "object",
                  members: (field.members ?? []).map((member) => ({
                    name: member.name,
                    kind: member.type,
                    ...(member.array === true ? { isArray: true } : {}),
                  })),
                };
              }
              if (field.type === "file") {
                return {
                  name: field.name,
                  kind: "file",
                  ...(field.array === true ? { isArray: true } : {}),
                  ...(field.mediaType === undefined
                    ? {}
                    : { mediaType: field.mediaType }),
                };
              }
              return {
                name: field.name,
                kind: field.type,
                ...(field.array === true ? { isArray: true } : {}),
              };
            }),
          },
        }),
    ...(spec.fileSources === undefined
      ? {}
      : { fileSources: new Set<FileSource>(spec.fileSources) }),
  });
}

type ComposedExpectation = Extract<
  FixtureOf<"argument-mapping">["expected"],
  { pathAndQuery: string }
>;

/**
 * Projects a composed body onto the fixture's expectation keys.
 *
 * `contentType` is written only when it is not the JSON default, so every fixture that predates
 * media types keeps comparing exactly what it compared before. The ref fallbacks are the SDK's
 * last rung and stay out of the corpus.
 */
function expectedFileOf(
  file: Extract<ComposedBody, { kind: "binary" }>["file"],
): NonNullable<ComposedExpectation["bodyFile"]> {
  switch (file.source) {
    case "text":
      return {
        text: file.text,
        filename: file.filename,
        mediaType: file.mediaType,
      };
    case "base64":
      return {
        base64: file.base64,
        byteLength: file.byteLength,
        filename: file.filename,
        mediaType: file.mediaType,
      };
    case "ref":
      return {
        ref: file.ref,
        ...(file.filename === undefined ? {} : { filename: file.filename }),
        ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
      };
  }
}

function bodyExpectationOf(
  body: ComposedBody | undefined,
): Omit<ComposedExpectation, "pathAndQuery" | "headers"> {
  if (body === undefined) {
    return {};
  }
  const contentType =
    body.contentType === "application/json"
      ? {}
      : { contentType: body.contentType };
  switch (body.kind) {
    case "json":
      return {
        ...contentType,
        bodyJson: body.value as ComposedExpectation["bodyJson"],
      };
    case "text":
      return { ...contentType, bodyText: body.value };
    case "urlencoded":
      return { ...contentType, bodyForm: body.encoded };
    case "binary":
      return { ...contentType, bodyFile: expectedFileOf(body.file) };
    case "multipart":
      return {
        ...contentType,
        bodyParts: body.parts.map((part) => {
          if ("value" in part) {
            return { name: part.name, value: part.value };
          }
          const file = part.file;
          switch (file.source) {
            case "text":
              return {
                name: part.name,
                file: {
                  text: file.text,
                  filename: file.filename,
                  mediaType: file.mediaType,
                },
              };
            case "base64":
              return {
                name: part.name,
                file: {
                  base64: file.base64,
                  byteLength: file.byteLength,
                  filename: file.filename,
                  mediaType: file.mediaType,
                },
              };
            case "ref":
              return {
                name: part.name,
                file: {
                  ref: file.ref,
                  ...(file.filename === undefined
                    ? {}
                    : { filename: file.filename }),
                  ...(file.mediaType === undefined
                    ? {}
                    : { mediaType: file.mediaType }),
                },
              };
          }
        }),
      };
  }
}

function composeFixture(
  template: RequestTemplate,
  input: FixtureOf<"argument-mapping">["input"],
): ReturnType<typeof compose> {
  const composed = compose(
    template,
    input.arguments,
    input.deferred,
    input.maxInlineFileBytes === undefined
      ? undefined
      : { maxInlineFileBytes: input.maxInlineFileBytes },
  );
  if (input.carrierCookies === undefined) {
    return composed;
  }
  const cookie = mergeCookieHeader(
    input.carrierCookies,
    composed.headers["cookie"],
  );
  return {
    ...composed,
    headers: {
      ...composed.headers,
      ...(cookie === undefined ? {} : { cookie }),
    },
  };
}

describe("conformance: argument-mapping", () => {
  for (const [file, fixture] of fixturesOf("argument-mapping")) {
    it(file, () => {
      const template = templateFrom(fixture.input.template);
      if ("error" in fixture.expected) {
        const expected = fixture.expected.error;
        try {
          composeFixture(template, fixture.input);
          expect.unreachable(`expected error ${expected}`);
        } catch (error) {
          expect(error).toBeInstanceOf(SezzleeArgumentError);
          expect((error as SezzleeArgumentError).code).toBe(expected);
        }
      } else {
        const composed = composeFixture(template, fixture.input);
        expect(composed.pathAndQuery).toBe(fixture.expected.pathAndQuery);
        expect(composed.headers).toEqual(fixture.expected.headers ?? {});
        const {
          pathAndQuery: _path,
          headers: _headers,
          ...body
        } = fixture.expected;
        expect(bodyExpectationOf(composed.body)).toEqual(body);
      }
    });
  }
});

describe("conformance: naming", () => {
  for (const [file, fixture] of fixturesOf("naming")) {
    it(file, () => {
      const hostPrefixes = fixture.input.hostPrefixes ?? {};
      const endpoints: EndpointDescriptor[] = fixture.input.endpoints.map(
        (e) => {
          const declared =
            e.containerPrefix ??
            (e.container === undefined ? undefined : hostPrefixes[e.container]);
          return {
            ...(e.operationId === undefined
              ? {}
              : { operationId: e.operationId }),
            ...(e.container === undefined ? {} : { container: e.container }),
            ...(declared === undefined ? {} : { containerPrefix: declared }),
            ...(e.toolName === undefined ? {} : { toolName: e.toolName }),
            ...(e.variants === undefined ? {} : { variants: e.variants }),
            method: e.method,
            route: e.route,
            auth: unusedAuth,
          };
        },
      );
      const options = { prefixMode: fixture.input.prefixMode ?? "always" };
      if ("error" in fixture.expected) {
        expect(
          catalogErrorCode(() => createToolNames(endpoints, options)),
        ).toBe(fixture.expected.error);
      } else {
        expect(createToolNames(endpoints, options)).toEqual(
          fixture.expected.names,
        );
      }
    });
  }
});

describe("conformance: selection", () => {
  for (const [file, fixture] of fixturesOf("selection")) {
    it(file, () => {
      const select = (): string[] =>
        fixture.input.operations
          .filter((o) =>
            isSelected(
              fixture.input.default,
              o.container,
              o.operation,
              o.id,
              resolveRules(
                fixture.input.rules,
                o.route ?? "",
                o.method ?? "",
                o.id,
              ),
            ),
          )
          .map((o) => o.id);
      if ("error" in fixture.expected) {
        expect(catalogErrorCode(select)).toBe(fixture.expected.error);
      } else {
        expect(select()).toEqual(fixture.expected.selected);
      }
    });
  }
});

function templateErrorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SezzleeTemplateError);
    return (error as SezzleeTemplateError).code;
  }
  return expect.unreachable("expected a template error");
}

function reliefOf(
  fixture: FixtureOf<"metadata-extraction">,
): CurationRelief | undefined {
  if (fixture.foldedRoutes === undefined) {
    return undefined;
  }
  const foldedNames = new Set<string>();
  for (const route of fixture.foldedRoutes) {
    for (const name of routePlaceholderNames(route)) {
      foldedNames.add(name);
    }
  }
  for (const name of routePlaceholderNames(fixture.input.route)) {
    foldedNames.delete(name);
  }
  return { foldedNames, onUnused: () => {} };
}

function filesOf(
  fixture: FixtureOf<"metadata-extraction">,
): FileOptions | undefined {
  return fixture.files?.refDescription === undefined
    ? undefined
    : { refDescription: fixture.files.refDescription };
}

/**
 * Builds the request template too whenever the body is not JSON, because every body-shape
 * rejection lives there: a definition alone would publish a form tool whose template can never
 * be built.
 */
function toolsOf(
  endpoint: EndpointDescriptor,
  relief: CurationRelief | undefined,
  files: FileOptions | undefined,
): ToolDefinition[] {
  return expandToolProductions([endpoint], (e) => e).map((production) => {
    const definition = createToolDefinition(
      production.endpoint,
      undefined,
      production.variant,
      relief,
      files,
    );
    createRequestTemplateFromEndpoint(
      production.endpoint,
      production.variant,
      relief,
      files,
    );
    return definition;
  });
}

describe("conformance: metadata-extraction", () => {
  for (const [file, fixture] of fixturesOf("metadata-extraction")) {
    it(file, () => {
      const expected = fixture.expected;
      const relief = reliefOf(fixture);
      const files = filesOf(fixture);
      if ("error" in expected) {
        expect(
          templateErrorCode(() => toolsOf(fixture.input, relief, files)),
        ).toBe(expected.error);
        return;
      }
      if ("tools" in expected) {
        expect(toolsOf(fixture.input, relief, files)).toEqual(expected.tools);
        return;
      }
      expect(toolsOf(fixture.input, relief, files)).toEqual([expected]);
    });
  }
});

describe("conformance: visibility", () => {
  for (const [file, fixture] of fixturesOf("visibility")) {
    it(file, () => {
      expect(evaluateVisibility(fixture.input.auth, fixture.input.caller)).toBe(
        fixture.expected.decision,
      );
    });
  }
});

type ErrorMappingInput = FixtureOf<"error-mapping">["input"];
type BackendInput = Extract<ErrorMappingInput, { status: number }>;
type SdkInput = Extract<ErrorMappingInput, { sdkError: string }>;

function isSdkInput(input: ErrorMappingInput): input is SdkInput {
  return "sdkError" in input;
}

function rawBody(body: BackendInput["body"]): string | undefined {
  if (body === undefined) return undefined;
  return typeof body === "string" ? body : JSON.stringify(body);
}

function backendResponseFrom(input: BackendInput): BackendResponse {
  const body = rawBody(input.body);
  return {
    status: input.status,
    ...(input.contentType === undefined
      ? {}
      : { contentType: input.contentType }),
    headers: input.headers ?? {},
    ...(body === undefined ? {} : { body }),
  };
}

function sdkResultFrom(input: SdkInput): InvokeResult {
  if (input.sdkError === "response_too_large") {
    return refuseOversizeResponse({
      bytes: input.bytes ?? 0,
      limit: input.limit ?? 1,
      shape: describePayload(input.payload),
      ...(input.narrowing === undefined ? {} : { narrowing: input.narrowing }),
    });
  }
  if (input.sdkError === "invoke_timeout") {
    return refuseTimedOutInvoke(input.limitMs ?? 0);
  }
  if (input.sdkError === "search_ranker_unavailable") {
    return refuseRankerUnavailable();
  }
  if (input.sdkError === "tool_changed") {
    return refuseChangedTool(input.tool ?? "");
  }
  if (input.reason !== undefined) {
    return refuseUnresolvedFile(
      input.field ?? "",
      input.reason,
      input.limit ?? 1,
    );
  }
  return sdkError(input.sdkError, input.message ?? "");
}

describe("conformance: error-mapping", () => {
  for (const [file, fixture] of fixturesOf("error-mapping")) {
    it(file, () => {
      if (isSdkInput(fixture.input)) {
        expect(sdkResultFrom(fixture.input)).toEqual(fixture.expected);
        return;
      }
      const response = backendResponseFrom(fixture.input);
      const options = {
        ...(fixture.input.knownFields === undefined
          ? {}
          : { knownFields: fixture.input.knownFields }),
        ...(fixture.input.fieldAliases === undefined
          ? {}
          : { fieldAliases: fixture.input.fieldAliases }),
        ...(fixture.input.hiddenFields === undefined
          ? {}
          : { hiddenFields: fixture.input.hiddenFields }),
      };
      expect(mapInvokeResult(response, options)).toEqual(fixture.expected);
    });
  }
});

type SearchTool = FixtureOf<"search">["input"]["tools"][number];

function searchIndexOf(tools: readonly SearchTool[]): ToolIndex {
  return new ToolIndex(
    tools.map((t) => ({
      name: t.name,
      ...(t.description === undefined ? {} : { description: t.description }),
      ...(t.tags === undefined ? {} : { tags: t.tags }),
      ...(t.searchTerms === undefined ? {} : { searchTerms: t.searchTerms }),
      route: t.route,
      ...(t.alternateRoutes === undefined
        ? {}
        : { alternateRoutes: t.alternateRoutes }),
      ...(t.inputSchema === undefined
        ? {}
        : {
            parameters: searchParameters(
              t.inputSchema,
              new Set(t.groupedParameters ?? []),
            ),
          }),
    })),
  );
}

describe("conformance: search", () => {
  for (const [file, fixture] of fixturesOf("search")) {
    it(file, () => {
      const index = searchIndexOf(fixture.input.tools);
      expect(
        index.search(
          fixture.input.query,
          fixture.input.limit ?? 20,
          fixture.input.tags,
        ),
      ).toEqual(fixture.expected.names);
    });
  }
});

describe("conformance: ranked-search", () => {
  for (const [file, fixture] of fixturesOf("ranked-search")) {
    it(file, () => {
      const { tools, query, tags, rankerAnswer } = fixture.input;
      const limit = fixture.input.limit ?? 20;
      const index = searchIndexOf(tools);
      const bm25 = (): string[] => index.search(query, limit, tags);
      const normalized = isListQuery(query)
        ? { names: bm25(), unknown: [], duplicate: [] }
        : normalizeRanking(index, rankerAnswer, tags);
      expect({
        names: normalized?.names.slice(0, limit) ?? bm25(),
        fallback: normalized === undefined,
        unknown: normalized?.unknown ?? [],
        duplicate: normalized?.duplicate ?? [],
      }).toEqual({
        unknown: [],
        duplicate: [],
        ...fixture.expected,
      });
    });
  }
});

describe("conformance: schema-simplification", () => {
  for (const [file, fixture] of fixturesOf("schema-simplification")) {
    it(file, () => {
      const { schema, diagnostics } = simplifySchema(
        fixture.input.shape,
        fixture.input.options,
      );
      expect(schema).toEqual(fixture.expected.schema);
      expect(diagnostics.map((entry) => entry.code)).toEqual(
        fixture.expected.diagnostics ?? [],
      );
      if (fixture.expected.defsOrder !== undefined) {
        expect(Object.keys(schema["$defs"] as object)).toEqual(
          fixture.expected.defsOrder,
        );
      }
    });
  }
});

describe("conformance: card", () => {
  for (const [file, fixture] of fixturesOf("card")) {
    it(file, () => {
      const card = createCard(
        fixture.input.tool as ToolDefinition,
        fixture.input.decision ?? "allow",
      );
      expect(card).toEqual(fixture.expected);
    });
  }
});

describe("conformance: detail", () => {
  for (const [file, fixture] of fixturesOf("detail")) {
    it(file, () => {
      const detail = createDetail(
        fixture.input.tool as ToolDefinition,
        fixture.input.decision ?? "allow",
      );
      expect(detail).toEqual(fixture.expected);
    });
  }
});
