import { providerValidationPathSegments } from "./contract.js";
import { createHash } from "node:crypto";
import { AwsError } from "../../errors.js";
import type { LambdaService } from "../../lambda.js";
import type { S3Service } from "../../s3.js";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";
import { invokeJsonService } from "./service-invoker.js";

export const LAMBDA_LAYER_VERSION_TYPE = "AWS::Lambda::LayerVersion";

export interface LambdaLayerVersionContentModel {
  readonly S3Bucket: string;
  readonly S3Key: string;
  readonly S3ObjectVersion?: string;
}

export interface LambdaLayerVersionModel {
  readonly LayerName: string;
  readonly Content: LambdaLayerVersionContentModel;
  readonly Description?: string;
  readonly CompatibleArchitectures?: readonly ("x86_64" | "arm64")[];
  readonly CompatibleRuntimes?: readonly string[];
  readonly LicenseInfo?: string;
}

export const LAMBDA_LAYER_VERSION_SCHEMA: ProviderSchema = Object.freeze({
  typeName: LAMBDA_LAYER_VERSION_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    LayerName: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    Content: Object.freeze({ valueType: "object", required: true, updateBehavior: "REPLACEMENT" }),
    Description: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    CompatibleArchitectures: Object.freeze({ valueType: "array", updateBehavior: "REPLACEMENT" }),
    CompatibleRuntimes: Object.freeze({ valueType: "array", updateBehavior: "REPLACEMENT" }),
    LicenseInfo: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Layer version ARN" }),
  attributes: Object.freeze({ LayerVersionArn: Object.freeze({ valueType: "string", description: "Layer version ARN" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: Object.freeze({
    deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    snapshotSupported: false,
  }),
  tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stackName(context: ProviderContext): string {
  return context.stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack";
}

function generatedName(context: ProviderContext): string {
  const suffix = createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex").slice(0, 12);
  const prefix = `${stackName(context)}-${context.logicalId}`.replace(/[^A-Za-z0-9-_]/g, "-");
  return `${prefix.slice(0, Math.max(1, 140 - suffix.length - 1))}-${suffix}`;
}

function owner(context: ProviderContext): string {
  return `${context.stackId}\0${context.logicalId}`;
}

function validateNested(properties: Record<string, unknown>, context: ProviderContext): ProviderValidationIssue[] {
  const issues: ProviderValidationIssue[] = [];
  const invalid = (path: string, message: string) => issues.push({ code: "InvalidProperty", path, pathSegments: providerValidationPathSegments(path), message });
  const unsupported = (path: string, message: string) => issues.push({ code: "UnsupportedProperty", path, pathSegments: providerValidationPathSegments(path), message });
  if (properties.LayerName !== undefined && (typeof properties.LayerName !== "string" || !/^[A-Za-z0-9-_]{1,140}$/.test(properties.LayerName))) invalid("Properties.LayerName", "LayerName must contain 1-140 letters, numbers, hyphens, or underscores");
  if (!properties.LayerName && !/^[A-Za-z0-9-_]{1,140}$/.test(generatedName(context))) invalid("Properties.LayerName", "The generated layer name is invalid");
  if (!record(properties.Content)) invalid("Properties.Content", "Content must be an object");
  else {
    const allowed = new Set(["S3Bucket", "S3Key", "S3ObjectVersion"]);
    for (const key of Object.keys(properties.Content)) if (!allowed.has(key)) unsupported(`Properties.Content.${key}`, `${key} is not supported; the bounded provider accepts only version-pinned S3 content`);
    if (typeof properties.Content.S3Bucket !== "string" || !properties.Content.S3Bucket || typeof properties.Content.S3Key !== "string" || !properties.Content.S3Key || (properties.Content.S3ObjectVersion !== undefined && (typeof properties.Content.S3ObjectVersion !== "string" || !properties.Content.S3ObjectVersion))) invalid("Properties.Content", "Content requires nonempty S3Bucket and S3Key and an optional nonempty S3ObjectVersion");
  }
  if (properties.Description !== undefined && (typeof properties.Description !== "string" || properties.Description.length > 256)) invalid("Properties.Description", "Description must be a string no longer than 256 characters");
  if (properties.LicenseInfo !== undefined && (typeof properties.LicenseInfo !== "string" || properties.LicenseInfo.length > 512)) invalid("Properties.LicenseInfo", "LicenseInfo must be a string no longer than 512 characters");
  if (properties.CompatibleArchitectures !== undefined && (!Array.isArray(properties.CompatibleArchitectures) || properties.CompatibleArchitectures.length > 2 || new Set(properties.CompatibleArchitectures).size !== properties.CompatibleArchitectures.length || properties.CompatibleArchitectures.some(value => !["x86_64", "arm64"].includes(String(value))))) invalid("Properties.CompatibleArchitectures", "CompatibleArchitectures must contain unique x86_64 or arm64 values");
  if (properties.CompatibleRuntimes !== undefined && (!Array.isArray(properties.CompatibleRuntimes) || properties.CompatibleRuntimes.length > 15 || new Set(properties.CompatibleRuntimes).size !== properties.CompatibleRuntimes.length || properties.CompatibleRuntimes.some(value => !["nodejs18.x", "nodejs20.x", "nodejs22.x", "python3.13"].includes(String(value))))) invalid("Properties.CompatibleRuntimes", "CompatibleRuntimes is limited to runtimes implemented by stacksim");
  return issues;
}

function stable<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stable) as T;
  if (record(value)) return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)])) as T;
  return value;
}

function parsePhysicalId(physicalId: string): { name: string; version: number } | undefined {
  const match = physicalId.match(/^arn:(?:aws|aws-us-gov|aws-cn):lambda:[^:]+:\d{12}:layer:([A-Za-z0-9-_]+):(\d+)$/);
  return match ? { name: match[1], version: Number(match[2]) } : undefined;
}

function notFound(error: unknown): boolean {
  return error instanceof AwsError && error.code === "ResourceNotFoundException";
}

function failed(error: unknown): ProviderUpdateResult<LambdaLayerVersionModel> {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}

export function createLambdaLayerVersionProvider(lambda: LambdaService, s3: S3Service): ProductionResourceProvider<LambdaLayerVersionModel> {
  const invoke = <T>(context: ProviderContext, method: string, path: string, input?: unknown) => invokeJsonService<T>({
    method,
    path,
    input,
    handle: (req, res, pathname, url) => lambda.handle(req, res, pathname, url, context.principal.identity),
  });
  const inspect = async (physicalId: string, context: ProviderContext) => (await invoke<any>(context, "GET", `/2018-10-31/layers?find=LayerVersion&Arn=${encodeURIComponent(physicalId)}`)).body;
  const success = (model: LambdaLayerVersionModel, physicalId: string) => ({ status: "SUCCESS" as const, physicalId, model: { physicalId, properties: model, attributes: { LayerVersionArn: physicalId } } });

  return {
    typeName: LAMBDA_LAYER_VERSION_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: LAMBDA_LAYER_VERSION_SCHEMA,
    validate(properties: unknown, context: ProviderContext) {
      const shallow = validateDeclaredProperties(properties ?? {}, LAMBDA_LAYER_VERSION_SCHEMA);
      return record(properties) ? [...shallow, ...validateNested(properties, context)] : shallow;
    },
    canonicalize(properties: unknown, context: ProviderContext): LambdaLayerVersionModel {
      if (!record(properties)) throw new TypeError(`${LAMBDA_LAYER_VERSION_TYPE} Properties must be an object`);
      const issues = [...validateDeclaredProperties(properties, LAMBDA_LAYER_VERSION_SCHEMA), ...validateNested(properties, context)];
      if (issues.length) throw new TypeError(issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
      const content = properties.Content as Record<string, string>;
      return stable({
        LayerName: String(properties.LayerName ?? generatedName(context)),
        Content: { S3Bucket: content.S3Bucket, S3Key: content.S3Key, ...(content.S3ObjectVersion ? { S3ObjectVersion: content.S3ObjectVersion } : {}) },
        ...(properties.Description !== undefined ? { Description: String(properties.Description) } : {}),
        ...(properties.CompatibleArchitectures !== undefined ? { CompatibleArchitectures: [...properties.CompatibleArchitectures as Array<"x86_64" | "arm64">] } : {}),
        ...(properties.CompatibleRuntimes !== undefined ? { CompatibleRuntimes: [...properties.CompatibleRuntimes as string[]] } : {}),
        ...(properties.LicenseInfo !== undefined ? { LicenseInfo: String(properties.LicenseInfo) } : {}),
      });
    },
    plan(previous: LambdaLayerVersionModel | undefined, desired: LambdaLayerVersionModel): ProviderPlan<LambdaLayerVersionModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const keys = [...new Set([...Object.keys(previous), ...Object.keys(desired)])].filter(key => JSON.stringify((previous as any)[key]) !== JSON.stringify((desired as any)[key])).sort();
      return keys.length ? { action: "REPLACE", desired, changedProperties: keys, replacementProperties: keys, replacementOrder: "CREATE_BEFORE_DELETE" } : { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
    },
    async create(desired: LambdaLayerVersionModel, context: ProviderContext) {
      try {
        const maximumBytes = Number(process.env.STACKSIM_LAMBDA_ZIP_LIMIT ?? 50 * 1024 * 1024);
        const bytes = (await s3.readObjectBytes(desired.Content.S3Bucket, desired.Content.S3Key, desired.Content.S3ObjectVersion, maximumBytes)).body;
        const response = (await invoke<any>(context, "POST", `/2018-10-31/layers/${encodeURIComponent(desired.LayerName)}/versions`, {
          Content: { ZipFile: bytes.toString("base64") },
          ...(desired.Description !== undefined ? { Description: desired.Description } : {}),
          ...(desired.CompatibleArchitectures ? { CompatibleArchitectures: [...desired.CompatibleArchitectures] } : {}),
          ...(desired.CompatibleRuntimes ? { CompatibleRuntimes: [...desired.CompatibleRuntimes] } : {}),
          ...(desired.LicenseInfo !== undefined ? { LicenseInfo: desired.LicenseInfo } : {}),
          StackSimCloudFormationOwner: owner(context),
          StackSimCloudFormationOperationToken: context.resourceOperationId,
        })).body;
        return success(desired, response.LayerVersionArn);
      } catch (error) { return failed(error); }
    },
    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<LambdaLayerVersionModel>> {
      try {
        const current = await inspect(physicalId, context);
        if (current.StackSimCloudFormationOwner !== owner(context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: "Layer version is not owned by this stack resource" };
        const parsed = parsePhysicalId(physicalId)!;
        const model: LambdaLayerVersionModel = { LayerName: parsed.name, Content: { S3Bucket: "<immutable>", S3Key: `<sha256:${current.Content?.CodeSha256 ?? "unknown"}>` }, ...(current.Description ? { Description: current.Description } : {}), ...(current.CompatibleArchitectures?.length ? { CompatibleArchitectures: current.CompatibleArchitectures } : {}), ...(current.CompatibleRuntimes?.length ? { CompatibleRuntimes: current.CompatibleRuntimes } : {}), ...(current.LicenseInfo ? { LicenseInfo: current.LicenseInfo } : {}) };
        return success(stable(model), physicalId);
      } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderReadResult<LambdaLayerVersionModel>; }
    },
    async update(_physicalId: string, _previous: LambdaLayerVersionModel, _desired: LambdaLayerVersionModel, _context: ProviderContext) {
      return { status: "FAILED", errorCode: "RequiresReplacement", message: "Lambda layer versions are immutable and every property change requires replacement" };
    },
    async delete(physicalId: string, _previous: LambdaLayerVersionModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const parsed = parsePhysicalId(physicalId);
        if (!parsed) return { status: "FAILED", errorCode: "InvalidPhysicalResourceId", message: "Layer version physical ID is invalid" };
        const current = await inspect(physicalId, context);
        if (current.StackSimCloudFormationOwner !== owner(context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: "Layer version is not owned by this stack resource" };
        await invoke(context, "DELETE", `/2018-10-31/layers/${encodeURIComponent(parsed.name)}/versions/${parsed.version}`);
        return { status: "SUCCESS", physicalId };
      } catch (error) { return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderDeleteResult; }
    },
    ref(model: ProviderReadModel<LambdaLayerVersionModel>) { return model.physicalId; },
    getAtt(model: ProviderReadModel<LambdaLayerVersionModel>, attribute: string) {
      if (attribute === "LayerVersionArn") return model.physicalId;
      throw new ProviderReferenceError(LAMBDA_LAYER_VERSION_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}
