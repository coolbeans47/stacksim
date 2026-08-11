import { createHash } from "node:crypto";
import type { LambdaService } from "../../lambda.js";
import type { S3Service } from "../../s3.js";
import { AwsError } from "../../errors.js";
import { createZip } from "../../core/zip-create.js";
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

export const LAMBDA_FUNCTION_TYPE = "AWS::Lambda::Function";

export interface LambdaFunctionCodeModel {
  readonly S3Bucket?: string;
  readonly S3Key?: string;
  readonly S3ObjectVersion?: string;
  readonly ZipFile?: string;
}

export interface LambdaFunctionModel {
  readonly FunctionName: string;
  readonly Code: LambdaFunctionCodeModel;
  readonly Handler: string;
  readonly Role: string;
  readonly Runtime: string;
  readonly PackageType?: "Zip";
  readonly Architectures?: readonly string[];
  readonly Description?: string;
  readonly Environment?: { readonly Variables: Readonly<Record<string, string>> };
  readonly Layers?: readonly string[];
  readonly MemorySize?: number;
  readonly Timeout?: number;
  readonly ReservedConcurrentExecutions?: number;
  readonly EphemeralStorage?: { readonly Size: number };
  readonly LoggingConfig?: {
    readonly ApplicationLogLevel?: "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";
    readonly LogFormat?: "JSON" | "Text";
    readonly LogGroup?: string;
    readonly SystemLogLevel?: "DEBUG" | "INFO" | "WARN";
  };
  readonly TracingConfig?: { readonly Mode: string };
  readonly DeadLetterConfig?: { readonly TargetArn?: string };
  readonly CodeSigningConfigArn?: string;
  readonly Tags?: readonly { readonly Key: string; readonly Value: string }[];
}

export const LAMBDA_FUNCTION_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LAMBDA_FUNCTION_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    FunctionName: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    Code: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
    Handler: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    Role: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    Runtime: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    PackageType: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    Architectures: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    Description: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Environment: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    Layers: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    MemorySize: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    Timeout: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    ReservedConcurrentExecutions: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    EphemeralStorage: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    LoggingConfig: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    TracingConfig: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    DeadLetterConfig: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    CodeSigningConfigArn: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Function name" }),
  attributes: Object.freeze({ Arn: Object.freeze({ valueType: "string", description: "Function ARN" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: Object.freeze({
    deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    snapshotSupported: false,
  }),
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableObject<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stableObject) as T;
  if (record(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableObject(item)])) as T;
  return value;
}

function stackName(context: ProviderContext): string {
  return context.stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack";
}

function generatedName(context: ProviderContext): string {
  const suffix = createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex").slice(0, 10);
  const stack = stackName(context).replace(/[^A-Za-z0-9-_]/g, "-") || "stack";
  const logical = context.logicalId.replace(/[^A-Za-z0-9-_]/g, "-") || "Function";
  const bodyBudget = 64 - suffix.length - 1;
  const unbounded = `${stack}-${logical}`;
  if (unbounded.length <= bodyBudget) return `${unbounded}-${suffix}`;

  // CloudFormation-generated names must keep enough of both ownership
  // components to remain useful to ordinary IAM wildcard policies.  Giving a
  // long stack name the entire budget can erase the logical resource identity
  // (for example "TableManager") and make the resource unusable by its own
  // generated execution role.
  const stackBudget = Math.min(stack.length, 20);
  const logicalBudget = bodyBudget - stackBudget - 1;
  return `${stack.slice(0, stackBudget)}-${logical.slice(0, logicalBudget)}-${suffix}`;
}

function canonicalTags(value: unknown): readonly { Key: string; Value: string }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("Tags must be an array");
  return value.map(tag => {
    if (!record(tag) || typeof tag.Key !== "string" || typeof tag.Value !== "string") throw new TypeError("Each tag requires string Key and Value");
    return { Key: tag.Key, Value: tag.Value };
  }).sort((left, right) => left.Key.localeCompare(right.Key));
}

function tagMap(model: LambdaFunctionModel, context: ProviderContext): Record<string, string> {
  const result = Object.fromEntries((model.Tags ?? []).map(tag => [tag.Key, tag.Value]));
  result["aws:cloudformation:stack-id"] = context.stackId;
  result["aws:cloudformation:stack-name"] = stackName(context);
  result["aws:cloudformation:logical-id"] = context.logicalId;
  return result;
}

function validateNested(properties: Record<string, unknown>, context: ProviderContext): ProviderValidationIssue[] {
  const issues: ProviderValidationIssue[] = [];
  const invalid = (path: string, message: string) => issues.push({ code: "InvalidProperty", path, message });
  const unsupported = (path: string, message: string) => issues.push({ code: "UnsupportedProperty", path, message });
  const rejectUnknown = (value: Record<string, unknown>, path: string, allowed: readonly string[]) => {
    const accepted = new Set(allowed);
    for (const key of Object.keys(value)) if (!accepted.has(key)) unsupported(`${path}.${key}`, `${key} is not supported in ${path}`);
  };
  if (properties.FunctionName !== undefined && (typeof properties.FunctionName !== "string" || !/^[A-Za-z0-9-_]{1,64}$/.test(properties.FunctionName))) invalid("Properties.FunctionName", "FunctionName must match [A-Za-z0-9-_] and contain at most 64 characters");
  if (properties.PackageType !== undefined && properties.PackageType !== "Zip") invalid("Properties.PackageType", "CFN-06 supports only Zip functions; ECR image assets are unavailable");
  if (typeof properties.Role === "string" && !/^arn:(?:aws|aws-us-gov|aws-cn):iam::\d{12}:role\/.+/.test(properties.Role)) invalid("Properties.Role", "Role must be an IAM role ARN");
  if (typeof properties.Runtime === "string" && !/^(?:nodejs(?:18|20|22|24)\.x|python3\.13)$/.test(properties.Runtime)) invalid("Properties.Runtime", "The bounded provider accepts Node.js 18, 20, 22, and 24 and the pinned CDK deployment helper's python3.13 runtime");
  if (typeof properties.Handler === "string" && (!properties.Handler || properties.Handler.length > 128)) invalid("Properties.Handler", "Handler must contain between 1 and 128 characters");

  const code = properties.Code;
  if (record(code)) {
    const allowed = new Set(["S3Bucket", "S3Key", "S3ObjectVersion", "ZipFile"]);
    for (const key of Object.keys(code)) if (!allowed.has(key)) invalid(`Properties.Code.${key}`, `${key} is not supported; KMS and image code dependencies are unavailable`);
    const inline = code.ZipFile !== undefined;
    const s3 = code.S3Bucket !== undefined || code.S3Key !== undefined || code.S3ObjectVersion !== undefined;
    if (inline === s3) invalid("Properties.Code", "Code must specify exactly one of ZipFile or S3Bucket/S3Key");
    if (inline && (typeof code.ZipFile !== "string" || Buffer.byteLength(code.ZipFile) > 4 * 1024 * 1024)) invalid("Properties.Code.ZipFile", "ZipFile must be source text no larger than 4 MiB");
    if (s3 && (typeof code.S3Bucket !== "string" || !code.S3Bucket || typeof code.S3Key !== "string" || !code.S3Key || (code.S3ObjectVersion !== undefined && typeof code.S3ObjectVersion !== "string"))) invalid("Properties.Code", "S3 code requires string S3Bucket and S3Key and an optional string S3ObjectVersion");
    if (inline && (typeof properties.Handler !== "string" || !properties.Handler.startsWith("index."))) invalid("Properties.Handler", "Inline ZipFile source requires a handler in index.js");
  }
  if (properties.Architectures !== undefined && (!Array.isArray(properties.Architectures) || properties.Architectures.length !== 1 || !["x86_64", "arm64"].includes(String(properties.Architectures[0])))) invalid("Properties.Architectures", "Architectures must contain exactly x86_64 or arm64");
  if (properties.Layers !== undefined && (!Array.isArray(properties.Layers) || properties.Layers.length > 5 || new Set(properties.Layers).size !== properties.Layers.length || properties.Layers.some(value => typeof value !== "string" || !/^arn:(?:aws|aws-us-gov|aws-cn):lambda:[^:]+:\d{12}:layer:[A-Za-z0-9-_]+:\d+$/.test(value)))) invalid("Properties.Layers", "Layers must contain at most five unique layer version ARNs");
  if (properties.MemorySize !== undefined && (!Number.isInteger(properties.MemorySize) || Number(properties.MemorySize) < 128 || Number(properties.MemorySize) > 10_240)) invalid("Properties.MemorySize", "MemorySize must be an integer between 128 and 10240");
  if (properties.Timeout !== undefined && (!Number.isInteger(properties.Timeout) || Number(properties.Timeout) < 1 || Number(properties.Timeout) > 900)) invalid("Properties.Timeout", "Timeout must be an integer between 1 and 900");
  if (properties.ReservedConcurrentExecutions !== undefined && (!Number.isInteger(properties.ReservedConcurrentExecutions) || Number(properties.ReservedConcurrentExecutions) < 0)) invalid("Properties.ReservedConcurrentExecutions", "ReservedConcurrentExecutions must be a non-negative integer");
  if (properties.Environment !== undefined) {
    if (!record(properties.Environment) || !record(properties.Environment.Variables) || Object.values(properties.Environment.Variables).some(item => typeof item !== "string")) invalid("Properties.Environment", "Environment must contain a string Variables map");
    else {
      rejectUnknown(properties.Environment, "Properties.Environment", ["Variables"]);
      const variables = properties.Environment.Variables;
      if (Object.keys(variables).some(key => !/^[A-Za-z][A-Za-z0-9_]+$/.test(key)) || Buffer.byteLength(JSON.stringify(variables)) > 4096) invalid("Properties.Environment.Variables", "Lambda environment keys and string values must fit within 4 KB");
    }
  }
  if (properties.EphemeralStorage !== undefined) {
    if (!record(properties.EphemeralStorage) || !Number.isInteger(properties.EphemeralStorage.Size) || Number(properties.EphemeralStorage.Size) < 512 || Number(properties.EphemeralStorage.Size) > 10_240) invalid("Properties.EphemeralStorage", "EphemeralStorage.Size must be an integer between 512 and 10240");
    else rejectUnknown(properties.EphemeralStorage, "Properties.EphemeralStorage", ["Size"]);
  }
  if (properties.TracingConfig !== undefined) {
    if (!record(properties.TracingConfig) || !["Active", "PassThrough"].includes(String(properties.TracingConfig.Mode))) invalid("Properties.TracingConfig", "TracingConfig.Mode must be Active or PassThrough");
    else rejectUnknown(properties.TracingConfig, "Properties.TracingConfig", ["Mode"]);
  }
  if (properties.DeadLetterConfig !== undefined) {
    if (!record(properties.DeadLetterConfig) || (properties.DeadLetterConfig.TargetArn !== undefined && typeof properties.DeadLetterConfig.TargetArn !== "string")) invalid("Properties.DeadLetterConfig", "DeadLetterConfig.TargetArn must be a string");
    else rejectUnknown(properties.DeadLetterConfig, "Properties.DeadLetterConfig", ["TargetArn"]);
  }
  if (properties.CodeSigningConfigArn !== undefined) {
    const match = typeof properties.CodeSigningConfigArn === "string"
      ? properties.CodeSigningConfigArn.match(/^arn:([^:]+):lambda:([^:]+):(\d{12}):code-signing-config:(csc-[A-Za-z0-9]+)$/)
      : undefined;
    if (!match || match[1] !== context.partition || match[2] !== context.region || match[3] !== context.accountId) {
      invalid("Properties.CodeSigningConfigArn", "CodeSigningConfigArn must identify a local code signing configuration in the stack account and Region");
    }
  }
  if (properties.LoggingConfig !== undefined) {
    if (!record(properties.LoggingConfig)) invalid("Properties.LoggingConfig", "LoggingConfig must be an object");
    else {
      const config = properties.LoggingConfig;
      rejectUnknown(config, "Properties.LoggingConfig", ["ApplicationLogLevel", "LogFormat", "LogGroup", "SystemLogLevel"]);
      if (config.LogFormat !== undefined && !["JSON", "Text"].includes(String(config.LogFormat))) invalid("Properties.LoggingConfig.LogFormat", "LogFormat must be JSON or Text");
      if (config.ApplicationLogLevel !== undefined && !["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"].includes(String(config.ApplicationLogLevel))) invalid("Properties.LoggingConfig.ApplicationLogLevel", "ApplicationLogLevel is invalid");
      if (config.SystemLogLevel !== undefined && !["DEBUG", "INFO", "WARN"].includes(String(config.SystemLogLevel))) invalid("Properties.LoggingConfig.SystemLogLevel", "SystemLogLevel is invalid");
      if ((config.LogFormat ?? "Text") === "Text" && (config.ApplicationLogLevel !== undefined || config.SystemLogLevel !== undefined)) invalid("Properties.LoggingConfig", "ApplicationLogLevel and SystemLogLevel require JSON LogFormat");
      if (config.LogGroup !== undefined && (typeof config.LogGroup !== "string" || config.LogGroup.length < 1 || config.LogGroup.length > 512 || !/^[.\-_/#A-Za-z0-9]+$/.test(config.LogGroup) || config.LogGroup.startsWith("aws/"))) invalid("Properties.LoggingConfig.LogGroup", "LogGroup is invalid");
    }
  }
  try {
    const tags = canonicalTags(properties.Tags);
    if (Array.isArray(properties.Tags)) properties.Tags.forEach((tag, index) => { if (record(tag)) rejectUnknown(tag, `Properties.Tags[${index}]`, ["Key", "Value"]); });
    if (tags && (tags.length > 47 || new Set(tags.map(tag => tag.Key)).size !== tags.length || tags.some(tag => !tag.Key || tag.Key.toLowerCase().startsWith("aws:")))) invalid("Properties.Tags", "Tags require unique non-aws: keys and contain at most 47 entries after reserving the three CloudFormation ownership tags");
  } catch (error) { invalid("Properties.Tags", error instanceof Error ? error.message : String(error)); }
  if (properties.Runtime === "python3.13") {
    const variables = record(properties.Environment) && record(properties.Environment.Variables) ? properties.Environment.Variables : undefined;
    const content = record(properties.Code) ? properties.Code : undefined;
    if (properties.Handler !== "index.handler"
      || properties.Timeout !== 900
      || !Array.isArray(properties.Layers)
      || properties.Layers.length !== 1
      || !variables
      || Object.keys(variables).length !== 1
      || variables.AWS_CA_BUNDLE !== "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem"
      || content?.S3Key !== "97e9ebf0b174a5c8f7faa505739022b7f509edddffcab9211dcd08b759944c4f.zip") {
      invalid("Properties.Runtime", "python3.13 is reserved for the exact pinned CDK BucketDeployment helper resource");
    }
  }
  if (!properties.FunctionName && generatedName(context).length > 64) invalid("Properties.FunctionName", "Generated function name exceeds the service limit");
  return issues;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableObject(left)) === JSON.stringify(stableObject(right));
}

function success(model: LambdaFunctionModel, arn: string): ProviderSuccess<LambdaFunctionModel> {
  const readModel: ProviderReadModel<LambdaFunctionModel> = { physicalId: model.FunctionName, properties: model, attributes: { Arn: arn } };
  return { status: "SUCCESS", physicalId: model.FunctionName, model: readModel };
}

function failure(error: unknown): ProviderUpdateResult<LambdaFunctionModel> {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}

function isNotFound(error: unknown): boolean {
  return error instanceof AwsError && ["ResourceNotFoundException", "NotFoundException"].includes(error.code);
}

function configurationInput(model: LambdaFunctionModel, resetDefaults = false): Record<string, unknown> {
  if (resetDefaults) return { ...expectedConfiguration(model), Layers: [...(model.Layers ?? [])] };
  return {
    Role: model.Role,
    Handler: model.Handler,
    Runtime: model.Runtime,
    ...(model.Architectures ? { Architectures: [...model.Architectures] } : {}),
    ...(model.Description !== undefined ? { Description: model.Description } : {}),
    ...(model.Environment !== undefined ? { Environment: structuredClone(model.Environment) } : {}),
    ...(model.Layers !== undefined ? { Layers: [...model.Layers] } : {}),
    ...(model.MemorySize !== undefined ? { MemorySize: model.MemorySize } : {}),
    ...(model.Timeout !== undefined ? { Timeout: model.Timeout } : {}),
    ...(model.EphemeralStorage !== undefined ? { EphemeralStorage: structuredClone(model.EphemeralStorage) } : {}),
    ...(model.LoggingConfig !== undefined ? { LoggingConfig: structuredClone(model.LoggingConfig) } : {}),
    ...(model.TracingConfig !== undefined ? { TracingConfig: structuredClone(model.TracingConfig) } : {}),
    ...(model.DeadLetterConfig !== undefined ? { DeadLetterConfig: structuredClone(model.DeadLetterConfig) } : {}),
  };
}

const CONFIGURATION_KEYS = [
  "Role", "Handler", "Runtime", "Architectures", "Description", "Environment", "MemorySize", "Timeout",
  "EphemeralStorage", "LoggingConfig", "TracingConfig", "DeadLetterConfig",
] as const;

function expectedConfiguration(model: LambdaFunctionModel): Record<(typeof CONFIGURATION_KEYS)[number], unknown> {
  return {
    Role: model.Role,
    Handler: model.Handler,
    Runtime: model.Runtime,
    Architectures: [...(model.Architectures ?? ["x86_64"])],
    Description: model.Description ?? "",
    Environment: structuredClone(model.Environment ?? { Variables: {} }),
    MemorySize: model.MemorySize ?? 128,
    Timeout: model.Timeout ?? 3,
    EphemeralStorage: structuredClone(model.EphemeralStorage ?? { Size: 512 }),
    LoggingConfig: {
      LogFormat: model.LoggingConfig?.LogFormat ?? "Text",
      ...(model.LoggingConfig?.ApplicationLogLevel !== undefined ? { ApplicationLogLevel: model.LoggingConfig.ApplicationLogLevel } : {}),
      ...(model.LoggingConfig?.SystemLogLevel !== undefined ? { SystemLogLevel: model.LoggingConfig.SystemLogLevel } : {}),
      LogGroup: model.LoggingConfig?.LogGroup ?? `/aws/lambda/${model.FunctionName}`,
    },
    TracingConfig: structuredClone(model.TracingConfig ?? { Mode: "PassThrough" }),
    DeadLetterConfig: structuredClone(model.DeadLetterConfig ?? {}),
  };
}

function configurationMatches(configuration: Record<string, unknown>, model: LambdaFunctionModel): boolean {
  const expected = expectedConfiguration(model);
  const actualLayers = Array.isArray(configuration.Layers) ? configuration.Layers.map(layer => record(layer) ? layer.Arn : layer) : [];
  return CONFIGURATION_KEYS.every(key => same(configuration[key], expected[key])) && same(actualLayers, model.Layers ?? []);
}

function inProgress(physicalId: string, phase: string, callbackAfterMs = 25): ProviderInProgress {
  return {
    status: "IN_PROGRESS",
    callbackAfterMs,
    checkpoint: { schemaVersion: 1, callbackContext: { phase }, physicalId },
  };
}

async function codeBytes(model: LambdaFunctionModel, s3: S3Service): Promise<Buffer> {
  if (model.Code.ZipFile !== undefined) return createZip([{ name: "index.js", content: model.Code.ZipFile }]);
  const maximumBytes = Number(process.env.STACKSIM_LAMBDA_ZIP_LIMIT ?? 50 * 1024 * 1024);
  return (await s3.readObjectBytes(model.Code.S3Bucket!, model.Code.S3Key!, model.Code.S3ObjectVersion, maximumBytes)).body;
}

function codeDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("base64");
}

export function createLambdaFunctionProvider(lambda: LambdaService, s3: S3Service): ProductionResourceProvider<LambdaFunctionModel> {
  const invoke = <T>(context: ProviderContext, method: string, path: string, input?: unknown) => invokeJsonService<T>({
    method,
    path,
    input,
    handle: (req, res, pathname, url) => lambda.handle(req, res, pathname, url, context.principal.identity),
  });

  const get = async (name: string, context: ProviderContext) => (await invoke<any>(context, "GET", `/2015-03-31/functions/${encodeURIComponent(name)}`)).body;
  const getCodeSigningConfigArn = async (name: string, context: ProviderContext): Promise<string | undefined> => {
    try {
      const arn = (await invoke<any>(context, "GET", `/2020-06-30/functions/${encodeURIComponent(name)}/code-signing-config`)).body.CodeSigningConfigArn;
      return typeof arn === "string" && arn ? arn : undefined;
    } catch (error) {
      if (error instanceof AwsError && error.code === "CodeSigningConfigNotFoundException") return undefined;
      throw error;
    }
  };
  const owned = (current: any, context: ProviderContext): boolean => {
    const currentTags = current.Tags ?? {};
    return currentTags["aws:cloudformation:stack-id"] === context.stackId
      && currentTags["aws:cloudformation:logical-id"] === context.logicalId;
  };
  const reconcile = async (
    physicalId: string,
    current: any,
    desired: LambdaFunctionModel,
    context: ProviderContext,
    changes: Readonly<{ code: boolean; codeSigning: boolean; configuration: boolean; concurrency: boolean; tags: boolean }>,
  ): Promise<ProviderUpdateResult<LambdaFunctionModel>> => {
    const configuration = current.Configuration ?? {};
    if (configuration.State === "Pending" || configuration.LastUpdateStatus === "InProgress") {
      return inProgress(physicalId, "stabilize");
    }
    if (configuration.State !== "Active" || configuration.LastUpdateStatus !== "Successful") {
      return { status: "FAILED", errorCode: "NotStabilized", message: configuration.StateReason ?? configuration.LastUpdateStatusReason ?? `Function ${physicalId} did not become active` };
    }

    if (changes.codeSigning) {
      const currentCodeSigningConfigArn = await getCodeSigningConfigArn(physicalId, context);
      if (currentCodeSigningConfigArn !== desired.CodeSigningConfigArn) {
        const associationPath = `/2020-06-30/functions/${encodeURIComponent(physicalId)}/code-signing-config`;
        if (desired.CodeSigningConfigArn === undefined) await invoke(context, "DELETE", associationPath);
        else await invoke(context, "PUT", associationPath, { CodeSigningConfigArn: desired.CodeSigningConfigArn });
        return inProgress(physicalId, "after-code-signing-config");
      }
    }

    if (changes.code) {
      const bytes = await codeBytes(desired, s3);
      const wantedArchitectures = [...(desired.Architectures ?? ["x86_64"])];
      if (configuration.CodeSha256 !== codeDigest(bytes) || !same(configuration.Architectures, wantedArchitectures)) {
        await invoke(context, "PUT", `/2015-03-31/functions/${encodeURIComponent(physicalId)}/code`, {
          ZipFile: bytes.toString("base64"),
          Architectures: wantedArchitectures,
        });
        return inProgress(physicalId, "after-code");
      }
    }

    if (changes.configuration && !configurationMatches(configuration, desired)) {
      const wanted = { ...expectedConfiguration(desired), Layers: [...(desired.Layers ?? [])] };
      const actualLogging = record(configuration.LoggingConfig) ? configuration.LoggingConfig : {};
      const wantedLogging = wanted.LoggingConfig as Record<string, unknown>;
      const mustClearJsonLevels = wantedLogging.LogFormat === "JSON"
        && ((desired.LoggingConfig?.ApplicationLogLevel === undefined && actualLogging.ApplicationLogLevel !== undefined)
          || (desired.LoggingConfig?.SystemLogLevel === undefined && actualLogging.SystemLogLevel !== undefined));
      const input = mustClearJsonLevels
        ? { ...wanted, LoggingConfig: { LogFormat: "Text", LogGroup: wantedLogging.LogGroup } }
        : wanted;
      await invoke(context, "PUT", `/2015-03-31/functions/${encodeURIComponent(physicalId)}/configuration`, input);
      return inProgress(physicalId, mustClearJsonLevels ? "after-configuration-log-reset" : "after-configuration");
    }

    if (changes.concurrency) {
      const actual = current.Concurrency?.ReservedConcurrentExecutions;
      if (actual !== desired.ReservedConcurrentExecutions) {
        const path = `/2017-10-31/functions/${encodeURIComponent(physicalId)}/concurrency`;
        if (desired.ReservedConcurrentExecutions === undefined) await invoke(context, "DELETE", path);
        else await invoke(context, "PUT", path, { ReservedConcurrentExecutions: desired.ReservedConcurrentExecutions });
        return inProgress(physicalId, "after-concurrency");
      }
    }

    if (changes.tags) {
      const arn = `arn:${context.partition}:lambda:${context.region}:${context.accountId}:function:${physicalId}`;
      const path = `/2017-03-31/tags/${encodeURIComponent(arn)}`;
      const actual = current.Tags ?? {};
      const wanted = tagMap(desired, context);
      const removals = Object.keys(actual).filter(key => !Object.hasOwn(wanted, key)).sort();
      if (removals.length) {
        await invoke(context, "DELETE", `${path}?${removals.map(key => `tagKeys=${encodeURIComponent(key)}`).join("&")}`);
        return inProgress(physicalId, "after-tag-removal");
      }
      const additions = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => actual[key] !== value).sort(([left], [right]) => left.localeCompare(right)));
      if (Object.keys(additions).length) {
        await invoke(context, "POST", path, { Tags: additions });
        return inProgress(physicalId, "after-tag-update");
      }
    }

    return success(desired, configuration.FunctionArn);
  };

  const provider: ProductionResourceProvider<LambdaFunctionModel> = {
    typeName: LAMBDA_FUNCTION_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: LAMBDA_FUNCTION_SCHEMA,

    validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[] {
      const shallow = validateDeclaredProperties(properties ?? {}, LAMBDA_FUNCTION_SCHEMA);
      return !record(properties) ? shallow : [...shallow, ...validateNested(properties, context)];
    },

    canonicalize(properties: unknown, context: ProviderContext): LambdaFunctionModel {
      if (!record(properties)) throw new TypeError(`${LAMBDA_FUNCTION_TYPE} Properties must be an object`);
      const issues = [...validateDeclaredProperties(properties, LAMBDA_FUNCTION_SCHEMA), ...validateNested(properties, context)];
      if (issues.length) throw new TypeError(issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
      const code = stableObject(structuredClone(properties.Code as LambdaFunctionCodeModel));
      const environment = properties.Environment === undefined ? undefined : { Variables: stableObject(structuredClone((properties.Environment as any).Variables)) };
      return stableObject({
        FunctionName: String(properties.FunctionName ?? generatedName(context)),
        Code: code,
        Handler: String(properties.Handler),
        Role: String(properties.Role),
        Runtime: String(properties.Runtime),
        ...(properties.PackageType !== undefined ? { PackageType: "Zip" as const } : {}),
        ...(properties.Architectures !== undefined ? { Architectures: [...properties.Architectures as string[]] } : {}),
        ...(properties.Description !== undefined ? { Description: String(properties.Description) } : {}),
        ...(environment ? { Environment: environment } : {}),
        ...(properties.Layers !== undefined ? { Layers: [...properties.Layers as string[]] } : {}),
        ...(properties.MemorySize !== undefined ? { MemorySize: Number(properties.MemorySize) } : {}),
        ...(properties.Timeout !== undefined ? { Timeout: Number(properties.Timeout) } : {}),
        ...(properties.ReservedConcurrentExecutions !== undefined ? { ReservedConcurrentExecutions: Number(properties.ReservedConcurrentExecutions) } : {}),
        ...(properties.EphemeralStorage !== undefined ? { EphemeralStorage: { Size: Number((properties.EphemeralStorage as any).Size) } } : {}),
        ...(properties.LoggingConfig !== undefined ? { LoggingConfig: stableObject(Object.fromEntries(["ApplicationLogLevel", "LogFormat", "LogGroup", "SystemLogLevel"].filter(key => (properties.LoggingConfig as any)[key] !== undefined).map(key => [key, (properties.LoggingConfig as any)[key]]))) as LambdaFunctionModel["LoggingConfig"] } : {}),
        ...(properties.TracingConfig !== undefined ? { TracingConfig: { Mode: String((properties.TracingConfig as any).Mode) } } : {}),
        ...(properties.DeadLetterConfig !== undefined ? { DeadLetterConfig: { ...((properties.DeadLetterConfig as any).TargetArn === undefined ? {} : { TargetArn: String((properties.DeadLetterConfig as any).TargetArn) }) } } : {}),
        ...(properties.CodeSigningConfigArn !== undefined ? { CodeSigningConfigArn: String(properties.CodeSigningConfigArn) } : {}),
        ...(properties.Tags !== undefined ? { Tags: canonicalTags(properties.Tags)! } : {}),
      });
    },

    plan(previous: LambdaFunctionModel | undefined, desired: LambdaFunctionModel): ProviderPlan<LambdaFunctionModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const keys = [...new Set([...Object.keys(previous), ...Object.keys(desired)])].filter(key => !same((previous as any)[key], (desired as any)[key])).sort();
      if (!keys.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      const replacements = keys.filter(key => key === "FunctionName" || key === "PackageType");
      return replacements.length ? { action: "REPLACE", desired, changedProperties: keys, replacementProperties: replacements, replacementOrder: "CREATE_BEFORE_DELETE" } : { action: "UPDATE", desired, changedProperties: keys, replacementProperties: [] };
    },

    async create(desired: LambdaFunctionModel, context: ProviderContext) {
      try {
        const bytes = await codeBytes(desired, s3);
        try {
          const current = await get(desired.FunctionName, context);
          if (!owned(current, context) || current.Configuration?.CodeSha256 !== codeDigest(bytes)) {
            return { status: "FAILED", errorCode: "AlreadyExists", message: `Function ${desired.FunctionName} already exists and is not owned by this stack resource` };
          }
          const currentCodeSigningConfigArn = await getCodeSigningConfigArn(desired.FunctionName, context);
          if (currentCodeSigningConfigArn !== desired.CodeSigningConfigArn) {
            return {
              status: "FAILED",
              errorCode: "OwnershipConflict",
              message: `Recovered function ${desired.FunctionName} has a different code signing configuration`,
            };
          }
          return await reconcile(desired.FunctionName, current, desired, context, { code: false, codeSigning: false, configuration: true, concurrency: true, tags: true });
        } catch (error) { if (!isNotFound(error)) throw error; }
        await invoke(context, "POST", "/2015-03-31/functions", {
          FunctionName: desired.FunctionName,
          Code: { ZipFile: bytes.toString("base64") },
          PackageType: "Zip",
          ...configurationInput(desired),
          ...(desired.CodeSigningConfigArn ? { CodeSigningConfigArn: desired.CodeSigningConfigArn } : {}),
          Tags: tagMap(desired, context),
        });
        return inProgress(desired.FunctionName, "after-create");
      } catch (error) { return failure(error); }
    },

    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<LambdaFunctionModel>> {
      try {
        const current = await get(physicalId, context); const configuration = current.Configuration ?? {};
        if (!owned(current, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Function ${physicalId} is not owned by this stack resource` };
        const codeSigningConfigArn = await getCodeSigningConfigArn(physicalId, context);
        const properties: LambdaFunctionModel = {
          FunctionName: configuration.FunctionName,
          Code: { ZipFile: `<sha256:${configuration.CodeSha256}>` },
          Handler: configuration.Handler,
          Role: configuration.Role,
          Runtime: configuration.Runtime,
          Architectures: configuration.Architectures,
          Description: configuration.Description,
          Environment: configuration.Environment?.Variables ? { Variables: stableObject(configuration.Environment.Variables) } : undefined,
          Layers: Array.isArray(configuration.Layers) ? configuration.Layers.map((layer: any) => record(layer) ? String(layer.Arn) : String(layer)) : undefined,
          MemorySize: configuration.MemorySize,
          Timeout: configuration.Timeout,
          ReservedConcurrentExecutions: current.Concurrency?.ReservedConcurrentExecutions,
          EphemeralStorage: configuration.EphemeralStorage,
          LoggingConfig: configuration.LoggingConfig,
          TracingConfig: configuration.TracingConfig,
          DeadLetterConfig: configuration.DeadLetterConfig,
          ...(codeSigningConfigArn ? { CodeSigningConfigArn: codeSigningConfigArn } : {}),
          Tags: Object.entries(current.Tags ?? {}).filter(([key]) => !key.startsWith("aws:cloudformation:")).map(([Key, Value]) => ({ Key, Value: String(Value) })).sort((a, b) => a.Key.localeCompare(b.Key)),
        };
        return success(stableObject(properties), configuration.FunctionArn);
      } catch (error) { return isNotFound(error) ? { status: "NOT_FOUND", physicalId } : failure(error) as ProviderReadResult<LambdaFunctionModel>; }
    },

    async update(physicalId: string, previous: LambdaFunctionModel, desired: LambdaFunctionModel, context: ProviderContext): Promise<ProviderUpdateResult<LambdaFunctionModel>> {
      try {
        if (physicalId !== desired.FunctionName || previous.FunctionName !== desired.FunctionName) {
          return { status: "FAILED", errorCode: "RequiresReplacement", message: "FunctionName changes require replacement" };
        }
        const current = await get(physicalId, context);
        if (!owned(current, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Function ${physicalId} is not owned by this stack resource` };
        return await reconcile(physicalId, current, desired, context, {
          code: !same(previous.Code, desired.Code) || !same(previous.Architectures, desired.Architectures),
          codeSigning: !same(previous.CodeSigningConfigArn, desired.CodeSigningConfigArn),
          configuration: CONFIGURATION_KEYS.some(key => !same(previous[key], desired[key])) || !same(previous.Layers, desired.Layers),
          concurrency: !same(previous.ReservedConcurrentExecutions, desired.ReservedConcurrentExecutions),
          tags: !same(previous.Tags, desired.Tags),
        });
      } catch (error) { return failure(error); }
    },

    async delete(physicalId: string, _previous: LambdaFunctionModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const current = await get(physicalId, context);
        if (!owned(current, context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Function ${physicalId} is not owned by this stack resource` };
        await invoke(context, "DELETE", `/2015-03-31/functions/${encodeURIComponent(physicalId)}`); return { status: "SUCCESS", physicalId };
      }
      catch (error) { return isNotFound(error) ? { status: "NOT_FOUND", physicalId } : failure(error) as ProviderDeleteResult; }
    },

    ref(model: ProviderReadModel<LambdaFunctionModel>): unknown { return model.physicalId; },
    getAtt(model: ProviderReadModel<LambdaFunctionModel>, attribute: string): unknown {
      if (attribute === "Arn") return model.attributes.Arn;
      throw new ProviderReferenceError(LAMBDA_FUNCTION_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
  return provider;
}
