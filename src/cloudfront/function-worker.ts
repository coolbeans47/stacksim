import { parentPort, workerData } from "node:worker_threads";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import * as releaseSyncVariantModule from "@jitl/quickjs-wasmfile-release-sync";

interface Input { code: string; event: unknown; deadlineMs: number; memoryBytes: number; outputBytes: number }

async function execute(input: Input): Promise<unknown> {
  const releaseSyncVariant = releaseSyncVariantModule.default as unknown as Parameters<typeof newQuickJSWASMModuleFromVariant>[0];
  const QuickJS = await newQuickJSWASMModuleFromVariant(releaseSyncVariant);
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(input.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + input.deadlineMs;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const context = runtime.newContext();
  try {
    const eventJson = JSON.stringify(input.event).replaceAll("<", "\\u003c");
    const source = `"use strict";\n` +
      `globalThis.process=undefined;globalThis.require=undefined;globalThis.module=undefined;globalThis.exports=undefined;globalThis.Buffer=undefined;globalThis.fetch=undefined;globalThis.WebAssembly=undefined;globalThis.setTimeout=undefined;globalThis.setInterval=undefined;globalThis.Worker=undefined;\n` +
      `${input.code}\n` +
      `if(typeof handler!=="function")throw new TypeError("Function code must declare handler(event)");\n` +
      `JSON.stringify(handler(${eventJson}));`;
    const result = context.evalCode(source, "cloudfront-function.js", { type: "global", strict: true });
    if (result.error) {
      const error = context.dump(result.error);
      result.error.dispose();
      throw new Error(typeof error?.message === "string" ? error.message : String(error));
    }
    const output = context.dump(result.value);
    result.value.dispose();
    if (typeof output !== "string") throw new TypeError("Function result is not JSON serializable");
    if (Buffer.byteLength(output) > input.outputBytes) throw new RangeError("Function output exceeds the configured limit");
    return JSON.parse(output);
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

void execute(workerData as Input).then(
  value => parentPort?.postMessage({ ok: true, value }),
  error => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }),
);
