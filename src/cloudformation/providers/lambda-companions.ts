import { providerValidationPathSegments } from "./contract.js";
import { createHash } from "node:crypto";
import type { LambdaService } from "../../lambda.js";
import { AwsError } from "../../errors.js";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderInProgress,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderSuccess,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";
import { invokeJsonService } from "./service-invoker.js";

export const LAMBDA_PERMISSION_TYPE = "AWS::Lambda::Permission";
export const LAMBDA_VERSION_TYPE = "AWS::Lambda::Version";
export const LAMBDA_ALIAS_TYPE = "AWS::Lambda::Alias";

interface PermissionModel {
  readonly Action: string;
  readonly FunctionName: string;
  readonly Principal: string;
  readonly SourceArn?: string;
  readonly SourceAccount?: string;
  readonly FunctionUrlAuthType?: "AWS_IAM" | "NONE";
  readonly InvokedViaFunctionUrl?: boolean;
}
interface ProvisionedConcurrencyModel { readonly ProvisionedConcurrentExecutions: number }
interface VersionModel {
  readonly FunctionName: string;
  readonly CodeSha256?: string;
  readonly Description?: string;
  readonly ProvisionedConcurrencyConfig?: ProvisionedConcurrencyModel;
}
interface AliasWeight { readonly FunctionVersion: string; readonly FunctionWeight: number }
interface AliasModel {
  readonly FunctionName: string;
  readonly FunctionVersion: string;
  readonly Name: string;
  readonly Description?: string;
  readonly ProvisionedConcurrencyConfig?: ProvisionedConcurrencyModel;
  readonly RoutingConfig?: { readonly AdditionalVersionWeights: readonly AliasWeight[] };
}

const retention = Object.freeze({ deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const), updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const), snapshotSupported: false });
const SUPPORTED_LOCAL_INVOCATION_PRINCIPALS: ReadonlySet<string> = new Set([
  "apigateway.amazonaws.com",
  "cognito-idp.amazonaws.com",
  "events.amazonaws.com",
  "s3.amazonaws.com",
  "secretsmanager.amazonaws.com",
  "sns.amazonaws.com",
]);
export const LAMBDA_PERMISSION_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LAMBDA_PERMISSION_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    Action: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    FunctionName: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Principal: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    SourceArn: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    SourceAccount: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    FunctionUrlAuthType: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    InvokedViaFunctionUrl: Object.freeze({ valueType: "boolean", updateBehavior: "REPLACEMENT" }),
  }),
  ref: Object.freeze({ supported: false, description: "The Lambda permission resource has no documented Ref return value." }), attributes: Object.freeze({}), replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention, tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});
export const LAMBDA_VERSION_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LAMBDA_VERSION_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    FunctionName: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    CodeSha256: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    Description: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    ProvisionedConcurrencyConfig: Object.freeze({ valueType: "object", updateBehavior: "REPLACEMENT" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Qualified function version ARN" }), attributes: Object.freeze({ FunctionArn: Object.freeze({ valueType: "string" }), Version: Object.freeze({ valueType: "string" }) }), replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention, tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});
export const LAMBDA_ALIAS_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LAMBDA_ALIAS_TYPE, unknownProperties: "REJECT",
  properties: Object.freeze({
    FunctionName: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    FunctionVersion: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    Name: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    Description: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    ProvisionedConcurrencyConfig: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    RoutingConfig: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Alias ARN" }), attributes: Object.freeze({ AliasArn: Object.freeze({ valueType: "string" }) }), replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }), retention, tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function failed<Model>(error: unknown, physicalId?: string): ProviderUpdateResult<Model> {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500, ...(physicalId ? { physicalId } : {}) };
}
function notFound(error: unknown): boolean { return error instanceof AwsError && error.code === "ResourceNotFoundException"; }
function provisionedNotFound(error: unknown): boolean { return error instanceof AwsError && error.code === "ProvisionedConcurrencyConfigNotFoundException"; }
function planImmutable<Model extends object>(previous: Model | undefined, desired: Model): ProviderPlan<Model> {
  if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
  const changed = [...new Set([...Object.keys(previous), ...Object.keys(desired)])].filter(key => !same((previous as any)[key], (desired as any)[key])).sort();
  return changed.length ? { action: "REPLACE", desired, changedProperties: changed, replacementProperties: changed, replacementOrder: "CREATE_BEFORE_DELETE" } : { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
}
function invoker(lambda: LambdaService) {
  return <T>(context: ProviderContext, method: string, path: string, input?: unknown) => invokeJsonService<T>({ method, path, input, handle: (req, res, pathname, url) => lambda.handle(req, res, pathname, url, context.principal.identity) });
}

function provisionedConcurrencyIssues(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (value === undefined) return;
  if (!record(value)) {
    issues.push({ code: "InvalidType", path, pathSegments: providerValidationPathSegments(path), message: "ProvisionedConcurrencyConfig must be an object" });
    return;
  }
  for (const key of Object.keys(value)) {
    if (key !== "ProvisionedConcurrentExecutions") issues.push({ code: "UnsupportedProperty", path: `${path}.${key}`, pathSegments: providerValidationPathSegments(`${path}.${key}`), message: `ProvisionedConcurrencyConfig does not support ${key}` });
  }
  if (value.ProvisionedConcurrentExecutions === undefined) {
    issues.push({ code: "MissingRequiredProperty", path: `${path}.ProvisionedConcurrentExecutions`, pathSegments: providerValidationPathSegments(`${path}.ProvisionedConcurrentExecutions`), message: "ProvisionedConcurrentExecutions is required" });
  } else if (typeof value.ProvisionedConcurrentExecutions !== "number" || !Number.isInteger(value.ProvisionedConcurrentExecutions) || value.ProvisionedConcurrentExecutions < 1) {
    issues.push({ code: "InvalidProperty", path: `${path}.ProvisionedConcurrentExecutions`, pathSegments: providerValidationPathSegments(`${path}.ProvisionedConcurrentExecutions`), message: "ProvisionedConcurrentExecutions must be an integer of at least 1" });
  }
}

function provisionedConcurrency(value: unknown): ProvisionedConcurrencyModel | undefined {
  if (value === undefined) return undefined;
  return { ProvisionedConcurrentExecutions: (value as Record<string, number>).ProvisionedConcurrentExecutions };
}

function provisionedPath(functionName: string, qualifier: string): string {
  return `/2019-09-30/functions/${encodeURIComponent(functionName)}/provisioned-concurrency?Qualifier=${encodeURIComponent(qualifier)}`;
}

async function readProvisioned(
  invoke: ReturnType<typeof invoker>,
  context: ProviderContext,
  functionName: string,
  qualifier: string,
): Promise<any | undefined> {
  try {
    return (await invoke<any>(context, "GET", provisionedPath(functionName, qualifier))).body;
  } catch (error) {
    if (provisionedNotFound(error)) return undefined;
    throw error;
  }
}

async function reconcileProvisioned(
  invoke: ReturnType<typeof invoker>,
  context: ProviderContext,
  functionName: string,
  qualifier: string,
  desired: ProvisionedConcurrencyModel | undefined,
): Promise<"READY" | "IN_PROGRESS"> {
  const current = await readProvisioned(invoke, context, functionName, qualifier);
  if (!desired) {
    if (current) {
      try {
        await invoke(context, "DELETE", provisionedPath(functionName, qualifier));
      } catch (error) {
        if (!provisionedNotFound(error)) throw error;
      }
    }
    return "READY";
  }
  const requested = desired.ProvisionedConcurrentExecutions;
  if (!current || current.RequestedProvisionedConcurrentExecutions !== requested) {
    await invoke(context, "PUT", provisionedPath(functionName, qualifier), { ProvisionedConcurrentExecutions: requested });
    return "IN_PROGRESS";
  }
  if (current.Status === "READY") return "READY";
  if (current.Status === "FAILED") {
    throw new AwsError("ProvisionedConcurrencyConfigFailed", String(current.StatusReason ?? `Provisioned concurrency failed for ${functionName}:${qualifier}`), 400);
  }
  if (current.Status !== "IN_PROGRESS") {
    throw new AwsError("InternalFailure", `Lambda returned unknown provisioned concurrency status ${String(current.Status)}`, 500);
  }
  return "IN_PROGRESS";
}

async function removeProvisioned(
  invoke: ReturnType<typeof invoker>,
  context: ProviderContext,
  functionName: string,
  qualifier: string,
): Promise<void> {
  const current = await readProvisioned(invoke, context, functionName, qualifier);
  if (!current) return;
  try {
    await invoke(context, "DELETE", provisionedPath(functionName, qualifier));
  } catch (error) {
    if (!provisionedNotFound(error)) throw error;
  }
}

export function createLambdaPermissionProvider(lambda: LambdaService): ProductionResourceProvider<PermissionModel> {
  const invoke = invoker(lambda);
  // A permission replacement must coexist with the old statement until the
  // executor reaches replace-delete. The operation/step-scoped idempotency key
  // is stable across retries and restarts, but differs for replacement and
  // rollback creates, so each physical permission receives its own SID.
  const statementId = (context: ProviderContext): string => {
    const prefix = (context.logicalId.replace(/[^A-Za-z0-9-_]/g, "-") || "Permission").slice(0, 64);
    const suffix = createHash("sha256").update(`${context.stackId}\0${context.logicalId}\0${context.idempotencyKey}`).digest("hex").slice(0, 32);
    return `${prefix}-${suffix}`;
  };
  const physicalId = (desired: PermissionModel, sid: string): string => `${desired.FunctionName}/${sid}`;
  const success = (desired: PermissionModel, sid: string): ProviderSuccess<PermissionModel> => {
    const id = physicalId(desired, sid);
    return { status: "SUCCESS", physicalId: id, model: { physicalId: id, properties: desired, attributes: {} } };
  };
  const parsePhysicalId = (id: string): { functionName: string; sid: string } => {
    const separator = id.lastIndexOf("/");
    if (separator <= 0 || separator === id.length - 1) throw new AwsError("ResourceNotFoundException", `Invalid Lambda permission physical ID ${id}`, 404);
    return { functionName: id.slice(0, separator), sid: id.slice(separator + 1) };
  };
  const stableJson = (value: unknown): string => JSON.stringify(record(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, record(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item]))
    : value);
  const expectedCondition = (desired: PermissionModel): Record<string, Record<string, string>> => ({
    ...(desired.SourceArn ? { ArnLike: { "AWS:SourceArn": desired.SourceArn } } : {}),
    ...(desired.SourceAccount || desired.FunctionUrlAuthType ? { StringEquals: {
      ...(desired.SourceAccount ? { "AWS:SourceAccount": desired.SourceAccount } : {}),
      ...(desired.FunctionUrlAuthType ? { "lambda:FunctionUrlAuthType": desired.FunctionUrlAuthType } : {}),
    } } : {}),
    ...(desired.InvokedViaFunctionUrl !== undefined ? { Bool: { "lambda:InvokedViaFunctionUrl": String(desired.InvokedViaFunctionUrl) } } : {}),
  });
  const statementProperties = (functionName: string, statement: any): PermissionModel => ({
    Action: String(statement.Action),
    FunctionName: functionName,
    Principal: typeof statement.Principal === "string" ? statement.Principal : String(statement.Principal?.Service ?? statement.Principal?.AWS ?? ""),
    ...(statement.Condition?.ArnLike?.["AWS:SourceArn"] ? { SourceArn: String(statement.Condition.ArnLike["AWS:SourceArn"]) } : {}),
    ...(statement.Condition?.StringEquals?.["AWS:SourceAccount"] ? { SourceAccount: String(statement.Condition.StringEquals["AWS:SourceAccount"]) } : {}),
    ...(statement.Condition?.StringEquals?.["lambda:FunctionUrlAuthType"] ? { FunctionUrlAuthType: String(statement.Condition.StringEquals["lambda:FunctionUrlAuthType"]) as PermissionModel["FunctionUrlAuthType"] } : {}),
    ...(statement.Condition?.Bool?.["lambda:InvokedViaFunctionUrl"] !== undefined ? { InvokedViaFunctionUrl: String(statement.Condition.Bool["lambda:InvokedViaFunctionUrl"]) === "true" } : {}),
  });
  const statementMatches = (statement: any, desired: PermissionModel): boolean => statement?.Effect === "Allow"
    && statement.Action === desired.Action
    && statement.Principal === desired.Principal
    && stableJson(statement.Condition ?? {}) === stableJson(expectedCondition(desired));
  return {
    typeName: LAMBDA_PERMISSION_TYPE, providerVersion: 1, visibility: "production", schema: LAMBDA_PERMISSION_SCHEMA,
    validate(properties: unknown): readonly ProviderValidationIssue[] {
      const issues = validateDeclaredProperties(properties ?? {}, LAMBDA_PERMISSION_SCHEMA); if (!record(properties)) return issues;
      if (typeof properties.Action === "string" && !/^(?:lambda:[A-Za-z*]+|\*)$/.test(properties.Action)) issues.push({ code: "InvalidProperty", path: "Properties.Action", pathSegments: providerValidationPathSegments("Properties.Action"), message: "Action must be a Lambda action" });
      if (typeof properties.SourceAccount === "string" && !/^\d{12}$/.test(properties.SourceAccount)) issues.push({ code: "InvalidProperty", path: "Properties.SourceAccount", pathSegments: providerValidationPathSegments("Properties.SourceAccount"), message: "SourceAccount must contain 12 digits" });
      if (typeof properties.FunctionUrlAuthType === "string" && !["AWS_IAM", "NONE"].includes(properties.FunctionUrlAuthType)) issues.push({ code: "InvalidProperty", path: "Properties.FunctionUrlAuthType", pathSegments: providerValidationPathSegments("Properties.FunctionUrlAuthType"), message: "FunctionUrlAuthType must be AWS_IAM or NONE" });
      if (properties.FunctionUrlAuthType !== undefined && properties.Action !== "lambda:InvokeFunctionUrl") issues.push({ code: "InvalidProperty", path: "Properties.FunctionUrlAuthType", pathSegments: providerValidationPathSegments("Properties.FunctionUrlAuthType"), message: "FunctionUrlAuthType requires Action lambda:InvokeFunctionUrl" });
      if (properties.InvokedViaFunctionUrl !== undefined && properties.Action !== "lambda:InvokeFunction") issues.push({ code: "InvalidProperty", path: "Properties.InvokedViaFunctionUrl", pathSegments: providerValidationPathSegments("Properties.InvokedViaFunctionUrl"), message: "InvokedViaFunctionUrl requires Action lambda:InvokeFunction" });
      if (typeof properties.Principal === "string" && properties.Principal.endsWith(".amazonaws.com") && !SUPPORTED_LOCAL_INVOCATION_PRINCIPALS.has(properties.Principal)) issues.push({ code: "InvalidProperty", path: "Properties.Principal", pathSegments: providerValidationPathSegments("Properties.Principal"), message: `Service principal ${properties.Principal} is not backed by a supported local invocation source` });
      return issues;
    },
    canonicalize(properties: unknown, context: ProviderContext): PermissionModel {
      if (!record(properties)) throw new TypeError(`${LAMBDA_PERMISSION_TYPE} Properties must be an object`);
      const issues = this.validate(properties, context);
      if (issues.length) throw new TypeError(issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
      return {
        Action: String(properties.Action),
        FunctionName: String(properties.FunctionName),
        Principal: String(properties.Principal),
        ...(properties.SourceArn !== undefined ? { SourceArn: String(properties.SourceArn) } : {}),
        ...(properties.SourceAccount !== undefined ? { SourceAccount: String(properties.SourceAccount) } : {}),
        ...(properties.FunctionUrlAuthType !== undefined ? { FunctionUrlAuthType: String(properties.FunctionUrlAuthType) as PermissionModel["FunctionUrlAuthType"] } : {}),
        ...(properties.InvokedViaFunctionUrl !== undefined ? { InvokedViaFunctionUrl: Boolean(properties.InvokedViaFunctionUrl) } : {}),
      };
    },
    plan: planImmutable,
    async create(desired: PermissionModel, context: ProviderContext) {
      try {
        const sid = statementId(context); const path = `/2015-03-31/functions/${encodeURIComponent(desired.FunctionName)}/policy`;
        try {
          const policy = (await invoke<any>(context, "GET", path)).body; const statements = JSON.parse(policy.Policy).Statement ?? []; const existing = statements.find((item: any) => item.Sid === sid);
          if (existing) {
            if (!statementMatches(existing, desired)) return { status: "FAILED", errorCode: "ResourceConflictException", message: `Permission statement ${sid} exists with different contents` };
            return success(desired, sid);
          }
        } catch (error) { if (!notFound(error)) throw error; }
        await invoke(context, "POST", path, {
          StatementId: sid,
          Action: desired.Action,
          Principal: desired.Principal,
          ...(desired.SourceArn ? { SourceArn: desired.SourceArn } : {}),
          ...(desired.SourceAccount ? { SourceAccount: desired.SourceAccount } : {}),
          ...(desired.FunctionUrlAuthType ? { FunctionUrlAuthType: desired.FunctionUrlAuthType } : {}),
          ...(desired.InvokedViaFunctionUrl !== undefined ? { InvokedViaFunctionUrl: desired.InvokedViaFunctionUrl } : {}),
        });
        return success(desired, sid);
      } catch (error) { return failed<PermissionModel>(error); }
    },
    async read(id: string, context: ProviderContext): Promise<ProviderReadResult<PermissionModel>> {
      try {
        const { functionName, sid } = parsePhysicalId(id);
        const response = (await invoke<any>(context, "GET", `/2015-03-31/functions/${encodeURIComponent(functionName)}/policy`)).body; const statement = (JSON.parse(response.Policy).Statement ?? []).find((item: any) => item.Sid === sid); if (!statement) return { status: "NOT_FOUND", physicalId: id };
        const properties = statementProperties(functionName, statement);
        return { status: "SUCCESS", physicalId: id, model: { physicalId: id, properties, attributes: {} } };
      } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId: id } : failed<PermissionModel>(error) as ProviderReadResult<PermissionModel>; }
    },
    async update(_physicalId: string, _previous: PermissionModel, _desired: PermissionModel): Promise<ProviderUpdateResult<PermissionModel>> { return { status: "FAILED", errorCode: "NotUpdatable", message: "Lambda permissions are replacement-only" }; },
    async delete(id: string, previous: PermissionModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const { functionName, sid } = parsePhysicalId(id);
        if (functionName !== previous.FunctionName) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Permission physical ID ${id} does not belong to function ${previous.FunctionName}` };
        const path = `/2015-03-31/functions/${encodeURIComponent(functionName)}/policy`;
        const response = (await invoke<any>(context, "GET", path)).body;
        const statement = (JSON.parse(response.Policy).Statement ?? []).find((item: any) => item.Sid === sid);
        if (!statement) return { status: "NOT_FOUND", physicalId: id };
        if (!statementMatches(statement, previous)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Permission statement ${sid} no longer matches the resource recorded by CloudFormation` };
        const revision = typeof response.RevisionId === "string" ? `?RevisionId=${encodeURIComponent(response.RevisionId)}` : "";
        await invoke(context, "DELETE", `${path}/${encodeURIComponent(sid)}${revision}`);
        return { status: "SUCCESS", physicalId: id };
      } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId: id } : failed<PermissionModel>(error) as ProviderDeleteResult; }
    },
    ref(): never { throw new ProviderReferenceError(LAMBDA_PERMISSION_TYPE, "Ref"); }, getAtt(_model, attribute): never { throw new ProviderReferenceError(LAMBDA_PERMISSION_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}

export function createLambdaVersionProvider(lambda: LambdaService): ProductionResourceProvider<VersionModel> {
  const invoke = invoker(lambda);
  const parsePhysical = (physicalId: string) => { const match = physicalId.match(/^(arn:[^:]+:lambda:[^:]+:\d{12}:function:.+):([^:]+)$/); if (!match) throw new AwsError("ResourceNotFoundException", `Invalid Lambda version ARN ${physicalId}`, 404); return { functionArn: match[1], functionName: match[1].split(":function:")[1], version: match[2] }; };
  const success = (desired: VersionModel, arn: string, version: string): ProviderSuccess<VersionModel> => ({ status: "SUCCESS", physicalId: arn, model: { physicalId: arn, properties: desired, attributes: { FunctionArn: arn, Version: version } } });
  const operationToken = (context: ProviderContext): string => createHash("sha256").update(`${LAMBDA_VERSION_TYPE}\0${context.stackId}\0${context.logicalId}\0${context.idempotencyKey}`).digest("hex");
  const inProgress = (physicalId: string, token: string, callbackAfterMs = 0): ProviderInProgress => ({ status: "IN_PROGRESS", callbackAfterMs, checkpoint: { schemaVersion: 1, callbackContext: { stateMachine: "lambda-version-v1", token, physicalId }, physicalId } });
  const candidateMatches = (candidate: any, desired: VersionModel): boolean => candidate !== undefined
    && typeof candidate.Version === "string" && /^\d+$/.test(candidate.Version)
    && typeof candidate.FunctionArn === "string" && candidate.FunctionArn.endsWith(`:${candidate.Version}`)
    && (desired.CodeSha256 === undefined || candidate.CodeSha256 === desired.CodeSha256)
    && (desired.Description === undefined || candidate.Description === desired.Description);
  const ownedVersion = async (desired: VersionModel, token: string, context: ProviderContext): Promise<any | undefined> => {
    const query = new URLSearchParams({ MaxItems: "50", "stacksim-cloudformation-operation-token": token });
    const response = (await invoke<any>(context, "GET", `/2015-03-31/functions/${encodeURIComponent(desired.FunctionName)}/versions?${query.toString()}`)).body;
    const candidates = response.Versions ?? [];
    if (candidates.length > 1) throw new AwsError("ResourceConflictException", `Multiple Lambda versions carry CloudFormation operation token ${token}`, 409);
    const candidate = candidates[0];
    if (candidate && !candidateMatches(candidate, desired)) throw new AwsError("ResourceConflictException", `CloudFormation operation token ${token} belongs to a different Lambda version`, 409);
    return candidate;
  };
  return {
    typeName: LAMBDA_VERSION_TYPE, providerVersion: 2, visibility: "production", schema: LAMBDA_VERSION_SCHEMA,
    validate(properties: unknown): readonly ProviderValidationIssue[] {
      const issues = validateDeclaredProperties(properties ?? {}, LAMBDA_VERSION_SCHEMA);
      if (record(properties)) {
        if (properties.Description !== undefined && String(properties.Description).length > 256) issues.push({ code: "InvalidProperty", path: "Properties.Description", pathSegments: providerValidationPathSegments("Properties.Description"), message: "Description must contain at most 256 characters" });
        provisionedConcurrencyIssues(properties.ProvisionedConcurrencyConfig, "Properties.ProvisionedConcurrencyConfig", issues);
      }
      return issues;
    },
    canonicalize(properties: unknown, context: ProviderContext): VersionModel {
      if (!record(properties)) throw new TypeError(`${LAMBDA_VERSION_TYPE} Properties must be an object`);
      const issues = this.validate(properties, context);
      if (issues.length) throw new TypeError(issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
      return {
        FunctionName: String(properties.FunctionName),
        ...(properties.CodeSha256 !== undefined ? { CodeSha256: String(properties.CodeSha256) } : {}),
        ...(properties.Description !== undefined ? { Description: String(properties.Description) } : {}),
        ...(properties.ProvisionedConcurrencyConfig !== undefined ? { ProvisionedConcurrencyConfig: provisionedConcurrency(properties.ProvisionedConcurrencyConfig)! } : {}),
      };
    },
    plan: planImmutable,
    async create(desired: VersionModel, context: ProviderContext) {
      let partialPhysicalId: string | undefined;
      try {
        const token = operationToken(context); const rawCallback = context.callbackContext;
        if (rawCallback !== undefined && !record(rawCallback)) throw new AwsError("InvalidCallbackContext", "Invalid AWS::Lambda::Version create callback context", 400);
        const callback = rawCallback && Object.keys(rawCallback).length ? rawCallback : undefined;
        if (callback !== undefined && (callback.stateMachine !== "lambda-version-v1" || callback.token !== token || typeof callback.physicalId !== "string")) throw new AwsError("InvalidCallbackContext", "Invalid AWS::Lambda::Version create callback context", 400);
        const owned = await ownedVersion(desired, token, context);
        if (owned) {
          const physicalId = String(owned.FunctionArn); const parsed = parsePhysical(physicalId);
          if (callback && callback.physicalId !== physicalId) throw new AwsError("OwnershipConflict", `Lambda version callback ${String(callback.physicalId)} does not match operation-owned version ${physicalId}`, 409);
          partialPhysicalId = physicalId;
          if (!callback) return inProgress(physicalId, token);
          if (desired.ProvisionedConcurrencyConfig) {
            const provisioned = await reconcileProvisioned(invoke, context, parsed.functionName, parsed.version, desired.ProvisionedConcurrencyConfig);
            if (provisioned === "IN_PROGRESS") return inProgress(physicalId, token, 25);
          }
          return success(desired, physicalId, parsed.version);
        }
        if (callback) throw new AwsError("ResourceNotFoundException", `Operation-owned Lambda version ${String(callback.physicalId)} was not found`, 404);
        const output = (await invoke<any>(context, "POST", `/2015-03-31/functions/${encodeURIComponent(desired.FunctionName)}/versions`, { ...(desired.CodeSha256 !== undefined ? { CodeSha256: desired.CodeSha256 } : {}), ...(desired.Description !== undefined ? { Description: desired.Description } : {}), StackSimCloudFormationOperationToken: token })).body;
        if (!candidateMatches(output, desired)) throw new AwsError("InternalFailure", "PublishVersion returned a model that does not match the desired Lambda version", 500);
        partialPhysicalId = String(output.FunctionArn);
        return inProgress(partialPhysicalId, token);
      } catch (error) { return failed<VersionModel>(error, partialPhysicalId); }
    },
    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<VersionModel>> {
      try {
        const parsed = parsePhysical(physicalId);
        const output = (await invoke<any>(context, "GET", `/2015-03-31/functions/${encodeURIComponent(parsed.functionName)}?Qualifier=${encodeURIComponent(parsed.version)}`)).body.Configuration;
        const provisioned = await readProvisioned(invoke, context, parsed.functionName, parsed.version);
        return success({
          FunctionName: parsed.functionName,
          ...(output.CodeSha256 !== undefined ? { CodeSha256: String(output.CodeSha256) } : {}),
          Description: output.Description,
          ...(provisioned ? { ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: Number(provisioned.RequestedProvisionedConcurrentExecutions) } } : {}),
        }, physicalId, parsed.version);
      } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed<VersionModel>(error) as ProviderReadResult<VersionModel>; }
    },
    async update(): Promise<ProviderUpdateResult<VersionModel>> { return { status: "FAILED", errorCode: "NotUpdatable", message: "Lambda versions are immutable" }; },
    async delete(physicalId: string, previous: VersionModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const parsed = parsePhysical(physicalId);
        if (previous.ProvisionedConcurrencyConfig) await removeProvisioned(invoke, context, parsed.functionName, parsed.version);
        await invoke(context, "DELETE", `/2015-03-31/functions/${encodeURIComponent(parsed.functionName)}?Qualifier=${encodeURIComponent(parsed.version)}`);
        return { status: "SUCCESS", physicalId };
      } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed<VersionModel>(error) as ProviderDeleteResult; }
    },
    ref(model: ProviderReadModel<VersionModel>): unknown { return model.physicalId; }, getAtt(model: ProviderReadModel<VersionModel>, attribute: string): unknown { if (attribute === "FunctionArn" || attribute === "Version") return model.attributes[attribute]; throw new ProviderReferenceError(LAMBDA_VERSION_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}

function aliasRouting(value: unknown): AliasModel["RoutingConfig"] {
  if (value === undefined) return undefined; if (!record(value) || !Array.isArray(value.AdditionalVersionWeights)) throw new TypeError("RoutingConfig.AdditionalVersionWeights must be an array");
  const weights = value.AdditionalVersionWeights.map(item => { if (!record(item) || typeof item.FunctionVersion !== "string" || typeof item.FunctionWeight !== "number") throw new TypeError("Each alias weight requires FunctionVersion and FunctionWeight"); return { FunctionVersion: item.FunctionVersion, FunctionWeight: item.FunctionWeight }; }).sort((a, b) => a.FunctionVersion.localeCompare(b.FunctionVersion));
  if (weights.some(item => !/^\d+$/.test(item.FunctionVersion) || item.FunctionWeight < 0 || item.FunctionWeight > 1) || weights.reduce((sum, item) => sum + item.FunctionWeight, 0) > 1) throw new TypeError("Alias weights must target numeric versions and total at most 1"); return { AdditionalVersionWeights: weights };
}
function routingApi(model: AliasModel): Record<string, number> { return Object.fromEntries((model.RoutingConfig?.AdditionalVersionWeights ?? []).map(item => [item.FunctionVersion, item.FunctionWeight])); }
function functionNameFromTarget(value: string): string {
  return value.match(/^arn:[^:]+:lambda:[^:]+:\d{12}:function:([^:]+)$/)?.[1]
    ?? value.match(/^\d{12}:function:([^:]+)$/)?.[1]
    ?? value;
}
function aliasArn(model: Pick<AliasModel, "FunctionName" | "Name">, context: ProviderContext): string {
  const arn = model.FunctionName.match(/^arn:[^:]+:lambda:[^:]+:\d{12}:function:[^:]+$/)?.[0]
    ?? `arn:${context.partition}:lambda:${context.region}:${context.accountId}:function:${functionNameFromTarget(model.FunctionName)}`;
  return `${arn}:${model.Name}`;
}
function parseAliasPhysical(physicalId: string): { functionName: string; name: string } {
  const match = physicalId.match(/^arn:[^:]+:lambda:[^:]+:\d{12}:function:([^:]+):([^:]+)$/);
  if (!match) throw new AwsError("ResourceNotFoundException", `Invalid Lambda alias ARN ${physicalId}`, 404);
  return { functionName: match[1], name: match[2] };
}
function aliasMatches(current: any, desired: AliasModel): boolean {
  return current.FunctionVersion === desired.FunctionVersion
    && String(current.Description ?? "") === String(desired.Description ?? "")
    && same(current.RoutingConfig?.AdditionalVersionWeights ?? {}, routingApi(desired));
}
function aliasProgress(physicalId: string, operation: "CREATE" | "UPDATE"): ProviderInProgress {
  return {
    status: "IN_PROGRESS",
    callbackAfterMs: 25,
    checkpoint: {
      schemaVersion: 1,
      callbackContext: { stateMachine: "lambda-alias-provisioned-v1", operation, physicalId },
      physicalId,
    },
  };
}
function aliasCallback(context: ProviderContext, operation: "CREATE" | "UPDATE", physicalId: string): boolean {
  const raw = context.callbackContext;
  if (raw === undefined || record(raw) && Object.keys(raw).length === 0) return false;
  if (!record(raw)
    || raw.stateMachine !== "lambda-alias-provisioned-v1"
    || raw.operation !== operation
    || raw.physicalId !== physicalId) {
    throw new AwsError("InvalidCallbackContext", `Invalid AWS::Lambda::Alias ${operation.toLowerCase()} callback context`, 400);
  }
  return true;
}

export function createLambdaAliasProvider(lambda: LambdaService): ProductionResourceProvider<AliasModel> {
  const invoke = invoker(lambda); const path = (model: Pick<AliasModel, "FunctionName" | "Name">) => `/2015-03-31/functions/${encodeURIComponent(model.FunctionName)}/aliases/${encodeURIComponent(model.Name)}`;
  const success = (desired: AliasModel, arn: string): ProviderSuccess<AliasModel> => ({ status: "SUCCESS", physicalId: arn, model: { physicalId: arn, properties: desired, attributes: { AliasArn: arn } } });
  return {
    typeName: LAMBDA_ALIAS_TYPE, providerVersion: 1, visibility: "production", schema: LAMBDA_ALIAS_SCHEMA,
    validate(properties: unknown): readonly ProviderValidationIssue[] {
      const issues = validateDeclaredProperties(properties ?? {}, LAMBDA_ALIAS_SCHEMA); if (!record(properties)) return issues;
      if (typeof properties.Name === "string" && (!/^[A-Za-z-_][A-Za-z0-9-_]{0,127}$/.test(properties.Name) || /^\d+$/.test(properties.Name))) issues.push({ code: "InvalidProperty", path: "Properties.Name", pathSegments: providerValidationPathSegments("Properties.Name"), message: "Name must be a non-numeric Lambda alias name" });
      if (typeof properties.FunctionVersion === "string" && !/^\d+$/.test(properties.FunctionVersion)) issues.push({ code: "InvalidProperty", path: "Properties.FunctionVersion", pathSegments: providerValidationPathSegments("Properties.FunctionVersion"), message: "Alias must target a published numeric version" });
      provisionedConcurrencyIssues(properties.ProvisionedConcurrencyConfig, "Properties.ProvisionedConcurrencyConfig", issues);
      try { aliasRouting(properties.RoutingConfig); } catch (error) { issues.push({ code: "InvalidProperty", path: "Properties.RoutingConfig", pathSegments: providerValidationPathSegments("Properties.RoutingConfig"), message: error instanceof Error ? error.message : String(error) }); } return issues;
    },
    canonicalize(properties: unknown, context: ProviderContext): AliasModel {
      if (!record(properties)) throw new TypeError(`${LAMBDA_ALIAS_TYPE} Properties must be an object`); const issues = this.validate(properties, context); if (issues.length) throw new TypeError(issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
      return {
        FunctionName: String(properties.FunctionName),
        FunctionVersion: String(properties.FunctionVersion),
        Name: String(properties.Name),
        ...(properties.Description !== undefined ? { Description: String(properties.Description) } : {}),
        ...(properties.ProvisionedConcurrencyConfig !== undefined ? { ProvisionedConcurrencyConfig: provisionedConcurrency(properties.ProvisionedConcurrencyConfig)! } : {}),
        ...(properties.RoutingConfig !== undefined ? { RoutingConfig: aliasRouting(properties.RoutingConfig)! } : {}),
      };
    },
    plan(previous: AliasModel | undefined, desired: AliasModel): ProviderPlan<AliasModel> { if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] }; const changed = [...new Set([...Object.keys(previous), ...Object.keys(desired)])].filter(key => !same((previous as any)[key], (desired as any)[key])).sort(); if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] }; const replacements = changed.filter(key => key === "FunctionName" || key === "Name"); return replacements.length ? { action: "REPLACE", desired, changedProperties: changed, replacementProperties: replacements, replacementOrder: "CREATE_BEFORE_DELETE" } : { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] }; },
    async create(desired: AliasModel, context: ProviderContext) {
      const expectedArn = aliasArn(desired, context);
      let partialPhysicalId: string | undefined;
      try {
        const resumed = aliasCallback(context, "CREATE", expectedArn);
        let current: any;
        try {
          current = (await invoke<any>(context, "GET", path(desired))).body;
        } catch (error) {
          if (!notFound(error)) throw error;
          if (resumed) throw new AwsError("ResourceNotFoundException", `Operation-owned Lambda alias ${expectedArn} was not found`, 404);
        }
        if (current) {
          if (!aliasMatches(current, desired)) return { status: "FAILED", errorCode: "ResourceConflictException", message: `Alias ${desired.Name} already exists with different contents` };
          partialPhysicalId = String(current.AliasArn);
        } else {
          partialPhysicalId = expectedArn;
          current = (await invoke<any>(context, "POST", `/2015-03-31/functions/${encodeURIComponent(desired.FunctionName)}/aliases`, {
            Name: desired.Name,
            FunctionVersion: desired.FunctionVersion,
            ...(desired.Description !== undefined ? { Description: desired.Description } : {}),
            RoutingConfig: { AdditionalVersionWeights: routingApi(desired) },
          })).body;
          partialPhysicalId = String(current.AliasArn ?? expectedArn);
        }
        if (partialPhysicalId !== expectedArn) throw new AwsError("OwnershipConflict", `Lambda returned alias ARN ${partialPhysicalId}, expected ${expectedArn}`, 409);
        if (desired.ProvisionedConcurrencyConfig) {
          const provisioned = await reconcileProvisioned(invoke, context, desired.FunctionName, desired.Name, desired.ProvisionedConcurrencyConfig);
          if (provisioned === "IN_PROGRESS") return aliasProgress(partialPhysicalId, "CREATE");
        }
        return success(desired, partialPhysicalId);
      } catch (error) { return failed<AliasModel>(error, partialPhysicalId); }
    },
    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<AliasModel>> {
      try {
        const parsed = parseAliasPhysical(physicalId);
        const current = (await invoke<any>(context, "GET", `/2015-03-31/functions/${encodeURIComponent(parsed.functionName)}/aliases/${encodeURIComponent(parsed.name)}`)).body;
        const provisioned = await readProvisioned(invoke, context, parsed.functionName, parsed.name);
        const weights = Object.entries(current.RoutingConfig?.AdditionalVersionWeights ?? {}).map(([FunctionVersion, FunctionWeight]) => ({ FunctionVersion, FunctionWeight: Number(FunctionWeight) })).sort((a, b) => a.FunctionVersion.localeCompare(b.FunctionVersion));
        return success({
          FunctionName: parsed.functionName,
          FunctionVersion: current.FunctionVersion,
          Name: current.Name,
          ...(current.Description !== undefined ? { Description: current.Description } : {}),
          ...(provisioned ? { ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: Number(provisioned.RequestedProvisionedConcurrentExecutions) } } : {}),
          ...(weights.length ? { RoutingConfig: { AdditionalVersionWeights: weights } } : {}),
        }, current.AliasArn);
      } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed<AliasModel>(error) as ProviderReadResult<AliasModel>; }
    },
    async update(physicalId: string, previous: AliasModel, desired: AliasModel, context: ProviderContext): Promise<ProviderUpdateResult<AliasModel>> {
      try {
        const parsed = parseAliasPhysical(physicalId);
        if (parsed.functionName !== functionNameFromTarget(desired.FunctionName) || parsed.name !== desired.Name) throw new AwsError("OwnershipConflict", `Alias physical ID ${physicalId} does not match ${desired.FunctionName}:${desired.Name}`, 409);
        aliasCallback(context, "UPDATE", physicalId);
        let current = (await invoke<any>(context, "GET", path(desired))).body;
        if (!aliasMatches(current, desired)) {
          current = (await invoke<any>(context, "PUT", path(desired), {
            FunctionVersion: desired.FunctionVersion,
            Description: desired.Description ?? "",
            RoutingConfig: { AdditionalVersionWeights: routingApi(desired) },
          })).body;
        }
        if (desired.ProvisionedConcurrencyConfig || previous.ProvisionedConcurrencyConfig) {
          const provisioned = await reconcileProvisioned(invoke, context, desired.FunctionName, desired.Name, desired.ProvisionedConcurrencyConfig);
          if (provisioned === "IN_PROGRESS") return aliasProgress(physicalId, "UPDATE");
        }
        return success(desired, String(current.AliasArn));
      } catch (error) { return failed<AliasModel>(error); }
    },
    async delete(physicalId: string, previous: AliasModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const parsed = parseAliasPhysical(physicalId);
        if (parsed.functionName !== functionNameFromTarget(previous.FunctionName) || parsed.name !== previous.Name) throw new AwsError("OwnershipConflict", `Alias physical ID ${physicalId} does not match ${previous.FunctionName}:${previous.Name}`, 409);
        if (previous.ProvisionedConcurrencyConfig) await removeProvisioned(invoke, context, parsed.functionName, parsed.name);
        await invoke(context, "DELETE", `/2015-03-31/functions/${encodeURIComponent(parsed.functionName)}/aliases/${encodeURIComponent(parsed.name)}`);
        return { status: "SUCCESS", physicalId };
      } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed<AliasModel>(error) as ProviderDeleteResult; }
    },
    ref(model: ProviderReadModel<AliasModel>): unknown { return model.physicalId; }, getAtt(model: ProviderReadModel<AliasModel>, attribute: string): unknown { if (attribute === "AliasArn") return model.attributes.AliasArn; throw new ProviderReferenceError(LAMBDA_ALIAS_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}

export function createLambdaCompanionProviders(lambda: LambdaService): readonly ProductionResourceProvider<any>[] { return [createLambdaPermissionProvider(lambda), createLambdaVersionProvider(lambda), createLambdaAliasProvider(lambda)]; }
