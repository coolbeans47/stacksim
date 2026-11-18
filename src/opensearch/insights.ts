import { createHash, randomUUID } from "node:crypto";
import type { StateStore } from "../state.js";
import type { Clock } from "../core/clock.js";
import { PaginationTokens } from "../core/pagination.js";
import { AwsError } from "../errors.js";
import { exact, object, reject } from "./validation.js";
import type { DomainRecord } from "./model.js";
import capabilities from "../../docs/opensearch-capabilities.json" with { type: "json" };

export const INSIGHT_ACTIONS = new Set(["ListInsights", "DescribeInsightDetails", "InsightFeedback"]);
interface Observation { key: string; name: string; priority: "CRITICAL" | "HIGH" | "MEDIUM"; summary: string; action: string; metric?: { name: string; value: number; unit: string } }
export interface DomainInsight extends Observation { id: string; state: "ACTIVE" | "RESOLVED"; createdAt: number; updatedAt: number; feedback?: { thumbs: "Up" | "Down"; text?: string; at: number } }
interface InsightPorts { domains(region: string, accountId: string): DomainRecord[]; metrics(domain: DomainRecord): { indexes: number; documentBytes: number } | undefined }

/** Insights are persisted observations of actual local state, never AWS fleet predictions. */
export class SearchInsights {
  constructor(private readonly store: StateStore, private readonly clock: Clock, private readonly ports: InsightPorts) {}
  private observe(domain: DomainRecord): { values: Observation[]; checked: Set<string> } {
    const values: Observation[] = [], checked = new Set(["domain", "backup", "maintenance", "configuration", ...["ES_APPLICATION_LOGS", "INDEX_SLOW_LOGS", "SEARCH_SLOW_LOGS", "AUDIT_LOGS"].map(type => `log:${type}`)]);
    if (domain.state === "failed" || domain.state === "deleting" && domain.failure) values.push({ key: "domain", name: "Embedded domain unavailable", priority: "CRITICAL", summary: domain.failure ?? "The embedded search endpoint or storage is unavailable.", action: "Check persistent storage, encryption material and the reserved endpoint port. Restore a matching stopped backup or retry the failed operation." });
    if (domain.automaticBackups?.failure) values.push({ key: "backup", name: "Automatic backup attempt failed", priority: "HIGH", summary: domain.automaticBackups.failure.message, action: "Review automatic backup status and local storage. Restore matching backup key/material files if they are missing; wait for a successful attempt before relying on a new recovery point." });
    for (const [type, failure] of Object.entries(domain.logDeliveryFailures ?? {})) if (domain.config.LogPublishingOptions?.[type]?.Enabled) values.push({ key: `log:${type}`, name: `${type} delivery failed`, priority: "HIGH", summary: failure.message, action: "Verify that the log group exists and its resource policy allows es.amazonaws.com to create streams and publish events for this domain.", metric: { name: "Failed delivery attempts", value: failure.count, unit: "Count" } });
    const maintenance = domain.maintenances?.at(-1); if (maintenance && ["FAILED", "TIMED_OUT"].includes(maintenance.state)) values.push({ key: "maintenance", name: "Embedded maintenance failed", priority: "HIGH", summary: maintenance.message, action: "Resolve the reported storage or endpoint error, then submit a new maintenance request." });
    const change = domain.changes?.at(-1); if (change?.state === "FAILED") values.push({ key: "configuration", name: "Domain configuration change failed", priority: "HIGH", summary: change.failure ?? "The last configuration change did not complete.", action: "Review the configuration change history, correct the reported issue and submit a new configuration change." });
    const metrics = this.ports.metrics(domain);
    if (metrics) {
      checked.add("index-capacity"); checked.add("document-capacity");
      if (metrics.indexes >= capabilities.limits.indexesPerDomain * 0.8) values.push({ key: "index-capacity", name: "Embedded index capacity is nearly full", priority: "MEDIUM", summary: `${metrics.indexes} of the ${capabilities.limits.indexesPerDomain} available index slots are in use.`, action: "Remove unneeded indexes or consolidate data before creating more indexes.", metric: { name: "Indexes", value: metrics.indexes, unit: "Count" } });
      if (metrics.documentBytes >= capabilities.limits.documentStorageBytes * 0.8) values.push({ key: "document-capacity", name: "Embedded document capacity is nearly full", priority: "MEDIUM", summary: `${metrics.documentBytes} of the ${capabilities.limits.documentStorageBytes} source-byte capacity is in use.`, action: "Remove unneeded documents or reduce stored source size. Increasing an AWS instance descriptor does not change the embedded capacity.", metric: { name: "Document source bytes", value: metrics.documentBytes, unit: "Bytes" } });
    }
    return { values, checked };
  }
  private async refresh(domains: DomainRecord[]): Promise<void> {
    const previous = domains.map(domain => ({ domain, insights: structuredClone(domain.insights) })); let changed = false;
    for (const domain of domains) {
      const { values, checked } = this.observe(domain), now = this.clock.now();
      if (!values.length && !domain.insights?.length) continue;
      const records = domain.insights ??= [];
      for (const value of values) {
        const existing = records.find(item => item.key === value.key && item.state === "ACTIVE");
        if (!existing) { records.push({ ...value, id: randomUUID(), state: "ACTIVE", createdAt: now, updatedAt: now }); changed = true; }
        else if (existing.summary !== value.summary || JSON.stringify(existing.metric) !== JSON.stringify(value.metric)) { Object.assign(existing, value, { updatedAt: now }); changed = true; }
      }
      for (const item of records) if (item.state === "ACTIVE" && checked.has(item.key) && !values.some(value => value.key === item.key)) { item.state = "RESOLVED"; item.updatedAt = now; changed = true; }
      while (records.length > 100) { const oldest = records.findIndex(item => item.state === "RESOLVED"); records.splice(oldest >= 0 ? oldest : 0, 1); changed = true; }
    }
    if (changed) try { await this.store.save(); } catch (error) { previous.forEach(({ domain, insights }) => { if (insights) domain.insights = insights; else delete domain.insights; }); throw error; }
  }
  async execute(operation: string, input: any, region: string, accountId: string): Promise<any> {
    if (!INSIGHT_ACTIONS.has(operation)) reject("Unsupported insight operation");
    object(input, operation);
    exact(input, operation === "ListInsights" ? ["Entity", "TimeRange", "SortOrder", "MaxResults", "NextToken"] : operation === "DescribeInsightDetails" ? ["Entity", "InsightId", "ShowHtmlContent"] : ["Entity", "InsightId", "Thumbs", "FeedbackText"], operation);
    const entity = object(input.Entity, "Entity"); exact(entity, ["Type", "Value"], "Entity");
    if (!["Account", "DomainName"].includes(entity.Type) || entity.Type === "Account" && entity.Value !== undefined && entity.Value !== accountId) reject("Insights require a domain or the caller's account");
    if (entity.Type === "DomainName" && (typeof entity.Value !== "string" || !/^[a-z][a-z0-9-]{2,27}$/.test(entity.Value))) reject("Entity.Value must name a domain");
    if (operation !== "ListInsights" && entity.Type !== "DomainName") reject("Insight details and feedback require a domain entity");
    if (operation === "DescribeInsightDetails" && input.ShowHtmlContent !== undefined && input.ShowHtmlContent !== false) reject("Insight details support plain text only");
    if (operation === "InsightFeedback" && (!["Up", "Down"].includes(input.Thumbs) || input.FeedbackText !== undefined && (typeof input.FeedbackText !== "string" || input.FeedbackText.length > 1000))) reject("Feedback requires Up or Down and at most 1000 text characters");
    const size = input.MaxResults ?? 100, sort = input.SortOrder ?? "DESC";
    if (operation === "ListInsights") {
      if (!Number.isInteger(size) || size < 1 || size > 500 || !["ASC", "DESC"].includes(sort)) reject("Invalid insight pagination or sort order");
      if (input.TimeRange !== undefined) { const range = object(input.TimeRange, "TimeRange"); exact(range, ["From", "To"], "TimeRange"); if (![range.From, range.To].every(value => Number.isSafeInteger(value) && value >= 0) || range.From > range.To) reject("Insight TimeRange requires ordered epoch millisecond values"); }
    }
    return this.store.withMutationLock(`opensearch:insights:${accountId}:${region}`, async () => {
      const domains = this.ports.domains(region, accountId).filter(domain => entity.Type === "Account" || domain.name === entity.Value);
      if (entity.Type === "DomainName" && !domains.length) throw new AwsError("ResourceNotFoundException", "Insight domain does not exist", 409);
      await this.refresh(domains);
      if (operation === "ListInsights") {
        const records = domains.flatMap(domain => domain.insights ?? []).filter(item => !input.TimeRange || item.createdAt >= input.TimeRange.From && item.createdAt <= input.TimeRange.To).sort((a, b) => (sort === "ASC" ? 1 : -1) * (a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
        const list = records.map(item => ({ InsightId: item.id, DisplayName: item.name, Type: item.metric ? "RECOMMENDATION" : "EVENT", Priority: item.priority, Status: item.state, CreationTime: item.createdAt / 1000, UpdateTime: item.updatedAt / 1000, IsExperimental: true }));
        const state = this.store.regionState(region, accountId).opensearch; if (!state.insightCursorKey) { state.insightCursorKey = randomUUID(); try { await this.store.save(); } catch (error) { delete state.insightCursorKey; throw error; } }
        const tokens = new PaginationTokens(state.insightCursorKey), scope = `${accountId}:${region}:${JSON.stringify(entity)}:${JSON.stringify(input.TimeRange)}:${sort}`, fingerprint = createHash("sha256").update(JSON.stringify(list)).digest("hex"); let offset = 0;
        if (input.NextToken !== undefined) try { if (typeof input.NextToken !== "string" || input.NextToken.length > 4096) throw new Error(); const cursor = tokens.decode<{ offset: number; fingerprint: string; expires: number }>(scope, input.NextToken); if (cursor.fingerprint !== fingerprint || cursor.expires <= this.clock.now() || !Number.isInteger(cursor.offset) || cursor.offset < 1 || cursor.offset >= list.length) throw new Error(); offset = cursor.offset; } catch { reject("Invalid or stale insight pagination token"); }
        return { Insights: list.slice(offset, offset + size), ...(offset + size < list.length ? { NextToken: tokens.encode(scope, { offset: offset + size, fingerprint, expires: this.clock.now() + 600000 }) } : {}) };
      }
      const domain = domains[0], item = domain.insights?.find(item => item.id === input.InsightId); if (!item) throw new AwsError("ResourceNotFoundException", "Insight does not exist for this domain", 409);
      if (operation === "InsightFeedback") { const previous = item.feedback; item.feedback = { thumbs: input.Thumbs, ...(input.FeedbackText === undefined ? {} : { text: input.FeedbackText }), at: this.clock.now() }; try { await this.store.save(); } catch (error) { if (previous) item.feedback = previous; else delete item.feedback; throw error; } return { Status: "SUCCESS" }; }
      return { Fields: [{ Name: "DomainName", Type: "text", Value: domain.name }, { Name: "Summary", Type: "text", Value: item.summary }, { Name: "SuggestedAction", Type: "text", Value: item.action }, { Name: "Source", Type: "text", Value: "Observed StackSim embedded state; AWS fleet predictions are unavailable." }, ...(item.metric ? [{ Name: "Observation", Type: "metric", Value: JSON.stringify(item.metric) }] : []), ...(item.feedback ? [{ Name: "Feedback", Type: "text", Value: JSON.stringify(item.feedback) }] : [])] };
    });
  }
}
