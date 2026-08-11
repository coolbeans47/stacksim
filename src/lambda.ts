import type { ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { delimiter, dirname, resolve } from "node:path";
import { AwsError, sendAwsError } from "./errors.js";
import type { PrincipalContext } from "./auth/sigv4.js";
import type { CloudWatchLogsService } from "./cloudwatch-logs.js";
import type { Clock } from "./core/clock.js";
import { SystemClock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import type { TelemetryBus } from "./core/telemetry.js";
import type { Scheduler } from "./core/scheduler.js";
import { LambdaEventSourceMappings, type LambdaSnsServicePort } from "./lambda-event-sources.js";
import type { LambdaSqsMessageAttributeValue, LambdaSqsServicePort } from "./lambda-sqs-event-source.js";
import { LambdaConcurrencyController } from "./lambda-concurrency.js";
import { LambdaLayers } from "./lambda-layers.js";
import { LambdaImages, type ResolvedLambdaImage } from "./lambda-images.js";
import { LambdaDockerRuntime } from "./lambda-docker-runtime.js";
import { LambdaWorkerPool, type LambdaWorkerRuntime, type LambdaWorkerSpec } from "./lambda-worker-pool.js";
import { LambdaCapacityProviders } from "./lambda-capacity-providers.js";
import { LambdaDurableExecutions, durableConfig, durableConfigView } from "./lambda-durable-executions.js";
import { LambdaFunctionUrls, validateStreamingResponseMetadata, type FunctionUrlTarget, type LambdaStreamCallbacks } from "./lambda-function-urls.js";
import { evaluateAuthorization, evaluateResourcePolicy, evaluateRoleAuthorization, evaluateTrust, roleSessionAuthorizationContext, type AuthorizationResult } from "./iam/evaluator.js";
import type { StateStore } from "./state.js";
import type { LambdaAliasState, LambdaArchitecture, LambdaAsyncInvocationState, LambdaCodeSigningConfigState, LambdaDurableExecutionState, LambdaEventInvokeConfigState, LambdaExecutableConfigurationState, LambdaProvisionedConcurrencyConfigState, LambdaResourcePolicyState, LambdaState, LambdaVersionState, PolicyDocument } from "./types.js";
import { extractZip } from "./zip.js";
import { id, json, readBody, sha256 } from "./util.js";
import { eventStreamMessage, writeWithBackpressure } from "./protocols/event-stream.js";
import type { EventBridgeService } from "./eventbridge.js";
import type { S3Service } from "./s3.js";
import type { CloudFormationHotswapDriftState } from "./types.js";
import { beginHotswapDrift, completeHotswapDrift, failHotswapDrift, hotswapCheckpoint, isPinnedCdkHotswapRequest, lambdaOwnershipKey, requestPayloadDigest, uniqueCompletedOwner } from "./cloudformation/hotswap.js";
import { executeCdkBucketDeploymentHotswap } from "./cloudformation/providers/cdk-bucket-deployment.js";

type Executable = Pick<LambdaState, "runtime" | "role" | "handler" | "timeout" | "memorySize" | "description" | "environment" | "codeSha256" | "codeSize" | "codeUnzippedSize" | "codeDir" | "layers" | "lastModified"> & LambdaExecutableConfigurationState;
interface ResolvedFunction { fn: LambdaState; executable: Executable; requestedQualifier?: string; executedVersion: string; qualifiedArn: string }
export interface InvokeResult { payload: Buffer; functionError?: string; statusCode: number; logResult?: string; requestId: string; durationMs: number; billedDurationMs: number; executedVersion: string; durableExecutionArn?: string; /** Internal: the simulator stopped while this invocation was active. */ interrupted?: boolean }
interface InvokeOptions { clientContext?: unknown; qualifier?: string; principal?: string; sourceArn?: string; sourceAccount?: string; enforceResourcePolicy?: boolean; lineage?: string[]; durableExecutionName?: string; traceHeader?: string; durableReplay?: boolean; durableExecutionArn?: string; resolvedOverride?: ResolvedFunction; environmentOverrides?: Readonly<Record<string, string>>; timeoutOverrideMs?: number; terminateOnCompletion?: Promise<void>; sanitizeEnvironment?: boolean; trustedCaCertificatePath?: string; sensitiveLogValues?: readonly string[]; integrationAttemptAcceptance?: (result: InvokeResult) => Promise<void>; serviceLogContext?: { apiGatewayRequestId: string; apiGatewayExtendedRequestId: string; apiId: string; stage: string } }

function cloudFormationCallbackSensitiveLogValues(event: unknown): string[] {
  if (!event || typeof event !== "object" || Array.isArray(event)) return [];
  const value = event as Record<string, unknown>;
  if (!new Set(["Create", "Update", "Delete"]).has(String(value.RequestType)) || typeof value.StackId !== "string" || !value.StackId.startsWith("arn:aws:cloudformation:") || typeof value.RequestId !== "string" || !/^[a-f0-9]{64}$/.test(value.RequestId) || typeof value.LogicalResourceId !== "string" || typeof value.ResponseURL !== "string") return [];
  try {
    const url = new URL(value.ResponseURL);
    const token = url.pathname.startsWith("/_stacksim/cloudformation/custom-resource-response/") ? url.pathname.split("/").at(-1) : undefined;
    if (url.protocol !== "https:" || !new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname) || !url.port || !token) return [];
    return [value.ResponseURL, token];
  } catch { return []; }
}

const lambdaRuntimeRequire = createRequire(import.meta.url);
const simulatorNodeModules = resolve(dirname(lambdaRuntimeRequire.resolve("@aws-sdk/client-lambda")), "..", "..", "..");
function runtimeNodePathEntries(): string[] { return [...new Set([simulatorNodeModules, ...(process.env.NODE_PATH?.split(delimiter).filter(Boolean) ?? [])])]; }

function parseFunctionTarget(value: string): { name: string; qualifier?: string } {
  value = decodeURIComponent(value);
  const raw = value.startsWith("arn:") ? value.split(":function:")[1] ?? value : value;
  const parts = raw.split(":"); return { name: parts[0], qualifier: parts[1] };
}
function sanitizedRuntimeHostEnvironment(): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  // Node is launched by absolute path.  Retain only conventional process/OS
  // compatibility values; host credentials, proxy settings, NODE_OPTIONS,
  // package-manager settings, and arbitrary simulator secrets are not inherited.
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "PATHEXT", "LANG", "LC_ALL", "TZ"]) {
    if (process.env[name] !== undefined) sanitized[name] = process.env[name];
  }
  return sanitized;
}
function sanitizedFunctionEnvironment(environment: Readonly<Record<string, string>>): Record<string, string> {
  const launchControls = new Set([
    "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_CHANNEL_FD",
    "LD_PRELOAD", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
    "STACKSIM_CLOUDFORMATION_CALLBACK_PORT", "STACKSIM_CLOUDFORMATION_NETWORK_PORTS",
  ]);
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !launchControls.has(name.toUpperCase())));
}
function tags(input: unknown): Record<string, string> {
  if (input === undefined) return {}; if (!input || Array.isArray(input) || typeof input !== "object") throw new AwsError("InvalidParameterValueException", "Tags must be a string map");
  const result: Record<string, string> = {}; for (const [key, value] of Object.entries(input as object)) { if (!key || key.length > 128 || typeof value !== "string" || value.length > 256) throw new AwsError("InvalidParameterValueException", "Invalid tag"); result[key] = value; } if (Object.keys(result).length > 50) throw new AwsError("InvalidParameterValueException", "A maximum of 50 tags is allowed"); return result;
}

export class LambdaService {
  private readonly children = new Set<ChildProcess>();
  private readonly dockerRuntime = new LambdaDockerRuntime();
  private asyncWorkerCancel?: () => void;
  private asyncWorkerRunning = false;
  private asyncWorker = Promise.resolve();
  private stopped = true;
  private readonly eventSources: LambdaEventSourceMappings;
  private readonly concurrency: LambdaConcurrencyController;
  private readonly workerPool: LambdaWorkerPool;
  private readonly layers: LambdaLayers;
  private readonly images: LambdaImages;
  private readonly capacityProviders: LambdaCapacityProviders;
  private readonly durableExecutions: LambdaDurableExecutions;
  private readonly functionUrls: LambdaFunctionUrls;
  private readonly activeDurableChildren = new Map<string, () => void>();
  private readonly controlEndpoint: () => string;
  private readonly provisionedTransitions = new Map<string, () => void>();
  private readonly functionTransitions = new Set<Promise<void>>();
  private sqsService?: LambdaSqsServicePort;
  private snsService?: LambdaSnsServicePort;
  private eventBridgeService?: EventBridgeService;
  private s3Service?: S3Service;
  constructor(
    private readonly store: StateStore,
    private readonly region: string,
    private readonly logs?: CloudWatchLogsService,
    private readonly clock: Clock = new SystemClock(),
    private readonly authMode: "off" | "validate" | "enforce" = "off",
    private readonly rootRecovery = false,
    private readonly random: () => number = Math.random,
    private readonly telemetry?: TelemetryBus,
    private readonly scheduler?: Scheduler,
    concurrentExecutions = 1_000,
    unreservedConcurrencyReserve = Math.min(100, Math.max(0, concurrentExecutions - 1)),
    invokeEndpoint: () => string = () => "http://127.0.0.1:4567",
    controlEndpoint: () => string = invokeEndpoint,
    sqs?: LambdaSqsServicePort,
  ) {
    this.controlEndpoint = controlEndpoint;
    this.sqsService = sqs;
    this.concurrency = new LambdaConcurrencyController(store, region, clock, concurrentExecutions, unreservedConcurrencyReserve, telemetry);
    const workerIdleMs = Number(process.env.STACKSIM_LAMBDA_WORKER_IDLE_MS ?? 300_000);
    if (!Number.isFinite(workerIdleMs) || workerIdleMs < 1) throw new Error("Lambda worker idle expiry must be a positive number of milliseconds");
    this.workerPool = new LambdaWorkerPool(clock, this.children, concurrentExecutions, workerIdleMs, (target, allocated, error) => {
      const separator = target.lastIndexOf(":"); const functionName = target.slice(0, separator); const qualifier = target.slice(separator + 1);
      const config = this.store.regionState(this.region).functions[functionName]?.provisionedConcurrencyConfigs?.[qualifier]; if (!config) return;
      config.allocatedProvisionedConcurrentExecutions = allocated;
      if (error) { config.status = "FAILED"; config.statusReason = error.message; }
      else if (allocated >= config.requestedProvisionedConcurrentExecutions) { config.status = "READY"; delete config.statusReason; }
      else { config.status = "IN_PROGRESS"; delete config.statusReason; }
      void this.store.save();
    });
    this.layers = new LambdaLayers(store, region, clock);
    this.images = new LambdaImages(region);
    this.capacityProviders = new LambdaCapacityProviders(store, region, clock, scheduler, authMode, rootRecovery);
    this.durableExecutions = new LambdaDurableExecutions(store, region, clock, scheduler, {
      invokeExecution: (execution, input) => { const fn = this.require(execution.functionName); const resolved: ResolvedFunction = { fn, executable: execution.executable, requestedQualifier: execution.requestedQualifier, executedVersion: execution.executedVersion, qualifiedArn: execution.functionArn }; return this.invokeRuntime(fn.functionName, Buffer.from(JSON.stringify(input)), id(24), { qualifier: execution.requestedQualifier, lineage: execution.lineage, durableReplay: true, durableExecutionArn: execution.durableExecutionArn, resolvedOverride: resolved }); },
      invokeChained: async (execution, functionName, payload) => { const target = this.resolveInvocation(functionName); if (this.authMode === "enforce" && evaluateRoleAuthorization(this.store.ensureAccount().iam, execution.executable.role, "lambda:InvokeFunction", target.qualifiedArn).decision !== "allowed") throw new AwsError("AccessDeniedException", `Execution role ${execution.executable.role} cannot invoke ${target.qualifiedArn}`, 403); return this.invoke(functionName, payload, id(24), { lineage: [...(execution.lineage ?? []), execution.functionArn] }); },
      deliverDeadLetter: execution => this.deliverDurableDeadLetter(execution),
      terminateExecution: arn => this.activeDurableChildren.get(arn)?.(),
    });
    this.functionUrls = new LambdaFunctionUrls(store, region, clock, invokeEndpoint, {
      resolve: (functionName, qualifier) => this.resolve(functionName, qualifier),
      invoke: (functionName, payload, requestId, qualifier, lineage) => this.invoke(functionName, payload, requestId, { qualifier, lineage }),
      invokeStreaming: (functionName, payload, requestId, qualifier, callbacks, lineage) => this.invokeStreaming(functionName, payload, requestId, { qualifier, lineage }, callbacks),
      publishMetric: (functionName, metricName, value) => this.publishFunctionUrlMetric(functionName, metricName, value),
    });
    this.eventSources = new LambdaEventSourceMappings(store, region, clock, {
      resolveFunction: target => { const resolved = this.resolve(target); return { functionName: resolved.fn.functionName, ...(resolved.requestedQualifier ? { qualifier: resolved.requestedQualifier } : {}), functionArn: resolved.qualifiedArn, role: resolved.executable.role, timeout: resolved.executable.timeout }; },
      invoke: (functionName, qualifier, payload, requestId, lineage) => this.invokeEventSource(functionName, qualifier, payload, requestId, lineage),
    }, authMode, telemetry, scheduler, sqs);
  }
  private get tokens(): PaginationTokens { return new PaginationTokens(this.store.state.installation.paginationSecret); }
  setS3Service(service: S3Service): void { this.s3Service = service; }
  private require(nameOrArn: string): LambdaState {
    const { name } = parseFunctionTarget(nameOrArn); const fn = this.store.regionState(this.region).functions[name]; if (!fn) throw new AwsError("ResourceNotFoundException", `Function not found: ${name}`, 404);
    fn.tags ??= {}; fn.versions ??= {}; fn.aliases ??= {}; fn.policies ??= {}; fn.eventInvokeConfigs ??= {}; fn.provisionedConcurrencyConfigs ??= {}; fn.functionUrlConfigs ??= {}; fn.functionScalingConfigs ??= {}; fn.layers ??= []; fn.packageType ??= "Zip"; fn.architectures ??= ["x86_64"]; fn.ephemeralStorageSize ??= 512; fn.loggingConfig ??= { logFormat: "Text", logGroup: `/aws/lambda/${fn.functionName}` }; fn.tracingMode ??= "PassThrough"; fn.fileSystemConfigs ??= []; fn.vpcConfig ??= { subnetIds: [], securityGroupIds: [], ipv6AllowedForDualStack: false }; fn.runtimeManagementConfig ??= { updateRuntimeOn: "Auto" }; fn.recursiveLoop ??= "Terminate"; for (const version of Object.values(fn.versions)) { version.layers ??= []; version.packageType ??= "Zip"; version.architectures ??= ["x86_64"]; version.ephemeralStorageSize ??= 512; version.loggingConfig ??= { logFormat: "Text", logGroup: `/aws/lambda/${fn.functionName}` }; version.tracingMode ??= "PassThrough"; version.fileSystemConfigs ??= []; version.vpcConfig ??= { subnetIds: [], securityGroupIds: [], ipv6AllowedForDualStack: false }; version.runtimeManagementConfig ??= { updateRuntimeOn: "Auto" }; } fn.revisionId ??= id(32); return fn;
  }
  private resolve(nameOrArn: string, explicitQualifier?: string): ResolvedFunction {
    const target = parseFunctionTarget(nameOrArn); const fn = this.require(target.name); const qualifier = explicitQualifier ?? target.qualifier;
    if (!qualifier || qualifier === "$LATEST") return { fn, executable: fn, requestedQualifier: qualifier, executedVersion: "$LATEST", qualifiedArn: qualifier ? `${fn.functionArn}:$LATEST` : fn.functionArn };
    let version = qualifier;
    const alias = fn.aliases?.[qualifier];
    if (alias) { const draw = this.random(); let cursor = 0; version = alias.functionVersion; for (const [candidate, weight] of Object.entries(alias.additionalVersionWeights).sort(([a], [b]) => Number(a) - Number(b))) { cursor += weight; if (draw < cursor) { version = candidate; break; } } }
    const snapshot = fn.versions?.[version]; if (!snapshot) throw new AwsError("ResourceNotFoundException", `Function not found: ${fn.functionName}:${qualifier}`, 404);
    return { fn, executable: snapshot, requestedQualifier: qualifier, executedVersion: version, qualifiedArn: `${fn.functionArn}:${qualifier}` };
  }
  private resolveInvocation(nameOrArn: string, explicitQualifier?: string): ResolvedFunction {
    const target = parseFunctionTarget(nameOrArn); const fn = this.require(target.name); const qualifier = explicitQualifier ?? target.qualifier;
    return !qualifier && fn.capacityProviderConfig ? this.resolve(target.name, "$LATEST.PUBLISHED") : this.resolve(nameOrArn, explicitQualifier);
  }
  private inlineCodeSource(item: Executable): { Type: "Inline"; FileName: "index.mjs" } | undefined {
    // The console's inline ZIP writer stores one uncompressed index.mjs entry.
    // Its fixed ZIP headers add 116 bytes, which lets older persisted functions
    // remain distinguishable from normal uploaded deployment packages.
    if (item.packageType !== "Zip" || !item.codeDir || item.codeUnzippedSize === undefined || item.codeSize !== item.codeUnzippedSize + 116) return undefined;
    try {
      const entries = readdirSync(item.codeDir, { withFileTypes: true });
      if (entries.length === 1 && entries[0].isFile() && entries[0].name === "index.mjs") return { Type: "Inline", FileName: "index.mjs" };
    } catch { /* A missing local artifact is reported by the normal code path. */ }
    return undefined;
  }
  private configuration(resolved: ResolvedFunction): any {
    const { fn, executable: item } = resolved;
    return {
      FunctionName: fn.functionName, FunctionArn: resolved.qualifiedArn, ...(item.packageType === "Zip" ? { Runtime: item.runtime, Handler: item.handler } : {}), Role: item.role, CodeSize: item.codeSize, Description: item.description, Timeout: item.timeout, MemorySize: item.memorySize, LastModified: item.lastModified, CodeSha256: item.codeSha256, Version: resolved.executedVersion, RevisionId: resolved.executedVersion === "$LATEST" ? fn.revisionId : (item as LambdaVersionState).revisionId, State: fn.state ?? "Active", StateReason: fn.stateReason, LastUpdateStatus: fn.lastUpdateStatus ?? "Successful", LastUpdateStatusReason: fn.lastUpdateStatusReason,
      Environment: { Variables: item.environment, ...(item.environmentError ? { Error: { ErrorCode: item.environmentError.errorCode, Message: item.environmentError.message } } : {}) },
      ...(item.packageType === "Zip" ? { Layers: this.layers.functionView(item.layers) } : { ImageConfigResponse: { ImageConfig: this.images.imageConfigView(item.imageConfig) } }), PackageType: item.packageType, Architectures: item.architectures,
      EphemeralStorage: { Size: item.ephemeralStorageSize },
      LoggingConfig: { LogFormat: item.loggingConfig.logFormat, ...(item.loggingConfig.applicationLogLevel ? { ApplicationLogLevel: item.loggingConfig.applicationLogLevel } : {}), ...(item.loggingConfig.systemLogLevel ? { SystemLogLevel: item.loggingConfig.systemLogLevel } : {}), LogGroup: item.loggingConfig.logGroup },
      TracingConfig: { Mode: item.tracingMode }, DeadLetterConfig: item.deadLetterTargetArn ? { TargetArn: item.deadLetterTargetArn } : {},
      FileSystemConfigs: item.fileSystemConfigs.map(config => ({ Arn: config.arn, LocalMountPath: config.localMountPath })),
      VpcConfig: { SubnetIds: item.vpcConfig.subnetIds, SecurityGroupIds: item.vpcConfig.securityGroupIds, Ipv6AllowedForDualStack: item.vpcConfig.ipv6AllowedForDualStack },
      ...(item.kmsKeyArn ? { KMSKeyArn: item.kmsKeyArn } : {}), ...(fn.codeSigningConfigArn ? { CodeSigningConfigArn: fn.codeSigningConfigArn } : {}), ...(item.capacityProviderConfig ? { CapacityProviderConfig: this.capacityProviders.assignmentView(item.capacityProviderConfig) } : {}), ...(item.durableConfig ? { DurableConfig: durableConfigView(item.durableConfig) } : {}),
    };
  }
  private publishSnapshot(fn: LambdaState, version: string, description = fn.description, cloudFormationOperationToken?: string): LambdaVersionState {
    const snapshot: LambdaVersionState = { version, functionArn: `${fn.functionArn}:${version}`, packageType: fn.packageType, ...(fn.imageConfig ? { imageConfig: structuredClone(fn.imageConfig) } : {}), ...(fn.imageUri ? { imageUri: fn.imageUri } : {}), ...(fn.resolvedImageUri ? { resolvedImageUri: fn.resolvedImageUri } : {}), ...(fn.imageExecutionUri ? { imageExecutionUri: fn.imageExecutionUri } : {}), ...(fn.imageSource ? { imageSource: fn.imageSource } : {}), runtime: fn.runtime, role: fn.role, handler: fn.handler, timeout: fn.timeout, memorySize: fn.memorySize, description, environment: structuredClone(fn.environment), codeSha256: fn.codeSha256, codeSize: fn.codeSize, codeUnzippedSize: fn.codeUnzippedSize, codeDir: fn.codeDir, layers: structuredClone(fn.layers ?? []), architectures: structuredClone(fn.architectures), ephemeralStorageSize: fn.ephemeralStorageSize, loggingConfig: structuredClone(fn.loggingConfig), tracingMode: fn.tracingMode, ...(fn.deadLetterTargetArn ? { deadLetterTargetArn: fn.deadLetterTargetArn } : {}), fileSystemConfigs: structuredClone(fn.fileSystemConfigs), vpcConfig: structuredClone(fn.vpcConfig), ...(fn.kmsKeyArn ? { kmsKeyArn: fn.kmsKeyArn } : {}), runtimeManagementConfig: structuredClone(fn.runtimeManagementConfig), ...(fn.environmentError ? { environmentError: structuredClone(fn.environmentError) } : {}), lastModified: fn.lastModified, revisionId: id(32), ...(cloudFormationOperationToken ? { cloudFormationOperationToken } : {}) };
    if (fn.capacityProviderConfig) snapshot.capacityProviderConfig = structuredClone(fn.capacityProviderConfig);
    if (fn.durableConfig) snapshot.durableConfig = structuredClone(fn.durableConfig);
    fn.versions![version] = snapshot; return snapshot;
  }
  private durableSnapshot(resolved: ResolvedFunction): LambdaVersionState {
    const item = structuredClone(resolved.executable); return { ...item, version: resolved.executedVersion, functionArn: `${resolved.fn.functionArn}:${resolved.executedVersion}`, revisionId: resolved.executedVersion === "$LATEST" ? resolved.fn.revisionId! : (resolved.executable as LambdaVersionState).revisionId };
  }
  private durableQualifier(nameOrArn: string, explicitQualifier?: string): string {
    const target = parseFunctionTarget(nameOrArn); const qualifier = explicitQualifier ?? target.qualifier; if (!qualifier) throw new AwsError("InvalidParameterValueException", "Durable functions require a qualified version, alias, or $LATEST"); return qualifier;
  }
  private durableInvocationResult(execution: LambdaDurableExecutionState, requestId: string, invocation?: Awaited<ReturnType<LambdaDurableExecutions["run"]>>["invocation"], timedOut = false, interrupted = false): InvokeResult {
    const common = { statusCode: 200, requestId: invocation?.requestId ?? requestId, durationMs: invocation?.durationMs ?? 0, billedDurationMs: invocation?.billedDurationMs ?? 1, executedVersion: execution.executedVersion, ...(invocation?.logResult ? { logResult: invocation.logResult } : {}), durableExecutionArn: execution.durableExecutionArn };
    if (interrupted || invocation?.interrupted) return { ...common, payload: Buffer.from("null"), interrupted: true };
    if (timedOut) return { ...common, payload: Buffer.from(JSON.stringify({ errorMessage: `Task timed out after ${execution.executable.timeout}.00 seconds`, errorType: "TimeoutError" })), functionError: "Unhandled" };
    if (execution.status === "SUCCEEDED") return { ...common, payload: Buffer.from(execution.result ?? "null") };
    if (execution.status !== "RUNNING") { const error = execution.error ?? { ErrorType: execution.status, ErrorMessage: `Durable execution ${execution.status.toLowerCase()}` }; return { ...common, payload: Buffer.from(JSON.stringify({ errorMessage: error.ErrorMessage, errorType: error.ErrorType, errorData: error.ErrorData, stackTrace: error.StackTrace })), functionError: "Unhandled" }; }
    if (invocation?.functionError) return { ...common, payload: invocation.payload, functionError: invocation.functionError };
    return { ...common, payload: Buffer.from(JSON.stringify({ errorMessage: "The durable execution is still running", errorType: "DurableExecutionPending" })), functionError: "Unhandled" };
  }
  private async invokeDurable(resolved: ResolvedFunction, payload: Buffer, requestId: string, options: InvokeOptions, invocationType: "RequestResponse" | "Event"): Promise<InvokeResult> {
    const qualifier = this.durableQualifier(resolved.fn.functionName, options.qualifier ?? resolved.requestedQualifier); const started = await this.durableExecutions.create({ functionName: resolved.fn.functionName, functionArn: `${resolved.fn.functionArn}:${resolved.executedVersion}`, requestedQualifier: qualifier, executedVersion: resolved.executedVersion, executable: this.durableSnapshot(resolved), invocationType, payload, durableExecutionName: options.durableExecutionName, traceHeader: options.traceHeader, lineage: options.lineage });
    if (invocationType === "Event") { if (started.created) this.durableExecutions.scheduleInitial(started.execution); return { payload: Buffer.alloc(0), statusCode: 202, requestId, durationMs: 0, billedDurationMs: 0, executedVersion: started.execution.executedVersion, durableExecutionArn: started.execution.durableExecutionArn }; }
    const outcome = await this.durableExecutions.run(started.execution.durableExecutionArn); if (this.stopped || outcome.invocation?.interrupted || outcome.invocation?.functionError || outcome.execution.status !== "RUNNING") return this.durableInvocationResult(outcome.execution, requestId, outcome.invocation, false, this.stopped);
    const remaining = Math.max(0, outcome.execution.executable.timeout * 1000 - (outcome.invocation?.durationMs ?? 0)); const terminal = await this.durableExecutions.waitForTerminal(outcome.execution, remaining); return this.durableInvocationResult(outcome.execution, requestId, outcome.invocation, !terminal, this.stopped);
  }
  private publicationTarget(fn: LambdaState, publish: boolean, publishTo?: unknown): string | undefined {
    if (publishTo !== undefined) {
      if (publishTo !== "LATEST_PUBLISHED") throw new AwsError("InvalidParameterValueException", "PublishTo must be LATEST_PUBLISHED");
      this.capacityProviders.assertPublishCapacity(fn); if (!fn.versions?.["$LATEST.PUBLISHED"]) this.capacityProviders.assertSnapshotQuota(fn); return "$LATEST.PUBLISHED";
    }
    if (!publish) return undefined; this.capacityProviders.assertSnapshotQuota(fn); return String(++fn.version);
  }
  private validateConfiguration(input: any, creating = false): void {
    if (creating && (!input.FunctionName || !/^[A-Za-z0-9-_]{1,64}$/.test(input.FunctionName))) throw new AwsError("InvalidParameterValueException", "FunctionName must be 1-64 letters, numbers, hyphens, or underscores");
    if (input.Runtime && !/^(?:nodejs(?:18|20|22|24)\.x|python3\.13)$/.test(input.Runtime)) throw new AwsError("InvalidParameterValueException", "Only Node.js 18, 20, 22, and 24 and the pinned CDK helper's python3.13 runtime are accepted");
    if (input.Handler && (!/^[^\s]{1,128}$/.test(input.Handler) || !input.Handler.includes("."))) throw new AwsError("InvalidParameterValueException", "Handler must use module.export format");
    if (input.Timeout !== undefined && (!Number.isInteger(input.Timeout) || input.Timeout < 1 || input.Timeout > 900)) throw new AwsError("InvalidParameterValueException", "Timeout must be between 1 and 900 seconds");
    if (input.MemorySize !== undefined && (!Number.isInteger(input.MemorySize) || input.MemorySize < 128 || input.MemorySize > 10_240)) throw new AwsError("InvalidParameterValueException", "MemorySize must be between 128 and 10240 MB");
    if (input.Description !== undefined && (typeof input.Description !== "string" || input.Description.length > 256)) throw new AwsError("InvalidParameterValueException", "Description must not exceed 256 characters");
    if (input.Environment !== undefined) { if (!input.Environment || typeof input.Environment !== "object" || Array.isArray(input.Environment) || !input.Environment.Variables || typeof input.Environment.Variables !== "object" || Array.isArray(input.Environment.Variables)) throw new AwsError("InvalidParameterValueException", "Environment.Variables must be a string map"); const environment = input.Environment.Variables; if (Object.keys(environment).some(key => !/^[A-Za-z][A-Za-z0-9_]+$/.test(key)) || Object.values(environment).some(value => typeof value !== "string") || Buffer.byteLength(JSON.stringify(environment)) > 4096) throw new AwsError("InvalidParameterValueException", "Lambda environment keys and string values must fit within 4 KB"); }
    if (input.Architectures !== undefined && (!Array.isArray(input.Architectures) || input.Architectures.length !== 1 || !new Set(["x86_64", "arm64"]).has(input.Architectures[0]))) throw new AwsError("InvalidParameterValueException", "Architectures must contain exactly one of x86_64 or arm64");
    if (input.EphemeralStorage !== undefined && (!input.EphemeralStorage || !Number.isInteger(input.EphemeralStorage.Size) || input.EphemeralStorage.Size < 512 || input.EphemeralStorage.Size > 10_240)) throw new AwsError("InvalidParameterValueException", "EphemeralStorage.Size must be between 512 and 10240 MB");
    if (input.TracingConfig !== undefined && (!input.TracingConfig || !new Set(["Active", "PassThrough"]).has(input.TracingConfig.Mode))) throw new AwsError("InvalidParameterValueException", "TracingConfig.Mode must be Active or PassThrough");
    if (input.LoggingConfig !== undefined) { const config = input.LoggingConfig; if (!config || typeof config !== "object" || Array.isArray(config)) throw new AwsError("InvalidParameterValueException", "LoggingConfig must be an object"); if (config.LogFormat !== undefined && !new Set(["JSON", "Text"]).has(config.LogFormat)) throw new AwsError("InvalidParameterValueException", "LoggingConfig.LogFormat must be JSON or Text"); if (config.ApplicationLogLevel !== undefined && !new Set(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]).has(config.ApplicationLogLevel)) throw new AwsError("InvalidParameterValueException", "Invalid application log level"); if (config.SystemLogLevel !== undefined && !new Set(["DEBUG", "INFO", "WARN"]).has(config.SystemLogLevel)) throw new AwsError("InvalidParameterValueException", "Invalid system log level"); if ((config.LogFormat ?? "Text") === "Text" && (config.ApplicationLogLevel !== undefined || config.SystemLogLevel !== undefined)) throw new AwsError("InvalidParameterValueException", "Application and system log levels require JSON log format"); if (config.LogGroup !== undefined && (typeof config.LogGroup !== "string" || config.LogGroup.length < 1 || config.LogGroup.length > 512 || !/^[.\-_/#A-Za-z0-9]+$/.test(config.LogGroup) || config.LogGroup.startsWith("aws/"))) throw new AwsError("InvalidParameterValueException", "Invalid Lambda log group name"); }
    if (input.DeadLetterConfig !== undefined) { if (!input.DeadLetterConfig || typeof input.DeadLetterConfig !== "object" || Array.isArray(input.DeadLetterConfig)) throw new AwsError("InvalidParameterValueException", "DeadLetterConfig must be an object"); const target = input.DeadLetterConfig.TargetArn; if (target !== undefined && target !== "" && (typeof target !== "string" || !/^arn:(?:aws|aws-us-gov|aws-cn):(sqs|sns):[^:]+:\d{12}:.+$/.test(target))) throw new AwsError("InvalidParameterValueException", "DeadLetterConfig TargetArn must be an SQS queue or SNS topic ARN"); if (typeof target === "string" && target.includes(":sqs:") && this.sqsService) { const match = target.match(/^arn:(?:aws|aws-us-gov|aws-cn):sqs:([^:]+):(\d{12}):/); if (!match || match[1] !== this.region || match[2] !== this.store.accountId || !this.sqsQueueExists(target)) throw new AwsError("InvalidParameterValueException", `Dead-letter queue does not exist in this simulator account and Region: ${target}`); } if (typeof target === "string" && target.includes(":sns:")) { const match = target.match(/^arn:(?:aws|aws-us-gov|aws-cn):sns:([^:]+):(\d{12}):/); if (!match || match[1] !== this.region || match[2] !== this.store.accountId || !this.snsService) throw new AwsError("InvalidParameterValueException", `SNS dead-letter topic dependency is unavailable: ${target}`); try { this.snsService.assertTopicExists(target); } catch { throw new AwsError("InvalidParameterValueException", `Dead-letter SNS topic does not exist: ${target}`); } } }
    if (input.FileSystemConfigs !== undefined) { if (!Array.isArray(input.FileSystemConfigs) || input.FileSystemConfigs.length > 1) throw new AwsError("InvalidParameterValueException", "FileSystemConfigs supports at most one access point"); for (const config of input.FileSystemConfigs) if (!config || typeof config !== "object" || !/^arn:(?:aws|aws-us-gov|aws-cn):elasticfilesystem:[^:]+:\d{12}:access-point\/fsap-[0-9a-f]+$/.test(config.Arn ?? "") || !/^\/mnt\/[A-Za-z0-9._-]+$/.test(config.LocalMountPath ?? "")) throw new AwsError("InvalidParameterValueException", "File system configuration requires an EFS access-point ARN and /mnt/... mount path"); }
    if (input.VpcConfig !== undefined) { const config = input.VpcConfig; if (!config || typeof config !== "object" || Array.isArray(config)) throw new AwsError("InvalidParameterValueException", "VpcConfig must be an object"); const subnets = config.SubnetIds ?? []; const groups = config.SecurityGroupIds ?? []; if (!Array.isArray(subnets) || subnets.length > 16 || subnets.some((value: unknown) => typeof value !== "string" || !/^subnet-[0-9a-f]+$/i.test(value)) || new Set(subnets).size !== subnets.length) throw new AwsError("InvalidParameterValueException", "VpcConfig supports up to 16 unique subnet IDs"); if (!Array.isArray(groups) || groups.length > 5 || groups.some((value: unknown) => typeof value !== "string" || !/^sg-[0-9a-f]+$/i.test(value)) || new Set(groups).size !== groups.length) throw new AwsError("InvalidParameterValueException", "VpcConfig supports up to 5 unique security group IDs"); if ((subnets.length === 0) !== (groups.length === 0)) throw new AwsError("InvalidParameterValueException", "VpcConfig must provide both subnet and security group IDs, or neither"); if (config.Ipv6AllowedForDualStack !== undefined && typeof config.Ipv6AllowedForDualStack !== "boolean") throw new AwsError("InvalidParameterValueException", "Ipv6AllowedForDualStack must be a boolean"); }
    if (input.KMSKeyArn !== undefined && input.KMSKeyArn !== "" && (typeof input.KMSKeyArn !== "string" || !/^arn:(?:aws|aws-us-gov|aws-cn):kms:[^:]+:\d{12}:key\/[A-Za-z0-9-]+$/.test(input.KMSKeyArn))) throw new AwsError("InvalidParameterValueException", "KMSKeyArn must be a KMS key ARN");
    if (input.CodeSigningConfigArn !== undefined && input.CodeSigningConfigArn !== "" && !this.store.regionState(this.region).lambdaCodeSigningConfigs[input.CodeSigningConfigArn]) throw new AwsError("ResourceNotFoundException", "Code signing configuration not found", 404);
    this.images.validateImageConfig(input.ImageConfig);
  }
  private validatePackageConfiguration(input: any, creating: boolean, current?: LambdaState): "Zip" | "Image" {
    const packageType = (creating ? input.PackageType ?? "Zip" : current?.packageType ?? "Zip") as "Zip" | "Image";
    if (!new Set(["Zip", "Image"]).has(packageType)) throw new AwsError("InvalidParameterValueException", "PackageType must be Zip or Image");
    if (!creating && input.PackageType !== undefined && input.PackageType !== packageType) throw new AwsError("InvalidParameterValueException", "The deployment package type cannot be changed for an existing function");
    if (packageType === "Image") {
      if (creating && (!input.Code?.ImageUri || !input.Role)) throw new AwsError("InvalidParameterValueException", "FunctionName, Code.ImageUri and Role are required for an image function");
      if (input.Runtime !== undefined || input.Handler !== undefined) throw new AwsError("InvalidParameterValueException", "Runtime and Handler must not be specified for an image function");
      if (input.Layers !== undefined) throw new AwsError("InvalidParameterValueException", "Layers are not supported for image functions");
      if (input.CodeSigningConfigArn !== undefined) throw new AwsError("InvalidParameterValueException", "Code signing configuration is supported only for Zip functions");
      const code = input.Code; if (code && (code.ZipFile !== undefined || code.S3Bucket !== undefined || code.S3Key !== undefined || code.S3ObjectVersion !== undefined || code.SourceKMSKeyArn !== undefined)) throw new AwsError("InvalidParameterValueException", "Image functions accept only Code.ImageUri");
    } else {
      if (creating && (!input.Code?.ZipFile || !input.Handler || !input.Runtime || !input.Role)) throw new AwsError("InvalidParameterValueException", "FunctionName, Code.ZipFile, Handler, Runtime and Role are required");
      if (input.ImageConfig !== undefined || input.Code?.ImageUri !== undefined) throw new AwsError("InvalidParameterValueException", "ImageUri and ImageConfig are valid only for image functions");
    }
    return packageType;
  }
  private executableConfiguration(input: any, functionName: string, current?: LambdaExecutableConfigurationState, principal?: PrincipalContext): LambdaExecutableConfigurationState {
    const architecture = (input.Architectures?.[0] ?? current?.architectures[0] ?? "x86_64") as LambdaArchitecture;
    const requestedLogging = input.LoggingConfig; const format = requestedLogging?.LogFormat ?? current?.loggingConfig.logFormat ?? "Text";
    const capacityProviderConfig = this.capacityProviders.validateAssignment(input.CapacityProviderConfig, current?.capacityProviderConfig, principal);
    const nextDurableConfig = durableConfig(input.DurableConfig, this.region, this.store.accountId, current?.durableConfig, !current);
    return {
      packageType: current?.packageType ?? (input.PackageType === "Image" ? "Image" : "Zip"), ...(this.images.imageConfig(input.ImageConfig, current?.imageConfig) ? { imageConfig: this.images.imageConfig(input.ImageConfig, current?.imageConfig) } : {}), ...(current?.imageUri ? { imageUri: current.imageUri } : {}), ...(current?.resolvedImageUri ? { resolvedImageUri: current.resolvedImageUri } : {}), ...(current?.imageExecutionUri ? { imageExecutionUri: current.imageExecutionUri } : {}), ...(current?.imageSource ? { imageSource: current.imageSource } : {}),
      architectures: [architecture], ephemeralStorageSize: input.EphemeralStorage?.Size ?? current?.ephemeralStorageSize ?? 512,
      loggingConfig: { logFormat: format, ...(requestedLogging?.ApplicationLogLevel !== undefined ? { applicationLogLevel: requestedLogging.ApplicationLogLevel } : format === "JSON" && current?.loggingConfig.applicationLogLevel ? { applicationLogLevel: current.loggingConfig.applicationLogLevel } : {}), ...(requestedLogging?.SystemLogLevel !== undefined ? { systemLogLevel: requestedLogging.SystemLogLevel } : format === "JSON" && current?.loggingConfig.systemLogLevel ? { systemLogLevel: current.loggingConfig.systemLogLevel } : {}), logGroup: requestedLogging?.LogGroup ?? current?.loggingConfig.logGroup ?? `/aws/lambda/${functionName}` },
      tracingMode: input.TracingConfig?.Mode ?? current?.tracingMode ?? "PassThrough", ...(input.DeadLetterConfig?.TargetArn ? { deadLetterTargetArn: input.DeadLetterConfig.TargetArn } : input.DeadLetterConfig !== undefined ? {} : current?.deadLetterTargetArn ? { deadLetterTargetArn: current.deadLetterTargetArn } : {}),
      fileSystemConfigs: input.FileSystemConfigs !== undefined ? input.FileSystemConfigs.map((config: any) => ({ arn: config.Arn, localMountPath: config.LocalMountPath })) : structuredClone(current?.fileSystemConfigs ?? []),
      vpcConfig: input.VpcConfig !== undefined ? { subnetIds: [...(input.VpcConfig.SubnetIds ?? [])], securityGroupIds: [...(input.VpcConfig.SecurityGroupIds ?? [])], ipv6AllowedForDualStack: input.VpcConfig.Ipv6AllowedForDualStack ?? false } : structuredClone(current?.vpcConfig ?? { subnetIds: [], securityGroupIds: [], ipv6AllowedForDualStack: false }),
      ...(input.KMSKeyArn ? { kmsKeyArn: input.KMSKeyArn } : input.KMSKeyArn !== undefined ? {} : current?.kmsKeyArn ? { kmsKeyArn: current.kmsKeyArn } : {}), runtimeManagementConfig: structuredClone(current?.runtimeManagementConfig ?? { updateRuntimeOn: "Auto" }),
      ...(current?.environmentError ? { environmentError: structuredClone(current.environmentError) } : {}), ...(capacityProviderConfig ? { capacityProviderConfig } : {}), ...(nextDurableConfig ? { durableConfig: nextDurableConfig } : {}),
    };
  }
  private requireCodeSigningConfig(value: string): LambdaCodeSigningConfigState {
    const arn = decodeURIComponent(value); const config = this.store.regionState(this.region).lambdaCodeSigningConfigs[arn];
    if (!config) throw new AwsError("ResourceNotFoundException", "Code signing configuration not found", 404);
    return config;
  }
  private codeSigningConfigView(config: LambdaCodeSigningConfigState): any {
    return { AllowedPublishers: { SigningProfileVersionArns: config.allowedPublishers }, CodeSigningConfigArn: config.codeSigningConfigArn, CodeSigningConfigId: config.codeSigningConfigId, CodeSigningPolicies: { UntrustedArtifactOnDeployment: config.untrustedArtifactOnDeployment }, Description: config.description, LastModified: config.lastModified };
  }
  private validateCodeSigningConfig(input: any, creating: boolean, current?: LambdaCodeSigningConfigState): { allowedPublishers: string[]; policy: "Enforce" | "Warn"; description: string } {
    const publishers = input.AllowedPublishers?.SigningProfileVersionArns ?? current?.allowedPublishers;
    if (!Array.isArray(publishers) || publishers.length < 1 || publishers.length > 20 || publishers.some((arn: unknown) => typeof arn !== "string" || !/^arn:(?:aws|aws-us-gov|aws-cn):signer:[^:]+:\d{12}:\/signing-profiles\/[A-Za-z0-9_]{2,64}\/[A-Za-z0-9]+$/.test(arn)) || new Set(publishers).size !== publishers.length) throw new AwsError("InvalidParameterValueException", "AllowedPublishers must contain 1-20 unique signing profile version ARNs");
    const policy = input.CodeSigningPolicies?.UntrustedArtifactOnDeployment ?? current?.untrustedArtifactOnDeployment ?? "Warn"; if (!new Set(["Enforce", "Warn"]).has(policy)) throw new AwsError("InvalidParameterValueException", "UntrustedArtifactOnDeployment must be Enforce or Warn");
    const description = input.Description ?? current?.description ?? ""; if (typeof description !== "string" || description.length > 256) throw new AwsError("InvalidParameterValueException", "Description must not exceed 256 characters");
    if (!creating && input.AllowedPublishers !== undefined && (!input.AllowedPublishers || typeof input.AllowedPublishers !== "object")) throw new AwsError("InvalidParameterValueException", "AllowedPublishers must be an object");
    return { allowedPublishers: [...publishers], policy, description };
  }
  private async handleCodeSigning(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<boolean> {
    const collection = "/2020-04-22/code-signing-configs"; if (!pathname.startsWith(collection)) return false; const state = this.store.regionState(this.region).lambdaCodeSigningConfigs;
    if (pathname === collection) {
      if (req.method === "POST") { const input = JSON.parse((await readBody(req)).toString("utf8") || "{}"); const validated = this.validateCodeSigningConfig(input, true); const configId = `csc-${id(17)}`; const arn = `arn:aws:lambda:${this.region}:${this.store.accountId}:code-signing-config:${configId}`; const config: LambdaCodeSigningConfigState = { codeSigningConfigId: configId, codeSigningConfigArn: arn, allowedPublishers: validated.allowedPublishers, untrustedArtifactOnDeployment: validated.policy, description: validated.description, lastModified: new Date(this.clock.now()).toISOString(), tags: tags(input.Tags) }; state[arn] = config; await this.store.save(); json(res, { CodeSigningConfig: this.codeSigningConfigView(config) }, 201); return true; }
      if (req.method === "GET") { const max = Number(url.searchParams.get("MaxItems") ?? 10_000); if (!Number.isInteger(max) || max < 1 || max > 10_000) throw new AwsError("InvalidParameterValueException", "MaxItems must be between 1 and 10000"); const values = Object.values(state).sort((left, right) => left.codeSigningConfigArn.localeCompare(right.codeSigningConfigArn)); let start = 0; const marker = url.searchParams.get("Marker"); if (marker) try { start = this.tokens.decode<{ index: number }>("ListCodeSigningConfigs", marker).index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid Marker"); } const page = values.slice(start, start + max); const next = start + page.length; json(res, { CodeSigningConfigs: page.map(config => this.codeSigningConfigView(config)), ...(next < values.length ? { NextMarker: this.tokens.encode("ListCodeSigningConfigs", { index: next }) } : {}) }); return true; }
      throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404);
    }
    const match = pathname.match(/^\/2020-04-22\/code-signing-configs\/(.+?)(\/functions)?$/); if (!match) throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404); const config = this.requireCodeSigningConfig(match[1]);
    if (match[2]) { if (req.method !== "GET") throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404); const max = Number(url.searchParams.get("MaxItems") ?? 10_000); if (!Number.isInteger(max) || max < 1 || max > 10_000) throw new AwsError("InvalidParameterValueException", "MaxItems must be between 1 and 10000"); const values = Object.values(this.store.regionState(this.region).functions).filter(fn => fn.codeSigningConfigArn === config.codeSigningConfigArn).map(fn => fn.functionArn).sort(); let start = 0; const marker = url.searchParams.get("Marker"); if (marker) try { const cursor = this.tokens.decode<{ arn: string; index: number }>("ListFunctionsByCodeSigningConfig", marker); if (cursor.arn !== config.codeSigningConfigArn) throw new Error(); start = cursor.index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid Marker"); } const page = values.slice(start, start + max); const next = start + page.length; json(res, { FunctionArns: page, ...(next < values.length ? { NextMarker: this.tokens.encode("ListFunctionsByCodeSigningConfig", { arn: config.codeSigningConfigArn, index: next }) } : {}) }); return true; }
    if (req.method === "GET") { json(res, { CodeSigningConfig: this.codeSigningConfigView(config) }); return true; }
    if (req.method === "PUT") { const input = JSON.parse((await readBody(req)).toString("utf8") || "{}"); const validated = this.validateCodeSigningConfig(input, false, config); config.allowedPublishers = validated.allowedPublishers; config.untrustedArtifactOnDeployment = validated.policy; config.description = validated.description; config.lastModified = new Date(this.clock.now()).toISOString(); await this.store.save(); json(res, { CodeSigningConfig: this.codeSigningConfigView(config) }); return true; }
    if (req.method === "DELETE") { if (Object.values(this.store.regionState(this.region).functions).some(fn => fn.codeSigningConfigArn === config.codeSigningConfigArn)) throw new AwsError("ResourceConflictException", "Code signing configuration is in use by a function", 409); delete state[config.codeSigningConfigArn]; await this.store.save(); res.statusCode = 204; res.end(); return true; }
    throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404);
  }
  private validateRole(roleArn: string, principal?: PrincipalContext, associatedResourceArn?: string): void {
    const role = Object.values(this.store.ensureAccount().iam.roles).find(item => item.arn === roleArn);
    if (!role) throw new AwsError("InvalidParameterValueException", `The role defined for the function cannot be assumed by Lambda: ${roleArn}`);
    if (evaluateTrust(role.assumeRolePolicyDocument, "lambda.amazonaws.com", "sts:AssumeRole", { "aws:PrincipalServiceName": "lambda.amazonaws.com" }).decision !== "allowed") throw new AwsError("InvalidParameterValueException", "The role defined for the function cannot be assumed by Lambda");
    if (this.authMode === "enforce" && principal) {
      const bootstrap = this.rootRecovery && principal.principalType === "root"; const decision = bootstrap ? "allowed" : evaluateAuthorization(this.store.ensureAccount().iam, principal, "iam:PassRole", roleArn, { "iam:PassedToService": "lambda.amazonaws.com", ...(associatedResourceArn ? { "iam:AssociatedResourceArn": associatedResourceArn } : {}) }).decision;
      if (decision !== "allowed") throw new AwsError("AccessDeniedException", `User ${principal.principalArn} is not authorized to perform iam:PassRole on ${roleArn}`, 403);
    }
  }
  private async installCode(fn: LambdaState, zip: Buffer): Promise<void> {
    const limit = Number(process.env.STACKSIM_LAMBDA_ZIP_LIMIT ?? 50 * 1024 * 1024); if (zip.length > limit) throw new AwsError("RequestEntityTooLargeException", `Zipped size must be smaller than ${limit} bytes`, 413);
    const base = resolve(this.store.root, "functions"); await mkdir(base, { recursive: true }); const destination = resolve(base, `${fn.functionName}-${id(8)}`); let extraction; try { extraction = await extractZip(zip, destination, { maxUncompressedSize: 262_144_000 }); this.layers.validateFunctionLayers(fn.layers ?? [], fn.runtime, extraction.uncompressedSize, fn.architectures[0]); } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
    const old = fn.codeDir; fn.codeDir = destination; fn.codeSize = zip.length; fn.codeUnzippedSize = extraction.uncompressedSize; fn.codeSha256 = sha256(zip); fn.lastModified = new Date(this.clock.now()).toISOString(); fn.revisionId = id(32);
    if (old && !Object.values(fn.versions ?? {}).some(version => version.codeDir === old)) await rm(old, { recursive: true, force: true });
  }
  private installImage(fn: LambdaState, image: ResolvedLambdaImage): void {
    fn.imageUri = image.imageUri; fn.resolvedImageUri = image.resolvedImageUri; if (image.executionImageUri) fn.imageExecutionUri = image.executionImageUri; else delete fn.imageExecutionUri; fn.imageSource = image.imageSource; fn.codeSha256 = image.codeSha256; fn.codeSize = image.codeSize; fn.codeUnzippedSize = image.codeSize; fn.codeDir = ""; fn.lastModified = new Date(this.clock.now()).toISOString(); fn.revisionId = id(32);
  }
  private assertCodeSigningDeployment(fn: LambdaState): void {
    if (!fn.codeSigningConfigArn) return; const config = this.requireCodeSigningConfig(fn.codeSigningConfigArn); if (config.untrustedArtifactOnDeployment === "Enforce") throw new AwsError("InvalidCodeSignatureException", "The attached code signing policy is Enforce, and local ZIP artifacts cannot be verified without AWS Signer", 400);
  }
  private async mergeTree(source: string, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = resolve(source, entry.name); const to = resolve(destination, entry.name); const existing = await lstat(to).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (entry.isSymbolicLink()) throw new AwsError("InvalidParameterValueException", "Lambda code and layers cannot contain symbolic links");
      if (entry.isDirectory()) { if (existing && !existing.isDirectory()) await rm(to, { recursive: true, force: true }); await this.mergeTree(from, to); }
      else if (entry.isFile()) { if (existing) await rm(to, { recursive: true, force: true }); await mkdir(dirname(to), { recursive: true }); await copyFile(from, to); }
      else throw new AwsError("InvalidParameterValueException", "Lambda code and layers can contain only files and directories");
    }
  }
  private async prepareRuntime(executable: Executable, requestId: string): Promise<{ codeDir: string; nodePath: string; optDir?: string; root: string; tmpDir: string }> {
    const root = resolve(this.store.root, "runtime", "lambda", requestId); const tmpDir = resolve(root, "tmp"); await rm(root, { recursive: true, force: true }); await mkdir(tmpDir, { recursive: true });
    if (!executable.layers?.length) {
      if (/^nodejs\d+\.x$/.test(executable.runtime)) await writeFile(resolve(dirname(executable.codeDir), "package.json"), '{"private":true,"type":"commonjs"}\n', { flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      return { codeDir: executable.codeDir, nodePath: runtimeNodePathEntries().join(delimiter), root, tmpDir };
    }
    const optDir = resolve(root, "opt"); const codeDir = resolve(root, "task"); await mkdir(optDir, { recursive: true });
    try {
      if (/^nodejs\d+\.x$/.test(executable.runtime)) await writeFile(resolve(root, "package.json"), '{"private":true,"type":"commonjs"}\n');
      for (const layer of executable.layers) await this.mergeTree(layer.codeDir, optDir);
      const major = executable.runtime.match(/^nodejs(\d+)\.x$/)?.[1]; const modulePaths = [resolve(optDir, "nodejs", "node_modules"), ...(major ? [resolve(optDir, "nodejs", `node${major}`, "node_modules")] : [])];
      for (const modulePath of modulePaths) if (await lstat(modulePath).then(item => item.isDirectory()).catch(() => false)) await this.mergeTree(modulePath, resolve(codeDir, "node_modules"));
      await this.mergeTree(executable.codeDir, codeDir);
      const expectedModulePaths = [...(major ? [`/opt/nodejs/node${major}/node_modules`] : []), "/opt/nodejs/node_modules"];
      return { codeDir, optDir, root, tmpDir, nodePath: [resolve(codeDir, "node_modules"), ...modulePaths.slice().reverse(), ...expectedModulePaths, ...runtimeNodePathEntries()].join(delimiter) };
    } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  }
  private workerFingerprint(resolved: ResolvedFunction, options: InvokeOptions): string {
    const executable = resolved.executable;
    const sorted = (value: Readonly<Record<string, string>> | undefined) => Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)));
    return sha256(Buffer.from(JSON.stringify({
      functionName: resolved.fn.functionName, executedVersion: resolved.executedVersion,
      codeSha256: executable.codeSha256, lastModified: executable.lastModified, runtime: executable.runtime,
      architecture: executable.architectures, handler: executable.handler,
      layers: (executable.layers ?? []).map(layer => ({ arn: layer.arn, codeSize: layer.codeSize, codeDir: layer.codeDir })),
      environment: sorted(executable.environment), role: executable.role, timeout: executable.timeout,
      memorySize: executable.memorySize, ephemeralStorageSize: executable.ephemeralStorageSize,
      loggingConfig: executable.loggingConfig, tracingMode: executable.tracingMode,
      fileSystemConfigs: executable.fileSystemConfigs, vpcConfig: executable.vpcConfig,
      runtimeManagementConfig: executable.runtimeManagementConfig, capacityProviderConfig: executable.capacityProviderConfig,
      invocationProfile: { sanitizeEnvironment: Boolean(options.sanitizeEnvironment), trustedCaCertificatePath: options.trustedCaCertificatePath, environmentOverrides: sorted(options.environmentOverrides) },
    })));
  }
  private workerSpec(resolved: ResolvedFunction, options: InvokeOptions, credentials: Record<string, string>, initializationType: "on-demand" | "provisioned-concurrency", provisionedFor?: string): LambdaWorkerSpec {
    const { fn, executable } = resolved; const fingerprint = this.workerFingerprint(resolved, options);
    const streamDate = new Date(this.clock.now()).toISOString().slice(0, 10).replace(/-/g, "/");
    const logStreamName = executable.loggingConfig.logGroup === `/aws/lambda/${fn.functionName}` ? `${streamDate}/[${resolved.executedVersion}]${id(32)}` : `${streamDate}/${fn.functionName}[${resolved.executedVersion}]${id(32)}`;
    return {
      fingerprint, functionName: fn.functionName, executedVersion: resolved.executedVersion, handler: executable.handler, logStreamName, initializationType, provisionedFor,
      prepareRuntime: async () => {
        const runtime = await this.prepareRuntime(executable, id(32));
        if (options.trustedCaCertificatePath) await copyFile(options.trustedCaCertificatePath, resolve(runtime.tmpDir, "cloudformation-callback-ca.pem"));
        return runtime;
      },
      launchEnvironment: (runtime: LambdaWorkerRuntime) => ({
        ...(options.sanitizeEnvironment ? sanitizedRuntimeHostEnvironment() : process.env), NODE_PATH: runtime.nodePath,
        ...(options.sanitizeEnvironment ? sanitizedFunctionEnvironment(executable.environment) : executable.environment),
        AWS_REGION: this.region, AWS_DEFAULT_REGION: this.region, AWS_ENDPOINT_URL: this.controlEndpoint(), AWS_ENDPOINT_URL_LAMBDA: this.controlEndpoint(), STACKSIM_ENDPOINT: this.controlEndpoint(),
        AWS_LAMBDA_FUNCTION_NAME: fn.functionName, AWS_LAMBDA_FUNCTION_VERSION: resolved.executedVersion, AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(executable.memorySize), AWS_LAMBDA_INITIALIZATION_TYPE: initializationType,
        LAMBDA_TASK_ROOT: runtime.codeDir, TMPDIR: runtime.tmpDir, TMP: runtime.tmpDir, TEMP: runtime.tmpDir, STACKSIM_LAMBDA_EPHEMERAL_STORAGE_SIZE: String(executable.ephemeralStorageSize),
        ...(runtime.optDir ? { STACKSIM_LAMBDA_OPT_DIR: runtime.optDir } : {}), ...credentials, ...options.environmentOverrides,
        ...(options.trustedCaCertificatePath ? { NODE_EXTRA_CA_CERTS: resolve(runtime.tmpDir, "cloudformation-callback-ca.pem") } : {}),
      }),
    };
  }
  private async containsNativeBinary(directory: string): Promise<boolean> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name); if (entry.isDirectory()) { if (await this.containsNativeBinary(path)) return true; continue; } if (!entry.isFile()) continue;
      if (entry.name.endsWith(".node")) return true;
      const handle = await open(path, "r"); try { const bytes = Buffer.alloc(4); const { bytesRead } = await handle.read(bytes, 0, 4, 0); if (bytesRead === 4 && (bytes.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || bytes.equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])) || bytes.equals(Buffer.from([0xfe, 0xed, 0xfa, 0xcf])) || bytes.equals(Buffer.from([0xca, 0xfe, 0xba, 0xbe])))) return true; } finally { await handle.close(); }
    }
    return false;
  }
  private transition(fn: LambdaState, kind: "create" | "update"): void {
    let transition!: Promise<void>;
    transition = new Promise<void>((resolve, reject) => {
      queueMicrotask(() => {
        if (kind === "create") fn.state = "Active";
        fn.lastUpdateStatus = "Successful";
        delete fn.stateReason;
        delete fn.lastUpdateStatusReason;
        void this.store.save().then(resolve, reject);
      });
    });
    this.functionTransitions.add(transition);
    void transition.then(() => this.functionTransitions.delete(transition), () => this.functionTransitions.delete(transition));
  }
  private async runtimeCredentials(roleArn: string, lineage: string[]): Promise<Record<string, string>> {
    const role = Object.values(this.store.ensureAccount().iam.roles).find(item => item.arn === roleArn);
    if (!role) throw new AwsError("InvalidParameterValueException", `Lambda execution role ${roleArn} does not exist`, 400);
    if (evaluateTrust(role.assumeRolePolicyDocument, "lambda.amazonaws.com", "sts:AssumeRole", { "aws:PrincipalServiceName": "lambda.amazonaws.com" }).decision !== "allowed") throw new AwsError("InvalidParameterValueException", `Lambda execution role ${roleArn} no longer trusts lambda.amazonaws.com`, 400);
    return this.store.withCredentialMutation(this.store.accountId, async () => {
      let accessKeyId: string; do { accessKeyId = `ASIA${id(16).toUpperCase()}`.slice(0, 20); } while (Object.values(this.store.state.accounts).some(account => account.iam.sessions[accessKeyId] || account.iam.accessKeys[accessKeyId]));
      const secretAccessKey = `${id(40)}${id(40)}`.slice(0, 40); const sessionToken = id(64); const sessionName = `lambda-${id(12)}`; const arn = `arn:aws:sts::${this.store.accountId}:assumed-role/${role.roleName}/${sessionName}`;
      const principalId = `${role.roleId}:${sessionName}`;
      const credentialId = id(32);
      if (!this.store.credentialStore) throw new AwsError("InternalFailure", "The IAM credential store is unavailable", 500);
      await this.store.credentialStore.put({ credentialId, type: "sts-session", accountId: this.store.accountId, ownerId: principalId, accessKeyId }, { secretAccessKey, sessionToken });
      this.store.ensureAccount().iam.sessions[accessKeyId] = { accessKeyId, credentialId, principalArn: arn, principalId, roleArn: role.arn, roleName: role.roleName, sessionName, expiration: this.clock.now() + 3_600_000, sessionTags: {}, lambdaLineage: lineage };
      try {
        await this.store.save();
      } catch (error) {
        delete this.store.ensureAccount().iam.sessions[accessKeyId];
        await this.store.credentialStore.delete(credentialId).catch(() => undefined);
        throw error;
      }
      // Keep the SDK's standard environment provider refreshable inside a
      // warm process. The service-side session remains valid for an hour;
      // the short advertised provider expiration makes module-level SDK
      // clients re-read the invocation lease's rotated environment values.
      return { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_SESSION_TOKEN: sessionToken, AWS_CREDENTIAL_EXPIRATION: new Date(this.clock.now() + 1_000).toISOString() };
    });
  }
  assertResourcePermission(nameOrArn: string, principal: string, sourceArn?: string, sourceAccount?: string, qualifier?: string, always = false): void {
    const resolved = this.resolve(nameOrArn, qualifier); if (!always && this.authMode !== "enforce") return; const keys = [resolved.requestedQualifier ?? "", ""]; let allowed = false;
    for (const key of keys) for (const statement of resolved.fn.policies?.[key]?.statements ?? []) {
      if (statement.Action !== "lambda:InvokeFunction" && statement.Action !== "lambda:*") continue;
      const p = typeof statement.Principal === "string" ? statement.Principal : statement.Principal.Service ?? statement.Principal.AWS; if (p !== "*" && p !== principal) continue;
      if (statement.Resource !== resolved.qualifiedArn && statement.Resource !== resolved.fn.functionArn) continue; const conditions = statement.Condition ?? {};
      const arnLike = conditions.ArnLike?.["AWS:SourceArn"] ?? conditions.ArnLike?.["aws:SourceArn"]; if (arnLike && !new RegExp(`^${arnLike.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(sourceArn ?? "")) continue;
      const account = conditions.StringEquals?.["AWS:SourceAccount"] ?? conditions.StringEquals?.["aws:SourceAccount"]; if (account && account !== sourceAccount) continue; allowed = true;
    }
    if (!allowed) throw new AwsError("AccessDeniedException", "The caller is not authorized to invoke this Lambda function", 403);
  }
  async enqueueServiceInvocation(nameOrArn: string, payload: Buffer, principal: string, sourceArn: string, sourceAccount: string, lineage: string[] = [], stableEventId?: string): Promise<string> { this.assertResourcePermission(nameOrArn, principal, sourceArn, sourceAccount); return this.enqueueAsync(nameOrArn, undefined, payload, lineage, stableEventId); }
  assertFunctionExists(nameOrArn: string): void { this.resolveInvocation(nameOrArn); }
  assertSecretsManagerRotationFunction(nameOrArn: string, secretArn: string): void {
    const resolved = this.resolveInvocation(nameOrArn);
    if (resolved.executable.vpcConfig.subnetIds.length || resolved.executable.vpcConfig.securityGroupIds.length) throw new AwsError("InvalidParameterValueException", "VPC-hosted Lambda rotation functions are outside the local PSS-06 profile", 400);
    this.assertResourcePermission(nameOrArn, "secretsmanager.amazonaws.com", secretArn, this.store.accountId, undefined, true);
  }
  async invokeSecretsManagerRotation(nameOrArn: string, event: { Step: string; SecretId: string; ClientRequestToken: string }, requestId: string, lineage: string[]): Promise<InvokeResult> {
    this.assertSecretsManagerRotationFunction(nameOrArn, event.SecretId);
    const result = await this.invoke(nameOrArn, Buffer.from(JSON.stringify(event)), requestId, { principal: "secretsmanager.amazonaws.com", sourceArn: event.SecretId, sourceAccount: this.store.accountId, enforceResourcePolicy: true, lineage });
    if (result.interrupted) throw new AwsError("ServiceUnavailableException", "The simulator stopped during the Lambda rotation step", 503);
    if (result.functionError) {
      let summary = "The Lambda rotation function returned an error";
      try { const payload = JSON.parse(result.payload.toString("utf8")); summary = String(payload?.errorType ?? payload?.errorMessage ?? summary); } catch {}
      throw new AwsError("InternalServiceError", summary.slice(0, 512), 500);
    }
    return result;
  }
  setSqsService(service: LambdaSqsServicePort): void { this.sqsService = service; this.eventSources.setSqsService(service); this.durableExecutions.wakeDeadLetterDeliveries(); }
  setSnsService(service: LambdaSnsServicePort): void { this.snsService = service; this.eventSources.setSnsService(service); this.durableExecutions.wakeDeadLetterDeliveries(); }
  setEventBridgeService(service: EventBridgeService): void { this.eventBridgeService = service; }

  async enqueueEventBridgeInvocation(targetArn: string, payload: Buffer, ruleArn: string, roleArn?: string, lineage: string[] = []): Promise<string> {
    if (!roleArn) return this.enqueueServiceInvocation(targetArn, payload, "events.amazonaws.com", ruleArn, this.store.accountId, lineage);
    const resolved = this.resolveInvocation(targetArn);
    const context = roleSessionAuthorizationContext(roleArn, this.region, this.clock.now(), { "aws:SourceArn": ruleArn, "aws:SourceAccount": this.store.accountId });
    if (evaluateRoleAuthorization(this.store.ensureAccount().iam, roleArn, "lambda:InvokeFunction", resolved.qualifiedArn, context).decision !== "allowed") throw new AwsError("AccessDeniedException", `EventBridge target role ${roleArn} cannot invoke ${resolved.qualifiedArn}.`, 403);
    return this.enqueueAsync(targetArn, undefined, payload, lineage);
  }
  async enqueueSchedulerInvocation(targetArn: string, payload: Buffer, scheduleArn: string, roleArn: string, lineage: string[] = [], occurrenceId?: string): Promise<string> {
    const resolved = this.resolveInvocation(targetArn);
    const context = roleSessionAuthorizationContext(roleArn, this.region, this.clock.now(), { "aws:SourceArn": scheduleArn, "aws:SourceAccount": this.store.accountId });
    if (evaluateRoleAuthorization(this.store.ensureAccount().iam, roleArn, "lambda:InvokeFunction", resolved.qualifiedArn, context).decision !== "allowed") throw new AwsError("AccessDeniedException", `Scheduler execution role ${roleArn} cannot invoke ${resolved.qualifiedArn}.`, 403);
    return this.enqueueAsync(targetArn, undefined, payload, lineage, occurrenceId);
  }
  private sqsQueueExists(queueArn: string): boolean { try { return Boolean(this.sqsService?.resolveQueueArn(queueArn)); } catch { return false; } }
  findFunctionUrl(urlId: string): FunctionUrlTarget | undefined { return this.functionUrls.find(urlId); }
  isFunctionUrlPreflight(req: IncomingMessage): boolean { return this.functionUrls.isPreflight(req); }
  handleFunctionUrlPreflight(req: IncomingMessage, res: ServerResponse, target: FunctionUrlTarget): void { this.functionUrls.preflight(req, res, target); }
  async invokeFunctionUrl(req: IncomingMessage, res: ServerResponse, url: URL, target: FunctionUrlTarget, rawPath: string, requestId: string, principal?: PrincipalContext): Promise<void> { await this.functionUrls.invoke(req, res, url, target, rawPath, requestId, principal); }
  functionUrlResourcePolicy(principalArn: string, target: FunctionUrlTarget, action: "lambda:InvokeFunction" | "lambda:InvokeFunctionUrl", context: Record<string, unknown>): AuthorizationResult {
    const fn = this.require(target.functionName); const statements = [...(fn.policies?.[target.config.qualifier ?? ""]?.statements ?? []), ...(target.config.qualifier ? fn.policies?.[""]?.statements ?? [] : [])];
    return evaluateResourcePolicy({ Version: "2012-10-17", Statement: statements }, principalArn, action, target.functionArn, context);
  }
  private async publishFunctionUrlMetric(functionName: string, metricName: string, value = 1): Promise<void> { if (!this.telemetry) return; await this.telemetry.publish({ namespace: "AWS/Lambda", metricName, dimensions: { FunctionName: functionName }, value, unit: "Count", timestamp: this.clock.now() }); }
  private get asyncQueue(): Record<string, LambdaAsyncInvocationState> { return this.store.regionState(this.region).lambdaAsyncInvocations ??= {}; }
  private configKey(qualifier?: string | null): string { return qualifier ?? ""; }
  private configArn(fn: LambdaState, qualifier?: string): string { return qualifier ? `${fn.functionArn}:${qualifier}` : fn.functionArn; }
  private eventInvokeConfigView(fn: LambdaState, config: LambdaEventInvokeConfigState): any {
    const destinations: any = {}; if (config.destinationConfig?.onSuccess) destinations.OnSuccess = { Destination: config.destinationConfig.onSuccess }; if (config.destinationConfig?.onFailure) destinations.OnFailure = { Destination: config.destinationConfig.onFailure };
    return { FunctionArn: this.configArn(fn, config.qualifier), LastModified: config.lastModified / 1000, ...(config.maximumEventAgeInSeconds !== undefined ? { MaximumEventAgeInSeconds: config.maximumEventAgeInSeconds } : {}), ...(config.maximumRetryAttempts !== undefined ? { MaximumRetryAttempts: config.maximumRetryAttempts } : {}), ...(Object.keys(destinations).length ? { DestinationConfig: destinations } : {}) };
  }
  private validateDestination(destination: unknown, condition: "OnSuccess" | "OnFailure"): string | undefined {
    if (destination === undefined || destination === null || destination === "") return undefined; if (typeof destination !== "string") throw new AwsError("InvalidParameterValueException", `${condition} destination must be an ARN`);
    const lambda = destination.match(/^arn:(?:aws|aws-us-gov|aws-cn):lambda:([^:]+):(\d{12}):function:([A-Za-z0-9-_]{1,64})(?::([A-Za-z0-9-_$]+))?$/); if (lambda) { if (lambda[1] !== this.region || lambda[2] !== this.store.accountId) throw new AwsError("InvalidParameterValueException", "Lambda destinations must use this simulator account and Region"); this.resolve(destination); return destination; }
    const sqs = destination.match(/^arn:(?:aws|aws-us-gov|aws-cn):sqs:([^:]+):(\d{12}):([^:]+)$/);
    if (sqs) { if (sqs[1] !== this.region || sqs[2] !== this.store.accountId) throw new AwsError("InvalidParameterValueException", "SQS destinations must use this simulator account and Region"); if (!this.sqsService) throw new AwsError("InvalidParameterValueException", "The sqs destination dependency is not available in this simulator"); if (!this.sqsQueueExists(destination)) throw new AwsError("InvalidParameterValueException", `SQS destination queue does not exist: ${destination}`); return destination; }
    const events = destination.match(/^arn:(?:aws|aws-us-gov|aws-cn):events:([^:]+):(\d{12}):event-bus\/(.+)$/);
    if (events) { if (events[1] !== this.region || events[2] !== this.store.accountId) throw new AwsError("InvalidParameterValueException", "EventBridge destinations must use this simulator account and Region"); if (!this.eventBridgeService?.hasEventBusArn(destination)) throw new AwsError("InvalidParameterValueException", `EventBridge destination bus does not exist: ${destination}`); return destination; }
    const sns = destination.match(/^arn:(?:aws|aws-us-gov|aws-cn):sns:([^:]+):(\d{12}):([^:]+)$/);
    if (sns) {
      if (sns[1] !== this.region || sns[2] !== this.store.accountId) throw new AwsError("InvalidParameterValueException", "SNS destinations must use this simulator account and Region");
      if (!this.snsService) throw new AwsError("InvalidParameterValueException", "The SNS destination dependency is not available in this simulator");
      try { this.snsService.assertTopicExists(destination); } catch { throw new AwsError("InvalidParameterValueException", `SNS destination topic does not exist: ${destination}`); }
      return destination;
    }
    if (/^arn:(?:aws|aws-us-gov|aws-cn):s3:/.test(destination)) throw new AwsError("InvalidParameterValueException", "The s3 destination dependency is not available in this simulator");
    throw new AwsError("InvalidParameterValueException", `${condition} destination must be a Lambda, SQS, SNS, S3, or EventBridge ARN`);
  }
  private eventInvokeConfigInput(fn: LambdaState, qualifier: string | undefined, input: any, replace: boolean): LambdaEventInvokeConfigState {
    if (qualifier) this.resolve(fn.functionName, qualifier); const previous = fn.eventInvokeConfigs?.[this.configKey(qualifier)]; const age = input.MaximumEventAgeInSeconds === undefined ? replace ? undefined : previous?.maximumEventAgeInSeconds : input.MaximumEventAgeInSeconds; const retries = input.MaximumRetryAttempts === undefined ? replace ? undefined : previous?.maximumRetryAttempts : input.MaximumRetryAttempts;
    if (age !== undefined && (!Number.isInteger(age) || age < 60 || age > 21_600)) throw new AwsError("InvalidParameterValueException", "MaximumEventAgeInSeconds must be between 60 and 21600"); if (retries !== undefined && (!Number.isInteger(retries) || retries < 0 || retries > 2)) throw new AwsError("InvalidParameterValueException", "MaximumRetryAttempts must be between 0 and 2");
    const destinationInput = input.DestinationConfig; let onSuccess = replace ? undefined : previous?.destinationConfig?.onSuccess; let onFailure = replace ? undefined : previous?.destinationConfig?.onFailure;
    if (destinationInput !== undefined) { if (!destinationInput || typeof destinationInput !== "object" || Array.isArray(destinationInput)) throw new AwsError("InvalidParameterValueException", "DestinationConfig must be an object"); if (destinationInput.OnSuccess !== undefined) onSuccess = this.validateDestination(destinationInput.OnSuccess?.Destination, "OnSuccess"); if (destinationInput.OnFailure !== undefined) onFailure = this.validateDestination(destinationInput.OnFailure?.Destination, "OnFailure"); }
    if ((onSuccess || onFailure) && this.resolve(fn.functionName, qualifier).executable.durableConfig) throw new AwsError("InvalidParameterValueException", "Durable functions do not support Lambda invocation destinations");
    return { ...(qualifier ? { qualifier } : {}), ...(age !== undefined ? { maximumEventAgeInSeconds: age } : {}), ...(retries !== undefined ? { maximumRetryAttempts: retries } : {}), ...(onSuccess || onFailure ? { destinationConfig: { ...(onSuccess ? { onSuccess } : {}), ...(onFailure ? { onFailure } : {}) } } : {}), lastModified: this.clock.now() };
  }
  private async putEventInvokeConfig(nameOrArn: string, qualifier: string | undefined, input: any, replace: boolean): Promise<any> {
    const fn = this.require(nameOrArn); const config = this.eventInvokeConfigInput(fn, qualifier, input, replace); fn.eventInvokeConfigs![this.configKey(qualifier)] = config; await this.store.save(); return this.eventInvokeConfigView(fn, config);
  }
  private async enqueueAsync(nameOrArn: string, qualifier: string | undefined, payload: Buffer, lineage?: string[], stableEventId?: string): Promise<string> {
    const resolved = this.resolveInvocation(nameOrArn, qualifier); if ((resolved.fn.state ?? "Active") !== "Active" || (resolved.fn.lastUpdateStatus ?? "Successful") === "InProgress") throw new AwsError("ResourceConflictException", "The function is currently in a non-invokable state", 409); let parsed: unknown; try { parsed = payload.length ? JSON.parse(payload.toString("utf8")) : null; } catch { throw new AwsError("InvalidRequestContentException", "Could not parse request body into JSON", 400); } void parsed;
    const eventId = stableEventId ?? id(32); const payloadBase64 = payload.toString("base64"); const existing = this.asyncQueue[eventId];
    if (existing) { if (existing.functionName === resolved.fn.functionName && existing.qualifier === resolved.requestedQualifier && existing.payloadBase64 === payloadBase64) return eventId; throw new AwsError("ResourceConflictException", `Async invocation identity ${eventId} is already owned by different content`, 409); }
    const now = this.clock.now(); this.asyncQueue[eventId] = { eventId, functionName: resolved.fn.functionName, ...(resolved.requestedQualifier ? { qualifier: resolved.requestedQualifier } : {}), payloadBase64, enqueuedAt: now, nextAttemptAt: now, attempts: 0, status: "QUEUED", ...(lineage?.length ? { lineage: [...lineage] } : {}) }; await this.store.save(); await this.publishAsyncMetric("AsyncEventsReceived", resolved.fn.functionName); await this.publishQueueDepth(resolved.fn.functionName); this.scheduleAsyncWorker(0); return eventId;
  }
  private scheduleAsyncWorker(delayMs: number): void {
    if (this.stopped || this.asyncWorkerRunning || this.asyncWorkerCancel) return; const callback = () => { this.asyncWorkerCancel = undefined; this.asyncWorker = this.runAsyncWorker(); };
    if (this.scheduler) this.asyncWorkerCancel = this.scheduler.schedule(callback, Math.max(0, delayMs)); else { const handle = this.clock.setTimeout(callback, Math.max(0, delayMs)); this.asyncWorkerCancel = () => this.clock.clearTimeout(handle); }
  }
  private scheduleNextAsyncWorker(): void {
    if (this.stopped || this.asyncWorkerCancel || this.asyncWorkerRunning) return; const now = this.clock.now(); const times = Object.values(this.asyncQueue).map(event => event.status === "LEASED" ? event.leaseUntil ?? now : event.nextAttemptAt); if (!times.length) return; this.scheduleAsyncWorker(Math.max(0, Math.min(...times) - now));
  }
  private async runAsyncWorker(): Promise<void> {
    if (this.stopped || this.asyncWorkerRunning) return; this.asyncWorkerRunning = true;
    try {
      const now = this.clock.now(); for (const event of Object.values(this.asyncQueue)) if (event.status === "LEASED" && (event.leaseUntil ?? 0) <= now) { event.status = "QUEUED"; delete event.leaseId; delete event.leaseUntil; }
      const event = Object.values(this.asyncQueue).filter(item => item.status === "QUEUED" && item.nextAttemptAt <= now).sort((left, right) => left.nextAttemptAt - right.nextAttemptAt || left.enqueuedAt - right.enqueuedAt || left.eventId.localeCompare(right.eventId))[0]; if (!event) return;
      event.status = "LEASED"; event.leaseId = id(24); event.leaseUntil = now + 30_000; await this.store.save(); await this.processAsyncEvent(event);
    } finally { this.asyncWorkerRunning = false; this.scheduleNextAsyncWorker(); }
  }
  private eventConfigFor(event: LambdaAsyncInvocationState): LambdaEventInvokeConfigState | undefined { return this.store.regionState(this.region).functions[event.functionName]?.eventInvokeConfigs?.[this.configKey(event.qualifier)]; }
  private async processAsyncEvent(event: LambdaAsyncInvocationState): Promise<void> {
    const config = this.eventConfigFor(event); const maxAgeMs = (config?.maximumEventAgeInSeconds ?? 21_600) * 1000; const age = this.clock.now() - event.enqueuedAt; if (age >= maxAgeMs) { await this.finishAsyncEvent(event, "EventAgeExceeded"); return; }
    event.attempts++; event.lastAttemptAt = this.clock.now(); await this.publishAsyncMetric("AsyncEventAge", event.functionName, age, "Milliseconds");
    try {
      const result = await this.invoke(event.functionName, Buffer.from(event.payloadBase64, "base64"), event.eventId, { qualifier: event.qualifier, lineage: event.lineage }); if (!result.functionError) { await this.finishAsyncEvent(event, "Success", result); return; }
      event.lastError = Buffer.from(result.payload).toString("utf8"); if (event.attempts <= (config?.maximumRetryAttempts ?? 2) && this.clock.now() - event.enqueuedAt < maxAgeMs) { await this.retryAsyncEvent(event, event.attempts === 1 ? 60_000 : 120_000); return; } await this.finishAsyncEvent(event, "RetriesExhausted", result);
    } catch (error) {
      event.lastError = error instanceof Error ? error.message : String(error); const retryable = error instanceof AwsError && (error.status >= 500 || error.status === 429 || error.code === "ResourceConflictException"); if (retryable && this.clock.now() - event.enqueuedAt < maxAgeMs) { await this.retryAsyncEvent(event, Math.min(300_000, 1000 * 2 ** Math.min(8, event.attempts - 1))); return; } await this.finishAsyncEvent(event, "RetriesExhausted", undefined, error);
    }
  }
  private async retryAsyncEvent(event: LambdaAsyncInvocationState, delayMs: number): Promise<void> { event.nextAttemptAt = this.clock.now() + delayMs; delete event.leaseId; delete event.leaseUntil; await this.publishAsyncMetric("AsyncEventsRetried", event.functionName); await this.publishQueueDepth(event.functionName); event.status = "QUEUED"; await this.store.save(); }
  private async finishAsyncEvent(event: LambdaAsyncInvocationState, condition: "Success" | "RetriesExhausted" | "EventAgeExceeded", result?: InvokeResult, error?: unknown): Promise<void> {
    const config = this.eventConfigFor(event); const destination = condition === "Success" ? config?.destinationConfig?.onSuccess : config?.destinationConfig?.onFailure; if (destination) await this.deliverAsyncDestination(event, destination, condition, result, error);
    if (condition !== "Success") { let deadLetterTarget: string | undefined; try { deadLetterTarget = this.resolveInvocation(event.functionName, event.qualifier).executable.deadLetterTargetArn; } catch { /* Function deletion does not retain an executable delivery target. */ } if (deadLetterTarget) await this.deliverAsyncDeadLetter(event, deadLetterTarget, result, error); }
    delete this.asyncQueue[event.eventId]; await this.publishAsyncMetric(condition === "Success" ? "AsyncEventsSucceeded" : "AsyncEventsDropped", event.functionName); await this.store.save(); await this.publishQueueDepth(event.functionName);
  }
  private async sendSqsUsingRole(destination: string, input: { MessageBody: string; MessageAttributes?: Record<string, LambdaSqsMessageAttributeValue> }, role: string | undefined, sourceArn?: string, deliveryLineage?: string[]): Promise<void> {
    if (!this.sqsService || !this.sqsService.resolveQueueArn(destination)) throw new AwsError("ResourceNotFoundException", `SQS destination queue does not exist: ${destination}`, 404);
    if (!role) throw new AwsError("AccessDeniedException", `No execution role is available to send to ${destination}`, 403);
    if (this.sqsService.sendAuthorizedMessageToArn) {
      await this.sqsService.sendAuthorizedMessageToArn(destination, input, { kind: "role", roleArn: role, sourceArn, sourceAccount: this.store.accountId, deliveryLineage: deliveryLineage?.slice(-32) });
      return;
    }
    if (this.authMode === "enforce" && evaluateRoleAuthorization(this.store.ensureAccount().iam, role, "sqs:SendMessage", destination).decision !== "allowed") throw new AwsError("AccessDeniedException", `Execution role ${role} cannot send to ${destination}`, 403);
    await this.sqsService.sendMessageToArn(destination, input);
  }
  private async deliverAsyncDestination(event: LambdaAsyncInvocationState, destination: string, condition: "Success" | "RetriesExhausted" | "EventAgeExceeded", result?: InvokeResult, error?: unknown): Promise<void> {
    let requestPayload: unknown = null; try { requestPayload = JSON.parse(Buffer.from(event.payloadBase64, "base64").toString("utf8")); } catch {} let responsePayload: unknown = null; if (result) try { responsePayload = JSON.parse(result.payload.toString("utf8")); } catch { responsePayload = result.payload.toString("utf8"); } else if (error) responsePayload = { errorMessage: error instanceof Error ? error.message : String(error) };
    const source = this.store.regionState(this.region).functions[event.functionName]; let resolved: ResolvedFunction | undefined; try { resolved = this.resolveInvocation(event.functionName, event.qualifier); } catch { /* Delivery records remain useful after a target qualifier disappears. */ } const role = resolved?.executable.role ?? source?.role; const record = { version: "1.0", timestamp: new Date(this.clock.now()).toISOString(), requestContext: { requestId: event.eventId, functionArn: source ? `${source.functionArn}:${event.qualifier ?? "$LATEST"}` : `arn:aws:lambda:${this.region}:${this.store.accountId}:function:${event.functionName}:${event.qualifier ?? "$LATEST"}`, condition, approximateInvokeCount: event.attempts }, requestPayload, responseContext: { statusCode: result?.statusCode ?? (error instanceof AwsError ? error.status : 200), executedVersion: result?.executedVersion ?? event.qualifier ?? "$LATEST", ...(result?.functionError ? { functionError: result.functionError } : {}) }, responsePayload };
    try {
      if (destination.includes(":sqs:")) {
        const functionArn = source ? `${source.functionArn}:${event.qualifier ?? "$LATEST"}` : `arn:aws:lambda:${this.region}:${this.store.accountId}:function:${event.functionName}:${event.qualifier ?? "$LATEST"}`;
        await this.sendSqsUsingRole(destination, { MessageBody: JSON.stringify(record) }, role, functionArn, [...(event.lineage ?? []), functionArn, destination]);
      } else if (destination.includes(":sns:")) {
        if (!this.snsService) throw new AwsError("ResourceNotFoundException", "The SNS destination service is unavailable.", 404);
        const functionArn = source ? `${source.functionArn}:${event.qualifier ?? "$LATEST"}` : `arn:aws:lambda:${this.region}:${this.store.accountId}:function:${event.functionName}:${event.qualifier ?? "$LATEST"}`;
        if (!role) throw new AwsError("AccessDeniedException", `No execution role is available to publish to ${destination}`, 403);
        const authorized = this.authMode !== "enforce" || evaluateRoleAuthorization(this.store.ensureAccount().iam, role, "sns:Publish", destination).decision === "allowed";
        if (!authorized) throw new AwsError("AccessDeniedException", `Execution role ${role} cannot publish to ${destination}`, 403);
        await this.snsService.publishAuthorized({ TopicArn: destination, Message: JSON.stringify(record) }, {
          principal: role,
          sourceArn: functionArn,
          sourceAccount: this.store.accountId,
          identityAuthorized: true,
          lineage: [...(event.lineage ?? []), functionArn].slice(-32),
        });
      } else if (destination.includes(":events:")) {
        if (!this.eventBridgeService) throw new AwsError("ResourceNotFoundException", "The EventBridge destination service is unavailable.", 404);
        const functionArn = source ? `${source.functionArn}:${event.qualifier ?? "$LATEST"}` : `arn:aws:lambda:${this.region}:${this.store.accountId}:function:${event.functionName}:${event.qualifier ?? "$LATEST"}`;
        await this.eventBridgeService.publishServiceEvent({ source: "lambda", detailType: condition === "Success" ? "Lambda Function Invocation Result - Success" : "Lambda Function Invocation Result - Failure", detail: record, resources: [functionArn, destination], eventBusName: destination, roleArn: role, requireRole: true, deliveryLineage: [...(event.lineage ?? []), functionArn, destination].slice(-32) });
      } else {
        if (this.authMode === "enforce" && role && evaluateRoleAuthorization(this.store.ensureAccount().iam, role, "lambda:InvokeFunction", destination).decision !== "allowed") throw new AwsError("AccessDeniedException", `Execution role ${role} cannot invoke destination ${destination}`, 403);
        const lineage = source ? [...(event.lineage ?? []), `${source.functionArn}:${event.qualifier ?? "$LATEST"}`] : event.lineage; await this.invoke(destination, Buffer.from(JSON.stringify(record)), id(24), { lineage });
      }
    } catch { await this.publishAsyncMetric("DestinationDeliveryFailures", event.functionName); }
  }
  private async deliverAsyncDeadLetter(event: LambdaAsyncInvocationState, destination: string, result?: InvokeResult, error?: unknown): Promise<void> {
    let resolved: ResolvedFunction | undefined; try { resolved = this.resolveInvocation(event.functionName, event.qualifier); } catch { /* A deleted function cannot authorize a new delivery. */ }
    const role = resolved?.executable.role ?? this.store.regionState(this.region).functions[event.functionName]?.role;
    const errorCode = String(result?.statusCode ?? (error instanceof AwsError ? error.status : 200));
    const errorMessage = String(event.lastError ?? (error instanceof Error ? error.message : error ?? result?.functionError ?? "Lambda asynchronous invocation failed")).slice(0, 10_240);
    const messageAttributes: Record<string, LambdaSqsMessageAttributeValue> = {
      RequestID: { DataType: "String", StringValue: event.eventId },
      ErrorCode: { DataType: "Number", StringValue: errorCode },
      ErrorMessage: { DataType: "String", StringValue: errorMessage },
    };
    try {
      const functionArn = resolved?.qualifiedArn ?? this.store.regionState(this.region).functions[event.functionName]?.functionArn;
      if (destination.includes(":sns:")) {
        if (!this.snsService || !role || !functionArn) throw new AwsError("ResourceNotFoundException", "The SNS dead-letter destination is unavailable", 404);
        const authorized = this.authMode !== "enforce" || evaluateRoleAuthorization(this.store.ensureAccount().iam, role, "sns:Publish", destination).decision === "allowed";
        if (!authorized) throw new AwsError("AccessDeniedException", `Execution role ${role} cannot publish to ${destination}`, 403);
        await this.snsService.publishAuthorized({
          TopicArn: destination,
          Message: Buffer.from(event.payloadBase64, "base64").toString("utf8"),
          MessageAttributes: messageAttributes,
        }, { principal: role, sourceArn: functionArn, sourceAccount: this.store.accountId, identityAuthorized: true, lineage: [...(event.lineage ?? []), functionArn] });
      } else if (destination.includes(":sqs:")) {
        await this.sendSqsUsingRole(destination, { MessageBody: Buffer.from(event.payloadBase64, "base64").toString("utf8"), MessageAttributes: messageAttributes }, role, functionArn, [...(event.lineage ?? []), ...(functionArn ? [functionArn] : []), destination]);
      } else throw new AwsError("InvalidParameterValueException", "Dead-letter destinations must be SQS or SNS");
    } catch { await this.publishAsyncMetric("DestinationDeliveryFailures", event.functionName); }
  }
  private async deliverDurableDeadLetter(execution: LambdaDurableExecutionState): Promise<void> {
    const destination = execution.deadLetterDelivery?.targetArn ?? execution.executable.deadLetterTargetArn;
    if (!destination) throw new AwsError("InvalidParameterValueException", "A durable dead-letter destination is required");
    const messageAttributes: Record<string, LambdaSqsMessageAttributeValue> = {
      RequestID: { DataType: "String", StringValue: execution.invocationId },
      ErrorCode: { DataType: "String", StringValue: execution.error?.ErrorType ?? execution.status },
      ErrorMessage: { DataType: "String", StringValue: String(execution.error?.ErrorMessage ?? `Durable execution ${execution.status.toLowerCase()}`).slice(0, 10_240) },
    };
    try {
      if (destination.includes(":sns:")) {
        if (!this.snsService) throw new AwsError("ResourceNotFoundException", "The SNS durable dead-letter destination is unavailable", 404);
        const authorized = this.authMode !== "enforce" || evaluateRoleAuthorization(this.store.ensureAccount().iam, execution.executable.role, "sns:Publish", destination).decision === "allowed";
        if (!authorized) throw new AwsError("AccessDeniedException", `Execution role ${execution.executable.role} cannot publish to ${destination}`, 403);
        await this.snsService.publishAuthorized({ TopicArn: destination, Message: execution.inputPayload, MessageAttributes: messageAttributes }, { principal: execution.executable.role, sourceArn: execution.functionArn, sourceAccount: this.store.accountId, identityAuthorized: true, lineage: [...(execution.lineage ?? []), execution.functionArn] });
      } else if (destination.includes(":sqs:")) {
        await this.sendSqsUsingRole(destination, { MessageBody: execution.inputPayload, MessageAttributes: messageAttributes }, execution.executable.role, execution.functionArn, [...(execution.lineage ?? []), execution.functionArn, destination]);
      } else throw new AwsError("InvalidParameterValueException", "Dead-letter destinations must be SQS or SNS");
    } catch (error) { await this.publishAsyncMetric("DestinationDeliveryFailures", execution.functionName); throw error; }
  }
  private async publishAsyncMetric(metricName: string, functionName: string, value = 1, unit = "Count"): Promise<void> { if (!this.telemetry) return; await this.telemetry.publish({ namespace: "AWS/Lambda", metricName, dimensions: { FunctionName: functionName }, value, unit, timestamp: this.clock.now() }).catch(() => undefined); }
  private async publishQueueDepth(functionName: string): Promise<void> { await this.publishAsyncMetric("AsyncEventsQueued", functionName, Object.values(this.asyncQueue).filter(event => event.functionName === functionName).length); }
  private provisionedKey(functionName: string, qualifier: string): string { return `${functionName}:${qualifier}`; }
  private provisionedView(fn: LambdaState, config: LambdaProvisionedConcurrencyConfigState, includeArn = false): any {
    return { ...(includeArn ? { FunctionArn: `${fn.functionArn}:${config.qualifier}` } : {}), RequestedProvisionedConcurrentExecutions: config.requestedProvisionedConcurrentExecutions, AvailableProvisionedConcurrentExecutions: config.status === "READY" ? config.allocatedProvisionedConcurrentExecutions : 0, AllocatedProvisionedConcurrentExecutions: config.allocatedProvisionedConcurrentExecutions, Status: config.status, ...(config.statusReason ? { StatusReason: config.statusReason } : {}), LastModified: config.lastModified };
  }
  private async completeProvisioned(fn: LambdaState, config: LambdaProvisionedConcurrencyConfigState): Promise<void> {
    const key = this.provisionedKey(fn.functionName, config.qualifier);
    if (fn.provisionedConcurrencyConfigs?.[config.qualifier] !== config) return;
    try {
      const specs: LambdaWorkerSpec[] = [];
      for (let index = 0; index < config.requestedProvisionedConcurrentExecutions; index++) {
        const resolved = this.resolve(fn.functionName, config.qualifier);
        if (resolved.executable.packageType === "Image") throw new Error("Provisioned concurrency is unavailable for image functions until reusable Docker containers are implemented");
        if (!/^nodejs(?:18|20|22|24)\.x$/.test(resolved.executable.runtime)) throw new Error(`Provisioned concurrency is unavailable for runtime ${resolved.executable.runtime}`);
        const credentials = await this.runtimeCredentials(resolved.executable.role, [resolved.qualifiedArn]);
        specs.push(this.workerSpec(resolved, {}, credentials, "provisioned-concurrency", key));
      }
      await this.workerPool.reconcileProvisioned(key, specs);
      if (fn.provisionedConcurrencyConfigs?.[config.qualifier] !== config) { await this.workerPool.retireProvisioned(key); return; }
      config.allocatedProvisionedConcurrentExecutions = specs.length; config.status = "READY"; delete config.statusReason;
    } catch (error) {
      await this.workerPool.retireProvisioned(key); config.allocatedProvisionedConcurrentExecutions = 0; config.status = "FAILED"; config.statusReason = error instanceof Error ? error.message : String(error);
    }
    await this.store.save();
  }
  private scheduleProvisionedReady(fn: LambdaState, config: LambdaProvisionedConcurrencyConfigState, delayMs = 50): void {
    const key = this.provisionedKey(fn.functionName, config.qualifier); this.provisionedTransitions.get(key)?.();
    const complete = async () => {
      this.provisionedTransitions.delete(key); if (fn.provisionedConcurrencyConfigs?.[config.qualifier] !== config) return;
      await this.completeProvisioned(fn, config);
    };
    if (this.scheduler) this.provisionedTransitions.set(key, this.scheduler.schedule(complete, delayMs));
    else { const handle = this.clock.setTimeout(() => { void complete(); }, delayMs); this.provisionedTransitions.set(key, () => this.clock.clearTimeout(handle)); }
  }
  private validateProvisionedQualifier(fn: LambdaState, qualifier: string | undefined): string {
    if (!qualifier || qualifier === "$LATEST") throw new AwsError("InvalidParameterValueException", "Qualifier must be a published version or alias"); this.resolve(fn.functionName, qualifier); return qualifier;
  }
  async start(): Promise<void> {
    this.stopped = false; this.capacityProviders.start(); this.durableExecutions.start(); let recovered = false;
    for (const event of Object.values(this.asyncQueue)) if (event.status === "LEASED") { event.status = "QUEUED"; event.nextAttemptAt = Math.min(event.nextAttemptAt, this.clock.now()); delete event.leaseId; delete event.leaseUntil; recovered = true; }
    const provisionedStartup: Promise<void>[] = [];
    for (const fn of Object.values(this.store.regionState(this.region).functions)) for (const config of Object.values(fn.provisionedConcurrencyConfigs ?? {})) { config.allocatedProvisionedConcurrentExecutions = 0; config.status = "IN_PROGRESS"; delete config.statusReason; recovered = true; provisionedStartup.push(this.completeProvisioned(fn, config)); }
    if (recovered) await this.store.save(); await Promise.all(provisionedStartup); this.scheduleNextAsyncWorker(); this.eventSources.start();
  }
  /** Marks active invocations replayable before network listeners begin draining. */
  beginShutdown(): void { this.stopped = true; }
  async invoke(nameOrArn: string, payload: Buffer, requestId = id(24), options: InvokeOptions = {}): Promise<InvokeResult> { const resolved = options.resolvedOverride ?? this.resolveInvocation(nameOrArn, options.qualifier); const result = resolved.executable.durableConfig && !options.durableReplay ? await this.invokeDurable(resolved, payload, requestId, options, "RequestResponse") : await this.invokeRuntime(nameOrArn, payload, requestId, { ...options, resolvedOverride: resolved }); if (options.integrationAttemptAcceptance && !result.interrupted) await options.integrationAttemptAcceptance(result); return result; }
  /** CFN-14 invokes a normal local ZIP runtime with an invocation-local public callback CA. */
  async invokeCloudFormationCustomResource(nameOrArn: string, payload: Buffer, requestId: string, caCertificatePath: string, callbackPort: number, timeoutMs: number, callbackCompleted?: Promise<void>): Promise<InvokeResult> {
    const resolved = this.resolveInvocation(nameOrArn);
    if (resolved.fn.packageType !== "Zip") throw new AwsError("InvalidParameterValueException", "CloudFormation custom-resource service tokens require a local ZIP-backed Lambda function", 400);
    const endpoint = new URL(this.controlEndpoint());
    if (endpoint.protocol !== "http:" || !new Set(["localhost", "127.0.0.1", "[::1]"]).has(endpoint.hostname) || !endpoint.port) throw new AwsError("InvalidEndpoint", "CloudFormation custom-resource provider endpoints must use the local simulator HTTP listener", 400);
    const sensitiveLogValues: string[] = [];
    try {
      const event = JSON.parse(payload.toString("utf8"));
      sensitiveLogValues.push(...cloudFormationCallbackSensitiveLogValues(event));
    } catch { /* invokeRuntime reports malformed request payloads. */ }
    try {
      // An IP-literal endpoint makes the unmodified S3 SDK select path-style
      // addressing, keeping every helper call on the pinned loopback origin.
      const secureServiceEndpoint = `https://127.0.0.1:${callbackPort}`;
      const result = await this.invokeRuntime(nameOrArn, payload, requestId, { resolvedOverride: resolved, timeoutOverrideMs: timeoutMs, terminateOnCompletion: callbackCompleted, sanitizeEnvironment: true, trustedCaCertificatePath: caCertificatePath, sensitiveLogValues, environmentOverrides: { AWS_ENDPOINT_URL: secureServiceEndpoint, AWS_ENDPOINT_URL_LAMBDA: secureServiceEndpoint, STACKSIM_ENDPOINT: secureServiceEndpoint, STACKSIM_CLOUDFORMATION_CALLBACK_PORT: String(callbackPort), STACKSIM_CLOUDFORMATION_NETWORK_PORTS: `${endpoint.port},${callbackPort}` } });
      if (!this.stopped) return result;
      const { functionError: _functionError, ...replayable } = result;
      return { ...replayable, payload: Buffer.from("null"), interrupted: true };
    } catch (error) {
      if (!this.stopped) throw error;
      return { payload: Buffer.from("null"), statusCode: 200, requestId, durationMs: 0, billedDurationMs: 1, executedVersion: resolved.executedVersion, interrupted: true };
    }
  }
  private async invokeEventSource(nameOrArn: string, qualifier: string | undefined, payload: Buffer, requestId: string, lineage?: string[]): Promise<InvokeResult> {
    const resolved = this.resolveInvocation(nameOrArn, qualifier); const bounded = lineage?.slice(-32);
    try {
      const result = resolved.executable.durableConfig ? await this.invokeDurable(resolved, payload, requestId, { qualifier, lineage: bounded }, "Event") : await this.invokeRuntime(nameOrArn, payload, requestId, { qualifier, lineage: bounded, resolvedOverride: resolved });
      if (!this.stopped || result.interrupted) return result;
      const { functionError: _functionError, ...replayable } = result; return { ...replayable, payload: Buffer.from("null"), interrupted: true };
    } catch (error) {
      if (!this.stopped) throw error;
      return { payload: Buffer.from("null"), statusCode: 200, requestId, durationMs: 0, billedDurationMs: 1, executedVersion: resolved.executedVersion, interrupted: true };
    }
  }
  async invokeStreaming(nameOrArn: string, payload: Buffer, requestId = id(24), options: InvokeOptions = {}, callbacks: LambdaStreamCallbacks): Promise<InvokeResult> { const resolved = this.resolveInvocation(nameOrArn, options.qualifier); if (resolved.executable.durableConfig) throw new AwsError("InvalidParameterValueException", "InvokeWithResponseStream is not supported for durable functions"); return this.invokeRuntime(nameOrArn, payload, requestId, { ...options, resolvedOverride: resolved }, callbacks); }
  private async invokeZipWorkerRuntime(resolved: ResolvedFunction, event: unknown, requestId: string, options: InvokeOptions, streamCallbacks?: LambdaStreamCallbacks): Promise<InvokeResult> {
    const { fn, executable } = resolved;
    const lease = await this.concurrency.acquire({ functionName: fn.functionName, requestedQualifier: resolved.requestedQualifier });
    const effectiveTimeoutMs = Math.max(1, Math.min(executable.timeout * 1000, options.timeoutOverrideMs ?? Number.POSITIVE_INFINITY));
    let credentials: Record<string, string>;
    try { credentials = await this.runtimeCredentials(executable.role, [...(options.lineage ?? []), resolved.qualifiedArn]); }
    catch (error) { await lease.release(); throw error; }
    const provisionedFor = lease.provisioned && resolved.requestedQualifier ? this.provisionedKey(fn.functionName, resolved.requestedQualifier) : undefined;
    const spec = this.workerSpec(resolved, options, credentials, lease.initializationType, provisionedFor);
    let worker: Awaited<ReturnType<LambdaWorkerPool["lease"]>> | undefined;
    try {
      worker = await this.workerPool.lease(spec);
      if (this.stopped) throw new Error("Lambda invocation was interrupted by simulator shutdown");
      const context = { awsRequestId: requestId, functionName: fn.functionName, functionVersion: resolved.executedVersion, invokedFunctionArn: resolved.qualifiedArn, memoryLimitInMB: String(executable.memorySize), logGroupName: executable.loggingConfig.logGroup, logStreamName: worker.spec.logStreamName, callbackWaitsForEmptyEventLoop: false, clientContext: options.clientContext, identity: undefined, __timeoutMs: effectiveTimeoutMs };
      await streamCallbacks?.onStart?.({ requestId, executedVersion: resolved.executedVersion });
      if (options.durableExecutionArn) this.activeDurableChildren.set(options.durableExecutionArn, () => { void worker?.terminate(); });
      const result = await worker.invoke({
        invocationId: requestId, event, context, timeoutMs: effectiveTimeoutMs, streaming: Boolean(streamCallbacks), terminateOnCompletion: options.terminateOnCompletion,
        environment: { ...credentials, ...options.environmentOverrides, ...(options.traceHeader ? { _X_AMZN_TRACE_ID: options.traceHeader } : {}) },
        onMetadata: async metadata => { validateStreamingResponseMetadata(metadata); await streamCallbacks?.onMetadata?.(metadata); },
        onChunk: chunk => streamCallbacks?.onChunk(chunk),
      });
      const durationMs = result.durationMs; const billedDurationMs = Math.max(1, Math.ceil(durationMs));
      const redact = (message: string) => [...new Set(options.sensitiveLogValues ?? [])].filter(Boolean).sort((left, right) => right.length - left.length).reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), message);
      const applicationLines = result.applicationLogs.map(entry => ({ ...entry, message: redact(entry.message) }));
      const logLines = this.formatLogLines(executable, fn.functionName, requestId, resolved.executedVersion, durationMs, billedDurationMs, applicationLines, options.serviceLogContext);
      await this.writeLogs(fn, executable.role, executable.loggingConfig.logGroup, worker.spec.logStreamName, logLines, [...(options.lineage ?? []), resolved.qualifiedArn]);
      const logBytes = Buffer.from(logLines.join("\n") + "\n");
      const common = { statusCode: 200, logResult: logBytes.subarray(Math.max(0, logBytes.length - 4096)).toString("base64"), requestId, durationMs, billedDurationMs, executedVersion: resolved.executedVersion };
      const interrupted = this.stopped;
      const invocation: InvokeResult = result.callbackTerminated || interrupted
        ? { ...common, payload: Buffer.from("null"), ...(interrupted ? { interrupted: true } : {}) }
        : result.ok
          ? { ...common, payload: Buffer.from(JSON.stringify(result.result ?? null)) }
          : { ...common, payload: Buffer.from(JSON.stringify(result.error ?? { errorMessage: "Lambda runtime failed", errorType: "Runtime.ExitError" })), functionError: "Unhandled" };
      if (this.telemetry) {
        const metricTime = this.clock.now(); const dimensions = { FunctionName: fn.functionName };
        await Promise.all([this.telemetry.publish({ namespace: "AWS/Lambda", metricName: "Invocations", dimensions, value: 1, unit: "Count", timestamp: metricTime }), this.telemetry.publish({ namespace: "AWS/Lambda", metricName: "Duration", dimensions, value: invocation.durationMs, unit: "Milliseconds", timestamp: metricTime }), ...(invocation.functionError ? [this.telemetry.publish({ namespace: "AWS/Lambda", metricName: "Errors", dimensions, value: 1, unit: "Count", timestamp: metricTime })] : [])]).catch(() => undefined);
      }
      this.workerPool.release(worker, !result.timedOut && !result.callbackTerminated && !worker.dead && !interrupted);
      worker = undefined;
      return invocation;
    } catch (error) {
      if (worker) this.workerPool.release(worker, false);
      throw error;
    } finally {
      if (options.durableExecutionArn) this.activeDurableChildren.delete(options.durableExecutionArn);
      await lease.release();
    }
  }
  private async invokeRuntime(nameOrArn: string, payload: Buffer, requestId: string, options: InvokeOptions, streamCallbacks?: LambdaStreamCallbacks): Promise<InvokeResult> {
    const resolved = options.resolvedOverride ?? this.resolveInvocation(nameOrArn, options.qualifier); const { fn, executable } = resolved; if (options.enforceResourcePolicy && options.principal) this.assertResourcePermission(nameOrArn, options.principal, options.sourceArn, options.sourceAccount, options.qualifier);
    if (fn.recursiveLoop === "Terminate" && (options.lineage?.length ?? 0) >= 16) { await this.publishAsyncMetric("RecursiveInvocationsDropped", fn.functionName); throw new AwsError("RecursiveInvocationException", "Lambda stopped this invocation because the recursive invocation lineage reached 16", 400); }
    if ((fn.state ?? "Active") !== "Active" || (fn.lastUpdateStatus ?? "Successful") === "InProgress") throw new AwsError("ResourceConflictException", "The function is currently in a non-invokable state", 409); if (payload.length > 6 * 1024 * 1024) throw new AwsError("RequestTooLargeException", "Request payload size exceeded the synchronous invocation limit", 413);
    let event: unknown = null; if (payload.length) { try { event = JSON.parse(payload.toString("utf8")); } catch { throw new AwsError("InvalidRequestContentException", "Could not parse request body into JSON", 400); } }
    const inheritedCallbackSecrets = cloudFormationCallbackSensitiveLogValues(event);
    if (inheritedCallbackSecrets.length) options = { ...options, sensitiveLogValues: [...(options.sensitiveLogValues ?? []), ...inheritedCallbackSecrets] };
    if (executable.packageType === "Image") return this.invokeImageRuntime(resolved, payload, requestId, options, streamCallbacks);
    if (!/^nodejs(?:18|20|22|24)\.x$/.test(executable.runtime)) throw new AwsError("InvalidRuntimeException", "python3.13 execution is available only through the bounded native Custom::CDKBucketDeployment lifecycle adapter", 502);
    const hostArchitecture = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "arm64" : undefined; if (executable.architectures[0] !== hostArchitecture && (await this.containsNativeBinary(executable.codeDir) || (await Promise.all((executable.layers ?? []).map(layer => this.containsNativeBinary(layer.codeDir)))).some(Boolean))) throw new AwsError("InvalidRuntimeException", `Function contains native binaries for ${executable.architectures[0]}, but the simulator host architecture is ${hostArchitecture ?? process.arch}`, 502);
    return this.invokeZipWorkerRuntime(resolved, event, requestId, options, streamCallbacks);
  }
  private async invokeImageRuntime(resolved: ResolvedFunction, payload: Buffer, requestId: string, options: InvokeOptions, streamCallbacks?: LambdaStreamCallbacks): Promise<InvokeResult> {
    const { fn, executable } = resolved; if (streamCallbacks) throw new AwsError("InvalidRuntimeException", "Container image response streaming is not available through the local Docker Runtime API adapter", 502);
    if (executable.imageSource !== "docker" || !process.env.STACKSIM_LAMBDA_DOCKER_SOCKET) throw new AwsError("InvalidRuntimeException", `Container image ${executable.resolvedImageUri ?? executable.imageUri ?? ""} is resolved and pinned, but invocation requires the exact configured Docker socket; OCI root filesystems are never host-executed`, 502);
    const lease = await this.concurrency.acquire({ functionName: fn.functionName, requestedQualifier: resolved.requestedQualifier }); const streamDate = new Date(this.clock.now()).toISOString().slice(0, 10).replace(/-/g, "/"); const streamName = executable.loggingConfig.logGroup === `/aws/lambda/${fn.functionName}` ? `${streamDate}/[${resolved.executedVersion}]${id(32)}` : `${streamDate}/${fn.functionName}[${resolved.executedVersion}]${id(32)}`;
    let credentials: Record<string, string>; try { credentials = await this.runtimeCredentials(executable.role, [...(options.lineage ?? []), resolved.qualifiedArn]); } catch (error) { await lease.release(); throw error; }
    try {
      if (options.durableExecutionArn) this.activeDurableChildren.set(options.durableExecutionArn, () => { void this.dockerRuntime.cancel(requestId); });
      const result = await this.dockerRuntime.invoke({ socketPath: process.env.STACKSIM_LAMBDA_DOCKER_SOCKET, imageUri: executable.imageExecutionUri ?? executable.resolvedImageUri ?? executable.imageUri!, imageConfig: executable.imageConfig, payload, requestId, deadlineMs: Date.now() + executable.timeout * 1000, timeoutMs: executable.timeout * 1000, invokedFunctionArn: resolved.qualifiedArn, clientContext: options.clientContext, environment: { ...executable.environment, AWS_REGION: this.region, AWS_DEFAULT_REGION: this.region, AWS_ENDPOINT_URL: this.controlEndpoint(), AWS_ENDPOINT_URL_LAMBDA: this.controlEndpoint(), STACKSIM_ENDPOINT: this.controlEndpoint(), AWS_LAMBDA_FUNCTION_NAME: fn.functionName, AWS_LAMBDA_FUNCTION_VERSION: resolved.executedVersion, AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(executable.memorySize), AWS_LAMBDA_INITIALIZATION_TYPE: lease.initializationType, LAMBDA_TASK_ROOT: "/var/task", LAMBDA_RUNTIME_DIR: "/var/runtime", STACKSIM_LAMBDA_EPHEMERAL_STORAGE_SIZE: String(executable.ephemeralStorageSize), ...(executable.imageConfig?.command?.length ? { _HANDLER: executable.imageConfig.command.join(" ") } : {}), ...credentials, ...options.environmentOverrides }, memorySize: executable.memorySize, ephemeralStorageSize: executable.ephemeralStorageSize, architecture: executable.architectures[0] });
      const billedDurationMs = Math.max(1, Math.ceil(result.durationMs)); const redact = (message: string) => [...new Set(options.sensitiveLogValues ?? [])].filter(Boolean).sort((left, right) => right.length - left.length).reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), message); const application = [...result.stdout.map(message => ({ message: redact(message), level: "INFO" })), ...result.stderr.map(message => ({ message: redact(message), level: "ERROR" }))]; const logLines = this.formatLogLines(executable, fn.functionName, requestId, resolved.executedVersion, result.durationMs, billedDurationMs, application, options.serviceLogContext);
      await this.writeLogs(fn, executable.role, executable.loggingConfig.logGroup, streamName, logLines, [...(options.lineage ?? []), resolved.qualifiedArn]); const logBytes = Buffer.from(logLines.join("\n") + "\n"); const invocation: InvokeResult = { payload: result.payload, ...(result.functionError ? { functionError: result.functionError } : {}), statusCode: 200, logResult: logBytes.subarray(Math.max(0, logBytes.length - 4096)).toString("base64"), requestId, durationMs: result.durationMs, billedDurationMs, executedVersion: resolved.executedVersion };
      if (this.telemetry) { const metricTime = this.clock.now(); const dimensions = { FunctionName: fn.functionName }; await Promise.all([this.telemetry.publish({ namespace: "AWS/Lambda", metricName: "Invocations", dimensions, value: 1, unit: "Count", timestamp: metricTime }), this.telemetry.publish({ namespace: "AWS/Lambda", metricName: "Duration", dimensions, value: invocation.durationMs, unit: "Milliseconds", timestamp: metricTime }), ...(invocation.functionError ? [this.telemetry.publish({ namespace: "AWS/Lambda", metricName: "Errors", dimensions, value: 1, unit: "Count", timestamp: metricTime })] : [])]).catch(() => undefined); }
      return invocation;
    } finally { if (options.durableExecutionArn) this.activeDurableChildren.delete(options.durableExecutionArn); await lease.release(); }
  }
  private formatLogLines(executable: Executable, functionName: string, requestId: string, version: string, durationMs: number, billedDurationMs: number, application: Array<{ message: string; level: string }>, serviceLogContext?: InvokeOptions["serviceLogContext"]): string[] {
    const now = new Date(this.clock.now()).toISOString(); const levels = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]; const minimum = levels.indexOf(executable.loggingConfig.applicationLogLevel ?? "INFO"); const output: string[] = [];
    if (serviceLogContext) output.push(`STACKSIM-SERVICE-CORRELATION ${JSON.stringify({ timestamp: now, lambdaRequestId: requestId, functionName, ...serviceLogContext })}`);
    const systemEnabled = (executable.loggingConfig.systemLogLevel ?? "INFO") !== "WARN"; const start = `START RequestId: ${requestId} Version: ${version}`; const end = `END RequestId: ${requestId}`; const report = `REPORT RequestId: ${requestId}\tDuration: ${durationMs.toFixed(2)} ms\tBilled Duration: ${billedDurationMs} ms\tMemory Size: ${executable.memorySize} MB\tMax Memory Used: ${executable.memorySize} MB`;
    if (systemEnabled) output.push(executable.loggingConfig.logFormat === "JSON" ? JSON.stringify({ time: now, type: "platform.start", record: { requestId, functionName, version } }) : start);
    for (const entry of application) { const level = levels.includes(entry.level) ? entry.level : "INFO"; if (executable.loggingConfig.logFormat === "JSON" && levels.indexOf(level) < minimum) continue; output.push(executable.loggingConfig.logFormat === "JSON" ? JSON.stringify({ timestamp: now, level, requestId, message: entry.message }) : entry.message); }
    if (systemEnabled) { if (executable.loggingConfig.logFormat === "JSON") { output.push(JSON.stringify({ time: now, type: "platform.runtimeDone", record: { requestId, status: "success" } })); output.push(JSON.stringify({ time: now, type: "platform.report", record: { requestId, metrics: { durationMs: Number(durationMs.toFixed(2)), billedDurationMs, memorySizeMB: executable.memorySize, maxMemoryUsedMB: executable.memorySize } } })); } else output.push(end, report); }
    return output;
  }
  private async writeLogs(fn: LambdaState, roleArn: string, groupName: string, streamName: string, lines: string[], deliveryLineage: string[] = []): Promise<void> {
    if (!this.logs || !lines.length) return;
    const iam = this.store.ensureAccount().iam;
    try {
      const delivered = await this.logs.deliverServiceEvents(
        { logGroupName: groupName, logStreamName: streamName, logEvents: lines.map((message, index) => ({ timestamp: this.clock.now() + index, message })) },
        (action, resource) => this.authMode !== "enforce" || evaluateRoleAuthorization(iam, roleArn, action, resource).decision === "allowed",
        { deliveryLineage },
      );
      if (!delivered) throw new AwsError("AccessDeniedException", "The Lambda execution role is not authorized to deliver function logs.", 403);
      if (fn.lastLogDeliveryError) { delete fn.lastLogDeliveryError; await this.store.save(); }
    } catch (error) {
      fn.lastLogDeliveryError = { time: this.clock.now(), code: error instanceof AwsError ? error.code : "LogDeliveryFailure", message: error instanceof Error ? error.message : String(error) };
      await this.store.save();
    }
  }
  /** Continue the same public CFN callback contract when an admitted waiter invokes isComplete. */
  async invokeCloudFormationCallbackContinuation(nameOrArn: string, payload: Buffer, requestId: string, caCertificatePath: string, callbackPort: number, options: InvokeOptions = {}): Promise<InvokeResult> {
    const resolved = this.resolveInvocation(nameOrArn, options.qualifier);
    if (resolved.fn.packageType !== "Zip") throw new AwsError("InvalidParameterValueException", "CloudFormation callback continuations require a local ZIP-backed Lambda function", 400);
    const endpoint = new URL(this.controlEndpoint());
    if (endpoint.protocol !== "http:" || !new Set(["localhost", "127.0.0.1", "[::1]"]).has(endpoint.hostname) || !endpoint.port) throw new AwsError("InvalidEndpoint", "CloudFormation callback continuations require the local simulator endpoint", 400);
    let event: unknown;
    try { event = JSON.parse(payload.toString("utf8")); } catch { throw new AwsError("InvalidRequestContentException", "The callback continuation payload is not JSON", 400); }
    const sensitiveLogValues = cloudFormationCallbackSensitiveLogValues(event);
    if (!sensitiveLogValues.length) throw new AwsError("InvalidParameterValueException", "The waiter payload is not a valid CloudFormation custom-resource callback event", 400);
    const secureServiceEndpoint = `https://127.0.0.1:${callbackPort}`;
    return this.invokeRuntime(nameOrArn, payload, requestId, {
      ...options,
      resolvedOverride: resolved,
      sanitizeEnvironment: true,
      trustedCaCertificatePath: caCertificatePath,
      sensitiveLogValues: [...(options.sensitiveLogValues ?? []), ...sensitiveLogValues],
      environmentOverrides: { ...(options.environmentOverrides ?? {}), AWS_ENDPOINT_URL: secureServiceEndpoint, AWS_ENDPOINT_URL_LAMBDA: secureServiceEndpoint, STACKSIM_ENDPOINT: secureServiceEndpoint, STACKSIM_CLOUDFORMATION_CALLBACK_PORT: String(callbackPort), STACKSIM_CLOUDFORMATION_NETWORK_PORTS: `${endpoint.port},${callbackPort}` },
    });
  }
  async stop(): Promise<void> { this.beginShutdown(); this.capacityProviders.stop(); this.durableExecutions.shutdown(); this.asyncWorkerCancel?.(); this.asyncWorkerCancel = undefined; const asyncWorkerStop = this.asyncWorker; for (const cancel of this.provisionedTransitions.values()) cancel(); this.provisionedTransitions.clear(); const eventSourceStop = this.eventSources.stop(); const dockerStop = this.dockerRuntime.stop(); const workerStop = this.workerPool.stop(); this.activeDurableChildren.clear(); await Promise.all([eventSourceStop, dockerStop, workerStop, this.durableExecutions.flush(), asyncWorkerStop]); await Promise.allSettled([...this.functionTransitions]); this.concurrency.reset(); }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, url = new URL(req.url ?? pathname, "http://localhost"), principal?: PrincipalContext): Promise<any> {
    let activeHotswapRecord: CloudFormationHotswapDriftState | undefined;
    try {
      if (await this.durableExecutions.handle(req, res, pathname, url)) return;
      if (await this.capacityProviders.handle(req, res, pathname, url)) return;
      if (await this.handleCodeSigning(req, res, pathname, url)) return;
      const functionCodeSigningMatch = pathname.match(/^\/2020-06-30\/functions\/([^/]+)\/code-signing-config$/);
      if (functionCodeSigningMatch) { const fn = this.require(decodeURIComponent(functionCodeSigningMatch[1])); if (req.method === "GET") { if (!fn.codeSigningConfigArn) throw new AwsError("CodeSigningConfigNotFoundException", "No code signing configuration is attached to this function", 404); return json(res, { FunctionName: fn.functionName, CodeSigningConfigArn: fn.codeSigningConfigArn }); } if (req.method === "PUT") { if (fn.packageType === "Image") throw new AwsError("InvalidParameterValueException", "Code signing configuration is supported only for Zip functions"); const input = JSON.parse((await readBody(req)).toString("utf8") || "{}"); if (typeof input.CodeSigningConfigArn !== "string") throw new AwsError("InvalidParameterValueException", "CodeSigningConfigArn is required"); const config = this.requireCodeSigningConfig(input.CodeSigningConfigArn); fn.codeSigningConfigArn = config.codeSigningConfigArn; await this.store.save(); return json(res, { FunctionName: fn.functionName, CodeSigningConfigArn: fn.codeSigningConfigArn }); } if (req.method === "DELETE") { if (!fn.codeSigningConfigArn) throw new AwsError("CodeSigningConfigNotFoundException", "No code signing configuration is attached to this function", 404); delete fn.codeSigningConfigArn; await this.store.save(); res.statusCode = 204; return res.end(); } throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404); }
      const runtimeManagementMatch = pathname.match(/^\/2021-07-20\/functions\/([^/]+)\/runtime-management-config$/);
      if (runtimeManagementMatch) { const name = decodeURIComponent(runtimeManagementMatch[1]); const qualifier = url.searchParams.get("Qualifier") ?? undefined; const fn = this.require(name); if (qualifier && fn.aliases?.[qualifier]) throw new AwsError("InvalidParameterValueException", "Qualifier must be $LATEST or a published version"); const resolved = this.resolve(name, qualifier); const item = resolved.executable; if (req.method === "GET") return json(res, { FunctionArn: resolved.qualifiedArn, UpdateRuntimeOn: item.runtimeManagementConfig.updateRuntimeOn, ...(item.runtimeManagementConfig.runtimeVersionArn ? { RuntimeVersionArn: item.runtimeManagementConfig.runtimeVersionArn } : {}) }); if (req.method === "PUT") { const input = JSON.parse((await readBody(req)).toString("utf8") || "{}"); if (!new Set(["Auto", "FunctionUpdate", "Manual"]).has(input.UpdateRuntimeOn)) throw new AwsError("InvalidParameterValueException", "UpdateRuntimeOn must be Auto, FunctionUpdate, or Manual"); if (input.UpdateRuntimeOn === "Manual" && (typeof input.RuntimeVersionArn !== "string" || !/^arn:(?:aws|aws-us-gov|aws-cn):lambda:[^:]+::runtime:[A-Za-z0-9._-]+$/.test(input.RuntimeVersionArn))) throw new AwsError("InvalidParameterValueException", "Manual runtime management requires a runtime version ARN"); if (input.UpdateRuntimeOn !== "Manual" && input.RuntimeVersionArn !== undefined) throw new AwsError("InvalidParameterValueException", "RuntimeVersionArn is valid only with Manual update mode"); await this.workerPool.retireFunctionVersion(fn.functionName, resolved.executedVersion); item.runtimeManagementConfig = { updateRuntimeOn: input.UpdateRuntimeOn, ...(input.RuntimeVersionArn ? { runtimeVersionArn: input.RuntimeVersionArn } : {}) }; await this.store.save(); return json(res, { FunctionArn: resolved.qualifiedArn, UpdateRuntimeOn: item.runtimeManagementConfig.updateRuntimeOn, ...(item.runtimeManagementConfig.runtimeVersionArn ? { RuntimeVersionArn: item.runtimeManagementConfig.runtimeVersionArn } : {}) }); } throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404); }
      const recursionMatch = pathname.match(/^\/2024-08-31\/functions\/([^/]+)\/recursion-config$/);
      if (recursionMatch) { const fn = this.require(decodeURIComponent(recursionMatch[1])); if (req.method === "GET") return json(res, { RecursiveLoop: fn.recursiveLoop }); if (req.method === "PUT") { const input = JSON.parse((await readBody(req)).toString("utf8") || "{}"); if (!new Set(["Allow", "Terminate"]).has(input.RecursiveLoop)) throw new AwsError("InvalidParameterValueException", "RecursiveLoop must be Allow or Terminate"); fn.recursiveLoop = input.RecursiveLoop; await this.store.save(); return json(res, { RecursiveLoop: fn.recursiveLoop }); } throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404); }
      if (pathname.startsWith("/2021-10-31/functions") && await this.functionUrls.handleControl(req, res, pathname, url)) return;
      const responseStreamMatch = pathname.match(/^\/2021-11-15\/functions\/([^/]+)\/response-streaming-invocations$/);
      if (responseStreamMatch && req.method === "POST") {
        const name = decodeURIComponent(responseStreamMatch[1]); const qualifier = url.searchParams.get("Qualifier") ?? undefined; const invocationType = String(req.headers["x-amz-invocation-type"] ?? "RequestResponse"); if (!new Set(["RequestResponse", "DryRun"]).has(invocationType)) throw new AwsError("InvalidParameterValueException", "InvokeWithResponseStream supports RequestResponse or DryRun"); const logType = String(req.headers["x-amz-log-type"] ?? "None"); if (!new Set(["None", "Tail"]).has(logType) || (logType === "Tail" && invocationType !== "RequestResponse")) throw new AwsError("InvalidParameterValueException", "LogType Tail is supported only for RequestResponse invocations"); if (req.headers["x-amz-tenant-id"]) throw new AwsError("InvalidParameterValueException", "TenantId requires a multi-tenant Lambda configuration that is not available"); const body = await readBody(req); if (body.length > 6 * 1024 * 1024) throw new AwsError("RequestTooLargeException", "Request payload size exceeded the synchronous invocation limit", 413); if (body.length) try { JSON.parse(body.toString("utf8")); } catch { throw new AwsError("InvalidRequestContentException", "Could not parse request body into JSON", 400); } let clientContext: unknown; const encoded = req.headers["x-amz-client-context"]; if (encoded) try { clientContext = JSON.parse(Buffer.from(String(encoded), "base64").toString("utf8")); } catch { throw new AwsError("InvalidParameterValueException", "ClientContext is not valid base64 JSON"); } const resolved = this.resolve(name, qualifier); if (resolved.executable.durableConfig) throw new AwsError("InvalidParameterValueException", "InvokeWithResponseStream is not supported for durable functions"); if (invocationType === "DryRun") { res.statusCode = 204; return res.end(); }
        res.statusCode = 200; res.setHeader("content-type", "application/vnd.amazon.eventstream"); const result = await this.invokeStreaming(name, body, id(24), { qualifier, clientContext, lineage: principal?.lambdaLineage }, { onStart: value => { res.setHeader("x-amz-executed-version", value.executedVersion); res.setHeader("x-amzn-requestid", value.requestId); res.flushHeaders(); }, onChunk: chunk => writeWithBackpressure(res, eventStreamMessage("PayloadChunk", chunk, "application/octet-stream")) }); const complete = { ...(result.functionError ? { ErrorCode: result.functionError, ErrorDetails: result.payload.toString("utf8") } : {}), ...(logType === "Tail" ? { LogResult: result.logResult } : {}) }; await writeWithBackpressure(res, eventStreamMessage("InvokeComplete", Buffer.from(JSON.stringify(complete)), "application/json")); return res.end();
      }
      if (pathname.startsWith("/2018-10-31/layers")) return await this.layers.handle(req, res, pathname, url);
      if (pathname.startsWith("/2015-03-31/event-source-mappings")) return await this.eventSources.handle(req, res, pathname, url);
      if (pathname.startsWith("/2016-08-19/account-settings") && req.method === "GET") { const functions = Object.values(this.store.regionState(this.region).functions); return json(res, { AccountLimit: { TotalCodeSize: 80_530_636_800, CodeSizeUnzipped: 262_144_000, CodeSizeZipped: Number(process.env.STACKSIM_LAMBDA_ZIP_LIMIT ?? 50 * 1024 * 1024), ConcurrentExecutions: this.concurrency.concurrentExecutions, UnreservedConcurrentExecutions: this.concurrency.unreservedConfigured() }, AccountUsage: { TotalCodeSize: functions.reduce((sum, fn) => sum + fn.codeSize, 0) + this.layers.storageBytes(), FunctionCount: functions.length } }); }
      const invokeAsyncMatch = pathname.match(/^\/2014-11-13\/functions\/([^/]+)\/invoke-async$/); if (invokeAsyncMatch && req.method === "POST") { const name = decodeURIComponent(invokeAsyncMatch[1]); const body = await readBody(req); if (body.length > 256 * 1024) throw new AwsError("RequestTooLargeException", "InvokeAsync payload size exceeded 256 KB", 413); await this.enqueueAsync(name, undefined, body, principal?.lambdaLineage); res.statusCode = 202; return res.end(); }
      const concurrencyMatch = pathname.match(/^\/(?:2017-10-31|2019-09-30)\/functions\/([^/]+)\/concurrency$/); if (concurrencyMatch) {
        const fn = this.require(decodeURIComponent(concurrencyMatch[1]));
        if (req.method === "GET") return json(res, fn.reservedConcurrentExecutions === undefined ? {} : { ReservedConcurrentExecutions: fn.reservedConcurrentExecutions });
        if (req.method === "PUT") { const input = JSON.parse((await readBody(req)).toString("utf8") || "{}"); if (input.ReservedConcurrentExecutions === undefined) throw new AwsError("InvalidParameterValueException", "ReservedConcurrentExecutions is required"); this.concurrency.validateReserved(fn, input.ReservedConcurrentExecutions); fn.reservedConcurrentExecutions = input.ReservedConcurrentExecutions; await this.store.save(); return json(res, { ReservedConcurrentExecutions: fn.reservedConcurrentExecutions }); }
        if (req.method === "DELETE") { this.concurrency.validateReserved(fn, undefined); delete fn.reservedConcurrentExecutions; await this.store.save(); res.statusCode = 204; return res.end(); }
        throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404);
      }
      const provisionedMatch = pathname.match(/^\/2019-09-30\/functions\/([^/]+)\/provisioned-concurrency$/); if (provisionedMatch) {
        const fn = this.require(decodeURIComponent(provisionedMatch[1])); const list = url.searchParams.get("List") === "ALL"; const qualifier = url.searchParams.get("Qualifier") ?? undefined;
        if (req.method === "GET" && list) {
          const requestedMax = Number(url.searchParams.get("MaxItems") ?? 50); if (!Number.isInteger(requestedMax) || requestedMax < 1 || requestedMax > 50) throw new AwsError("InvalidParameterValueException", "MaxItems must be between 1 and 50"); const values = Object.values(fn.provisionedConcurrencyConfigs!).sort((left, right) => left.qualifier.localeCompare(right.qualifier)); let start = 0; const marker = url.searchParams.get("Marker"); if (marker) try { const cursor = this.tokens.decode<{ functionName: string; index: number }>("ListProvisionedConcurrencyConfigs", marker); if (cursor.functionName !== fn.functionName || !Number.isInteger(cursor.index) || cursor.index < 0) throw new Error(); start = cursor.index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid Marker"); } const page = values.slice(start, start + requestedMax); const next = start + page.length; return json(res, { ProvisionedConcurrencyConfigs: page.map(config => this.provisionedView(fn, config, true)), ...(next < values.length ? { NextMarker: this.tokens.encode("ListProvisionedConcurrencyConfigs", { functionName: fn.functionName, index: next }) } : {}) });
        }
        const validQualifier = this.validateProvisionedQualifier(fn, qualifier); const key = this.provisionedKey(fn.functionName, validQualifier);
        if (req.method === "GET") { const config = fn.provisionedConcurrencyConfigs![validQualifier]; if (!config) throw new AwsError("ProvisionedConcurrencyConfigNotFoundException", `No provisioned concurrency configuration exists for ${fn.functionName}:${validQualifier}`, 404); return json(res, this.provisionedView(fn, config)); }
        if (req.method === "PUT") { const input = JSON.parse((await readBody(req)).toString("utf8") || "{}"); if (this.resolve(fn.functionName, validQualifier).executable.packageType === "Image") throw new AwsError("InvalidParameterValueException", "Provisioned concurrency for image functions requires reusable prewarmed Docker containers, which are not implemented", 400); this.concurrency.validateProvisioned(fn, validQualifier, input.ProvisionedConcurrentExecutions); const config: LambdaProvisionedConcurrencyConfigState = { qualifier: validQualifier, requestedProvisionedConcurrentExecutions: input.ProvisionedConcurrentExecutions, allocatedProvisionedConcurrentExecutions: 0, status: "IN_PROGRESS", lastModified: new Date(this.clock.now()).toISOString() }; fn.provisionedConcurrencyConfigs![validQualifier] = config; await this.store.save(); this.scheduleProvisionedReady(fn, config); return json(res, this.provisionedView(fn, config), 202); }
        if (req.method === "DELETE") { if (!fn.provisionedConcurrencyConfigs![validQualifier]) throw new AwsError("ProvisionedConcurrencyConfigNotFoundException", `No provisioned concurrency configuration exists for ${fn.functionName}:${validQualifier}`, 404); this.provisionedTransitions.get(key)?.(); this.provisionedTransitions.delete(key); delete fn.provisionedConcurrencyConfigs![validQualifier]; await this.workerPool.retireProvisioned(key); await this.store.save(); res.statusCode = 204; return res.end(); }
        throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404);
      }
      const eventConfigMatch = pathname.match(/^\/2019-09-25\/functions\/([^/]+)\/event-invoke-config(\/list)?$/); if (eventConfigMatch) {
        const name = decodeURIComponent(eventConfigMatch[1]); const qualifier = url.searchParams.get("Qualifier") ?? undefined; const fn = this.require(name);
        if (eventConfigMatch[2]) { if (req.method !== "GET") throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404); const requestedMax = Number(url.searchParams.get("MaxItems") ?? 50); if (!Number.isInteger(requestedMax) || requestedMax < 1 || requestedMax > 50) throw new AwsError("InvalidParameterValueException", "MaxItems must be between 1 and 50"); const values = Object.values(fn.eventInvokeConfigs!).sort((left, right) => this.configArn(fn, left.qualifier).localeCompare(this.configArn(fn, right.qualifier))); let start = 0; const marker = url.searchParams.get("Marker"); if (marker) try { const cursor = this.tokens.decode<{ functionName: string; index: number }>("ListFunctionEventInvokeConfigs", marker); if (cursor.functionName !== fn.functionName || !Number.isInteger(cursor.index) || cursor.index < 0) throw new Error(); start = cursor.index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid Marker"); } const page = values.slice(start, start + requestedMax); const next = start + page.length; return json(res, { FunctionEventInvokeConfigs: page.map(config => this.eventInvokeConfigView(fn, config)), ...(next < values.length ? { NextMarker: this.tokens.encode("ListFunctionEventInvokeConfigs", { functionName: fn.functionName, index: next }) } : {}) }); }
        const key = this.configKey(qualifier); if (req.method === "GET") { const config = fn.eventInvokeConfigs![key]; if (!config) throw new AwsError("ResourceNotFoundException", "The function event invoke configuration does not exist", 404); return json(res, this.eventInvokeConfigView(fn, config)); } if (req.method === "DELETE") { if (!fn.eventInvokeConfigs![key]) throw new AwsError("ResourceNotFoundException", "The function event invoke configuration does not exist", 404); delete fn.eventInvokeConfigs![key]; await this.store.save(); res.statusCode = 204; return res.end(); } if (req.method === "PUT" || req.method === "POST") { const input = JSON.parse((await readBody(req)).toString("utf8") || "{}"); return json(res, await this.putEventInvokeConfig(fn.functionName, qualifier, input, req.method === "PUT")); }
        throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404);
      }
      const providerTagMatch = pathname.match(/^\/2017-03-31\/tags\/(.+)$/);
      if (providerTagMatch) {
        const resource = decodeURIComponent(providerTagMatch[1]); const targetTags = this.capacityProviders.tagsForArn(resource);
        if (targetTags) {
          if (req.method === "GET") return json(res, { Tags: targetTags }); const input = JSON.parse((await readBody(req)).toString("utf8") || "{}");
          if (req.method === "POST") { const additions = tags(input.Tags); if (new Set([...Object.keys(targetTags), ...Object.keys(additions)]).size > 50) throw new AwsError("InvalidParameterValueException", "A maximum of 50 tags is allowed"); Object.assign(targetTags, additions); await this.store.save(); res.statusCode = 204; return res.end(); }
          if (req.method === "DELETE") { const keys = url.searchParams.getAll("tagKeys"); if (!keys.length || keys.length > 50) throw new AwsError("InvalidParameterValueException", "TagKeys must contain between 1 and 50 keys"); for (const key of keys) delete targetTags[key]; await this.store.save(); res.statusCode = 204; return res.end(); }
        }
      }
      const tagMatch = pathname.match(/^\/2017-03-31\/tags\/(.+)$/);
      if (tagMatch) { const resource = decodeURIComponent(tagMatch[1]); if (!resource.startsWith("arn:aws:lambda:")) throw new AwsError("InvalidParameterValueException", "Resource must be a Lambda ARN"); const mappingUuid = resource.match(/:event-source-mapping:([^:]+)$/)?.[1]; let targetTags: Record<string, string>; const signingConfig = this.store.regionState(this.region).lambdaCodeSigningConfigs[resource]; if (signingConfig) targetTags = signingConfig.tags; else if (mappingUuid) { const mapping = this.store.regionState(this.region).lambdaEventSourceMappings[mappingUuid]; if (!mapping || mapping.eventSourceMappingArn !== resource) throw new AwsError("ResourceNotFoundException", "Event source mapping not found", 404); targetTags = mapping.tags; } else { const target = parseFunctionTarget(resource); const resolved = this.resolve(target.name, target.qualifier); targetTags = resolved.fn.tags!; } if (req.method === "GET") return json(res, { Tags: targetTags }); const input = JSON.parse((await readBody(req)).toString("utf8") || "{}"); if (req.method === "POST") { const additions = tags(input.Tags); if (new Set([...Object.keys(targetTags), ...Object.keys(additions)]).size > 50) throw new AwsError("InvalidParameterValueException", "A maximum of 50 tags is allowed"); Object.assign(targetTags, additions); await this.store.save(); res.statusCode = 204; return res.end(); } if (req.method === "DELETE") { const keys = url.searchParams.getAll("tagKeys"); if (!keys.length || keys.length > 50) throw new AwsError("InvalidParameterValueException", "TagKeys must contain between 1 and 50 keys"); for (const key of keys) delete targetTags[key]; await this.store.save(); res.statusCode = 204; return res.end(); } }
      if (pathname === "/2015-03-31/functions" && req.method === "POST") {
        const input = JSON.parse((await readBody(req)).toString("utf8")); if (this.store.regionState(this.region).functions[input.FunctionName]) throw new AwsError("ResourceConflictException", `Function already exists: ${input.FunctionName}`, 409); this.validateConfiguration(input, true); const packageType = this.validatePackageConfiguration(input, true); this.validateRole(input.Role, principal, `arn:aws:lambda:${this.region}:${this.store.accountId}:function:${input.FunctionName}`);
        if (input.Publish !== undefined && typeof input.Publish !== "boolean") throw new AwsError("InvalidParameterValueException", "Publish must be a boolean"); if (input.Publish && input.PublishTo !== undefined) throw new AwsError("InvalidParameterValueException", "Publish and PublishTo cannot be used together"); if (input.PublishTo !== undefined && input.PublishTo !== "LATEST_PUBLISHED") throw new AwsError("InvalidParameterValueException", "PublishTo must be LATEST_PUBLISHED");
        const advanced = this.executableConfiguration(input, input.FunctionName, undefined, principal); const runtime = packageType === "Zip" ? input.Runtime : ""; const handler = packageType === "Zip" ? input.Handler : ""; const layers = packageType === "Zip" ? this.layers.resolveFunctionLayers(input.Layers, runtime, 0, advanced.architectures[0]) : [];
        const fn: LambdaState = { functionName: input.FunctionName, functionArn: `arn:aws:lambda:${this.region}:${this.store.accountId}:function:${input.FunctionName}`, runtime, role: input.Role, handler, timeout: input.Timeout ?? 3, memorySize: input.MemorySize ?? 128, description: input.Description ?? "", environment: input.Environment?.Variables ?? {}, codeSha256: "", codeSize: 0, codeUnzippedSize: 0, codeDir: "", layers, ...advanced, version: 0, revisionId: id(32), tags: tags(input.Tags), versions: {}, aliases: {}, policies: {}, eventInvokeConfigs: {}, provisionedConcurrencyConfigs: {}, functionUrlConfigs: {}, functionScalingConfigs: {}, ...(input.CodeSigningConfigArn ? { codeSigningConfigArn: input.CodeSigningConfigArn } : {}), recursiveLoop: "Terminate", lastModified: new Date(this.clock.now()).toISOString(), state: "Pending", lastUpdateStatus: "InProgress" };
        if (input.PublishTo !== undefined) this.capacityProviders.assertPublishCapacity(fn);
        if (packageType === "Image") this.installImage(fn, await this.images.resolve(input.Code.ImageUri, advanced.architectures[0])); else { this.assertCodeSigningDeployment(fn); await this.installCode(fn, Buffer.from(input.Code.ZipFile, "base64")); }
        this.store.regionState(this.region).functions[fn.functionName] = fn; const publishedVersion = this.publicationTarget(fn, Boolean(input.Publish), input.PublishTo); if (publishedVersion) this.publishSnapshot(fn, publishedVersion); await this.store.save(); const output = this.configuration(this.resolve(fn.functionName, publishedVersion)); this.transition(fn, "create"); return json(res, output, 201);
      }
      if (pathname === "/2015-03-31/functions" && req.method === "GET") { const functions = Object.values(this.store.regionState(this.region).functions).sort((a, b) => a.functionName.localeCompare(b.functionName)); const max = Math.min(10_000, Math.max(1, Number(url.searchParams.get("MaxItems") ?? 50))); let start = 0; const marker = url.searchParams.get("Marker"); if (marker) { try { start = this.tokens.decode<{ index: number }>("ListFunctions", marker).index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid Marker"); } } const page = functions.slice(start, start + max); const next = start + page.length; return json(res, { Functions: page.map(fn => this.configuration(this.resolve(fn.functionName))), ...(next < functions.length ? { NextMarker: this.tokens.encode("ListFunctions", { index: next }) } : {}) }); }
      const match = pathname.match(/^\/2015-03-31\/functions\/([^/]+)(.*)$/); if (!match) throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404); const target = parseFunctionTarget(decodeURIComponent(match[1])); const name = target.name; const suffix = match[2]; const qualifier = url.searchParams.get("Qualifier") ?? target.qualifier;
      if (suffix === "" && req.method === "GET") { const resolved = this.resolve(name, qualifier); const inlineSource = this.inlineCodeSource(resolved.executable); const source = inlineSource ? await readFile(resolve(resolved.executable.codeDir, inlineSource.FileName), "utf8") : undefined; const code = resolved.executable.packageType === "Image" ? { RepositoryType: "ECR", ImageUri: resolved.executable.imageUri, ResolvedImageUri: resolved.executable.resolvedImageUri, LocalImageSource: resolved.executable.imageSource } : { RepositoryType: "S3", Location: `file://${resolved.executable.codeDir}`, ...(inlineSource ? { StackSimCodeSource: { ...inlineSource, Source: source } } : {}) }; return json(res, { Configuration: this.configuration(resolved), Code: code, Tags: resolved.fn.tags, ...(resolved.fn.reservedConcurrentExecutions !== undefined ? { Concurrency: { ReservedConcurrentExecutions: resolved.fn.reservedConcurrentExecutions } } : {}) }); }
      if (suffix === "" && req.method === "DELETE") { const target = parseFunctionTarget(name); const requested = qualifier ?? target.qualifier; const fn = this.require(target.name); if (this.durableExecutions.hasRunningForFunction(fn.functionName, requested && requested !== "$LATEST" ? requested : undefined)) throw new AwsError("ResourceConflictException", "Cannot delete a function or version with running durable executions", 409); if (requested && requested !== "$LATEST") { if (!fn.versions?.[requested]) throw new AwsError("ResourceNotFoundException", "Version not found", 404); if (Object.values(fn.aliases ?? {}).some(alias => alias.functionVersion === requested || alias.additionalVersionWeights[requested] !== undefined)) throw new AwsError("ResourceConflictException", "Cannot delete a version that is referenced by an alias", 409); if (fn.provisionedConcurrencyConfigs![requested]) throw new AwsError("ResourceConflictException", "Cannot delete a version with provisioned concurrency configured", 409); const dir = fn.versions[requested].codeDir; await this.workerPool.retireFunctionVersion(fn.functionName, requested); delete fn.versions[requested]; delete fn.eventInvokeConfigs![requested]; delete fn.functionScalingConfigs![requested]; this.eventSources.disableForFunction(fn.functionName, requested); if (dir && dir !== fn.codeDir && !Object.values(fn.versions).some(version => version.codeDir === dir)) await rm(dir, { recursive: true, force: true }); } else { for (const qualifier of Object.keys(fn.provisionedConcurrencyConfigs!)) { const key = this.provisionedKey(fn.functionName, qualifier); this.provisionedTransitions.get(key)?.(); this.provisionedTransitions.delete(key); } await this.workerPool.retireFunctionVersion(fn.functionName); delete this.store.regionState(this.region).functions[fn.functionName]; this.eventSources.disableForFunction(fn.functionName); for (const [eventId, event] of Object.entries(this.asyncQueue)) if (event.functionName === fn.functionName) delete this.asyncQueue[eventId]; const dirs = new Set([fn.codeDir, ...Object.values(fn.versions ?? {}).map(version => version.codeDir)].filter(Boolean)); await Promise.all([...dirs].map(dir => rm(dir, { recursive: true, force: true }))); } await this.store.save(); res.statusCode = 204; return res.end(); }
      if (suffix.startsWith("/invocations") && req.method === "POST" && isPinnedCdkHotswapRequest(req) && this.s3Service) {
        const fn = this.require(name);
        if (fn.runtime === "python3.13" && fn.handler === "index.handler") {
          const payload = await readBody(req);
          activeHotswapRecord = beginHotswapDrift(this.store.regionState(this.region).cloudformation, uniqueCompletedOwner(this.store.regionState(this.region).cloudformation, lambdaOwnershipKey(fn.functionName)), "lambda", "Invoke", payload, fn.revisionId ?? "unknown", this.clock.now());
          await this.store.save();
          await hotswapCheckpoint(this.store.regionState(this.region).cloudformation, "before-direct-call", activeHotswapRecord);
          await executeCdkBucketDeploymentHotswap(this.s3Service, this.store, this.region, fn.functionArn, payload, this.clock.now());
          completeHotswapDrift(this.store.regionState(this.region).cloudformation, activeHotswapRecord, `${fn.revisionId ?? "unknown"}:invoke:${requestPayloadDigest(payload)}`, this.clock.now());
          await hotswapCheckpoint(this.store.regionState(this.region).cloudformation, "after-direct-call", activeHotswapRecord);
          await this.store.save();
          res.statusCode = 200; res.setHeader("content-type", "application/json"); res.setHeader("x-amzn-requestid", id(24)); return res.end("{}");
        }
      }
      if (suffix === "/code" && req.method === "PUT") {
        if (qualifier && qualifier !== "$LATEST") throw new AwsError("InvalidParameterValueException", "Published versions are immutable");
        const payload = await readBody(req); const input = JSON.parse(payload.toString("utf8")); const fn = this.require(name);
        if (isPinnedCdkHotswapRequest(req, "lambda")) { activeHotswapRecord = beginHotswapDrift(this.store.regionState(this.region).cloudformation, uniqueCompletedOwner(this.store.regionState(this.region).cloudformation, lambdaOwnershipKey(fn.functionName)), "lambda", "UpdateFunctionCode", payload, fn.revisionId ?? "unknown", this.clock.now()); await this.store.save(); await hotswapCheckpoint(this.store.regionState(this.region).cloudformation, "before-direct-call", activeHotswapRecord); }
        if (input.RevisionId && input.RevisionId !== fn.revisionId) throw new AwsError("PreconditionFailedException", "The RevisionId provided does not match", 412);
        if (input.Publish !== undefined && typeof input.Publish !== "boolean") throw new AwsError("InvalidParameterValueException", "Publish must be a boolean"); if (input.Publish && input.PublishTo !== undefined) throw new AwsError("InvalidParameterValueException", "Publish and PublishTo cannot be used together"); if (input.PublishTo !== undefined && input.PublishTo !== "LATEST_PUBLISHED") throw new AwsError("InvalidParameterValueException", "PublishTo must be LATEST_PUBLISHED");
        if (input.PublishTo !== undefined) this.capacityProviders.assertPublishCapacity(fn);
        if (input.Architectures !== undefined && (!Array.isArray(input.Architectures) || input.Architectures.length !== 1 || !new Set(["x86_64", "arm64"]).has(input.Architectures[0]))) throw new AwsError("InvalidParameterValueException", "Architectures must contain exactly one of x86_64 or arm64");
        const architecture = (input.Architectures?.[0] ?? fn.architectures[0]) as LambdaArchitecture;
        if (fn.packageType === "Image") {
          if (!input.ImageUri) throw new AwsError("InvalidParameterValueException", "ImageUri is required for an image function");
          if (input.ZipFile !== undefined || input.S3Bucket !== undefined || input.S3Key !== undefined || input.S3ObjectVersion !== undefined || input.SourceKMSKeyArn !== undefined) throw new AwsError("InvalidParameterValueException", "Image functions accept only ImageUri code updates");
          const image = await this.images.resolve(input.ImageUri, architecture);
          if (input.DryRun) return json(res, this.configuration(this.resolve(name)));
          fn.architectures = [architecture]; fn.lastUpdateStatus = "InProgress"; this.installImage(fn, image);
        } else {
          if (input.ImageUri !== undefined) throw new AwsError("InvalidParameterValueException", "ImageUri is valid only for image functions");
          const zip = input.ZipFile !== undefined
            ? Buffer.from(input.ZipFile, "base64")
            : typeof input.S3Bucket === "string" && typeof input.S3Key === "string" && this.s3Service
              ? (await this.s3Service.readObjectBytes(input.S3Bucket, input.S3Key, input.S3ObjectVersion, 50 * 1024 * 1024)).body
              : undefined;
          if (!zip) throw new AwsError("InvalidParameterValueException", "ZipFile or S3Bucket and S3Key are required");
          this.assertCodeSigningDeployment(fn);
          if (input.DryRun) return json(res, this.configuration(this.resolve(name)));
          await this.workerPool.retireFunctionVersion(fn.functionName, "$LATEST");
          const previousArchitectures = fn.architectures; fn.architectures = [architecture]; fn.lastUpdateStatus = "InProgress";
          try { await this.installCode(fn, zip); } catch (error) { fn.architectures = previousArchitectures; fn.lastUpdateStatus = "Successful"; throw error; }
        }
        const publishedVersion = this.publicationTarget(fn, Boolean(input.Publish), input.PublishTo); if (publishedVersion) this.publishSnapshot(fn, publishedVersion); if (activeHotswapRecord) { completeHotswapDrift(this.store.regionState(this.region).cloudformation, activeHotswapRecord, fn.revisionId ?? "unknown", this.clock.now()); await hotswapCheckpoint(this.store.regionState(this.region).cloudformation, "after-direct-call", activeHotswapRecord); } await this.store.save(); const output = this.configuration(this.resolve(name, publishedVersion)); this.transition(fn, "update"); return json(res, output);
      }
      if (suffix === "/configuration" && req.method === "GET") return json(res, this.configuration(this.resolve(name, qualifier)));
      if (suffix === "/configuration" && req.method === "PUT") {
        if (qualifier && qualifier !== "$LATEST") throw new AwsError("InvalidParameterValueException", "Published versions are immutable");
        const payload = await readBody(req); const input = JSON.parse(payload.toString("utf8")); const fn = this.require(name);
        if (isPinnedCdkHotswapRequest(req, "lambda")) { activeHotswapRecord = beginHotswapDrift(this.store.regionState(this.region).cloudformation, uniqueCompletedOwner(this.store.regionState(this.region).cloudformation, lambdaOwnershipKey(fn.functionName)), "lambda", "UpdateFunctionConfiguration", payload, fn.revisionId ?? "unknown", this.clock.now()); await this.store.save(); await hotswapCheckpoint(this.store.regionState(this.region).cloudformation, "before-direct-call", activeHotswapRecord); }
        if (input.RevisionId && input.RevisionId !== fn.revisionId) throw new AwsError("PreconditionFailedException", "The RevisionId provided does not match", 412);
        this.validateConfiguration(input); this.validatePackageConfiguration(input, false, fn); if (input.Role) this.validateRole(input.Role, principal, fn.functionArn);
        const advanced = this.executableConfiguration(input, fn.functionName, fn, principal); const nextRuntime = fn.packageType === "Zip" ? input.Runtime ?? fn.runtime : fn.runtime;
        const nextLayers = fn.packageType === "Zip" ? (input.Layers !== undefined ? this.layers.resolveFunctionLayers(input.Layers, nextRuntime, fn.codeUnzippedSize ?? fn.codeSize, advanced.architectures[0]) : structuredClone(fn.layers ?? [])) : [];
        if (fn.packageType === "Zip") this.layers.validateFunctionLayers(nextLayers, nextRuntime, fn.codeUnzippedSize ?? fn.codeSize, advanced.architectures[0]);
        await this.workerPool.retireFunctionVersion(fn.functionName, "$LATEST");
        if (input.Handler) fn.handler = input.Handler; fn.runtime = nextRuntime; fn.layers = nextLayers; Object.assign(fn, advanced);
        if (input.Role) fn.role = input.Role; if (input.Timeout !== undefined) fn.timeout = input.Timeout; if (input.MemorySize !== undefined) fn.memorySize = input.MemorySize; if (input.Description !== undefined) fn.description = input.Description;
        if (input.Environment !== undefined) { fn.environment = input.Environment.Variables; delete fn.environmentError; }
        if (input.CodeSigningConfigArn !== undefined) { if (input.CodeSigningConfigArn) fn.codeSigningConfigArn = input.CodeSigningConfigArn; else delete fn.codeSigningConfigArn; }
        fn.lastModified = new Date(this.clock.now()).toISOString(); fn.revisionId = id(32); fn.lastUpdateStatus = "InProgress"; if (activeHotswapRecord) { completeHotswapDrift(this.store.regionState(this.region).cloudformation, activeHotswapRecord, fn.revisionId, this.clock.now()); await hotswapCheckpoint(this.store.regionState(this.region).cloudformation, "after-direct-call", activeHotswapRecord); } await this.store.save(); const output = this.configuration(this.resolve(name)); this.transition(fn, "update"); return json(res, output);
      }
      if (suffix === "/versions" && req.method === "POST") { if (qualifier && qualifier !== "$LATEST") throw new AwsError("InvalidParameterValueException", "A version cannot be published from a published version or alias"); const input = JSON.parse((await readBody(req)).toString("utf8") || "{}"); const fn = this.require(name); const operationToken = input.StackSimCloudFormationOperationToken; if (operationToken !== undefined && (typeof operationToken !== "string" || !/^[a-f0-9]{64}$/.test(operationToken))) throw new AwsError("InvalidParameterValueException", "StackSimCloudFormationOperationToken must contain 64 lowercase hexadecimal characters"); if (operationToken && input.PublishTo !== undefined) throw new AwsError("InvalidParameterValueException", "A CloudFormation operation token can publish only a numeric version"); if (operationToken) { const existing = Object.values(fn.versions!).filter(candidate => candidate.cloudFormationOperationToken === operationToken); if (existing.length > 1) throw new AwsError("ResourceConflictException", "Multiple published versions carry the same CloudFormation operation token", 409); if (existing[0]) { if (input.Description !== undefined && input.Description !== existing[0].description || input.CodeSha256 !== undefined && input.CodeSha256 !== existing[0].codeSha256) throw new AwsError("ResourceConflictException", "The CloudFormation operation token belongs to a different published version", 409); return json(res, this.configuration(this.resolve(name, existing[0].version)), 201); } } if (input.CodeSha256 !== undefined && input.CodeSha256 !== fn.codeSha256) throw new AwsError("PreconditionFailedException", "CodeSha256 does not match", 412); if (input.RevisionId && input.RevisionId !== fn.revisionId) throw new AwsError("PreconditionFailedException", "RevisionId does not match", 412); const version = this.publicationTarget(fn, input.PublishTo === undefined, input.PublishTo)!; this.publishSnapshot(fn, version, input.Description ?? fn.description, operationToken); await this.store.save(); return json(res, this.configuration(this.resolve(name, version)), 201); }
      if (suffix === "/versions" && req.method === "GET") { const fn = this.require(name); const operationToken = url.searchParams.get("stacksim-cloudformation-operation-token"); if (operationToken !== null && !/^[a-f0-9]{64}$/.test(operationToken)) throw new AwsError("InvalidParameterValueException", "Invalid CloudFormation operation token"); const versions = Object.keys(fn.versions!).filter(version => operationToken === null || fn.versions![version].cloudFormationOperationToken === operationToken).sort((a, b) => a === "$LATEST.PUBLISHED" ? -1 : b === "$LATEST.PUBLISHED" ? 1 : Number(a) - Number(b)); const values = operationToken === null ? [this.configuration(this.resolve(name)), ...versions.map(version => this.configuration(this.resolve(name, version)))] : versions.map(version => this.configuration(this.resolve(name, version))); const requestedMax = Number(url.searchParams.get("MaxItems") ?? 50); if (!Number.isInteger(requestedMax) || requestedMax < 1 || requestedMax > 10_000) throw new AwsError("InvalidParameterValueException", "MaxItems must be between 1 and 10000"); const max = Math.min(50, requestedMax); let start = 0; const marker = url.searchParams.get("Marker"); if (marker) try { const cursor = this.tokens.decode<{ functionName: string; index: number }>("ListVersionsByFunction", marker); if (cursor.functionName !== fn.functionName) throw new Error(); start = cursor.index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid Marker"); } const page = values.slice(start, start + max); const next = start + page.length; return json(res, { Versions: page, ...(next < values.length ? { NextMarker: this.tokens.encode("ListVersionsByFunction", { functionName: fn.functionName, index: next }) } : {}) }); }
      if (suffix === "/aliases" && req.method === "POST") { const input = JSON.parse((await readBody(req)).toString("utf8")); const fn = this.require(name); this.validateAlias(fn, input.Name, input.FunctionVersion, input.RoutingConfig?.AdditionalVersionWeights); if (fn.aliases![input.Name]) throw new AwsError("ResourceConflictException", "Alias already exists", 409); const alias: LambdaAliasState = { name: input.Name, functionVersion: input.FunctionVersion, description: input.Description, revisionId: id(32), additionalVersionWeights: input.RoutingConfig?.AdditionalVersionWeights ?? {} }; fn.aliases![alias.name] = alias; await this.store.save(); return json(res, this.aliasView(fn, alias), 201); }
      if (suffix === "/aliases" && req.method === "GET") { const fn = this.require(name); const functionVersion = url.searchParams.get("FunctionVersion"); if (functionVersion && !/^\d+$/.test(functionVersion)) throw new AwsError("InvalidParameterValueException", "FunctionVersion must be a published numeric version"); const values = Object.values(fn.aliases!).filter(alias => !functionVersion || alias.functionVersion === functionVersion).sort((a, b) => a.name.localeCompare(b.name)); const max = Number(url.searchParams.get("MaxItems") ?? 50); if (!Number.isInteger(max) || max < 1 || max > 10_000) throw new AwsError("InvalidParameterValueException", "MaxItems must be between 1 and 10000"); let start = 0; const marker = url.searchParams.get("Marker"); if (marker) try { const cursor = this.tokens.decode<{ functionName: string; functionVersion?: string; index: number }>("ListAliases", marker); if (cursor.functionName !== fn.functionName || cursor.functionVersion !== (functionVersion ?? undefined)) throw new Error(); start = cursor.index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid Marker"); } const page = values.slice(start, start + max); const next = start + page.length; return json(res, { Aliases: page.map(alias => this.aliasView(fn, alias)), ...(next < values.length ? { NextMarker: this.tokens.encode("ListAliases", { functionName: fn.functionName, functionVersion: functionVersion ?? undefined, index: next }) } : {}) }); }
      const aliasMatch = suffix.match(/^\/aliases\/([^/]+)$/); if (aliasMatch) { const fn = this.require(name); const alias = fn.aliases![decodeURIComponent(aliasMatch[1])]; if (!alias) throw new AwsError("ResourceNotFoundException", "Alias not found", 404); if (req.method === "GET") return json(res, this.aliasView(fn, alias)); if (req.method === "PUT") { const input = JSON.parse((await readBody(req)).toString("utf8")); if (input.RevisionId && input.RevisionId !== alias.revisionId) throw new AwsError("PreconditionFailedException", "RevisionId does not match", 412); this.validateAlias(fn, alias.name, input.FunctionVersion ?? alias.functionVersion, input.RoutingConfig?.AdditionalVersionWeights ?? alias.additionalVersionWeights); if (input.FunctionVersion) alias.functionVersion = input.FunctionVersion; if (input.Description !== undefined) alias.description = input.Description; if (input.RoutingConfig) alias.additionalVersionWeights = input.RoutingConfig.AdditionalVersionWeights ?? {}; alias.revisionId = id(32); const provisioned = fn.provisionedConcurrencyConfigs![alias.name]; if (provisioned) { provisioned.status = "IN_PROGRESS"; provisioned.allocatedProvisionedConcurrentExecutions = 0; provisioned.lastModified = new Date(this.clock.now()).toISOString(); delete provisioned.statusReason; } await this.store.save(); if (provisioned) this.scheduleProvisionedReady(fn, provisioned, 0); return json(res, this.aliasView(fn, alias)); } if (req.method === "DELETE") { if (fn.provisionedConcurrencyConfigs![alias.name]) throw new AwsError("ResourceConflictException", "Cannot delete an alias with provisioned concurrency configured", 409); if (fn.functionUrlConfigs![alias.name]) throw new AwsError("ResourceConflictException", "Cannot delete an alias with a function URL configured", 409); delete fn.aliases![alias.name]; this.eventSources.disableForFunction(fn.functionName, alias.name); await this.store.save(); res.statusCode = 204; return res.end(); } }
      if (suffix === "/policy" && req.method === "POST") { const input = JSON.parse((await readBody(req)).toString("utf8")); const fn = this.require(name); if (qualifier) this.resolve(name, qualifier); if (!input.Principal || !/^lambda:[A-Za-z*]+$/.test(input.Action ?? "")) throw new AwsError("InvalidParameterValueException", "Principal and a valid Lambda action are required"); if (input.SourceAccount && !/^\d{12}$/.test(input.SourceAccount)) throw new AwsError("InvalidParameterValueException", "SourceAccount must be a 12-digit account ID"); if (input.FunctionUrlAuthType !== undefined && !new Set(["NONE", "AWS_IAM"]).has(input.FunctionUrlAuthType)) throw new AwsError("InvalidParameterValueException", "FunctionUrlAuthType must be NONE or AWS_IAM"); if (input.InvokedViaFunctionUrl !== undefined && typeof input.InvokedViaFunctionUrl !== "boolean") throw new AwsError("InvalidParameterValueException", "InvokedViaFunctionUrl must be a boolean"); const key = qualifier ?? ""; const policy = fn.policies![key] ??= { revisionId: id(32), statements: [] }; if (input.RevisionId && input.RevisionId !== policy.revisionId) throw new AwsError("PreconditionFailedException", "RevisionId does not match", 412); if (!/^[A-Za-z0-9-_]{1,100}$/.test(input.StatementId ?? "") || policy.statements.some(statement => statement.Sid === input.StatementId)) throw new AwsError("ResourceConflictException", "The statement id already exists or is invalid", 409); const resource = qualifier ? `${fn.functionArn}:${qualifier}` : fn.functionArn; const statement: LambdaResourcePolicyState["statements"][number] = { Sid: input.StatementId, Effect: "Allow", Principal: input.Principal, Action: input.Action, Resource: resource }; const condition: Record<string, Record<string, string>> = {}; if (input.SourceArn) condition.ArnLike = { "AWS:SourceArn": input.SourceArn }; if (input.SourceAccount) (condition.StringEquals ??= {})["AWS:SourceAccount"] = input.SourceAccount; if (input.PrincipalOrgID) (condition.StringEquals ??= {})["aws:PrincipalOrgID"] = input.PrincipalOrgID; if (input.FunctionUrlAuthType) (condition.StringEquals ??= {})["lambda:FunctionUrlAuthType"] = input.FunctionUrlAuthType; if (input.InvokedViaFunctionUrl !== undefined) (condition.Bool ??= {})["lambda:InvokedViaFunctionUrl"] = String(input.InvokedViaFunctionUrl); if (Object.keys(condition).length) statement.Condition = condition; policy.statements.push(statement); policy.revisionId = id(32); await this.store.save(); return json(res, { Statement: JSON.stringify(statement), RevisionId: policy.revisionId }, 201); }
      if (suffix === "/policy" && req.method === "GET") { const fn = this.require(name); const policy = fn.policies![qualifier ?? ""]; if (!policy) throw new AwsError("ResourceNotFoundException", "The resource you requested does not exist", 404); return json(res, { Policy: JSON.stringify({ Version: "2012-10-17", Id: "default", Statement: policy.statements }), RevisionId: policy.revisionId }); }
      const policyMatch = suffix.match(/^\/policy\/([^/]+)$/); if (policyMatch && req.method === "DELETE") { const fn = this.require(name); const policy = fn.policies![qualifier ?? ""]; if (!policy) throw new AwsError("ResourceNotFoundException", "Policy not found", 404); const index = policy.statements.findIndex(statement => statement.Sid === decodeURIComponent(policyMatch[1])); if (index < 0) throw new AwsError("ResourceNotFoundException", "Statement not found", 404); const revision = url.searchParams.get("RevisionId"); if (revision && revision !== policy.revisionId) throw new AwsError("PreconditionFailedException", "RevisionId does not match", 412); policy.statements.splice(index, 1); policy.revisionId = id(32); await this.store.save(); res.statusCode = 204; return res.end(); }
      if (suffix.startsWith("/invocations") && req.method === "POST") { const invocationType = String(req.headers["x-amz-invocation-type"] ?? "RequestResponse"); if (!["RequestResponse", "Event", "DryRun"].includes(invocationType)) throw new AwsError("InvalidParameterValueException", "Invalid InvocationType"); const logType = String(req.headers["x-amz-log-type"] ?? "None"); if (!["None", "Tail"].includes(logType) || (logType === "Tail" && invocationType !== "RequestResponse")) throw new AwsError("InvalidParameterValueException", "LogType Tail is supported only for RequestResponse invocations"); const body = await readBody(req); const resolved = this.resolveInvocation(name, qualifier); const payloadLimit = invocationType === "Event" ? 1024 * 1024 : 6 * 1024 * 1024; if (body.length > payloadLimit) throw new AwsError("RequestTooLargeException", "Request payload size exceeded the invocation limit", 413); if (body.length) try { JSON.parse(body.toString("utf8")); } catch { throw new AwsError("InvalidRequestContentException", "Could not parse request body into JSON", 400); } let clientContext: unknown; const encoded = req.headers["x-amz-client-context"]; if (encoded) try { clientContext = JSON.parse(Buffer.from(String(encoded), "base64").toString("utf8")); } catch { throw new AwsError("InvalidParameterValueException", "ClientContext is not valid base64 JSON"); } const durableExecutionName = req.headers["x-amz-durable-execution-name"] === undefined ? undefined : String(req.headers["x-amz-durable-execution-name"]); const traceHeader = req.headers["x-amzn-trace-id"] === undefined ? undefined : String(req.headers["x-amzn-trace-id"]); if (durableExecutionName !== undefined && !resolved.executable.durableConfig) throw new AwsError("InvalidParameterValueException", "X-Amz-Durable-Execution-Name is valid only for durable functions"); if (resolved.executable.durableConfig) this.durableQualifier(name, qualifier ?? resolved.requestedQualifier); if (invocationType === "DryRun") { res.statusCode = 204; return res.end(); } const options = { clientContext, qualifier, lineage: principal?.lambdaLineage, durableExecutionName, traceHeader, resolvedOverride: resolved }; if (invocationType === "Event") { if (resolved.executable.durableConfig) { const result = await this.invokeDurable(resolved, body, id(24), options, "Event"); res.statusCode = 202; res.setHeader("x-amz-durable-execution-arn", result.durableExecutionArn!); res.setHeader("x-amz-executed-version", result.executedVersion); res.setHeader("x-amzn-requestid", result.requestId); return res.end(); } await this.enqueueAsync(name, qualifier, body, principal?.lambdaLineage); res.statusCode = 202; return res.end(); } const result = await this.invoke(name, body, id(24), options); res.statusCode = result.statusCode; res.setHeader("content-type", "application/json"); res.setHeader("x-amz-executed-version", result.executedVersion); res.setHeader("x-amzn-requestid", result.requestId); res.setHeader("x-stacksim-duration-ms", result.durationMs.toFixed(2)); res.setHeader("x-stacksim-billed-duration-ms", String(result.billedDurationMs)); if (result.durableExecutionArn) res.setHeader("x-amz-durable-execution-arn", result.durableExecutionArn); if (logType === "Tail") res.setHeader("x-amz-log-result", result.logResult!); if (result.functionError) res.setHeader("x-amz-function-error", result.functionError); return res.end(result.payload); }
      throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404);
    } catch (error) { if (activeHotswapRecord?.status === "PENDING") { failHotswapDrift(activeHotswapRecord, error, this.clock.now()); await this.store.save().catch(() => undefined); } sendAwsError(res, error, "rest"); }
  }
  private validateAlias(fn: LambdaState, name: string, version: string, weights: Record<string, number> = {}): void { if (!/^[A-Za-z-_][A-Za-z0-9-_]{0,127}$/.test(name ?? "") || /^\d+$/.test(name)) throw new AwsError("InvalidParameterValueException", "Invalid alias name"); if (!fn.versions?.[version]) throw new AwsError("InvalidParameterValueException", "Aliases must reference a published version"); let total = 0; for (const [candidate, weight] of Object.entries(weights)) { if (!fn.versions[candidate] || candidate === version || typeof weight !== "number" || weight < 0 || weight > 1) throw new AwsError("InvalidParameterValueException", "Invalid additional version weight"); total += weight; } if (total > 1) throw new AwsError("InvalidParameterValueException", "Additional version weights cannot exceed 1"); }
  private aliasView(fn: LambdaState, alias: LambdaAliasState): any { return { AliasArn: `${fn.functionArn}:${alias.name}`, Name: alias.name, FunctionVersion: alias.functionVersion, Description: alias.description, RevisionId: alias.revisionId, RoutingConfig: { AdditionalVersionWeights: alias.additionalVersionWeights } }; }
}
