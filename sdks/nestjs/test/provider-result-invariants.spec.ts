import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { DiscoveryModule, DiscoveryService } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineProviderTool,
  invokeProvider,
  providerContext,
  type ProviderToolContext,
  type ProviderToolSchema,
} from "../src/provider-tools.js";

@Injectable()
class ResultService {}

class ResultArray extends Array<unknown> {}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("provider result invariants", () => {
  let module: TestingModule;
  const empty = z.strictObject({});
  const bind = (
    execute: (context: ProviderToolContext) => unknown,
    output?: ProviderToolSchema<unknown>,
  ) =>
    defineProviderTool({
      name: "result_fixture",
      description: "Exercise the provider result boundary.",
      provider: ResultService,
      input: empty,
      ...(output === undefined ? {} : { output }),
      access: "public",
      execute: (_provider, _input, context) => execute(context),
    }).bind(module.get(DiscoveryService));

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [ResultService],
    }).compile();
  });

  afterAll(async () => {
    await module?.close();
  });

  it("rejects accessors without reading them", async () => {
    const get = vi.fn(() => "private-output-secret");
    const value: unknown = Object.defineProperty({}, "value", {
      enumerable: true,
      get,
    });
    const result = await invokeProvider(bind(() => value), {}, undefined, {});
    expect(result).toMatchObject({
      isError: true,
      payload: { error: "provider_invalid_output" },
    });
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-output-secret");
  });

  it("rejects hidden toJSON hooks without running them", async () => {
    const toJSON = vi.fn(() => ({ secret: "private-output-secret" }));
    const value: unknown = Object.defineProperty({ ok: true }, "toJSON", {
      value: toJSON,
    });
    const result = await invokeProvider(bind(() => value), {}, undefined, {});
    expect(result).toMatchObject({
      isError: true,
      payload: { error: "provider_invalid_output" },
    });
    expect(toJSON).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "a sparse array with a compensating property",
      create: () => {
        const value: unknown[] = [];
        value.length = 1;
        return Object.assign(value, { extra: 1 });
      },
    },
    {
      name: "an array with an extra property",
      create: () => Object.assign([1], { extra: 2 }),
    },
    { name: "an array subclass", create: () => new ResultArray(1, 2) },
    { name: "a symbol key", create: () => ({ [Symbol("secret")]: 1 }) },
    {
      name: "a non-enumerable field",
      create: () => Object.defineProperty({}, "hidden", { value: 1 }),
    },
  ])("rejects $name", async (test) => {
    const result = await invokeProvider(bind(test.create), {}, undefined, {});
    expect(result).toMatchObject({
      isError: true,
      payload: { error: "provider_invalid_output" },
    });
  });

  it("detaches delivered and stored data from provider state", async () => {
    const shared = { message: "original" };
    const value = { rows: [shared, shared] };
    const result = await invokeProvider(bind(() => value), {}, undefined, {});
    shared.message = "changed";
    value.rows.push({ message: "added" });
    const expected = {
      body: { rows: [{ message: "original" }, { message: "original" }] },
    };
    expect(result.isError).toBe(false);
    expect(result.payload).toEqual(expected);
    expect(result.storable?.success).toEqual(expected);
    expect(result.storable?.success.body).not.toBe(value);
  });

  it("preserves null-prototype records and own __proto__ keys", async () => {
    const value: unknown = Object.assign(
      Object.create(null),
      Object.fromEntries([["__proto__", { harmless: true }]]),
    );
    const result = await invokeProvider(bind(() => value), {}, undefined, {});
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.payload)).toBe(
      '{"body":{"__proto__":{"harmless":true}}}',
    );
    const stored = result.storable?.success.body;
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty("harmless");
  });

  it.each([null, true, 17, "text"])("preserves %j", async (value) => {
    const result = await invokeProvider(bind(() => value), {}, undefined, {});
    expect(result).toMatchObject({
      payload: { body: value },
      isError: false,
    });
  });

  it("keeps output references relative to the envelope root", async () => {
    const schema = {
      type: "object",
      required: ["value"],
      properties: { value: { $ref: "#/$defs/Value" } },
      additionalProperties: false,
      $defs: { Value: { type: "string" } },
    };
    const output: ProviderToolSchema<unknown> = {
      "~standard": {
        validate: (value) =>
          z.strictObject({ value: z.string() })["~standard"].validate(value),
        jsonSchema: { input: () => schema, output: () => schema },
      },
    };
    const entry = bind(() => ({ value: "ok" }), output);
    expect(entry.tool.outputSchema).toEqual({
      type: "object",
      required: ["body"],
      properties: {
        body: {
          type: "object",
          required: ["value"],
          properties: { value: { $ref: "#/$defs/Value" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
      $defs: { Value: { type: "string" } },
    });
    expect(schema.$defs).toEqual({ Value: { type: "string" } });
    expect(await invokeProvider(entry, {}, undefined, {})).toMatchObject({
      payload: { body: { value: "ok" } },
      isError: false,
    });
  });

  it("skips output validation after an abandoned handler", async () => {
    const started = deferred<void>();
    const finished = deferred<unknown>();
    const validate = vi.fn((value: unknown) => ({ value }));
    const output: ProviderToolSchema<unknown> = {
      "~standard": {
        ...empty["~standard"],
        validate,
      },
    };
    const entry = bind(() => {
      started.resolve();
      return finished.promise;
    }, output);
    const abort = new AbortController();
    const work = entry.execute(
      {},
      providerContext(entry, undefined, abort.signal),
    );
    const refused = expect(work).rejects.toThrow();
    await started.promise;
    abort.abort();
    finished.resolve({});
    await refused;
    expect(validate).not.toHaveBeenCalled();
  });

  it("rejects output validation that settles after cancellation", async () => {
    const started = deferred<void>();
    const finished = deferred<{ value: unknown }>();
    const output: ProviderToolSchema<unknown> = {
      "~standard": {
        ...empty["~standard"],
        validate: () => {
          started.resolve();
          return finished.promise;
        },
      },
    };
    const entry = bind(() => ({}), output);
    const abort = new AbortController();
    const work = entry.execute(
      {},
      providerContext(entry, undefined, abort.signal),
    );
    const refused = expect(work).rejects.toThrow();
    await started.promise;
    abort.abort();
    finished.resolve({ value: {} });
    await refused;
  });
});
