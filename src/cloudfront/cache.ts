export interface CloudFrontCachedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  storedAt: number;
  expiresAt: number;
}

interface Entry extends CloudFrontCachedResponse { key: string; distributionId: string; uri: string; generation: number; accessedAt: number }

export class CloudFrontCache {
  private readonly entries = new Map<string, Entry>();
  private readonly generations = new Map<string, number>();
  private bytes = 0;
  readonly counters = new Map<string, { hits: number; misses: number; evictions: number; invalidations: number }>();

  constructor(private readonly maximumEntries = 1_000, private readonly maximumBytes = 128 * 1024 * 1024, private readonly now: () => number = Date.now) {}

  generation(distributionId: string): number { return this.generations.get(distributionId) ?? 0; }
  private metrics(id: string) { return this.counters.get(id) ?? { hits: 0, misses: 0, evictions: 0, invalidations: 0 }; }

  lookup(key: string, distributionId: string): CloudFrontCachedResponse | undefined {
    const metrics = this.metrics(distributionId);
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.remove(key);
      metrics.misses += 1; this.counters.set(distributionId, metrics); return undefined;
    }
    entry.accessedAt = this.now();
    metrics.hits += 1; this.counters.set(distributionId, metrics);
    return { status: entry.status, headers: { ...entry.headers }, body: Buffer.from(entry.body), storedAt: entry.storedAt, expiresAt: entry.expiresAt };
  }

  publish(key: string, distributionId: string, uri: string, response: Omit<CloudFrontCachedResponse, "storedAt">, fence: number): boolean {
    if (fence !== this.generation(distributionId) || response.body.length > this.maximumBytes) return false;
    this.remove(key);
    const storedAt = this.now();
    const entry: Entry = { ...response, key, distributionId, uri, storedAt, generation: fence, accessedAt: storedAt, body: Buffer.from(response.body), headers: { ...response.headers } };
    this.entries.set(key, entry); this.bytes += entry.body.length;
    this.evict(); return true;
  }

  invalidate(distributionId: string, paths: readonly string[]): number {
    this.generations.set(distributionId, this.generation(distributionId) + 1);
    let count = 0;
    for (const [key, entry] of [...this.entries]) if (entry.distributionId === distributionId && paths.some(path => matchesInvalidation(path, entry.uri))) { this.remove(key); count += 1; }
    const metrics = this.metrics(distributionId); metrics.invalidations += 1; this.counters.set(distributionId, metrics);
    return count;
  }

  clearDistribution(distributionId: string): void {
    for (const [key, entry] of [...this.entries]) if (entry.distributionId === distributionId) this.remove(key);
    this.generations.delete(distributionId); this.counters.delete(distributionId);
  }

  diagnostics(distributionId: string): Record<string, number> {
    const entries = [...this.entries.values()].filter(entry => entry.distributionId === distributionId);
    const metrics = this.metrics(distributionId);
    return { entries: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.body.length, 0), ...metrics, generation: this.generation(distributionId) };
  }

  private remove(key: string): void { const entry = this.entries.get(key); if (!entry) return; this.entries.delete(key); this.bytes -= entry.body.length; }
  private evict(): void {
    while (this.entries.size > this.maximumEntries || this.bytes > this.maximumBytes) {
      const candidate = [...this.entries.values()].sort((a, b) => a.accessedAt - b.accessedAt || a.key.localeCompare(b.key))[0];
      if (!candidate) break;
      this.remove(candidate.key); const metrics = this.metrics(candidate.distributionId); metrics.evictions += 1; this.counters.set(candidate.distributionId, metrics);
    }
  }
}

export function matchesInvalidation(pattern: string, uri: string): boolean {
  return pattern.endsWith("*") ? uri.startsWith(pattern.slice(0, -1)) : uri === pattern;
}
