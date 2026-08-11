import type { Clock } from "./clock.js";

export class Scheduler {
  private handles = new Set<ReturnType<Clock["setTimeout"]>>();
  private stopped = false;
  constructor(private readonly clock: Clock) {}
  schedule(callback: () => void | Promise<void>, delayMs: number): () => void {
    if (this.stopped) throw new Error("Scheduler is stopped");
    const handle = this.clock.setTimeout(() => {
      this.handles.delete(handle);
      void Promise.resolve(callback()).catch(() => undefined);
    }, delayMs);
    this.handles.add(handle);
    return () => { this.clock.clearTimeout(handle); this.handles.delete(handle); };
  }
  stop(): void { this.stopped = true; for (const handle of this.handles) this.clock.clearTimeout(handle); this.handles.clear(); }
  get size(): number { return this.handles.size; }
}
