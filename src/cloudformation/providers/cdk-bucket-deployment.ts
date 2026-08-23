import { providerValidationPathSegments } from "./contract.js";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { evaluateRoleAuthorization, evaluateTrust } from "../../iam/evaluator.js";
import type { S3InternalCurrentObject, S3Service } from "../../s3.js";
import type { StateStore } from "../../state.js";
import type { CloudFormationStackResourceState, LambdaState } from "../../types.js";
import { AwsError } from "../../errors.js";
import { cdkBootstrapNames } from "../bootstrap.js";
import { CloudFormationJournal } from "../journal.js";
import { readZipEntries, type ValidatedZipEntry } from "../../zip.js";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderFailed,
  type ProviderInProgress,
  type ProviderJsonObject,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderSuccess,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";

export const CDK_BUCKET_DEPLOYMENT_TYPE = "Custom::CDKBucketDeployment";

// These are the checked-in provider assets emitted by the supported aws-cdk-lib helpers.
export const PINNED_BUCKET_DEPLOYMENT_HANDLER_ASSET = "97e9ebf0b174a5c8f7faa505739022b7f509edddffcab9211dcd08b759944c4f.zip";
export const PINNED_BUCKET_DEPLOYMENT_AWSCLI_ASSET = "98f62bef9320f8c0a0a7be21d7c746f069131f196f51ffe3008a6bb730b368ec.zip";
export const LEGACY_BUCKET_DEPLOYMENT_AWSCLI_ASSET = "a72522445441e9b66c2f16956c54d4786af8c61c156b80c48a6e7c32fcc49023.zip";

const SUPPORTED_BUCKET_DEPLOYMENT_AWSCLI_ASSETS = new Set<string>([
  LEGACY_BUCKET_DEPLOYMENT_AWSCLI_ASSET,
  PINNED_BUCKET_DEPLOYMENT_AWSCLI_ASSET,
]);

const MAX_SOURCE_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_ASSET_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_ENTRY_COUNT = 10_000;
const MAX_DESTINATION_OBJECT_COUNT = 10_000;
const MAX_MUTATIONS_PER_CALLBACK = 256;
const MAX_SOURCE_COUNT = 32;
const MAX_MARKERS_PER_SOURCE = 256;
const MAX_MARKER_TOKEN_BYTES = 128;
const MAX_MARKER_VALUE_BYTES = 16 * 1024;
const MAX_CACHE_CONTROL_BYTES = 1_024;
const MAX_INVALIDATION_PATH_COUNT = 3_000;
const MAX_INVALIDATION_PATH_BYTES = 4_000;
const BASIC_EXECUTION_POLICY = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
const MARKER_TOKEN = /^<<marker:0x[a-f0-9]{4}:[0-9]+>>$/;
const ANY_MARKER_TOKEN = /<<marker[^<>]*>>/g;

export interface CdkBucketDeploymentInvalidationPort {
  createInvalidation(distributionId: string, paths: string[], callerReference: string): Promise<{ id: string; status: string }>;
  getInvalidation(distributionId: string, invalidationId: string): { id: string; status: string } | Promise<{ id: string; status: string }>;
}

export interface CdkBucketDeploymentModel {
  readonly ServiceToken: string;
  readonly SourceBucketNames: readonly string[];
  readonly SourceObjectKeys: readonly string[];
  readonly SourceMarkers: readonly Readonly<Record<string, string>>[];
  readonly SourceMarkersConfig: readonly Readonly<Record<string, never>>[];
  readonly DestinationBucketName: string;
  readonly DestinationBucketArn?: string;
  readonly DestinationBucketKeyPrefix?: string;
  readonly WaitForDistributionInvalidation: true;
  readonly Prune: boolean;
  readonly SystemMetadata?: Readonly<{ "cache-control"?: string }>;
  readonly DistributionId?: string;
  readonly DistributionPaths?: readonly string[];
  readonly OutputObjectKeys: true;
  /** The pinned helper defaults this property to true when it is omitted. */
  readonly RetainOnDelete: boolean;
}

export const CDK_BUCKET_DEPLOYMENT_SCHEMA: ProviderSchema = Object.freeze({
  typeName: CDK_BUCKET_DEPLOYMENT_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    ServiceToken: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT", sensitive: true }),
    SourceBucketNames: Object.freeze({ valueType: "array", required: true, updateBehavior: "MUTABLE" }),
    SourceObjectKeys: Object.freeze({ valueType: "array", required: true, updateBehavior: "MUTABLE" }),
    SourceMarkers: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    SourceMarkersConfig: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    DestinationBucketName: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    DestinationBucketArn: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    DestinationBucketKeyPrefix: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    WaitForDistributionInvalidation: Object.freeze({ valueType: "boolean", required: true, updateBehavior: "MUTABLE" }),
    Prune: Object.freeze({ valueType: "boolean", required: true, updateBehavior: "MUTABLE" }),
    SystemMetadata: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    DistributionId: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    DistributionPaths: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    OutputObjectKeys: Object.freeze({ valueType: "boolean", required: true, updateBehavior: "MUTABLE" }),
    RetainOnDelete: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Stable custom-resource physical ID" }),
  attributes: Object.freeze({
    SourceObjectKeys: Object.freeze({ valueType: "array", description: "Pinned source object keys echoed by the standard helper" }),
    DestinationBucketArn: Object.freeze({ valueType: "string", description: "Authoritative destination bucket ARN echoed by the standard helper" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: Object.freeze({
    deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    snapshotSupported: false,
  }),
  tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});

interface SourcePin {
  readonly versionId: string;
  readonly sha256: string;
  readonly etag: string;
  readonly size: number;
}

interface DeploymentCheckpoint extends ProviderJsonObject {
  readonly phase: "deploy" | "delete-old" | "delete" | "invalidation-intent" | "invalidation-created";
  readonly sourcePins: Array<{ versionId: string; sha256: string; etag: string; size: number }>;
  readonly batchStarted: boolean;
  readonly invalidationPhase: "" | "create" | "update" | "rollback" | "delete";
  readonly invalidationCallerReference: string;
  readonly invalidationId: string;
}

interface PreparedObject {
  readonly key: string;
  readonly content: Buffer;
  readonly contentType: string;
  readonly cacheControl?: string;
}

interface PreparedDeployment {
  readonly objects: readonly PreparedObject[];
  readonly current: readonly S3InternalCurrentObject[];
  readonly sourcePins: readonly SourcePin[];
}

interface AcceptedAssetReference {
  readonly logicalId: string;
  readonly resourceType: string;
  readonly propertyPath: string;
  readonly elementIndex?: number;
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly sha256: string;
  readonly etag: string;
  readonly size: number;
}

interface AcceptedAssetManifest {
  readonly schemaVersion: 1 | 2;
  readonly references: readonly AcceptedAssetReference[];
}

class DeploymentBoundaryError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "DeploymentBoundaryError"; }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(path: string, message: string, code: ProviderValidationIssue["code"] = "InvalidProperty"): ProviderValidationIssue {
  return { code, path, pathSegments: providerValidationPathSegments(path), message };
}

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function canonicalPrefix(value: unknown): string | undefined {
  if (value === undefined || value === "" || value === "/") return undefined;
  return String(value);
}

function prefixRoot(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

function destinationKey(prefix: string | undefined, name: string): string {
  return `${prefixRoot(prefix)}${name}`;
}

function validateModel(properties: unknown, context: ProviderContext): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, CDK_BUCKET_DEPLOYMENT_SCHEMA);
  if (!record(properties)) return issues;
  const invalid = (path: string, message: string) => issues.push(issue(path, message));
  const sourceBuckets = properties.SourceBucketNames;
  const sourceKeys = properties.SourceObjectKeys;
  const sourceMarkers = properties.SourceMarkers;
  const sourceMarkersConfig = properties.SourceMarkersConfig;
  if (Array.isArray(sourceBuckets) && (!sourceBuckets.length || sourceBuckets.length > MAX_SOURCE_COUNT || sourceBuckets.some(value => typeof value !== "string" || !value))) invalid("Properties.SourceBucketNames", `BucketDeployment requires 1..${MAX_SOURCE_COUNT} nonempty source bucket names`);
  if (Array.isArray(sourceKeys) && (!sourceKeys.length || sourceKeys.length > MAX_SOURCE_COUNT || sourceKeys.some(value => typeof value !== "string" || !/^[a-f0-9]{64}\.zip$/.test(value)))) invalid("Properties.SourceObjectKeys", `BucketDeployment requires 1..${MAX_SOURCE_COUNT} immutable 64-hex .zip asset keys`);
  if (Array.isArray(sourceBuckets) && Array.isArray(sourceKeys) && sourceBuckets.length !== sourceKeys.length) invalid("Properties.SourceObjectKeys", "Source bucket and object-key arrays must have equal length");
  if (sourceMarkers !== undefined && Array.isArray(sourceMarkers) && sourceMarkers.some(value => !record(value)
    || Object.keys(value).length > MAX_MARKERS_PER_SOURCE
    || Object.entries(value).some(([token, replacement]) => !MARKER_TOKEN.test(token)
      || Buffer.byteLength(token, "utf8") > MAX_MARKER_TOKEN_BYTES
      || typeof replacement !== "string"
      || Buffer.byteLength(replacement, "utf8") > MAX_MARKER_VALUE_BYTES))) {
    invalid("Properties.SourceMarkers", "SourceMarkers must contain only bounded exact marker tokens mapped to resolved scalar strings");
  }
  if (Array.isArray(sourceMarkers)) {
    const tokens = sourceMarkers.flatMap(value => record(value) ? Object.keys(value) : []);
    if (new Set(tokens).size !== tokens.length) invalid("Properties.SourceMarkers", "Source marker tokens must be unique across the ordered sources");
  }
  if (Array.isArray(sourceKeys) && Array.isArray(sourceMarkers) && sourceKeys.length !== sourceMarkers.length) invalid("Properties.SourceMarkers", "Source object-key and marker arrays must have equal length");
  if (sourceMarkersConfig !== undefined && Array.isArray(sourceMarkersConfig) && sourceMarkersConfig.some(value => !record(value) || Object.keys(value).length !== 0)) invalid("Properties.SourceMarkersConfig", "CFR-01 supports only empty SourceMarkersConfig entries");
  if (Array.isArray(sourceKeys) && Array.isArray(sourceMarkersConfig) && sourceKeys.length !== sourceMarkersConfig.length) invalid("Properties.SourceMarkersConfig", "Source object-key and marker-config arrays must have equal length");
  const expectedBootstrap = cdkBootstrapNames(context.accountId, context.region).bucketName;
  if (Array.isArray(sourceBuckets) && sourceBuckets.some(value => value !== expectedBootstrap)) invalid("Properties.SourceBucketNames", "Every source asset must come from the simulator-managed CDK bootstrap bucket");
  if (typeof properties.DestinationBucketName === "string") {
    if (!properties.DestinationBucketName) invalid("Properties.DestinationBucketName", "DestinationBucketName must not be empty");
    if (Array.isArray(sourceBuckets) && sourceBuckets.includes(properties.DestinationBucketName)) invalid("Properties.DestinationBucketName", "The bootstrap source bucket and application destination bucket must be different");
  }
  if (properties.DestinationBucketArn !== undefined && typeof properties.DestinationBucketName === "string") {
    const expectedArn = `arn:${context.partition}:s3:::${properties.DestinationBucketName}`;
    if (properties.DestinationBucketArn !== expectedArn) invalid("Properties.DestinationBucketArn", "DestinationBucketArn must identify DestinationBucketName exactly");
  }
  const prefix = properties.DestinationBucketKeyPrefix;
  if (prefix !== undefined && typeof prefix === "string") {
    if (Buffer.byteLength(prefix, "utf8") > 104) invalid("Properties.DestinationBucketKeyPrefix", "DestinationBucketKeyPrefix must be at most 104 UTF-8 bytes for the pinned construct");
    if (prefix.includes("\0") || prefix.includes("\\") || prefix.startsWith("/") || /[\u0000-\u001f\u007f]/.test(prefix) || prefix.split("/").some(part => part === "." || part === "..")) invalid("Properties.DestinationBucketKeyPrefix", "DestinationBucketKeyPrefix is unsafe");
  }
  if (properties.WaitForDistributionInvalidation !== true) invalid("Properties.WaitForDistributionInvalidation", "Only WaitForDistributionInvalidation=true is supported");
  if (properties.Prune !== true && properties.Prune !== false) invalid("Properties.Prune", "Prune must be a boolean");
  const systemMetadata = properties.SystemMetadata;
  if (systemMetadata !== undefined && record(systemMetadata)) {
    const keys = Object.keys(systemMetadata);
    if (keys.some(key => key !== "cache-control")) invalid("Properties.SystemMetadata", "CFR-01 supports only lowercase cache-control system metadata");
    const cacheControl = systemMetadata["cache-control"];
    if (cacheControl !== undefined && (typeof cacheControl !== "string" || Buffer.byteLength(cacheControl, "utf8") > MAX_CACHE_CONTROL_BYTES || /[\r\n]/.test(cacheControl))) invalid("Properties.SystemMetadata.cache-control", "cache-control must be a bounded string without CR or LF");
  }
  const distributionId = properties.DistributionId;
  const distributionPaths = properties.DistributionPaths;
  if (distributionId !== undefined && typeof distributionId === "string" && (!distributionId || Buffer.byteLength(distributionId, "utf8") > 128 || !/^[A-Z0-9]+$/.test(distributionId))) invalid("Properties.DistributionId", "DistributionId is invalid");
  if (distributionId !== undefined && (!Array.isArray(distributionPaths) || !distributionPaths.length)) invalid("Properties.DistributionPaths", "DistributionId requires nonempty DistributionPaths");
  if (distributionId === undefined && distributionPaths !== undefined) invalid("Properties.DistributionPaths", "DistributionPaths requires DistributionId");
  if (Array.isArray(distributionPaths) && (!distributionPaths.length || distributionPaths.length > MAX_INVALIDATION_PATH_COUNT || distributionPaths.some(path => typeof path !== "string" || !path.startsWith("/") || Buffer.byteLength(path, "utf8") > MAX_INVALIDATION_PATH_BYTES || path.slice(0, -1).includes("*")))) invalid("Properties.DistributionPaths", "Invalidation paths are invalid or exceed the CFR-01 bounds");
  if (properties.OutputObjectKeys !== true) invalid("Properties.OutputObjectKeys", "The pinned helper slice requires OutputObjectKeys=true");
  if (typeof properties.ServiceToken === "string") {
    const expression = new RegExp(`^arn:${context.partition}:lambda:${context.region}:${context.accountId}:function:[A-Za-z0-9-_]{1,64}$`);
    if (!expression.test(properties.ServiceToken)) invalid("Properties.ServiceToken", "ServiceToken must be an unqualified same-account, same-Region Lambda ARN");
  }
  return issues;
}

function throwValidation(issues: readonly ProviderValidationIssue[]): never {
  throw new DeploymentBoundaryError("ValidationError", issues.map(item => `${item.path}: ${item.message}`).join("; "));
}

function physicalId(context: ProviderContext): string {
  const digest = createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex");
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  return `aws.cdk.s3deployment.${uuid}`;
}

function success(model: CdkBucketDeploymentModel, context: ProviderContext, id = physicalId(context)): ProviderSuccess<CdkBucketDeploymentModel> {
  const attributes: Record<string, unknown> = { SourceObjectKeys: [...model.SourceObjectKeys] };
  if (model.DestinationBucketArn !== undefined) attributes.DestinationBucketArn = model.DestinationBucketArn;
  return {
    status: "SUCCESS",
    physicalId: id,
    model: { physicalId: id, properties: model, attributes },
  };
}

function inProgress(context: ProviderContext, checkpoint: DeploymentCheckpoint): ProviderInProgress {
  return { status: "IN_PROGRESS", callbackAfterMs: 1, checkpoint: { schemaVersion: 1, physicalId: physicalId(context), callbackContext: checkpoint } };
}

function failure(error: unknown): ProviderFailed {
  if (error instanceof DeploymentBoundaryError) return { status: "FAILED", errorCode: error.code, message: error.message };
  if (error instanceof AwsError && error.code === "InvalidParameterValueException") return { status: "FAILED", errorCode: "InvalidAsset", message: error.message };
  if (error instanceof AwsError) return { status: "FAILED", errorCode: error.code, message: `The backing S3 operation failed (${error.code})` };
  if (record(error) && typeof error.code === "string") return { status: "FAILED", errorCode: error.code, message: "The CloudFront invalidation operation failed" };
  return { status: "FAILED", errorCode: "InternalFailure", message: "The local BucketDeployment provider failed without exposing asset data or host paths" };
}

function serviceTokenFunctionName(token: string): string {
  const marker = ":function:";
  const index = token.indexOf(marker);
  if (index < 0) throw new DeploymentBoundaryError("ProviderConfiguration", "The BucketDeployment ServiceToken is not a Lambda function ARN");
  return token.slice(index + marker.length);
}

function helperResource(store: StateStore, model: CdkBucketDeploymentModel, context: ProviderContext): CloudFormationStackResourceState | undefined {
  const stack = store.regionState(context.region).cloudformation.stacks[context.stackId];
  const functionName = serviceTokenFunctionName(model.ServiceToken);
  return Object.values(stack?.resources ?? {}).find(resource => resource.resourceType === "AWS::Lambda::Function" && resource.physicalResourceId === functionName);
}

async function validatePinnedHelper(s3: S3Service, store: StateStore, model: CdkBucketDeploymentModel, context: ProviderContext): Promise<LambdaState> {
  const functionName = serviceTokenFunctionName(model.ServiceToken);
  const fn = store.regionState(context.region).functions[functionName];
  if (!fn || fn.functionArn !== model.ServiceToken) throw new DeploymentBoundaryError("ProviderConfiguration", "The pinned BucketDeployment provider Lambda is missing");
  if (fn.packageType !== "Zip" || fn.runtime !== "python3.13" || fn.handler !== "index.handler" || fn.timeout !== 900
    || fn.environment?.AWS_CA_BUNDLE !== "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem"
    || Object.keys(fn.environment ?? {}).some(key => key !== "AWS_CA_BUNDLE") || fn.layers?.length !== 1) {
    throw new DeploymentBoundaryError("ProviderConfiguration", "The BucketDeployment provider Lambda does not match a supported aws-cdk-lib helper shape");
  }
  const declared = helperResource(store, model, context);
  const code = record(declared?.properties.Code) ? declared!.properties.Code as Record<string, unknown> : undefined;
  if (!declared || code?.S3Bucket !== model.SourceBucketNames[0] || code?.S3Key !== PINNED_BUCKET_DEPLOYMENT_HANDLER_ASSET) {
    throw new DeploymentBoundaryError("ProviderConfiguration", "The BucketDeployment provider code asset does not match a supported aws-cdk-lib helper");
  }
  if (fn.tags?.["aws:cloudformation:stack-id"] !== context.stackId || fn.tags?.["aws:cloudformation:logical-id"] !== declared.logicalResourceId) {
    throw new DeploymentBoundaryError("ProviderConfiguration", "The BucketDeployment provider Lambda is not owned by its declared CloudFormation resource");
  }
  if (typeof code.S3ObjectVersion !== "string" || !code.S3ObjectVersion) throw new DeploymentBoundaryError("ProviderConfiguration", "The BucketDeployment provider code asset is not version-pinned");
  const codeAsset = await s3.readObjectBytes(String(code.S3Bucket), String(code.S3Key), code.S3ObjectVersion, 50 * 1024 * 1024);
  if (fn.codeSha256 !== Buffer.from(codeAsset.sha256, "hex").toString("base64") || fn.codeSize !== codeAsset.size) {
    throw new DeploymentBoundaryError("ProviderConfiguration", "The deployed BucketDeployment provider code bytes do not match its accepted immutable asset");
  }
  const layer = Object.values(store.regionState(context.region).lambdaLayers).flatMap(item => Object.values(item.versions)).find(item => item.arn === fn.layers![0].arn);
  if (!layer || layer.description !== "/opt/awscli/aws") throw new DeploymentBoundaryError("ProviderConfiguration", "The pinned BucketDeployment AWS CLI layer is missing");
  const stack = store.regionState(context.region).cloudformation.stacks[context.stackId];
  const declaredLayer = Object.values(stack?.resources ?? {}).find(resource => resource.resourceType === "AWS::Lambda::LayerVersion" && (resource.physicalResourceId === layer.arn || resource.refValue === layer.arn));
  const layerContent = record(declaredLayer?.properties.Content) ? declaredLayer!.properties.Content as Record<string, unknown> : undefined;
  const layerAssetKey = layerContent?.S3Key;
  if (!declaredLayer || layerContent?.S3Bucket !== model.SourceBucketNames[0]
    || typeof layerAssetKey !== "string" || !SUPPORTED_BUCKET_DEPLOYMENT_AWSCLI_ASSETS.has(layerAssetKey)) {
    throw new DeploymentBoundaryError("ProviderConfiguration", "The BucketDeployment AWS CLI layer asset does not match a supported aws-cdk-lib helper");
  }
  if (layer.cloudFormationOwner !== `${context.stackId}\0${declaredLayer.logicalResourceId}`) throw new DeploymentBoundaryError("ProviderConfiguration", "The BucketDeployment AWS CLI layer is not owned by its declared CloudFormation resource");
  if (typeof layerContent.S3ObjectVersion !== "string" || !layerContent.S3ObjectVersion) throw new DeploymentBoundaryError("ProviderConfiguration", "The BucketDeployment AWS CLI layer asset is not version-pinned");
  const layerAsset = await s3.readObjectBytes(String(layerContent.S3Bucket), String(layerContent.S3Key), layerContent.S3ObjectVersion, 50 * 1024 * 1024);
  if (layer.codeSha256 !== Buffer.from(layerAsset.sha256, "hex").toString("base64") || layer.codeSize !== layerAsset.size) {
    throw new DeploymentBoundaryError("ProviderConfiguration", "The deployed BucketDeployment AWS CLI layer bytes do not match its accepted immutable asset");
  }
  const role = Object.values(store.ensureAccount().iam.roles).find(item => item.arn === fn.role);
  if (!role || evaluateTrust(role.assumeRolePolicyDocument, "lambda.amazonaws.com", "sts:AssumeRole", { "aws:PrincipalServiceName": "lambda.amazonaws.com" }).decision !== "allowed") {
    throw new DeploymentBoundaryError("ProviderConfiguration", "The BucketDeployment provider execution role is missing or cannot be assumed by Lambda");
  }
  const declaredRole = Object.values(stack?.resources ?? {}).find(resource => resource.resourceType === "AWS::IAM::Role" && (resource.attributes.Arn === fn.role || resource.physicalResourceId === role.roleName));
  if (!declaredRole || role.tags["aws:cloudformation:stack-id"] !== context.stackId || role.tags["aws:cloudformation:logical-id"] !== declaredRole.logicalResourceId) {
    throw new DeploymentBoundaryError("ProviderConfiguration", "The BucketDeployment provider execution role is not owned by its declared CloudFormation resource");
  }
  if (!role.attachedPolicyArns.includes(BASIC_EXECUTION_POLICY)) throw new DeploymentBoundaryError("ProviderConfiguration", "The pinned BucketDeployment provider basic execution policy is missing");
  return fn;
}

function requireRoleGrants(store: StateStore, roleArn: string, checks: ReadonlyArray<readonly [string, string]>): void {
  const iam = store.ensureAccount().iam;
  if (checks.some(([action, resource]) => evaluateRoleAuthorization(iam, roleArn, action, resource).decision !== "allowed")) {
    throw new DeploymentBoundaryError("AccessDenied", "The BucketDeployment provider execution role does not grant the exact source and destination S3 access required by this deployment");
  }
}

function commonRoleChecks(model: CdkBucketDeploymentModel): Array<readonly [string, string]> {
  const destinationBucketArn = model.DestinationBucketArn ?? `arn:aws:s3:::${model.DestinationBucketName}`;
  const checks: Array<readonly [string, string]> = [
    ["s3:GetBucketLocation", destinationBucketArn],
    ["s3:ListBucket", destinationBucketArn],
  ];
  for (let index = 0; index < model.SourceObjectKeys.length; index += 1) {
    const sourceBucketArn = `arn:aws:s3:::${model.SourceBucketNames[index]}`;
    const sourceObjectArn = `${sourceBucketArn}/${model.SourceObjectKeys[index]}`;
    checks.push(["s3:GetBucketLocation", sourceBucketArn], ["s3:ListBucket", sourceBucketArn], ["s3:GetObject", sourceObjectArn], ["s3:GetObjectVersion", sourceObjectArn]);
  }
  return checks;
}

function invalidationRoleChecks(model: CdkBucketDeploymentModel, context: ProviderContext): Array<readonly [string, string]> {
  if (!model.DistributionId) return [];
  const arn = `arn:${context.partition}:cloudfront::${context.accountId}:distribution/${model.DistributionId}`;
  return [["cloudfront:CreateInvalidation", arn], ["cloudfront:GetInvalidation", arn]];
}

function contentTypeFor(key: string): string {
  const extension = extname(key).toLowerCase();
  const types: Readonly<Record<string, string>> = {
    ".avif": "image/avif", ".bmp": "image/bmp", ".css": "text/css", ".csv": "text/csv", ".gif": "image/gif",
    ".htm": "text/html", ".html": "text/html", ".ico": "image/vnd.microsoft.icon", ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
    ".js": "application/javascript", ".json": "application/json", ".map": "application/json", ".mjs": "application/javascript",
    ".otf": "font/otf", ".pdf": "application/pdf", ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain",
    ".wasm": "application/wasm", ".webmanifest": "application/manifest+json", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".xml": "application/xml",
  };
  return types[extension] ?? "application/octet-stream";
}

function replaceSourceMarkers(entries: readonly ValidatedZipEntry[], markers: Readonly<Record<string, string>>): ValidatedZipEntry[] {
  const output = entries.map(entry => ({ ...entry, content: Buffer.from(entry.content) }));
  for (const [token, replacement] of Object.entries(markers).sort(([left], [right]) => left.localeCompare(right))) {
    const needle = Buffer.from(token, "utf8");
    let occurrences = 0;
    let foundEntry = -1;
    let foundAt = -1;
    for (let entryIndex = 0; entryIndex < output.length; entryIndex += 1) {
      for (let offset = 0; (offset = output[entryIndex].content.indexOf(needle, offset)) >= 0; offset += needle.length) { occurrences += 1; foundEntry = entryIndex; foundAt = offset; }
    }
    if (occurrences !== 1) throw new DeploymentBoundaryError("InvalidAsset", occurrences ? "A source marker token occurs more than once in its source" : "A declared source marker token does not occur in its source");
    const content = output[foundEntry].content;
    output[foundEntry] = { ...output[foundEntry], content: Buffer.concat([content.subarray(0, foundAt), Buffer.from(replacement, "utf8"), content.subarray(foundAt + needle.length)]) };
  }
  for (const entry of output) {
    ANY_MARKER_TOKEN.lastIndex = 0;
    if (ANY_MARKER_TOKEN.test(entry.content.toString("utf8"))) throw new DeploymentBoundaryError("InvalidAsset", "A source contains an unknown or leftover marker token");
    if (entry.content.length > MAX_ASSET_OBJECT_BYTES) throw new DeploymentBoundaryError("InvalidAsset", "Marker expansion makes an object exceed the per-object limit");
  }
  return output;
}

function overlayObjects(
  target: Map<string, PreparedObject>,
  entries: readonly ValidatedZipEntry[],
  model: CdkBucketDeploymentModel,
): void {
  for (const entry of entries) {
    const key = destinationKey(model.DestinationBucketKeyPrefix, entry.name);
    if (Buffer.byteLength(key, "utf8") > 1_024) throw new DeploymentBoundaryError("InvalidAsset", "A deployed object key exceeds S3's 1,024-byte key limit");
    target.set(key, {
      key,
      content: entry.content,
      contentType: contentTypeFor(entry.name),
      ...(model.SystemMetadata?.["cache-control"] === undefined ? {} : { cacheControl: model.SystemMetadata["cache-control"] }),
    });
  }
}

function checkpoint(value: Readonly<ProviderJsonObject> | undefined): DeploymentCheckpoint | undefined {
  if (!value) return undefined;
  const phase = value.phase;
  const pins = value.sourcePins;
  const phases = new Set(["deploy", "delete-old", "delete", "invalidation-intent", "invalidation-created"]);
  const invalidationPhases = new Set(["create", "update", "rollback", "delete"]);
  if (typeof phase !== "string" || !phases.has(phase) || typeof value.batchStarted !== "boolean" || !Array.isArray(pins) || pins.length > MAX_SOURCE_COUNT || pins.some(pin => !record(pin)
    || typeof pin.versionId !== "string" || !pin.versionId
    || typeof pin.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pin.sha256)
    || typeof pin.etag !== "string" || !pin.etag
    || typeof pin.size !== "number" || !Number.isSafeInteger(pin.size) || pin.size < 0)
    || ((phase === "invalidation-intent" || phase === "invalidation-created")
      && (typeof value.invalidationPhase !== "string" || !invalidationPhases.has(value.invalidationPhase)
        || typeof value.invalidationCallerReference !== "string" || !value.invalidationCallerReference
        || (phase === "invalidation-created" && (typeof value.invalidationId !== "string" || !value.invalidationId))))) {
    throw new DeploymentBoundaryError("InvalidCheckpoint", "The durable BucketDeployment checkpoint is malformed");
  }
  return {
    phase: phase as DeploymentCheckpoint["phase"],
    batchStarted: value.batchStarted,
    sourcePins: pins.map(pin => ({ versionId: String((pin as any).versionId), sha256: String((pin as any).sha256), etag: String((pin as any).etag), size: Number((pin as any).size) })),
    invalidationPhase: value.invalidationPhase === undefined ? "" : value.invalidationPhase as DeploymentCheckpoint["invalidationPhase"],
    invalidationCallerReference: value.invalidationCallerReference === undefined ? "" : String(value.invalidationCallerReference),
    invalidationId: value.invalidationId === undefined ? "" : String(value.invalidationId),
  };
}

async function acceptedSourcePin(store: StateStore, model: CdkBucketDeploymentModel, context: ProviderContext, elementIndex: number): Promise<SourcePin | undefined> {
  const journal = new CloudFormationJournal(store.root, store.accountId, context.region);
  const artifactId = `${context.operationId}.${context.logicalId}.SourceObjectKeys.${elementIndex}.json`;
  const stack = store.regionState(context.region).cloudformation.stacks[context.stackId];
  const active = stack?.activeOperation;
  const rollback = stack?.stackStatus === "UPDATE_ROLLBACK_IN_PROGRESS" || active?.kind === "ROLLBACK_UPDATE";
  let reference: AcceptedAssetReference | undefined;
  if (rollback && active?.previousTemplateArtifactId) {
    const manifest = await journal.readJsonArtifact<AcceptedAssetManifest>("assets", `${active.previousTemplateArtifactId}.json`);
    if (!manifest || ![1, 2].includes(manifest.schemaVersion) || !Array.isArray(manifest.references)) throw new DeploymentBoundaryError("MissingAssetCheckpoint", "The previous BucketDeployment source-asset manifest required for rollback is missing");
    reference = manifest.references.find(candidate => candidate.logicalId === context.logicalId && candidate.propertyPath === "SourceObjectKeys" && (candidate.elementIndex ?? 0) === elementIndex);
    if (!reference) throw new DeploymentBoundaryError("MissingAssetCheckpoint", "The previous BucketDeployment source asset required for rollback is missing from its manifest");
  } else {
    reference = await journal.readJsonArtifact<AcceptedAssetReference>("assets", artifactId);
    if (reference === undefined && elementIndex === 0) reference = await journal.readJsonArtifact<AcceptedAssetReference>("assets", `${context.operationId}.${context.logicalId}.SourceObjectKeys.json`);
  }
  if (reference === undefined) {
    // Direct provider harnesses and rollback of an older resource do not have a
    // forward-operation asset artifact. Every live CREATE/UPDATE path does.
    if (active?.operationId === context.operationId && (active.kind === "CREATE" || active.kind === "UPDATE")) {
      throw new DeploymentBoundaryError("MissingAssetCheckpoint", "The accepted BucketDeployment source-asset checkpoint is missing");
    }
    return undefined;
  }
  if (!record(reference)
    || reference.logicalId !== context.logicalId
    || reference.resourceType !== CDK_BUCKET_DEPLOYMENT_TYPE
    || reference.propertyPath !== "SourceObjectKeys"
    || (reference.elementIndex ?? 0) !== elementIndex
    || reference.bucket !== model.SourceBucketNames[elementIndex]
    || reference.key !== model.SourceObjectKeys[elementIndex]
    || typeof reference.versionId !== "string" || !reference.versionId
    || typeof reference.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256)
    || typeof reference.etag !== "string" || !reference.etag
    || typeof reference.size !== "number" || !Number.isSafeInteger(reference.size) || reference.size < 0) {
    throw new DeploymentBoundaryError("InvalidAssetCheckpoint", "The accepted BucketDeployment source-asset checkpoint is malformed or addresses a different asset");
  }
  return { versionId: reference.versionId, sha256: reference.sha256, etag: reference.etag, size: reference.size };
}

async function prepareDeployment(
  s3: S3Service,
  store: StateStore,
  model: CdkBucketDeploymentModel,
  context: ProviderContext,
  pins?: readonly SourcePin[],
): Promise<PreparedDeployment> {
  const fn = await validatePinnedHelper(s3, store, model, context);
  requireRoleGrants(store, fn.role, [...commonRoleChecks(model), ...invalidationRoleChecks(model, context)]);
  if (pins && pins.length !== model.SourceObjectKeys.length) throw new DeploymentBoundaryError("InvalidCheckpoint", "The source-pin count does not match the accepted multi-source deployment");
  for (const bucketName of model.SourceBucketNames) {
    const sourceBucket = await s3.readBucketInternal(bucketName);
    if (!sourceBucket || sourceBucket.managedBy !== "stacksim-cdk-bootstrap" || sourceBucket.region !== context.region) throw new DeploymentBoundaryError("InvalidSource", "A source bucket is not the simulator-managed CDK bootstrap bucket in this Region");
  }
  const destinationBucket = await s3.readBucketInternal(model.DestinationBucketName);
  if (!destinationBucket || destinationBucket.managedBy) throw new DeploymentBoundaryError("InvalidDestination", "The destination must be a separate application-owned S3 bucket in this Region");
  const overlay = new Map<string, PreparedObject>();
  const sourcePins: SourcePin[] = [];
  const sources: Array<Awaited<ReturnType<S3Service["readObjectBytes"]>>> = [];
  let archiveBytes = 0;
  for (let index = 0; index < model.SourceObjectKeys.length; index += 1) {
    const accepted = await acceptedSourcePin(store, model, context, index);
    if (pins?.[index] && accepted && (pins[index].versionId !== accepted.versionId || pins[index].sha256 !== accepted.sha256 || pins[index].etag !== accepted.etag || pins[index].size !== accepted.size)) {
      throw new DeploymentBoundaryError("AssetChanged", "A durable deployment callback and accepted source-asset checkpoint disagree");
    }
    const expected = pins?.[index] ?? accepted;
    const source = await s3.readObjectBytes(model.SourceBucketNames[index], model.SourceObjectKeys[index], expected?.versionId, MAX_SOURCE_ARCHIVE_BYTES);
    archiveBytes += source.size;
    if (archiveBytes > MAX_SOURCE_ARCHIVE_BYTES) throw new DeploymentBoundaryError("InvalidAsset", "The combined source archives exceed the deployment archive limit");
    if (expected && (source.versionId !== expected.versionId || source.sha256 !== expected.sha256 || source.etag !== expected.etag || source.size !== expected.size)) throw new DeploymentBoundaryError("AssetChanged", "A pinned source asset fingerprint changed during deployment");
    sources.push(source);
    sourcePins.push({ versionId: source.versionId, sha256: source.sha256, etag: source.etag, size: source.size });
  }
  // Do not begin extraction until every declared source has been independently
  // version/digest/ETag/size pinned.
  let expandedBytes = 0;
  let expandedEntries = 0;
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const archive = readZipEntries(source.body, {
      maxEntryCount: Math.max(1, MAX_ASSET_ENTRY_COUNT - expandedEntries),
      maxEntrySize: MAX_ASSET_OBJECT_BYTES,
      maxUncompressedSize: Math.max(1, MAX_EXPANDED_ASSET_BYTES - expandedBytes),
    });
    expandedEntries += archive.entries.length;
    expandedBytes += archive.entries.reduce((sum, entry) => sum + entry.content.length, 0);
    if (expandedEntries > MAX_ASSET_ENTRY_COUNT || expandedBytes > MAX_EXPANDED_ASSET_BYTES) throw new DeploymentBoundaryError("InvalidAsset", "The combined expanded sources exceed the deployment limits");
    overlayObjects(overlay, replaceSourceMarkers(archive.entries, model.SourceMarkers[index]), model);
  }
  const objects = [...overlay.values()].sort((left, right) => Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)));
  if (objects.length > MAX_DESTINATION_OBJECT_COUNT || objects.reduce((sum, object) => sum + object.content.length, 0) > MAX_EXPANDED_ASSET_BYTES) throw new DeploymentBoundaryError("InvalidAsset", "The merged deployment output exceeds the destination limits");
  const current = await s3.listCurrentObjectsInternal(model.DestinationBucketName, prefixRoot(model.DestinationBucketKeyPrefix));
  if (current.length > MAX_DESTINATION_OBJECT_COUNT) throw new DeploymentBoundaryError("DestinationLimitExceeded", `The destination prefix contains more than ${MAX_DESTINATION_OBJECT_COUNT} current objects`);
  const destinationBucketArn = `arn:aws:s3:::${model.DestinationBucketName}`;
  const checks: Array<readonly [string, string]> = [];
  for (const object of objects) checks.push(["s3:GetObject", `${destinationBucketArn}/${object.key}`], ["s3:PutObject", `${destinationBucketArn}/${object.key}`]);
  const desiredKeys = new Set(objects.map(object => object.key));
  if (model.Prune) for (const object of current) if (!desiredKeys.has(object.key)) checks.push(["s3:DeleteObject", `${destinationBucketArn}/${object.key}`]);
  requireRoleGrants(store, fn.role, checks);
  return { objects, current, sourcePins };
}

function deploymentCheckpoint(phase: DeploymentCheckpoint["phase"], pins: readonly SourcePin[], batchStarted: boolean): DeploymentCheckpoint {
  return { phase, batchStarted, sourcePins: pins.map(pin => ({ versionId: pin.versionId, sha256: pin.sha256, etag: pin.etag, size: pin.size })), invalidationPhase: "", invalidationCallerReference: "", invalidationId: "" };
}

async function deployPrepared(s3: S3Service, prepared: PreparedDeployment, model: CdkBucketDeploymentModel, context: ProviderContext, phase: DeploymentCheckpoint["phase"], batchStarted: boolean): Promise<ProviderInProgress | true> {
  const current = new Map(prepared.current.map(object => [object.key, object]));
  const mutationLimit = batchStarted ? MAX_MUTATIONS_PER_CALLBACK : 1;
  let mutations = 0;
  for (const object of prepared.objects) {
    const existing = current.get(object.key);
    const expectedDigest = createHash("sha256").update(object.content).digest("hex");
    // aws s3 sync does not retroactively rewrite metadata when the object bytes
    // and key are unchanged. A subsequently copied object receives the current
    // exact metadata value.
    if (existing?.sha256 === expectedDigest && existing.contentType === object.contentType && !existing.contentEncoding && !existing.contentDisposition && !existing.contentLanguage && !existing.expires && !Object.keys(existing.metadata).length && !Object.keys(existing.tags).length) continue;
    const result = await s3.putObjectBytesInternal(model.DestinationBucketName, object.key, object.content, { contentType: object.contentType, ...(object.cacheControl === undefined ? {} : { cacheControl: object.cacheControl }) });
    if (result.changed && ++mutations >= mutationLimit) return inProgress(context, deploymentCheckpoint(phase, prepared.sourcePins, true));
  }
  if (model.Prune) {
    const desired = new Set(prepared.objects.map(object => object.key));
    for (const stale of prepared.current) {
      if (desired.has(stale.key)) continue;
      const result = await s3.deleteObjectInternal(model.DestinationBucketName, stale.key);
      if (result.deleted && ++mutations >= mutationLimit) return inProgress(context, deploymentCheckpoint(phase, prepared.sourcePins, true));
    }
  }
  return true;
}

async function deletePrefix(s3: S3Service, store: StateStore, model: CdkBucketDeploymentModel, context: ProviderContext): Promise<boolean> {
  const fn = await validatePinnedHelper(s3, store, model, context);
  const bucket = await s3.readBucketInternal(model.DestinationBucketName);
  if (!bucket) return true;
  const current = await s3.listCurrentObjectsInternal(model.DestinationBucketName, prefixRoot(model.DestinationBucketKeyPrefix));
  if (current.length > MAX_DESTINATION_OBJECT_COUNT) throw new DeploymentBoundaryError("DestinationLimitExceeded", `The destination prefix contains more than ${MAX_DESTINATION_OBJECT_COUNT} current objects`);
  if (!current.length) return true;
  const destinationBucketArn = `arn:aws:s3:::${model.DestinationBucketName}`;
  requireRoleGrants(store, fn.role, [["s3:ListBucket", destinationBucketArn], ...current.slice(0, MAX_MUTATIONS_PER_CALLBACK).map(object => ["s3:DeleteObject", `${destinationBucketArn}/${object.key}`] as const)]);
  let deleted = 0;
  for (const object of current.slice(0, MAX_MUTATIONS_PER_CALLBACK)) if ((await s3.deleteObjectInternal(model.DestinationBucketName, object.key)).deleted) deleted += 1;
  return !(deleted > 0 && current.length > deleted);
}

function invalidationCallerReference(context: ProviderContext, phase: Exclude<DeploymentCheckpoint["invalidationPhase"], "">): string {
  return `stacksim-${phase}-${createHash("sha256").update(`${context.resourceOperationId}\0${context.logicalId}\0${phase}`).digest("hex")}`;
}

function invalidationCheckpoint(
  phase: "invalidation-intent" | "invalidation-created",
  pins: readonly SourcePin[],
  invalidationPhase: Exclude<DeploymentCheckpoint["invalidationPhase"], "">,
  context: ProviderContext,
  invalidationId?: string,
): DeploymentCheckpoint {
  return {
    phase,
    batchStarted: true,
    sourcePins: pins.map(pin => ({ ...pin })),
    invalidationPhase,
    invalidationCallerReference: invalidationCallerReference(context, invalidationPhase),
    invalidationId: invalidationId ?? "",
  };
}

function operationInvalidationPhase(store: StateStore, context: ProviderContext, fallback: "create" | "update"): "create" | "update" | "rollback" {
  const stack = store.regionState(context.region).cloudformation.stacks[context.stackId];
  return stack?.stackStatus === "UPDATE_ROLLBACK_IN_PROGRESS" || stack?.activeOperation?.kind === "ROLLBACK_UPDATE" ? "rollback" : fallback;
}

function beginInvalidation(
  model: CdkBucketDeploymentModel,
  context: ProviderContext,
  pins: readonly SourcePin[],
  phase: Exclude<DeploymentCheckpoint["invalidationPhase"], "">,
): ProviderInProgress | ProviderSuccess<CdkBucketDeploymentModel> {
  return model.DistributionId ? inProgress(context, invalidationCheckpoint("invalidation-intent", pins, phase, context)) : success(model, context);
}

async function continueInvalidation(
  s3: S3Service,
  store: StateStore,
  invalidations: CdkBucketDeploymentInvalidationPort | undefined,
  model: CdkBucketDeploymentModel,
  context: ProviderContext,
  prior: DeploymentCheckpoint,
): Promise<ProviderInProgress | ProviderSuccess<CdkBucketDeploymentModel>> {
  if (!model.DistributionId || !model.DistributionPaths || !invalidations) throw new DeploymentBoundaryError("ProviderConfiguration", "CloudFront invalidation support is unavailable for this BucketDeployment");
  const phase = prior.invalidationPhase as Exclude<DeploymentCheckpoint["invalidationPhase"], "">;
  if (prior.invalidationCallerReference !== invalidationCallerReference(context, phase)) throw new DeploymentBoundaryError("InvalidCheckpoint", "The durable invalidation caller reference is malformed");
  const fn = await validatePinnedHelper(s3, store, model, context);
  requireRoleGrants(store, fn.role, invalidationRoleChecks(model, context));
  if (prior.phase === "invalidation-intent") {
    const created = await invalidations.createInvalidation(model.DistributionId, [...model.DistributionPaths], prior.invalidationCallerReference!);
    if (!created.id) throw new DeploymentBoundaryError("InvalidationFailed", "CloudFront returned an invalid invalidation identity");
    return inProgress(context, invalidationCheckpoint("invalidation-created", prior.sourcePins, phase, context, created.id));
  }
  const current = await invalidations.getInvalidation(model.DistributionId, prior.invalidationId!);
  if (current.id !== prior.invalidationId) throw new DeploymentBoundaryError("InvalidationFailed", "CloudFront returned a different invalidation identity");
  return current.status === "Completed" ? success(model, context) : inProgress(context, prior);
}

export function createCdkBucketDeploymentProvider(s3: S3Service, store: StateStore, invalidations?: CdkBucketDeploymentInvalidationPort): ProductionResourceProvider<CdkBucketDeploymentModel> {
  return {
    typeName: CDK_BUCKET_DEPLOYMENT_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: CDK_BUCKET_DEPLOYMENT_SCHEMA,

    validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[] { return validateModel(properties, context); },

    canonicalize(properties: unknown, context: ProviderContext): CdkBucketDeploymentModel {
      const issues = validateModel(properties, context);
      if (issues.length) throwValidation(issues);
      const value = properties as Record<string, unknown>;
      const sourceBuckets = value.SourceBucketNames as unknown[];
      const sourceKeys = value.SourceObjectKeys as unknown[];
      const markerValues = value.SourceMarkers as unknown[] | undefined;
      const markerConfigValues = value.SourceMarkersConfig as unknown[] | undefined;
      return Object.freeze({
        ServiceToken: String(value.ServiceToken),
        SourceBucketNames: Object.freeze(sourceBuckets.map(String)),
        SourceObjectKeys: Object.freeze(sourceKeys.map(String)),
        SourceMarkers: Object.freeze((markerValues ?? sourceKeys.map(() => ({}))).map(item => Object.freeze(Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, replacement]) => [key, String(replacement)]))))),
        SourceMarkersConfig: Object.freeze((markerConfigValues ?? sourceKeys.map(() => ({}))).map(() => Object.freeze({}))),
        DestinationBucketName: String(value.DestinationBucketName),
        ...(value.DestinationBucketArn === undefined ? {} : { DestinationBucketArn: String(value.DestinationBucketArn) }),
        ...(canonicalPrefix(value.DestinationBucketKeyPrefix) ? { DestinationBucketKeyPrefix: canonicalPrefix(value.DestinationBucketKeyPrefix) } : {}),
        WaitForDistributionInvalidation: true,
        Prune: Boolean(value.Prune),
        ...(value.SystemMetadata === undefined ? {} : { SystemMetadata: Object.freeze({ ...value.SystemMetadata as Record<string, string> }) }),
        ...(value.DistributionId === undefined ? {} : { DistributionId: String(value.DistributionId) }),
        ...(value.DistributionPaths === undefined ? {} : { DistributionPaths: Object.freeze((value.DistributionPaths as unknown[]).map(String)) }),
        OutputObjectKeys: true,
        RetainOnDelete: value.RetainOnDelete === undefined ? true : Boolean(value.RetainOnDelete),
      });
    },

    plan(previous: CdkBucketDeploymentModel | undefined, desired: CdkBucketDeploymentModel): ProviderPlan<CdkBucketDeploymentModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const changed = [...new Set([...Object.keys(previous), ...Object.keys(desired)])].filter(key => !same((previous as any)[key], (desired as any)[key])).sort();
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      const replacements = changed.filter(key => key === "ServiceToken");
      return replacements.length
        ? { action: "REPLACE", desired, changedProperties: changed, replacementProperties: replacements, replacementOrder: "CREATE_BEFORE_DELETE" }
        : { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
    },

    async create(desired: CdkBucketDeploymentModel, context: ProviderContext) {
      try {
        const prior = checkpoint(context.callbackContext);
        if (prior?.phase === "invalidation-intent" || prior?.phase === "invalidation-created") return await continueInvalidation(s3, store, invalidations, desired, context, prior);
        if (desired.DistributionId && !invalidations) throw new DeploymentBoundaryError("ProviderConfiguration", "CloudFront invalidation support is unavailable for this BucketDeployment");
        const prepared = await prepareDeployment(s3, store, desired, context, prior?.sourcePins);
        if (!prior) return inProgress(context, deploymentCheckpoint("deploy", prepared.sourcePins, false));
        const deployed = await deployPrepared(s3, prepared, desired, context, prior.phase, prior.batchStarted);
        return deployed === true ? beginInvalidation(desired, context, prepared.sourcePins, operationInvalidationPhase(store, context, "create")) : deployed;
      } catch (error) { return failure(error); }
    },

    async read(id: string, context: ProviderContext): Promise<ProviderReadResult<CdkBucketDeploymentModel>> {
      try {
        if (id !== physicalId(context)) return { status: "NOT_FOUND", physicalId: id };
        const resource = store.regionState(context.region).cloudformation.stacks[context.stackId]?.resources[context.logicalId];
        if (!resource || resource.resourceType !== CDK_BUCKET_DEPLOYMENT_TYPE) return { status: "NOT_FOUND", physicalId: id };
        const model = this.canonicalize(resource.properties, context);
        const bucket = await s3.readBucketInternal(model.DestinationBucketName);
        return bucket ? success(model, context, id) : { status: "NOT_FOUND", physicalId: id };
      } catch (error) { return failure(error); }
    },

    async update(id: string, previous: CdkBucketDeploymentModel, desired: CdkBucketDeploymentModel, context: ProviderContext): Promise<ProviderUpdateResult<CdkBucketDeploymentModel>> {
      try {
        if (id !== physicalId(context)) throw new DeploymentBoundaryError("OwnershipConflict", "The BucketDeployment physical ID is not owned by this stack resource");
        const prior = checkpoint(context.callbackContext);
        if (prior?.phase === "invalidation-intent" || prior?.phase === "invalidation-created") return await continueInvalidation(s3, store, invalidations, desired, context, prior);
        if (desired.DistributionId && !invalidations) throw new DeploymentBoundaryError("ProviderConfiguration", "CloudFront invalidation support is unavailable for this BucketDeployment");
        const destinationChanged = previous.DestinationBucketName !== desired.DestinationBucketName || previous.DestinationBucketKeyPrefix !== desired.DestinationBucketKeyPrefix;
        if (destinationChanged && !desired.RetainOnDelete && prior?.phase === "delete-old") {
          const deleted = await deletePrefix(s3, store, previous, context);
          if (!deleted) return inProgress(context, deploymentCheckpoint("delete-old", prior.sourcePins, true));
          return inProgress(context, deploymentCheckpoint("deploy", prior.sourcePins, false));
        }
        const prepared = await prepareDeployment(s3, store, desired, context, prior?.sourcePins);
        if (!prior) return inProgress(context, deploymentCheckpoint(destinationChanged && !desired.RetainOnDelete ? "delete-old" : "deploy", prepared.sourcePins, false));
        if (prior.phase === "delete-old") return inProgress(context, deploymentCheckpoint("deploy", prepared.sourcePins, false));
        const deployed = await deployPrepared(s3, prepared, desired, context, "deploy", prior.batchStarted);
        return deployed === true ? beginInvalidation(desired, context, prepared.sourcePins, operationInvalidationPhase(store, context, "update")) : deployed;
      } catch (error) { return failure(error); }
    },

    async delete(id: string, previous: CdkBucketDeploymentModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        if (id !== physicalId(context)) return { status: "NOT_FOUND", physicalId: id };
        const prior = checkpoint(context.callbackContext);
        if (prior?.phase === "invalidation-intent" || prior?.phase === "invalidation-created") {
          const result = await continueInvalidation(s3, store, invalidations, previous, context, prior);
          return result.status === "SUCCESS" ? { status: "SUCCESS", physicalId: id } : result;
        }
        if (previous.DistributionId && !invalidations) throw new DeploymentBoundaryError("ProviderConfiguration", "CloudFront invalidation support is unavailable for this BucketDeployment");
        const fn = await validatePinnedHelper(s3, store, previous, context);
        requireRoleGrants(store, fn.role, invalidationRoleChecks(previous, context));
        if (!previous.RetainOnDelete) {
          const deleted = await deletePrefix(s3, store, previous, context);
          if (!deleted) return inProgress(context, deploymentCheckpoint("delete", [], true));
        }
        const result = beginInvalidation(previous, context, [], "delete");
        return result.status === "SUCCESS" ? { status: "SUCCESS", physicalId: id } : result;
      } catch (error) { return failure(error); }
    },

    ref(model: ProviderReadModel<CdkBucketDeploymentModel>): unknown { return model.physicalId; },
    getAtt(model: ProviderReadModel<CdkBucketDeploymentModel>, attribute: string): unknown {
      if (attribute === "SourceObjectKeys") return model.attributes.SourceObjectKeys;
      if (attribute === "DestinationBucketArn") return model.attributes.DestinationBucketArn;
      throw new ProviderReferenceError(CDK_BUCKET_DEPLOYMENT_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}

/** Execute the pinned CDK hotswap Lambda event through the native provider boundary. */
export async function executeCdkBucketDeploymentHotswap(
  s3: S3Service,
  store: StateStore,
  region: string,
  functionArn: string,
  payload: Uint8Array,
  now: number,
): Promise<{ stackId: string; logicalId: string; physicalId: string }> {
  let event: Record<string, any>;
  try { event = JSON.parse(Buffer.from(payload).toString("utf8")); }
  catch { throw new AwsError("InvalidRequestContentException", "The BucketDeployment hotswap payload is not JSON", 400); }
  if (event.RequestType !== "Update" || !record(event.ResourceProperties)) throw new AwsError("InvalidRequestContentException", "The BucketDeployment hotswap payload is not the pinned Update event", 400);
  const matches: Array<{ stackId: string; logicalId: string; resource: CloudFormationStackResourceState }> = [];
  for (const stack of Object.values(store.regionState(region).cloudformation.stacks)) {
    if (stack.stackStatus === "DELETE_COMPLETE" || stack.completedDeploymentGeneration === undefined) continue;
    for (const resource of Object.values(stack.resources)) {
      if (resource.resourceType === CDK_BUCKET_DEPLOYMENT_TYPE && resource.properties.ServiceToken === functionArn
        && resource.properties.DestinationBucketName === event.ResourceProperties.DestinationBucketName) matches.push({ stackId: stack.stackId, logicalId: resource.logicalResourceId, resource });
    }
  }
  if (matches.length !== 1) throw new AwsError(matches.length ? "HotswapTargetAmbiguous" : "HotswapTargetNotManaged", "The BucketDeployment helper target is not uniquely owned by a completed deployment", 409);
  const match = matches[0];
  if (!match.resource.physicalResourceId) throw new AwsError("HotswapOwnershipStale", "The BucketDeployment custom resource has no completed physical identity", 409);
  const provider = createCdkBucketDeploymentProvider(s3, store);
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  };
  const operationId = createHash("sha256").update(Buffer.from(payload)).digest("hex");
  const base: ProviderContext = {
    accountId: store.accountId, region, partition: "aws", stackId: match.stackId, logicalId: match.logicalId,
    operationId,
    resourceOperationId: createHash("sha256").update(`${match.stackId}\0${match.logicalId}\0hotswap`).digest("hex"),
    idempotencyKey: `${operationId}:${match.logicalId}:hotswap`,
    deadlineAt: now + 5 * 60_000,
    principal: { identity: {} as any, serviceRoleArn: store.regionState(region).cloudformation.stacks[match.stackId].roleArn },
  };
  const previous = provider.canonicalize(match.resource.properties, base);
  const desiredProperties = normalize(event.ResourceProperties) as Record<string, unknown>;
  const desired = provider.canonicalize({ ...match.resource.properties, ...desiredProperties, ServiceToken: functionArn }, base);
  let callbackContext: Record<string, any> | undefined;
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const context: ProviderContext = { ...base, callbackContext };
    const result = await provider.update(match.resource.physicalResourceId, previous, desired, context);
    if (result.status === "SUCCESS") return { stackId: match.stackId, logicalId: match.logicalId, physicalId: match.resource.physicalResourceId };
    if (result.status === "FAILED") throw new AwsError(result.errorCode, result.message, 400);
    if (result.status !== "IN_PROGRESS") throw new AwsError("InternalFailure", "The BucketDeployment hotswap provider returned an invalid result", 500);
    callbackContext = result.checkpoint.callbackContext as Record<string, any>;
  }
  throw new AwsError("HotswapWaiterFailed", "The BucketDeployment hotswap exceeded its bounded native callback count", 504);
}
