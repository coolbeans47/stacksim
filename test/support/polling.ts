export interface WaitUntilOptions<T> {
  timeoutMs?: number;
  intervalMs?: number;
  timeoutMessage?: string | ((lastValue: T | undefined) => string);
}

/**
 * Polls asynchronous simulator state against a monotonic, platform-neutral
 * deadline. Fixed attempt counts make the effective timeout depend on HTTP and
 * filesystem latency because time spent in read() is not part of their budget.
 */
export async function waitUntil<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  options: WaitUntilOptions<T> = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = performance.now() + timeoutMs;
  let lastValue: T | undefined;

  for (;;) {
    lastValue = await read();
    if (accept(lastValue)) return lastValue;
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remainingMs)));
  }

  const message = typeof options.timeoutMessage === "function"
    ? options.timeoutMessage(lastValue)
    : options.timeoutMessage ?? `Timed out after ${timeoutMs}ms waiting for an asynchronous test condition`;
  throw new Error(message);
}
