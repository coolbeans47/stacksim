import { resourceUsage } from "node:process";

export type LambdaMemoryUsage =
  | { status: "measured"; maxMemoryUsedMB: number; source: "node-process-peak-rss"; scope: "worker-lifetime-excluding-children" }
  | { status: "unavailable"; reason: "runtime-measurement-unavailable" | "worker-ended-without-measurement" | "container-peak-unavailable" };

/** libuv normalizes maxRSS to KiB on supported hosts. This is a process lifetime
 * high-water mark, including initialization and earlier warm calls, not a quota. */
export function measureWorkerMemory(read = resourceUsage): LambdaMemoryUsage {
  try {
    const kibibytes = read().maxRSS;
    if (Number.isFinite(kibibytes) && kibibytes > 0) return { status: "measured", maxMemoryUsedMB: kibibytes / 1024, source: "node-process-peak-rss", scope: "worker-lifetime-excluding-children" };
  } catch { /* A missing host measurement must not fail an invocation. */ }
  return { status: "unavailable", reason: "runtime-measurement-unavailable" };
}
