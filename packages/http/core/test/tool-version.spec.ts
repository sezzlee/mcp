import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/generated/tool-definition.js";
import { checkPinnedVersion } from "../src/meta-tools/meta-tools.js";
import { createLoadedTool, toolVersion } from "../src/tool-version.js";

const getOrder = (): ToolDefinition => ({
  name: "get_order",
  description: "Fetches one order by id.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "integer", minimum: 1 },
      expand: { type: "string", enum: ["lines", "customer"] },
    },
    required: ["id"],
  },
  outputSchema: {
    type: "object",
    properties: { id: { type: "integer" }, total: { type: "number" } },
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  auth: { anonymous: "no", policies: ["orders.read"], imperative: false },
});

const changed = (patch: Partial<ToolDefinition>): ToolDefinition => ({
  ...getOrder(),
  ...patch,
});

describe("toolVersion", () => {
  it("is equal for one tool discovered with its keys in another order", () => {
    const reordered: ToolDefinition = {
      auth: { imperative: false, policies: ["orders.read"], anonymous: "no" },
      annotations: { idempotentHint: true, readOnlyHint: true },
      outputSchema: {
        properties: { total: { type: "number" }, id: { type: "integer" } },
        type: "object",
      },
      inputSchema: {
        required: ["id"],
        properties: {
          expand: { enum: ["lines", "customer"], type: "string" },
          id: { minimum: 1, type: "integer" },
        },
        type: "object",
      },
      description: "Fetches one order by id.",
      name: "get_order",
    };

    expect(toolVersion(reordered)).toBe(toolVersion(getOrder()));
  });

  it.each<[string, ToolDefinition]>([
    ["description", changed({ description: "Fetches one order." })],
    [
      "argument type",
      changed({
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      }),
    ],
    [
      "required arguments",
      changed({
        inputSchema: {
          ...getOrder().inputSchema,
          required: ["id", "expand"],
        },
      }),
    ],
    [
      "output schema",
      changed({
        outputSchema: {
          type: "object",
          properties: { id: { type: "integer" } },
        },
      }),
    ],
    ["annotations", changed({ annotations: { readOnlyHint: true } })],
    ["deprecation", changed({ deprecated: true })],
  ])("changes when the loaded shape's %s changes", (_member, tool) => {
    expect(toolVersion(tool)).not.toBe(toolVersion(getOrder()));
  });

  it("ignores auth, which the loaded shape never carries", () => {
    const tightened = changed({
      auth: { anonymous: "no", policies: ["orders.admin"], imperative: true },
    });

    expect(toolVersion(tightened)).toBe(toolVersion(getOrder()));
  });
});

describe("createLoadedTool", () => {
  it("gives a caller with an unknown decision the version an allowed caller sees", () => {
    const uncertain = createLoadedTool(getOrder(), "unknown");
    const allowed = createLoadedTool(getOrder(), "allow");

    expect(uncertain.authUncertain).toBe(true);
    expect(uncertain.version).toBe(allowed.version);
  });
});

describe("checkPinnedVersion", () => {
  const current = createLoadedTool(getOrder()).version;

  it.each([undefined, null])("skips the check when version is %s", (pinned) => {
    expect(checkPinnedVersion(getOrder(), pinned)).toBeUndefined();
  });

  it("lets a call pinned to the current version through", () => {
    expect(checkPinnedVersion(getOrder(), current)).toBeUndefined();
  });

  it("refuses a call pinned to a version the tool no longer has", () => {
    const stale = createLoadedTool(
      changed({ description: "Fetches one order." }),
    ).version;

    expect(checkPinnedVersion(getOrder(), stale)).toEqual({
      payload: {
        error: "tool_changed",
        message:
          "The tool 'get_order' changed after it was loaded, so the call was refused before reaching the backend. Load it again with load_tool and retry with the new version.",
        retryable: false,
      },
      isError: true,
    });
  });

  it("answers a version that is not a string with unknown_argument", () => {
    expect(checkPinnedVersion(getOrder(), 7)).toEqual({
      payload: {
        error: "unknown_argument",
        message:
          "Tool 'invoke_tool' takes 'version' as a string; number arrived. Call it again with the version load_tool returned, or without 'version'.",
        retryable: false,
      },
      isError: true,
    });
  });
});
