import { parentPort, workerData } from "node:worker_threads";
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  Scope,
} from "quickjs-emscripten-core";
import {
  executionFailure,
  workerInputSchema,
  type DataExecution,
} from "./protocol.js";

const serializer = `(() => {
  const stringify = JSON.stringify;
  const finite = Number.isFinite;
  const array = Array.isArray;
  const prototype = Object.getPrototypeOf;
  const plain = Object.prototype;
  return (value) => {
    return stringify(value, (_key, item) => {
      const type = typeof item;
      if (type === "undefined" || type === "function" || type === "symbol" || type === "bigint" || (type === "number" && !finite(item))) {
        throw new TypeError("A finite JSON value is required");
      }
      if (item !== null && type === "object") {
        if (typeof item.then === "function" || (!array(item) && prototype(item) !== plain && prototype(item) !== null)) {
          throw new TypeError("A plain JSON value is required");
        }
      }
      return item;
    });
  };
})()`;

async function execute(input: unknown): Promise<DataExecution> {
  const parsed = workerInputSchema.safeParse(input);
  if (!parsed.success) {
    return executionFailure("invalid_input");
  }
  const { json, code, limits } = parsed.data;
  const variant =
    "default" in RELEASE_SYNC ? RELEASE_SYNC.default : RELEASE_SYNC;
  const quickjs = await newQuickJSWASMModuleFromVariant(variant);
  return Scope.withScope((scope) => {
    const runtime = scope.manage(quickjs.newRuntime());
    runtime.setMemoryLimit(limits.maxMemoryBytes);
    runtime.setMaxStackSize(limits.maxStackBytes);
    const deadline = performance.now() + limits.timeoutMs;
    let interrupted = false;
    runtime.setInterruptHandler(() => {
      interrupted = performance.now() >= deadline;
      return interrupted;
    });
    const vm = scope.manage(runtime.newContext());
    const data = vm.evalCode(`JSON.parse(${JSON.stringify(json)})`, "input.js");
    if (data.error) {
      scope.manage(data.error);
      return executionFailure(interrupted ? "timeout" : "invalid_input");
    }
    const dataValue = scope.manage(data.value);
    const encode = vm.evalCode(serializer, "serialize.js");
    if (encode.error) {
      scope.manage(encode.error);
      return executionFailure(interrupted ? "timeout" : "memory_limit");
    }
    const encodeValue = scope.manage(encode.value);
    const program = vm.evalCode(
      `(function(data) { "use strict";\n${code}\n})`,
      "program.js",
    );
    if (program.error) {
      scope.manage(program.error);
      return executionFailure(interrupted ? "timeout" : "invalid_program");
    }
    const programValue = scope.manage(program.value);
    if (vm.typeof(programValue) !== "function") {
      return executionFailure("invalid_program");
    }
    const result = vm.callFunction(programValue, vm.undefined, dataValue);
    if (result.error) {
      scope.manage(result.error);
      return executionFailure(interrupted ? "timeout" : "program_failed");
    }
    const resultValue = scope.manage(result.value);
    const encoded = vm.callFunction(encodeValue, vm.undefined, resultValue);
    if (encoded.error) {
      scope.manage(encoded.error);
      return executionFailure(interrupted ? "timeout" : "invalid_result");
    }
    const encodedValue = scope.manage(encoded.value);
    if (vm.typeof(encodedValue) !== "string") {
      return executionFailure("invalid_result");
    }
    const length = scope.manage(vm.getProp(encodedValue, "length"));
    if (vm.getNumber(length) > limits.maxOutputBytes) {
      return executionFailure("output_limit");
    }
    const output = vm.getString(encodedValue);
    return Buffer.byteLength(output, "utf8") > limits.maxOutputBytes
      ? executionFailure("output_limit")
      : { kind: "success", json: output };
  });
}

const port = parentPort;
if (port !== null) {
  void execute(workerData).then(
    (result) => port.postMessage(result),
    () => port.postMessage(executionFailure("unavailable")),
  );
}
