export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export class SystemClock implements Clock {
  now(): number { return Date.now(); }
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> { return setTimeout(callback, delayMs); }
  clearTimeout(handle: ReturnType<typeof setTimeout>): void { clearTimeout(handle); }
}

export class TestClock implements Clock {
  private time: number;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();
  constructor(start = 0) { this.time = start; }
  now(): number { return this.time; }
  setTimeout(callback: () => void, delayMs: number): any { const id = this.nextId++; this.timers.set(id, { at: this.time + Math.max(0, delayMs), callback }); return id; }
  clearTimeout(handle: any): void { this.timers.delete(Number(handle)); }
  advance(ms: number): void {
    const end = this.time + ms;
    while (true) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].callback();
    }
    this.time = end;
  }
}
