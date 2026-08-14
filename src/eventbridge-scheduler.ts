import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StateStore } from "./state.js";
import type { Clock } from "./core/clock.js";
import type { Scheduler } from "./core/scheduler.js";
import type { LambdaService } from "./lambda.js";
import type { SqsService } from "./sqs.js";
import type { CloudWatchLogsService } from "./cloudwatch-logs.js";
import type { EventBridgeService } from "./eventbridge.js";
import type { StepFunctionsService } from "./step-functions.js";
import type { EventBridgeScheduleGroupState, EventBridgeScheduleOccurrenceState, EventBridgeScheduleState, EventBridgeSchedulerTargetState } from "./types.js";
import { AwsError } from "./errors.js";
import { evaluateRoleAuthorization, evaluateTrust, roleSessionAuthorizationContext } from "./iam/evaluator.js";
import { PaginationTokens } from "./core/pagination.js";
import { id, json, readJson } from "./util.js";
import { nextScheduleOccurrence, parseScheduleExpression, validateScheduleTimezone } from "./eventbridge/schedule-expression.js";

const NAME = /^[0-9A-Za-z_.-]{1,64}$/;
const TOKEN = /^[!-~]{1,64}$/;
const DEFAULT_MAX_AGE = 86_400;
const DEFAULT_RETRIES = 185;
const LEASE_MS = 30_000;
const MAX_TERMINAL_OCCURRENCES = 1_000;

function object(value: unknown, name: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("ValidationException", `${name} must be an object.`, 400);
  return value as Record<string, any>;
}
function integer(value: unknown, name: string, minimum: number, maximum: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new AwsError("ValidationException", `${name} must be between ${minimum} and ${maximum}.`, 400);
  return parsed;
}
function timestamp(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "number" ? (Math.abs(value) < 100_000_000_000 ? value * 1000 : value) : Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new AwsError("ValidationException", `${name} must be a valid timestamp.`, 400);
  return parsed;
}
function token(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const result = String(value); if (!TOKEN.test(result)) throw new AwsError("ValidationException", "ClientToken must contain 1-64 visible characters.", 400); return result;
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function tags(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length > 50) throw new AwsError("ValidationException", "Tags must contain at most 50 entries.", 400);
  const result: Record<string, string> = Object.create(null);
  for (const item of value) {
    const tag = object(item, "Tag"); const key = String(tag.Key ?? ""); const text = String(tag.Value ?? "");
    if (!key || key.length > 128 || key.toLowerCase().startsWith("aws:") || text.length > 256) throw new AwsError("ValidationException", "A schedule-group tag is invalid.", 400);
    result[key] = text;
  }
  return result;
}
function errorCode(error: unknown): string { return error instanceof AwsError ? error.code : "InternalServerException"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function retryable(error: unknown): boolean { return error instanceof AwsError && (error.status === 429 || error.status >= 500); }

export class EventBridgeSchedulerService {
  private stopped = true;
  private cancelWorker?: () => void;
  private workerRunning = false;
  private groupDeletions = new Map<string, () => void>();
  private stepFunctions?: StepFunctionsService;

  constructor(
    private readonly store: StateStore,
    private readonly region: string,
    private readonly clock: Clock,
    private readonly scheduler: Scheduler,
    private readonly lambda: LambdaService,
    private readonly sqs: SqsService,
    private readonly logs: CloudWatchLogsService,
    private readonly events: EventBridgeService,
  ) {}

  setStepFunctionsService(service: StepFunctionsService): void { this.stepFunctions = service; }

  private get groups(): Record<string, EventBridgeScheduleGroupState> { return this.store.regionState(this.region).eventScheduleGroups; }
  private get schedules(): Record<string, EventBridgeScheduleState> { return this.store.regionState(this.region).eventSchedules; }
  private get occurrences(): Record<string, EventBridgeScheduleOccurrenceState> { return this.store.regionState(this.region).eventScheduleOccurrences; }
  private get mutationScope(): string { return `eventbridge-scheduler:${this.store.accountId}:${this.region}`; }
  private get pagination(): PaginationTokens { return new PaginationTokens(this.store.state.installation.paginationSecret); }
  private groupArn(name: string): string { return `arn:aws:scheduler:${this.region}:${this.store.accountId}:schedule-group/${name}`; }
  private scheduleArn(group: string, name: string): string { return `arn:aws:scheduler:${this.region}:${this.store.accountId}:schedule/${group}/${name}`; }
  private key(group: string, name: string): string { return `${group}\0${name}`; }

  async start(): Promise<void> {
    this.stopped = false; let dirty = false; const now = this.clock.now();
    if (!this.groups.default) { this.groups.default = { name: "default", arn: this.groupArn("default"), state: "ACTIVE", creationDate: now, lastModificationDate: now, tags: {} }; dirty = true; }
    for (const occurrence of Object.values(this.occurrences)) {
      if (occurrence.status === "LEASED") { occurrence.status = "QUEUED"; delete occurrence.leaseId; delete occurrence.leaseUntil; dirty = true; }
      else if (occurrence.status === "DLQ_LEASED") { occurrence.status = "DLQ_QUEUED"; delete occurrence.leaseId; delete occurrence.leaseUntil; dirty = true; }
    }
    for (const schedule of Object.values(this.schedules)) {
      schedule.generation ??= randomUUID();
      if (schedule.state === "ENABLED" && schedule.nextScheduledAt === undefined && !schedule.completedAt) { this.recompute(schedule, now - 1); dirty = true; }
    }
    if (dirty) await this.store.save();
    for (const group of Object.values(this.groups)) if (group.state === "DELETING") this.finishGroupDeletion(group.name);
    this.scheduleNext();
  }
  async stop(): Promise<void> { this.stopped = true; this.cancelWorker?.(); this.cancelWorker = undefined; for (const cancel of this.groupDeletions.values()) cancel(); this.groupDeletions.clear(); }

  private validName(value: unknown, label: string): string { const result = String(value ?? ""); if (!NAME.test(result)) throw new AwsError("ValidationException", `${label} is invalid.`, 400); return result; }
  private requireGroup(value: unknown): EventBridgeScheduleGroupState {
    const name = this.validName(value ?? "default", "GroupName"); const group = this.groups[name];
    if (!group) throw new AwsError("ResourceNotFoundException", `Schedule group ${name} does not exist.`, 404);
    if (group.state === "DELETING") throw new AwsError("ConflictException", `Schedule group ${name} is being deleted.`, 409);
    return group;
  }
  private requireSchedule(nameValue: unknown, groupValue: unknown): EventBridgeScheduleState {
    const name = this.validName(nameValue, "Name"); const group = this.validName(groupValue ?? "default", "GroupName"); const schedule = this.schedules[this.key(group, name)];
    if (!schedule) throw new AwsError("ResourceNotFoundException", `Schedule ${group}/${name} does not exist.`, 404);
    return schedule;
  }
  private executionRole(roleArnValue: unknown): string {
    const roleArn = String(roleArnValue ?? ""); const role = Object.values(this.store.ensureAccount().iam.roles).find(candidate => candidate.arn === roleArn);
    if (!role || evaluateTrust(role.assumeRolePolicyDocument, "scheduler.amazonaws.com", "sts:AssumeRole", { "aws:PrincipalServiceName": "scheduler.amazonaws.com" }).decision !== "allowed") throw new AwsError("ValidationException", "Target.RoleArn must identify a role that trusts scheduler.amazonaws.com.", 400);
    return roleArn;
  }
  private authorize(roleArn: string, action: string, resource: string, sourceArn: string): void {
    const context = roleSessionAuthorizationContext(roleArn, this.region, this.clock.now(), { "aws:SourceArn": sourceArn, "aws:SourceAccount": this.store.accountId });
    if (evaluateRoleAuthorization(this.store.ensureAccount().iam, roleArn, action, resource, context).decision !== "allowed") throw new AwsError("AccessDeniedException", `Scheduler execution role ${roleArn} cannot perform ${action} on ${resource}.`, 403);
  }

  private target(value: unknown): EventBridgeSchedulerTargetState {
    const input = object(value, "Target"); const arn = String(input.Arn ?? ""); const roleArn = this.executionRole(input.RoleArn);
    if (!arn || arn.length > 1600) throw new AwsError("ValidationException", "Target.Arn is invalid.", 400);
    const retry = input.RetryPolicy === undefined ? {} : object(input.RetryPolicy, "Target.RetryPolicy");
    const result: EventBridgeSchedulerTargetState = {
      arn, roleArn,
      maximumEventAgeInSeconds: integer(retry.MaximumEventAgeInSeconds, "MaximumEventAgeInSeconds", 60, 86_400, DEFAULT_MAX_AGE),
      maximumRetryAttempts: integer(retry.MaximumRetryAttempts, "MaximumRetryAttempts", 0, 185, DEFAULT_RETRIES),
    };
    if (input.Input !== undefined) {
      const supplied = String(input.Input); if (Buffer.byteLength(supplied) > 256 * 1024) throw new AwsError("ValidationException", "Target.Input exceeds 256 KiB.", 400); result.input = supplied;
    }
    const lambda = arn.match(/^arn:aws:lambda:([^:]+):(\d{12}):function:/);
    const sqs = arn.match(/^arn:aws:sqs:([^:]+):(\d{12}):([^:]+)$/);
    const bus = arn.match(/^arn:aws:events:([^:]+):(\d{12}):event-bus\/(.+)$/);
    const states = arn.match(/^arn:aws:states:([^:]+):(\d{12}):stateMachine:[A-Za-z0-9-_]{1,80}$/);
    const universal = arn.match(/^arn:aws:scheduler:::aws-sdk:(cloudwatchlogs|logs):putLogEvents$/i);
    if (lambda) {
      if (lambda[1] !== this.region || lambda[2] !== this.store.accountId) throw new AwsError("ValidationException", "Lambda targets must use this account and Region.", 400);
      this.lambda.assertFunctionExists(arn); if (result.input !== undefined) try { JSON.parse(result.input); } catch { throw new AwsError("ValidationException", "Lambda target Input must be valid JSON.", 400); }
    } else if (sqs) {
      if (sqs[1] !== this.region || sqs[2] !== this.store.accountId) throw new AwsError("ValidationException", "SQS targets must use this account and Region.", 400);
      const queue = this.sqs.resolveQueueArn(arn);
      if (input.SqsParameters !== undefined) { const parameters = object(input.SqsParameters, "Target.SqsParameters"); result.sqsMessageGroupId = String(parameters.MessageGroupId ?? ""); if (!result.sqsMessageGroupId || result.sqsMessageGroupId.length > 128) throw new AwsError("ValidationException", "SqsParameters.MessageGroupId is invalid.", 400); }
      if (queue.fifo && queue.state.attributes.ContentBasedDeduplication !== "true") throw new AwsError("ValidationException", "Scheduler FIFO targets require content-based deduplication.", 400);
      if (queue.fifo && !result.sqsMessageGroupId) throw new AwsError("ValidationException", "Scheduler FIFO targets require SqsParameters.MessageGroupId.", 400);
    } else if (bus) {
      if (bus[1] !== this.region || bus[2] !== this.store.accountId || !this.events.hasEventBusArn(arn)) throw new AwsError("ValidationException", "EventBridge targets must identify an existing bus in this account and Region.", 400);
      const parameters = object(input.EventBridgeParameters, "Target.EventBridgeParameters"); const detailType = String(parameters.DetailType ?? ""); const source = String(parameters.Source ?? "");
      if (!detailType || detailType.length > 128 || !source || source.length > 256) throw new AwsError("ValidationException", "EventBridgeParameters requires valid DetailType and Source.", 400);
      if (result.input !== undefined) try { const parsed = JSON.parse(result.input); object(parsed, "EventBridge target Input"); } catch (error) { if (error instanceof AwsError) throw error; throw new AwsError("ValidationException", "EventBridge target Input must be a JSON object.", 400); }
      result.eventBridgeParameters = { detailType, source };
    } else if (states) {
      if (states[1] !== this.region || states[2] !== this.store.accountId || !this.stepFunctions?.hasStateMachine(arn)) throw new AwsError("ValidationException", "Step Functions targets must identify an existing Standard state machine in this account and Region.", 400);
      if (result.input !== undefined) try { JSON.parse(result.input); } catch { throw new AwsError("ValidationException", "Step Functions target Input must be valid JSON.", 400); }
    } else if (universal) {
      if (result.input === undefined) throw new AwsError("ValidationException", "The CloudWatch Logs universal target requires Input.", 400);
      try { object(JSON.parse(result.input), "CloudWatch Logs target Input"); } catch (error) { if (error instanceof AwsError) throw error; throw new AwsError("ValidationException", "CloudWatch Logs target Input must be valid JSON.", 400); }
      result.universal = { service: "logs", action: "putLogEvents" };
    } else throw new AwsError("ValidationException", "Target.Arn is not in the locally implemented Scheduler target allowlist.", 400);
    for (const field of ["EcsParameters", "KinesisParameters", "SageMakerPipelineParameters"]) if (input[field] !== undefined) throw new AwsError("ValidationException", `${field} is not available in the local Scheduler profile.`, 400);
    if (input.DeadLetterConfig !== undefined) {
      const dlqArn = String(object(input.DeadLetterConfig, "Target.DeadLetterConfig").Arn ?? ""); const match = dlqArn.match(/^arn:aws:sqs:([^:]+):(\d{12}):([^:]+)$/);
      if (!match || match[1] !== this.region || match[2] !== this.store.accountId) throw new AwsError("ValidationException", "The Scheduler DLQ must be a Standard SQS queue in this account and Region.", 400);
      const queue = this.sqs.resolveQueueArn(dlqArn); if (queue.fifo) throw new AwsError("ValidationException", "The Scheduler DLQ must be a Standard SQS queue.", 400); result.deadLetterArn = dlqArn;
    }
    return result;
  }

  private window(value: unknown): EventBridgeScheduleState["flexibleTimeWindow"] {
    const supplied = object(value, "FlexibleTimeWindow"); const mode = String(supplied.Mode ?? "");
    if (mode === "OFF") { if (supplied.MaximumWindowInMinutes !== undefined) throw new AwsError("ValidationException", "MaximumWindowInMinutes is valid only for FLEXIBLE mode.", 400); return { mode: "OFF" }; }
    if (mode !== "FLEXIBLE") throw new AwsError("ValidationException", "FlexibleTimeWindow.Mode must be OFF or FLEXIBLE.", 400);
    return { mode: "FLEXIBLE", maximumWindowInMinutes: integer(supplied.MaximumWindowInMinutes, "MaximumWindowInMinutes", 1, 1440) };
  }
  private normalize(input: any, name: string, groupName: string, existing?: EventBridgeScheduleState): EventBridgeScheduleState {
    if (input.KmsKeyArn !== undefined) {
      if (!/^arn:aws:kms:[^:]+:\d{12}:key\/[0-9a-f-]+$/i.test(String(input.KmsKeyArn))) throw new AwsError("ValidationException", "KmsKeyArn is invalid.", 400);
      throw new AwsError("ValidationException", "Customer-managed Scheduler encryption depends on a later KMS phase; no schedule state was changed.", 400);
    }
    const expression = String(input.ScheduleExpression ?? ""); parseScheduleExpression(expression);
    const timezone = validateScheduleTimezone(input.ScheduleExpressionTimezone);
    const state = String(input.State ?? "ENABLED"); if (state !== "ENABLED" && state !== "DISABLED") throw new AwsError("ValidationException", "State must be ENABLED or DISABLED.", 400);
    const startDate = timestamp(input.StartDate, "StartDate"); const endDate = timestamp(input.EndDate, "EndDate"); if (startDate !== undefined && endDate !== undefined && startDate >= endDate) throw new AwsError("ValidationException", "StartDate must be before EndDate.", 400);
    const description = input.Description === undefined ? undefined : String(input.Description); if (description !== undefined && description.length > 512) throw new AwsError("ValidationException", "Description exceeds 512 characters.", 400);
    const action = String(input.ActionAfterCompletion ?? "NONE"); if (action !== "NONE" && action !== "DELETE") throw new AwsError("ValidationException", "ActionAfterCompletion must be NONE or DELETE.", 400);
    const now = this.clock.now(); const schedule: EventBridgeScheduleState = {
      name, groupName, generation: randomUUID(), arn: existing?.arn ?? this.scheduleArn(groupName, name), scheduleExpression: expression, scheduleExpressionTimezone: timezone,
      ...(startDate !== undefined ? { startDate } : {}), ...(endDate !== undefined ? { endDate } : {}), ...(description !== undefined ? { description } : {}),
      state, flexibleTimeWindow: this.window(input.FlexibleTimeWindow), target: this.target(input.Target), actionAfterCompletion: action,
      creationDate: existing?.creationDate ?? now, lastModificationDate: now,
    };
    if (existing && existing.scheduleExpression === expression && existing.scheduleExpressionTimezone === timezone) { schedule.lastCommittedScheduledAt = existing.lastCommittedScheduledAt; schedule.lastCommittedLocalKey = existing.lastCommittedLocalKey; }
    if (state === "ENABLED") this.recompute(schedule, existing ? now : now - 1);
    return schedule;
  }

  private flexibleOffset(schedule: EventBridgeScheduleState, scheduledAt: number): number {
    const minutes = schedule.flexibleTimeWindow.maximumWindowInMinutes ?? 0; if (!minutes) return 0;
    const value = createHash("sha256").update(`${schedule.arn}:${scheduledAt}`).digest().readUInt32BE(0);
    return value % (minutes * 60_000);
  }
  private recompute(schedule: EventBridgeScheduleState, after: number): void {
    const next = nextScheduleOccurrence({ expression: schedule.scheduleExpression, timezone: schedule.scheduleExpressionTimezone, after, anchor: schedule.startDate ?? schedule.creationDate, startDate: schedule.startDate, endDate: schedule.endDate, lastLocalKey: schedule.lastCommittedLocalKey, rateFirstAtAnchor: true });
    schedule.nextScheduledAt = next?.at; schedule.nextInvocationAt = next ? next.at + this.flexibleOffset(schedule, next.at) : undefined;
    if (!next) schedule.completedAt ??= this.clock.now(); else delete schedule.completedAt;
  }

  private page<T>(operation: string, scope: unknown, values: T[], maxValue: unknown, tokenValue: unknown): { values: T[]; nextToken?: string } {
    const max = integer(maxValue, "MaxResults", 1, 100, 100); let index = 0;
    if (tokenValue !== undefined) try { const decoded = this.pagination.decode<{ index: number; scope: unknown }>(operation, String(tokenValue)); if (JSON.stringify(decoded.scope) !== JSON.stringify(scope)) throw new Error(); index = decoded.index; } catch { throw new AwsError("ValidationException", "NextToken is invalid.", 400); }
    const page = values.slice(index, index + max); const next = index + page.length; return { values: page, ...(next < values.length ? { nextToken: this.pagination.encode(operation, { index: next, scope }) } : {}) };
  }
  private scheduleView(schedule: EventBridgeScheduleState): any {
    const target = schedule.target;
    return { Arn: schedule.arn, GroupName: schedule.groupName, Name: schedule.name, ScheduleExpression: schedule.scheduleExpression, ...(schedule.startDate !== undefined ? { StartDate: schedule.startDate / 1000 } : {}), ...(schedule.endDate !== undefined ? { EndDate: schedule.endDate / 1000 } : {}), ...(schedule.description !== undefined ? { Description: schedule.description } : {}), ScheduleExpressionTimezone: schedule.scheduleExpressionTimezone, State: schedule.state, CreationDate: schedule.creationDate / 1000, LastModificationDate: schedule.lastModificationDate / 1000, Target: { Arn: target.arn, RoleArn: target.roleArn, ...(target.input !== undefined ? { Input: target.input } : {}), ...(target.deadLetterArn ? { DeadLetterConfig: { Arn: target.deadLetterArn } } : {}), RetryPolicy: { MaximumEventAgeInSeconds: target.maximumEventAgeInSeconds, MaximumRetryAttempts: target.maximumRetryAttempts }, ...(target.sqsMessageGroupId ? { SqsParameters: { MessageGroupId: target.sqsMessageGroupId } } : {}), ...(target.eventBridgeParameters ? { EventBridgeParameters: { DetailType: target.eventBridgeParameters.detailType, Source: target.eventBridgeParameters.source } } : {}) }, FlexibleTimeWindow: { Mode: schedule.flexibleTimeWindow.mode, ...(schedule.flexibleTimeWindow.maximumWindowInMinutes ? { MaximumWindowInMinutes: schedule.flexibleTimeWindow.maximumWindowInMinutes } : {}) }, ActionAfterCompletion: schedule.actionAfterCompletion };
  }
  private groupView(group: EventBridgeScheduleGroupState): any { return { Arn: group.arn, Name: group.name, State: group.state, CreationDate: group.creationDate / 1000, LastModificationDate: group.lastModificationDate / 1000 }; }

  async CreateSchedule(input: any, nameValue: unknown): Promise<any> {
    return this.store.withMutationLock(this.mutationScope, async () => {
      const name = this.validName(nameValue, "Name"); const group = this.requireGroup(input.GroupName); const key = this.key(group.name, name); const clientToken = token(input.ClientToken); const requestHash = hash({ ...input, ClientToken: undefined, Name: name, GroupName: group.name });
      const existing = this.schedules[key]; if (existing) { if (clientToken && existing.clientToken === clientToken && existing.clientTokenHash === requestHash) return { ScheduleArn: existing.arn }; throw new AwsError("ConflictException", `Schedule ${group.name}/${name} already exists.`, 409); }
      const schedule = this.normalize(input, name, group.name); schedule.clientToken = clientToken; schedule.clientTokenHash = requestHash; this.schedules[key] = schedule; await this.store.save(); this.scheduleNext(); return { ScheduleArn: schedule.arn };
    });
  }
  async UpdateSchedule(input: any, nameValue: unknown): Promise<any> {
    return this.store.withMutationLock(this.mutationScope, async () => {
      const existing = this.requireSchedule(nameValue, input.GroupName); const clientToken = token(input.ClientToken); const requestHash = hash({ ...input, ClientToken: undefined, Name: existing.name, GroupName: existing.groupName });
      if (clientToken && existing.clientToken === clientToken) {
        if (existing.clientTokenHash === requestHash) return { ScheduleArn: existing.arn };
        throw new AwsError("ConflictException", "ClientToken was reused with different schedule parameters.", 409);
      }
      const updated = this.normalize(input, existing.name, existing.groupName, existing); updated.clientToken = clientToken; updated.clientTokenHash = requestHash; this.schedules[this.key(existing.groupName, existing.name)] = updated; await this.store.save(); this.scheduleNext(); return { ScheduleArn: updated.arn };
    });
  }
  async GetSchedule(input: any, name: unknown): Promise<any> { return this.scheduleView(this.requireSchedule(name, input.GroupName)); }
  async DeleteSchedule(input: any, name: unknown): Promise<any> { return this.store.withMutationLock(this.mutationScope, async () => { const schedule = this.requireSchedule(name, input.GroupName); delete this.schedules[this.key(schedule.groupName, schedule.name)]; await this.store.save(); this.scheduleNext(); return {}; }); }
  async ListSchedules(input: any): Promise<any> {
    const group = input.GroupName === undefined ? undefined : this.validName(input.GroupName, "GroupName"); const prefix = input.NamePrefix === undefined ? undefined : String(input.NamePrefix); const state = input.State === undefined ? undefined : String(input.State);
    if (state && state !== "ENABLED" && state !== "DISABLED") throw new AwsError("ValidationException", "State filter is invalid.", 400);
    const values = Object.values(this.schedules).filter(item => (!group || item.groupName === group) && (!prefix || item.name.startsWith(prefix)) && (!state || item.state === state)).sort((a, b) => a.name.localeCompare(b.name) || a.groupName.localeCompare(b.groupName));
    const page = this.page("ListSchedules", { group: group ?? null, prefix: prefix ?? null, state: state ?? null }, values, input.MaxResults, input.NextToken);
    return { Schedules: page.values.map(item => ({ Arn: item.arn, Name: item.name, GroupName: item.groupName, State: item.state, CreationDate: item.creationDate / 1000, LastModificationDate: item.lastModificationDate / 1000, Target: { Arn: item.target.arn } })), ...(page.nextToken ? { NextToken: page.nextToken } : {}) };
  }
  async CreateScheduleGroup(input: any, nameValue: unknown): Promise<any> {
    return this.store.withMutationLock(this.mutationScope, async () => {
      const name = this.validName(nameValue, "Name"); const clientToken = token(input.ClientToken); const requestHash = hash({ ...input, ClientToken: undefined, Name: name }); const existing = this.groups[name];
      if (existing) { if (clientToken && existing.clientToken === clientToken && existing.clientTokenHash === requestHash) return { ScheduleGroupArn: existing.arn }; throw new AwsError("ConflictException", `Schedule group ${name} already exists.`, 409); }
      const now = this.clock.now(); const group: EventBridgeScheduleGroupState = { name, arn: this.groupArn(name), state: "ACTIVE", creationDate: now, lastModificationDate: now, tags: tags(input.Tags), clientToken, clientTokenHash: requestHash }; this.groups[name] = group; await this.store.save(); return { ScheduleGroupArn: group.arn };
    });
  }
  async GetScheduleGroup(_input: any, name: unknown): Promise<any> { const group = this.groups[this.validName(name, "Name")]; if (!group) throw new AwsError("ResourceNotFoundException", "Schedule group does not exist.", 404); return this.groupView(group); }
  async ListScheduleGroups(input: any): Promise<any> {
    const prefix = input.NamePrefix === undefined ? undefined : String(input.NamePrefix); const values = Object.values(this.groups).filter(item => !prefix || item.name.startsWith(prefix)).sort((a, b) => a.name.localeCompare(b.name)); const page = this.page("ListScheduleGroups", { prefix: prefix ?? null }, values, input.MaxResults, input.NextToken);
    return { ScheduleGroups: page.values.map(item => this.groupView(item)), ...(page.nextToken ? { NextToken: page.nextToken } : {}) };
  }
  async DeleteScheduleGroup(_input: any, nameValue: unknown): Promise<any> {
    return this.store.withMutationLock(this.mutationScope, async () => {
      const name = this.validName(nameValue, "Name"); if (name === "default") throw new AwsError("ConflictException", "The default schedule group cannot be deleted.", 409); const group = this.groups[name]; if (!group) throw new AwsError("ResourceNotFoundException", "Schedule group does not exist.", 404);
      group.state = "DELETING"; group.lastModificationDate = this.clock.now(); for (const schedule of Object.values(this.schedules).filter(item => item.groupName === name)) { schedule.state = "DISABLED"; delete schedule.nextScheduledAt; delete schedule.nextInvocationAt; } await this.store.save();
      this.finishGroupDeletion(name); this.scheduleNext(); return {};
    });
  }
  private finishGroupDeletion(name: string): void {
    this.groupDeletions.get(name)?.();
    this.groupDeletions.set(name, this.scheduler.schedule(async () => {
      this.groupDeletions.delete(name); await this.store.withMutationLock(this.mutationScope, async () => {
        for (const schedule of Object.values(this.schedules).filter(item => item.groupName === name)) delete this.schedules[this.key(name, schedule.name)];
        if (Object.values(this.occurrences).some(item => item.groupName === name && !this.terminalOccurrence(item))) return;
        delete this.groups[name]; await this.store.save();
      });
    }, 1));
  }
  private groupByArn(value: unknown): EventBridgeScheduleGroupState {
    const arn = String(value ?? ""); const group = Object.values(this.groups).find(item => item.arn === arn); if (!group) throw new AwsError("ResourceNotFoundException", "Schedule group does not exist.", 404); return group;
  }
  async TagResource(input: any, arn: unknown): Promise<any> { const group = this.groupByArn(arn); const next = { ...group.tags, ...tags(input.Tags) }; if (Object.keys(next).length > 50) throw new AwsError("ValidationException", "A schedule group can have at most 50 tags.", 400); group.tags = next; group.lastModificationDate = this.clock.now(); await this.store.save(); return {}; }
  async UntagResource(input: any, arn: unknown): Promise<any> { const group = this.groupByArn(arn); if (!Array.isArray(input.TagKeys)) throw new AwsError("ValidationException", "TagKeys must be an array.", 400); for (const key of input.TagKeys.map(String)) delete group.tags[key]; group.lastModificationDate = this.clock.now(); await this.store.save(); return {}; }
  async ListTagsForResource(_input: any, arn: unknown): Promise<any> { const group = this.groupByArn(arn); return { Tags: Object.entries(group.tags).sort(([a], [b]) => a.localeCompare(b)).map(([Key, Value]) => ({ Key, Value })) }; }

  private defaultPayload(scheduleArn: string, scheduledAt: number, eventId: string): string {
    return JSON.stringify({ version: "1", id: eventId, "detail-type": "Scheduled Event", source: "aws.scheduler", account: this.store.accountId, time: new Date(scheduledAt).toISOString(), region: this.region, resources: [scheduleArn], detail: { attempt: 0 } });
  }
  private terminalOccurrence(occurrence: EventBridgeScheduleOccurrenceState): boolean { return new Set(["SUCCEEDED", "FAILED", "DLQ_SENT", "DLQ_FAILED"]).has(occurrence.status); }
  private admit(schedule: EventBridgeScheduleState, now: number): EventBridgeScheduleOccurrenceState {
    const scheduledAt = schedule.nextScheduledAt!; const invocationAt = schedule.nextInvocationAt!; const eventId = randomUUID();
    const occurrence: EventBridgeScheduleOccurrenceState = {
      occurrenceId: eventId, eventId, scheduleArn: schedule.arn, scheduleName: schedule.name, groupName: schedule.groupName,
      scheduleGeneration: schedule.generation, scheduledAt, invocationAt, admittedAt: now,
      payload: schedule.target.input ?? this.defaultPayload(schedule.arn, scheduledAt, eventId), target: structuredClone(schedule.target),
      flexibleTimeWindow: structuredClone(schedule.flexibleTimeWindow), actionAfterCompletion: schedule.actionAfterCompletion,
      lineage: [schedule.arn], attempts: 0, nextAttemptAt: now, status: "QUEUED",
    };
    this.occurrences[occurrence.occurrenceId] = occurrence;
    schedule.lastCommittedScheduledAt = scheduledAt;
    schedule.lastCommittedLocalKey = nextScheduleOccurrence({ expression: schedule.scheduleExpression, timezone: schedule.scheduleExpressionTimezone, after: scheduledAt - 1, anchor: schedule.startDate ?? schedule.creationDate, rateFirstAtAnchor: true })?.localKey;
    if (parseScheduleExpression(schedule.scheduleExpression).kind === "at") { delete schedule.nextScheduledAt; delete schedule.nextInvocationAt; schedule.completedAt = now; }
    else this.recompute(schedule, scheduledAt);
    return occurrence;
  }
  private async dispatch(occurrence: EventBridgeScheduleOccurrenceState): Promise<void> {
    const target = occurrence.target; this.executionRole(target.roleArn); const payload = occurrence.payload;
    if (target.arn.includes(":lambda:")) {
      this.authorize(target.roleArn, "lambda:InvokeFunction", target.arn, occurrence.scheduleArn); await this.lambda.enqueueSchedulerInvocation(target.arn, Buffer.from(payload), occurrence.scheduleArn, target.roleArn, occurrence.lineage, occurrence.eventId); return;
    }
    if (target.arn.includes(":sqs:")) {
      this.authorize(target.roleArn, "sqs:SendMessage", target.arn, occurrence.scheduleArn); await this.sqs.sendAuthorizedMessageToArn(target.arn, { MessageBody: payload, ...(target.sqsMessageGroupId ? { MessageGroupId: target.sqsMessageGroupId } : {}) }, { kind: "role", roleArn: target.roleArn, sourceArn: occurrence.scheduleArn, sourceAccount: this.store.accountId, deliveryLineage: occurrence.lineage }); return;
    }
    if (target.arn.includes(":events:")) {
      this.authorize(target.roleArn, "events:PutEvents", target.arn, occurrence.scheduleArn); let detail: unknown = {}; try { detail = JSON.parse(payload); } catch {}
      await this.events.publishServiceEvent({ source: target.eventBridgeParameters!.source, detailType: target.eventBridgeParameters!.detailType, detail, resources: [occurrence.scheduleArn], time: occurrence.scheduledAt, eventBusName: target.arn, roleArn: target.roleArn, requireRole: true, deliveryLineage: occurrence.lineage }); return;
    }
    if (target.arn.includes(":states:")) {
      if (!this.stepFunctions) throw new AwsError("InternalServerException", "The Step Functions Scheduler adapter is unavailable.", 500); this.authorize(target.roleArn, "states:StartExecution", target.arn, occurrence.scheduleArn);
      await this.stepFunctions.startExecutionFromProducer({ stateMachineArn: target.arn, input: payload, name: `scheduler-${createHash("sha256").update(occurrence.occurrenceId).digest("hex").slice(0, 48)}`, roleArn: target.roleArn, sourceArn: occurrence.scheduleArn, deliveryLineage: occurrence.lineage }); return;
    }
    const request = object(JSON.parse(payload), "CloudWatch Logs target Input"); const groupName = String(request.LogGroupName ?? request.logGroupName ?? ""); const streamName = String(request.LogStreamName ?? request.logStreamName ?? ""); const entries = request.LogEvents ?? request.logEvents;
    if (!groupName || !streamName || !Array.isArray(entries)) throw new AwsError("ValidationException", "CloudWatch Logs PutLogEvents input requires LogGroupName, LogStreamName, and LogEvents.", 400);
    const delivered = await this.logs.deliverServiceEvents({ logGroupName: groupName, logStreamName: streamName, logEvents: entries.map((entry: any) => ({ timestamp: timestamp(entry.Timestamp ?? entry.timestamp, "LogEvent.Timestamp")!, message: String(entry.Message ?? entry.message ?? "") })) }, (action, resource) => evaluateRoleAuthorization(this.store.ensureAccount().iam, target.roleArn, action, resource).decision === "allowed", { deliveryLineage: occurrence.lineage });
    if (!delivered) throw new AwsError("AccessDeniedException", "Scheduler execution role cannot deliver the CloudWatch Logs event.", 403);
  }
  private async dispatchDlq(occurrence: EventBridgeScheduleOccurrenceState): Promise<void> {
    const arn = occurrence.target.deadLetterArn!; const [code, ...message] = String(occurrence.lastError ?? "InternalServerException: Delivery failed").split(":");
    this.authorize(occurrence.target.roleArn, "sqs:SendMessage", arn, occurrence.scheduleArn);
    await this.sqs.sendAuthorizedMessageToArn(arn, { MessageBody: occurrence.payload, MessageAttributes: { SCHEDULE_ARN: { DataType: "String", StringValue: occurrence.scheduleArn }, TARGET_ARN: { DataType: "String", StringValue: occurrence.target.arn }, ERROR_CODE: { DataType: "String", StringValue: code }, ERROR_MESSAGE: { DataType: "String", StringValue: message.join(":").trim().slice(0, 1024) }, RETRY_ATTEMPTS: { DataType: "Number", StringValue: String(Math.max(0, occurrence.attempts - 1)) } } }, { kind: "role", roleArn: occurrence.target.roleArn, sourceArn: occurrence.scheduleArn, sourceAccount: this.store.accountId, deliveryLineage: occurrence.lineage });
  }
  private finalize(occurrence: EventBridgeScheduleOccurrenceState, status: "SUCCEEDED" | "FAILED" | "DLQ_SENT" | "DLQ_FAILED", error?: unknown): void {
    occurrence.status = status; occurrence.completedAt = this.clock.now(); delete occurrence.leaseId; delete occurrence.leaseUntil;
    if (error !== undefined) {
      const description = `${errorCode(error)}: ${errorMessage(error)}`;
      if (status === "DLQ_FAILED") occurrence.deadLetterError = description; else occurrence.lastError = description;
    }
    const schedule = this.schedules[this.key(occurrence.groupName, occurrence.scheduleName)];
    if (schedule?.generation === occurrence.scheduleGeneration) {
      schedule.lastDeliveryStatus = status; schedule.lastDeliveryError = status === "SUCCEEDED" ? undefined : occurrence.lastError;
      if (schedule.completedAt && occurrence.actionAfterCompletion === "DELETE") delete this.schedules[this.key(occurrence.groupName, occurrence.scheduleName)];
    }
    const terminal = Object.values(this.occurrences).filter(item => this.terminalOccurrence(item)).sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0));
    for (const stale of terminal.slice(MAX_TERMINAL_OCCURRENCES)) delete this.occurrences[stale.occurrenceId];
  }
  private async checkpointTarget(occurrenceId: string, leaseId: string, error?: unknown): Promise<void> {
    await this.store.withMutationLock(this.mutationScope, async () => {
      const occurrence = this.occurrences[occurrenceId]; if (!occurrence || occurrence.status !== "LEASED" || occurrence.leaseId !== leaseId) return;
      if (error === undefined) this.finalize(occurrence, "SUCCEEDED");
      else {
        occurrence.lastError = `${errorCode(error)}: ${errorMessage(error)}`; const expired = this.clock.now() - occurrence.scheduledAt >= occurrence.target.maximumEventAgeInSeconds * 1000; const exhausted = occurrence.attempts > occurrence.target.maximumRetryAttempts;
        if (retryable(error) && !expired && !exhausted) { occurrence.status = "QUEUED"; occurrence.nextAttemptAt = this.clock.now() + Math.min(300_000, 1000 * 2 ** Math.min(8, occurrence.attempts - 1)); delete occurrence.leaseId; delete occurrence.leaseUntil; }
        else if (occurrence.target.deadLetterArn) { occurrence.status = "DLQ_QUEUED"; occurrence.nextAttemptAt = this.clock.now(); delete occurrence.leaseId; delete occurrence.leaseUntil; }
        else this.finalize(occurrence, "FAILED", error);
      }
      await this.store.save(); if (this.groups[occurrence.groupName]?.state === "DELETING" && this.terminalOccurrence(occurrence)) this.finishGroupDeletion(occurrence.groupName);
    });
  }
  private async checkpointDlq(occurrenceId: string, leaseId: string, error?: unknown): Promise<void> { await this.store.withMutationLock(this.mutationScope, async () => { const occurrence = this.occurrences[occurrenceId]; if (!occurrence || occurrence.status !== "DLQ_LEASED" || occurrence.leaseId !== leaseId) return; this.finalize(occurrence, error === undefined ? "DLQ_SENT" : "DLQ_FAILED", error); await this.store.save(); if (this.groups[occurrence.groupName]?.state === "DELETING") this.finishGroupDeletion(occurrence.groupName); }); }
  private scheduleNext(): void {
    if (this.stopped || this.workerRunning) return; this.cancelWorker?.(); this.cancelWorker = undefined;
    const times = [...Object.values(this.occurrences).filter(item => !this.terminalOccurrence(item)).map(item => item.status === "LEASED" || item.status === "DLQ_LEASED" ? item.leaseUntil ?? this.clock.now() : item.nextAttemptAt), ...Object.values(this.schedules).flatMap(schedule => schedule.state === "ENABLED" && schedule.nextInvocationAt !== undefined ? [schedule.nextInvocationAt] : [])];
    if (!times.length) return; try { this.cancelWorker = this.scheduler.schedule(() => this.runWorker(), Math.max(0, Math.min(...times) - this.clock.now())); } catch { /* shutdown */ }
  }
  private async runWorker(): Promise<void> {
    if (this.stopped || this.workerRunning) return; this.workerRunning = true; this.cancelWorker = undefined;
    try {
      const claim = await this.store.withMutationLock(this.mutationScope, async () => {
        const now = this.clock.now(); for (const occurrence of Object.values(this.occurrences)) {
          if (occurrence.status === "LEASED" && (occurrence.leaseUntil ?? 0) <= now) { occurrence.status = "QUEUED"; delete occurrence.leaseId; delete occurrence.leaseUntil; }
          else if (occurrence.status === "DLQ_LEASED" && (occurrence.leaseUntil ?? 0) <= now) { occurrence.status = "DLQ_QUEUED"; delete occurrence.leaseId; delete occurrence.leaseUntil; }
        }
        let occurrence = Object.values(this.occurrences).filter(item => (item.status === "QUEUED" || item.status === "DLQ_QUEUED") && item.nextAttemptAt <= now).sort((left, right) => left.nextAttemptAt - right.nextAttemptAt || left.admittedAt - right.admittedAt || left.occurrenceId.localeCompare(right.occurrenceId))[0];
        if (!occurrence) { const schedule = Object.values(this.schedules).filter(item => item.state === "ENABLED" && item.nextInvocationAt !== undefined && item.nextInvocationAt <= now).sort((left, right) => left.nextInvocationAt! - right.nextInvocationAt! || left.arn.localeCompare(right.arn))[0]; if (schedule) occurrence = this.admit(schedule, now); }
        if (!occurrence) return undefined; const leaseId = id(24); const dlq = occurrence.status === "DLQ_QUEUED"; occurrence.status = dlq ? "DLQ_LEASED" : "LEASED"; occurrence.leaseId = leaseId; occurrence.leaseUntil = now + LEASE_MS; if (!dlq) occurrence.attempts++; await this.store.save(); return { occurrenceId: occurrence.occurrenceId, leaseId, dlq };
      });
      if (!claim) return; const occurrence = this.occurrences[claim.occurrenceId]; if (!occurrence) return;
      if (!claim.dlq && this.clock.now() - occurrence.scheduledAt >= occurrence.target.maximumEventAgeInSeconds * 1000) await this.checkpointTarget(claim.occurrenceId, claim.leaseId, new AwsError("MaximumEventAgeExceeded", "The scheduled invocation exceeded its maximum event age.", 400));
      else if (claim.dlq) { try { await this.dispatchDlq(structuredClone(occurrence)); await this.checkpointDlq(claim.occurrenceId, claim.leaseId); } catch (error) { await this.checkpointDlq(claim.occurrenceId, claim.leaseId, error); } }
      else { try { await this.dispatch(structuredClone(occurrence)); await this.checkpointTarget(claim.occurrenceId, claim.leaseId); } catch (error) { await this.checkpointTarget(claim.occurrenceId, claim.leaseId, error); } }
    } finally { this.workerRunning = false; this.scheduleNext(); }
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    try {
      const body = req.method === "GET" ? {} : await readJson(req);
      for (const [key, value] of url.searchParams) {
        const field = ({ groupName: "GroupName", scheduleGroup: "GroupName", namePrefix: "NamePrefix", state: "State", nextToken: "NextToken", maxResults: "MaxResults", clientToken: "ClientToken", TagKeys: "TagKeys" } as Record<string, string>)[key] ?? key;
        if (field === "TagKeys") (body.TagKeys ??= []).push(value);
        else body[field] = value;
      }
      const scheduleMatch = url.pathname.match(/^\/schedules\/([^/]+)$/); const groupMatch = url.pathname.match(/^\/schedule-groups\/([^/]+)$/); const tagsMatch = url.pathname.match(/^\/tags\/(.+)$/);
      let output: unknown;
      if (url.pathname === "/schedules" && req.method === "GET") output = await this.ListSchedules(body);
      else if (scheduleMatch && req.method === "POST") output = await this.CreateSchedule(body, decodeURIComponent(scheduleMatch[1]));
      else if (scheduleMatch && req.method === "PUT") output = await this.UpdateSchedule(body, decodeURIComponent(scheduleMatch[1]));
      else if (scheduleMatch && req.method === "GET") output = await this.GetSchedule(body, decodeURIComponent(scheduleMatch[1]));
      else if (scheduleMatch && req.method === "DELETE") output = await this.DeleteSchedule(body, decodeURIComponent(scheduleMatch[1]));
      else if (url.pathname === "/schedule-groups" && req.method === "GET") output = await this.ListScheduleGroups(body);
      else if (groupMatch && req.method === "POST") output = await this.CreateScheduleGroup(body, decodeURIComponent(groupMatch[1]));
      else if (groupMatch && req.method === "GET") output = await this.GetScheduleGroup(body, decodeURIComponent(groupMatch[1]));
      else if (groupMatch && req.method === "DELETE") output = await this.DeleteScheduleGroup(body, decodeURIComponent(groupMatch[1]));
      else if (tagsMatch && req.method === "GET") output = await this.ListTagsForResource(body, decodeURIComponent(tagsMatch[1]));
      else if (tagsMatch && req.method === "POST") output = await this.TagResource(body, decodeURIComponent(tagsMatch[1]));
      else if (tagsMatch && req.method === "DELETE") output = await this.UntagResource(body, decodeURIComponent(tagsMatch[1]));
      else throw new AwsError("ResourceNotFoundException", "Unknown EventBridge Scheduler route.", 404);
      json(res, output ?? {});
    } catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("InternalServerException", errorMessage(error), 500); res.setHeader("x-amzn-errortype", aws.code); json(res, { Message: aws.message, message: aws.message, __type: aws.code }, aws.status);
    }
  }

  diagnostics(): any {
    const occurrences = Object.values(this.occurrences);
    return {
      schedules: Object.values(this.schedules).map(schedule => {
        const pending = occurrences.filter(item => item.scheduleGeneration === schedule.generation && !this.terminalOccurrence(item)).sort((left, right) => left.admittedAt - right.admittedAt || left.occurrenceId.localeCompare(right.occurrenceId))[0];
        return { name: schedule.name, groupName: schedule.groupName, arn: schedule.arn, state: schedule.state, nextScheduledAt: schedule.nextScheduledAt, nextInvocationAt: schedule.nextInvocationAt, pendingDelivery: pending ? { occurrenceId: pending.occurrenceId, eventId: pending.eventId, scheduledAt: pending.scheduledAt, attempts: pending.attempts, status: pending.status, nextAttemptAt: pending.nextAttemptAt, lastError: pending.lastError, deadLetterError: pending.deadLetterError } : undefined, lastDeliveryStatus: schedule.lastDeliveryStatus, lastDeliveryError: schedule.lastDeliveryError };
      }),
      occurrences: occurrences.map(occurrence => ({ occurrenceId: occurrence.occurrenceId, eventId: occurrence.eventId, scheduleArn: occurrence.scheduleArn, scheduleName: occurrence.scheduleName, groupName: occurrence.groupName, scheduledAt: occurrence.scheduledAt, invocationAt: occurrence.invocationAt, admittedAt: occurrence.admittedAt, targetArn: occurrence.target.arn, attempts: occurrence.attempts, status: occurrence.status, nextAttemptAt: occurrence.nextAttemptAt, lastError: occurrence.lastError, deadLetterError: occurrence.deadLetterError, completedAt: occurrence.completedAt })),
    };
  }
}
