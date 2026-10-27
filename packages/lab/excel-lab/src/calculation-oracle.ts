import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { SaxesParser } from "saxes";

export interface CalculationExpectation {
  readonly part: string;
  readonly cells: Readonly<
    Record<
      string,
      {
        readonly formula: string;
        readonly value:
          | number
          | string
          | boolean
          | { readonly error: string }
          | { readonly unavailable: true };
      }
    >
  >;
}

export function checkCalculationOutput(
  bytes: Uint8Array,
  expectation: CalculationExpectation,
): void {
  const part = unzipSync(bytes)[expectation.part];
  assert(part !== undefined, "The expected worksheet part is absent.");
  const cells = new Map<
    string,
    { formula: string; value: string | undefined; type: string | undefined }
  >();
  let address: string | undefined,
    type: string | undefined,
    formula = "",
    value: string | undefined,
    capture: "f" | "v" | undefined;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => {
    if (tag.uri !== "http://schemas.openxmlformats.org/spreadsheetml/2006/main")
      return;
    if (tag.local === "c") {
      address = Object.values(tag.attributes).find(
        (attr) => attr.local === "r",
      )?.value;
      type = Object.values(tag.attributes).find(
        (attr) => attr.local === "t",
      )?.value;
      formula = "";
      value = undefined;
    }
    if (address !== undefined && (tag.local === "f" || tag.local === "v")) {
      capture = tag.local;
      if (capture === "v") value = "";
    }
  });
  parser.on("text", (text) => {
    if (capture === "f") formula += text;
    if (capture === "v") value = (value ?? "") + text;
  });
  parser.on("closetag", (tag) => {
    if (tag.uri !== "http://schemas.openxmlformats.org/spreadsheetml/2006/main")
      return;
    if (tag.local === "f" || tag.local === "v") capture = undefined;
    if (tag.local === "c" && address !== undefined) {
      assert(!cells.has(address), "Duplicate cell.");
      cells.set(address, { formula, value, type });
      address = undefined;
    }
  });
  parser.write(new TextDecoder().decode(part)).close();
  for (const [address, expected] of Object.entries(expectation.cells)) {
    const actual = cells.get(address);
    assert(actual !== undefined, `Missing calculated cell ${address}.`);
    assert.equal(
      actual.formula,
      expected.formula,
      `Changed formula at ${address}.`,
    );
    if (typeof expected.value === "object" && "unavailable" in expected.value) {
      assert.equal(actual.value, undefined, `Stale cache at ${address}.`);
      continue;
    }
    assert(actual.value !== undefined, `Missing cache at ${address}.`);
    if (typeof expected.value === "number") {
      assert(
        actual.type === undefined || actual.type === "n",
        `Wrong cache type at ${address}.`,
      );
      assert(
        Number.isFinite(Number(actual.value)) &&
          Math.abs(Number(actual.value) - expected.value) <=
            1e-10 * Math.max(1, Math.abs(expected.value)),
        `Wrong numeric cache at ${address}.`,
      );
    } else if (typeof expected.value === "string") {
      assert.equal(actual.type, "str");
      assert.equal(actual.value, expected.value);
    } else if (typeof expected.value === "boolean") {
      assert.equal(actual.type, "b");
      assert.equal(actual.value, expected.value ? "1" : "0");
    } else {
      assert.equal(actual.type, "e");
      assert.equal(actual.value, expected.value.error);
    }
  }
}
