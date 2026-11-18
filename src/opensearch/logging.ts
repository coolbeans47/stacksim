import type { DomainRecord } from "./model.js";
import type { StateStore } from "../state.js";
import type { Clock } from "../core/clock.js";
import { AwsError } from "../errors.js";
import type { SearchObservation } from "./engine.js";

export type SearchLogType = "ES_APPLICATION_LOGS" | "SEARCH_SLOW_LOGS" | "INDEX_SLOW_LOGS" | "AUDIT_LOGS";
export interface SearchLogPort {
  validate(domain: Pick<DomainRecord, "arn" | "accountId" | "region" | "generation">, type: SearchLogType, groupArn: string): void;
  publish(domain: DomainRecord, type: SearchLogType, groupArn: string, event: { timestamp: number; message: string }): Promise<void>;
}
export const SLOW_LEVELS = ["warn", "info", "debug", "trace"] as const;
export const SLOW_SETTINGS = ["search.slowlog.threshold.query", "indexing.slowlog.threshold.index"].flatMap(prefix => SLOW_LEVELS.map(level => `${prefix}.${level}`));
export function slowMilliseconds(value: string): number {
  if (value === "-1") return Infinity;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(value);
  return match ? Number(match[1]) * (match[2] === "m" ? 60000 : match[2] === "s" ? 1000 : 1) : NaN;
}

/** Publishing failure is observable, but cannot revoke an acknowledged write. */
export class SearchLogging {
  private port?: SearchLogPort;
  constructor(private readonly store: StateStore, private readonly clock: Clock) {}
  configure(port: SearchLogPort): void { this.port = port; }
  validate(domain: Pick<DomainRecord, "arn" | "accountId" | "region" | "generation">, options: Record<string, any>): void {
    for (const [type, option] of Object.entries(options)) if (option.Enabled) {
      if (!this.port) throw new AwsError("ValidationException", "OpenSearch log delivery is unavailable");
      this.port.validate(domain, type as SearchLogType, option.CloudWatchLogsLogGroupArn);
    }
  }
  async event(domain: DomainRecord, type: SearchLogType, message: Record<string, any>): Promise<void> {
    const options = domain.config.LogPublishingOptions?.[type]; if (!options?.Enabled || !this.port) return;
    try {
      await this.port.publish(domain, type, options.CloudWatchLogsLogGroupArn, { timestamp: this.clock.now(), message: JSON.stringify({ provider: "stacksim-embedded", domain: domain.name, ...message }) });
      if (domain.logDeliveryFailures?.[type]) { delete domain.logDeliveryFailures[type]; await this.store.save(); }
    } catch (error) {
      const previous = domain.logDeliveryFailures?.[type];
      domain.logDeliveryFailures ??= {};
      domain.logDeliveryFailures[type] = { count: (previous?.count ?? 0) + 1, at: this.clock.now(), message: error instanceof AwsError ? error.message.slice(0, 512) : "CloudWatch Logs delivery failed" };
      try { await this.store.save(); } catch { /* Preserve the delivery failure in memory. */ }
    }
  }
  async request(domain: DomainRecord, method: string, path: string, status: number, observation?: SearchObservation): Promise<void> {
    // Neither query strings, request bodies, documents nor credentials enter logs.
    const pathname = path.split("?")[0];
    if (status >= 500) await this.event(domain, "ES_APPLICATION_LOGS", { level: "ERROR", event: "request_failed", method, path: pathname, status });
    const operation = pathname.split("/").filter(Boolean).find(part => part.startsWith("_"));
    const kind = ["_search", "_msearch", "_count"].includes(operation ?? "") ? "search" : !["GET", "HEAD"].includes(method) && ["_doc", "_create", "_update", "_bulk"].includes(operation ?? "") ? "index" : undefined;
    if (!kind || !observation || status >= 400) return;
    for (const index of observation.indexes) {
      const prefix = kind === "search" ? "search.slowlog.threshold.query" : "indexing.slowlog.threshold.index";
      const level = SLOW_LEVELS.find(level => observation.durationMs >= slowMilliseconds(index.settings[`${prefix}.${level}`] ?? "-1"));
      if (level) await this.event(domain, kind === "search" ? "SEARCH_SLOW_LOGS" : "INDEX_SLOW_LOGS", { level: level.toUpperCase(), event: `slow_${kind}_request`, index: index.name, method, path: pathname, status, took_millis: observation.durationMs });
    }
  }
}
