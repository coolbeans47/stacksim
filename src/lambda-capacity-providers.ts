import type { IncomingMessage, ServerResponse } from "node:http";
import { AwsError } from "./errors.js";
import type { PrincipalContext } from "./auth/sigv4.js";
import type { Clock } from "./core/clock.js";
import { PaginationTokens } from "./core/pagination.js";
import type { Scheduler } from "./core/scheduler.js";
import { evaluateAuthorization } from "./iam/evaluator.js";
import type { StateStore } from "./state.js";
import type { LambdaCapacityProviderState, LambdaFunctionScalingConfigState, LambdaManagedInstancesCapacityProviderConfigState, LambdaState } from "./types.js";
import { json, readBody } from "./util.js";

const PROVIDER_NAME = /^[A-Za-z0-9-_]{1,64}$/;
const SUBNET_ID = /^subnet-[0-9a-f]+$/i;
const SECURITY_GROUP_ID = /^sg-[0-9a-f]+$/i;
const INSTANCE_TYPE = /^[a-z][a-z0-9-]*\.[a-z0-9-]+$/;
const ROLE_ARN = /^arn:(?:aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/[\w+=,.@\/-]{1,512}$/;
const KMS_ARN = /^arn:(?:aws|aws-us-gov|aws-cn):kms:([^:]+):(\d{12}):key\/[A-Za-z0-9-]+$/;
const LOG_GROUP = /^[.\-_/#A-Za-z0-9]+$/;

function object(value: unknown, name: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsError("InvalidParameterValueException", `${name} must be an object`);
  return value as Record<string, any>;
}

function stringMap(value: unknown, limit: number, name: string): Record<string, string> {
  if (value === undefined) return {};
  const input = object(value, name); const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) {
    if (!key || key.length > 128 || typeof item !== "string" || item.length > 256) throw new AwsError("InvalidParameterValueException", `${name} contains an invalid tag`);
    result[key] = item;
  }
  if (Object.keys(result).length > limit) throw new AwsError("InvalidParameterValueException", `${name} supports at most ${limit} tags`);
  return result;
}

export class LambdaCapacityProviders {
  private readonly transitions = new Map<string, () => void>();
  constructor(
    private readonly store: StateStore,
    private readonly region: string,
    private readonly clock: Clock,
    private readonly scheduler?: Scheduler,
    private readonly authMode: "off" | "validate" | "enforce" = "off",
    private readonly rootRecovery = false,
  ) {}

  private get state(): Record<string, LambdaCapacityProviderState> { return this.store.regionState(this.region).lambdaCapacityProviders ??= {}; }
  private get tokens(): PaginationTokens { return new PaginationTokens(this.store.state.installation.paginationSecret); }
  private arn(name: string): string { return `arn:aws:lambda:${this.region}:${this.store.accountId}:capacity-provider:${name}`; }

  private require(name: string): LambdaCapacityProviderState {
    const provider = this.state[decodeURIComponent(name)];
    if (!provider) throw new AwsError("ResourceNotFoundException", `Capacity provider not found: ${decodeURIComponent(name)}`, 404);
    provider.tags ??= {};
    return provider;
  }

  findByArn(arn: string): LambdaCapacityProviderState | undefined { return Object.values(this.state).find(provider => provider.capacityProviderArn === arn); }
  tagsForArn(arn: string): Record<string, string> | undefined { return this.findByArn(arn)?.tags; }

  view(provider: LambdaCapacityProviderState): any {
    return {
      CapacityProviderArn: provider.capacityProviderArn,
      State: provider.state,
      VpcConfig: { SubnetIds: provider.vpcConfig.subnetIds, SecurityGroupIds: provider.vpcConfig.securityGroupIds },
      PermissionsConfig: { CapacityProviderOperatorRoleArn: provider.permissionsConfig.capacityProviderOperatorRoleArn },
      ...(provider.instanceRequirements ? { InstanceRequirements: { ...(provider.instanceRequirements.architectures ? { Architectures: provider.instanceRequirements.architectures } : {}), ...(provider.instanceRequirements.allowedInstanceTypes ? { AllowedInstanceTypes: provider.instanceRequirements.allowedInstanceTypes } : {}), ...(provider.instanceRequirements.excludedInstanceTypes ? { ExcludedInstanceTypes: provider.instanceRequirements.excludedInstanceTypes } : {}) } } : {}),
      ...(provider.capacityProviderScalingConfig ? { CapacityProviderScalingConfig: { ...(provider.capacityProviderScalingConfig.maxVCpuCount !== undefined ? { MaxVCpuCount: provider.capacityProviderScalingConfig.maxVCpuCount } : {}), ...(provider.capacityProviderScalingConfig.scalingMode ? { ScalingMode: provider.capacityProviderScalingConfig.scalingMode } : {}), ...(provider.capacityProviderScalingConfig.scalingPolicies ? { ScalingPolicies: provider.capacityProviderScalingConfig.scalingPolicies.map(policy => ({ PredefinedMetricType: policy.predefinedMetricType, TargetValue: policy.targetValue })) } : {}) } } : {}),
      ...(provider.kmsKeyArn ? { KmsKeyArn: provider.kmsKeyArn } : {}),
      LastModified: provider.lastModified,
      ...(provider.propagateTags ? { PropagateTags: { ...(provider.propagateTags.mode ? { Mode: provider.propagateTags.mode } : {}), ...(provider.propagateTags.explicitTags ? { ExplicitTags: provider.propagateTags.explicitTags } : {}) } } : {}),
      ...(provider.telemetryConfig ? { TelemetryConfig: { ...(provider.telemetryConfig.loggingConfig ? { LoggingConfig: { ...(provider.telemetryConfig.loggingConfig.systemLogLevel ? { SystemLogLevel: provider.telemetryConfig.loggingConfig.systemLogLevel } : {}), ...(provider.telemetryConfig.loggingConfig.logGroup ? { LogGroup: provider.telemetryConfig.loggingConfig.logGroup } : {}) } } : {}) } } : {}),
    };
  }

  assignmentView(config?: LambdaManagedInstancesCapacityProviderConfigState): any | undefined {
    if (!config) return undefined;
    return { LambdaManagedInstancesCapacityProviderConfig: { CapacityProviderArn: config.capacityProviderArn, ...(config.executionEnvironmentMemoryGiBPerVCpu !== undefined ? { ExecutionEnvironmentMemoryGiBPerVCpu: config.executionEnvironmentMemoryGiBPerVCpu } : {}), ...(config.perExecutionEnvironmentMaxConcurrency !== undefined ? { PerExecutionEnvironmentMaxConcurrency: config.perExecutionEnvironmentMaxConcurrency } : {}) } };
  }

  validateAssignment(input: unknown, current: LambdaManagedInstancesCapacityProviderConfigState | undefined, principal?: PrincipalContext): LambdaManagedInstancesCapacityProviderConfigState | undefined {
    if (input === undefined) return current ? structuredClone(current) : undefined;
    const outer = object(input, "CapacityProviderConfig");
    if (Object.keys(outer).some(key => key !== "LambdaManagedInstancesCapacityProviderConfig")) throw new AwsError("InvalidParameterValueException", "CapacityProviderConfig contains an unsupported field");
    const managed = object(outer.LambdaManagedInstancesCapacityProviderConfig, "LambdaManagedInstancesCapacityProviderConfig");
    const arn = managed.CapacityProviderArn;
    if (typeof arn !== "string") throw new AwsError("InvalidParameterValueException", "CapacityProviderArn is required");
    const provider = this.findByArn(arn);
    if (!provider) throw new AwsError("ResourceNotFoundException", `Capacity provider not found: ${arn}`, 404);
    if (provider.state !== "Active") throw new AwsError("ResourceConflictException", "The capacity provider must be Active before it can be assigned", 409);
    const memory = managed.ExecutionEnvironmentMemoryGiBPerVCpu;
    if (memory !== undefined && (!Number.isInteger(memory) || memory < 2 || memory > 8)) throw new AwsError("InvalidParameterValueException", "ExecutionEnvironmentMemoryGiBPerVCpu must be between 2 and 8");
    const concurrency = managed.PerExecutionEnvironmentMaxConcurrency;
    if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 1600)) throw new AwsError("InvalidParameterValueException", "PerExecutionEnvironmentMaxConcurrency must be between 1 and 1600");
    if (this.authMode === "enforce" && principal) {
      const bootstrap = this.rootRecovery && principal.principalType === "root";
      const decision = bootstrap ? "allowed" : evaluateAuthorization(this.store.ensureAccount().iam, principal, "lambda:PassCapacityProvider", arn, {}).decision;
      if (decision !== "allowed") throw new AwsError("AccessDeniedException", `User ${principal.principalArn} is not authorized to perform lambda:PassCapacityProvider on ${arn}`, 403);
    }
    if (current?.capacityProviderArn !== arn && this.attachments(provider).length >= 100) throw new AwsError("ServiceException", "The capacity provider supports at most 100 attached function versions", 400);
    return { capacityProviderArn: arn, ...(memory !== undefined ? { executionEnvironmentMemoryGiBPerVCpu: memory } : {}), ...(concurrency !== undefined ? { perExecutionEnvironmentMaxConcurrency: concurrency } : {}) };
  }

  assertPublishCapacity(fn: LambdaState): void {
    const config = fn.capacityProviderConfig;
    if (!config) throw new AwsError("InvalidParameterValueException", "LATEST_PUBLISHED is available only to a function assigned to an active Lambda Managed Instances capacity provider");
    const provider = this.findByArn(config.capacityProviderArn);
    if (!provider || provider.state !== "Active") throw new AwsError("ResourceConflictException", "The assigned capacity provider is not Active", 409);
  }

  assertSnapshotQuota(fn: LambdaState): void {
    const arn = fn.capacityProviderConfig?.capacityProviderArn; if (!arn) return;
    const provider = this.findByArn(arn); if (!provider) throw new AwsError("ResourceNotFoundException", "The assigned capacity provider no longer exists", 404);
    if (this.attachments(provider).length >= 100) throw new AwsError("ServiceException", "The capacity provider supports at most 100 attached function versions", 400);
  }

  private validateVpc(value: unknown): LambdaCapacityProviderState["vpcConfig"] {
    const input = object(value, "VpcConfig"); const subnets = input.SubnetIds; const groups = input.SecurityGroupIds;
    if (!Array.isArray(subnets) || subnets.length < 1 || subnets.length > 16 || subnets.some(item => typeof item !== "string" || !SUBNET_ID.test(item)) || new Set(subnets).size !== subnets.length) throw new AwsError("InvalidParameterValueException", "VpcConfig.SubnetIds must contain 1-16 unique subnet IDs");
    if (!Array.isArray(groups) || groups.length > 5 || groups.some(item => typeof item !== "string" || !SECURITY_GROUP_ID.test(item)) || new Set(groups).size !== groups.length) throw new AwsError("InvalidParameterValueException", "VpcConfig.SecurityGroupIds must contain up to 5 unique security group IDs");
    return { subnetIds: [...subnets], securityGroupIds: [...groups] };
  }

  private validatePermissions(value: unknown): LambdaCapacityProviderState["permissionsConfig"] {
    const input = object(value, "PermissionsConfig"); const arn = input.CapacityProviderOperatorRoleArn; const match = typeof arn === "string" ? arn.match(ROLE_ARN) : undefined;
    if (!match || match[1] !== this.store.accountId) throw new AwsError("InvalidParameterValueException", "CapacityProviderOperatorRoleArn must be an IAM role ARN in this account");
    return { capacityProviderOperatorRoleArn: arn };
  }

  private validateInstanceRequirements(value: unknown): LambdaCapacityProviderState["instanceRequirements"] {
    if (value === undefined) return undefined; const input = object(value, "InstanceRequirements"); const architectures = input.Architectures;
    if (!Array.isArray(architectures) || architectures.length !== 1 || !new Set(["x86_64", "arm64"]).has(architectures[0])) throw new AwsError("InvalidParameterValueException", "InstanceRequirements.Architectures must contain exactly one architecture");
    const allowed = input.AllowedInstanceTypes; const excluded = input.ExcludedInstanceTypes;
    if ((allowed === undefined) === (excluded === undefined)) throw new AwsError("InvalidParameterValueException", "Specify exactly one of AllowedInstanceTypes or ExcludedInstanceTypes");
    const list = allowed ?? excluded;
    if (!Array.isArray(list) || list.length > 400 || list.some((item: unknown) => typeof item !== "string" || !INSTANCE_TYPE.test(item)) || new Set(list).size !== list.length) throw new AwsError("InvalidParameterValueException", "Instance type lists support up to 400 unique EC2 instance type names");
    return { architectures: [...architectures], ...(allowed !== undefined ? { allowedInstanceTypes: [...allowed] } : { excludedInstanceTypes: [...excluded] }) };
  }

  private validateScaling(value: unknown): LambdaCapacityProviderState["capacityProviderScalingConfig"] {
    if (value === undefined) return undefined; const input = object(value, "CapacityProviderScalingConfig");
    if (input.ScalingMode !== undefined && !new Set(["Auto", "Manual"]).has(input.ScalingMode)) throw new AwsError("InvalidParameterValueException", "ScalingMode must be Auto or Manual");
    if (input.MaxVCpuCount !== undefined && (!Number.isInteger(input.MaxVCpuCount) || input.MaxVCpuCount < 2 || input.MaxVCpuCount > 15000)) throw new AwsError("InvalidParameterValueException", "MaxVCpuCount must be between 2 and 15000");
    let policies: NonNullable<LambdaCapacityProviderState["capacityProviderScalingConfig"]>["scalingPolicies"];
    if (input.ScalingPolicies !== undefined) {
      if (!Array.isArray(input.ScalingPolicies) || input.ScalingPolicies.length < 1 || input.ScalingPolicies.length > 10) throw new AwsError("InvalidParameterValueException", "ScalingPolicies must contain 1-10 policies");
      policies = input.ScalingPolicies.map((raw: unknown) => { const policy = object(raw, "TargetTrackingScalingPolicy"); if (policy.PredefinedMetricType !== "LambdaCapacityProviderAverageCPUUtilization") throw new AwsError("InvalidParameterValueException", "Unsupported capacity provider metric type"); if (typeof policy.TargetValue !== "number" || !Number.isFinite(policy.TargetValue) || policy.TargetValue < 0 || policy.TargetValue > 100) throw new AwsError("InvalidParameterValueException", "TargetValue must be between 0 and 100"); return { predefinedMetricType: policy.PredefinedMetricType, targetValue: policy.TargetValue }; });
    }
    return { ...(input.MaxVCpuCount !== undefined ? { maxVCpuCount: input.MaxVCpuCount } : {}), ...(input.ScalingMode !== undefined ? { scalingMode: input.ScalingMode } : {}), ...(policies ? { scalingPolicies: policies } : {}) };
  }

  private validatePropagation(value: unknown): LambdaCapacityProviderState["propagateTags"] {
    if (value === undefined) return undefined; const input = object(value, "PropagateTags");
    if (input.Mode !== undefined && !new Set(["None", "Explicit"]).has(input.Mode)) throw new AwsError("InvalidParameterValueException", "PropagateTags.Mode must be None or Explicit");
    const explicit = input.ExplicitTags === undefined ? undefined : stringMap(input.ExplicitTags, 40, "ExplicitTags");
    if (input.Mode === "None" && explicit !== undefined) throw new AwsError("InvalidParameterValueException", "ExplicitTags cannot be used when propagation mode is None");
    if (input.Mode !== "Explicit" && explicit !== undefined) throw new AwsError("InvalidParameterValueException", "ExplicitTags requires propagation mode Explicit");
    return { ...(input.Mode !== undefined ? { mode: input.Mode } : {}), ...(explicit !== undefined ? { explicitTags: explicit } : {}) };
  }

  private validateTelemetry(value: unknown): LambdaCapacityProviderState["telemetryConfig"] {
    if (value === undefined) return undefined; const input = object(value, "TelemetryConfig"); if (input.LoggingConfig === undefined) return {};
    const logging = object(input.LoggingConfig, "TelemetryConfig.LoggingConfig");
    if (logging.SystemLogLevel !== undefined && !new Set(["DEBUG", "INFO", "WARN"]).has(logging.SystemLogLevel)) throw new AwsError("InvalidParameterValueException", "SystemLogLevel must be DEBUG, INFO, or WARN");
    if (logging.LogGroup !== undefined && (typeof logging.LogGroup !== "string" || logging.LogGroup.length < 1 || logging.LogGroup.length > 512 || !LOG_GROUP.test(logging.LogGroup) || logging.LogGroup.startsWith("aws/"))) throw new AwsError("InvalidParameterValueException", "Invalid capacity provider log group name");
    return { loggingConfig: { ...(logging.SystemLogLevel !== undefined ? { systemLogLevel: logging.SystemLogLevel } : {}), ...(logging.LogGroup !== undefined ? { logGroup: logging.LogGroup } : {}) } };
  }

  private validateKms(value: unknown): string | undefined {
    if (value === undefined) return undefined; const match = typeof value === "string" ? value.match(KMS_ARN) : undefined;
    if (!match || match[1] !== this.region || match[2] !== this.store.accountId) throw new AwsError("InvalidParameterValueException", "KmsKeyArn must be a KMS key ARN in this account and Region");
    return value as string;
  }

  private attachments(provider: LambdaCapacityProviderState): Array<{ functionArn: string; state: "Pending" | "Active" | "Failed" | "Inactive" }> {
    const result: Array<{ functionArn: string; state: "Pending" | "Active" | "Failed" | "Inactive" }> = [];
    for (const fn of Object.values(this.store.regionState(this.region).functions)) {
      const state = fn.state ?? "Active";
      if (fn.capacityProviderConfig?.capacityProviderArn === provider.capacityProviderArn) result.push({ functionArn: `${fn.functionArn}:$LATEST`, state });
      for (const [version, snapshot] of Object.entries(fn.versions ?? {})) if (snapshot.capacityProviderConfig?.capacityProviderArn === provider.capacityProviderArn) result.push({ functionArn: `${fn.functionArn}:${version}`, state });
    }
    return result.sort((left, right) => left.functionArn.localeCompare(right.functionArn));
  }

  private schedule(provider: LambdaCapacityProviderState, delayMs = 50): void {
    this.transitions.get(provider.capacityProviderName)?.();
    const complete = async () => {
      this.transitions.delete(provider.capacityProviderName);
      if (this.state[provider.capacityProviderName] !== provider) return;
      if (provider.state === "Deleting") delete this.state[provider.capacityProviderName];
      else if (provider.state === "Pending") provider.state = "Active";
      await this.store.save();
    };
    if (this.scheduler) this.transitions.set(provider.capacityProviderName, this.scheduler.schedule(complete, delayMs));
    else { const handle = this.clock.setTimeout(() => void complete(), delayMs); this.transitions.set(provider.capacityProviderName, () => this.clock.clearTimeout(handle)); }
  }

  start(): void {
    let recovered = false;
    for (const provider of Object.values(this.state)) {
      if (provider.state === "Pending") { provider.state = "Active"; recovered = true; }
      else if (provider.state === "Deleting") { delete this.state[provider.capacityProviderName]; recovered = true; }
    }
    if (recovered) void this.store.save();
  }

  stop(): void { for (const cancel of this.transitions.values()) cancel(); this.transitions.clear(); }

  private resolveScalingQualifier(fn: LambdaState, qualifier: string | null): string {
    if (!qualifier) throw new AwsError("InvalidParameterValueException", "Qualifier is required");
    if (qualifier === "$LATEST.PUBLISHED") { if (!fn.versions?.[qualifier]) throw new AwsError("ResourceNotFoundException", `Function version not found: ${qualifier}`, 404); return qualifier; }
    if (fn.aliases?.[qualifier]) return qualifier;
    if (/^\d+$/.test(qualifier) && fn.versions?.[qualifier]) return qualifier;
    throw new AwsError("ResourceNotFoundException", `Function version or alias not found: ${qualifier}`, 404);
  }

  private scalingExecutable(fn: LambdaState, qualifier: string): LambdaManagedInstancesCapacityProviderConfigState | undefined {
    const version = fn.aliases?.[qualifier]?.functionVersion ?? qualifier;
    return fn.versions?.[version]?.capacityProviderConfig;
  }

  private scalingView(fn: LambdaState, config: LambdaFunctionScalingConfigState): any {
    const values = { ...(config.minExecutionEnvironments !== undefined ? { MinExecutionEnvironments: config.minExecutionEnvironments } : {}), ...(config.maxExecutionEnvironments !== undefined ? { MaxExecutionEnvironments: config.maxExecutionEnvironments } : {}) };
    return { FunctionArn: `${fn.functionArn}:${config.qualifier}`, AppliedFunctionScalingConfig: values, RequestedFunctionScalingConfig: values };
  }

  private async handleScaling(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<boolean> {
    const match = pathname.match(/^\/2025-11-30\/functions\/([^/]+)\/function-scaling-config$/); if (!match) return false;
    const name = decodeURIComponent(match[1]); const fn = this.store.regionState(this.region).functions[name]; if (!fn) throw new AwsError("ResourceNotFoundException", `Function not found: ${name}`, 404);
    fn.functionScalingConfigs ??= {}; const qualifier = this.resolveScalingQualifier(fn, url.searchParams.get("Qualifier"));
    if (!this.scalingExecutable(fn, qualifier)) throw new AwsError("InvalidParameterValueException", "Function scaling configuration requires a published Lambda Managed Instances function version");
    if (req.method === "GET") { const config = fn.functionScalingConfigs[qualifier]; if (!config) throw new AwsError("ResourceNotFoundException", "Function scaling configuration not found", 404); json(res, this.scalingView(fn, config)); return true; }
    if (req.method === "PUT") {
      const input = JSON.parse((await readBody(req)).toString("utf8") || "{}"); const scaling = object(input.FunctionScalingConfig ?? {}, "FunctionScalingConfig"); const min = scaling.MinExecutionEnvironments; const max = scaling.MaxExecutionEnvironments;
      for (const [key, value] of [["MinExecutionEnvironments", min], ["MaxExecutionEnvironments", max]] as const) if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 15000)) throw new AwsError("InvalidParameterValueException", `${key} must be between 0 and 15000`);
      if (min !== undefined && max !== undefined && min > max) throw new AwsError("InvalidParameterValueException", "MinExecutionEnvironments cannot exceed MaxExecutionEnvironments");
      fn.functionScalingConfigs[qualifier] = { qualifier, ...(min !== undefined ? { minExecutionEnvironments: min } : {}), ...(max !== undefined ? { maxExecutionEnvironments: max } : {}) }; await this.store.save(); json(res, { FunctionState: fn.state ?? "Active" }, 202); return true;
    }
    throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404);
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<boolean> {
    if (await this.handleScaling(req, res, pathname, url)) return true;
    const collection = "/2025-11-30/capacity-providers"; if (!pathname.startsWith(collection)) return false;
    if (pathname === collection) {
      if (req.method === "POST") {
        const input = JSON.parse((await readBody(req)).toString("utf8") || "{}"); const name = input.CapacityProviderName;
        if (typeof name !== "string" || !PROVIDER_NAME.test(name)) throw new AwsError("InvalidParameterValueException", "CapacityProviderName must be 1-64 letters, numbers, hyphens, or underscores");
        if (this.state[name]) throw new AwsError("ResourceConflictException", `Capacity provider already exists: ${name}`, 409);
        if (Object.keys(this.state).length >= 1000) throw new AwsError("ServiceException", "The account supports at most 1000 capacity providers", 400);
        const provider: LambdaCapacityProviderState = { capacityProviderName: name, capacityProviderArn: this.arn(name), state: "Pending", vpcConfig: this.validateVpc(input.VpcConfig), permissionsConfig: this.validatePermissions(input.PermissionsConfig), ...(input.InstanceRequirements !== undefined ? { instanceRequirements: this.validateInstanceRequirements(input.InstanceRequirements) } : {}), ...(input.CapacityProviderScalingConfig !== undefined ? { capacityProviderScalingConfig: this.validateScaling(input.CapacityProviderScalingConfig) } : {}), ...(input.KmsKeyArn !== undefined ? { kmsKeyArn: this.validateKms(input.KmsKeyArn) } : {}), tags: stringMap(input.Tags, 50, "Tags"), ...(input.PropagateTags !== undefined ? { propagateTags: this.validatePropagation(input.PropagateTags) } : {}), ...(input.TelemetryConfig !== undefined ? { telemetryConfig: this.validateTelemetry(input.TelemetryConfig) } : {}), lastModified: new Date(this.clock.now()).toISOString() };
        this.state[name] = provider; await this.store.save(); this.schedule(provider); json(res, { CapacityProvider: this.view(provider) }, 202); return true;
      }
      if (req.method === "GET") {
        const state = url.searchParams.get("State"); if (state && !new Set(["Pending", "Active", "Failed", "Deleting"]).has(state)) throw new AwsError("InvalidParameterValueException", "Invalid capacity provider State filter");
        const max = Number(url.searchParams.get("MaxItems") ?? 50); if (!Number.isInteger(max) || max < 1 || max > 50) throw new AwsError("InvalidParameterValueException", "MaxItems must be between 1 and 50");
        const values = Object.values(this.state).filter(provider => !state || provider.state === state).sort((left, right) => left.capacityProviderName.localeCompare(right.capacityProviderName)); let start = 0; const marker = url.searchParams.get("Marker");
        if (marker) try { const cursor = this.tokens.decode<{ state?: string; index: number }>("ListCapacityProviders", marker); if (cursor.state !== (state ?? undefined) || !Number.isInteger(cursor.index) || cursor.index < 0) throw new Error(); start = cursor.index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid Marker"); }
        const page = values.slice(start, start + max); const next = start + page.length; json(res, { CapacityProviders: page.map(provider => this.view(provider)), ...(next < values.length ? { NextMarker: this.tokens.encode("ListCapacityProviders", { state: state ?? undefined, index: next }) } : {}) }); return true;
      }
      throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404);
    }
    const match = pathname.match(/^\/2025-11-30\/capacity-providers\/([^/]+)(\/function-versions)?$/); if (!match) throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404); const provider = this.require(match[1]);
    if (match[2]) {
      if (req.method !== "GET") throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404); const max = Number(url.searchParams.get("MaxItems") ?? 50); if (!Number.isInteger(max) || max < 1 || max > 50) throw new AwsError("InvalidParameterValueException", "MaxItems must be between 1 and 50"); const values = this.attachments(provider); let start = 0; const marker = url.searchParams.get("Marker");
      if (marker) try { const cursor = this.tokens.decode<{ arn: string; index: number }>("ListFunctionVersionsByCapacityProvider", marker); if (cursor.arn !== provider.capacityProviderArn || !Number.isInteger(cursor.index) || cursor.index < 0) throw new Error(); start = cursor.index; } catch { throw new AwsError("InvalidParameterValueException", "Invalid Marker"); }
      const page = values.slice(start, start + max); const next = start + page.length; json(res, { CapacityProviderArn: provider.capacityProviderArn, FunctionVersions: page.map(item => ({ FunctionArn: item.functionArn, State: item.state })), ...(next < values.length ? { NextMarker: this.tokens.encode("ListFunctionVersionsByCapacityProvider", { arn: provider.capacityProviderArn, index: next }) } : {}) }); return true;
    }
    if (req.method === "GET") { json(res, { CapacityProvider: this.view(provider) }); return true; }
    if (req.method === "PUT") {
      if (provider.state === "Deleting") throw new AwsError("ResourceConflictException", "The capacity provider is being deleted", 409); const input = JSON.parse((await readBody(req)).toString("utf8") || "{}"); const allowed = new Set(["CapacityProviderScalingConfig", "PropagateTags", "TelemetryConfig"]); if (Object.keys(input).some(key => !allowed.has(key))) throw new AwsError("InvalidParameterValueException", "Only scaling, tag propagation, and telemetry can be updated");
      if (input.CapacityProviderScalingConfig !== undefined) provider.capacityProviderScalingConfig = this.validateScaling(input.CapacityProviderScalingConfig); if (input.PropagateTags !== undefined) provider.propagateTags = this.validatePropagation(input.PropagateTags); if (input.TelemetryConfig !== undefined) provider.telemetryConfig = this.validateTelemetry(input.TelemetryConfig); provider.state = "Pending"; provider.lastModified = new Date(this.clock.now()).toISOString(); await this.store.save(); this.schedule(provider); json(res, { CapacityProvider: this.view(provider) }, 202); return true;
    }
    if (req.method === "DELETE") {
      if (this.attachments(provider).length) throw new AwsError("ResourceConflictException", "The capacity provider is attached to one or more function versions", 409); provider.state = "Deleting"; provider.lastModified = new Date(this.clock.now()).toISOString(); await this.store.save(); this.schedule(provider); json(res, { CapacityProvider: this.view(provider) }, 202); return true;
    }
    throw new AwsError("ResourceNotFoundException", "Unknown Lambda route", 404);
  }
}
