import { createHash, createHmac, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import type { Scheduler } from "./core/scheduler.js";
import type { TelemetryBus } from "./core/telemetry.js";
import { AwsError } from "./errors.js";
import { evaluateRoleAuthorization, evaluateTrust, roleSessionAuthorizationContext, type AuthorizationResult } from "./iam/evaluator.js";
import type { LambdaService } from "./lambda.js";
import type { DynamoDbService } from "./dynamodb.js";
import type { SqsService } from "./sqs.js";
import type { SnsService } from "./sns.js";
import type { EventBridgeService } from "./eventbridge.js";
import { parseAwsJson, sendAwsJson } from "./protocols/aws-json.js";
import type { StateStore } from "./state.js";
import type { StepFunctionsActivityState, StepFunctionsCallbackTaskState, StepFunctionsChildState, StepFunctionsExecutionState, StepFunctionsHistoryEventState, StepFunctionsStateMachineState, StepFunctionsTaskJournalState } from "./types.js";
import { id } from "./util.js";
import { validateDefinition, type CompiledDefinition, type ValidationDiagnostic } from "./step-functions/asl-validator.js";
import { StepFunctionsExecutionStore } from "./step-functions/execution-store.js";
import { getPath, matchesChoice, payloadTemplate, stateInput, stateOutput, type AslContext } from "./step-functions/jsonpath.js";
import { acceptedIntegrationAttempt, assertMatchingIntegrationAttempt, integrationInputDigest, type ServiceIntegrationAttempt } from "./step-functions/integration-attempt.js";

export const STEP_FUNCTIONS_P0_ACTIONS = [
  "CreateStateMachine", "DeleteStateMachine", "DescribeExecution", "DescribeStateMachine",
  "DescribeStateMachineForExecution", "GetExecutionHistory", "ListExecutions", "ListStateMachines",
  "ListTagsForResource", "StartExecution", "StopExecution", "TagResource", "UntagResource",
  "UpdateStateMachine", "ValidateStateMachineDefinition",
] as const;
export const STEP_FUNCTIONS_SFN03_ACTIONS = [
  "CreateActivity", "DeleteActivity", "DescribeActivity", "GetActivityTask", "ListActivities",
  "SendTaskFailure", "SendTaskHeartbeat", "SendTaskSuccess",
] as const;

const ACTIONS = new Set<string>([...STEP_FUNCTIONS_P0_ACTIONS, ...STEP_FUNCTIONS_SFN03_ACTIONS]);
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_HISTORY = 25_000;
const MAX_INLINE_MAP_ITEMS = 1_000;
const MAX_NAME = 80;
const DEFAULT_EXECUTION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const OPTIMIZED_LAMBDA = "arn:aws:states:::lambda:invoke";
const ACTIVITY_ARN = /^arn:aws:states:([^:]+):(\d{12}):activity:([^:]{1,80})$/;
const CALLBACK_SUFFIX = ".waitForTaskToken";
const TOKEN_REFERENCE_PREFIX = "__stacksim_task_token_ref_";
const SUSPENDED = Symbol("StepFunctionsTaskSuspended");
type StateTransition = { output?: unknown; next?: string; waitUntil?: number; suspendUntil?: number; terminal?: "SUCCEEDED" | "FAILED"; error?: string; cause?: string };
const ACTION_FIELDS: Record<string, ReadonlySet<string>> = {
  CreateActivity: new Set(["name", "tags", "encryptionConfiguration"]),
  DeleteActivity: new Set(["activityArn"]),
  DescribeActivity: new Set(["activityArn"]),
  GetActivityTask: new Set(["activityArn", "workerName"]),
  ListActivities: new Set(["maxResults", "nextToken"]),
  SendTaskFailure: new Set(["taskToken", "error", "cause"]),
  SendTaskHeartbeat: new Set(["taskToken"]),
  SendTaskSuccess: new Set(["taskToken", "output"]),
  CreateStateMachine: new Set(["name", "definition", "roleArn", "type", "loggingConfiguration", "tracingConfiguration", "tags", "encryptionConfiguration", "publish", "versionDescription"]),
  DeleteStateMachine: new Set(["stateMachineArn"]),
  DescribeExecution: new Set(["executionArn", "includedData"]),
  DescribeStateMachine: new Set(["stateMachineArn", "includedData"]),
  DescribeStateMachineForExecution: new Set(["executionArn", "includedData"]),
  GetExecutionHistory: new Set(["executionArn", "maxResults", "reverseOrder", "nextToken", "includeExecutionData"]),
  ListExecutions: new Set(["stateMachineArn", "statusFilter", "maxResults", "nextToken", "mapRunArn", "redriveFilter"]),
  ListStateMachines: new Set(["maxResults", "nextToken"]),
  ListTagsForResource: new Set(["resourceArn"]),
  StartExecution: new Set(["stateMachineArn", "name", "input", "traceHeader"]),
  StopExecution: new Set(["executionArn", "error", "cause"]),
  TagResource: new Set(["resourceArn", "tags"]),
  UntagResource: new Set(["resourceArn", "tagKeys"]),
  UpdateStateMachine: new Set(["stateMachineArn", "definition", "roleArn", "loggingConfiguration", "tracingConfiguration", "encryptionConfiguration", "publish", "versionDescription"]),
  ValidateStateMachineDefinition: new Set(["definition", "type", "severity", "maxResults"]),
};

class WorkflowError extends Error {
  constructor(readonly error: string, readonly cause: string, readonly retryable = true) { super(cause); }
}

function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function executionName(value: unknown): string {
  const name = String(value ?? "");
  if (!name || [...name].length > MAX_NAME || /[\s<>{}\[\]?*"#%\\^|~`$&,;:/\u0000-\u001f\u007f-\u009f]/u.test(name)) throw new AwsError("InvalidName", "Execution name is invalid.");
  return name;
}
function machineName(value: unknown): string {
  const name = String(value ?? "");
  if (!name || [...name].length > 80 || !/^[A-Za-z0-9-_]+$/.test(name)) throw new AwsError("InvalidName", "State machine name is invalid.");
  return name;
}
function activityName(value: unknown): string {
  const name = String(value ?? "");
  if (!name || [...name].length > MAX_NAME || /[\s<>{}\[\]?*"#%\\^|~`$&,;:/\u0000-\u001f\u007f-\u009f]/u.test(name)) throw new AwsError("InvalidName", "Activity name is invalid.");
  return name;
}
function jsonInput(value: unknown): { text: string; value: unknown } {
  const text = value === undefined ? "{}" : String(value);
  if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) throw new AwsError("InvalidExecutionInput", "Execution input exceeds 262144 bytes.");
  try { return { text, value: JSON.parse(text) }; } catch { throw new AwsError("InvalidExecutionInput", "Execution input is not valid JSON."); }
}
function timestamp(ms: number): number { return ms / 1000; }
function safeCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 32_768);
}
function errorName(error: unknown): string {
  if (error instanceof WorkflowError) return error.error;
  if (error instanceof AwsError) {
    if (/Timeout/i.test(error.code)) return "States.Timeout";
    if (/Throttle|TooManyRequests/i.test(error.code)) return "Lambda.TooManyRequestsException";
    if (/AccessDenied/i.test(error.code)) return "Lambda.AWSLambdaException";
    if (/NotFound/i.test(error.code)) return "Lambda.ResourceNotFoundException";
    return `Lambda.${error.code}`;
  }
  return "States.TaskFailed";
}
function matchesError(patterns: unknown, error: string): boolean {
  if (!Array.isArray(patterns)) return false;
  return patterns.some(pattern => pattern === error || pattern === "States.ALL" && !["States.DataLimitExceeded", "States.Runtime"].includes(error) || pattern === "States.TaskFailed" && error !== "States.Timeout");
}
function tags(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length > 50) throw new AwsError("ValidationException", "tags must contain at most 50 entries.");
  const result: Record<string, string> = {};
  for (const item of value as any[]) {
    if (!item || typeof item.key !== "string" || !item.key || item.key.length > 128 || typeof item.value !== "string" || item.value.length > 256 || result[item.key] !== undefined) throw new AwsError("ValidationException", "A tag is invalid or duplicated.");
    result[item.key] = item.value;
  }
  return result;
}

export class StepFunctionsService {
  private readonly running = new Set<string>();
  private readonly timers = new Map<string, () => void>();
  private readonly executionStore: StepFunctionsExecutionStore;
  private readonly activityWaiters = new Map<string, Set<() => void>>();
  private started = false;
  constructor(
    private readonly store: StateStore,
    private readonly region: string,
    private readonly clock: Clock,
    private readonly scheduler: Scheduler,
    private readonly lambda: LambdaService,
    private readonly telemetry?: TelemetryBus,
    private readonly authMode: "off" | "validate" | "enforce" = "off",
    private readonly random: () => number = Math.random,
    private readonly limits: { maximumConcurrentExecutions?: number; maximumMapConcurrency?: number; executionRetentionMs?: number } = {},
    private readonly publishEvent?: (input: { source: string; detailType: string; detail: unknown; resources: string[]; time: number; deliveryLineage: string[] }) => Promise<unknown>,
    private readonly cloudFormationCallbacks?: { readonly caCertificatePath: string; readonly port: () => number },
    private readonly integrations?: { dynamodb: DynamoDbService; sqs: SqsService; sns: SnsService; eventbridge: EventBridgeService },
  ) { this.executionStore = new StepFunctionsExecutionStore(store.root, store.accountId, region); }

  private get state() { return this.store.regionState(this.region).stepFunctions; }
  private get pagination() { return new PaginationTokens(this.store.state.installation.paginationSecret); }
  private machineArn(name: string): string { return `arn:aws:states:${this.region}:${this.store.accountId}:stateMachine:${name}`; }
  private executionArn(machine: StepFunctionsStateMachineState, name: string): string { return `arn:aws:states:${this.region}:${this.store.accountId}:execution:${machine.name}:${name}`; }
  private activityArn(name: string): string { return `arn:aws:states:${this.region}:${this.store.accountId}:activity:${name}`; }

  async start(): Promise<void> {
    if (this.started) return; this.started = true;
    await this.executionStore.start(this.state);
    await this.releaseTerminalIntegrationReceipts();
    const now = this.clock.now(); let changed = false;
    for (const execution of Object.values(this.state.executions)) this.state.executionNames[`${execution.stateMachineGeneration}:${execution.name}`] = execution.executionArn;
    for (const [arn, execution] of Object.entries(this.state.executions)) {
      if (execution.status === "RUNNING") {
        if (execution.waitingUntil && execution.waitingUntil > now) this.schedule(arn, execution.waitingUntil);
        else void this.run(arn);
      } else if ((execution.stopDate ?? execution.startDate) + (this.limits.executionRetentionMs ?? DEFAULT_EXECUTION_RETENTION_MS) < now) {
        delete this.state.executionNames[`${execution.stateMachineGeneration}:${execution.name}`];
        await this.executionStore.delete(arn); changed = true;
      }
    }
    if (changed) await this.store.save();
  }
  beginShutdown(): void { this.started = false; for (const cancel of this.timers.values()) cancel(); this.timers.clear(); for (const waiters of this.activityWaiters.values()) for (const wake of waiters) wake(); this.activityWaiters.clear(); }
  async stop(): Promise<void> { this.beginShutdown(); await this.executionStore.stop(); await this.store.flush(); }

  private async releaseTerminalIntegrationReceipts(): Promise<void> {
    const releases: Promise<void>[] = [];
    for (const execution of Object.values(this.state.executions)) for (const journal of Object.values(execution.taskJournal ?? {})) if (["SUCCEEDED", "FAILED", "AMBIGUOUS"].includes(journal.status)) releases.push(this.releaseIntegrationReceipt(journal));
    await Promise.allSettled(releases);
  }

  private async releaseIntegrationReceipt(journal: StepFunctionsTaskJournalState): Promise<void> {
    if (journal.service === "DYNAMODB") await this.integrations?.dynamodb.releaseIntegrationAttempt(journal.taskId);
    else if (journal.service === "SQS") await this.integrations?.sqs.releaseIntegrationAttempt(journal.targetArn, journal.taskId);
    else if (journal.service === "SNS") await this.integrations?.sns.releaseIntegrationAttempt(journal.taskId);
    else if (journal.service === "EVENTBRIDGE") await this.integrations?.eventbridge.releaseIntegrationAttempt(journal.taskId);
    else if (journal.service === "LAMBDA") await this.executionStore.deleteIntegrationAttempt(journal.taskId);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = String(req.headers["x-amz-target"] ?? "");
    const action = target.startsWith("AWSStepFunctions.") ? target.slice("AWSStepFunctions.".length) : "";
    try {
      if (req.method !== "POST" || !ACTIONS.has(action)) throw new AwsError("UnknownOperationException", `The operation '${action || "(empty)"}' is not supported.`);
      if (!String(req.headers["content-type"] ?? "").toLowerCase().includes("application/x-amz-json-1.0")) throw new AwsError("UnsupportedMediaTypeException", "Step Functions requires application/x-amz-json-1.0.", 415);
      const input = await parseAwsJson(req);
      for (const field of Object.keys(input)) if (!ACTION_FIELDS[action].has(field)) throw new AwsError("SerializationException", `Unrecognized field '${field}'.`);
      if (action === "ListExecutions" && (input.mapRunArn !== undefined || input.redriveFilter !== undefined)) throw new AwsError("ValidationException", "Map Run and redrive filters are not available in P0.");
      const operation = (this as any)[action];
      const output = await operation.call(this, input);
      sendAwsJson(res, output ?? {}, "1.0");
    } catch (error) {
      const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", safeCause(error), 500);
      res.statusCode = aws.status; res.setHeader("content-type", "application/x-amz-json-1.0");
      res.end(JSON.stringify({ __type: aws.code, message: aws.message, ...aws.details }));
    }
  }

  private validateRole(roleArn: unknown): string {
    const arn = String(roleArn ?? "");
    if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(arn)) throw new AwsError("InvalidArn", "roleArn is invalid.");
    const role = Object.values(this.store.ensureAccount().iam.roles).find(candidate => candidate.arn === arn);
    if (!role) throw new AwsError("InvalidArn", `The role '${arn}' does not exist.`);
    const trust = evaluateTrust(role.assumeRolePolicyDocument, "states.amazonaws.com", "sts:AssumeRole", { "aws:PrincipalAccount": this.store.accountId });
    if (trust.decision !== "allowed") throw new AwsError("AccessDeniedException", `The role '${arn}' cannot be assumed by Step Functions.`, 400);
    return arn;
  }

  private configuration(input: any): { loggingConfiguration: StepFunctionsStateMachineState["loggingConfiguration"]; tracingConfiguration: StepFunctionsStateMachineState["tracingConfiguration"]; encryptionConfiguration: StepFunctionsStateMachineState["encryptionConfiguration"] } {
    if (input.type !== undefined && input.type !== "STANDARD") throw new AwsError("StateMachineTypeNotSupported", "P0 supports STANDARD state machines only.");
    const logging = input.loggingConfiguration;
    if (logging && (logging.level !== undefined && logging.level !== "OFF" || logging.includeExecutionData === true || logging.destinations?.length)) throw new AwsError("ValidationException", "Execution logging requires SFN-05.");
    if (input.tracingConfiguration?.enabled === true) throw new AwsError("ValidationException", "X-Ray tracing is not available.");
    if (input.encryptionConfiguration && !["AWS_OWNED_KEY", undefined].includes(input.encryptionConfiguration.type)) throw new AwsError("ValidationException", "Customer-managed encryption is not available.");
    if (input.publish !== undefined || input.versionDescription !== undefined) throw new AwsError("ValidationException", "State machine versions require SFN-06.");
    return { loggingConfiguration: { level: "OFF", includeExecutionData: false, destinations: [] }, tracingConfiguration: { enabled: false }, encryptionConfiguration: { type: "AWS_OWNED_KEY" } };
  }

  private compile(text: unknown): CompiledDefinition {
    const result = validateDefinition(text, this.region, this.store.accountId);
    if (!result.definition) throw new AwsError("InvalidDefinition", result.diagnostics.map(item => `${item.location}: ${item.message}`).join("; "), 400);
    return result.definition;
  }

  async CreateStateMachine(input: any): Promise<any> {
    const name = machineName(input.name); const arn = this.machineArn(name); const definition = String(input.definition ?? ""); this.compile(definition);
    const roleArn = this.validateRole(input.roleArn); const config = this.configuration(input); const suppliedTags = tags(input.tags);
    return this.store.withMutationLock(`step-functions:${this.region}`, async () => {
      const existingArn = this.state.stateMachineNames[name];
      if (existingArn) {
        const existing = this.state.stateMachines[existingArn];
        if (existing.definition === definition) return { stateMachineArn: arn, creationDate: timestamp(existing.creationDate), stateMachineVersionArn: undefined };
        throw new AwsError("StateMachineAlreadyExists", `State Machine Already Exists: '${arn}'`);
      }
      const now = this.clock.now(); const machine: StepFunctionsStateMachineState = { stateMachineArn: arn, name, generation: randomUUID(), type: "STANDARD", status: "ACTIVE", definition, roleArn, revisionId: randomUUID(), creationDate: now, updateDate: now, tags: suppliedTags, ...config };
      this.state.stateMachines[arn] = machine; this.state.stateMachineNames[name] = arn; this.state.revision++; await this.store.save();
      return { stateMachineArn: arn, creationDate: timestamp(now) };
    });
  }

  async ValidateStateMachineDefinition(input: any): Promise<any> {
    if (input.type !== undefined && input.type !== "STANDARD") return { result: "FAIL", diagnostics: [{ severity: "ERROR", code: "UNSUPPORTED_FEATURE", message: "P0 supports STANDARD state machines only.", location: "$.type" }], truncated: false };
    const result = validateDefinition(input.definition, this.region, this.store.accountId); const max = input.maxResults === undefined ? 100 : Math.max(0, Math.min(100, Number(input.maxResults)));
    const diagnostics = result.diagnostics.filter(item => input.severity === "ERROR" ? item.severity === "ERROR" : true);
    return { result: diagnostics.some(item => item.severity === "ERROR") ? "FAIL" : "OK", diagnostics: diagnostics.slice(0, max), truncated: diagnostics.length > max };
  }

  async DescribeStateMachine(input: any): Promise<any> {
    const machine = this.requireMachine(input.stateMachineArn);
    return this.machineOutput(machine, true);
  }
  async ListStateMachines(input: any): Promise<any> {
    const limit = this.limit(input.maxResults, 100, 1_000); const offset = this.offset("ListStateMachines", input.nextToken);
    const values = Object.values(this.state.stateMachines).sort((a, b) => a.name.localeCompare(b.name)); const page = values.slice(offset, offset + limit);
    return { stateMachines: page.map(machine => ({ stateMachineArn: machine.stateMachineArn, name: machine.name, type: machine.type, creationDate: timestamp(machine.creationDate) })), ...(offset + limit < values.length ? { nextToken: this.pagination.encode("ListStateMachines", offset + limit) } : {}) };
  }
  async UpdateStateMachine(input: any): Promise<any> {
    return this.store.withMutationLock(`step-functions:${this.region}`, async () => {
      const machine = this.requireMachine(input.stateMachineArn);
      if (input.definition === undefined && input.roleArn === undefined && input.loggingConfiguration === undefined && input.tracingConfiguration === undefined && input.encryptionConfiguration === undefined) throw new AwsError("ValidationException", "At least one mutable field is required.");
      if (input.definition !== undefined) { this.compile(input.definition); machine.definition = String(input.definition); }
      if (input.roleArn !== undefined) machine.roleArn = this.validateRole(input.roleArn);
      this.configuration({ ...input, type: "STANDARD" }); machine.revisionId = randomUUID(); machine.updateDate = this.clock.now(); this.state.revision++; await this.store.save();
      return { updateDate: timestamp(machine.updateDate), revisionId: machine.revisionId };
    });
  }
  async DeleteStateMachine(input: any): Promise<any> {
    return this.store.withMutationLock(`step-functions:${this.region}`, async () => {
      const arn = String(input.stateMachineArn ?? ""); const machine = this.state.stateMachines[arn]; if (!machine) return {};
      delete this.state.stateMachines[arn]; delete this.state.stateMachineNames[machine.name]; this.state.revision++; await this.store.save(); return {};
    });
  }
  async TagResource(input: any): Promise<any> { const resource = this.requireTagged(input.resourceArn); Object.assign(resource.tags, tags(input.tags)); await this.store.save(); return {}; }
  async UntagResource(input: any): Promise<any> { const resource = this.requireTagged(input.resourceArn); if (!Array.isArray(input.tagKeys)) throw new AwsError("ValidationException", "tagKeys must be an array."); for (const key of input.tagKeys) delete resource.tags[String(key)]; await this.store.save(); return {}; }
  async ListTagsForResource(input: any): Promise<any> { const resource = this.requireTagged(input.resourceArn); return { tags: Object.entries(resource.tags).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value })) }; }

  async CreateActivity(input: any): Promise<any> {
    const name = activityName(input.name); const arn = this.activityArn(name); const suppliedTags = tags(input.tags);
    if (input.encryptionConfiguration && ![undefined, "AWS_OWNED_KEY"].includes(input.encryptionConfiguration.type)) throw new AwsError("ValidationException", "Customer-managed activity encryption requires KMS and is unavailable.");
    return this.store.withMutationLock(`step-functions:${this.region}`, async () => {
      const existingArn = this.state.activityNames[name];
      if (existingArn) { const existing = this.state.activities[existingArn]; return { activityArn: existing.activityArn, creationDate: timestamp(existing.creationDate) }; }
      const now = this.clock.now(); const activity: StepFunctionsActivityState = { activityArn: arn, name, generation: randomUUID(), creationDate: now, tags: suppliedTags, encryptionConfiguration: { type: "AWS_OWNED_KEY" } };
      this.state.activities[arn] = activity; this.state.activityNames[name] = arn; this.state.revision++; await this.store.save();
      return { activityArn: arn, creationDate: timestamp(now) };
    });
  }
  async DescribeActivity(input: any): Promise<any> { const activity = this.requireActivity(input.activityArn); return { activityArn: activity.activityArn, name: activity.name, creationDate: timestamp(activity.creationDate), encryptionConfiguration: activity.encryptionConfiguration }; }
  async ListActivities(input: any): Promise<any> {
    const limit = this.limit(input.maxResults, 100, 1_000); const offset = this.offset("ListActivities", input.nextToken); const values = Object.values(this.state.activities).sort((a, b) => a.name.localeCompare(b.name)); const page = values.slice(offset, offset + limit);
    return { activities: page.map(activity => ({ activityArn: activity.activityArn, name: activity.name, creationDate: timestamp(activity.creationDate) })), ...(offset + limit < values.length ? { nextToken: this.pagination.encode("ListActivities", offset + limit) } : {}) };
  }
  async DeleteActivity(input: any): Promise<any> {
    const arn = this.validateActivityArn(input.activityArn);
    return this.store.withMutationLock(`step-functions:${this.region}`, async () => { const activity = this.state.activities[arn]; if (!activity) return {}; delete this.state.activities[arn]; delete this.state.activityNames[activity.name]; for (const wake of this.activityWaiters.get(arn) ?? []) wake(); this.activityWaiters.delete(arn); this.state.revision++; await this.store.save(); return {}; });
  }
  async GetActivityTask(input: any): Promise<any> {
    const activity = this.requireActivity(input.activityArn); if (input.workerName !== undefined && typeof input.workerName !== "string") throw new AwsError("ValidationException", "workerName must be a string."); const workerName = input.workerName as string | undefined;
    if (workerName !== undefined && (!workerName || [...workerName].length > 80)) throw new AwsError("ValidationException", "workerName must contain 1-80 characters.");
    const claim = async () => this.claimActivityTask(activity.activityArn, workerName);
    const immediate = await claim(); if (immediate) return immediate;
    await new Promise<void>(resolve => {
      const waiters = this.activityWaiters.get(activity.activityArn) ?? new Set<() => void>(); this.activityWaiters.set(activity.activityArn, waiters);
      let cancel = () => {}; const done = () => { waiters.delete(done); cancel(); resolve(); }; waiters.add(done);
      cancel = this.scheduler.schedule(done, 1_000);
    });
    return this.started && this.state.activities[activity.activityArn] ? await claim() ?? { taskToken: "" } : { taskToken: "" };
  }
  async SendTaskHeartbeat(input: any): Promise<any> {
    const located = this.findCallback(input.taskToken); const task = located.task;
    if (task.status === "TIMED_OUT") throw new AwsError("TaskTimedOut", "The task token has timed out.");
    const expiration = this.callbackExpiration(task);
    if (expiration) { this.recordCallbackTimeout(located.execution, located.entryId, task, expiration); this.wakeCallbackChild(located.execution, located.entryId); await this.persistExecution(located.execution); void this.run(located.execution.executionArn); throw new AwsError("TaskTimedOut", "The task token has timed out."); }
    if (task.status !== "PENDING") throw new AwsError("TaskDoesNotExist", "The task token is no longer active.");
    if (task.heartbeatSeconds !== undefined) task.heartbeatDeadline = this.clock.now() + task.heartbeatSeconds * 1000;
    if (task.kind === "ACTIVITY") task.leaseUntil = this.clock.now() + Math.max(60_000, (task.heartbeatSeconds ?? 60) * 1000);
    await this.persistExecution(located.execution); return {};
  }
  async SendTaskSuccess(input: any): Promise<any> {
    if (typeof input.output !== "string") throw new AwsError("ValidationException", "output is required and must be a string."); const text = input.output; if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) throw new AwsError("InvalidOutput", "Task output exceeds 262144 bytes.");
    let output: unknown; try { output = JSON.parse(text); } catch { throw new AwsError("InvalidOutput", "Task output is not valid JSON."); }
    return this.completeCallback(input.taskToken, { status: "SUCCEEDED", output });
  }
  async SendTaskFailure(input: any): Promise<any> {
    if (input.error !== undefined && (typeof input.error !== "string" || [...input.error].length > 256)) throw new AwsError("ValidationException", "error must be a string of at most 256 characters.");
    if (input.cause !== undefined && (typeof input.cause !== "string" || [...input.cause].length > 32_768)) throw new AwsError("ValidationException", "cause must be a string of at most 32768 characters.");
    return this.completeCallback(input.taskToken, { status: "FAILED", error: input.error ?? "States.TaskFailed", cause: input.cause ?? "" });
  }

  async StartExecution(input: any): Promise<any> {
    const machine = this.requireMachine(input.stateMachineArn); const parsed = jsonInput(input.input); const name = input.name === undefined ? `${this.clock.now()}-${id(16)}` : executionName(input.name);
    return this.store.withMutationLock(`step-functions:${this.region}`, async () => {
      const key = `${machine.generation}:${name}`; const priorArn = this.state.executionNames[key]; const prior = priorArn ? this.state.executions[priorArn] : undefined;
      if (prior) {
        if (prior.status === "RUNNING" && prior.input === parsed.text) return { executionArn: prior.executionArn, startDate: timestamp(prior.startDate) };
        throw new AwsError("ExecutionAlreadyExists", `Execution Already Exists: '${prior.executionArn}'`);
      }
      if (Object.values(this.state.executions).filter(item => item.status === "RUNNING").length >= (this.limits.maximumConcurrentExecutions ?? 1_000)) throw new AwsError("ExecutionLimitExceeded", "The local concurrent Standard execution capacity has been reached.");
      const now = this.clock.now(); const arn = this.executionArn(machine, name);
      if (this.state.executions[arn]) throw new AwsError("ExecutionAlreadyExists", `Execution Already Exists: '${arn}'`);
      const execution: StepFunctionsExecutionState = { executionArn: arn, stateMachineArn: machine.stateMachineArn, stateMachineGeneration: machine.generation, name, status: "RUNNING", startDate: now, input: parsed.text, inputDetails: { included: true }, definition: machine.definition, roleArn: machine.roleArn, revisionId: machine.revisionId, currentState: this.compile(machine.definition).StartAt, currentInput: parsed.value, retryAttempts: {}, taskJournal: {}, callbackTasks: {}, nestedExecutions: {}, lineage: Array.isArray(input.__lineage) ? [...input.__lineage] : [machine.stateMachineArn], history: [] };
      this.append(execution, "ExecutionStarted", { executionStartedEventDetails: { input: parsed.text, inputDetails: { truncated: false }, roleArn: machine.roleArn } });
      this.state.executions[arn] = execution; this.state.executionNames[key] = arn; await this.persistExecution(execution, true); this.metric("ExecutionsStarted", machine, 1);
      this.statusEvent(execution);
      void this.run(arn); return { executionArn: arn, startDate: timestamp(now) };
    });
  }

  hasStateMachine(stateMachineArn: string): boolean { return Boolean(this.state.stateMachines[stateMachineArn]); }
  async startExecutionFromProducer(input: { stateMachineArn: string; input: string; name?: string; traceHeader?: string; roleArn: string; sourceArn: string; deliveryLineage?: string[] }): Promise<any> {
    const supplied = input.deliveryLineage ?? []; const lineage = [...supplied, ...(supplied.at(-1) === input.sourceArn ? [] : [input.sourceArn])]; const executionLineage = [...lineage, input.stateMachineArn]; if (executionLineage.length > 32 || new Set(executionLineage).size !== executionLineage.length) throw new AwsError("ValidationException", "Step Functions producer lineage was rejected.");
    const decision = evaluateRoleAuthorization(this.store.ensureAccount().iam, input.roleArn, "states:StartExecution", input.stateMachineArn, roleSessionAuthorizationContext(input.roleArn, this.region, this.clock.now(), { "aws:SourceArn": input.sourceArn, "aws:SourceAccount": this.store.accountId }));
    if (decision.decision !== "allowed") throw new AwsError("AccessDeniedException", `Producer role ${input.roleArn} cannot start ${input.stateMachineArn}.`, 403);
    if (input.name) { const machine = this.requireMachine(input.stateMachineArn); const existing = this.state.executions[this.executionArn(machine, input.name)]; if (existing) { if (existing.input !== input.input || JSON.stringify(existing.lineage ?? []) !== JSON.stringify(executionLineage)) throw new AwsError("ExecutionAlreadyExists", `Producer execution correlation ${input.name} was reused with different immutable input or lineage.`); return { executionArn: existing.executionArn, startDate: timestamp(existing.startDate) }; } }
    return this.StartExecution({ stateMachineArn: input.stateMachineArn, input: input.input, __lineage: executionLineage, ...(input.name ? { name: input.name } : {}), ...(input.traceHeader ? { traceHeader: input.traceHeader } : {}) });
  }

  async DescribeExecution(input: any): Promise<any> { return this.executionOutput(this.requireExecution(input.executionArn)); }
  async DescribeStateMachineForExecution(input: any): Promise<any> {
    const execution = this.requireExecution(input.executionArn);
    return { stateMachineArn: execution.stateMachineArn, name: execution.stateMachineArn.split(":").at(-1), definition: execution.definition, roleArn: execution.roleArn, updateDate: timestamp(execution.startDate), revisionId: execution.revisionId, label: undefined };
  }
  async ListExecutions(input: any): Promise<any> {
    const machine = this.requireMachine(input.stateMachineArn); const limit = this.limit(input.maxResults, 100, 1_000); const offset = this.offset(`ListExecutions:${machine.generation}`, input.nextToken);
    const values = Object.values(this.state.executions).filter(item => item.stateMachineGeneration === machine.generation && (!input.statusFilter || item.status === input.statusFilter)).sort((a, b) => b.startDate - a.startDate || a.executionArn.localeCompare(b.executionArn));
    const page = values.slice(offset, offset + limit);
    return { executions: page.map(item => ({ executionArn: item.executionArn, stateMachineArn: item.stateMachineArn, name: item.name, status: item.status, startDate: timestamp(item.startDate), ...(item.stopDate !== undefined ? { stopDate: timestamp(item.stopDate) } : {}) })), ...(offset + limit < values.length ? { nextToken: this.pagination.encode(`ListExecutions:${machine.generation}`, offset + limit) } : {}) };
  }
  async StopExecution(input: any): Promise<any> {
    const execution = this.requireExecution(input.executionArn);
    if (execution.status === "RUNNING") await this.terminal(execution, "ABORTED", undefined, String(input.error ?? "States.TaskFailed"), String(input.cause ?? "Execution was aborted"));
    return { stopDate: timestamp(execution.stopDate ?? this.clock.now()) };
  }
  async GetExecutionHistory(input: any): Promise<any> {
    const execution = this.requireExecution(input.executionArn); const ordered = input.reverseOrder ? [...execution.history].reverse() : execution.history;
    const limit = this.limit(input.maxResults, 100, 1_000); const operation = `GetExecutionHistory:${execution.executionArn}:${Boolean(input.reverseOrder)}`; const offset = this.offset(operation, input.nextToken);
    const events = ordered.slice(offset, offset + limit).map(event => this.historyOutput(event, input.includeExecutionData !== false));
    return { events, ...(offset + limit < ordered.length ? { nextToken: this.pagination.encode(operation, offset + limit) } : {}) };
  }

  private requireMachine(value: unknown): StepFunctionsStateMachineState {
    const arn = String(value ?? ""); const machine = this.state.stateMachines[arn]; if (!machine) throw new AwsError("StateMachineDoesNotExist", `State Machine Does Not Exist: '${arn}'`);
    return machine;
  }
  private requireActivity(value: unknown): StepFunctionsActivityState {
    const arn = this.validateActivityArn(value); const activity = this.state.activities[arn]; if (!activity) throw new AwsError("ActivityDoesNotExist", `Activity Does Not Exist: '${arn}'`); return activity;
  }
  private validateActivityArn(value: unknown): string {
    const arn = String(value ?? ""); const match = arn.match(ACTIVITY_ARN);
    if (!match || match[1] !== this.region || match[2] !== this.store.accountId) throw new AwsError("InvalidArn", "activityArn must identify an Activity in this account and Region.");
    activityName(match[3]); return arn;
  }
  private requireTagged(value: unknown): StepFunctionsStateMachineState | StepFunctionsActivityState {
    const arn = String(value ?? ""); const resource = this.state.stateMachines[arn] ?? this.state.activities[arn]; if (!resource) throw new AwsError("ResourceNotFound", `Resource Does Not Exist: '${arn}'`); return resource;
  }
  private requireExecution(value: unknown): StepFunctionsExecutionState {
    const arn = String(value ?? ""); const execution = this.state.executions[arn]; if (!execution) throw new AwsError("ExecutionDoesNotExist", `Execution Does Not Exist: '${arn}'`);
    return execution;
  }
  private tokenFor(task: Pick<StepFunctionsCallbackTaskState, "tokenId">): string {
    const signature = createHmac("sha256", this.store.state.installation.paginationSecret).update(`${this.store.accountId}\0${this.region}\0${task.tokenId}`).digest("base64url");
    return Buffer.from(`${task.tokenId}.${signature}`).toString("base64url");
  }
  private tokenReference(tokenId: string): string { return `${TOKEN_REFERENCE_PREFIX}${tokenId}__`; }
  private replaceTaskToken(value: unknown, token: string, tokenId: string): unknown { return JSON.parse(JSON.stringify(value).split(token).join(this.tokenReference(tokenId))); }
  private materializeTaskTokenReferences(value: unknown): any { return JSON.parse(JSON.stringify(value).replace(/__stacksim_task_token_ref_([0-9a-f-]{36})__/g, (_match, tokenId) => this.tokenFor({ tokenId }))); }
  private tokenDigest(token: string): string { return createHash("sha256").update(token).digest("hex"); }
  private findCallback(value: unknown): { execution: StepFunctionsExecutionState; entryId: string; task: StepFunctionsCallbackTaskState } {
    const token = String(value ?? ""); if (!token || token.length > 2_048) throw new AwsError("InvalidToken", "The task token is invalid."); const digest = this.tokenDigest(token);
    for (const execution of Object.values(this.state.executions)) for (const [entryId, task] of Object.entries(execution.callbackTasks ?? {})) if (task.tokenDigest === digest && this.tokenFor(task) === token) return { execution, entryId, task };
    throw new AwsError("InvalidToken", "The task token is invalid or belongs to another account or Region.");
  }
  private async completeCallback(token: unknown, completion: Pick<StepFunctionsCallbackTaskState, "status" | "output" | "error" | "cause">): Promise<any> {
    const located = this.findCallback(token); if (located.task.status === "TIMED_OUT") throw new AwsError("TaskTimedOut", "The task token has timed out."); const expiration = this.callbackExpiration(located.task); if (expiration) { this.recordCallbackTimeout(located.execution, located.entryId, located.task, expiration); this.wakeCallbackChild(located.execution, located.entryId); await this.persistExecution(located.execution); void this.run(located.execution.executionArn); throw new AwsError("TaskTimedOut", "The task token has timed out."); } if (located.task.status !== "PENDING") throw new AwsError("TaskDoesNotExist", "The task token has already been consumed or expired.");
    Object.assign(located.task, completion); delete located.task.leaseUntil; this.recordCallbackCompletion(located.execution, located.entryId, located.task); this.wakeCallbackChild(located.execution, located.entryId); await this.persistExecution(located.execution); void this.run(located.execution.executionArn); return {};
  }
  private callbackExpiration(task: StepFunctionsCallbackTaskState): "States.HeartbeatTimeout" | "States.Timeout" | undefined {
    if (task.status !== "PENDING") return undefined;
    const heartbeatExpired = task.heartbeatDeadline !== undefined && task.heartbeatDeadline <= this.clock.now();
    const taskExpired = task.timeoutDeadline !== undefined && task.timeoutDeadline <= this.clock.now();
    if (heartbeatExpired && (!taskExpired || task.heartbeatDeadline! <= task.timeoutDeadline!)) return "States.HeartbeatTimeout";
    return taskExpired ? "States.Timeout" : undefined;
  }
  private callbackChild(execution: StepFunctionsExecutionState, entryId: string): StepFunctionsChildState | undefined {
    const visit = (nested: NonNullable<StepFunctionsExecutionState["nested"]>): StepFunctionsChildState | undefined => { for (const child of nested.children) { if (child.activeState && this.belongsToStateVisit(child.activeState.entryId, entryId)) return child; if (child.nested) { const found = visit(child.nested); if (found) return found; } } return undefined; };
    return execution.nested ? visit(execution.nested) : undefined;
  }
  private wakeCallbackChild(execution: StepFunctionsExecutionState, entryId: string): void { const child = this.callbackChild(execution, entryId); if (child?.status === "WAITING") child.waitingUntil = this.clock.now(); }
  private recordCallbackCompletion(execution: StepFunctionsExecutionState, entryId: string, task: StepFunctionsCallbackTaskState): void {
    if (task.completionEventRecorded) return; const child = this.callbackChild(execution, entryId);
    if (task.kind === "ACTIVITY") this.appendScoped(execution, child, task.status === "SUCCEEDED" ? "ActivitySucceeded" : "ActivityFailed", task.status === "SUCCEEDED" ? { activitySucceededEventDetails: { output: JSON.stringify(task.output), outputDetails: { truncated: false } } } : { activityFailedEventDetails: { error: task.error, cause: task.cause } });
    else this.appendScoped(execution, child, task.status === "SUCCEEDED" ? "TaskSucceeded" : "TaskFailed", task.status === "SUCCEEDED" ? { taskSucceededEventDetails: { output: JSON.stringify(task.output), outputDetails: { truncated: false } } } : { taskFailedEventDetails: { error: task.error, cause: task.cause } });
    task.completionEventRecorded = true;
  }
  private recordCallbackTimeout(execution: StepFunctionsExecutionState, entryId: string, task: StepFunctionsCallbackTaskState, expiration: "States.HeartbeatTimeout" | "States.Timeout"): void {
    task.status = "TIMED_OUT"; task.error = expiration; task.cause = expiration === "States.HeartbeatTimeout" ? "The callback task missed its heartbeat deadline." : "The callback task timed out."; if (task.completionEventRecorded) return; const child = this.callbackChild(execution, entryId);
    this.appendScoped(execution, child, task.kind === "ACTIVITY" ? "ActivityTimedOut" : "TaskTimedOut", task.kind === "ACTIVITY" ? { activityTimedOutEventDetails: { error: task.error, cause: task.cause } } : { taskTimedOutEventDetails: { error: task.error, cause: task.cause } }); task.completionEventRecorded = true;
  }
  private async claimActivityTask(activityArn: string, workerName: unknown): Promise<any | undefined> {
    return this.store.withMutationLock(`step-functions-activity:${activityArn}`, async () => {
      const now = this.clock.now(); const candidates: Array<{ execution: StepFunctionsExecutionState; entryId: string; task: StepFunctionsCallbackTaskState }> = [];
      for (const execution of Object.values(this.state.executions)) for (const [entryId, task] of Object.entries(execution.callbackTasks ?? {})) if (task.kind === "ACTIVITY" && task.activityArn === activityArn && task.status === "PENDING" && (!task.leaseUntil || task.leaseUntil <= now)) candidates.push({ execution, entryId, task });
      candidates.sort((a, b) => a.task.createdAt - b.task.createdAt || a.task.taskAttemptId.localeCompare(b.task.taskAttemptId)); const selected = candidates[0]; if (!selected) return undefined;
      selected.task.workerName = workerName === undefined ? undefined : String(workerName); selected.task.leaseUntil = now + Math.max(60_000, (selected.task.heartbeatSeconds ?? 60) * 1000); if (!selected.task.startedEventRecorded) { this.appendScoped(selected.execution, this.callbackChild(selected.execution, selected.entryId), "ActivityStarted", { activityStartedEventDetails: { workerName: selected.task.workerName } }); selected.task.startedEventRecorded = true; } await this.persistExecution(selected.execution);
      return { taskToken: this.tokenFor(selected.task), input: JSON.stringify(selected.task.input ?? {}) };
    });
  }
  private machineOutput(machine: StepFunctionsStateMachineState, definition: boolean): any {
    return { stateMachineArn: machine.stateMachineArn, name: machine.name, status: machine.status, definition: definition ? machine.definition : undefined, roleArn: machine.roleArn, type: machine.type, creationDate: timestamp(machine.creationDate), loggingConfiguration: machine.loggingConfiguration, tracingConfiguration: machine.tracingConfiguration, encryptionConfiguration: machine.encryptionConfiguration, revisionId: machine.revisionId };
  }
  private executionOutput(execution: StepFunctionsExecutionState): any {
    return { executionArn: execution.executionArn, stateMachineArn: execution.stateMachineArn, name: execution.name, status: execution.status, startDate: timestamp(execution.startDate), ...(execution.stopDate !== undefined ? { stopDate: timestamp(execution.stopDate) } : {}), input: execution.input, inputDetails: execution.inputDetails, ...(execution.output !== undefined ? { output: execution.output, outputDetails: execution.outputDetails } : {}), ...(execution.error ? { error: execution.error } : {}), ...(execution.cause ? { cause: execution.cause } : {}), redriveCount: 0 };
  }
  private limit(value: unknown, fallback: number, maximum: number): number { if (value === undefined || value === 0) return fallback; const number = Number(value); if (!Number.isInteger(number) || number < 1 || number > maximum) throw new AwsError("InvalidToken", "maxResults is invalid."); return number; }
  private offset(operation: string, token: unknown): number { if (token === undefined) return 0; try { return this.pagination.decode<number>(operation, String(token)); } catch { throw new AwsError("InvalidToken", "The pagination token is invalid."); } }

  private append(execution: StepFunctionsExecutionState, type: string, details: Record<string, unknown> = {}): void {
    if (execution.history.length >= MAX_HISTORY) throw new WorkflowError("States.DataLimitExceeded", "Execution history exceeded 25,000 events.");
    const prior = execution.history.at(-1)?.id ?? 0;
    execution.history.push({ timestamp: this.clock.now(), type, id: prior + 1, previousEventId: prior, ...details });
  }
  private historyOutput(event: StepFunctionsHistoryEventState, includeData: boolean): any {
    const result: any = { ...structuredClone(event), timestamp: timestamp(event.timestamp) };
    if (!includeData) for (const candidate of Object.values(result)) if (candidate && typeof candidate === "object") { const details = candidate as any; delete details.input; delete details.output; delete details.parameters; delete details.cause; if ("inputDetails" in details) details.inputDetails = { truncated: false }; if ("outputDetails" in details) details.outputDetails = { truncated: false }; }
    return result;
  }
  private context(execution: StepFunctionsExecutionState, stateName: string, retryCount = 0, map?: AslContext["Map"]): AslContext {
    return { Execution: { Id: execution.executionArn, Input: JSON.parse(execution.input), Name: execution.name, RoleArn: execution.roleArn, StartTime: new Date(execution.startDate).toISOString() }, State: { EnteredTime: new Date(this.clock.now()).toISOString(), Name: stateName, RetryCount: retryCount }, StateMachine: { Id: execution.stateMachineArn, Name: execution.stateMachineArn.split(":").at(-1)! }, ...(map ? { Map: map } : {}) };
  }
  private taskAttemptEntryId(entryId: string, retryCount: number): string { return retryCount === 0 ? entryId : `${entryId}:retry:${retryCount}`; }
  private belongsToStateVisit(entryId: string, attemptEntryId: string): boolean { return attemptEntryId === entryId || attemptEntryId.startsWith(`${entryId}:retry:`); }
  private schedule(arn: string, deadline: number): void {
    this.timers.get(arn)?.(); this.timers.set(arn, this.scheduler.schedule(() => { this.timers.delete(arn); return this.run(arn); }, Math.max(0, deadline - this.clock.now())));
  }

  private async run(arn: string): Promise<void> {
    if (!this.started || this.running.has(arn)) return; this.running.add(arn);
    try {
      await this.store.withMutationLock(`step-functions-execution:${arn}`, async () => {
        const execution = this.state.executions[arn]; if (!execution || execution.status !== "RUNNING") return;
        const definition = this.compile(execution.definition);
        if (definition.TimeoutSeconds && this.clock.now() >= execution.startDate + definition.TimeoutSeconds * 1000) { await this.terminal(execution, "TIMED_OUT", undefined, "States.Timeout", "Execution timed out"); return; }
        while (this.started && execution.status === "RUNNING") {
          if (execution.waitingUntil !== undefined) {
            if (execution.waitingUntil > this.clock.now()) { this.schedule(arn, execution.waitingUntil); return; }
            const kind = execution.waitingKind; delete execution.waitingUntil; delete execution.waitingKind;
            if (kind === "WAIT") {
              const state = definition.States[execution.currentState!]; this.appendExited(execution, execution.currentState!, state.Type, execution.currentInput);
              delete execution.activeState;
              if (state.End) { await this.terminal(execution, "SUCCEEDED", execution.currentInput); return; }
              execution.currentState = state.Next; await this.persistExecution(execution); continue;
            }
          }
          const stateName = execution.currentState!; const state = definition.States[stateName]; const retryCount = execution.retryAttempts[stateName] ?? 0;
          if (!execution.activeState || execution.activeState.name !== stateName) {
            const rawInput = structuredClone(execution.currentInput); execution.activeState = { entryId: randomUUID(), name: stateName, input: rawInput };
            this.appendEntered(execution, stateName, state.Type, rawInput); await this.persistExecution(execution);
          }
          const rawInput = structuredClone(execution.activeState.input); const context = this.context(execution, stateName, retryCount);
          const attemptHistoryLength = execution.history.length;
          try {
            const transition = await this.executeState(execution, stateName, state, rawInput, context, this.taskAttemptEntryId(execution.activeState.entryId, retryCount));
            if (execution.status !== "RUNNING") return;
            if (transition.suspendUntil !== undefined) { await this.persistExecution(execution); this.schedule(arn, Math.min(transition.suspendUntil, definition.TimeoutSeconds ? execution.startDate + definition.TimeoutSeconds * 1000 : transition.suspendUntil)); return; }
            if (transition.waitUntil !== undefined) { execution.currentInput = transition.output; execution.waitingUntil = transition.waitUntil; execution.waitingKind = "WAIT"; await this.persistExecution(execution); this.schedule(arn, Math.min(transition.waitUntil, definition.TimeoutSeconds ? execution.startDate + definition.TimeoutSeconds * 1000 : transition.waitUntil)); return; }
            delete execution.retryAttempts[stateName]; this.appendExited(execution, stateName, state.Type, transition.output); delete execution.activeState;
            if (transition.terminal === "SUCCEEDED") { await this.terminal(execution, "SUCCEEDED", transition.output); return; }
            if (transition.terminal === "FAILED") { await this.terminal(execution, "FAILED", undefined, transition.error, transition.cause); return; }
            execution.currentState = transition.next!; execution.currentInput = transition.output; await this.persistExecution(execution);
          } catch (caught) {
            if (!this.started && execution.status === "RUNNING") return;
            const failure = caught instanceof WorkflowError ? caught : new WorkflowError(errorName(caught), safeCause(caught));
            const retry = (state.Retry ?? []).find((item: any) => matchesError(item.ErrorEquals, failure.error));
            const attempts = execution.retryAttempts[stateName] ?? 0; const maximum = Number(retry?.MaxAttempts ?? 3);
            if (retry && failure.retryable && attempts < maximum) {
              const nextAttempt = attempts + 1; execution.retryAttempts[stateName] = nextAttempt;
              const base = Number(retry.IntervalSeconds ?? 1) * Math.pow(Number(retry.BackoffRate ?? 2), attempts);
              const capped = Math.min(base, Number(retry.MaxDelaySeconds ?? base)); const delay = retry.JitterStrategy === "FULL" ? this.random() * capped : capped;
              execution.waitingUntil = this.clock.now() + delay * 1000; execution.waitingKind = "RETRY";
              if (state.Type === "Task" && !execution.history.slice(attemptHistoryLength).some(event => /(?:Failed|TimedOut)$/.test(event.type))) this.append(execution, "TaskFailed", { taskFailedEventDetails: { error: failure.error, cause: failure.cause } });
              await this.persistExecution(execution); this.schedule(arn, Math.min(execution.waitingUntil, definition.TimeoutSeconds ? execution.startDate + definition.TimeoutSeconds * 1000 : execution.waitingUntil)); return;
            }
            const catcher = (state.Catch ?? []).find((item: any) => matchesError(item.ErrorEquals, failure.error));
            if (catcher) {
              const caughtOutput = stateOutput({ ResultPath: catcher.ResultPath, OutputPath: state.OutputPath }, rawInput, { Error: failure.error, Cause: failure.cause }, context);
              this.appendExited(execution, stateName, state.Type, caughtOutput); execution.currentState = catcher.Next; execution.currentInput = caughtOutput; delete execution.retryAttempts[stateName]; delete execution.activeState; await this.persistExecution(execution); continue;
            }
            const executionTimedOut = Boolean(definition.TimeoutSeconds && this.clock.now() >= execution.startDate + definition.TimeoutSeconds * 1000);
            await this.terminal(execution, executionTimedOut ? "TIMED_OUT" : "FAILED", undefined, failure.error, failure.cause); return;
          }
        }
      });
    } finally { this.running.delete(arn); }
  }

  private async executeState(execution: StepFunctionsExecutionState, name: string, state: any, rawInput: unknown, context: AslContext, entryId: string, child?: StepFunctionsChildState): Promise<StateTransition> {
    let callback: StepFunctionsCallbackTaskState | undefined; let taskContext = context;
    if (state.Type === "Task" && (String(state.Resource).endsWith(CALLBACK_SUFFIX) || ACTIVITY_ARN.test(String(state.Resource)))) {
      callback = this.ensureCallbackTask(execution, entryId, name, state.Resource); taskContext = { ...context, Task: { Token: this.tokenFor(callback) } };
    }
    const effective = stateInput(state, rawInput, taskContext);
    if (callback) {
      this.configureCallback(callback, state, effective, taskContext);
      if (callback.kind === "ACTIVITY" && !callback.scheduledEventRecorded) { const input = JSON.stringify(effective); const recordedInput = taskContext.Task?.Token ? input.split(taskContext.Task.Token).join("<redacted task token>") : input; this.appendScoped(execution, child, "ActivityScheduled", { activityScheduledEventDetails: { resource: state.Resource, input: recordedInput, inputDetails: { truncated: false }, ...(callback.heartbeatSeconds !== undefined ? { heartbeatInSeconds: callback.heartbeatSeconds } : {}), ...(callback.timeoutDeadline !== undefined ? { timeoutInSeconds: Math.max(0, (callback.timeoutDeadline - callback.createdAt) / 1000) } : {}) } }); callback.scheduledEventRecorded = true; }
    }
    switch (state.Type) {
      case "Pass": { const result = state.Result !== undefined ? structuredClone(state.Result) : effective; const output = stateOutput(state, rawInput, result, context); this.checkPayload(output); return { output, next: state.Next, ...(state.End ? { terminal: "SUCCEEDED" as const } : {}) }; }
      case "Choice": { const selected = state.Choices.find((rule: any) => matchesChoice(rule, effective, context)); const next = selected?.Next ?? state.Default; if (!next) throw new WorkflowError("States.NoChoiceMatched", `No choice rule matched in state '${name}'`); const output = state.OutputPath === undefined ? effective : getPath(effective, state.OutputPath, context); return { output, next }; }
      case "Wait": { let deadline: number; if (state.Seconds !== undefined) deadline = this.clock.now() + state.Seconds * 1000; else if (state.SecondsPath !== undefined) deadline = this.clock.now() + Number(getPath(effective, state.SecondsPath, context)) * 1000; else if (state.Timestamp !== undefined) deadline = Date.parse(state.Timestamp); else deadline = Date.parse(String(getPath(effective, state.TimestampPath, context))); if (!Number.isFinite(deadline)) throw new WorkflowError("States.Runtime", "Wait value is invalid"); const output = state.OutputPath === undefined ? effective : getPath(effective, state.OutputPath, context); return deadline <= this.clock.now() ? { output, next: state.Next, ...(state.End ? { terminal: "SUCCEEDED" as const } : {}) } : { output, waitUntil: deadline }; }
      case "Succeed": { const output = state.OutputPath === undefined ? effective : getPath(effective, state.OutputPath, context); return { output, terminal: "SUCCEEDED" }; }
      case "Fail": { const error = state.ErrorPath ? String(getPath(effective, state.ErrorPath, context)) : state.Error === undefined ? undefined : String(state.Error); const cause = state.CausePath ? String(getPath(effective, state.CausePath, context)) : state.Cause === undefined ? undefined : String(state.Cause); return { terminal: "FAILED", error, cause }; }
      case "Task": {
        let result: unknown;
        if (ACTIVITY_ARN.test(state.Resource)) { this.requireActivity(state.Resource); result = undefined; }
        else result = await this.invokeTask(execution, state, effective, taskContext, entryId, child);
        if (result === SUSPENDED) return { suspendUntil: this.clock.now() + 10 };
        if (callback) {
          if (callback.status === "PENDING") {
            const deadline = Math.min(callback.heartbeatDeadline ?? Number.MAX_SAFE_INTEGER, callback.timeoutDeadline ?? Number.MAX_SAFE_INTEGER);
            if (deadline <= this.clock.now()) { const expiration = this.callbackExpiration(callback) ?? "States.Timeout"; this.recordCallbackTimeout(execution, entryId, callback, expiration); await this.persistExecution(execution); }
            else { await this.persistExecution(execution); return { suspendUntil: deadline === Number.MAX_SAFE_INTEGER ? this.clock.now() + 60_000 : deadline }; }
          }
          if (callback.status === "FAILED" || callback.status === "TIMED_OUT") throw new WorkflowError(callback.error ?? "States.TaskFailed", callback.cause ?? "The callback task failed.");
          result = structuredClone(callback.output);
        }
        const output = stateOutput(state, rawInput, result, taskContext); this.checkPayload(output); return { output, next: state.Next, ...(state.End ? { terminal: "SUCCEEDED" as const } : {}) };
      }
      case "Parallel": return this.runDurableNested(execution, name, state, rawInput, effective, context, "PARALLEL", child);
      case "Map": return this.runDurableNested(execution, name, state, rawInput, effective, context, "MAP", child);
      default: throw new WorkflowError("States.Runtime", `Unsupported state type '${state.Type}'`);
    }
  }

  private async runDurableNested(execution: StepFunctionsExecutionState, name: string, state: any, rawInput: unknown, effective: unknown, context: AslContext, kind: "PARALLEL" | "MAP", ownerChild?: StepFunctionsChildState): Promise<StateTransition> {
    const owner = ownerChild ?? execution;
    if (!owner.nested || owner.nested.parentState !== name || owner.nested.kind !== kind) {
      let children: StepFunctionsChildState[]; let maximumConcurrency: number;
      if (kind === "PARALLEL") {
        children = state.Branches.map((definition: CompiledDefinition, slot: number) => ({ childId: `${ownerChild?.childId ?? execution.executionArn}:${ownerChild?.activeState?.entryId ?? execution.activeState?.entryId}:${slot}`, kind, slot, definition: JSON.stringify(definition), status: "RUNNING" as const, currentState: definition.StartAt, currentInput: structuredClone(effective), retryAttempts: {}, history: [] }));
        maximumConcurrency = children.length;
      } else {
        const items = getPath(effective, state.ItemsPath ?? "$", context); if (!Array.isArray(items)) throw new WorkflowError("States.Runtime", "Map ItemsPath must select an array"); if (items.length > MAX_INLINE_MAP_ITEMS) throw new WorkflowError("States.DataLimitExceeded", `Inline Map exceeds the local ${MAX_INLINE_MAP_ITEMS}-item limit`);
        const processor = { ...(state.ItemProcessor ?? state.Iterator) }; delete processor.ProcessorConfig;
        const definition = JSON.stringify(processor); maximumConcurrency = Math.max(1, Math.min(items.length || 1, Number(state.MaxConcurrency || 40), this.limits.maximumMapConcurrency ?? 40));
        children = items.map((item, slot) => {
          const mapContext = this.context(execution, name, 0, { Item: { Index: slot, Value: item } }); const selected = state.ItemSelector === undefined ? item : payloadTemplate(state.ItemSelector, effective, mapContext);
          return { childId: `${ownerChild?.childId ?? execution.executionArn}:${ownerChild?.activeState?.entryId ?? execution.activeState?.entryId}:${slot}`, kind, slot, mapItemValue: structuredClone(item), status: "PLANNED" as const, currentState: processor.StartAt, currentInput: structuredClone(selected), retryAttempts: {}, history: [] };
        });
        owner.nested = { parentState: name, kind, maximumConcurrency, sharedDefinition: definition, children }; await this.persistExecution(execution);
        return this.runDurableNested(execution, name, state, rawInput, effective, context, kind, ownerChild);
      }
      owner.nested = { parentState: name, kind, maximumConcurrency, children };
      await this.persistExecution(execution);
    }
    const nested = owner.nested;
    await this.advanceNested(execution, nested);
    if (execution.status !== "RUNNING") return {};
    const failure = nested.children.filter(item => item.status === "FAILED").sort((left, right) => left.slot - right.slot)[0];
    if (failure) {
      for (const item of nested.children) if (["PLANNED", "RUNNING", "WAITING"].includes(item.status)) item.status = "CANCELLED";
      this.commitNestedHistory(execution, nested, ownerChild); delete owner.nested; await this.persistExecution(execution);
      throw new WorkflowError(failure.error ?? "States.TaskFailed", failure.cause ?? "A nested state failed");
    }
    if (nested.children.every(item => item.status === "SUCCEEDED")) {
      this.commitNestedHistory(execution, nested, ownerChild); const results = nested.children.sort((left, right) => left.slot - right.slot).map(item => item.output); delete owner.nested; await this.persistExecution(execution);
      const output = stateOutput(state, rawInput, results, context); this.checkPayload(output); return { output, next: state.Next, ...(state.End ? { terminal: "SUCCEEDED" as const } : {}) };
    }
    const wake = nested.children.filter(item => item.status === "WAITING" && item.waitingUntil !== undefined).map(item => item.waitingUntil!).sort((left, right) => left - right)[0];
    if (wake === undefined) throw new WorkflowError("States.Runtime", "Nested execution made no progress");
    return { suspendUntil: wake };
  }

  private async advanceNested(execution: StepFunctionsExecutionState, nested: NonNullable<StepFunctionsExecutionState["nested"]>): Promise<void> {
    while (execution.status === "RUNNING") {
      const active = nested.children.filter(item => ["RUNNING", "WAITING"].includes(item.status)).length; let capacity = Math.max(0, nested.maximumConcurrency - active); let admitted = false;
      for (const child of nested.children) if (capacity && child.status === "PLANNED") { child.status = "RUNNING"; capacity--; admitted = true; }
      if (admitted) await this.persistExecution(execution);
      const ready = nested.children.filter(item => item.status === "RUNNING" || item.status === "WAITING" && (item.waitingUntil ?? Number.MAX_SAFE_INTEGER) <= this.clock.now());
      if (!ready.length) return;
      await Promise.all(ready.map(child => this.runChild(execution, nested, child)));
      if (nested.children.some(item => item.status === "FAILED")) return;
    }
  }

  private async runChild(execution: StepFunctionsExecutionState, nested: NonNullable<StepFunctionsExecutionState["nested"]>, child: StepFunctionsChildState): Promise<void> {
    const definition = JSON.parse(child.definition ?? nested.sharedDefinition!) as CompiledDefinition;
    if (child.status === "WAITING") {
      if ((child.waitingUntil ?? Number.MAX_SAFE_INTEGER) > this.clock.now()) return;
      const kind = child.waitingKind; delete child.waitingUntil; delete child.waitingKind; child.status = "RUNNING";
      if (kind === "WAIT") {
        const state = definition.States[child.currentState]; this.appendChild(child, `${state.Type}StateExited`, { stateExitedEventDetails: { name: child.currentState, output: JSON.stringify(child.currentInput), outputDetails: { truncated: false } } }); delete child.activeState;
        if (state.End) { child.status = "SUCCEEDED"; child.output = structuredClone(child.currentInput); await this.persistExecution(execution); return; }
        child.currentState = state.Next; await this.persistExecution(execution);
      }
    }
    while (execution.status === "RUNNING" && child.status === "RUNNING") {
      const stateName = child.currentState; const state = definition.States[stateName]; const retryCount = child.retryAttempts[stateName] ?? 0;
      if (!child.activeState || child.activeState.name !== stateName) {
        child.activeState = { entryId: randomUUID(), name: stateName, input: structuredClone(child.currentInput) };
        this.appendChild(child, state.Type === "Task" ? "TaskStateEntered" : `${state.Type}StateEntered`, { stateEnteredEventDetails: { name: stateName, input: JSON.stringify(child.currentInput), inputDetails: { truncated: false } } }); await this.persistExecution(execution);
      }
      const rawInput = structuredClone(child.activeState.input); const context = this.context(execution, stateName, retryCount, child.kind === "MAP" ? { Item: { Index: child.slot, Value: structuredClone(child.mapItemValue) } } : undefined);
      const attemptHistoryLength = child.history.length;
      try {
        const transition = await this.executeState(execution, stateName, state, rawInput, context, this.taskAttemptEntryId(child.activeState.entryId, retryCount), child);
        if (execution.status !== "RUNNING") return;
        if (transition.suspendUntil !== undefined) { child.status = "WAITING"; child.waitingUntil = transition.suspendUntil; child.waitingKind = "NESTED"; await this.persistExecution(execution); return; }
        if (transition.waitUntil !== undefined) { child.currentInput = transition.output; child.status = "WAITING"; child.waitingUntil = transition.waitUntil; child.waitingKind = "WAIT"; await this.persistExecution(execution); return; }
        delete child.retryAttempts[stateName]; this.appendChild(child, state.Type === "Task" ? "TaskStateExited" : `${state.Type}StateExited`, { stateExitedEventDetails: { name: stateName, output: JSON.stringify(transition.output), outputDetails: { truncated: false } } }); delete child.activeState;
        if (transition.terminal === "SUCCEEDED") { child.status = "SUCCEEDED"; child.output = structuredClone(transition.output); await this.persistExecution(execution); return; }
        if (transition.terminal === "FAILED") throw new WorkflowError(transition.error!, transition.cause!);
        child.currentState = transition.next!; child.currentInput = structuredClone(transition.output); await this.persistExecution(execution);
      } catch (caught) {
        if (!this.started && execution.status === "RUNNING") return;
        const failure = caught instanceof WorkflowError ? caught : new WorkflowError(errorName(caught), safeCause(caught)); const retry = (state.Retry ?? []).find((item: any) => matchesError(item.ErrorEquals, failure.error)); const count = child.retryAttempts[stateName] ?? 0;
        if (retry && failure.retryable && count < Number(retry.MaxAttempts ?? 3)) {
          child.retryAttempts[stateName] = count + 1; const base = Number(retry.IntervalSeconds ?? 1) * Math.pow(Number(retry.BackoffRate ?? 2), count); const capped = Math.min(base, Number(retry.MaxDelaySeconds ?? base)); const delay = retry.JitterStrategy === "FULL" ? this.random() * capped : capped;
          if (state.Type === "Task" && !child.history.slice(attemptHistoryLength).some(event => /(?:Failed|TimedOut)$/.test(event.type))) this.appendChild(child, "TaskFailed", { taskFailedEventDetails: { error: failure.error, cause: failure.cause } });
          child.status = "WAITING"; child.waitingUntil = this.clock.now() + delay * 1000; child.waitingKind = "RETRY"; await this.persistExecution(execution); return;
        }
        const catcher = (state.Catch ?? []).find((item: any) => matchesError(item.ErrorEquals, failure.error));
        if (catcher) { const output = stateOutput({ ResultPath: catcher.ResultPath, OutputPath: state.OutputPath }, rawInput, { Error: failure.error, Cause: failure.cause }, context); this.appendChild(child, state.Type === "Task" ? "TaskStateExited" : `${state.Type}StateExited`, { stateExitedEventDetails: { name: stateName, output: JSON.stringify(output), outputDetails: { truncated: false } } }); child.currentState = catcher.Next; child.currentInput = output; delete child.retryAttempts[stateName]; delete child.activeState; await this.persistExecution(execution); continue; }
        child.status = "FAILED"; child.error = failure.error; child.cause = failure.cause; await this.persistExecution(execution); return;
      }
    }
  }

  private appendChild(child: StepFunctionsChildState, type: string, details: Record<string, unknown> = {}): void {
    if (child.history.length >= MAX_HISTORY) throw new WorkflowError("States.DataLimitExceeded", "Nested execution history exceeded 25,000 events.");
    const prior = child.history.at(-1)?.id ?? 0; child.history.push({ timestamp: this.clock.now(), type, id: prior + 1, previousEventId: prior, ...details });
  }

  private commitNestedHistory(execution: StepFunctionsExecutionState, nested: NonNullable<StepFunctionsExecutionState["nested"]>, ownerChild?: StepFunctionsChildState): void {
    if (nested.historyCommitted) return; const prefix = nested.kind === "PARALLEL" ? "ParallelState" : "MapState"; this.appendScoped(execution, ownerChild, `${prefix}Started`);
    for (const child of [...nested.children].sort((left, right) => left.slot - right.slot)) {
      if (nested.kind === "MAP") this.appendScoped(execution, ownerChild, "MapIterationStarted", { mapIterationStartedEventDetails: { name: nested.parentState, index: child.slot } });
      for (const event of child.history) { const { id: _id, previousEventId: _previous, timestamp: eventTime, ...details } = event; this.appendScoped(execution, ownerChild, event.type, details, eventTime); }
      if (nested.kind === "MAP") { const suffix = child.status === "SUCCEEDED" ? "Succeeded" : child.status === "CANCELLED" ? "Aborted" : "Failed"; const key = `mapIteration${suffix}EventDetails`; this.appendScoped(execution, ownerChild, `MapIteration${suffix}`, { [key]: { name: nested.parentState, index: child.slot } }); }
    }
    this.appendScoped(execution, ownerChild, `${prefix}${nested.children.every(item => item.status === "SUCCEEDED") ? "Succeeded" : "Failed"}`); nested.historyCommitted = true;
  }

  private appendScoped(execution: StepFunctionsExecutionState, child: StepFunctionsChildState | undefined, type: string, details: Record<string, unknown> = {}, eventTime = this.clock.now()): void {
    if (!child) { if (execution.history.length >= MAX_HISTORY) throw new WorkflowError("States.DataLimitExceeded", "Execution history exceeded 25,000 events."); const prior = execution.history.at(-1)?.id ?? 0; execution.history.push({ timestamp: eventTime, type, id: prior + 1, previousEventId: prior, ...details }); return; }
    if (child.history.length >= MAX_HISTORY) throw new WorkflowError("States.DataLimitExceeded", "Nested execution history exceeded 25,000 events."); const prior = child.history.at(-1)?.id ?? 0; child.history.push({ timestamp: eventTime, type, id: prior + 1, previousEventId: prior, ...details });
  }

  private ensureCallbackTask(execution: StepFunctionsExecutionState, entryId: string, stateName: string, resource: string): StepFunctionsCallbackTaskState {
    execution.callbackTasks ??= {}; const prior = execution.callbackTasks[entryId]; if (prior) return prior;
    const activity = resource.match(ACTIVITY_ARN); const tokenId = randomUUID(); const seed = { tokenId }; const task: StepFunctionsCallbackTaskState = execution.callbackTasks[entryId] = { tokenId, tokenDigest: this.tokenDigest(this.tokenFor(seed)), kind: activity ? "ACTIVITY" : "CALLBACK", status: "PENDING", stateName, taskAttemptId: randomUUID(), createdAt: this.clock.now(), ...(activity ? { activityArn: resource } : {}) };
    if (activity) for (const wake of this.activityWaiters.get(resource) ?? []) wake();
    return task;
  }

  private configureCallback(task: StepFunctionsCallbackTaskState, state: any, effective: unknown, context: AslContext): void {
    if (task.kind === "ACTIVITY") task.input ??= structuredClone(effective);
    const heartbeat = state.HeartbeatSecondsPath ? Number(getPath(effective, state.HeartbeatSecondsPath, context)) : state.HeartbeatSeconds;
    const timeout = state.TimeoutSecondsPath ? Number(getPath(effective, state.TimeoutSecondsPath, context)) : state.TimeoutSeconds;
    if (heartbeat !== undefined && task.heartbeatSeconds === undefined) { task.heartbeatSeconds = heartbeat; task.heartbeatDeadline = task.createdAt + heartbeat * 1000; }
    if (timeout !== undefined && task.timeoutDeadline === undefined) task.timeoutDeadline = task.createdAt + timeout * 1000;
  }

  private authorizeIntegration(execution: StepFunctionsExecutionState, action: string, resource: string, extra: Record<string, unknown> = {}): AuthorizationResult {
    this.validateRole(execution.roleArn); if (this.authMode !== "enforce") return { decision: "allowed", reason: "Authorization enforcement is disabled", matchedStatements: [] };
    const result = evaluateRoleAuthorization(this.store.ensureAccount().iam, execution.roleArn, action, resource, roleSessionAuthorizationContext(execution.roleArn, this.region, this.clock.now(), { "aws:SourceArn": execution.stateMachineArn, "aws:SourceAccount": this.store.accountId, ...extra }));
    if (result.decision !== "allowed") throw new AwsError("AccessDeniedException", `Execution role ${execution.roleArn} cannot perform ${action} on ${resource}.`, 403); return result;
  }

  private integrationFailure(prefix: string, error: unknown): WorkflowError {
    if (error instanceof WorkflowError) return error;
    if (error instanceof AwsError) return new WorkflowError(`${prefix}.${error.code.replace(/^.*#/, "")}`, safeCause(error));
    return new WorkflowError(`${prefix}.ServiceException`, safeCause(error));
  }

  private async invokeTask(execution: StepFunctionsExecutionState, state: any, effective: unknown, context: AslContext, entryId: string, child?: StepFunctionsChildState): Promise<unknown | typeof SUSPENDED> {
    const resource = String(state.Resource);
    if (resource === OPTIMIZED_LAMBDA || resource.startsWith(`${OPTIMIZED_LAMBDA}.`) || /^arn:aws:lambda:/.test(resource)) return this.invokeLambda(execution, { ...state, Resource: resource.replace(CALLBACK_SUFFIX, "") }, effective, context, entryId, child);
    if (resource.startsWith("arn:aws:states:::states:startExecution")) { const callback = execution.callbackTasks?.[entryId]; const parameters = context.Task?.Token && callback ? this.replaceTaskToken(effective, context.Task.Token, callback.tokenId) : effective; const seconds = state.TimeoutSecondsPath ? Number(getPath(effective, state.TimeoutSecondsPath, context)) : state.TimeoutSeconds; const retainedDeadline = execution.nestedExecutions?.[entryId]?.timeoutDeadline; const deadline = retainedDeadline ?? (seconds === undefined ? undefined : this.clock.now() + seconds * 1000); let timedOut = false; const invocation = this.invokeNestedExecution(execution, resource, parameters as any, entryId, child, deadline, () => timedOut); if (deadline === undefined) return invocation; let cancel: () => void = () => {}; try { return await Promise.race([invocation, new Promise<never>((_resolve, reject) => { cancel = this.scheduler.schedule(() => { timedOut = true; reject(new WorkflowError("States.Timeout", `Task timed out after ${seconds} seconds`, false)); }, Math.max(0, deadline - this.clock.now())); })]); } finally { cancel(); } }
    if (!this.integrations) throw new WorkflowError("States.Runtime", "The SFN-03 service integration registry is unavailable.");
    execution.taskJournal ??= {}; const prior = execution.taskJournal[entryId];
    if (prior?.status === "SUCCEEDED") return structuredClone(prior.output);
    if (prior?.status === "FAILED") throw new WorkflowError(prior.error ?? "States.TaskFailed", prior.cause ?? "The integration task failed.");
    if (prior?.status === "AMBIGUOUS" || prior?.status === "ACCEPTED" && prior.schemaVersion !== 2) { prior.status = "AMBIGUOUS"; prior.error = "States.TaskFailed"; prior.cause = "The legacy integration attempt may have crossed the durable-acceptance boundary; it was not repeated."; await this.persistExecution(execution); throw new WorkflowError(prior.error, prior.cause); }
    const parameters = this.materializeTaskTokenReferences(effective); let targetArn = prior?.targetArn ?? resource; let prefix = "States"; let service: NonNullable<StepFunctionsTaskJournalState["service"]> | undefined = prior?.service; let operation = prior?.operation ?? ""; let call: ((attempt: ServiceIntegrationAttempt) => Promise<any>) | undefined;
    const attemptFor = (journal: StepFunctionsTaskJournalState): ServiceIntegrationAttempt => ({ attemptId: journal.taskId, inputDigest: journal.inputDigest!, operation: journal.operation!, targetArn: journal.targetArn, executionArn: execution.executionArn, stateMachineArn: execution.stateMachineArn, roleArn: execution.roleArn, sourceArn: execution.stateMachineArn, lineage: [...(execution.lineage ?? []), execution.executionArn].slice(-32) });
    const finalize = async (journal: StepFunctionsTaskJournalState, result: any): Promise<any> => { if (journal.service === "EVENTBRIDGE" && Number(result?.FailedEntryCount ?? 0) > 0) { const failure = new WorkflowError("EventBridge.FailedEntry", JSON.stringify(result)); journal.status = "FAILED"; journal.completedAt = this.clock.now(); journal.error = failure.error; journal.cause = failure.cause; this.appendScoped(execution, child, "TaskFailed", { taskFailedEventDetails: { resource, error: failure.error, cause: failure.cause } }); await this.persistExecution(execution); await this.releaseIntegrationReceipt(journal).catch(() => undefined); throw failure; } journal.status = "SUCCEEDED"; journal.completedAt = this.clock.now(); if (!resource.endsWith(CALLBACK_SUFFIX)) journal.output = structuredClone(result); if (resource.endsWith(CALLBACK_SUFFIX)) this.appendScoped(execution, child, "TaskStarted", { taskStartedEventDetails: { resource } }); else this.appendScoped(execution, child, "TaskSucceeded", { taskSucceededEventDetails: { resource, output: JSON.stringify(result), outputDetails: { truncated: false } } }); await this.persistExecution(execution); await this.releaseIntegrationReceipt(journal).catch(() => undefined); return result; };
    if (prior?.status === "ACCEPTED") return finalize(prior, structuredClone(prior.output));
    if (prior?.status === "DISPATCHED" && prior.schemaVersion === 2) {
      const attempt = attemptFor(prior); let receipt: any | undefined;
      if (prior.service === "DYNAMODB") receipt = this.integrations.dynamodb.reconcileIntegrationAttempt(attempt)?.output;
      else if (prior.service === "SQS") receipt = await this.integrations.sqs.reconcileIntegrationAttempt(prior.targetArn, attempt);
      else if (prior.service === "SNS") receipt = await this.integrations.sns.reconcileIntegrationAttempt(attempt);
      else if (prior.service === "EVENTBRIDGE") receipt = this.integrations.eventbridge.reconcileIntegrationAttempt(attempt);
      if (receipt !== undefined) { prior.status = "ACCEPTED"; prior.acceptedAt = this.clock.now(); prior.output = structuredClone(receipt); await this.persistExecution(execution); return finalize(prior, receipt); }
    }
    if (resource.startsWith("arn:aws:states:::dynamodb:")) {
      operation = resource.split(":").at(-1)!; service = "DYNAMODB"; const tableName = String(parameters.TableName ?? ""); const match = tableName.match(/^arn:aws:dynamodb:([^:]+):(\d{12}):table\/(.+)$/); if (match && (match[1] !== this.region || match[2] !== this.store.accountId)) throw new WorkflowError("DynamoDB.ResourceNotFoundException", "DynamoDB integrations must target the same account and Region.");
      const name = match?.[3] ?? tableName; targetArn = `arn:aws:dynamodb:${this.region}:${this.store.accountId}:table/${name}`; const action = `dynamodb:${operation[0].toUpperCase()}${operation.slice(1)}`; prefix = "DynamoDB"; try { this.authorizeIntegration(execution, action, targetArn); } catch (error) { throw this.integrationFailure(prefix, error); }
      const method = `${operation[0].toUpperCase()}${operation.slice(1)}`; call = attempt => (this.integrations!.dynamodb as any)[method]({ ...parameters, TableName: name }, attempt);
    } else if (resource.startsWith("arn:aws:states:::sqs:sendMessage")) {
      service = "SQS"; operation = "sendMessage"; const queueUrl = String(parameters.QueueUrl ?? ""); let queue; try { queue = this.integrations.sqs.resolveQueueUrl(queueUrl); } catch { throw new WorkflowError("SQS.NonExistentQueue", "The target queue does not exist."); } if (queue.ownerAccountId !== this.store.accountId) throw new WorkflowError("SQS.AccessDenied", "SQS integrations must target a queue in the workflow account."); targetArn = queue.queueArn; prefix = "SQS";
      call = attempt => this.authMode === "enforce"
        ? this.integrations!.sqs.sendAuthorizedMessageToArn(targetArn, { ...parameters, QueueUrl: undefined } as any, { kind: "role", roleArn: execution.roleArn, sourceArn: execution.stateMachineArn, sourceAccount: this.store.accountId, deliveryLineage: [...(execution.lineage ?? []), execution.executionArn] }, attempt)
        : this.integrations!.sqs.SendMessageToArn(targetArn, { ...parameters, QueueUrl: undefined } as any, attempt);
    } else if (resource.startsWith("arn:aws:states:::sns:publish")) {
      service = "SNS"; operation = "publish"; targetArn = String(parameters.TopicArn ?? parameters.TargetArn ?? ""); if (!new RegExp(`^arn:aws:sns:${this.region}:${this.store.accountId}:`).test(targetArn)) throw new WorkflowError("SNS.NotFound", "SNS integrations require a same-account, same-Region topic ARN."); prefix = "SNS"; let identityAuthorization: AuthorizationResult; try { identityAuthorization = this.authorizeIntegration(execution, "sns:Publish", targetArn); } catch (error) { throw this.integrationFailure(prefix, error); }
      call = attempt => this.integrations!.sns.publishAuthorized({ ...parameters, TopicArn: targetArn }, { principal: execution.roleArn, sourceArn: execution.stateMachineArn, sourceAccount: this.store.accountId, identityAuthorization, lineage: [...(execution.lineage ?? []), execution.executionArn] }, attempt);
    } else if (resource === "arn:aws:states:::events:putEvents") {
      service = "EVENTBRIDGE"; operation = "putEvents"; prefix = "EventBridge"; const entries = Array.isArray(parameters.Entries) ? parameters.Entries : []; const augmented = { ...parameters, Entries: entries.map((entry: any) => ({ ...entry, Resources: [...(Array.isArray(entry.Resources) ? entry.Resources : []), execution.executionArn, execution.stateMachineArn] })) }; for (const [index, entry] of augmented.Entries.entries()) { const accepted = prior?.status === "DISPATCHED" ? this.integrations.eventbridge.reconcileIntegrationEntryAttempt(attemptFor(prior), index, entry) : undefined; if (accepted !== undefined) continue; const bus = String(entry.EventBusName ?? "default"); const arn = bus.startsWith("arn:") ? bus : `arn:aws:events:${this.region}:${this.store.accountId}:event-bus/${bus}`; try { this.authorizeIntegration(execution, "events:PutEvents", arn, { "events:source": entry.Source, "events:detail-type": entry.DetailType }); } catch (error) { throw this.integrationFailure(prefix, error); } } targetArn = `arn:aws:events:${this.region}:${this.store.accountId}:event-bus/*`;
      call = attempt => this.integrations!.eventbridge.PutEvents(augmented, undefined, { deliveryLineage: [...(execution.lineage ?? []), execution.executionArn], integrationAttempt: attempt });
    } else throw new WorkflowError("States.Runtime", `Unsupported integration resource '${resource}'.`);
    const inputText = JSON.stringify(parameters); const safeInputText = JSON.stringify(effective); const recordedInput = context.Task?.Token ? safeInputText.split(context.Task.Token).join("<redacted task token>") : safeInputText; this.checkPayload(parameters); const journal: StepFunctionsTaskJournalState = prior ?? (execution.taskJournal[entryId] = { taskId: randomUUID(), schemaVersion: 2, stateName: context.State.Name, targetArn, input: recordedInput, inputDigest: integrationInputDigest(parameters), service: service!, operation, status: "UNDISPATCHED" });
    if (!prior) { this.appendScoped(execution, child, "TaskScheduled", { taskScheduledEventDetails: { resource, parameters: recordedInput, taskAttemptId: journal.taskId } }); await this.persistExecution(execution); }
    journal.status = "DISPATCHED"; journal.dispatchedAt ??= this.clock.now(); await this.persistExecution(execution);
    try {
      const invocation = call!(attemptFor(journal)); const timeout = state.TimeoutSecondsPath ? Number(getPath(effective, state.TimeoutSecondsPath, context)) : state.TimeoutSeconds; let result: any;
      if (timeout !== undefined) {
        let cancel: () => void = () => {}; let timedOut = false;
        try { result = await Promise.race([invocation, new Promise<never>((_resolve, reject) => { cancel = this.scheduler.schedule(() => { timedOut = true; reject(new WorkflowError("States.Timeout", `Task timed out after ${timeout} seconds`, false)); }, timeout * 1000); })]); }
        catch (error) { if (timedOut) void invocation.finally(() => this.releaseIntegrationReceipt(journal).catch(() => undefined)); throw error; }
        finally { cancel(); }
      } else result = await invocation;
      journal.status = "ACCEPTED"; journal.acceptedAt = this.clock.now(); if (!resource.endsWith(CALLBACK_SUFFIX)) journal.output = structuredClone(result); await this.persistExecution(execution);
      if (execution.status !== "RUNNING") { journal.status = "SUCCEEDED"; journal.completedAt = this.clock.now(); await this.persistExecution(execution); await this.releaseIntegrationReceipt(journal).catch(() => undefined); return result; }
      return finalize(journal, result);
    }
    catch (error) { if (!this.started && execution.status === "RUNNING") throw error; const failure = this.integrationFailure(prefix, error); if ((journal as StepFunctionsTaskJournalState).status === "FAILED") throw failure; journal.status = "FAILED"; journal.completedAt = this.clock.now(); journal.error = failure.error; journal.cause = failure.cause; this.appendScoped(execution, child, "TaskFailed", { taskFailedEventDetails: { resource, error: failure.error, cause: failure.cause } }); await this.persistExecution(execution); await this.releaseIntegrationReceipt(journal).catch(() => undefined); throw failure; }
  }

  private async invokeNestedExecution(parent: StepFunctionsExecutionState, resource: string, parameters: any, entryId: string, ownerChild?: StepFunctionsChildState, timeoutDeadline?: number, timedOut: () => boolean = () => false): Promise<unknown | typeof SUSPENDED> {
    const machineArn = String(parameters.StateMachineArn ?? ""); if (!new RegExp(`^arn:aws:states:${this.region}:${this.store.accountId}:stateMachine:`).test(machineArn)) throw new WorkflowError("StepFunctions.StateMachineDoesNotExist", "Nested workflows must target the same account and Region.");
    const lineage = parent.lineage ?? [parent.stateMachineArn]; if (lineage.length >= 32 || lineage.includes(machineArn)) throw new WorkflowError("States.ExceedToleratedFailureThreshold", "Nested workflow recursion or lineage depth was rejected.");
    parent.nestedExecutions ??= {}; let link = parent.nestedExecutions[entryId]; if (link?.timeoutDeadline !== undefined && link.timeoutDeadline <= this.clock.now()) { const child = this.state.executions[link.executionArn]; if (link.pattern !== "REQUEST_RESPONSE" && child?.status === "RUNNING") await this.terminal(child, "ABORTED", undefined, "States.Timeout", "Parent nested task timed out"); throw new WorkflowError("States.Timeout", "Nested task timed out", false); }
    if (!link) { const input = parameters.Input === undefined ? "{}" : typeof parameters.Input === "string" ? parameters.Input : JSON.stringify(parameters.Input); const automaticName = !parameters.Name; const nestedName = automaticName ? `sfn-${createHash("sha256").update(`${parent.executionArn}\0${entryId}`).digest("hex").slice(0, 48)}` : String(parameters.Name); const machineName = machineArn.split(":").at(-1)!; const stableArn = `arn:aws:states:${this.region}:${this.store.accountId}:execution:${machineName}:${nestedName}`; const expectedLineage = [...lineage, machineArn]; const existing = this.state.executions[stableArn]; if (existing && (existing.input !== input || JSON.stringify(existing.lineage ?? []) !== JSON.stringify(expectedLineage))) throw new WorkflowError("StepFunctions.ExecutionAlreadyExists", `Nested execution ${stableArn} already exists with different input or lineage.`); if (!existing) { try { this.authorizeIntegration(parent, "states:StartExecution", machineArn); } catch (error) { if (error instanceof AwsError) throw new WorkflowError(`StepFunctions.${error.code}`, safeCause(error)); throw error; } this.requireMachine(machineArn); } let started: any; try { started = existing ? { executionArn: existing.executionArn, startDate: timestamp(existing.startDate) } : await this.StartExecution({ stateMachineArn: machineArn, name: nestedName, input, __lineage: expectedLineage, ...(parameters.TraceHeader ? { traceHeader: parameters.TraceHeader } : {}) }); } catch (error) { if (error instanceof WorkflowError) throw error; if (error instanceof AwsError) throw new WorkflowError(`StepFunctions.${error.code}`, safeCause(error)); throw error; } link = parent.nestedExecutions[entryId] = { executionArn: started.executionArn, pattern: resource.endsWith(".sync") ? "RUN_JOB" : resource.endsWith(CALLBACK_SUFFIX) ? "WAIT_FOR_TASK_TOKEN" : "REQUEST_RESPONSE", ...(timeoutDeadline !== undefined ? { timeoutDeadline } : {}) }; if (timedOut() || timeoutDeadline !== undefined && timeoutDeadline <= this.clock.now()) { const admitted = this.state.executions[started.executionArn]; if (link.pattern !== "REQUEST_RESPONSE" && admitted?.status === "RUNNING") await this.terminal(admitted, "ABORTED", undefined, "States.Timeout", "Parent nested task timed out during admission"); await this.persistExecution(parent); throw new WorkflowError("States.Timeout", "Nested task timed out during admission", false); } if (parent.status !== "RUNNING") { const admitted = this.state.executions[started.executionArn]; if (link.pattern !== "REQUEST_RESPONSE" && admitted?.status === "RUNNING") await this.terminal(admitted, "ABORTED", undefined, "States.TaskFailed", "Parent execution stopped during nested admission"); await this.persistExecution(parent); return { ExecutionArn: started.executionArn, StartDate: started.startDate }; } const callback = parent.callbackTasks?.[entryId]; const parameterText = JSON.stringify(parameters); const recordedParameters = callback ? parameterText.split(this.tokenFor(callback)).join("<redacted task token>") : parameterText; this.appendScoped(parent, ownerChild, "TaskScheduled", { taskScheduledEventDetails: { resource, parameters: recordedParameters } }); this.appendScoped(parent, ownerChild, "TaskStarted", { taskStartedEventDetails: { resource } }); await this.persistExecution(parent); if (link.pattern !== "RUN_JOB") { const output = { ExecutionArn: started.executionArn, StartDate: started.startDate }; if (link.pattern === "REQUEST_RESPONSE") { this.appendScoped(parent, ownerChild, "TaskSucceeded", { taskSucceededEventDetails: { resource, output: JSON.stringify(output), outputDetails: { truncated: false } } }); link.completionEventRecorded = true; await this.persistExecution(parent); } return output; } }
    if (link.pattern !== "RUN_JOB") { const child = this.requireExecution(link.executionArn); return { ExecutionArn: child.executionArn, StartDate: timestamp(child.startDate) }; }
    const child = this.requireExecution(link.executionArn); try { this.authorizeIntegration(parent, "states:DescribeExecution", child.executionArn); } catch (error) { if (error instanceof AwsError) throw new WorkflowError(`StepFunctions.${error.code}`, safeCause(error)); throw error; } if (child.status === "RUNNING") return SUSPENDED;
    if (child.status !== "SUCCEEDED") { if (!link.completionEventRecorded) { this.appendScoped(parent, ownerChild, "TaskFailed", { taskFailedEventDetails: { resource, error: "StepFunctions.ExecutionFailed", cause: child.cause ?? `Nested execution ended with ${child.status}.` } }); link.completionEventRecorded = true; await this.persistExecution(parent); } throw new WorkflowError("StepFunctions.ExecutionFailed", child.cause ?? `Nested execution ended with ${child.status}.`); }
    const output = { ExecutionArn: child.executionArn, StateMachineArn: child.stateMachineArn, Name: child.name, Status: child.status, StartDate: timestamp(child.startDate), StopDate: timestamp(child.stopDate!), Output: child.output }; if (!link.completionEventRecorded) { this.appendScoped(parent, ownerChild, "TaskSucceeded", { taskSucceededEventDetails: { resource, output: JSON.stringify(output), outputDetails: { truncated: false } } }); link.completionEventRecorded = true; await this.persistExecution(parent); } return output;
  }

  private async invokeLambda(execution: StepFunctionsExecutionState, state: any, effective: unknown, context: AslContext, entryId: string, child?: StepFunctionsChildState): Promise<unknown> {
    const optimized = state.Resource === OPTIMIZED_LAMBDA; const safeParameters = effective as any; const parameters = this.materializeTaskTokenReferences(effective);
    const functionName = optimized ? String(parameters.FunctionName) : state.Resource; const payload = optimized ? (parameters.Payload === undefined ? {} : parameters.Payload) : effective;
    const targetArn = functionName.startsWith("arn:") ? functionName : `arn:aws:lambda:${this.region}:${this.store.accountId}:function:${functionName}`;
    execution.taskJournal ??= {}; const prior = execution.taskJournal[entryId];
    if (prior?.status === "SUCCEEDED") return structuredClone(prior.output);
    if (prior?.status === "FAILED") throw new WorkflowError(prior.error ?? "States.TaskFailed", prior.cause ?? "The Lambda task failed");
    if (prior?.status === "AMBIGUOUS" || prior?.status === "ACCEPTED" && prior.schemaVersion !== 2) { prior.status = "AMBIGUOUS"; prior.error = "States.TaskFailed"; prior.cause = "The Lambda invocation may have run, but no owning-service completion receipt exists; the non-idempotent call was not repeated."; await this.persistExecution(execution); throw new WorkflowError(prior.error, prior.cause); }
    const callback = Boolean(context.Task?.Token);
    const completeOutput = async (journal: StepFunctionsTaskJournalState, output: unknown): Promise<unknown> => { journal.status = "SUCCEEDED"; journal.completedAt = this.clock.now(); if (!callback) journal.output = structuredClone(output); if (execution.status === "RUNNING") this.appendScoped(execution, child, "LambdaFunctionSucceeded", { lambdaFunctionSucceededEventDetails: { output: callback ? "{}" : JSON.stringify(output), outputDetails: { truncated: false } } }); await this.persistExecution(execution); await this.releaseIntegrationReceipt(journal).catch(() => undefined); return output; };
    if (prior?.status === "ACCEPTED") return completeOutput(prior, structuredClone(prior.output));
    const inputText = JSON.stringify(payload); const safeInputText = JSON.stringify(optimized ? (safeParameters.Payload === undefined ? {} : safeParameters.Payload) : safeParameters); const recordedInput = context.Task?.Token ? safeInputText.split(context.Task.Token).join("<redacted task token>") : safeInputText; this.checkPayload(payload);
    const journal: StepFunctionsTaskJournalState = prior ?? { taskId: randomUUID(), schemaVersion: 2, stateName: context.State.Name, targetArn, input: recordedInput, inputDigest: integrationInputDigest(payload), service: "LAMBDA", operation: "invoke", status: "UNDISPATCHED" };
    const attempt: ServiceIntegrationAttempt = { attemptId: journal.taskId, inputDigest: journal.inputDigest!, operation: journal.operation!, targetArn: journal.targetArn, executionArn: execution.executionArn, stateMachineArn: execution.stateMachineArn, roleArn: execution.roleArn, sourceArn: execution.stateMachineArn, lineage: [...(execution.lineage ?? []), execution.executionArn].slice(-32) };
    const fromReceipt = (value: any) => ({ ...value, payload: Buffer.from(String(value.payloadBase64 ?? ""), "base64") });
    const finishInvocation = async (result: any): Promise<unknown> => { let response: any; try { response = result.payload.length ? JSON.parse(result.payload.toString("utf8")) : null; } catch { response = result.payload.toString("utf8"); } if (result.functionError) { const failure = new WorkflowError(String(response?.errorType ?? response?.Error ?? "States.TaskFailed"), String(response?.errorMessage ?? response?.Cause ?? JSON.stringify(response))); journal.status = "FAILED"; journal.completedAt = this.clock.now(); journal.error = failure.error; journal.cause = failure.cause; this.appendScoped(execution, child, "LambdaFunctionFailed", { lambdaFunctionFailedEventDetails: { error: failure.error, cause: failure.cause } }); await this.persistExecution(execution); await this.releaseIntegrationReceipt(journal).catch(() => undefined); throw failure; } const output = optimized ? { ExecutedVersion: result.executedVersion, Payload: response, SdkHttpMetadata: { HttpStatusCode: result.statusCode }, SdkResponseMetadata: { RequestId: result.requestId } } : response; journal.status = "ACCEPTED"; journal.acceptedAt = this.clock.now(); if (!callback) journal.output = structuredClone(output); await this.persistExecution(execution); return completeOutput(journal, output); };
    if (prior?.status === "DISPATCHED" && prior.schemaVersion === 2) { const receipt = this.executionStore.integrationAttempt(prior.taskId); if (receipt) { assertMatchingIntegrationAttempt(receipt, attempt); return finishInvocation(fromReceipt(receipt.output)); } prior.status = "AMBIGUOUS"; prior.error = "States.TaskFailed"; prior.cause = "The Lambda invocation crossed the dispatch boundary without an owning-service completion receipt; it was not repeated."; await this.persistExecution(execution); throw new WorkflowError(prior.error, prior.cause); }
    this.validateRole(execution.roleArn);
    this.lambda.assertFunctionExists(functionName);
    if (this.authMode === "enforce") {
      const authorization = evaluateRoleAuthorization(this.store.ensureAccount().iam, execution.roleArn, "lambda:InvokeFunction", targetArn, roleSessionAuthorizationContext(execution.roleArn, this.region, this.clock.now(), { "aws:SourceArn": execution.stateMachineArn, "aws:SourceAccount": this.store.accountId }));
      if (authorization.decision !== "allowed") throw new AwsError("AccessDeniedException", `Execution role ${execution.roleArn} cannot invoke ${targetArn}.`, 403);
    }
    if (!prior) { execution.taskJournal[entryId] = journal; this.appendScoped(execution, child, "LambdaFunctionScheduled", { lambdaFunctionScheduledEventDetails: { resource: state.Resource, input: recordedInput, inputDetails: { truncated: false }, taskAttemptId: journal.taskId } }); await this.persistExecution(execution); }
    journal.status = "DISPATCHED"; journal.dispatchedAt ??= this.clock.now(); await this.persistExecution(execution);
    const accept = async (result: any) => { let payloadBase64 = result.payload.toString("base64"); if (callback && !result.functionError) payloadBase64 = Buffer.from("null").toString("base64"); else if (context.Task?.Token) payloadBase64 = Buffer.from(result.payload.toString("utf8").split(context.Task.Token).join("<redacted task token>")).toString("base64"); const output = { payloadBase64, functionError: result.functionError, statusCode: result.statusCode, requestId: result.requestId, durationMs: result.durationMs, billedDurationMs: result.billedDurationMs, executedVersion: result.executedVersion, durableExecutionArn: result.durableExecutionArn }; await this.executionStore.putIntegrationAttempt(acceptedIntegrationAttempt(attempt, output, this.clock.now())); };
    const callbackContinuation = this.cloudFormationCallbacks && payload && typeof payload === "object" && !Array.isArray(payload)
      && typeof (payload as Record<string, unknown>).ResponseURL === "string"
      && typeof (payload as Record<string, unknown>).RequestId === "string"
      && typeof (payload as Record<string, unknown>).StackId === "string";
    const invocation = callbackContinuation
      ? this.lambda.invokeCloudFormationCallbackContinuation(functionName, Buffer.from(inputText), journal.taskId, this.cloudFormationCallbacks!.caCertificatePath, this.cloudFormationCallbacks!.port(), { lineage: [execution.stateMachineArn, execution.executionArn] }).then(async result => { if (!result.interrupted) await accept(result); return result; })
      : this.lambda.invoke(functionName, Buffer.from(inputText), journal.taskId, { lineage: [execution.stateMachineArn, execution.executionArn], ...(context.Task?.Token ? { sensitiveLogValues: [context.Task.Token] } : {}), integrationAttemptAcceptance: accept });
    if (!journal.startedEventRecorded) { this.appendScoped(execution, child, "LambdaFunctionStarted"); journal.startedEventRecorded = true; await this.persistExecution(execution); }
    const stateTimeout = state.TimeoutSecondsPath ? Number(getPath(effective, state.TimeoutSecondsPath, context)) : state.TimeoutSeconds;
    const machineTimeout = (JSON.parse(execution.definition) as CompiledDefinition).TimeoutSeconds;
    const remainingExecutionSeconds = machineTimeout === undefined ? undefined : Math.max(0, (execution.startDate + machineTimeout * 1000 - this.clock.now()) / 1000);
    const candidates = [stateTimeout, remainingExecutionSeconds].filter((value): value is number => value !== undefined);
    const timeoutSeconds = candidates.length ? Math.min(...candidates) : undefined;
    let result;
    try {
      if (timeoutSeconds !== undefined) {
        let cancel: () => void = () => {}; let timedOut = false;
        try { result = await Promise.race([invocation, new Promise<never>((_resolve, reject) => { cancel = this.scheduler.schedule(() => { timedOut = true; reject(new WorkflowError("States.Timeout", `Task timed out after ${timeoutSeconds} seconds`, false)); }, timeoutSeconds * 1000); })]); }
        catch (error) { if (timedOut) await invocation.catch(() => undefined); throw error; }
        finally { cancel(); }
      } else result = await invocation;
    } catch (caught) {
      if (!this.started && execution.status === "RUNNING") throw caught;
      const failure = caught instanceof WorkflowError ? caught : new WorkflowError(errorName(caught), safeCause(caught)); journal.status = "FAILED"; journal.completedAt = this.clock.now(); journal.error = failure.error; journal.cause = failure.cause; this.appendScoped(execution, child, "LambdaFunctionFailed", { lambdaFunctionFailedEventDetails: { error: failure.error, cause: failure.cause } }); await this.persistExecution(execution); throw failure;
    }
    if (result.interrupted && !this.started) throw new WorkflowError("States.TaskFailed", "The synchronous Lambda invocation was interrupted during simulator shutdown");
    return finishInvocation(result);
  }

  private checkPayload(value: unknown): void { if (bytes(value) > MAX_PAYLOAD_BYTES) throw new WorkflowError("States.DataLimitExceeded", "State output exceeds 262144 bytes."); }
  private appendEntered(execution: StepFunctionsExecutionState, name: string, type: string, input: unknown): void { const prefix = type === "Task" ? "TaskState" : `${type}State`; this.append(execution, `${prefix}Entered`, { stateEnteredEventDetails: { name, input: JSON.stringify(input), inputDetails: { truncated: false } } }); }
  private appendExited(execution: StepFunctionsExecutionState, name: string, type: string, output: unknown): void { const prefix = type === "Task" ? "TaskState" : `${type}State`; this.append(execution, `${prefix}Exited`, { stateExitedEventDetails: { name, output: JSON.stringify(output), outputDetails: { truncated: false } } }); }
  private async terminal(execution: StepFunctionsExecutionState, status: StepFunctionsExecutionState["status"], output?: unknown, error?: string, cause?: string): Promise<void> {
    if (execution.status !== "RUNNING") return; this.timers.get(execution.executionArn)?.(); this.timers.delete(execution.executionArn);
    if (execution.history.length >= MAX_HISTORY) execution.history.splice(MAX_HISTORY - 1);
    if (status !== "SUCCEEDED" && execution.nested) this.cancelNested(execution.nested);
    if (status !== "SUCCEEDED") for (const link of Object.values(execution.nestedExecutions ?? {})) {
      const child = this.state.executions[link.executionArn];
      if (child?.status === "RUNNING") { let mayStop = true; try { this.authorizeIntegration(execution, "states:StopExecution", child.executionArn); } catch (error) { if (!(error instanceof AwsError)) throw error; mayStop = false; } if (mayStop) await this.terminal(child, "ABORTED", undefined, "States.TaskFailed", `Parent execution ${execution.executionArn} stopped.`); }
    }
    for (const task of Object.values(execution.callbackTasks ?? {})) if (task.status === "PENDING") { task.status = "FAILED"; task.error = error ?? "States.TaskFailed"; task.cause = cause ?? "Execution ended while waiting for a callback."; delete task.leaseUntil; }
    execution.status = status; execution.stopDate = this.clock.now();
    if (status === "SUCCEEDED") { this.checkPayload(output); execution.output = JSON.stringify(output); execution.outputDetails = { included: true }; this.append(execution, "ExecutionSucceeded", { executionSucceededEventDetails: { output: execution.output, outputDetails: { truncated: false } } }); }
    else { execution.error = error; execution.cause = cause; const type = status === "ABORTED" ? "ExecutionAborted" : status === "TIMED_OUT" ? "ExecutionTimedOut" : "ExecutionFailed"; const key = `${type[0].toLowerCase()}${type.slice(1)}EventDetails`; this.append(execution, type, { [key]: { error, cause } }); }
    delete execution.currentState; delete execution.currentInput; delete execution.activeState; delete execution.waitingUntil; delete execution.waitingKind; await this.persistExecution(execution);
    const machine = this.state.stateMachines[execution.stateMachineArn] ?? { name: execution.stateMachineArn.split(":").at(-1), stateMachineArn: execution.stateMachineArn } as StepFunctionsStateMachineState;
    this.metric("ExecutionTime", machine, execution.stopDate - execution.startDate, "Milliseconds");
    this.metric(status === "SUCCEEDED" ? "ExecutionsSucceeded" : status === "ABORTED" ? "ExecutionsAborted" : status === "TIMED_OUT" ? "ExecutionsTimedOut" : "ExecutionsFailed", machine, 1);
    this.statusEvent(execution);
  }
  private cancelNested(nested: NonNullable<StepFunctionsExecutionState["nested"]>): void { for (const child of nested.children) { if (child.nested) this.cancelNested(child.nested); if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(child.status)) child.status = "CANCELLED"; } }
  private metric(metricName: string, machine: StepFunctionsStateMachineState, value: number, unit = "Count"): void { void this.telemetry?.publish({ namespace: "AWS/States", metricName, dimensions: { StateMachineArn: machine.stateMachineArn }, value, unit, timestamp: this.clock.now() }); }
  private statusEvent(execution: StepFunctionsExecutionState): void {
    void this.publishEvent?.({ source: "aws.states", detailType: "Step Functions Execution Status Change", detail: { executionArn: execution.executionArn, stateMachineArn: execution.stateMachineArn, name: execution.name, status: execution.status, startDate: execution.startDate, ...(execution.stopDate ? { stopDate: execution.stopDate } : {}), ...(execution.error ? { error: execution.error } : {}) }, resources: [execution.executionArn, execution.stateMachineArn], time: this.clock.now(), deliveryLineage: [execution.stateMachineArn, execution.executionArn] }).catch(() => undefined);
  }
  private async persistExecution(execution: StepFunctionsExecutionState, controlChanged = false): Promise<void> {
    await this.executionStore.put(execution);
    if (controlChanged) await this.store.save();
  }
}
