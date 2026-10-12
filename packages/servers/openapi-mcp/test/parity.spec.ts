import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EndpointDescriptor, ToolDefinition } from "@sezzlee/core";
import { ingest } from "@sezzlee/openapi";
import { describe, expect, it } from "vitest";
import { buildGatewayCatalog, configSchema } from "../src/index.js";

/**
 * Compares OpenAPI ingestion with framework discovery on the same controllers. The inputs are
 * written by sdks/dotnet/tests/Sezzlee.Tests/OpenApiParityDump.cs into SEZZLEE_PARITY_DIR. A
 * family member's SDK descriptor carries the member's body in place of the operation's, so members
 * are compared by the second test alone.
 */
const directory = process.env["SEZZLEE_PARITY_DIR"];

/**
 * Differences a document cannot avoid: the generator omits a fact the SDK reads from the type.
 */
const queryObjectForm =
  "Microsoft.AspNetCore.OpenApi writes a bound query object as one form-style object parameter, which has no wire form";

const expectedDifferences = new Map([
  [
    "PUT /schema/audited",
    "a getter-only property is readOnly to the SDK; Microsoft.AspNetCore.OpenApi does not mark it",
  ],
  ["GET /probe/filters", queryObjectForm],
  ["GET /probe/aliased", queryObjectForm],
]);

const normalizeRoute = (route: string): string =>
  route.replace(/\{([^}:?*]+)[^}]*\}/g, "{$1}").replace(/\/+$/, "") || "/";

function shapeOf(descriptor: EndpointDescriptor): Record<string, unknown> {
  const body = descriptor.requestBody;
  return {
    parameters: (descriptor.parameters ?? [])
      .map((p) => `${p.in}:${p.name}${p.required ? "!" : ""}`)
      .sort(),
    body:
      body === undefined
        ? null
        : {
            contentType: body.contentType ?? "application/json",
            required: body.required !== false,
            fields: Object.keys(body.schema.properties ?? {}).sort(),
          },
  };
}

/**
 * Tools the annotated document cannot rebuild for a reason outside the extension: the generator
 * writes a fact differently from the type the SDK reads.
 */
const expectedToolDifferences = new Map([
  [
    "schema_bodies_audited",
    "a getter-only property is readOnly to the SDK; Microsoft.AspNetCore.OpenApi does not mark it",
  ],
  ["query_object_probe_filters", queryObjectForm],
  ["query_object_probe_aliased", queryObjectForm],
]);

/** What the extension decides about a tool; requiredness and schemas are document facts, compared above. */
function surfaceOf(tool: ToolDefinition): Record<string, unknown> {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> };
  return {
    arguments: Object.keys(schema.properties ?? {}).sort(),
    annotations: Object.fromEntries(
      Object.entries(tool.annotations).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

describe.skipIf(directory === undefined || directory === "")(
  "parity: OpenAPI ingestion against framework discovery",
  () => {
    it("describes every SDK endpoint the same way", async () => {
      const dir = directory as string;
      const sdk = JSON.parse(
        readFileSync(join(dir, "sdk-descriptors.json"), "utf8"),
      ) as { tool: string; descriptor: EndpointDescriptor }[];
      const document = JSON.parse(
        readFileSync(join(dir, "openapi.json"), "utf8"),
      );
      const ingested = await ingest(document, {
        requestBodyRequired: "always",
        baseUrl: "http://localhost",
      });
      const byKey = new Map(
        ingested.endpoints.map((e) => [
          `${e.descriptor.method} ${normalizeRoute(e.descriptor.route)}`,
          e.descriptor,
        ]),
      );
      const report: string[] = [];
      const unexpected: string[] = [];
      let missing = 0;
      let differing = 0;
      for (const { tool, descriptor } of sdk.filter(
        ({ descriptor }) => descriptor.family === undefined,
      )) {
        const key = `${descriptor.method} ${normalizeRoute(descriptor.route)}`;
        const other = byKey.get(key);
        if (other === undefined) {
          missing += 1;
          report.push(`MISSING ${key} (${tool})`);
          continue;
        }
        const left = JSON.stringify(shapeOf(descriptor));
        const right = JSON.stringify(shapeOf(other));
        if (left !== right) {
          differing += 1;
          if (!expectedDifferences.has(key)) {
            unexpected.push(key);
          }
          report.push(
            `DIFF ${key} (${tool})\n  sdk:     ${left}\n  openapi: ${right}`,
          );
        }
      }
      process.stdout.write(
        [
          `sdk endpoints: ${String(sdk.length)}, ingested: ${String(ingested.endpoints.length)}, missing: ${String(missing)}, differing: ${String(differing)}`,
          ...report,
          ...ingested.diagnostics.map((d) => `diag ${d.code} ${d.at}`),
        ].join("\n") + "\n",
      );
      expect(missing).toBe(0);
      expect(unexpected).toEqual([]);
    });

    it("rebuilds the SDK's tools from the document its x-sezzlee extensions annotate", async () => {
      const dir = directory as string;
      const sdk = JSON.parse(
        readFileSync(join(dir, "sdk-descriptors.json"), "utf8"),
      ) as { tool: string; definition: ToolDefinition }[];
      const document = JSON.parse(
        readFileSync(join(dir, "openapi.sezzlee.json"), "utf8"),
      ) as Record<string, unknown>;
      const gateway = await buildGatewayCatalog(
        document,
        configSchema.parse({
          source: "inline",
          baseUrl: "http://localhost",
          requestBodyRequired: "always",
          selection: { default: "include" },
        }),
        new Map(),
        [],
        undefined,
        undefined,
      );
      const sdkNames = sdk.map(({ tool }) => tool).sort();
      const gatewayNames = [...gateway.catalog.byName.keys()].sort();
      const onlySdk = sdkNames.filter(
        (name) => !gateway.catalog.byName.has(name),
      );
      const onlyGateway = gatewayNames.filter(
        (name) => !sdkNames.includes(name),
      );
      const report = [
        ...onlySdk.map((name) => `ONLY SDK ${name}`),
        ...onlyGateway.map((name) => `ONLY GATEWAY ${name}`),
      ];
      const differing: string[] = [];
      for (const { tool, definition } of sdk) {
        const entry = gateway.catalog.byName.get(tool);
        if (entry === undefined) {
          continue;
        }
        const left = JSON.stringify(surfaceOf(definition));
        const right = JSON.stringify(surfaceOf(entry.tool));
        if (left !== right) {
          differing.push(tool);
          report.push(`DIFF ${tool}\n  sdk:     ${left}\n  gateway: ${right}`);
        }
      }
      process.stdout.write(
        [
          `sdk tools: ${String(sdkNames.length)}, gateway tools: ${String(gatewayNames.length)}, differing: ${String(differing.length)}`,
          ...report,
          ...gateway.ingestion
            .filter(
              (d) =>
                d.code.startsWith("extension") || d.code.startsWith("family"),
            )
            .map((d) => `diag ${d.code} ${d.at}`),
          ...gateway.catalog.diagnostics.map(
            (d) => `catalog ${d.code} ${d.message}`,
          ),
        ].join("\n") + "\n",
      );
      expect(onlyGateway).toEqual([]);
      expect(
        [...onlySdk, ...differing].filter(
          (name) => !expectedToolDifferences.has(name),
        ),
      ).toEqual([]);
    });
  },
);
