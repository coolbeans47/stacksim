import { createHash } from "node:crypto";
import { AwsError } from "../../errors.js";
import type { LambdaService } from "../../lambda.js";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
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

export const LAMBDA_LAYER_VERSION_PERMISSION_TYPE = "AWS::Lambda::LayerVersionPermission";
export const LAMBDA_URL_TYPE = "AWS::Lambda::Url";
export const LAMBDA_CODE_SIGNING_CONFIG_TYPE = "AWS::Lambda::CodeSigningConfig";

const RETENTION = Object.freeze({
  deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  snapshotSupported: false,
});
const NO_TAGS = Object.freeze({ behavior: "NONE" as const, propagatesCloudFormationTags: false });
const STACK_TAGS = Object.freeze({
  behavior: "STACK_AND_RESOURCE" as const,
  propertyName: "Tags",
  propagatesCloudFormationTags: true,
});

export const LAMBDA_LAYER_VERSION_PERMISSION_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LAMBDA_LAYER_VERSION_PERMISSION_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Action: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    LayerVersionArn: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    OrganizationId: Object.freeze({
      valueType: "string",
      updateBehavior: "REPLACEMENT",
      description: "Recognized by the pinned L1 schema but rejected because Organizations is not backed.",
    }),
    Principal: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
  }),
  ref: Object.freeze({
    supported: true,
    valueType: "string",
    description: "Layer version ARN and the provider-owned statement ID separated by #.",
  }),
  attributes: Object.freeze({
    Id: Object.freeze({ valueType: "string", description: "The provider-owned layer permission ID." }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: NO_TAGS,
});

export const LAMBDA_URL_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LAMBDA_URL_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    AuthType: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    Cors: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    InvokeMode: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Qualifier: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    TargetFunctionArn: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "The qualified function ARN that owns the URL configuration." }),
  attributes: Object.freeze({
    FunctionArn: Object.freeze({ valueType: "string" }),
    FunctionUrl: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: NO_TAGS,
});

export const LAMBDA_CODE_SIGNING_CONFIG_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LAMBDA_CODE_SIGNING_CONFIG_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    AllowedPublishers: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
    CodeSigningPolicies: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    Description: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Code signing configuration ARN." }),
  attributes: Object.freeze({
    CodeSigningConfigArn: Object.freeze({ valueType: "string" }),
    CodeSigningConfigId: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: RETENTION,
  tags: STACK_TAGS,
});

export interface LambdaLayerVersionPermissionModel {
  readonly Action: "lambda:GetLayerVersion";
  readonly LayerVersionArn: string;
  readonly Principal: string;
}

export interface LambdaUrlCorsModel {
  readonly AllowCredentials?: boolean;
  readonly AllowHeaders?: readonly string[];
  readonly AllowMethods?: readonly string[];
  readonly AllowOrigins?: readonly string[];
  readonly ExposeHeaders?: readonly string[];
  readonly MaxAge?: number;
}

export interface LambdaUrlModel {
  readonly AuthType: "AWS_IAM" | "NONE";
  readonly Cors?: LambdaUrlCorsModel;
  readonly InvokeMode: "BUFFERED" | "RESPONSE_STREAM";
  /** Canonical local function name; the backing read supplies the full ARN. */
  readonly TargetFunctionArn: string;
  readonly Qualifier?: string;
}

export interface LambdaCodeSigningConfigModel {
  readonly AllowedPublishers: {
    readonly SigningProfileVersionArns: readonly string[];
  };
  readonly CodeSigningPolicies: {
    readonly UntrustedArtifactOnDeployment: "Enforce" | "Warn";
  };
  readonly Description: string;
  readonly Tags: readonly { readonly Key: string; readonly Value: string }[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(
  output: ProviderValidationIssue[],
  path: string,
  message: string,
  code: ProviderValidationIssue["code"] = "InvalidProperty",
): void {
  output.push({ code, path, message });
}

function rejectUnknown(
  value: Record<string, unknown>,
  path: string,
  accepted: readonly string[],
  output: ProviderValidationIssue[],
): void {
  const names = new Set(accepted);
  for (const key of Object.keys(value).sort()) {
    if (!names.has(key)) issue(output, `${path}.${key}`, `${key} is not supported in ${path}`, "UnsupportedProperty");
  }
}

function throwIssues(issues: readonly ProviderValidationIssue[]): never {
  throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (record(value)) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function plan<Model extends object>(
  previous: Model | undefined,
  desired: Model,
  schema: ProviderSchema,
): ProviderPlan<Model> {
  if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
  const changedProperties = [...new Set([...Object.keys(previous), ...Object.keys(desired)])]
    .filter(key => !same((previous as Record<string, unknown>)[key], (desired as Record<string, unknown>)[key]))
    .sort();
  if (!changedProperties.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
  const replacementProperties = changedProperties.filter(key => schema.properties[key]?.updateBehavior === "REPLACEMENT");
  return replacementProperties.length
    ? { action: "REPLACE", desired, changedProperties, replacementProperties, replacementOrder: schema.replacement.defaultOrder }
    : { action: "UPDATE", desired, changedProperties, replacementProperties: [] };
}

function failure<Model>(error: unknown): ProviderUpdateResult<Model> {
  const aws = error instanceof AwsError
    ? error
    : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}

function isNotFound(error: unknown, ...extraCodes: string[]): boolean {
  return error instanceof AwsError
    && (error.code === "ResourceNotFoundException" || extraCodes.includes(error.code));
}

function invoker(lambda: LambdaService) {
  return <T>(context: ProviderContext, method: string, path: string, input?: unknown) => invokeJsonService<T>({
    method,
    path,
    input,
    handle: (req, res, pathname, url) => lambda.handle(req, res, pathname, url, context.principal.identity),
  });
}

interface ParsedLayerVersionArn {
  readonly partition: string;
  readonly region: string;
  readonly accountId: string;
  readonly layerName: string;
  readonly version: number;
}

function parseLayerVersionArn(value: string): ParsedLayerVersionArn | undefined {
  const match = value.match(/^arn:([^:]+):lambda:([^:]+):(\d{12}):layer:([A-Za-z0-9-_]{1,140}):([1-9]\d*)$/);
  if (!match) return undefined;
  const version = Number(match[5]);
  if (!Number.isSafeInteger(version)) return undefined;
  return { partition: match[1], region: match[2], accountId: match[3], layerName: match[4], version };
}

function layerPermissionIssues(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const output = validateDeclaredProperties(properties ?? {}, LAMBDA_LAYER_VERSION_PERMISSION_SCHEMA);
  if (!record(properties)) return output;
  if (typeof properties.Action === "string" && properties.Action !== "lambda:GetLayerVersion") {
    issue(output, "Properties.Action", "Action must be lambda:GetLayerVersion");
  }
  if (typeof properties.LayerVersionArn === "string") {
    const parsed = parseLayerVersionArn(properties.LayerVersionArn);
    if (!parsed) issue(output, "Properties.LayerVersionArn", "LayerVersionArn must be a version-qualified Lambda layer ARN");
    else if (parsed.partition !== context.partition || parsed.region !== context.region || parsed.accountId !== context.accountId) {
      issue(output, "Properties.LayerVersionArn", "LayerVersionArn must identify a layer version in the stack account, Region, and partition");
    }
  }
  if (properties.OrganizationId !== undefined) {
    issue(output, "Properties.OrganizationId", "Organization-scoped sharing requires the unavailable AWS Organizations dependency", "UnsupportedProperty");
  }
  if (typeof properties.Principal === "string") {
    const localRoot = `arn:${context.partition}:iam::${context.accountId}:root`;
    if (properties.Principal === "*") {
      issue(output, "Properties.Principal", "Public layer sharing is outside the bounded same-account CFN-15 profile", "UnsupportedProperty");
    } else if (properties.Principal !== context.accountId && properties.Principal !== localRoot) {
      issue(output, "Properties.Principal", "Principal must be the stack account ID or its root ARN");
    }
  }
  return output;
}

function layerPolicyPath(parsed: ParsedLayerVersionArn): string {
  return `/2018-10-31/layers/${encodeURIComponent(parsed.layerName)}/versions/${parsed.version}/policy`;
}

function layerStatementId(context: ProviderContext): string {
  const prefix = (context.logicalId.replace(/[^A-Za-z0-9-_]/g, "-") || "LayerPermission").slice(0, 60);
  const suffix = createHash("sha256")
    .update(`${LAMBDA_LAYER_VERSION_PERMISSION_TYPE}\0${context.stackId}\0${context.logicalId}\0${context.idempotencyKey}`)
    .digest("hex")
    .slice(0, 32);
  return `${prefix}-${suffix}`;
}

function layerPermissionPhysicalId(layerVersionArn: string, statementId: string): string {
  return `${layerVersionArn}#${statementId}`;
}

function parseLayerPermissionPhysicalId(value: string): { arn: ParsedLayerVersionArn; layerVersionArn: string; statementId: string } | undefined {
  const separator = value.lastIndexOf("#");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const layerVersionArn = value.slice(0, separator);
  const arn = parseLayerVersionArn(layerVersionArn);
  return arn ? { arn, layerVersionArn, statementId: value.slice(separator + 1) } : undefined;
}

function layerStatementMatches(statement: any, desired: LambdaLayerVersionPermissionModel, statementId: string): boolean {
  const principal = statement?.Principal === "*"
    ? "*"
    : String(statement?.Principal?.AWS ?? statement?.Principal ?? "").match(/:iam::(\d{12}):root$/)?.[1]
      ?? String(statement?.Principal?.AWS ?? statement?.Principal ?? "");
  return statement?.Sid === statementId
    && statement?.Effect === "Allow"
    && statement?.Action === desired.Action
    && statement?.Resource === desired.LayerVersionArn
    && principal === desired.Principal
    && statement?.Condition === undefined;
}

export function createLambdaLayerVersionPermissionProvider(
  lambda: LambdaService,
): ProductionResourceProvider<LambdaLayerVersionPermissionModel> {
  const invoke = invoker(lambda);
  const policy = async (parsed: ParsedLayerVersionArn, context: ProviderContext): Promise<{ statements: any[]; revisionId?: string }> => {
    const response = (await invoke<any>(context, "GET", layerPolicyPath(parsed))).body;
    const document = JSON.parse(String(response.Policy));
    return { statements: Array.isArray(document.Statement) ? document.Statement : [], ...(typeof response.RevisionId === "string" ? { revisionId: response.RevisionId } : {}) };
  };
  const success = (
    desired: LambdaLayerVersionPermissionModel,
    statementId: string,
  ): ProviderSuccess<LambdaLayerVersionPermissionModel> => {
    const physicalId = layerPermissionPhysicalId(desired.LayerVersionArn, statementId);
    return { status: "SUCCESS", physicalId, model: { physicalId, properties: desired, attributes: { Id: physicalId } } };
  };

  return {
    typeName: LAMBDA_LAYER_VERSION_PERMISSION_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: LAMBDA_LAYER_VERSION_PERMISSION_SCHEMA,
    validate: layerPermissionIssues,
    canonicalize(properties: unknown, context: ProviderContext): LambdaLayerVersionPermissionModel {
      const issues = layerPermissionIssues(properties, context);
      if (issues.length) throwIssues(issues);
      const input = properties as Record<string, unknown>;
      return Object.freeze({
        Action: "lambda:GetLayerVersion" as const,
        LayerVersionArn: String(input.LayerVersionArn),
        Principal: context.accountId,
      });
    },
    plan(previous, desired) { return plan(previous, desired, LAMBDA_LAYER_VERSION_PERMISSION_SCHEMA); },
    async create(desired, context) {
      const parsed = parseLayerVersionArn(desired.LayerVersionArn)!;
      const statementId = layerStatementId(context);
      try {
        try {
          const current = await policy(parsed, context);
          const existing = current.statements.find(statement => statement.Sid === statementId);
          if (existing) {
            if (!layerStatementMatches(existing, desired, statementId)) {
              return { status: "FAILED", errorCode: "ResourceConflictException", message: `Layer permission ${statementId} exists with different contents` };
            }
            return success(desired, statementId);
          }
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        try {
          await invoke(context, "POST", layerPolicyPath(parsed), {
            StatementId: statementId,
            Action: desired.Action,
            Principal: desired.Principal,
          });
        } catch (error) {
          if (!(error instanceof AwsError && error.code === "ResourceConflictException")) throw error;
          const replay = await policy(parsed, context);
          const existing = replay.statements.find(statement => statement.Sid === statementId);
          if (!existing || !layerStatementMatches(existing, desired, statementId)) throw error;
        }
        return success(desired, statementId);
      } catch (error) {
        return failure<LambdaLayerVersionPermissionModel>(error);
      }
    },
    async read(physicalId, context): Promise<ProviderReadResult<LambdaLayerVersionPermissionModel>> {
      const parsed = parseLayerPermissionPhysicalId(physicalId);
      if (!parsed) return { status: "NOT_FOUND", physicalId };
      try {
        const current = await policy(parsed.arn, context);
        const statement = current.statements.find(item => item.Sid === parsed.statementId);
        if (!statement) return { status: "NOT_FOUND", physicalId };
        const principal = String(statement.Principal?.AWS ?? statement.Principal ?? "").match(/:iam::(\d{12}):root$/)?.[1]
          ?? String(statement.Principal?.AWS ?? statement.Principal ?? "");
        const model: LambdaLayerVersionPermissionModel = {
          Action: "lambda:GetLayerVersion",
          LayerVersionArn: parsed.layerVersionArn,
          Principal: principal,
        };
        if (!layerStatementMatches(statement, model, parsed.statementId)) {
          return { status: "FAILED", errorCode: "OwnershipConflict", message: `Layer permission ${parsed.statementId} no longer matches its CloudFormation resource` };
        }
        return success(model, parsed.statementId);
      } catch (error) {
        return isNotFound(error)
          ? { status: "NOT_FOUND", physicalId }
          : failure<LambdaLayerVersionPermissionModel>(error) as ProviderReadResult<LambdaLayerVersionPermissionModel>;
      }
    },
    async update(_physicalId, _previous, _desired): Promise<ProviderUpdateResult<LambdaLayerVersionPermissionModel>> {
      return { status: "FAILED", errorCode: "RequiresReplacement", message: "Lambda layer version permissions are replacement-only" };
    },
    async delete(physicalId, previous, context): Promise<ProviderDeleteResult> {
      const parsed = parseLayerPermissionPhysicalId(physicalId);
      if (!parsed) return { status: "NOT_FOUND", physicalId };
      if (parsed.layerVersionArn !== previous.LayerVersionArn) {
        return { status: "FAILED", errorCode: "OwnershipConflict", message: "Layer permission physical ID does not match the recorded layer version" };
      }
      try {
        const current = await policy(parsed.arn, context);
        const statement = current.statements.find(item => item.Sid === parsed.statementId);
        if (!statement) return { status: "NOT_FOUND", physicalId };
        if (!layerStatementMatches(statement, previous, parsed.statementId)) {
          return { status: "FAILED", errorCode: "OwnershipConflict", message: `Layer permission ${parsed.statementId} no longer matches its CloudFormation resource` };
        }
        const revision = current.revisionId ? `?RevisionId=${encodeURIComponent(current.revisionId)}` : "";
        await invoke(context, "DELETE", `${layerPolicyPath(parsed.arn)}/${encodeURIComponent(parsed.statementId)}${revision}`);
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return isNotFound(error)
          ? { status: "NOT_FOUND", physicalId }
          : failure<LambdaLayerVersionPermissionModel>(error) as ProviderDeleteResult;
      }
    },
    ref(model) { return model.physicalId; },
    getAtt(model, attribute) {
      if (attribute === "Id") return model.physicalId;
      throw new ProviderReferenceError(LAMBDA_LAYER_VERSION_PERMISSION_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}

function stringArray(
  value: unknown,
  path: string,
  maximum: number,
  memberMaximum: number,
  output: ProviderValidationIssue[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issue(output, path, `${path.split(".").at(-1)} must be an array`);
    return undefined;
  }
  if (value.length > maximum) issue(output, path, `${path.split(".").at(-1)} may contain at most ${maximum} entries`);
  const strings = value.filter((item): item is string => typeof item === "string");
  if (strings.length !== value.length || strings.some(item => item.length > memberMaximum)) {
    issue(output, path, `${path.split(".").at(-1)} entries must be strings no longer than ${memberMaximum} characters`);
  }
  if (new Set(strings).size !== strings.length) issue(output, path, `${path.split(".").at(-1)} entries must be unique`);
  return strings;
}

function corsIssues(value: unknown, output: ProviderValidationIssue[]): void {
  if (value === undefined || !record(value)) return;
  rejectUnknown(value, "Properties.Cors", ["AllowCredentials", "AllowHeaders", "AllowMethods", "AllowOrigins", "ExposeHeaders", "MaxAge"], output);
  if (value.AllowCredentials !== undefined && typeof value.AllowCredentials !== "boolean") {
    issue(output, "Properties.Cors.AllowCredentials", "AllowCredentials must be a boolean");
  }
  const headers = stringArray(value.AllowHeaders, "Properties.Cors.AllowHeaders", 100, 1024, output);
  const methods = stringArray(value.AllowMethods, "Properties.Cors.AllowMethods", 6, 6, output);
  const origins = stringArray(value.AllowOrigins, "Properties.Cors.AllowOrigins", 100, 253, output);
  const exposed = stringArray(value.ExposeHeaders, "Properties.Cors.ExposeHeaders", 100, 1024, output);
  void headers;
  void exposed;
  const supportedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "*"]);
  if (methods?.some(method => !supportedMethods.has(method.toUpperCase())) || methods?.includes("*") && methods.length > 1) {
    issue(output, "Properties.Cors.AllowMethods", "AllowMethods contains an unsupported HTTP method or combines * with another method");
  }
  if (origins?.some(origin => origin !== "*" && !/^https?:\/\/[^\s/]+(?::\d+)?$/.test(origin))) {
    issue(output, "Properties.Cors.AllowOrigins", "AllowOrigins entries must be * or an HTTP(S) origin without a path");
  }
  if (value.AllowCredentials === true && origins?.includes("*")) {
    issue(output, "Properties.Cors.AllowOrigins", "AllowCredentials cannot be combined with wildcard origin");
  }
  if (value.MaxAge !== undefined && (!Number.isInteger(value.MaxAge) || Number(value.MaxAge) < 0 || Number(value.MaxAge) > 86_400)) {
    issue(output, "Properties.Cors.MaxAge", "MaxAge must be an integer between 0 and 86400");
  }
}

function normalizedFunctionTarget(
  target: string,
  qualifier: unknown,
  context: ProviderContext,
): { functionName: string; qualifier?: string } | undefined {
  let functionName: string;
  let targetQualifier: string | undefined;
  if (target.startsWith("arn:")) {
    const match = target.match(/^arn:([^:]+):lambda:([^:]+):(\d{12}):function:([A-Za-z0-9-_]{1,64})(?::([^:]+))?$/);
    if (!match || match[1] !== context.partition || match[2] !== context.region || match[3] !== context.accountId) return undefined;
    functionName = match[4];
    targetQualifier = match[5];
  } else {
    if (!/^[A-Za-z0-9-_]{1,64}$/.test(target)) return undefined;
    functionName = target;
  }
  const explicitQualifier = qualifier === undefined ? undefined : String(qualifier);
  if (targetQualifier && explicitQualifier && targetQualifier !== explicitQualifier) return undefined;
  const resolvedQualifier = explicitQualifier ?? targetQualifier;
  if (resolvedQualifier !== undefined && (!/^(?!\d+$)[A-Za-z0-9-_]{1,128}$/.test(resolvedQualifier) || resolvedQualifier === "$LATEST")) return undefined;
  return { functionName, ...(resolvedQualifier ? { qualifier: resolvedQualifier } : {}) };
}

function urlIssues(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const output = validateDeclaredProperties(properties ?? {}, LAMBDA_URL_SCHEMA);
  if (!record(properties)) return output;
  if (typeof properties.AuthType === "string" && !["AWS_IAM", "NONE"].includes(properties.AuthType)) {
    issue(output, "Properties.AuthType", "AuthType must be AWS_IAM or NONE");
  }
  if (typeof properties.InvokeMode === "string" && !["BUFFERED", "RESPONSE_STREAM"].includes(properties.InvokeMode)) {
    issue(output, "Properties.InvokeMode", "InvokeMode must be BUFFERED or RESPONSE_STREAM");
  }
  if (properties.TargetFunctionArn !== undefined && typeof properties.TargetFunctionArn === "string"
    && !normalizedFunctionTarget(properties.TargetFunctionArn, properties.Qualifier, context)) {
    issue(output, "Properties.TargetFunctionArn", "TargetFunctionArn and Qualifier must identify an unqualified local function or a non-numeric local alias");
  } else if (properties.Qualifier !== undefined && typeof properties.Qualifier === "string"
    && !/^(?!\d+$)[A-Za-z0-9-_]{1,128}$/.test(properties.Qualifier)) {
    issue(output, "Properties.Qualifier", "Qualifier must be a non-numeric Lambda alias name");
  }
  corsIssues(properties.Cors, output);
  return output;
}

function canonicalCors(value: unknown): LambdaUrlCorsModel | undefined {
  if (!record(value)) return undefined;
  const output: LambdaUrlCorsModel = {
    ...(value.AllowCredentials !== undefined ? { AllowCredentials: Boolean(value.AllowCredentials) } : {}),
    ...(Array.isArray(value.AllowHeaders) ? { AllowHeaders: [...value.AllowHeaders].map(String).sort() } : {}),
    ...(Array.isArray(value.AllowMethods) ? { AllowMethods: [...value.AllowMethods].map(item => String(item).toUpperCase()).sort() } : {}),
    ...(Array.isArray(value.AllowOrigins) ? { AllowOrigins: [...value.AllowOrigins].map(String).sort() } : {}),
    ...(Array.isArray(value.ExposeHeaders) ? { ExposeHeaders: [...value.ExposeHeaders].map(String).sort() } : {}),
    ...(value.MaxAge !== undefined ? { MaxAge: Number(value.MaxAge) } : {}),
  };
  return Object.keys(output).length ? Object.freeze(output) : undefined;
}

function urlPath(model: Pick<LambdaUrlModel, "TargetFunctionArn" | "Qualifier">): string {
  const query = model.Qualifier ? `?Qualifier=${encodeURIComponent(model.Qualifier)}` : "";
  return `/2021-10-31/functions/${encodeURIComponent(model.TargetFunctionArn)}/url${query}`;
}

function parseFunctionArn(value: string): { functionName: string; qualifier?: string } | undefined {
  const match = value.match(/^arn:[^:]+:lambda:[^:]+:\d{12}:function:([A-Za-z0-9-_]{1,64})(?::([^:]+))?$/);
  return match ? { functionName: match[1], ...(match[2] ? { qualifier: match[2] } : {}) } : undefined;
}

function urlModelFromService(current: any): LambdaUrlModel {
  const target = parseFunctionArn(String(current.FunctionArn));
  if (!target) throw new AwsError("InternalFailure", "Lambda returned an invalid FunctionArn for the URL configuration", 500);
  return Object.freeze({
    AuthType: String(current.AuthType) as LambdaUrlModel["AuthType"],
    ...(current.Cors !== undefined && canonicalCors(current.Cors) ? { Cors: canonicalCors(current.Cors)! } : {}),
    InvokeMode: String(current.InvokeMode ?? "BUFFERED") as LambdaUrlModel["InvokeMode"],
    TargetFunctionArn: target.functionName,
    ...(target.qualifier ? { Qualifier: target.qualifier } : {}),
  });
}

export function createLambdaUrlProvider(lambda: LambdaService): ProductionResourceProvider<LambdaUrlModel> {
  const invoke = invoker(lambda);
  const success = (model: LambdaUrlModel, current: any): ProviderSuccess<LambdaUrlModel> => {
    const physicalId = String(current.FunctionArn);
    return {
      status: "SUCCESS",
      physicalId,
      model: {
        physicalId,
        properties: model,
        attributes: { FunctionArn: physicalId, FunctionUrl: String(current.FunctionUrl) },
      },
    };
  };
  const readCurrent = async (model: Pick<LambdaUrlModel, "TargetFunctionArn" | "Qualifier">, context: ProviderContext): Promise<any> => (
    await invoke<any>(context, "GET", urlPath(model))
  ).body;

  return {
    typeName: LAMBDA_URL_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: LAMBDA_URL_SCHEMA,
    validate: urlIssues,
    canonicalize(properties: unknown, context: ProviderContext): LambdaUrlModel {
      const issues = urlIssues(properties, context);
      if (issues.length) throwIssues(issues);
      const input = properties as Record<string, unknown>;
      const target = normalizedFunctionTarget(String(input.TargetFunctionArn), input.Qualifier, context)!;
      const cors = canonicalCors(input.Cors);
      return Object.freeze({
        AuthType: String(input.AuthType) as LambdaUrlModel["AuthType"],
        ...(cors ? { Cors: cors } : {}),
        InvokeMode: String(input.InvokeMode ?? "BUFFERED") as LambdaUrlModel["InvokeMode"],
        TargetFunctionArn: target.functionName,
        ...(target.qualifier ? { Qualifier: target.qualifier } : {}),
      });
    },
    plan(previous, desired) { return plan(previous, desired, LAMBDA_URL_SCHEMA); },
    async create(desired, context) {
      try {
        try {
          const current = await readCurrent(desired, context);
          const actual = urlModelFromService(current);
          if (!same(actual, desired)) {
            return { status: "FAILED", errorCode: "ResourceConflictException", message: `A different function URL configuration already exists for ${current.FunctionArn}` };
          }
          return success(actual, current);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        const current = (await invoke<any>(context, "POST", urlPath(desired), {
          AuthType: desired.AuthType,
          ...(desired.Cors ? { Cors: desired.Cors } : {}),
          InvokeMode: desired.InvokeMode,
        })).body;
        return success(desired, current);
      } catch (error) {
        return failure<LambdaUrlModel>(error);
      }
    },
    async read(physicalId, context): Promise<ProviderReadResult<LambdaUrlModel>> {
      const target = parseFunctionArn(physicalId);
      if (!target) return { status: "NOT_FOUND", physicalId };
      const locator = { TargetFunctionArn: target.functionName, ...(target.qualifier ? { Qualifier: target.qualifier } : {}) };
      try {
        const current = await readCurrent(locator, context);
        if (String(current.FunctionArn) !== physicalId) {
          return { status: "FAILED", errorCode: "OwnershipConflict", message: "Function URL identity no longer matches its CloudFormation resource" };
        }
        return success(urlModelFromService(current), current);
      } catch (error) {
        return isNotFound(error)
          ? { status: "NOT_FOUND", physicalId }
          : failure<LambdaUrlModel>(error) as ProviderReadResult<LambdaUrlModel>;
      }
    },
    async update(physicalId, _previous, desired, context): Promise<ProviderUpdateResult<LambdaUrlModel>> {
      const target = parseFunctionArn(physicalId);
      if (!target || target.functionName !== desired.TargetFunctionArn || target.qualifier !== desired.Qualifier) {
        return { status: "FAILED", errorCode: "RequiresReplacement", message: "TargetFunctionArn and Qualifier changes require replacement" };
      }
      try {
        const current = (await invoke<any>(context, "PUT", urlPath(desired), {
          AuthType: desired.AuthType,
          Cors: desired.Cors ?? {},
          InvokeMode: desired.InvokeMode,
        })).body;
        return success(urlModelFromService(current), current);
      } catch (error) {
        return failure<LambdaUrlModel>(error);
      }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      const target = parseFunctionArn(physicalId);
      if (!target) return { status: "NOT_FOUND", physicalId };
      const locator = { TargetFunctionArn: target.functionName, ...(target.qualifier ? { Qualifier: target.qualifier } : {}) };
      try {
        const current = await readCurrent(locator, context);
        if (String(current.FunctionArn) !== physicalId) {
          return { status: "FAILED", errorCode: "OwnershipConflict", message: "Function URL identity no longer matches its CloudFormation resource" };
        }
        await invoke(context, "DELETE", urlPath(locator));
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return isNotFound(error)
          ? { status: "NOT_FOUND", physicalId }
          : failure<LambdaUrlModel>(error) as ProviderDeleteResult;
      }
    },
    ref(model) { return model.physicalId; },
    getAtt(model, attribute) {
      if (attribute === "FunctionArn" || attribute === "FunctionUrl") return model.attributes[attribute];
      throw new ProviderReferenceError(LAMBDA_URL_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}

function codeSigningIssues(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const output = validateDeclaredProperties(properties ?? {}, LAMBDA_CODE_SIGNING_CONFIG_SCHEMA);
  if (!record(properties)) return output;
  if (record(properties.AllowedPublishers)) {
    rejectUnknown(properties.AllowedPublishers, "Properties.AllowedPublishers", ["SigningProfileVersionArns"], output);
    const publishers = properties.AllowedPublishers.SigningProfileVersionArns;
    if (!Array.isArray(publishers) || publishers.length < 1 || publishers.length > 20 || publishers.some(value => typeof value !== "string")) {
      issue(output, "Properties.AllowedPublishers.SigningProfileVersionArns", "SigningProfileVersionArns must contain 1-20 strings");
    } else {
      if (new Set(publishers).size !== publishers.length) issue(output, "Properties.AllowedPublishers.SigningProfileVersionArns", "Signing profile version ARNs must be unique");
      const pattern = /^arn:([^:]+):signer:([^:]+):(\d{12}):\/signing-profiles\/([A-Za-z0-9_]{2,64})\/([A-Za-z0-9]+)$/;
      for (const [index, publisher] of publishers.entries()) {
        const parsed = String(publisher).match(pattern);
        if (!parsed || parsed[1] !== context.partition || parsed[2] !== context.region || parsed[3] !== context.accountId) {
          issue(output, `Properties.AllowedPublishers.SigningProfileVersionArns.${index}`, "Signing profile version ARN must be a syntactically valid local account and Region descriptor");
        }
      }
    }
  } else if (properties.AllowedPublishers !== undefined) {
    issue(output, "Properties.AllowedPublishers", "AllowedPublishers must be an object");
  }
  if (properties.CodeSigningPolicies !== undefined) {
    if (!record(properties.CodeSigningPolicies)) issue(output, "Properties.CodeSigningPolicies", "CodeSigningPolicies must be an object");
    else {
      rejectUnknown(properties.CodeSigningPolicies, "Properties.CodeSigningPolicies", ["UntrustedArtifactOnDeployment"], output);
      if (!Object.hasOwn(properties.CodeSigningPolicies, "UntrustedArtifactOnDeployment")) {
        issue(output, "Properties.CodeSigningPolicies.UntrustedArtifactOnDeployment", "UntrustedArtifactOnDeployment is required when CodeSigningPolicies is present");
      } else if (!["Enforce", "Warn"].includes(String(properties.CodeSigningPolicies.UntrustedArtifactOnDeployment))) {
        issue(output, "Properties.CodeSigningPolicies.UntrustedArtifactOnDeployment", "UntrustedArtifactOnDeployment must be Enforce or Warn");
      }
    }
  }
  if (properties.Description !== undefined && (typeof properties.Description !== "string" || properties.Description.length > 256)) {
    issue(output, "Properties.Description", "Description must be a string no longer than 256 characters");
  }
  if (properties.Tags !== undefined) {
    if (!Array.isArray(properties.Tags)) issue(output, "Properties.Tags", "Tags must be an array");
    else {
      if (properties.Tags.length > 47) issue(output, "Properties.Tags", "At most 47 merged tags are supported because three ownership tags are reserved");
      const keys = new Set<string>();
      for (const [index, tag] of properties.Tags.entries()) {
        if (!record(tag)) {
          issue(output, `Properties.Tags.${index}`, "Each tag must be an object with Key and Value");
          continue;
        }
        rejectUnknown(tag, `Properties.Tags.${index}`, ["Key", "Value"], output);
        if (typeof tag.Key !== "string" || !tag.Key || tag.Key.length > 128 || tag.Key.toLowerCase().startsWith("aws:")) {
          issue(output, `Properties.Tags.${index}.Key`, "Tag Key must contain 1-128 characters and cannot use the aws: prefix");
        } else if (keys.has(tag.Key)) issue(output, `Properties.Tags.${index}.Key`, "Tag keys must be unique");
        else keys.add(tag.Key);
        if (typeof tag.Value !== "string" || tag.Value.length > 256) {
          issue(output, `Properties.Tags.${index}.Value`, "Tag Value must be a string no longer than 256 characters");
        }
      }
    }
  }
  return output;
}

function stackName(context: ProviderContext): string {
  return context.stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack";
}

function codeSigningTagMap(model: LambdaCodeSigningConfigModel, context: ProviderContext): Record<string, string> {
  return {
    ...Object.fromEntries(model.Tags.map(tag => [tag.Key, tag.Value])),
    "aws:cloudformation:stack-id": context.stackId,
    "aws:cloudformation:stack-name": stackName(context),
    "aws:cloudformation:logical-id": context.logicalId,
  };
}

function codeSigningOwned(tags: Readonly<Record<string, unknown>>, context: ProviderContext): boolean {
  return tags["aws:cloudformation:stack-id"] === context.stackId
    && tags["aws:cloudformation:logical-id"] === context.logicalId;
}

function codeSigningModel(current: any, tags: Readonly<Record<string, unknown>>): LambdaCodeSigningConfigModel {
  return Object.freeze({
    AllowedPublishers: Object.freeze({
      SigningProfileVersionArns: Object.freeze([...(current.AllowedPublishers?.SigningProfileVersionArns ?? [])].map(String).sort()),
    }),
    CodeSigningPolicies: Object.freeze({
      UntrustedArtifactOnDeployment: String(current.CodeSigningPolicies?.UntrustedArtifactOnDeployment ?? "Warn") as "Enforce" | "Warn",
    }),
    Description: String(current.Description ?? ""),
    Tags: Object.freeze(Object.entries(tags)
      .filter(([key]) => !key.startsWith("aws:cloudformation:"))
      .map(([Key, Value]) => Object.freeze({ Key, Value: String(Value) }))
      .sort((left, right) => left.Key.localeCompare(right.Key))),
  });
}

export function createLambdaCodeSigningConfigProvider(
  lambda: LambdaService,
): ProductionResourceProvider<LambdaCodeSigningConfigModel> {
  const invoke = invoker(lambda);
  const path = (arn: string) => `/2020-04-22/code-signing-configs/${encodeURIComponent(arn)}`;
  const tagPath = (arn: string) => `/2017-03-31/tags/${encodeURIComponent(arn)}`;
  const getTags = async (arn: string, context: ProviderContext): Promise<Record<string, unknown>> => (
    await invoke<any>(context, "GET", tagPath(arn))
  ).body.Tags ?? {};
  const get = async (arn: string, context: ProviderContext): Promise<any> => (
    await invoke<any>(context, "GET", path(arn))
  ).body.CodeSigningConfig;
  const success = (
    model: LambdaCodeSigningConfigModel,
    current: any,
  ): ProviderSuccess<LambdaCodeSigningConfigModel> => {
    const physicalId = String(current.CodeSigningConfigArn);
    return {
      status: "SUCCESS",
      physicalId,
      model: {
        physicalId,
        properties: model,
        attributes: {
          CodeSigningConfigArn: physicalId,
          CodeSigningConfigId: String(current.CodeSigningConfigId),
        },
      },
    };
  };
  const recoverOwned = async (context: ProviderContext): Promise<{ current: any; tags: Record<string, unknown> } | undefined> => {
    const response = (await invoke<any>(context, "GET", "/2020-04-22/code-signing-configs?MaxItems=10000")).body;
    const matches: Array<{ current: any; tags: Record<string, unknown> }> = [];
    for (const current of response.CodeSigningConfigs ?? []) {
      const arn = String(current.CodeSigningConfigArn);
      const tags = await getTags(arn, context);
      if (codeSigningOwned(tags, context)) matches.push({ current, tags });
    }
    if (matches.length > 1) throw new AwsError("ResourceConflictException", "Multiple code signing configurations carry this CloudFormation ownership identity", 409);
    return matches[0];
  };
  const reconcileTags = async (
    arn: string,
    desired: LambdaCodeSigningConfigModel,
    context: ProviderContext,
  ): Promise<Record<string, unknown>> => {
    const current = await getTags(arn, context);
    const wanted = codeSigningTagMap(desired, context);
    const removals = Object.keys(current).filter(key => !Object.hasOwn(wanted, key)).sort();
    if (removals.length) {
      await invoke(context, "DELETE", `${tagPath(arn)}?${removals.map(key => `tagKeys=${encodeURIComponent(key)}`).join("&")}`);
    }
    const additions = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => current[key] !== value));
    if (Object.keys(additions).length) await invoke(context, "POST", tagPath(arn), { Tags: additions });
    return await getTags(arn, context);
  };

  return {
    typeName: LAMBDA_CODE_SIGNING_CONFIG_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: LAMBDA_CODE_SIGNING_CONFIG_SCHEMA,
    validate: codeSigningIssues,
    canonicalize(properties: unknown, context: ProviderContext): LambdaCodeSigningConfigModel {
      const issues = codeSigningIssues(properties, context);
      if (issues.length) throwIssues(issues);
      const input = properties as Record<string, any>;
      return Object.freeze({
        AllowedPublishers: Object.freeze({
          SigningProfileVersionArns: Object.freeze([...input.AllowedPublishers.SigningProfileVersionArns].map(String).sort()),
        }),
        CodeSigningPolicies: Object.freeze({
          UntrustedArtifactOnDeployment: String(input.CodeSigningPolicies?.UntrustedArtifactOnDeployment ?? "Warn") as "Enforce" | "Warn",
        }),
        Description: String(input.Description ?? ""),
        Tags: Object.freeze((input.Tags ?? [])
          .map((tag: any) => Object.freeze({ Key: String(tag.Key), Value: String(tag.Value) }))
          .sort((left: { Key: string }, right: { Key: string }) => left.Key.localeCompare(right.Key))),
      });
    },
    plan(previous, desired) { return plan(previous, desired, LAMBDA_CODE_SIGNING_CONFIG_SCHEMA); },
    async create(desired, context) {
      try {
        const recovered = await recoverOwned(context);
        if (recovered) {
          const actual = codeSigningModel(recovered.current, recovered.tags);
          if (!same(actual, desired)) {
            return { status: "FAILED", errorCode: "ResourceConflictException", message: "The owned code signing configuration has different contents" };
          }
          return success(actual, recovered.current);
        }
        const current = (await invoke<any>(context, "POST", "/2020-04-22/code-signing-configs", {
          AllowedPublishers: desired.AllowedPublishers,
          CodeSigningPolicies: desired.CodeSigningPolicies,
          Description: desired.Description,
          Tags: codeSigningTagMap(desired, context),
        })).body.CodeSigningConfig;
        return success(desired, current);
      } catch (error) {
        return failure<LambdaCodeSigningConfigModel>(error);
      }
    },
    async read(physicalId, context): Promise<ProviderReadResult<LambdaCodeSigningConfigModel>> {
      try {
        const current = await get(physicalId, context);
        const tags = await getTags(physicalId, context);
        if (!codeSigningOwned(tags, context)) {
          return { status: "FAILED", errorCode: "OwnershipConflict", message: "Code signing configuration is not owned by this stack resource" };
        }
        return success(codeSigningModel(current, tags), current);
      } catch (error) {
        return isNotFound(error)
          ? { status: "NOT_FOUND", physicalId }
          : failure<LambdaCodeSigningConfigModel>(error) as ProviderReadResult<LambdaCodeSigningConfigModel>;
      }
    },
    async update(physicalId, _previous, desired, context): Promise<ProviderUpdateResult<LambdaCodeSigningConfigModel>> {
      try {
        const owned = await this.read(physicalId, context);
        if (owned.status !== "SUCCESS") return owned as ProviderUpdateResult<LambdaCodeSigningConfigModel>;
        await invoke(context, "PUT", path(physicalId), {
          AllowedPublishers: desired.AllowedPublishers,
          CodeSigningPolicies: desired.CodeSigningPolicies,
          Description: desired.Description,
        });
        const tags = await reconcileTags(physicalId, desired, context);
        const current = await get(physicalId, context);
        return success(codeSigningModel(current, tags), current);
      } catch (error) {
        return failure<LambdaCodeSigningConfigModel>(error);
      }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try {
        const current = await get(physicalId, context);
        const tags = await getTags(physicalId, context);
        if (!codeSigningOwned(tags, context)) {
          return { status: "FAILED", errorCode: "OwnershipConflict", message: "Code signing configuration is not owned by this stack resource" };
        }
        if (String(current.CodeSigningConfigArn) !== physicalId) {
          return { status: "FAILED", errorCode: "OwnershipConflict", message: "Code signing configuration identity no longer matches CloudFormation state" };
        }
        await invoke(context, "DELETE", path(physicalId));
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return isNotFound(error)
          ? { status: "NOT_FOUND", physicalId }
          : failure<LambdaCodeSigningConfigModel>(error) as ProviderDeleteResult;
      }
    },
    ref(model: ProviderReadModel<LambdaCodeSigningConfigModel>) { return model.physicalId; },
    getAtt(model, attribute) {
      if (attribute === "CodeSigningConfigArn" || attribute === "CodeSigningConfigId") return model.attributes[attribute];
      throw new ProviderReferenceError(LAMBDA_CODE_SIGNING_CONFIG_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}

export function createLambdaCfn15Providers(lambda: LambdaService): readonly ProductionResourceProvider<any>[] {
  return [
    createLambdaLayerVersionPermissionProvider(lambda),
    createLambdaUrlProvider(lambda),
    createLambdaCodeSigningConfigProvider(lambda),
  ];
}
