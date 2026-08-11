import { createHash } from "node:crypto";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import { AwsError } from "./errors.js";
import { resolveExtractedValue } from "./cloudwatch-log-filter.js";
import type { StateStore } from "./state.js";
import type { CloudWatchInsightRuleState, DynamoIndexState, TableState } from "./types.js";

export const CLOUDWATCH_INSIGHT_RULE_ACTIONS = ["PutInsightRule", "DescribeInsightRules", "DeleteInsightRules", "EnableInsightRules", "DisableInsightRules", "GetInsightRuleReport", "PutManagedInsightRules", "ListManagedInsightRules"] as const;

export interface ContributorLogEvent {
  timestamp: number;
  ingestionTime: number;
  message: string;
  logGroupName: string;
  logStreamName: string;
}

export interface ManagedContributorObservation {
  timestamp: number;
  keys: string[];
  value: number;
}

export interface ManagedContributorResult {
  keyLabels: string[];
  observations: ManagedContributorObservation[];
}

type LogReader = (selectors: string[], start: number, end: number) => Promise<ContributorLogEvent[]>;
type ManagedReader = (resourceArn: string, templateName: string, start: number, end: number) => Promise<ManagedContributorResult>;

type FilterOperator = "In" | "NotIn" | "StartsWith" | "GreaterThan" | "LessThan" | "EqualTo" | "NotEqualTo" | "IsPresent";
interface ParsedFilter { selector: string; operator: FilterOperator; operand: string[] | number | boolean }
interface ParsedRule {
  selectors: string[];
  format: "JSON" | "CLF";
  fields: Record<string, number>;
  keys: string[];
  valueOf?: string;
  filters: ParsedFilter[];
  aggregate: "Count" | "Sum";
}

const METRICS = new Set(["UniqueContributors", "MaxContributorValue", "SampleCount", "Sum", "Minimum", "Maximum", "Average"]);
const MANAGED_TEMPLATES = ["DynamoDBContributorInsights-PKC", "DynamoDBContributorInsights-SKC", "DynamoDBContributorInsights-PKT", "DynamoDBContributorInsights-SKT"] as const;

function list<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function ruleName(value: unknown): string {
  const name = String(value ?? "");
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) throw new AwsError("InvalidParameterValue", "RuleName must contain 1-128 letters, numbers, periods, hyphens, or underscores");
  return name;
}
function tags(value: unknown): Record<string, string> {
  const values = list<any>(value); if (values.length > 50) throw new AwsError("LimitExceeded", "A maximum of 50 tags is allowed"); const result: Record<string, string> = {};
  for (const item of values) { const key = String(item?.Key ?? ""); const tagValue = String(item?.Value ?? ""); if (!key || key.length > 128 || key.startsWith("aws:") || /[\x00-\x1f]/.test(key) || tagValue.length > 256 || /[\x00-\x1f]/.test(tagValue) || Object.hasOwn(result, key)) throw new AwsError("InvalidParameterValue", "Contributor Insights tag is invalid or duplicated"); result[key] = tagValue; }
  return result;
}
function numberTime(value: unknown, label: string): number {
  const time = value instanceof Date ? value.getTime() : typeof value === "number" ? (value < 10_000_000_000 ? value * 1000 : value) : Date.parse(String(value ?? ""));
  if (!Number.isFinite(time)) throw new AwsError("InvalidParameterValue", `${label} must be a valid timestamp`); return time;
}
function failure(resource: string, code: string, description: string): any { return { FailureResource: resource, ExceptionType: code, FailureCode: code, FailureDescription: description }; }
function isRecord(value: unknown): value is Record<string, any> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function jsonSelector(value: unknown, label: string): string {
  const selector = String(value ?? ""); if (!/^\$\.(?:[A-Za-z0-9_@-]+|\[[0-9]+])(?:\.(?:[A-Za-z0-9_@-]+)|\[[0-9]+])*$/.test(selector)) throw new AwsError("InvalidParameterValue", `${label} must be a supported JSON field path such as $.user.id`); return selector;
}

function parseDefinition(value: unknown): ParsedRule {
  const definition = String(value ?? ""); const bytes = Buffer.byteLength(definition); if (bytes < 1 || bytes > 8192 || /[^\x00-\x7f]/.test(definition)) throw new AwsError("InvalidParameterValue", "RuleDefinition must contain 1-8192 ASCII bytes");
  let root: any; try { root = JSON.parse(definition); } catch { throw new AwsError("InvalidParameterValue", "RuleDefinition must be valid JSON"); }
  if (!isRecord(root) || !isRecord(root.Schema) || root.Schema.Name !== "CloudWatchLogRule" || root.Schema.Version !== 1) throw new AwsError("InvalidParameterValue", "RuleDefinition Schema must be CloudWatchLogRule version 1");
  if (root.LogGroupARNs !== undefined) throw new AwsError("InvalidParameterValue", "LogGroupARNs and cross-account source groups are not available in the single-account local subset; use LogGroupNames");
  const selectors = list<any>(root.LogGroupNames).map(String); if (!selectors.length || selectors.length > 20 || new Set(selectors).size !== selectors.length || selectors.some(selector => !selector || selector.length > 512 || selector.includes(":") || (selector.includes("*") && !selector.endsWith("*")) || (selector.match(/\*/g)?.length ?? 0) > 1)) throw new AwsError("InvalidParameterValue", "LogGroupNames must contain 1-20 unique names or trailing-prefix wildcards");
  const format = String(root.LogFormat ?? "").toUpperCase(); if (format !== "JSON" && format !== "CLF") throw new AwsError("InvalidParameterValue", "LogFormat must be JSON or CLF");
  const fields: Record<string, number> = {};
  if (format === "CLF") {
    if (root.Fields !== undefined && !isRecord(root.Fields)) throw new AwsError("InvalidParameterValue", "CLF Fields must map one-based positions to aliases");
    for (const [position, alias] of Object.entries(root.Fields ?? {})) { const index = Number(position); const name = String(alias); if (!Number.isInteger(index) || index < 1 || index > 100 || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(name) || Object.hasOwn(fields, name)) throw new AwsError("InvalidParameterValue", "CLF Fields contains an invalid position or duplicate alias"); fields[name] = index; }
  } else if (root.Fields !== undefined) throw new AwsError("InvalidParameterValue", "Fields is supported only with CLF log format");
  if (!isRecord(root.Contribution)) throw new AwsError("InvalidParameterValue", "Contribution is required"); const contribution = root.Contribution;
  const selector = (candidate: unknown, label: string): string => { const result = String(candidate ?? ""); if (format === "JSON") return jsonSelector(result, label); if (/^\$?[1-9][0-9]?$/.test(result)) return `$${result.replace(/^\$/, "")}`; if (Object.hasOwn(fields, result)) return result; throw new AwsError("InvalidParameterValue", `${label} must be a CLF field position or declared alias`); };
  const keys = list<any>(contribution.Keys).map((item, index) => selector(item, `Contribution.Keys[${index}]`)); if (!keys.length || keys.length > 4 || new Set(keys).size !== keys.length) throw new AwsError("InvalidParameterValue", "Contribution.Keys must contain 1-4 unique fields");
  const aggregate = String(root.AggregateOn ?? ""); if (aggregate !== "Count" && aggregate !== "Sum") throw new AwsError("InvalidParameterValue", "AggregateOn must be Count or Sum");
  const valueOf = contribution.ValueOf === undefined ? undefined : selector(contribution.ValueOf, "Contribution.ValueOf"); if (aggregate === "Sum" && !valueOf) throw new AwsError("InvalidParameterValue", "Sum rules require Contribution.ValueOf"); if (aggregate === "Count" && valueOf) throw new AwsError("InvalidParameterValue", "Count rules cannot specify Contribution.ValueOf");
  const filterValues = list<any>(contribution.Filters); if (filterValues.length > 4) throw new AwsError("InvalidParameterValue", "Contribution.Filters supports at most four filters"); const filters: ParsedFilter[] = filterValues.map((item, index) => {
    if (!isRecord(item)) throw new AwsError("InvalidParameterValue", `Contribution.Filters[${index}] must be an object`); const match = selector(item.Match, `Contribution.Filters[${index}].Match`); const operators = Object.keys(item).filter(key => key !== "Match") as FilterOperator[]; if (operators.length !== 1 || !["In", "NotIn", "StartsWith", "GreaterThan", "LessThan", "EqualTo", "NotEqualTo", "IsPresent"].includes(operators[0])) throw new AwsError("InvalidParameterValue", `Contribution.Filters[${index}] must contain exactly one supported operator`); const operator = operators[0]; const raw = item[operator];
    if (["In", "NotIn", "StartsWith"].includes(operator)) { const operand = list<any>(raw); if (!operand.length || operand.length > 10 || operand.some(value => typeof value !== "string")) throw new AwsError("InvalidParameterValue", `${operator} requires 1-10 strings`); return { selector: match, operator, operand: operand.map(String) }; }
    if (operator === "IsPresent") { if (typeof raw !== "boolean") throw new AwsError("InvalidParameterValue", "IsPresent requires a boolean"); return { selector: match, operator, operand: raw }; }
    if (typeof raw !== "number" || !Number.isFinite(raw)) throw new AwsError("InvalidParameterValue", `${operator} requires a number`); return { selector: match, operator, operand: raw };
  });
  return { selectors, format, fields, keys, ...(valueOf ? { valueOf } : {}), filters, aggregate };
}

function clfValues(message: string): string[] {
  const values: string[] = []; let value = ""; let quote = ""; let escaped = false;
  for (const character of message.trim()) { if (escaped) { value += character; escaped = false; } else if (character === "\\" && quote) escaped = true; else if (quote) { if (character === quote) quote = ""; else value += character; } else if (character === '"' || character === "'") quote = character; else if (/\s/.test(character)) { if (value) { values.push(value); value = ""; } } else value += character; }
  if (value) values.push(value); return values;
}

function observedValue(rule: ParsedRule, message: string, selector: string): string | undefined {
  if (rule.format === "JSON") return resolveExtractedValue(selector, {}, message);
  const values = clfValues(message); const position = selector.startsWith("$") ? Number(selector.slice(1)) : rule.fields[selector]; return position ? values[position - 1] : undefined;
}

function filterMatches(rule: ParsedRule, message: string, filter: ParsedFilter): boolean {
  const raw = observedValue(rule, message, filter.selector); if (filter.operator === "IsPresent") return (raw !== undefined) === filter.operand;
  if (raw === undefined) return false; if (filter.operator === "In") return (filter.operand as string[]).includes(raw); if (filter.operator === "NotIn") return !(filter.operand as string[]).includes(raw); if (filter.operator === "StartsWith") return (filter.operand as string[]).some(value => raw.startsWith(value));
  const numeric = Number(raw); if (!Number.isFinite(numeric)) return false; const operand = filter.operand as number; if (filter.operator === "GreaterThan") return numeric > operand; if (filter.operator === "LessThan") return numeric < operand; if (filter.operator === "EqualTo") return numeric === operand; return numeric !== operand;
}

function windowContains(rule: CloudWatchInsightRuleState, time: number): boolean { return rule.collectionWindows.some(window => time >= window.start && (window.end === undefined || time <= window.end)); }
function normalizeDynamoValue(value: any): string {
  if (!isRecord(value)) return String(value ?? ""); if (typeof value.S === "string") return value.S; if (typeof value.N === "string") return value.N; if (typeof value.B === "string") return value.B; if (typeof value.BOOL === "boolean") return String(value.BOOL); if (value.NULL === true) return "null"; return JSON.stringify(value);
}

export class CloudWatchInsightRuleEngine {
  private readonly tokens: PaginationTokens;
  private logReader?: LogReader;
  constructor(private readonly store: StateStore, private readonly region: string, private readonly clock: Clock, private readonly managedReader: ManagedReader) { this.tokens = new PaginationTokens(store.state.installation.paginationSecret); }
  setLogReader(reader: LogReader): void { this.logReader = reader; }
  private get control(): Record<string, CloudWatchInsightRuleState> { return this.store.regionState(this.region).cloudwatch.insightRules; }
  private arn(name: string): string { return `arn:aws:cloudwatch:${this.region}:${this.store.accountId}:insight-rule/${name}`; }
  private require(value: unknown): CloudWatchInsightRuleState { const name = ruleName(value); const rule = this.control[name]; if (!rule) throw new AwsError("ResourceNotFoundException", `Contributor Insights rule ${name} does not exist`, 404); return rule; }
  private view(rule: CloudWatchInsightRuleState): any { return { Name: rule.name, State: rule.state, Schema: JSON.stringify({ Name: rule.managedRule ? "ServiceLogRule" : "CloudWatchLogRule", Version: 1 }), Definition: rule.definition, ...(rule.managedRule ? { ManagedRule: true } : {}), ApplyOnTransformedLogs: rule.applyOnTransformedLogs }; }

  async PutInsightRule(input: any): Promise<Record<string, never>> {
    const name = ruleName(input.RuleName); parseDefinition(input.RuleDefinition); const state = String(input.RuleState ?? "ENABLED"); if (state !== "ENABLED" && state !== "DISABLED") throw new AwsError("InvalidParameterValue", "RuleState must be ENABLED or DISABLED"); const existing = this.control[name]; if (existing?.managedRule) throw new AwsError("InvalidParameterValue", "Managed Contributor Insights rules cannot be replaced with PutInsightRule"); if (!existing && Object.keys(this.control).length >= 100) throw new AwsError("LimitExceeded", "The local account supports at most 100 Contributor Insights rules");
    const now = this.clock.now(); const unchanged = Boolean(existing && existing.definition === String(input.RuleDefinition)); const opening = state === "ENABLED" ? [{ start: now }] : []; this.control[name] = { name, arn: this.arn(name), definition: String(input.RuleDefinition), state: unchanged ? existing!.state : state, applyOnTransformedLogs: input.ApplyOnTransformedLogs === true, tags: existing?.tags ?? tags(input.Tags), managedRule: false, createdAt: existing?.createdAt ?? now, updatedAt: now, collectionWindows: unchanged ? structuredClone(existing!.collectionWindows) : opening };
    if (unchanged) this.transitionOne(this.control[name], state as "ENABLED" | "DISABLED", now); await this.store.save(); return {};
  }

  async DescribeInsightRules(input: any): Promise<any> {
    const max = input.MaxResults === undefined ? 500 : Number(input.MaxResults); if (!Number.isInteger(max) || max < 1 || max > 500) throw new AwsError("InvalidParameterValue", "MaxResults must be between 1 and 500"); let index = 0; if (input.NextToken) try { index = this.tokens.decode<{ index: number }>("DescribeInsightRules", String(input.NextToken)).index; } catch { throw new AwsError("InvalidNextToken", "The next token is invalid"); }
    const rules = Object.values(this.control).sort((left, right) => left.name.localeCompare(right.name)); const page = rules.slice(index, index + max); const next = index + page.length; return { InsightRules: page.map(rule => this.view(rule)), ...(next < rules.length ? { NextToken: this.tokens.encode("DescribeInsightRules", { index: next }) } : {}) };
  }

  private names(input: any): string[] { const names = list<any>(input.RuleNames).map(ruleName); if (!names.length || names.length > 100 || new Set(names).size !== names.length) throw new AwsError("InvalidParameterValue", "RuleNames must contain 1-100 unique rule names"); return names; }
  private transitionOne(rule: CloudWatchInsightRuleState, state: "ENABLED" | "DISABLED", now: number): void {
    if (rule.state === state) return; if (state === "ENABLED") rule.collectionWindows.push({ start: now }); else { const current = [...rule.collectionWindows].reverse().find(window => window.end === undefined); if (current) current.end = now; } rule.state = state; rule.updatedAt = now;
  }
  private async batch(input: any, operation: "delete" | "enable" | "disable"): Promise<any> {
    const failures: any[] = []; const now = this.clock.now(); const affected = new Set<string>();
    for (const name of this.names(input)) { const rule = this.control[name]; if (!rule) { failures.push(failure(name, "ResourceNotFoundException", `Contributor Insights rule ${name} does not exist`)); continue; } if (operation === "delete") { if (rule.managedResourceArn) affected.add(rule.managedResourceArn); delete this.control[name]; } else { this.transitionOne(rule, operation === "enable" ? "ENABLED" : "DISABLED", now); if (rule.managedResourceArn) affected.add(rule.managedResourceArn); } }
    for (const resourceArn of affected) this.syncDynamoTelemetry(resourceArn); await this.store.save(); return failures.length ? { Failures: failures } : { Failures: [] };
  }
  async DeleteInsightRules(input: any): Promise<any> { return this.batch(input, "delete"); }
  async EnableInsightRules(input: any): Promise<any> { return this.batch(input, "enable"); }
  async DisableInsightRules(input: any): Promise<any> { return this.batch(input, "disable"); }

  private async observations(rule: CloudWatchInsightRuleState, parsed: ParsedRule, start: number, end: number): Promise<ManagedContributorResult> {
    if (rule.managedRule) { const result = await this.managedReader(rule.managedResourceArn!, rule.managedTemplateName!, start, end); return { ...result, observations: result.observations.filter(item => windowContains(rule, item.timestamp)) }; }
    if (!this.logReader) throw new AwsError("InternalServiceError", "CloudWatch Logs is not connected", 500); const events = await this.logReader(parsed.selectors, start, end); const observations: ManagedContributorObservation[] = [];
    for (const event of events) { if (!windowContains(rule, event.ingestionTime) || !parsed.filters.every(filter => filterMatches(parsed, event.message, filter))) continue; const keys = parsed.keys.map(key => observedValue(parsed, event.message, key)); if (keys.some(value => value === undefined)) continue; let value = 1; if (parsed.aggregate === "Sum") { const raw = observedValue(parsed, event.message, parsed.valueOf!); value = Number(raw); if (!Number.isFinite(value) || value < -1_000_000_000 || value > 1_000_000_000) continue; } observations.push({ timestamp: event.timestamp, keys: keys as string[], value }); }
    return { keyLabels: parsed.keys, observations };
  }

  async GetInsightRuleReport(input: any): Promise<any> {
    const rule = this.require(input.RuleName); const parsed = rule.managedRule ? ({ aggregate: "Count" } as ParsedRule) : parseDefinition(rule.definition); const start = numberTime(input.StartTime, "StartTime"); const end = numberTime(input.EndTime, "EndTime"); if (start >= end) throw new AwsError("InvalidParameterValue", "StartTime must be before EndTime"); const period = Number(input.Period); if (!Number.isInteger(period) || period < 1 || period > 86_400) throw new AwsError("InvalidParameterValue", "Period must be between 1 and 86400 seconds"); const maximum = input.MaxContributorCount === undefined ? 10 : Number(input.MaxContributorCount); if (!Number.isInteger(maximum) || maximum < 1 || maximum > 100) throw new AwsError("InvalidParameterValue", "MaxContributorCount must be between 1 and 100"); const metrics = input.Metrics === undefined ? ["UniqueContributors", "MaxContributorValue", "SampleCount", "Sum", "Minimum", "Maximum", "Average"] : list<any>(input.Metrics).map(String); if (!metrics.length || new Set(metrics).size !== metrics.length || metrics.some(metric => !METRICS.has(metric))) throw new AwsError("InvalidParameterValue", "Metrics contains an unsupported or duplicate statistic"); const orderBy = String(input.OrderBy ?? "Sum"); if (orderBy !== "Sum" && orderBy !== "Maximum") throw new AwsError("InvalidParameterValue", "OrderBy must be Sum or Maximum");
    const source = await this.observations(rule, parsed, start, end); const step = period * 1000; const buckets = new Map<number, ManagedContributorObservation[]>(); for (const item of source.observations) { const at = Math.floor(item.timestamp / step) * step; const values = buckets.get(at) ?? []; values.push(item); buckets.set(at, values); } const contributors = new Map<string, { keys: string[]; observations: ManagedContributorObservation[] }>(); for (const item of source.observations) { const key = JSON.stringify(item.keys); const current = contributors.get(key) ?? { keys: item.keys, observations: [] }; current.observations.push(item); contributors.set(key, current); }
    const ranked = [...contributors.entries()].sort(([leftKey, left], [rightKey, right]) => { const score = (value: typeof left) => orderBy === "Sum" ? value.observations.reduce((sum, item) => sum + item.value, 0) : Math.max(...value.observations.map(item => item.value)); return score(right) - score(left) || leftKey.localeCompare(rightKey); }).slice(0, maximum);
    const metricDatapoints = [...buckets.entries()].sort(([left], [right]) => left - right).map(([timestamp, values]) => { const grouped = new Map<string, number>(); for (const item of values) grouped.set(JSON.stringify(item.keys), (grouped.get(JSON.stringify(item.keys)) ?? 0) + item.value); const raw = values.map(item => item.value); const datapoint: any = { Timestamp: new Date(timestamp) }; if (metrics.includes("UniqueContributors")) datapoint.UniqueContributors = grouped.size; if (metrics.includes("MaxContributorValue")) datapoint.MaxContributorValue = Math.max(...grouped.values()); if (metrics.includes("SampleCount")) datapoint.SampleCount = values.length; if (metrics.includes("Sum")) datapoint.Sum = raw.reduce((sum, value) => sum + value, 0); if (metrics.includes("Minimum")) datapoint.Minimum = Math.min(...raw); if (metrics.includes("Maximum")) datapoint.Maximum = Math.max(...raw); if (metrics.includes("Average")) datapoint.Average = raw.reduce((sum, value) => sum + value, 0) / raw.length; return datapoint; });
    return { KeyLabels: source.keyLabels, AggregationStatistic: parsed.aggregate.toUpperCase(), AggregateValue: source.observations.reduce((sum, item) => sum + item.value, 0), ApproximateUniqueCount: contributors.size, Contributors: ranked.map(([, contributor]) => { const byBucket = new Map<number, number>(); for (const item of contributor.observations) { const at = Math.floor(item.timestamp / step) * step; byBucket.set(at, (byBucket.get(at) ?? 0) + item.value); } return { Keys: contributor.keys, ApproximateAggregateValue: contributor.observations.reduce((sum, item) => sum + item.value, 0), Datapoints: [...byBucket.entries()].sort(([left], [right]) => left - right).map(([Timestamp, ApproximateValue]) => ({ Timestamp: new Date(Timestamp), ApproximateValue })) }; }), MetricDatapoints: metricDatapoints };
  }

  private resource(value: unknown): { arn: string; table: TableState; index?: DynamoIndexState; key: string } {
    const arn = String(value ?? ""); const match = arn.match(/^arn:(?:aws|aws-us-gov|aws-cn):dynamodb:([^:]+):(\d{12}):table\/([A-Za-z0-9_.-]{3,255})(?:\/index\/([A-Za-z0-9_.-]{3,255}))?$/); if (!match || match[1] !== this.region || match[2] !== this.store.accountId) throw new AwsError("InvalidParameterValue", "ResourceARN must identify a DynamoDB table or global secondary index in this simulator account and Region"); const table = this.store.regionState(this.region).tables[match[3]]; if (!table) throw new AwsError("ResourceNotFoundException", `DynamoDB table ${match[3]} does not exist`, 404); const index = match[4] ? table.globalSecondaryIndexes?.find(item => item.indexName === match[4]) : undefined; if (match[4] && !index) throw new AwsError("ResourceNotFoundException", `DynamoDB index ${match[4]} does not exist`, 404); return { arn, table, ...(index ? { index } : {}), key: index?.indexName ?? "__TABLE__" };
  }
  private templates(resource: ReturnType<CloudWatchInsightRuleEngine["resource"]>): string[] { const sorted = (resource.index?.keySchema ?? resource.table.keySchema).some(key => key.KeyType === "RANGE"); return [MANAGED_TEMPLATES[0], ...(sorted ? [MANAGED_TEMPLATES[1]] : []), MANAGED_TEMPLATES[2], ...(sorted ? [MANAGED_TEMPLATES[3]] : [])]; }
  private managedName(templateName: string, resourceArn: string): string { const suffix = resourceArn.split(":table/").at(-1)!.replace(/\/index\//, "-").replace(/[^A-Za-z0-9_.-]/g, "-"); const candidate = `${templateName}-${suffix}`; return candidate.length <= 128 ? candidate : `${candidate.slice(0, 111)}-${createHash("sha256").update(candidate).digest("hex").slice(0, 16)}`; }
  private managedDefinition(templateName: string, resourceArn: string): string { return JSON.stringify({ Schema: { Name: "ServiceLogRule", Version: 1 }, Service: "DynamoDB", ResourceARN: resourceArn, TemplateName: templateName }); }
  private syncDynamoTelemetry(resourceArn: string): void {
    let resource: ReturnType<CloudWatchInsightRuleEngine["resource"]>; try { resource = this.resource(resourceArn); } catch { return; } const enabled = Object.values(this.control).filter(rule => rule.managedResourceArn === resourceArn && rule.state === "ENABLED"); const previous = resource.table.contributorInsights[resource.key]; const now = this.clock.now(); resource.table.contributorInsights[resource.key] = { status: enabled.length ? "ENABLED" : "DISABLED", mode: enabled.some(rule => rule.managedTemplateName?.endsWith("C")) ? "ACCESSED_AND_THROTTLED_KEYS" : "THROTTLED_KEYS", lastUpdatedAt: now, ruleCreatedAt: previous?.ruleCreatedAt ?? now };
  }
  async PutManagedInsightRules(input: any): Promise<any> {
    const values = list<any>(input.ManagedRules); if (!values.length || values.length > 100) throw new AwsError("InvalidParameterValue", "ManagedRules must contain 1-100 entries"); const failures: any[] = [];
    for (const item of values) { const templateName = String(item?.TemplateName ?? ""); const resourceArn = String(item?.ResourceARN ?? ""); try { const resource = this.resource(resourceArn); if (!this.templates(resource).includes(templateName)) throw new AwsError("InvalidParameterValue", `Managed template ${templateName || "(missing)"} is not available for ${resourceArn}`); const name = this.managedName(templateName, resourceArn); const existing = this.control[name]; if (existing && !existing.managedRule) throw new AwsError("ResourceInUseException", `Rule name ${name} is already used by a custom rule`); const now = this.clock.now(); this.control[name] = { name, arn: this.arn(name), definition: this.managedDefinition(templateName, resourceArn), state: existing?.state ?? "ENABLED", applyOnTransformedLogs: false, tags: existing?.tags ?? tags(item.Tags), managedRule: true, managedTemplateName: templateName, managedResourceArn: resourceArn, createdAt: existing?.createdAt ?? now, updatedAt: now, collectionWindows: existing ? structuredClone(existing.collectionWindows) : [{ start: now }] }; if (existing?.state === "DISABLED") this.transitionOne(this.control[name], "ENABLED", now); this.syncDynamoTelemetry(resourceArn); } catch (error) { const aws = error instanceof AwsError ? error : new AwsError("InternalServiceError", String(error)); failures.push(failure(`${templateName}:${resourceArn}`, aws.code, aws.message)); } }
    await this.store.save(); return { Failures: failures };
  }
  async ListManagedInsightRules(input: any): Promise<any> {
    const resource = this.resource(input.ResourceARN); const max = input.MaxResults === undefined ? 100 : Number(input.MaxResults); if (!Number.isInteger(max) || max < 1 || max > 500) throw new AwsError("InvalidParameterValue", "MaxResults must be between 1 and 500"); let index = 0; if (input.NextToken) try { const cursor = this.tokens.decode<{ index: number; resourceArn: string }>("ListManagedInsightRules", String(input.NextToken)); if (cursor.resourceArn !== resource.arn) throw new Error(); index = cursor.index; } catch { throw new AwsError("InvalidNextToken", "The next token is invalid"); } const values = this.templates(resource); const page = values.slice(index, index + max); const next = index + page.length; return { ManagedRules: page.map(TemplateName => { const name = this.managedName(TemplateName, resource.arn); const rule = this.control[name]; return { TemplateName, ...(rule ? { ResourceARN: resource.arn, RuleState: { RuleName: rule.name, State: rule.state } } : {}) }; }), ...(next < values.length ? { NextToken: this.tokens.encode("ListManagedInsightRules", { index: next, resourceArn: resource.arn }) } : {}) };
  }

  hasResourceArn(value: unknown): boolean { const arn = String(value ?? ""); return Object.values(this.control).some(rule => rule.arn === arn); }
  private taggedResource(value: unknown): CloudWatchInsightRuleState { const arn = String(value ?? ""); const rule = Object.values(this.control).find(item => item.arn === arn); if (!rule) throw new AwsError("ResourceNotFound", `CloudWatch resource ${arn} does not exist`, 404); return rule; }
  async TagResource(input: any): Promise<Record<string, never>> { const rule = this.taggedResource(input.ResourceARN); const next = { ...rule.tags, ...tags(input.Tags) }; if (Object.keys(next).length > 50) throw new AwsError("LimitExceeded", "A maximum of 50 tags is allowed"); rule.tags = next; rule.updatedAt = this.clock.now(); await this.store.save(); return {}; }
  async UntagResource(input: any): Promise<Record<string, never>> { const rule = this.taggedResource(input.ResourceARN); for (const key of list<any>(input.TagKeys).map(String)) delete rule.tags[key]; rule.updatedAt = this.clock.now(); await this.store.save(); return {}; }
  async ListTagsForResource(input: any): Promise<any> { const rule = this.taggedResource(input.ResourceARN); return { Tags: Object.entries(rule.tags).sort(([left], [right]) => left.localeCompare(right)).map(([Key, Value]) => ({ Key, Value })) }; }
}

export function decodeDynamoContributorKey(raw: string, schema: Array<{ AttributeName: string; KeyType: "HASH" | "RANGE" }>, templateName: string): string[] | undefined {
  if (raw.startsWith("sha256:")) return [raw]; let value: any; try { value = JSON.parse(raw); } catch { return undefined; } const type = templateName.split("-").at(-1) ?? ""; const key = schema.find(item => item.KeyType === (type.startsWith("SK") ? "RANGE" : "HASH")); if (!key || value[key.AttributeName] === undefined) return undefined; return [normalizeDynamoValue(value[key.AttributeName])];
}
