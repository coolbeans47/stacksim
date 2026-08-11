import { createHash } from "node:crypto";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import type { Scheduler } from "./core/scheduler.js";
import { AwsError } from "./errors.js";
import type { LambdaService } from "./lambda.js";
import type { StateStore } from "./state.js";
import type { CloudWatchAlarmCommonState, CloudWatchAlarmHistoryState, CloudWatchAlarmMuteRuleState, CloudWatchAlarmState, CloudWatchAlarmStateValue, CloudWatchAnyAlarmState, CloudWatchComparisonOperator, CloudWatchCompositeAlarmState, CloudWatchEventBridgeOutboxState, CloudWatchLambdaActionOutboxState, CloudWatchLogAlarmContributorState, CloudWatchLogAlarmState, CloudWatchSnsActionOutboxState } from "./types.js";
import { id } from "./util.js";
import { parseAlarmRule } from "./cloudwatch-alarm-rule.js";

export interface AlarmSeries {
  values: Map<number, number>;
  sampleCounts: Map<number, number>;
  period: number;
}

export type AlarmSeriesReader = (metricStat: any, start: number, end: number) => Promise<AlarmSeries>;
export type AlarmMetricDataReader = (input: any) => Promise<any>;
export type AlarmLogQueryReader = (configuration: CloudWatchLogAlarmState["scheduledQueryConfiguration"], start: number, end: number, lineCount: number) => Promise<{ values: Array<{ value: number; attributes: Record<string, string> }>; logLines: string[]; partial: boolean }>;
export type AlarmLogQueryValidator = (configuration: CloudWatchLogAlarmState["scheduledQueryConfiguration"]) => void;
export type AlarmEventPublisher = (event: { detailType: "CloudWatch Alarm State Change" | "CloudWatch Alarm Configuration Change"; source: "aws.cloudwatch"; resources: string[]; time: number; detail: Record<string, unknown>; deliveryLineage?: string[] }) => Promise<void>;
export type AlarmSnsPublisher = (topicArn: string, message: string, alarmArn: string, deliveryLineage?: string[]) => Promise<void>;
export const CLOUDWATCH_ALARM_ACTIONS = ["PutMetricAlarm", "PutCompositeAlarm", "PutLogAlarm", "DescribeAlarms", "DescribeAlarmsForMetric", "DescribeAlarmContributors", "DeleteAlarms", "SetAlarmState", "EnableAlarmActions", "DisableAlarmActions", "DescribeAlarmHistory", "PutAlarmMuteRule", "GetAlarmMuteRule", "ListAlarmMuteRules", "DeleteAlarmMuteRule", "TagResource", "UntagResource", "ListTagsForResource"] as const;

const STATIC_COMPARISONS = new Set<CloudWatchComparisonOperator>(["GreaterThanThreshold", "GreaterThanOrEqualToThreshold", "LessThanThreshold", "LessThanOrEqualToThreshold"]);
const ANOMALY_COMPARISONS = new Set<CloudWatchComparisonOperator>(["LessThanLowerOrGreaterThanUpperThreshold", "LessThanLowerThreshold", "GreaterThanUpperThreshold"]);
const STATISTICS = new Set(["SampleCount", "Average", "Sum", "Minimum", "Maximum"]);
const UNITS = new Set(["Seconds", "Microseconds", "Milliseconds", "Bytes", "Kilobytes", "Megabytes", "Gigabytes", "Terabytes", "Bits", "Kilobits", "Megabits", "Gigabits", "Terabits", "Percent", "Count", "Bytes/Second", "Kilobytes/Second", "Megabytes/Second", "Gigabytes/Second", "Terabytes/Second", "Bits/Second", "Kilobits/Second", "Megabits/Second", "Gigabits/Second", "Terabits/Second", "Count/Second", "None"]);
const MISSING = new Set(["breaching", "notBreaching", "ignore", "missing"]);
const LOW_SAMPLE = new Set(["evaluate", "ignore"]);
const DEFAULT_HISTORY_RETENTION_MS = 30 * 86_400_000;
const LAMBDA_ALARM_SERVICE_PRINCIPAL = "lambda.alarms.cloudwatch.amazonaws.com";
const LAMBDA_ACTION_OUTBOX_MAX_AGE_MS = 86_400_000;

function list<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function integer(value: unknown, field: string, min: number, max: number): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new AwsError("InvalidParameterValue", `${field} must be an integer between ${min} and ${max}`); return parsed; }
function finite(value: unknown, field: string): number { const parsed = Number(value); if (!Number.isFinite(parsed)) throw new AwsError("InvalidParameterValue", `${field} must be a finite number`); return parsed; }
function name(value: unknown): string { const result = String(value ?? ""); if (!result || result.length > 255 || result.includes(":") || /[\x00-\x1f]/.test(result)) throw new AwsError("InvalidParameterValue", "AlarmName is invalid"); return result; }
function percentileName(value: string): boolean { const match = value.match(/^p(100(?:\.0{1,10})?|\d{1,2}(?:\.\d{1,10})?)$/i); return Boolean(match && Number(match[1]) >= 0 && Number(match[1]) <= 100); }
function canonical(value: unknown): string { if (value instanceof Date) return value.toISOString(); if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); }
function signature(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function timestamp(value: unknown): number { const result = value instanceof Date ? value.getTime() : typeof value === "number" ? value < 1e12 ? value * 1000 : value : Date.parse(String(value)); if (!Number.isFinite(result)) throw new AwsError("InvalidParameterValue", "Timestamp is invalid"); return result; }
function alarmArn(region: string, accountId: string, alarmName: string): string { return `arn:aws:cloudwatch:${region}:${accountId}:alarm:${alarmName}`; }
function scheduleRateMs(value: unknown): number { const match = String(value ?? "").trim().match(/^rate\(\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*\)$/i); if (!match) throw new AwsError("InvalidParameterValue", "ScheduleExpression must be a rate expression in minutes, hours, or days"); const amount = Number(match[1]); const singular = !match[2].toLowerCase().endsWith("s"); if (!Number.isInteger(amount) || amount < 1 || (amount === 1) !== singular) throw new AwsError("InvalidParameterValue", "ScheduleExpression has invalid rate grammar"); const unit = match[2].toLowerCase(); const milliseconds = amount * (unit.startsWith("minute") ? 60_000 : unit.startsWith("hour") ? 3_600_000 : 86_400_000); if (milliseconds > 86_400_000) throw new AwsError("InvalidParameterValue", "Scheduled log alarm rates cannot exceed one day"); return milliseconds; }
function muteDurationMs(value: unknown): number { const text = String(value ?? ""); const match = text.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/); if (!match || (!match[1] && !match[2] && !match[3])) throw new AwsError("InvalidParameterValue", "Mute duration must use ISO 8601 days, hours, and minutes"); const milliseconds = (Number(match[1] ?? 0) * 1440 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 60_000; if (milliseconds < 60_000 || milliseconds > 15 * 86_400_000) throw new AwsError("InvalidParameterValue", "Mute duration must be between one minute and 15 days"); return milliseconds; }
function validTimezone(value: unknown): string { const timezone = value === undefined ? "UTC" : String(value); if (!timezone || timezone.length > 50) throw new AwsError("InvalidParameterValue", "Mute schedule timezone is invalid"); try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0); } catch { throw new AwsError("InvalidParameterValue", "Mute schedule timezone must be a tz database identifier"); } return timezone; }
interface LocalMinute { year: number; month: number; day: number; hour: number; minute: number; weekday: number }
const WEEKDAYS: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }; const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
function localMinute(at: number, timezone: string): LocalMinute { const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(at); const part = (type: string) => parts.find(item => item.type === type)?.value ?? ""; return { year: Number(part("year")), month: Number(part("month")), day: Number(part("day")), hour: Number(part("hour")), minute: Number(part("minute")), weekday: WEEKDAYS[part("weekday").toUpperCase()] }; }
function localAtEpoch(expression: string, timezone: string): number { const match = expression.match(/^at\((\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})\)$/); if (!match) throw new AwsError("InvalidParameterValue", "One-time mute schedules must use at(yyyy-MM-ddThh:mm)"); const wanted = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]) }; const center = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute); for (let candidate = center - 36 * 3_600_000; candidate <= center + 36 * 3_600_000; candidate += 60_000) { const local = localMinute(candidate, timezone); if (local.year === wanted.year && local.month === wanted.month && local.day === wanted.day && local.hour === wanted.hour && local.minute === wanted.minute) return candidate; } throw new AwsError("InvalidParameterValue", "The one-time mute schedule does not identify a valid local minute"); }
const cronCache = new Map<string, (minute: LocalMinute) => boolean>();
function cronMatcher(expression: string): (minute: LocalMinute) => boolean {
  const cached = cronCache.get(expression); if (cached) return cached; const match = expression.match(/^cron\((.*)\)$/i); if (!match) throw new AwsError("InvalidParameterValue", "Recurring mute schedules must use cron(minutes hours day-of-month month day-of-week)"); const fields = match[1].trim().split(/\s+/); if (fields.length !== 5) throw new AwsError("InvalidParameterValue", "Mute cron expressions require five fields");
  const parse = (field: string, min: number, max: number, names: Record<string, number> = {}) => { if (field === "*" || field === "?") return (_value: number) => true; const allowed = new Set<number>(); for (const item of field.split(",")) { const range = item.split("-"); if (range.length > 2) throw new AwsError("InvalidParameterValue", "Mute cron expression is invalid"); const number = (token: string) => Object.hasOwn(names, token.toUpperCase()) ? names[token.toUpperCase()] : /^\d+$/.test(token) ? Number(token) : NaN; const start = number(range[0]); const end = number(range[1] ?? range[0]); if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) throw new AwsError("InvalidParameterValue", "Mute cron expression is invalid"); for (let value = start; value <= end; value++) allowed.add(value); } return (value: number) => allowed.has(value); };
  const minute = parse(fields[0], 0, 59); const hour = parse(fields[1], 0, 23); const day = parse(fields[2], 1, 31); const month = parse(fields[3], 1, 12, MONTHS); const weekday = parse(fields[4], 0, 6, WEEKDAYS); const compiled = (value: LocalMinute) => minute(value.minute) && hour(value.hour) && day(value.day) && month(value.month) && weekday(value.weekday); cronCache.set(expression, compiled); return compiled;
}
function parseTags(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const tag of list<any>(value as any)) {
    const key = String(tag?.Key ?? ""); const item = String(tag?.Value ?? "");
    if (!key || key.length > 128 || key.startsWith("aws:") || item.length > 256) throw new AwsError("InvalidParameterValue", "A tag key or value is invalid");
    result[key] = item;
  }
  if (Object.keys(result).length > 50) throw new AwsError("InvalidParameterValue", "A maximum of 50 tags is allowed");
  return result;
}
function actionArns(value: unknown, field: string): string[] {
  const values = list<any>(value as any).map(String); if (values.length > 5) throw new AwsError("LimitExceeded", `${field} supports at most five actions`);
  if (values.some(item => item.length > 1024 || !/^arn:[^:]+:[^:]+:[^:]*:[^:]*:.+/.test(item))) throw new AwsError("InvalidParameterValue", `${field} contains an invalid action ARN`);
  return values;
}
function dimensions(value: unknown): Array<{ Name: string; Value: string }> {
  const result = list<any>(value as any).map(item => ({ Name: String(item?.Name ?? ""), Value: String(item?.Value ?? "") })).sort((a, b) => a.Name.localeCompare(b.Name) || a.Value.localeCompare(b.Value));
  if (result.length > 30 || result.some(item => !item.Name || !item.Value || item.Name.length > 255 || item.Value.length > 1024) || new Set(result.map(item => item.Name)).size !== result.length) throw new AwsError("InvalidParameterValue", "Dimensions are invalid");
  return result;
}
function sameDimensions(left: Array<{ Name: string; Value: string }> = [], right: Array<{ Name: string; Value: string }> = []): boolean { return left.length === right.length && left.every((item, index) => item.Name === right[index].Name && item.Value === right[index].Value); }
function isComposite(alarm: CloudWatchAnyAlarmState): alarm is CloudWatchCompositeAlarmState { return "alarmRule" in alarm; }
function isLog(alarm: CloudWatchAnyAlarmState): alarm is CloudWatchLogAlarmState { return "scheduledQueryConfiguration" in alarm; }

export class CloudWatchAlarmEngine {
  private lambda?: LambdaService;
  private readLogQuery?: AlarmLogQueryReader;
  private validateLogQuery?: AlarmLogQueryValidator;
  private publishEvent?: AlarmEventPublisher;
  private publisherDrain?: Promise<void>;
  private cancelPublisherRetry?: () => void;
  private publisherStarted = false;
  private publishSns?: AlarmSnsPublisher;
  private snsPublisherDrain?: Promise<void>;
  private cancelSnsPublisherRetry?: () => void;
  private lambdaPublisherDrain?: Promise<void>;
  private cancelLambdaPublisherRetry?: () => void;

  constructor(
    private readonly store: StateStore,
    private readonly region: string,
    private readonly clock: Clock,
    private readonly readSeries: AlarmSeriesReader,
    private readonly readMetricData: AlarmMetricDataReader,
    private readonly historyRetentionMs = DEFAULT_HISTORY_RETENTION_MS,
    private readonly scheduler?: Scheduler,
  ) {
    if (!Number.isFinite(historyRetentionMs) || historyRetentionMs <= 0) throw new Error("Alarm history retention must be positive");
  }

  setLambdaService(lambda: LambdaService): void { this.lambda = lambda; }
  setLogQueryService(validate: AlarmLogQueryValidator, read: AlarmLogQueryReader): void { this.validateLogQuery = validate; this.readLogQuery = read; }
  setEventPublisher(publisher: AlarmEventPublisher): void { this.publishEvent = publisher; if (this.publisherStarted) void this.drainEventBridgeOutbox(); }
  setSnsPublisher(publisher: AlarmSnsPublisher): void { this.publishSns = publisher; if (this.publisherStarted) void this.drainSnsOutbox(); }
  start(): void { this.publisherStarted = true; void this.drainEventBridgeOutbox(); void this.drainSnsOutbox(); void this.drainLambdaOutbox(); }
  async stop(): Promise<void> { this.publisherStarted = false; this.cancelPublisherRetry?.(); this.cancelPublisherRetry = undefined; this.cancelSnsPublisherRetry?.(); this.cancelSnsPublisherRetry = undefined; this.cancelLambdaPublisherRetry?.(); this.cancelLambdaPublisherRetry = undefined; await Promise.all([this.publisherDrain?.catch(() => undefined), this.snsPublisherDrain?.catch(() => undefined), this.lambdaPublisherDrain?.catch(() => undefined)]); }
  private get tokens(): PaginationTokens { return new PaginationTokens(this.store.state.installation.paginationSecret); }
  private get control() { return this.store.regionState(this.region).cloudwatch; }
  private requireAlarm(alarmName: string): CloudWatchAnyAlarmState { const alarm = this.control.alarms[alarmName] ?? this.control.compositeAlarms[alarmName] ?? this.control.logAlarms[alarmName]; if (!alarm) throw new AwsError("ResourceNotFound", `Alarm ${alarmName} does not exist`); return alarm; }
  private allAlarms(): CloudWatchAnyAlarmState[] { return [...Object.values(this.control.alarms), ...Object.values(this.control.compositeAlarms), ...Object.values(this.control.logAlarms)]; }
  private referenceName(reference: string): string { const match = reference.match(/^arn:([^:]+):cloudwatch:([^:]+):(\d{12}):alarm:(.+)$/); if (!match) return name(reference); if (match[2] !== this.region || match[3] !== this.store.accountId) throw new AwsError("InvalidParameterValue", "Composite alarm references must use this account and Region"); return name(match[4]); }
  private pruneHistory(): boolean { const cutoff = this.clock.now() - this.historyRetentionMs; const previous = this.control.alarmHistory; const retained = previous.filter(item => item.timestamp >= cutoff); if (retained.length === previous.length) return false; this.control.alarmHistory = retained; return true; }
  private history(alarmName: string, type: CloudWatchAlarmHistoryState["historyItemType"], summary: string, data: unknown, at = this.clock.now(), alarmType?: CloudWatchAlarmHistoryState["alarmType"], contributor?: { id: string; attributes: Record<string, string> }): void { this.pruneHistory(); this.control.alarmHistory.push({ alarmName, alarmType: alarmType ?? (this.control.compositeAlarms[alarmName] ? "CompositeAlarm" : this.control.logAlarms[alarmName] ? "LogAlarm" : "MetricAlarm"), timestamp: at, historyItemType: type, historySummary: summary, historyData: JSON.stringify(data), ...(contributor ? { alarmContributorId: contributor.id, alarmContributorAttributes: structuredClone(contributor.attributes) } : {}) }); }

  private eventMetrics(alarm: CloudWatchAlarmState): Array<Record<string, unknown>> {
    const source = alarm.metrics ?? [{ Id: "m1", MetricStat: { Metric: { Namespace: alarm.namespace, MetricName: alarm.metricName, Dimensions: alarm.dimensions }, Period: alarm.period, Stat: alarm.statistic ?? alarm.extendedStatistic, Unit: alarm.unit }, ReturnData: true }];
    return source.map(raw => {
      const query = raw as any; const metricStat = query.MetricStat ?? query.metricStat; const metric = metricStat?.Metric ?? metricStat?.metric;
      const dimensionsValue = metric?.Dimensions ?? metric?.dimensions; const dimensionsRecord = Array.isArray(dimensionsValue)
        ? Object.fromEntries(dimensionsValue.map((item: any) => [String(item.Name ?? item.name), String(item.Value ?? item.value)]))
        : dimensionsValue;
      return {
        id: query.Id ?? query.id,
        ...(query.Expression !== undefined || query.expression !== undefined ? { expression: query.Expression ?? query.expression } : {}),
        ...(query.Label !== undefined || query.label !== undefined ? { label: query.Label ?? query.label } : {}),
        ...(query.ReturnData !== undefined || query.returnData !== undefined ? { returnData: query.ReturnData ?? query.returnData } : {}),
        ...(query.Period !== undefined || query.period !== undefined ? { period: query.Period ?? query.period } : {}),
        ...(query.AccountId !== undefined || query.accountId !== undefined ? { accountId: query.AccountId ?? query.accountId } : {}),
        ...(metricStat ? { metricStat: {
          metric: {
            namespace: metric?.Namespace ?? metric?.namespace,
            name: metric?.MetricName ?? metric?.name,
            ...(dimensionsRecord && Object.keys(dimensionsRecord).length ? { dimensions: dimensionsRecord } : {}),
          },
          period: metricStat.Period ?? metricStat.period,
          stat: metricStat.Stat ?? metricStat.stat,
          ...(metricStat.Unit !== undefined || metricStat.unit !== undefined ? { unit: metricStat.Unit ?? metricStat.unit } : {}),
        } } : {}),
      };
    });
  }

  private logEventConfiguration(alarm: CloudWatchLogAlarmState): Record<string, unknown> {
    const query = alarm.scheduledQueryConfiguration;
    return {
      logGroupIdentifiers: [...query.logGroupIdentifiers],
      queryString: query.queryString,
      aggregationExpression: query.aggregationExpression,
      scheduledQueryRoleARN: query.scheduledQueryRoleArn,
      ...(alarm.actionLogLineRoleArn ? { actionLogLineRoleArn: alarm.actionLogLineRoleArn } : {}),
      actionLogLineCount: alarm.actionLogLineCount,
      schedule: {
        expression: query.scheduleConfiguration.scheduleExpression,
        ...(query.scheduleConfiguration.startTimeOffset !== undefined ? { startTimeOffset: query.scheduleConfiguration.startTimeOffset } : {}),
        ...(query.scheduleConfiguration.endTimeOffset !== undefined ? { endTimeOffset: query.scheduleConfiguration.endTimeOffset } : {}),
      },
      threshold: alarm.threshold,
      comparisonOperator: alarm.comparisonOperator,
      treatMissingData: alarm.treatMissingData,
      queryResultsToEvaluate: alarm.queryResultsToEvaluate,
      queryResultsToAlarm: alarm.queryResultsToAlarm,
    };
  }

  private eventConfiguration(alarm: CloudWatchAnyAlarmState, at = alarm.configurationUpdatedTimestamp): Record<string, unknown> {
    const common: Record<string, unknown> = { alarmName: alarm.alarmName, ...(alarm.alarmDescription !== undefined ? { description: alarm.alarmDescription } : {}), actionsEnabled: alarm.actionsEnabled, timestamp: new Date(at).toISOString(), okActions: alarm.okActions, alarmActions: alarm.alarmActions, insufficientDataActions: alarm.insufficientDataActions };
    if (isComposite(alarm)) return { alarmRule: alarm.alarmRule, ...(alarm.actionsSuppressor ? { actionsSuppressor: alarm.actionsSuppressor, actionsSuppressorWaitPeriod: alarm.actionsSuppressorWaitPeriod, actionsSuppressorExtensionPeriod: alarm.actionsSuppressorExtensionPeriod } : {}), ...common };
    if (isLog(alarm)) return { ...this.logEventConfiguration(alarm), ...common };
    return { evaluationPeriods: alarm.evaluationPeriods, datapointsToAlarm: alarm.datapointsToAlarm, ...(alarm.threshold !== undefined ? { threshold: alarm.threshold } : {}), ...(alarm.thresholdMetricId !== undefined ? { thresholdMetricId: alarm.thresholdMetricId } : {}), comparisonOperator: alarm.comparisonOperator, treatMissingData: alarm.treatMissingData, metrics: this.eventMetrics(alarm), ...common };
  }

  private stateEventConfiguration(alarm: CloudWatchAnyAlarmState): Record<string, unknown> {
    if (isComposite(alarm)) return { alarmRule: alarm.alarmRule, ...(alarm.actionsSuppressor ? { actionsSuppressor: alarm.actionsSuppressor, actionsSuppressorWaitPeriod: alarm.actionsSuppressorWaitPeriod, actionsSuppressorExtensionPeriod: alarm.actionsSuppressorExtensionPeriod } : {}) };
    if (isLog(alarm)) return { ...this.logEventConfiguration(alarm), alarmName: alarm.alarmName, ...(alarm.alarmDescription !== undefined ? { description: alarm.alarmDescription } : {}), actionsEnabled: alarm.actionsEnabled, timestamp: new Date(alarm.configurationUpdatedTimestamp).toISOString(), okActions: alarm.okActions, alarmActions: alarm.alarmActions, insufficientDataActions: alarm.insufficientDataActions };
    return { ...(alarm.alarmDescription !== undefined ? { description: alarm.alarmDescription } : {}), metrics: this.eventMetrics(alarm) };
  }

  private enqueueEventBridgeEvent(event: Parameters<AlarmEventPublisher>[0]): void {
    this.control.eventBridgeOutbox.push({
      id: id(32),
      detailType: event.detailType,
      source: event.source,
      resources: [...event.resources],
      time: event.time,
      detail: structuredClone(event.detail),
      ...(event.deliveryLineage?.length ? { deliveryLineage: [...event.deliveryLineage] } : {}),
      createdAt: this.clock.now(),
      attempts: 0,
      nextAttemptAt: this.clock.now(),
    });
  }

  private get snsOutbox(): CloudWatchSnsActionOutboxState[] {
    return (this.control.snsActionOutbox ??= []);
  }

  private get lambdaOutbox(): CloudWatchLambdaActionOutboxState[] {
    return (this.control.lambdaActionOutbox ??= []);
  }

  private transitionActionId(alarm: CloudWatchAnyAlarmState, at: number, previous: { value: CloudWatchAlarmStateValue; reason: string; timestamp: number }, actionArn: string, contributor?: { id: string }, state?: CloudWatchAlarmStateValue): string {
    return signature({ alarmArn: alarm.alarmArn, transitionAt: at, newState: state ?? alarm.stateValue, previousState: previous.value, actionArn, ...(contributor ? { contributorId: contributor.id } : {}) });
  }

  private enqueueLambdaAction(alarm: CloudWatchAnyAlarmState, functionArn: string, event: Record<string, unknown>, previous: { value: CloudWatchAlarmStateValue; reason: string; timestamp: number }, at: number, contributor?: { id: string; attributes: Record<string, string> }, state?: CloudWatchAlarmStateValue): void {
    const actionState = state ?? alarm.stateValue;
    const actionId = this.transitionActionId(alarm, at, previous, functionArn, contributor, actionState);
    if (this.lambdaOutbox.some(item => item.id === actionId)) return;
    this.lambdaOutbox.push({
      id: actionId,
      functionArn,
      payloadBase64: Buffer.from(JSON.stringify(event)).toString("base64"),
      alarmName: alarm.alarmName,
      state: actionState,
      transitionAt: at,
      createdAt: at,
      attempts: 0,
      nextAttemptAt: this.clock.now(),
      deliveryLineage: [alarm.alarmArn],
      ...(contributor ? { contributor: structuredClone(contributor) } : {}),
    });
    this.history(alarm.alarmName, contributor ? "AlarmContributorAction" : "Action", `Lambda action ${functionArn} queued for durable delivery`, { action: functionArn, state: actionState, status: "Queued", transitionActionId: actionId }, at, contributor ? "LogAlarm" : undefined, contributor);
    void this.drainLambdaOutbox();
  }

  private scheduleLambdaRetry(delayMs: number): void {
    this.cancelLambdaPublisherRetry?.();
    this.cancelLambdaPublisherRetry = undefined;
    if (!this.publisherStarted || !this.scheduler) return;
    try {
      this.cancelLambdaPublisherRetry = this.scheduler.schedule(() => {
        this.cancelLambdaPublisherRetry = undefined;
        return this.drainLambdaOutbox();
      }, Math.max(0, delayMs));
    } catch {}
  }

  private retryableLambdaHandoffError(error: unknown): boolean {
    return error instanceof AwsError && (error.status >= 500 || error.status === 429 || error.code === "ResourceConflictException");
  }

  private async drainLambdaOutbox(): Promise<void> {
    if (!this.publisherStarted || !this.lambda || this.lambdaPublisherDrain) return this.lambdaPublisherDrain;
    const running = (async () => {
      while (this.publisherStarted && this.lambda && this.lambdaOutbox.length) {
        const pending = this.lambdaOutbox[0];
        const now = this.clock.now();
        if (now - pending.createdAt >= LAMBDA_ACTION_OUTBOX_MAX_AGE_MS) {
          this.history(pending.alarmName, pending.contributor ? "AlarmContributorAction" : "Action", `Failed to execute action ${pending.functionArn}`, { action: pending.functionArn, state: pending.state, status: "Failed", transitionActionId: pending.id, error: "Alarm action delivery exceeded the maximum outbox age" }, now, pending.contributor ? "LogAlarm" : undefined, pending.contributor);
          this.lambdaOutbox.shift();
          await this.store.save();
          continue;
        }
        const delay = pending.nextAttemptAt - now;
        if (delay > 0) { this.scheduleLambdaRetry(delay); return; }
        try {
          await this.lambda.enqueueServiceInvocation(
            pending.functionArn,
            Buffer.from(pending.payloadBase64, "base64"),
            LAMBDA_ALARM_SERVICE_PRINCIPAL,
            alarmArn(this.region, this.store.accountId, pending.alarmName),
            this.store.accountId,
            pending.deliveryLineage,
            pending.id,
          );
          this.history(pending.alarmName, pending.contributor ? "AlarmContributorAction" : "Action", `Successfully executed action ${pending.functionArn}`, { action: pending.functionArn, state: pending.state, status: "Succeeded", transitionActionId: pending.id }, now, pending.contributor ? "LogAlarm" : undefined, pending.contributor);
          this.lambdaOutbox.shift();
          await this.store.save();
        } catch (error) {
          pending.attempts++;
          const message = error instanceof Error ? error.message : String(error);
          if (!this.retryableLambdaHandoffError(error)) {
            this.history(pending.alarmName, pending.contributor ? "AlarmContributorAction" : "Action", `Failed to execute action ${pending.functionArn}`, { action: pending.functionArn, state: pending.state, status: "Failed", transitionActionId: pending.id, error: message.slice(0, 256) }, now, pending.contributor ? "LogAlarm" : undefined, pending.contributor);
            this.lambdaOutbox.shift();
            await this.store.save().catch(() => undefined);
            continue;
          }
          const backoff = Math.min(60_000, 1_000 * 2 ** Math.min(6, pending.attempts - 1));
          pending.nextAttemptAt = now + backoff;
          this.history(pending.alarmName, pending.contributor ? "AlarmContributorAction" : "Action", `Lambda action ${pending.functionArn} delivery will be retried`, { action: pending.functionArn, state: pending.state, status: "Retrying", transitionActionId: pending.id, error: message.slice(0, 256) }, now, pending.contributor ? "LogAlarm" : undefined, pending.contributor);
          await this.store.save().catch(() => undefined);
          this.scheduleLambdaRetry(backoff);
          return;
        }
      }
    })();
    this.lambdaPublisherDrain = running;
    try { await running; } finally { if (this.lambdaPublisherDrain === running) this.lambdaPublisherDrain = undefined; }
  }

  private enqueueSnsAction(alarm: CloudWatchAnyAlarmState, topicArn: string, previous: { value: CloudWatchAlarmStateValue; reason: string; timestamp: number }, at: number, contributor?: { id: string; attributes: Record<string, string> }): void {
    const configuration = isComposite(alarm)
      ? { AlarmRule: alarm.alarmRule }
      : isLog(alarm)
        ? { ScheduledQueryConfiguration: this.logView(alarm).ScheduledQueryConfiguration }
        : { Metrics: this.eventMetrics(alarm) };
    const message = JSON.stringify({
      AlarmName: alarm.alarmName,
      AlarmDescription: alarm.alarmDescription ?? "",
      AWSAccountId: this.store.accountId,
      AlarmConfigurationUpdatedTimestamp: new Date(alarm.configurationUpdatedTimestamp).toISOString(),
      NewStateValue: alarm.stateValue,
      NewStateReason: alarm.stateReason,
      StateChangeTime: new Date(at).toISOString(),
      Region: this.region,
      AlarmArn: alarm.alarmArn,
      OldStateValue: previous.value,
      OKActions: alarm.okActions,
      AlarmActions: alarm.alarmActions,
      InsufficientDataActions: alarm.insufficientDataActions,
      Trigger: configuration,
    });
    this.snsOutbox.push({ id: id(32), topicArn, message, alarmName: alarm.alarmName, state: alarm.stateValue, createdAt: at, attempts: 0, nextAttemptAt: at, deliveryLineage: [alarm.alarmArn], ...(contributor ? { contributor: structuredClone(contributor) } : {}) });
    this.history(alarm.alarmName, contributor ? "AlarmContributorAction" : "Action", `SNS action ${topicArn} queued for durable delivery`, { action: topicArn, state: alarm.stateValue, status: "Queued" }, at, undefined, contributor);
    void this.drainSnsOutbox();
  }

  private scheduleSnsRetry(delayMs: number): void {
    this.cancelSnsPublisherRetry?.();
    this.cancelSnsPublisherRetry = undefined;
    if (!this.publisherStarted || !this.scheduler) return;
    try {
      this.cancelSnsPublisherRetry = this.scheduler.schedule(() => {
        this.cancelSnsPublisherRetry = undefined;
        return this.drainSnsOutbox();
      }, Math.max(0, delayMs));
    } catch {}
  }

  private async drainSnsOutbox(): Promise<void> {
    if (!this.publisherStarted || !this.publishSns || this.snsPublisherDrain) return this.snsPublisherDrain;
    const running = (async () => {
      while (this.publisherStarted && this.publishSns && this.snsOutbox.length) {
        const pending = this.snsOutbox[0];
        const delay = pending.nextAttemptAt - this.clock.now();
        if (delay > 0) { this.scheduleSnsRetry(delay); return; }
        try {
          await this.publishSns(pending.topicArn, pending.message, `arn:aws:cloudwatch:${this.region}:${this.store.accountId}:alarm:${pending.alarmName}`, pending.deliveryLineage);
          this.history(pending.alarmName, pending.contributor ? "AlarmContributorAction" : "Action", `Successfully executed action ${pending.topicArn}`, { action: pending.topicArn, state: pending.state, status: "Succeeded" }, this.clock.now(), undefined, pending.contributor);
          this.snsOutbox.shift();
          await this.store.save();
        } catch (error) {
          pending.attempts++;
          const backoff = Math.min(60_000, 1_000 * 2 ** Math.min(6, pending.attempts - 1));
          pending.nextAttemptAt = this.clock.now() + backoff;
          this.history(pending.alarmName, pending.contributor ? "AlarmContributorAction" : "Action", `SNS action ${pending.topicArn} delivery will be retried`, { action: pending.topicArn, state: pending.state, status: "Retrying", error: error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256) }, this.clock.now(), undefined, pending.contributor);
          await this.store.save().catch(() => undefined);
          this.scheduleSnsRetry(backoff);
          return;
        }
      }
    })();
    this.snsPublisherDrain = running;
    try { await running; } finally { if (this.snsPublisherDrain === running) this.snsPublisherDrain = undefined; }
  }

  private scheduleEventBridgeRetry(delayMs: number): void {
    this.cancelPublisherRetry?.();
    this.cancelPublisherRetry = undefined;
    if (!this.publisherStarted || !this.scheduler) return;
    try {
      this.cancelPublisherRetry = this.scheduler.schedule(() => {
        this.cancelPublisherRetry = undefined;
        return this.drainEventBridgeOutbox();
      }, Math.max(0, delayMs));
    } catch {
      // The simulator is stopping. The persisted outbox will resume on the next start.
    }
  }

  private async drainEventBridgeOutbox(): Promise<void> {
    if (!this.publisherStarted || !this.publishEvent) return;
    if (this.publisherDrain) return this.publisherDrain;
    const running = (async () => {
      this.cancelPublisherRetry?.();
      this.cancelPublisherRetry = undefined;
      while (this.publisherStarted && this.publishEvent && this.control.eventBridgeOutbox.length) {
        const pending: CloudWatchEventBridgeOutboxState = this.control.eventBridgeOutbox[0];
        const delayMs = pending.nextAttemptAt - this.clock.now();
        if (delayMs > 0) { this.scheduleEventBridgeRetry(delayMs); return; }
        try {
          await this.publishEvent({
            detailType: pending.detailType,
            source: pending.source,
            resources: [...pending.resources],
            time: pending.time,
            detail: structuredClone(pending.detail),
            ...(pending.deliveryLineage?.length ? { deliveryLineage: [...pending.deliveryLineage] } : {}),
          });
        } catch {
          pending.attempts += 1;
          const backoffMs = Math.min(60_000, 1_000 * 2 ** Math.min(6, Math.max(0, pending.attempts - 1)));
          pending.nextAttemptAt = this.clock.now() + backoffMs;
          await this.store.save().catch(() => undefined);
          this.scheduleEventBridgeRetry(backoffMs);
          return;
        }
        const index = this.control.eventBridgeOutbox.findIndex(item => item.id === pending.id);
        if (index < 0) continue;
        this.control.eventBridgeOutbox.splice(index, 1);
        try { await this.store.save(); }
        catch {
          pending.attempts += 1;
          const backoffMs = Math.min(60_000, 1_000 * 2 ** Math.min(6, Math.max(0, pending.attempts - 1)));
          pending.nextAttemptAt = this.clock.now() + backoffMs;
          this.control.eventBridgeOutbox.splice(Math.min(index, this.control.eventBridgeOutbox.length), 0, pending);
          await this.store.save().catch(() => undefined);
          this.scheduleEventBridgeRetry(backoffMs);
          return;
        }
      }
    })();
    this.publisherDrain = running;
    try { await running; }
    finally {
      if (this.publisherDrain === running) this.publisherDrain = undefined;
      const next = this.control.eventBridgeOutbox[0];
      if (this.publisherStarted && next && next.nextAttemptAt <= this.clock.now() && !this.cancelPublisherRetry) void this.drainEventBridgeOutbox();
    }
  }

  private queueConfigurationEvent(alarm: CloudWatchAnyAlarmState, operation: "create" | "update" | "delete", previous?: CloudWatchAnyAlarmState, at = this.clock.now(), deliveryLineage?: string[]): void {
    const state: Record<string, unknown> = { value: alarm.stateValue, timestamp: new Date(alarm.stateUpdatedTimestamp).toISOString() };
    if (isComposite(alarm)) {
      const previousSuppression = previous && isComposite(previous) && previous.actionsSuppressor === alarm.actionsSuppressor ? previous.actionsSuppressedBy : undefined;
      const actionsSuppressedBy = alarm.actionsSuppressedBy ?? previousSuppression;
      if (actionsSuppressedBy) state.actionsSuppressedBy = actionsSuppressedBy;
    }
    const muteDetail = this.activeMuteDetail(alarm.alarmName, at);
    const detail: Record<string, unknown> = { alarmName: alarm.alarmName, operation, state, configuration: this.eventConfiguration(alarm, alarm.configurationUpdatedTimestamp), ...(previous ? { previousConfiguration: this.eventConfiguration(previous, previous.configurationUpdatedTimestamp) } : {}), ...(muteDetail ? { muteDetail } : {}) };
    this.enqueueEventBridgeEvent({ detailType: "CloudWatch Alarm Configuration Change", source: "aws.cloudwatch", resources: [alarm.alarmArn], time: at, detail, ...(deliveryLineage?.length ? { deliveryLineage: [...deliveryLineage, alarm.alarmArn].slice(-32) } : {}) });
  }

  private queueStateEvent(alarm: CloudWatchAnyAlarmState, previous: { value: CloudWatchAlarmStateValue; reason: string; reasonData: string; timestamp: number }, at: number, deliveryLineage?: string[]): void {
    const state: Record<string, unknown> = { value: alarm.stateValue, reason: alarm.stateReason, reasonData: alarm.stateReasonData, timestamp: new Date(at).toISOString() };
    if (isComposite(alarm)) { if (alarm.actionsSuppressedBy) state.actionsSuppressedBy = alarm.actionsSuppressedBy; if (alarm.actionsSuppressedReason) state.actionsSuppressedReason = alarm.actionsSuppressedReason; }
    const muteDetail = this.activeMuteDetail(alarm.alarmName, at);
    this.enqueueEventBridgeEvent({ detailType: "CloudWatch Alarm State Change", source: "aws.cloudwatch", resources: [alarm.alarmArn], time: at, detail: { alarmName: alarm.alarmName, configuration: this.stateEventConfiguration(alarm), previousState: { value: previous.value, reason: previous.reason, reasonData: previous.reasonData, timestamp: new Date(previous.timestamp).toISOString() }, state, ...(muteDetail ? { muteDetail } : {}) }, ...(deliveryLineage?.length ? { deliveryLineage: [...deliveryLineage, alarm.alarmArn].slice(-32) } : {}) });
  }

  private validatePeriod(period: number, evaluationPeriods: number): void {
    if (![10, 20, 30].includes(period) && period % 60 !== 0) throw new AwsError("InvalidParameterValue", "Period must be 10, 20, 30, or a multiple of 60 seconds");
    const window = period * evaluationPeriods; if (window > 604_800 || (period < 3600 && window > 86_400)) throw new AwsError("InvalidParameterValue", "The alarm evaluation range exceeds the supported limit");
  }

  async PutMetricAlarm(input: any, deliveryLineage?: string[]): Promise<Record<string, never>> {
    if (input.EvaluationCriteria !== undefined) throw new AwsError("InvalidParameterValue", "Custom evaluation criteria are available in a later CW-08 subphase");
    const alarmName = name(input.AlarmName); if (this.control.compositeAlarms[alarmName] || this.control.logAlarms[alarmName]) throw new AwsError("InvalidParameterValue", "An alarm with this name already exists with another alarm type"); const previous = this.control.alarms[alarmName]; const now = this.clock.now();
    const description = input.AlarmDescription === undefined ? undefined : String(input.AlarmDescription); if (description && description.length > 1024) throw new AwsError("InvalidParameterValue", "AlarmDescription is too long");
    const evaluationPeriods = integer(input.EvaluationPeriods, "EvaluationPeriods", 1, 86_400); const datapointsToAlarm = input.DatapointsToAlarm === undefined ? evaluationPeriods : integer(input.DatapointsToAlarm, "DatapointsToAlarm", 1, evaluationPeriods);
    const thresholdMetricId = input.ThresholdMetricId === undefined ? undefined : String(input.ThresholdMetricId); const anomaly = thresholdMetricId !== undefined; const threshold = anomaly ? undefined : finite(input.Threshold, "Threshold"); if (anomaly && input.Threshold !== undefined) throw new AwsError("InvalidParameterCombination", "Threshold cannot be used with ThresholdMetricId"); const comparisonOperator = String(input.ComparisonOperator ?? "") as CloudWatchComparisonOperator; if (!(anomaly ? ANOMALY_COMPARISONS : STATIC_COMPARISONS).has(comparisonOperator)) throw new AwsError("InvalidParameterValue", `ComparisonOperator is not supported for a${anomaly ? "n anomaly detection" : " static threshold"} alarm`);
    const treatMissingData = String(input.TreatMissingData ?? "missing") as CloudWatchAlarmState["treatMissingData"]; if (!MISSING.has(treatMissingData)) throw new AwsError("InvalidParameterValue", "TreatMissingData is invalid");
    const evaluateLowSampleCountPercentile = String(input.EvaluateLowSampleCountPercentile ?? "evaluate") as CloudWatchAlarmState["evaluateLowSampleCountPercentile"]; if (!LOW_SAMPLE.has(evaluateLowSampleCountPercentile)) throw new AwsError("InvalidParameterValue", "EvaluateLowSampleCountPercentile is invalid");
    const standard = input.MetricName !== undefined || input.Namespace !== undefined; const math = input.Metrics !== undefined; if (standard === math || (anomaly && !math)) throw new AwsError("InvalidParameterCombination", anomaly ? "Anomaly detection alarms require Metrics" : "Specify either a metric or Metrics, but not both");
    let metricFields: Partial<CloudWatchAlarmState>;
    if (standard) {
      const metricName = String(input.MetricName ?? ""); const namespace = String(input.Namespace ?? ""); if (!metricName || !namespace || metricName.length > 255 || namespace.length > 255) throw new AwsError("InvalidParameterValue", "MetricName and Namespace are required");
      const period = integer(input.Period, "Period", 10, 86_400); this.validatePeriod(period, evaluationPeriods);
      const statistic = input.Statistic === undefined ? undefined : String(input.Statistic); const extendedStatistic = input.ExtendedStatistic === undefined ? undefined : String(input.ExtendedStatistic); if (Boolean(statistic) === Boolean(extendedStatistic) || (statistic && !STATISTICS.has(statistic)) || (extendedStatistic && !percentileName(extendedStatistic))) throw new AwsError("InvalidParameterValue", "Specify one supported Statistic or ExtendedStatistic");
      const unit = input.Unit === undefined ? undefined : String(input.Unit); if (unit && !UNITS.has(unit)) throw new AwsError("InvalidParameterValue", "Unit is invalid");
      metricFields = { namespace, metricName, dimensions: dimensions(input.Dimensions), period, unit, statistic, extendedStatistic };
    } else {
      const metrics = list<any>(input.Metrics); if (!metrics.length || metrics.length > 20) throw new AwsError("InvalidParameterValue", "Metrics must contain between 1 and 20 queries");
      let returned: any[];
      if (anomaly) {
        if (!/^[a-z][A-Za-z0-9_]{0,254}$/.test(thresholdMetricId!)) throw new AwsError("InvalidParameterValue", "ThresholdMetricId is invalid"); const band = metrics.find(query => query.Id === thresholdMetricId); const match = String(band?.Expression ?? "").match(/^\s*ANOMALY_DETECTION_BAND\s*\(\s*([a-z][A-Za-z0-9_]*)\s*(?:,\s*(\d+(?:\.\d+)?)\s*)?\)\s*$/i); if (!match || !metrics.some(query => query.Id === match[1])) throw new AwsError("InvalidParameterValue", "ThresholdMetricId must identify an ANOMALY_DETECTION_BAND expression"); returned = metrics.filter(query => query.Id !== thresholdMetricId && query.ReturnData !== false); if (returned.length !== 1 || returned[0].Id !== match[1]) throw new AwsError("InvalidParameterValue", "Exactly one watched metric or expression must return data and match the anomaly band source"); const actions = [...list<any>(input.OKActions), ...list<any>(input.AlarmActions), ...list<any>(input.InsufficientDataActions)].map(String); if (actions.some(action => /:autoscaling:/.test(action))) throw new AwsError("InvalidParameterValue", "Anomaly detection alarms cannot have Auto Scaling actions");
      } else { returned = metrics.filter(query => query.ReturnData !== false); if (returned.length !== 1) throw new AwsError("InvalidParameterValue", "Exactly one metric data query must return data"); }
      const output = returned[0]; const period = Number(output.Period ?? output.MetricStat?.Period); if (!Number.isInteger(period)) throw new AwsError("InvalidParameterValue", "The returned metric data query must define a period"); this.validatePeriod(period, evaluationPeriods);
      await this.readMetricData({ StartTime: new Date(now - period * 2_000), EndTime: new Date(now), MetricDataQueries: metrics, ScanBy: "TimestampAscending" });
      metricFields = { metrics: structuredClone(metrics), period };
    }
    const next: CloudWatchAlarmState = {
      alarmName, alarmArn: alarmArn(this.region, this.store.accountId, alarmName), alarmDescription: description, createdAt: previous?.createdAt ?? now, configurationUpdatedTimestamp: now,
      actionsEnabled: input.ActionsEnabled === undefined ? true : Boolean(input.ActionsEnabled), okActions: actionArns(input.OKActions, "OKActions"), alarmActions: actionArns(input.AlarmActions, "AlarmActions"), insufficientDataActions: actionArns(input.InsufficientDataActions, "InsufficientDataActions"),
      ...metricFields, evaluationPeriods, datapointsToAlarm, ...(threshold === undefined ? {} : { threshold }), ...(thresholdMetricId === undefined ? {} : { thresholdMetricId }), comparisonOperator, treatMissingData, evaluateLowSampleCountPercentile,
      stateValue: previous?.stateValue ?? "INSUFFICIENT_DATA", stateReason: previous?.stateReason ?? "Unchecked: Initial alarm creation", stateReasonData: previous?.stateReasonData ?? JSON.stringify({ version: "1.0", queryDate: new Date(now).toISOString() }), stateUpdatedTimestamp: previous?.stateUpdatedTimestamp ?? now, stateTransitionedTimestamp: previous?.stateTransitionedTimestamp ?? now,
      tags: previous?.tags ?? parseTags(input.Tags), lastEvaluatedAt: previous?.lastEvaluatedAt,
    };
    this.control.alarms[alarmName] = next;
    this.history(alarmName, "ConfigurationUpdate", previous ? "Alarm updated" : "Alarm created", { type: previous ? "Update" : "Create", updatedConfiguration: this.view(next) }, now);
    this.queueConfigurationEvent(next, previous ? "update" : "create", previous, now, deliveryLineage); await this.store.save(); await this.drainEventBridgeOutbox(); await this.evaluateCompositeAlarms(now, deliveryLineage); return {};
  }

  async PutCompositeAlarm(input: any, deliveryLineage?: string[]): Promise<Record<string, never>> {
    const alarmName = name(input.AlarmName); if (this.control.alarms[alarmName] || this.control.logAlarms[alarmName]) throw new AwsError("InvalidParameterValue", "An alarm with this name already exists with another alarm type"); const previous = this.control.compositeAlarms[alarmName]; const now = this.clock.now();
    const description = input.AlarmDescription === undefined ? undefined : String(input.AlarmDescription); if (description !== undefined && description.length > 1024) throw new AwsError("InvalidParameterValue", "AlarmDescription is too long");
    const parsed = parseAlarmRule(input.AlarmRule); const children = [...new Set(parsed.children.map(reference => this.referenceName(reference)))];
    for (const child of children) { const parents = Object.values(this.control.compositeAlarms).filter(alarm => alarm.alarmName !== alarmName && alarm.children.includes(child)); if (parents.length >= 150 && !previous?.children.includes(child)) throw new AwsError("LimitExceeded", `Alarm ${child} already has 150 composite parents`); }
    const actionsSuppressor = input.ActionsSuppressor === undefined ? undefined : this.referenceName(String(input.ActionsSuppressor)); let actionsSuppressorWaitPeriod: number | undefined; let actionsSuppressorExtensionPeriod: number | undefined;
    if (actionsSuppressor !== undefined) { if (input.ActionsSuppressorWaitPeriod === undefined || input.ActionsSuppressorExtensionPeriod === undefined) throw new AwsError("MissingParameter", "ActionsSuppressorWaitPeriod and ActionsSuppressorExtensionPeriod are required with ActionsSuppressor"); actionsSuppressorWaitPeriod = integer(input.ActionsSuppressorWaitPeriod, "ActionsSuppressorWaitPeriod", 0, 86_400); actionsSuppressorExtensionPeriod = integer(input.ActionsSuppressorExtensionPeriod, "ActionsSuppressorExtensionPeriod", 0, 86_400); }
    else if (input.ActionsSuppressorWaitPeriod !== undefined || input.ActionsSuppressorExtensionPeriod !== undefined) throw new AwsError("InvalidParameterCombination", "ActionsSuppressor is required with suppression periods");
    const next: CloudWatchCompositeAlarmState = {
      alarmName, alarmArn: alarmArn(this.region, this.store.accountId, alarmName), alarmDescription: description, createdAt: previous?.createdAt ?? now, configurationUpdatedTimestamp: now,
      actionsEnabled: input.ActionsEnabled === undefined ? true : Boolean(input.ActionsEnabled), okActions: actionArns(input.OKActions, "OKActions"), alarmActions: actionArns(input.AlarmActions, "AlarmActions"), insufficientDataActions: actionArns(input.InsufficientDataActions, "InsufficientDataActions"),
      alarmRule: String(input.AlarmRule), children, ...(actionsSuppressor ? { actionsSuppressor, actionsSuppressorWaitPeriod, actionsSuppressorExtensionPeriod } : {}),
      stateValue: previous?.stateValue ?? "INSUFFICIENT_DATA", stateReason: previous?.stateReason ?? "Unchecked: Initial composite alarm creation", stateReasonData: previous?.stateReasonData ?? JSON.stringify({ version: "1.0", queryDate: new Date(now).toISOString() }), stateUpdatedTimestamp: previous?.stateUpdatedTimestamp ?? now, stateTransitionedTimestamp: previous?.stateTransitionedTimestamp ?? now,
      tags: previous?.tags ?? parseTags(input.Tags),
    };
    this.control.compositeAlarms[alarmName] = next; this.history(alarmName, "ConfigurationUpdate", previous ? "Composite alarm updated" : "Composite alarm created", { type: previous ? "Update" : "Create", updatedConfiguration: this.compositeView(next) }, now, "CompositeAlarm");
    this.queueConfigurationEvent(next, previous ? "update" : "create", previous, now, deliveryLineage); await this.store.save(); await this.drainEventBridgeOutbox(); await this.evaluateCompositeAlarms(now, deliveryLineage); return {};
  }

  async PutLogAlarm(input: any, deliveryLineage?: string[]): Promise<Record<string, never>> {
    if (!this.validateLogQuery) throw new AwsError("InternalServiceError", "CloudWatch Logs query evaluation is unavailable", 500);
    const alarmName = name(input.AlarmName); if (this.control.alarms[alarmName] || this.control.compositeAlarms[alarmName]) throw new AwsError("InvalidParameterValue", "An alarm with this name already exists with another alarm type"); const previous = this.control.logAlarms[alarmName]; const now = this.clock.now();
    const alarmDescription = input.AlarmDescription === undefined ? undefined : String(input.AlarmDescription); if (alarmDescription !== undefined && alarmDescription.length > 1024) throw new AwsError("InvalidParameterValue", "AlarmDescription is too long");
    const configuration = input.ScheduledQueryConfiguration; if (!configuration || typeof configuration !== "object") throw new AwsError("MissingParameter", "ScheduledQueryConfiguration is required"); const queryString = String(configuration.QueryString ?? ""); if (queryString.length > 10_000) throw new AwsError("InvalidParameterValue", "QueryString is too long");
    const logGroupIdentifiers = list<any>(configuration.LogGroupIdentifiers).map(String); if (logGroupIdentifiers.length < 1 || logGroupIdentifiers.length > 50 || logGroupIdentifiers.some(value => !value || value.length > 1024)) throw new AwsError("InvalidParameterValue", "LogGroupIdentifiers must contain between 1 and 50 identifiers");
    const scheduledQueryRoleArn = String(configuration.ScheduledQueryRoleARN ?? ""); if (!/^arn:[^:]+:iam::\d{12}:role\/.+/.test(scheduledQueryRoleArn) || scheduledQueryRoleArn.length > 1024) throw new AwsError("InvalidParameterValue", "ScheduledQueryRoleARN must be an IAM role ARN");
    const schedule = configuration.ScheduleConfiguration; if (!schedule || typeof schedule !== "object") throw new AwsError("MissingParameter", "ScheduleConfiguration is required"); const scheduleExpression = String(schedule.ScheduleExpression ?? ""); const intervalMs = scheduleRateMs(scheduleExpression); const startTimeOffset = schedule.StartTimeOffset === undefined ? Math.floor(intervalMs / 1000) : integer(schedule.StartTimeOffset, "StartTimeOffset", 1, 604_800); const endTimeOffset = schedule.EndTimeOffset === undefined ? 0 : integer(schedule.EndTimeOffset, "EndTimeOffset", 0, 604_799); if (endTimeOffset >= startTimeOffset) throw new AwsError("InvalidParameterValue", "EndTimeOffset must be less than StartTimeOffset");
    const aggregationExpression = String(configuration.AggregationExpression ?? ""); const scheduledQueryConfiguration: CloudWatchLogAlarmState["scheduledQueryConfiguration"] = { queryString, logGroupIdentifiers: [...new Set(logGroupIdentifiers)], queryArn: `arn:aws:logs:${this.region}:${this.store.accountId}:scheduled-query:${encodeURIComponent(alarmName)}`, scheduledQueryRoleArn, scheduleConfiguration: { scheduleExpression, startTimeOffset, endTimeOffset }, aggregationExpression, tags: parseTags(configuration.Tags) };
    this.validateLogQuery(scheduledQueryConfiguration);
    const queryResultsToEvaluate = integer(input.QueryResultsToEvaluate, "QueryResultsToEvaluate", 1, 100); const queryResultsToAlarm = integer(input.QueryResultsToAlarm, "QueryResultsToAlarm", 1, queryResultsToEvaluate); const threshold = finite(input.Threshold, "Threshold"); const comparisonOperator = String(input.ComparisonOperator ?? "") as CloudWatchLogAlarmState["comparisonOperator"]; if (!STATIC_COMPARISONS.has(comparisonOperator)) throw new AwsError("InvalidParameterValue", "Log alarms support only static comparison operators"); const treatMissingData = String(input.TreatMissingData ?? "missing") as CloudWatchLogAlarmState["treatMissingData"]; if (!MISSING.has(treatMissingData)) throw new AwsError("InvalidParameterValue", "TreatMissingData is invalid");
    const actionLogLineCount = input.ActionLogLineCount === undefined ? 0 : integer(input.ActionLogLineCount, "ActionLogLineCount", 0, 50); const actionLogLineRoleArn = input.ActionLogLineRoleArn === undefined ? undefined : String(input.ActionLogLineRoleArn); if (actionLogLineCount > 0 && (!actionLogLineRoleArn || !/^arn:[^:]+:iam::\d{12}:role\/.+/.test(actionLogLineRoleArn))) throw new AwsError("InvalidParameterValue", "ActionLogLineRoleArn is required when ActionLogLineCount is greater than zero"); if (actionLogLineRoleArn && actionLogLineRoleArn.length > 1024) throw new AwsError("InvalidParameterValue", "ActionLogLineRoleArn is too long");
    const next: CloudWatchLogAlarmState = { alarmName, alarmArn: alarmArn(this.region, this.store.accountId, alarmName), alarmDescription, createdAt: previous?.createdAt ?? now, configurationUpdatedTimestamp: now, actionsEnabled: input.ActionsEnabled === undefined ? true : Boolean(input.ActionsEnabled), okActions: actionArns(input.OKActions, "OKActions"), alarmActions: actionArns(input.AlarmActions, "AlarmActions"), insufficientDataActions: actionArns(input.InsufficientDataActions, "InsufficientDataActions"), stateValue: previous?.stateValue ?? "INSUFFICIENT_DATA", stateReason: previous?.stateReason ?? "Unchecked: Initial log alarm creation", stateReasonData: previous?.stateReasonData ?? JSON.stringify({ version: "1.0", queryDate: new Date(now).toISOString() }), stateUpdatedTimestamp: previous?.stateUpdatedTimestamp ?? now, stateTransitionedTimestamp: previous?.stateTransitionedTimestamp ?? now, tags: previous?.tags ?? parseTags(input.Tags), scheduledQueryConfiguration, queryResultsToEvaluate, queryResultsToAlarm, threshold, comparisonOperator, treatMissingData, actionLogLineCount, ...(actionLogLineRoleArn ? { actionLogLineRoleArn } : {}), contributors: previous?.contributors ?? {}, latestLogLines: previous?.latestLogLines ?? [], lastEvaluatedAt: previous?.lastEvaluatedAt };
    this.control.logAlarms[alarmName] = next; this.history(alarmName, "ConfigurationUpdate", previous ? "Log alarm updated" : "Log alarm created", { type: previous ? "Update" : "Create", updatedConfiguration: this.logView(next) }, now, "LogAlarm"); this.queueConfigurationEvent(next, previous ? "update" : "create", previous, now, deliveryLineage); await this.store.save(); await this.drainEventBridgeOutbox(); await this.evaluateCompositeAlarms(now, deliveryLineage); return {};
  }

  private commonView(alarm: CloudWatchAlarmCommonState): any { return { AlarmName: alarm.alarmName, AlarmArn: alarm.alarmArn, AlarmDescription: alarm.alarmDescription, AlarmConfigurationUpdatedTimestamp: new Date(alarm.configurationUpdatedTimestamp), ActionsEnabled: alarm.actionsEnabled, OKActions: alarm.okActions, AlarmActions: alarm.alarmActions, InsufficientDataActions: alarm.insufficientDataActions, StateValue: alarm.stateValue, StateReason: alarm.stateReason, StateReasonData: alarm.stateReasonData, StateUpdatedTimestamp: new Date(alarm.stateUpdatedTimestamp), StateTransitionedTimestamp: new Date(alarm.stateTransitionedTimestamp) }; }
  private view(alarm: CloudWatchAlarmState): any {
    return { ...this.commonView(alarm), MetricName: alarm.metricName, Namespace: alarm.namespace, Statistic: alarm.statistic, ExtendedStatistic: alarm.extendedStatistic, Dimensions: alarm.dimensions, Period: alarm.period, Unit: alarm.unit, EvaluationPeriods: alarm.evaluationPeriods, DatapointsToAlarm: alarm.datapointsToAlarm, Threshold: alarm.threshold, ThresholdMetricId: alarm.thresholdMetricId, ComparisonOperator: alarm.comparisonOperator, TreatMissingData: alarm.treatMissingData, EvaluateLowSampleCountPercentile: alarm.evaluateLowSampleCountPercentile, Metrics: alarm.metrics };
  }

  private compositeView(alarm: CloudWatchCompositeAlarmState): any { return { ...this.commonView(alarm), AlarmRule: alarm.alarmRule, ActionsSuppressor: alarm.actionsSuppressor, ActionsSuppressorWaitPeriod: alarm.actionsSuppressorWaitPeriod, ActionsSuppressorExtensionPeriod: alarm.actionsSuppressorExtensionPeriod, ActionsSuppressedBy: alarm.actionsSuppressedBy, ActionsSuppressedReason: alarm.actionsSuppressedReason }; }

  private logView(alarm: CloudWatchLogAlarmState): any { const query = alarm.scheduledQueryConfiguration; return { ...this.commonView(alarm), ScheduledQueryConfiguration: { QueryString: query.queryString, LogGroupIdentifiers: query.logGroupIdentifiers, QueryARN: query.queryArn, ScheduledQueryRoleARN: query.scheduledQueryRoleArn, ScheduleConfiguration: { ScheduleExpression: query.scheduleConfiguration.scheduleExpression, StartTimeOffset: query.scheduleConfiguration.startTimeOffset, EndTimeOffset: query.scheduleConfiguration.endTimeOffset }, AggregationExpression: query.aggregationExpression, Tags: Object.entries(query.tags).sort(([a], [b]) => a.localeCompare(b)).map(([Key, Value]) => ({ Key, Value })) }, QueryResultsToEvaluate: alarm.queryResultsToEvaluate, QueryResultsToAlarm: alarm.queryResultsToAlarm, Threshold: alarm.threshold, ComparisonOperator: alarm.comparisonOperator, TreatMissingData: alarm.treatMissingData, EvaluationState: alarm.evaluationState, ActionLogLineCount: alarm.actionLogLineCount, ActionLogLineRoleArn: alarm.actionLogLineRoleArn }; }

  async DescribeAlarms(input: any): Promise<any> {
    const childrenOf = input.ChildrenOfAlarmName === undefined ? undefined : name(input.ChildrenOfAlarmName); const parentsOf = input.ParentsOfAlarmName === undefined ? undefined : name(input.ParentsOfAlarmName); if (childrenOf && parentsOf) throw new AwsError("InvalidParameterCombination", "ChildrenOfAlarmName and ParentsOfAlarmName cannot be combined");
    if (childrenOf || parentsOf) {
      const allowed = new Set([childrenOf ? "ChildrenOfAlarmName" : "ParentsOfAlarmName", "MaxRecords", "NextToken"]); if (Object.keys(input).some(key => !allowed.has(key))) throw new AwsError("InvalidParameterCombination", "Parent/child relationship queries cannot be combined with other filters");
      let related: Array<{ type: "MetricAlarm" | "CompositeAlarm" | "LogAlarm"; alarm: CloudWatchAnyAlarmState }>;
      if (childrenOf) { const parent = this.control.compositeAlarms[childrenOf]; if (!parent) throw new AwsError("ResourceNotFound", `Composite alarm ${childrenOf} does not exist`); related = []; for (const child of parent.children) { if (this.control.alarms[child]) related.push({ type: "MetricAlarm", alarm: this.control.alarms[child] }); else if (this.control.compositeAlarms[child]) related.push({ type: "CompositeAlarm", alarm: this.control.compositeAlarms[child] }); else if (this.control.logAlarms[child]) related.push({ type: "LogAlarm", alarm: this.control.logAlarms[child] }); } }
      else { this.requireAlarm(parentsOf!); related = Object.values(this.control.compositeAlarms).filter(alarm => alarm.children.includes(parentsOf!)).map(alarm => ({ type: "CompositeAlarm" as const, alarm })); }
      related.sort((left, right) => left.alarm.alarmName.localeCompare(right.alarm.alarmName)); const max = input.MaxRecords === undefined ? 100 : integer(input.MaxRecords, "MaxRecords", 1, 100); const filter = { childrenOf, parentsOf }; let index = 0;
      if (input.NextToken) try { const cursor = this.tokens.decode<{ index: number; signature: string }>("DescribeAlarms", input.NextToken); if (cursor.signature !== signature(filter)) throw new Error(); index = cursor.index; } catch { throw new AwsError("InvalidNextToken", "The next token is invalid"); }
      const page = related.slice(index, index + max); const next = index + page.length; return { CompositeAlarms: page.filter(item => item.type === "CompositeAlarm").map(item => parentsOf ? { AlarmName: item.alarm.alarmName, AlarmArn: item.alarm.alarmArn } : this.commonRelationView(item.alarm)), MetricAlarms: page.filter(item => item.type === "MetricAlarm").map(item => this.commonRelationView(item.alarm)), LogAlarms: page.filter(item => item.type === "LogAlarm").map(item => this.commonRelationView(item.alarm)), ...(next < related.length ? { NextToken: this.tokens.encode("DescribeAlarms", { index: next, signature: signature(filter) }) } : {}) };
    }
    const names = new Set(list<any>(input.AlarmNames).map(String)); const prefix = input.AlarmNamePrefix === undefined ? undefined : String(input.AlarmNamePrefix); if (names.size && prefix) throw new AwsError("InvalidParameterCombination", "AlarmNames and AlarmNamePrefix cannot be combined"); const actionPrefix = input.ActionPrefix === undefined ? undefined : String(input.ActionPrefix); const state = input.StateValue === undefined ? undefined : String(input.StateValue); if (state && !["OK", "ALARM", "INSUFFICIENT_DATA"].includes(state)) throw new AwsError("InvalidParameterValue", "StateValue is invalid");
    const types = list<any>(input.AlarmTypes).map(String); if (types.some(type => !["MetricAlarm", "CompositeAlarm", "LogAlarm"].includes(type))) throw new AwsError("InvalidParameterValue", "AlarmTypes is invalid"); const selectedTypes = types.length ? new Set(types) : new Set(["MetricAlarm"]); const matches = (alarm: CloudWatchAnyAlarmState) => (!names.size || names.has(alarm.alarmName)) && (!prefix || alarm.alarmName.startsWith(prefix)) && (!actionPrefix || [...alarm.okActions, ...alarm.alarmActions, ...alarm.insufficientDataActions].some(action => action.startsWith(actionPrefix))) && (!state || alarm.stateValue === state);
    let alarms: Array<{ type: "MetricAlarm" | "CompositeAlarm" | "LogAlarm"; alarm: CloudWatchAnyAlarmState }> = [...(selectedTypes.has("MetricAlarm") ? Object.values(this.control.alarms).filter(matches).map(alarm => ({ type: "MetricAlarm" as const, alarm })) : []), ...(selectedTypes.has("CompositeAlarm") ? Object.values(this.control.compositeAlarms).filter(matches).map(alarm => ({ type: "CompositeAlarm" as const, alarm })) : []), ...(selectedTypes.has("LogAlarm") ? Object.values(this.control.logAlarms).filter(matches).map(alarm => ({ type: "LogAlarm" as const, alarm })) : [])].sort((a, b) => a.alarm.alarmName.localeCompare(b.alarm.alarmName) || a.type.localeCompare(b.type));
    const max = input.MaxRecords === undefined ? 100 : integer(input.MaxRecords, "MaxRecords", 1, 100); const filter = { names: [...names].sort(), prefix, actionPrefix, state, types }; let index = 0;
    if (input.NextToken) try { const cursor = this.tokens.decode<{ index: number; signature: string }>("DescribeAlarms", input.NextToken); if (cursor.signature !== signature(filter)) throw new Error(); index = cursor.index; } catch { throw new AwsError("InvalidNextToken", "The next token is invalid"); }
    const page = alarms.slice(index, index + max); const next = index + page.length; return { CompositeAlarms: page.filter(item => item.type === "CompositeAlarm").map(item => this.compositeView(item.alarm as CloudWatchCompositeAlarmState)), MetricAlarms: page.filter(item => item.type === "MetricAlarm").map(item => this.view(item.alarm as CloudWatchAlarmState)), LogAlarms: page.filter(item => item.type === "LogAlarm").map(item => this.logView(item.alarm as CloudWatchLogAlarmState)), ...(next < alarms.length ? { NextToken: this.tokens.encode("DescribeAlarms", { index: next, signature: signature(filter) }) } : {}) };
  }

  private commonRelationView(alarm: CloudWatchAnyAlarmState): any { return { AlarmName: alarm.alarmName, AlarmArn: alarm.alarmArn, StateValue: alarm.stateValue, StateUpdatedTimestamp: new Date(alarm.stateUpdatedTimestamp) }; }

  async DescribeAlarmsForMetric(input: any): Promise<any> {
    const metricName = String(input.MetricName ?? ""); const namespace = String(input.Namespace ?? ""); if (!metricName || !namespace) throw new AwsError("MissingParameter", "MetricName and Namespace are required"); const requestedDimensions = input.Dimensions === undefined ? undefined : dimensions(input.Dimensions);
    const alarms = Object.values(this.control.alarms).filter(alarm => !alarm.metrics && alarm.metricName === metricName && alarm.namespace === namespace && (requestedDimensions === undefined || sameDimensions(alarm.dimensions, requestedDimensions)) && (input.Period === undefined || alarm.period === Number(input.Period)) && (input.Statistic === undefined || alarm.statistic === input.Statistic) && (input.ExtendedStatistic === undefined || alarm.extendedStatistic === input.ExtendedStatistic) && (input.Unit === undefined || alarm.unit === input.Unit));
    return { MetricAlarms: alarms.sort((a, b) => a.alarmName.localeCompare(b.alarmName)).map(alarm => this.view(alarm)) };
  }

  async DescribeAlarmContributors(input: any): Promise<any> {
    const alarmName = name(input.AlarmName); const alarm = this.requireAlarm(alarmName); const contributors = isLog(alarm) ? Object.values(alarm.contributors).filter(item => item.stateValue === "ALARM").sort((a, b) => a.contributorId.localeCompare(b.contributorId)) : []; let index = 0;
    if (input.NextToken) try { const cursor = this.tokens.decode<{ alarmName: string; index: number }>("DescribeAlarmContributors", input.NextToken); if (cursor.alarmName !== alarmName) throw new Error(); index = cursor.index; } catch { throw new AwsError("InvalidNextToken", "The next token is invalid"); }
    const page = contributors.slice(index, index + 100); const next = index + page.length; return { AlarmContributors: page.map(item => ({ ContributorId: item.contributorId, ContributorAttributes: item.contributorAttributes, StateReason: item.stateReason, StateTransitionedTimestamp: new Date(item.stateTransitionedTimestamp) })), ...(next < contributors.length ? { NextToken: this.tokens.encode("DescribeAlarmContributors", { alarmName, index: next }) } : {}) };
  }

  async DeleteAlarms(input: any, deliveryLineage?: string[]): Promise<Record<string, never>> { const names = list<any>(input.AlarmNames).map(name); if (!names.length || names.length > 100) throw new AwsError("InvalidParameterValue", "AlarmNames must contain between 1 and 100 names"); const composites = names.filter(alarmName => this.control.compositeAlarms[alarmName]); if (composites.length > 1) throw new AwsError("InvalidParameterValue", "A delete request can contain no more than one composite alarm"); for (const alarmName of composites) { const parents = Object.values(this.control.compositeAlarms).filter(alarm => alarm.alarmName !== alarmName && alarm.children.includes(alarmName)); if (parents.length) throw new AwsError("ResourceNotFound", `Composite alarm ${alarmName} is still referenced by ${parents[0].alarmName}`); } const deleted: CloudWatchAnyAlarmState[] = []; for (const alarmName of names) { const alarm = this.control.alarms[alarmName] ?? this.control.compositeAlarms[alarmName] ?? this.control.logAlarms[alarmName]; if (alarm) deleted.push(alarm as CloudWatchAnyAlarmState); } for (const alarmName of names) { delete this.control.alarms[alarmName]; delete this.control.compositeAlarms[alarmName]; delete this.control.logAlarms[alarmName]; } const now = this.clock.now(); for (const alarm of deleted) this.queueConfigurationEvent(alarm, "delete", undefined, now, deliveryLineage); await this.store.save(); await this.drainEventBridgeOutbox(); await this.evaluateCompositeAlarms(now, deliveryLineage); return {}; }

  async SetAlarmState(input: any, deliveryLineage?: string[]): Promise<Record<string, never>> {
    const alarm = this.requireAlarm(name(input.AlarmName)); const state = String(input.StateValue ?? "") as CloudWatchAlarmStateValue; if (!["OK", "ALARM", "INSUFFICIENT_DATA"].includes(state)) throw new AwsError("InvalidParameterValue", "StateValue is invalid"); const reason = String(input.StateReason ?? ""); if (!reason || reason.length > 1023) throw new AwsError("InvalidParameterValue", "StateReason is required and must not exceed 1023 characters"); const reasonData = input.StateReasonData === undefined ? "{}" : String(input.StateReasonData); if (reasonData.length > 4000) throw new AwsError("InvalidParameterValue", "StateReasonData is too long"); try { JSON.parse(reasonData); } catch { throw new AwsError("InvalidParameterValue", "StateReasonData must be valid JSON"); }
    await this.transition(alarm, state, reason, reasonData, this.clock.now(), "SetAlarmState", deliveryLineage); if (!isComposite(alarm)) await this.evaluateCompositeAlarms(this.clock.now(), deliveryLineage); return {};
  }

  async EnableAlarmActions(input: any, deliveryLineage?: string[]): Promise<Record<string, never>> { return this.setActions(input, true, deliveryLineage); }
  async DisableAlarmActions(input: any, deliveryLineage?: string[]): Promise<Record<string, never>> { return this.setActions(input, false, deliveryLineage); }
  private async setActions(input: any, enabled: boolean, deliveryLineage?: string[]): Promise<Record<string, never>> { const names = list<any>(input.AlarmNames).map(name); if (!names.length || names.length > 100) throw new AwsError("InvalidParameterValue", "AlarmNames must contain between 1 and 100 names"); const now = this.clock.now(); const changed: Array<{ alarm: CloudWatchAnyAlarmState; previous: CloudWatchAnyAlarmState }> = []; for (const alarmName of names) { const alarm = this.requireAlarm(alarmName); const previous = structuredClone(alarm); alarm.actionsEnabled = enabled; alarm.configurationUpdatedTimestamp = now; if (!enabled && isComposite(alarm)) { delete alarm.pendingAction; delete alarm.actionsSuppressedBy; delete alarm.actionsSuppressedReason; } this.history(alarmName, "ConfigurationUpdate", enabled ? "Alarm actions enabled" : "Alarm actions disabled", { actionsEnabled: enabled }, now); changed.push({ alarm, previous }); } for (const item of changed) this.queueConfigurationEvent(item.alarm, "update", item.previous, now, deliveryLineage); await this.store.save(); await this.drainEventBridgeOutbox(); return {}; }

  async DescribeAlarmHistory(input: any): Promise<any> {
    const pruned = this.pruneHistory(); if (pruned) await this.store.save(); const alarmName = input.AlarmName === undefined ? undefined : name(input.AlarmName); const contributorId = input.AlarmContributorId === undefined ? undefined : String(input.AlarmContributorId); if (contributorId && (contributorId.length > 16 || !/^[A-Za-z0-9_-]+$/.test(contributorId))) throw new AwsError("InvalidParameterValue", "AlarmContributorId is invalid"); const type = input.HistoryItemType === undefined ? undefined : String(input.HistoryItemType); if (type && !["ConfigurationUpdate", "StateUpdate", "Action", "AlarmContributorStateUpdate", "AlarmContributorAction"].includes(type)) throw new AwsError("InvalidParameterValue", "HistoryItemType is invalid"); const alarmTypes = list<any>(input.AlarmTypes).map(String); if (alarmTypes.some(value => !["MetricAlarm", "CompositeAlarm", "LogAlarm"].includes(value))) throw new AwsError("InvalidParameterValue", "AlarmTypes is invalid"); const selectedTypes = alarmTypes.length ? new Set(alarmTypes) : alarmName ? undefined : new Set(["MetricAlarm"]); const start = input.StartDate === undefined ? undefined : timestamp(input.StartDate); const end = input.EndDate === undefined ? undefined : timestamp(input.EndDate); if (start !== undefined && end !== undefined && start > end) throw new AwsError("InvalidParameterValue", "StartDate must not follow EndDate");
    const filter = { alarmName, contributorId, alarmTypes, type, start, end, scan: input.ScanBy ?? "TimestampDescending" }; let values = this.control.alarmHistory.filter(item => (!alarmName || item.alarmName === alarmName) && (!contributorId || item.alarmContributorId === contributorId) && (!selectedTypes || selectedTypes.has(item.alarmType)) && (!type || item.historyItemType === type) && (start === undefined || item.timestamp >= start) && (end === undefined || item.timestamp <= end)); if (!input.ScanBy || input.ScanBy === "TimestampDescending") values.sort((a, b) => b.timestamp - a.timestamp); else if (input.ScanBy === "TimestampAscending") values.sort((a, b) => a.timestamp - b.timestamp); else throw new AwsError("InvalidParameterValue", "ScanBy is invalid");
    const max = input.MaxRecords === undefined ? 100 : integer(input.MaxRecords, "MaxRecords", 1, 100); let index = 0; if (input.NextToken) try { const cursor = this.tokens.decode<{ index: number; signature: string }>("DescribeAlarmHistory", input.NextToken); if (cursor.signature !== signature(filter)) throw new Error(); index = cursor.index; } catch { throw new AwsError("InvalidNextToken", "The next token is invalid"); }
    const page = values.slice(index, index + max); const next = index + page.length; return { AlarmHistoryItems: page.map(item => ({ AlarmName: item.alarmName, AlarmType: item.alarmType, Timestamp: new Date(item.timestamp), HistoryItemType: item.historyItemType, HistorySummary: item.historySummary, HistoryData: item.historyData, AlarmContributorId: item.alarmContributorId, AlarmContributorAttributes: item.alarmContributorAttributes })), ...(next < values.length ? { NextToken: this.tokens.encode("DescribeAlarmHistory", { index: next, signature: signature(filter) }) } : {}) };
  }

  private muteRuleState(rule: CloudWatchAlarmMuteRuleState, at = this.clock.now()): { status: "SCHEDULED" | "ACTIVE" | "EXPIRED"; active: boolean; occurrence?: number } {
    if (rule.expireDate !== undefined && at >= rule.expireDate) return { status: "EXPIRED", active: false }; if (rule.startDate !== undefined && at < rule.startDate) return { status: "SCHEDULED", active: false }; const schedule = rule.rule.schedule;
    if (/^at\(/i.test(schedule.expression)) { const occurrence = localAtEpoch(schedule.expression, schedule.timezone); if (at < occurrence) return { status: "SCHEDULED", active: false, occurrence }; const active = at < occurrence + schedule.durationMs && (rule.expireDate === undefined || at < rule.expireDate); return { status: active ? "ACTIVE" : "EXPIRED", active, occurrence }; }
    const matches = cronMatcher(schedule.expression); const floor = Math.floor(at / 60_000) * 60_000; const lower = at - schedule.durationMs; for (let occurrence = floor; occurrence >= lower; occurrence -= 60_000) { if (rule.startDate !== undefined && occurrence < rule.startDate) break; if (matches(localMinute(occurrence, schedule.timezone)) && at < occurrence + schedule.durationMs) return { status: "ACTIVE", active: true, occurrence }; } return { status: "SCHEDULED", active: false };
  }

  private muteRuleView(rule: CloudWatchAlarmMuteRuleState): any { const status = this.muteRuleState(rule).status; return { Name: rule.name, AlarmMuteRuleArn: rule.alarmMuteRuleArn, Description: rule.description, Rule: { Schedule: { Expression: rule.rule.schedule.expression, Duration: rule.rule.schedule.duration, Timezone: rule.rule.schedule.timezone } }, MuteTargets: { AlarmNames: rule.alarmNames }, StartDate: rule.startDate === undefined ? undefined : new Date(rule.startDate), ExpireDate: rule.expireDate === undefined ? undefined : new Date(rule.expireDate), Status: status, MuteType: /^at\(/i.test(rule.rule.schedule.expression) ? "ONE_TIME" : "RECURRING", LastUpdatedTimestamp: new Date(rule.lastUpdatedTimestamp) }; }

  private activeMuteRule(alarmName: string, at: number): CloudWatchAlarmMuteRuleState | undefined { return Object.values(this.control.alarmMuteRules).sort((a, b) => a.name.localeCompare(b.name)).find(rule => rule.alarmNames.includes(alarmName) && this.muteRuleState(rule, at).active); }

  private activeMuteDetail(alarmName: string, at: number): { mutedByArn: string; muteWindowStart: string; muteWindowEnd: string } | undefined {
    const rule = this.activeMuteRule(alarmName, at); if (!rule) return undefined;
    const state = this.muteRuleState(rule, at); if (!state.active || state.occurrence === undefined) return undefined;
    const windowEnd = Math.min(state.occurrence + rule.rule.schedule.durationMs, rule.expireDate ?? Number.POSITIVE_INFINITY);
    return { mutedByArn: rule.alarmMuteRuleArn, muteWindowStart: new Date(state.occurrence).toISOString(), muteWindowEnd: new Date(windowEnd).toISOString() };
  }

  async PutAlarmMuteRule(input: any): Promise<Record<string, never>> {
    const ruleName = name(input.Name); const description = input.Description === undefined ? undefined : String(input.Description); if (description !== undefined && description.length > 1024) throw new AwsError("InvalidParameterValue", "Description is too long"); const schedule = input.Rule?.Schedule; if (!schedule) throw new AwsError("MissingParameter", "Rule.Schedule is required"); const expression = String(schedule.Expression ?? ""); if (!expression || expression.length > 256) throw new AwsError("InvalidParameterValue", "Mute schedule expression is invalid"); const timezone = validTimezone(schedule.Timezone); if (/^at\(/i.test(expression)) localAtEpoch(expression, timezone); else cronMatcher(expression); const duration = String(schedule.Duration ?? ""); const durationMs = muteDurationMs(duration);
    const alarmNames = [...new Set(list<any>(input.MuteTargets?.AlarmNames).map(name))].sort(); if (alarmNames.length > 100) throw new AwsError("InvalidParameterValue", "MuteTargets supports at most 100 alarms"); for (const alarmName of alarmNames) this.requireAlarm(alarmName); const startDate = input.StartDate === undefined ? undefined : timestamp(input.StartDate); const expireDate = input.ExpireDate === undefined ? undefined : timestamp(input.ExpireDate); if (startDate !== undefined && expireDate !== undefined && startDate >= expireDate) throw new AwsError("InvalidParameterValue", "StartDate must precede ExpireDate"); const previous = this.control.alarmMuteRules[ruleName]; const now = this.clock.now(); this.control.alarmMuteRules[ruleName] = { name: ruleName, alarmMuteRuleArn: `arn:aws:cloudwatch:${this.region}:${this.store.accountId}:alarm-mute-rule:${ruleName}`, description, rule: { schedule: { expression, duration, durationMs, timezone } }, alarmNames, tags: previous?.tags ?? parseTags(input.Tags), ...(startDate === undefined ? {} : { startDate }), ...(expireDate === undefined ? {} : { expireDate }), createdAt: previous?.createdAt ?? now, lastUpdatedTimestamp: now }; await this.store.save(); return {};
  }

  async GetAlarmMuteRule(input: any): Promise<any> { const ruleName = name(input.AlarmMuteRuleName); const rule = this.control.alarmMuteRules[ruleName]; if (!rule) throw new AwsError("ResourceNotFoundException", `Alarm mute rule ${ruleName} does not exist`, 404); return this.muteRuleView(rule); }

  async ListAlarmMuteRules(input: any): Promise<any> {
    const alarmName = input.AlarmName === undefined ? undefined : name(input.AlarmName); if (alarmName) this.requireAlarm(alarmName); const statuses = list<any>(input.Statuses).map(String); if (statuses.some(status => !["SCHEDULED", "ACTIVE", "EXPIRED"].includes(status))) throw new AwsError("InvalidParameterValue", "Statuses is invalid"); let rules = Object.values(this.control.alarmMuteRules).filter(rule => (!alarmName || rule.alarmNames.includes(alarmName)) && (!statuses.length || statuses.includes(this.muteRuleState(rule).status))).sort((a, b) => a.name.localeCompare(b.name)); const max = input.MaxRecords === undefined ? 50 : integer(input.MaxRecords, "MaxRecords", 1, 100); const filter = { alarmName, statuses: [...statuses].sort() }; let index = 0; if (input.NextToken) try { const cursor = this.tokens.decode<{ index: number; signature: string }>("ListAlarmMuteRules", input.NextToken); if (cursor.signature !== signature(filter)) throw new Error(); index = cursor.index; } catch { throw new AwsError("InvalidNextToken", "The next token is invalid"); } const page = rules.slice(index, index + max); const next = index + page.length; return { AlarmMuteRuleSummaries: page.map(rule => { const view = this.muteRuleView(rule); return { AlarmMuteRuleArn: view.AlarmMuteRuleArn, ExpireDate: view.ExpireDate, Status: view.Status, MuteType: view.MuteType, LastUpdatedTimestamp: view.LastUpdatedTimestamp }; }), ...(next < rules.length ? { NextToken: this.tokens.encode("ListAlarmMuteRules", { index: next, signature: signature(filter) }) } : {}) };
  }

  async DeleteAlarmMuteRule(input: any): Promise<Record<string, never>> { const ruleName = name(input.AlarmMuteRuleName); const rule = this.control.alarmMuteRules[ruleName]; if (!rule) return {}; const wasActive = this.muteRuleState(rule).active; delete this.control.alarmMuteRules[ruleName]; await this.store.save(); if (wasActive) for (const alarmName of rule.alarmNames) { const alarm = this.control.alarms[alarmName] ?? this.control.compositeAlarms[alarmName] ?? this.control.logAlarms[alarmName]; if (!alarm || alarm.stateValue !== "ALARM") continue; if (isLog(alarm)) for (const contributor of Object.values(alarm.contributors).filter(item => item.stateValue === "ALARM")) this.executeContributorActions(alarm, contributor, "ALARM", this.clock.now()); else this.executeActions(alarm, { value: "ALARM", reason: "Alarm actions were muted", timestamp: this.clock.now() }, this.clock.now()); } await this.store.save(); return {}; }

  private resourceForArn(value: unknown): CloudWatchAnyAlarmState | CloudWatchAlarmMuteRuleState { const arn = String(value ?? ""); const alarm = this.allAlarms().find(item => item.alarmArn === arn); if (alarm) return alarm; const rule = Object.values(this.control.alarmMuteRules).find(item => item.alarmMuteRuleArn === arn); if (rule) return rule; throw new AwsError("ResourceNotFound", `CloudWatch resource ${arn} does not exist`); }
  async TagResource(input: any): Promise<Record<string, never>> { const resource = this.resourceForArn(input.ResourceARN); resource.tags = { ...resource.tags, ...parseTags(input.Tags) }; if (Object.keys(resource.tags).length > 50) throw new AwsError("LimitExceeded", "A maximum of 50 tags is allowed"); await this.store.save(); return {}; }
  async UntagResource(input: any): Promise<Record<string, never>> { const resource = this.resourceForArn(input.ResourceARN); for (const key of list<any>(input.TagKeys).map(String)) delete resource.tags[key]; await this.store.save(); return {}; }
  async ListTagsForResource(input: any): Promise<any> { const resource = this.resourceForArn(input.ResourceARN); return { Tags: Object.entries(resource.tags).sort(([a], [b]) => a.localeCompare(b)).map(([Key, Value]) => ({ Key, Value })) }; }
  private alarmForArn(value: unknown): CloudWatchAnyAlarmState { const arn = String(value ?? ""); const alarm = this.allAlarms().find(item => item.alarmArn === arn); if (!alarm) throw new AwsError("ResourceNotFound", `Alarm resource ${arn} does not exist`); return alarm; }

  async evaluateNow(at = this.clock.now()): Promise<void> {
    let dirty = this.pruneHistory(); const tick = Math.floor(at / 10_000) * 10_000;
    for (const alarm of Object.values(this.control.alarms)) {
      const period = alarm.period!; const cadence = period * alarm.evaluationPeriods > 86_400 ? 3600 : period < 60 ? 10 : 60; const boundary = Math.floor(tick / (cadence * 1000)) * cadence * 1000;
      if (boundary !== tick || alarm.lastEvaluatedAt === boundary) continue; alarm.lastEvaluatedAt = boundary; dirty = true; await this.evaluate(alarm, boundary);
    }
    dirty = await this.evaluateLogAlarms(tick) || dirty;
    await this.evaluateCompositeAlarms(at);
    if (dirty) await this.store.save();
  }

  private async evaluate(alarm: CloudWatchAlarmState, at: number): Promise<void> {
    const period = alarm.period!; const step = period * 1000; const end = Math.floor(at / step) * step; const start = end - step * (alarm.evaluationPeriods + 2); let values: Map<number, number>; let sampleCounts = new Map<number, number>(); let bounds: Map<number, { lower: number; upper: number }> | undefined;
    if (alarm.metrics) {
      const queryStart = alarm.thresholdMetricId ? Math.min(start, end - 14 * 86_400_000) : start; const result = await this.readMetricData({ StartTime: new Date(queryStart), EndTime: new Date(end), MetricDataQueries: alarm.metrics, ScanBy: "TimestampAscending", MaxDatapoints: 100_800 });
      if (alarm.thresholdMetricId) {
        const watched = alarm.metrics.find(query => query.Id !== alarm.thresholdMetricId && query.ReturnData !== false); const output = result.MetricDataResults?.find((item: any) => item.Id === watched?.Id); values = new Map(list<any>(output?.Timestamps).map((time, index) => [timestamp(time), Number(output.Values[index])])); const bands = list<any>(result.MetricDataResults).filter(item => item.Id === alarm.thresholdMetricId); const lower = bands.find(item => /\(lower\)$/i.test(item.Label ?? "")) ?? bands[0]; const upper = bands.find(item => /\(upper\)$/i.test(item.Label ?? "")) ?? bands[1]; const lowers = new Map(list<any>(lower?.Timestamps).map((time, index) => [timestamp(time), Number(lower.Values[index])])); const uppers = new Map(list<any>(upper?.Timestamps).map((time, index) => [timestamp(time), Number(upper.Values[index])])); bounds = new Map([...lowers.entries()].flatMap(([time, value]) => uppers.has(time) ? [[time, { lower: value, upper: uppers.get(time)! }] as const] : [])); values = new Map([...values.entries()].filter(([time]) => bounds!.has(time)));
      } else { const output = result.MetricDataResults?.find((item: any) => alarm.metrics!.some(query => query.Id === item.Id && query.ReturnData !== false)) ?? result.MetricDataResults?.[0]; values = new Map(list<any>(output?.Timestamps).map((time, index) => [timestamp(time), Number(output.Values[index])])); }
    } else {
      const series = await this.readSeries({ Metric: { Namespace: alarm.namespace, MetricName: alarm.metricName, Dimensions: alarm.dimensions }, Period: alarm.period, Stat: alarm.statistic ?? alarm.extendedStatistic, Unit: alarm.unit }, start, end); values = series.values; sampleCounts = series.sampleCounts;
    }
    const real = [...values.entries()].filter(([time, value]) => time >= start && time < end && Number.isFinite(value)).sort((a, b) => b[0] - a[0]); const selected = real.length >= alarm.evaluationPeriods ? real.slice(0, alarm.evaluationPeriods) : Array.from({ length: alarm.evaluationPeriods }, (_, index) => { const time = end - step * (index + 1); const value = values.get(time); return value === undefined ? undefined : [time, value] as [number, number]; });
    const realSelected = selected.filter((item): item is [number, number] => Boolean(item)); const missing = selected.length - realSelected.length; const treat = alarm.namespace === "AWS/DynamoDB" ? "ignore" : alarm.treatMissingData;
    if (alarm.extendedStatistic && alarm.evaluateLowSampleCountPercentile === "ignore" && realSelected.some(([time]) => (sampleCounts.get(time) ?? 0) < 10)) { alarm.stateUpdatedTimestamp = at; alarm.stateReason = "Insufficient samples to evaluate the percentile; the current state is maintained"; alarm.stateReasonData = JSON.stringify({ version: "1.0", queryDate: new Date(at).toISOString(), lowSampleCountPercentile: "ignore" }); return; }
    if (missing && treat === "ignore") { alarm.stateUpdatedTimestamp = at; alarm.stateReason = "Missing data was configured to be ignored; the current state is maintained"; alarm.stateReasonData = JSON.stringify({ version: "1.0", queryDate: new Date(at).toISOString(), recentDatapoints: realSelected.map(([, value]) => value) }); return; }
    const isBreaching = ([time, value]: [number, number]) => alarm.thresholdMetricId ? this.breachesBand(value, bounds!.get(time)!, alarm.comparisonOperator) : this.breaches(value, alarm.threshold!, alarm.comparisonOperator); const realBreaching = realSelected.filter(isBreaching).length; const breaching = realBreaching + (treat === "breaching" ? missing : 0); const notBreaching = realSelected.length - realBreaching + (treat === "notBreaching" ? missing : 0); let state: CloudWatchAlarmStateValue;
    if (treat === "missing" && missing) state = !realSelected.length ? "INSUFFICIENT_DATA" : breaching >= alarm.datapointsToAlarm ? "ALARM" : notBreaching > alarm.evaluationPeriods - alarm.datapointsToAlarm ? "OK" : "INSUFFICIENT_DATA";
    else state = breaching >= alarm.datapointsToAlarm ? "ALARM" : "OK";
    const reason = state === "INSUFFICIENT_DATA" ? `${missing} of the last ${alarm.evaluationPeriods} datapoints were missing` : `${breaching} of the last ${alarm.evaluationPeriods} datapoints were breaching; ${alarm.datapointsToAlarm} required to alarm`;
    const data = JSON.stringify({ version: "1.0", queryDate: new Date(at).toISOString(), startDate: new Date(start).toISOString(), statistic: alarm.statistic ?? alarm.extendedStatistic ?? "MetricDataQuery", period, recentDatapoints: realSelected.map(([, value]) => value), ...(alarm.thresholdMetricId ? { thresholdMetricId: alarm.thresholdMetricId } : { threshold: alarm.threshold }), evaluatedDatapoints: realSelected.map(([time, value]) => ({ timestamp: new Date(time).toISOString(), sampleCount: sampleCounts.get(time), value, ...(bounds?.get(time) ?? {}) })) });
    await this.transition(alarm, state, reason, data, at, "Evaluation");
  }

  private contributorState(alarm: CloudWatchLogAlarmState, contributor: CloudWatchLogAlarmContributorState): { state: CloudWatchAlarmStateValue; reason: string } {
    const selected = contributor.results.slice(-alarm.queryResultsToEvaluate); const real = selected.filter((item): item is { timestamp: number; value: number } => item.value !== undefined && Number.isFinite(item.value)); const missing = alarm.queryResultsToEvaluate - real.length; const realBreaching = real.filter(item => this.breaches(item.value, alarm.threshold, alarm.comparisonOperator)).length; const breaching = realBreaching + (alarm.treatMissingData === "breaching" ? missing : 0); const notBreaching = real.length - realBreaching + (alarm.treatMissingData === "notBreaching" ? missing : 0); let state: CloudWatchAlarmStateValue;
    if (alarm.treatMissingData === "ignore" && missing) state = contributor.stateValue;
    else if (alarm.treatMissingData === "missing" && missing) state = !real.length ? "INSUFFICIENT_DATA" : breaching >= alarm.queryResultsToAlarm ? "ALARM" : notBreaching > alarm.queryResultsToEvaluate - alarm.queryResultsToAlarm ? "OK" : "INSUFFICIENT_DATA";
    else state = breaching >= alarm.queryResultsToAlarm ? "ALARM" : "OK";
    const reason = alarm.treatMissingData === "ignore" && missing ? "Missing query results were configured to be ignored; the contributor state is maintained" : state === "INSUFFICIENT_DATA" ? `${missing} of the last ${alarm.queryResultsToEvaluate} query results were missing` : `${breaching} of the last ${alarm.queryResultsToEvaluate} query results were breaching; ${alarm.queryResultsToAlarm} required to alarm`; return { state, reason };
  }

  private async evaluateLogAlarms(at: number): Promise<boolean> {
    if (!Object.keys(this.control.logAlarms).length) return false; let dirty = false;
    for (const alarm of Object.values(this.control.logAlarms)) {
      const interval = scheduleRateMs(alarm.scheduledQueryConfiguration.scheduleConfiguration.scheduleExpression); const boundary = Math.floor(at / interval) * interval; if (boundary !== at || alarm.lastEvaluatedAt === boundary) continue; alarm.lastEvaluatedAt = boundary; dirty = true;
      try {
        if (!this.readLogQuery) throw new Error("CloudWatch Logs query evaluation is unavailable"); const schedule = alarm.scheduledQueryConfiguration.scheduleConfiguration; const start = boundary - (schedule.startTimeOffset ?? interval / 1000) * 1000; const end = boundary - (schedule.endTimeOffset ?? 0) * 1000; const result = await this.readLogQuery(alarm.scheduledQueryConfiguration, start, end, alarm.actionLogLineCount); alarm.latestLogLines = result.logLines; alarm.evaluationState = result.partial ? "PARTIAL_DATA" : undefined;
        const current = new Map(result.values.map(item => { const attributes = Object.fromEntries(Object.entries(item.attributes).sort(([a], [b]) => a.localeCompare(b))); const contributorId = createHash("sha256").update(canonical(attributes)).digest("hex").slice(0, 16); return [contributorId, { ...item, attributes }] as const; })); const ids = new Set([...Object.keys(alarm.contributors), ...current.keys()]);
        for (const contributorId of ids) {
          const value = current.get(contributorId); const contributor = alarm.contributors[contributorId] ?? { contributorId, contributorAttributes: value?.attributes ?? {}, stateValue: "INSUFFICIENT_DATA", stateReason: "Unchecked: Initial contributor evaluation", stateTransitionedTimestamp: boundary, results: [] }; const previous = contributor.stateValue; if (value) contributor.contributorAttributes = value.attributes; contributor.results.push({ timestamp: boundary, ...(value ? { value: value.value } : {}) }); contributor.results = contributor.results.slice(-alarm.queryResultsToEvaluate); const evaluated = this.contributorState(alarm, contributor); contributor.stateValue = evaluated.state; contributor.stateReason = evaluated.reason; if (previous !== evaluated.state) { contributor.stateTransitionedTimestamp = boundary; this.history(alarm.alarmName, "AlarmContributorStateUpdate", `Contributor ${contributorId} updated from ${previous} to ${evaluated.state}`, { oldState: previous, newState: evaluated.state, reason: evaluated.reason, value: value?.value }, boundary, "LogAlarm", { id: contributorId, attributes: contributor.contributorAttributes }); this.executeContributorActions(alarm, contributor, evaluated.state, boundary); } alarm.contributors[contributorId] = contributor;
        }
        const contributors = Object.values(alarm.contributors); const state: CloudWatchAlarmStateValue = contributors.some(item => item.stateValue === "ALARM") ? "ALARM" : contributors.some(item => item.stateValue === "OK") ? "OK" : "INSUFFICIENT_DATA"; const reason = state === "ALARM" ? `${contributors.filter(item => item.stateValue === "ALARM").length} contributor(s) are in ALARM` : state === "OK" ? "No contributors are in ALARM" : "The scheduled query has insufficient contributor data"; const reasonData = JSON.stringify({ version: "1.0", queryDate: new Date(boundary).toISOString(), queryStartDate: new Date(start).toISOString(), queryEndDate: new Date(end).toISOString(), contributors: contributors.map(item => ({ contributorId: item.contributorId, attributes: item.contributorAttributes, state: item.stateValue, latestValue: item.results.at(-1)?.value })) }); await this.transition(alarm, state, reason, reasonData, boundary, "ScheduledQueryEvaluation");
      } catch (error) { alarm.evaluationState = error instanceof AwsError && error.code === "InvalidParameterValue" ? "EVALUATION_ERROR" : "EVALUATION_FAILURE"; const reason = `Scheduled query evaluation failed: ${error instanceof Error ? error.message : String(error)}`; await this.transition(alarm, "INSUFFICIENT_DATA", reason, JSON.stringify({ version: "1.0", queryDate: new Date(boundary).toISOString(), error: reason }), boundary, "ScheduledQueryEvaluation"); }
    }
    return dirty;
  }

  private breaches(value: number, threshold: number, operator: CloudWatchComparisonOperator): boolean { return operator === "GreaterThanThreshold" ? value > threshold : operator === "GreaterThanOrEqualToThreshold" ? value >= threshold : operator === "LessThanThreshold" ? value < threshold : value <= threshold; }
  private breachesBand(value: number, band: { lower: number; upper: number }, operator: CloudWatchComparisonOperator): boolean { return operator === "LessThanLowerThreshold" ? value < band.lower : operator === "GreaterThanUpperThreshold" ? value > band.upper : value < band.lower || value > band.upper; }

  private async evaluateCompositeAlarms(at: number, deliveryLineage?: string[]): Promise<void> {
    const completed = new Set<string>(); const visiting: string[] = []; const cycles = new Set<string>();
    const evaluateOne = async (alarm: CloudWatchCompositeAlarmState): Promise<void> => {
      if (completed.has(alarm.alarmName)) return; const cycleAt = visiting.indexOf(alarm.alarmName); if (cycleAt >= 0) { visiting.slice(cycleAt).forEach(item => cycles.add(item)); return; }
      visiting.push(alarm.alarmName); for (const child of alarm.children) if (this.control.compositeAlarms[child]) await evaluateOne(this.control.compositeAlarms[child]); visiting.pop();
      if (cycles.has(alarm.alarmName)) { delete alarm.pendingAction; delete alarm.actionsSuppressedBy; alarm.actionsSuppressedReason = "Evaluation stopped because a composite alarm cycle was detected"; alarm.stateUpdatedTimestamp = at; alarm.stateReason = alarm.actionsSuppressedReason; alarm.stateReasonData = JSON.stringify({ version: "1.0", queryDate: new Date(at).toISOString(), cycle: [...cycles].sort() }); completed.add(alarm.alarmName); return; }
      const parsed = parseAlarmRule(alarm.alarmRule); const state: CloudWatchAlarmStateValue = parsed.evaluate(reference => { const child = this.requireReferencedAlarm(reference); return child?.stateValue ?? "INSUFFICIENT_DATA"; }) ? "ALARM" : "OK"; const children = alarm.children.map(child => { const target = this.control.alarms[child] ?? this.control.compositeAlarms[child] ?? this.control.logAlarms[child]; return { alarmName: child, stateValue: target?.stateValue ?? "INSUFFICIENT_DATA" }; });
      await this.transition(alarm, state, `Composite rule evaluated to ${state}`, JSON.stringify({ version: "1.0", queryDate: new Date(at).toISOString(), alarmRule: alarm.alarmRule, children }), at, "Evaluation", deliveryLineage); await this.updateSuppression(alarm, at); completed.add(alarm.alarmName);
    };
    for (const alarm of Object.values(this.control.compositeAlarms).sort((left, right) => left.alarmName.localeCompare(right.alarmName))) await evaluateOne(alarm);
    await this.store.save();
  }

  private requireReferencedAlarm(reference: string): CloudWatchAnyAlarmState | undefined { let alarmName: string; try { alarmName = this.referenceName(reference); } catch { return undefined; } return this.control.alarms[alarmName] ?? this.control.compositeAlarms[alarmName] ?? this.control.logAlarms[alarmName]; }

  private suppressorExitAt(alarm: CloudWatchCompositeAlarmState): number | undefined {
    if (!alarm.actionsSuppressor) return undefined; const state = this.control.alarmHistory.filter(item => item.alarmName === alarm.actionsSuppressor && item.historyItemType === "StateUpdate").reduce<CloudWatchAlarmHistoryState | undefined>((latest, item) => !latest || item.timestamp >= latest.timestamp ? item : latest, undefined); if (!state) return undefined;
    try { const data = JSON.parse(state.historyData); return data.oldState?.value === "ALARM" && data.newState?.value !== "ALARM" ? state.timestamp : undefined; } catch { return undefined; }
  }

  private suppressCompositeActions(alarm: CloudWatchCompositeAlarmState, previous: { value: CloudWatchAlarmStateValue; reason: string; timestamp: number }, at: number): boolean {
    const actions = alarm.stateValue === "ALARM" ? alarm.alarmActions : alarm.stateValue === "OK" ? alarm.okActions : alarm.insufficientDataActions;
    if (!alarm.actionsEnabled || !actions.length || !alarm.actionsSuppressor) { delete alarm.pendingAction; delete alarm.actionsSuppressedBy; delete alarm.actionsSuppressedReason; return false; } const suppressor = this.control.alarms[alarm.actionsSuppressor] ?? this.control.compositeAlarms[alarm.actionsSuppressor] ?? this.control.logAlarms[alarm.actionsSuppressor];
    const pending = (dueAt: number) => { alarm.pendingAction = { state: alarm.stateValue, dueAt, previousValue: previous.value, previousReason: previous.reason, previousTimestamp: previous.timestamp }; };
    if (suppressor?.stateValue === "ALARM") { alarm.actionsSuppressedBy = "Alarm"; alarm.actionsSuppressedReason = `Actions suppressed by alarm ${alarm.actionsSuppressor}`; pending(at); this.history(alarm.alarmName, "Action", alarm.actionsSuppressedReason, { status: "Suppressed", suppressor: alarm.actionsSuppressor, reason: "Alarm" }, at, "CompositeAlarm"); return true; }
    const exitAt = this.suppressorExitAt(alarm); const extensionDue = exitAt === undefined ? undefined : exitAt + (alarm.actionsSuppressorExtensionPeriod ?? 0) * 1000;
    if (extensionDue !== undefined && at < extensionDue) { alarm.actionsSuppressedBy = "ExtensionPeriod"; alarm.actionsSuppressedReason = `Actions suppressed during the extension period for ${alarm.actionsSuppressor}`; pending(extensionDue); this.history(alarm.alarmName, "Action", alarm.actionsSuppressedReason, { status: "Suppressed", suppressor: alarm.actionsSuppressor, reason: "ExtensionPeriod", until: extensionDue }, at, "CompositeAlarm"); return true; }
    const wait = alarm.actionsSuppressorWaitPeriod ?? 0; if (wait > 0) { alarm.actionsSuppressedBy = "WaitPeriod"; alarm.actionsSuppressedReason = `Waiting for suppressor alarm ${alarm.actionsSuppressor}`; pending(at + wait * 1000); return true; }
    return false;
  }

  private async updateSuppression(alarm: CloudWatchCompositeAlarmState, at: number): Promise<void> {
    if (!alarm.actionsSuppressor) { delete alarm.actionsSuppressedBy; delete alarm.actionsSuppressedReason; delete alarm.pendingAction; return; }
    const suppressor = this.control.alarms[alarm.actionsSuppressor] ?? this.control.compositeAlarms[alarm.actionsSuppressor] ?? this.control.logAlarms[alarm.actionsSuppressor];
    if (alarm.pendingAction) {
      if (!alarm.actionsEnabled || alarm.pendingAction.state !== alarm.stateValue) { delete alarm.pendingAction; delete alarm.actionsSuppressedBy; delete alarm.actionsSuppressedReason; return; }
      if (suppressor?.stateValue === "ALARM") { alarm.actionsSuppressedBy = "Alarm"; alarm.actionsSuppressedReason = `Actions suppressed by alarm ${alarm.actionsSuppressor}`; return; }
      const exitAt = this.suppressorExitAt(alarm); const extensionDue = exitAt === undefined ? undefined : exitAt + (alarm.actionsSuppressorExtensionPeriod ?? 0) * 1000;
      if (extensionDue !== undefined && at < extensionDue) { alarm.pendingAction.dueAt = extensionDue; alarm.actionsSuppressedBy = "ExtensionPeriod"; alarm.actionsSuppressedReason = `Actions suppressed during the extension period for ${alarm.actionsSuppressor}`; return; }
      if (at >= alarm.pendingAction.dueAt) { const pending = alarm.pendingAction; delete alarm.pendingAction; delete alarm.actionsSuppressedBy; delete alarm.actionsSuppressedReason; this.executeActions(alarm, { value: pending.previousValue, reason: pending.previousReason, timestamp: pending.previousTimestamp }, at); }
      return;
    }
    delete alarm.actionsSuppressedBy; delete alarm.actionsSuppressedReason;
  }

  private async transition(alarm: CloudWatchAnyAlarmState, state: CloudWatchAlarmStateValue, reason: string, reasonData: string, at: number, source: string, deliveryLineage?: string[]): Promise<void> {
    const previous = { value: alarm.stateValue, reason: alarm.stateReason, reasonData: alarm.stateReasonData, timestamp: alarm.stateUpdatedTimestamp }; const changed = alarm.stateValue !== state; alarm.stateValue = state; alarm.stateReason = reason; alarm.stateReasonData = reasonData; alarm.stateUpdatedTimestamp = at;
    if (changed) { alarm.stateTransitionedTimestamp = at; this.history(alarm.alarmName, "StateUpdate", `Alarm updated from ${previous.value} to ${state}`, { source, oldState: previous, newState: { value: state, reason, reasonData, timestamp: at } }, at, isComposite(alarm) ? "CompositeAlarm" : isLog(alarm) ? "LogAlarm" : "MetricAlarm"); if (!isLog(alarm) && (!isComposite(alarm) || !this.suppressCompositeActions(alarm, previous, at))) this.executeActions(alarm, previous, at); this.queueStateEvent(alarm, previous, at, deliveryLineage); }
    await this.store.save();
    if (changed) await this.drainEventBridgeOutbox();
  }

  private executeActions(alarm: CloudWatchAnyAlarmState, previous: { value: CloudWatchAlarmStateValue; reason: string; timestamp: number }, at: number): void {
    if (!alarm.actionsEnabled) return; const actions = alarm.stateValue === "ALARM" ? alarm.alarmActions : alarm.stateValue === "OK" ? alarm.okActions : alarm.insufficientDataActions;
    for (const action of actions) {
      const muteRule = this.activeMuteRule(alarm.alarmName, at); if (muteRule) { this.history(alarm.alarmName, "Action", `Action ${action} was muted by ${muteRule.name}`, { action, state: alarm.stateValue, status: "Suppressed", alarmMuteRuleName: muteRule.name }, at); continue; }
      if (/^arn:[^:]+:lambda:/.test(action) && this.lambda) {
        const configuration = isComposite(alarm) ? { description: alarm.alarmDescription, alarmRule: alarm.alarmRule, actionsSuppressor: alarm.actionsSuppressor } : isLog(alarm) ? { description: alarm.alarmDescription, scheduledQueryConfiguration: this.logView(alarm).ScheduledQueryConfiguration, queryResultsToEvaluate: alarm.queryResultsToEvaluate, queryResultsToAlarm: alarm.queryResultsToAlarm, threshold: alarm.threshold } : { description: alarm.alarmDescription, metrics: alarm.metrics ?? [{ id: "m1", metricStat: { metric: { namespace: alarm.namespace, name: alarm.metricName, dimensions: Object.fromEntries((alarm.dimensions ?? []).map(item => [item.Name, item.Value])) }, period: alarm.period, stat: alarm.statistic ?? alarm.extendedStatistic } }] }; const event = { source: "aws.cloudwatch", alarmArn: alarm.alarmArn, accountId: this.store.accountId, time: new Date(at).toISOString(), region: this.region, alarmData: { alarmName: alarm.alarmName, state: { value: alarm.stateValue, reason: alarm.stateReason, timestamp: new Date(at).toISOString() }, previousState: { value: previous.value, reason: previous.reason, timestamp: new Date(previous.timestamp).toISOString() }, configuration } };
        this.enqueueLambdaAction(alarm, action, event, previous, at);
      } else if (/^arn:[^:]+:sns:/.test(action) && this.publishSns) {
        this.enqueueSnsAction(alarm, action, previous, at);
      } else this.history(alarm.alarmName, "Action", `Action ${action} was not executed because its service dependency is unavailable`, { action, state: alarm.stateValue, status: "DependencyBlocked" }, at);
    }
  }

  private executeContributorActions(alarm: CloudWatchLogAlarmState, contributor: CloudWatchLogAlarmContributorState, state: CloudWatchAlarmStateValue, at: number): void {
    if (!alarm.actionsEnabled) return; const actions = state === "ALARM" ? alarm.alarmActions : state === "OK" ? alarm.okActions : alarm.insufficientDataActions; const contributorContext = { id: contributor.contributorId, attributes: contributor.contributorAttributes };
    for (const action of actions) {
      const muteRule = this.activeMuteRule(alarm.alarmName, at); if (muteRule) { this.history(alarm.alarmName, "AlarmContributorAction", `Contributor action ${action} was muted by ${muteRule.name}`, { action, state, status: "Suppressed", alarmMuteRuleName: muteRule.name }, at, "LogAlarm", contributorContext); continue; }
      if (/^arn:[^:]+:lambda:/.test(action) && this.lambda) {
        const event = { source: "aws.cloudwatch", alarmArn: alarm.alarmArn, accountId: this.store.accountId, time: new Date(at).toISOString(), region: this.region, alarmData: { alarmName: alarm.alarmName, state: { value: state, reason: contributor.stateReason, timestamp: new Date(at).toISOString() }, configuration: { description: alarm.alarmDescription, scheduledQueryConfiguration: this.logView(alarm).ScheduledQueryConfiguration, queryResultsToEvaluate: alarm.queryResultsToEvaluate, queryResultsToAlarm: alarm.queryResultsToAlarm, threshold: alarm.threshold }, contributor: { contributorId: contributor.contributorId, contributorAttributes: contributor.contributorAttributes, latestValue: contributor.results.at(-1)?.value }, ...(alarm.actionLogLineCount > 0 ? { logLines: alarm.latestLogLines.slice(0, alarm.actionLogLineCount) } : {}) } };
        this.enqueueLambdaAction(alarm, action, event, { value: alarm.stateValue, reason: contributor.stateReason, timestamp: at }, at, contributorContext, state);
      } else if (/^arn:[^:]+:sns:/.test(action) && this.publishSns) {
        this.enqueueSnsAction(alarm, action, { value: alarm.stateValue, reason: contributor.stateReason, timestamp: at }, at, contributorContext);
      } else this.history(alarm.alarmName, "AlarmContributorAction", `Contributor action ${action} was not executed because its service dependency is unavailable`, { action, state, status: "DependencyBlocked" }, at, "LogAlarm", contributorContext);
    }
  }
}
