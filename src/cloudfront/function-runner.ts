import { Worker } from "node:worker_threads";
import { cloneFunctionEvent, validateFunctionRequest, type CloudFrontFunctionEvent, type CloudFrontFunctionRequest } from "./function-event.js";

export const CLOUDFRONT_FUNCTION_LIMITS = Object.freeze({
  maximumCodeBytes: 10 * 1024,
  maximumEventBytes: 40 * 1024,
  maximumOutputBytes: 40 * 1024,
  memoryBytes: 16 * 1024 * 1024,
  timeoutMs: 50,
});

export class CloudFrontFunctionExecutionError extends Error {
  constructor(message: string) { super(message); this.name = "CloudFrontFunctionExecutionError"; }
}

export class CloudFrontFunctionRunner {
  async invoke(code: string, event: CloudFrontFunctionEvent): Promise<CloudFrontFunctionRequest | Record<string, unknown>> {
    if (Buffer.byteLength(code, "utf8") > CLOUDFRONT_FUNCTION_LIMITS.maximumCodeBytes) throw new CloudFrontFunctionExecutionError("Function code exceeds 10 KiB");
    const input = cloneFunctionEvent(event);
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./function-worker.js", import.meta.url), {
        workerData: { code, event: input, deadlineMs: CLOUDFRONT_FUNCTION_LIMITS.timeoutMs, memoryBytes: CLOUDFRONT_FUNCTION_LIMITS.memoryBytes, outputBytes: CLOUDFRONT_FUNCTION_LIMITS.maximumOutputBytes },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
      });
      let settled = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        if (error) reject(new CloudFrontFunctionExecutionError(error instanceof Error ? error.message : String(error)));
        else {
          try {
            const candidate = value as Record<string, unknown>;
            if (candidate && typeof candidate === "object" && "uri" in candidate) resolve(validateFunctionRequest(candidate, input.request.method));
            else resolve(candidate);
          } catch (validationError) { reject(new CloudFrontFunctionExecutionError(validationError instanceof Error ? validationError.message : String(validationError))); }
        }
      };
      // WASM initialization is outside the guest CPU deadline, but remains bounded by the
      // parent. Every invocation still receives a fresh worker/runtime/context.
      const timer = setTimeout(() => finish(new Error("Function execution timed out")), 3_000);
      worker.once("message", message => message?.ok ? finish(undefined, message.value) : finish(new Error(message?.error ?? "Function execution failed")));
      worker.once("error", finish);
      worker.once("exit", code => { if (!settled && code !== 0) finish(new Error("Function worker exited unexpectedly")); });
    });
  }
}
