import type { S3BucketConfigurationInput, S3Service } from "../../s3.js";
import type { S3BucketState } from "../../types.js";
import { AwsError } from "../../errors.js";
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
import {
  exactKeys,
  generatedS3BucketName,
  isRecord,
  isS3ResourceOwner,
  issue,
  S3_CLOUDFORMATION_OWNER_TAG,
  s3OwnerValue,
  same,
  validS3BucketName,
} from "./s3-common.js";

export const S3_BUCKET_TYPE = "AWS::S3::Bucket";

export interface S3BucketEncryptionModel {
  readonly ServerSideEncryptionConfiguration: readonly [{
    readonly ServerSideEncryptionByDefault: { readonly SSEAlgorithm: "AES256" };
  }];
}

export interface S3PublicAccessBlockModel {
  readonly BlockPublicAcls: boolean;
  readonly IgnorePublicAcls: boolean;
  readonly BlockPublicPolicy: boolean;
  readonly RestrictPublicBuckets: boolean;
}

export interface S3OwnershipControlsModel {
  readonly Rules: readonly [{ readonly ObjectOwnership: "BucketOwnerEnforced" }];
}

export interface S3WebsiteConfigurationModel {
  readonly IndexDocument: string;
  readonly ErrorDocument?: string;
}

export interface S3CorsConfigurationModel {
  readonly CorsRules: readonly [{
    readonly AllowedHeaders: readonly string[];
    readonly AllowedMethods: readonly ("GET" | "HEAD")[];
    readonly AllowedOrigins: readonly string[];
  }] | readonly { readonly AllowedHeaders: readonly string[]; readonly AllowedMethods: readonly ("GET" | "HEAD")[]; readonly AllowedOrigins: readonly string[] }[];
}

export interface S3LambdaNotificationModel {
  readonly Event: string;
  readonly Function: string;
}

export interface S3NotificationConfigurationModel {
  readonly LambdaConfigurations: readonly S3LambdaNotificationModel[];
}

export interface S3BucketModel {
  readonly BucketName: string;
  readonly BucketEncryption: S3BucketEncryptionModel;
  readonly VersioningConfiguration?: { readonly Status: "Enabled" | "Suspended" };
  readonly OwnershipControls?: S3OwnershipControlsModel;
  readonly PublicAccessBlockConfiguration?: S3PublicAccessBlockModel;
  readonly Tags: readonly { readonly Key: string; readonly Value: string }[];
  readonly WebsiteConfiguration?: S3WebsiteConfigurationModel;
  readonly CorsConfiguration?: S3CorsConfigurationModel;
  readonly NotificationConfiguration?: S3NotificationConfigurationModel;
}

const AES256_ENCRYPTION: S3BucketEncryptionModel = Object.freeze({
  ServerSideEncryptionConfiguration: Object.freeze([
    Object.freeze({ ServerSideEncryptionByDefault: Object.freeze({ SSEAlgorithm: "AES256" as const }) }),
  ]) as unknown as S3BucketEncryptionModel["ServerSideEncryptionConfiguration"],
});

export const S3_BUCKET_SCHEMA: ProviderSchema = Object.freeze({
  typeName: S3_BUCKET_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    BucketName: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    BucketEncryption: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    VersioningConfiguration: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    OwnershipControls: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    PublicAccessBlockConfiguration: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    WebsiteConfiguration: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    CorsConfiguration: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    NotificationConfiguration: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Bucket name" }),
  attributes: Object.freeze({
    Arn: Object.freeze({ valueType: "string", description: "S3 bucket ARN" }),
    WebsiteURL: Object.freeze({ valueType: "string", description: "Simulator-backed S3 website endpoint" }),
    RegionalDomainName: Object.freeze({ valueType: "string", description: "Regional virtual-hosted S3 domain name" }),
  }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: Object.freeze({
    deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    snapshotSupported: false,
  }),
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

function validateEncryption(value: unknown, issues: ProviderValidationIssue[]): void {
  const path = "Properties.BucketEncryption";
  if (!isRecord(value)) return;
  exactKeys(value, ["ServerSideEncryptionConfiguration"], path, issues);
  const rules = value.ServerSideEncryptionConfiguration;
  if (!Array.isArray(rules) || rules.length !== 1) {
    issue(issues, `${path}.ServerSideEncryptionConfiguration`, "Exactly one SSE-S3 rule is required");
    return;
  }
  const rulePath = `${path}.ServerSideEncryptionConfiguration.0`;
  const rule = rules[0];
  if (!isRecord(rule)) {
    issue(issues, rulePath, "The SSE-S3 rule must be an object");
    return;
  }
  exactKeys(rule, ["ServerSideEncryptionByDefault"], rulePath, issues);
  const defaultsPath = `${rulePath}.ServerSideEncryptionByDefault`;
  const defaults = rule.ServerSideEncryptionByDefault;
  if (!isRecord(defaults)) {
    issue(issues, defaultsPath, "ServerSideEncryptionByDefault must be an object");
    return;
  }
  exactKeys(defaults, ["SSEAlgorithm"], defaultsPath, issues);
  if (defaults.SSEAlgorithm !== "AES256") {
    issue(issues, `${defaultsPath}.SSEAlgorithm`, "Only SSE-S3 encryption with SSEAlgorithm AES256 is supported; KMS and DSSE are unavailable");
  }
}

function validateVersioning(value: unknown, issues: ProviderValidationIssue[]): void {
  if (!isRecord(value)) return;
  const path = "Properties.VersioningConfiguration";
  exactKeys(value, ["Status"], path, issues);
  if (value.Status !== "Enabled" && value.Status !== "Suspended") {
    issue(issues, `${path}.Status`, "Status must be Enabled or Suspended");
  }
}

function validateOwnershipControls(value: unknown, issues: ProviderValidationIssue[]): void {
  const path = "Properties.OwnershipControls";
  if (!isRecord(value)) return;
  exactKeys(value, ["Rules"], path, issues);
  if (!Array.isArray(value.Rules) || value.Rules.length !== 1 || !isRecord(value.Rules[0])) {
    issue(issues, `${path}.Rules`, "OwnershipControls requires exactly one rule");
    return;
  }
  exactKeys(value.Rules[0], ["ObjectOwnership"], `${path}.Rules.0`, issues);
  if (value.Rules[0].ObjectOwnership !== "BucketOwnerEnforced") {
    issue(issues, `${path}.Rules.0.ObjectOwnership`, "Only BucketOwnerEnforced is supported");
  }
}

const PUBLIC_ACCESS_FIELDS = ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"] as const;

function validatePublicAccessBlock(value: unknown, issues: ProviderValidationIssue[]): void {
  if (!isRecord(value)) return;
  const path = "Properties.PublicAccessBlockConfiguration";
  exactKeys(value, PUBLIC_ACCESS_FIELDS, path, issues);
  for (const field of PUBLIC_ACCESS_FIELDS) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      issue(issues, `${path}.${field}`, `${field} must be a boolean`);
    }
  }
}

function validTagText(value: string): boolean {
  return /^[\p{L}\p{M}\p{Z}\p{N}_.:/=+\-@]*$/u.test(value);
}

function validateTags(value: unknown, issues: ProviderValidationIssue[]): void {
  if (!Array.isArray(value)) return;
  if (value.length > 49) {
    issue(issues, "Properties.Tags", "At most 49 tags are supported because one private ownership tag is required for retry safety");
  }
  const keys = new Set<string>();
  for (const [index, item] of value.entries()) {
    const path = `Properties.Tags.${index}`;
    if (!isRecord(item)) {
      issue(issues, path, "Each tag must be an object with string Key and Value");
      continue;
    }
    exactKeys(item, ["Key", "Value"], path, issues);
    if (typeof item.Key !== "string" || typeof item.Value !== "string") {
      issue(issues, path, "Each tag requires string Key and Value");
      continue;
    }
    if (![...item.Key].length || [...item.Key].length > 128 || [...item.Value].length > 256 || !validTagText(item.Key) || !validTagText(item.Value)) {
      issue(issues, path, "Tag keys and values must satisfy the standard S3 tag character and length bounds");
    }
    if (item.Key.toLowerCase().startsWith("aws:") || item.Key.startsWith("stacksim:cloudformation:")) {
      issue(issues, `${path}.Key`, "The tag key uses a reserved prefix or CloudFormation ownership key");
    }
    if (keys.has(item.Key)) issue(issues, `${path}.Key`, "Tag keys must be unique");
    keys.add(item.Key);
  }
}

function validateWebsiteKey(value: unknown, path: string, issues: ProviderValidationIssue[]): void {
  if (typeof value !== "string" || !value || value.startsWith("/") || Buffer.byteLength(value, "utf8") > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
    issue(issues, path, `${path.split(".").at(-1)} must be a nonempty relative S3 object key of at most 1024 UTF-8 bytes`);
  }
}

function validateWebsite(value: unknown, issues: ProviderValidationIssue[]): void {
  if (!isRecord(value)) return;
  const path = "Properties.WebsiteConfiguration";
  exactKeys(value, ["IndexDocument", "ErrorDocument"], path, issues);
  validateWebsiteKey(value.IndexDocument, `${path}.IndexDocument`, issues);
  if (value.ErrorDocument !== undefined) validateWebsiteKey(value.ErrorDocument, `${path}.ErrorDocument`, issues);
}

function validateCors(value: unknown, issues: ProviderValidationIssue[]): void {
  const path = "Properties.CorsConfiguration";
  if (!isRecord(value)) return;
  exactKeys(value, ["CorsRules"], path, issues);
  if (!Array.isArray(value.CorsRules) || value.CorsRules.length !== 1 || !isRecord(value.CorsRules[0])) {
    issue(issues, `${path}.CorsRules`, "Exactly one generated CORS rule is required");
    return;
  }
  const rule = value.CorsRules[0];
  exactKeys(rule, ["AllowedHeaders", "AllowedMethods", "AllowedOrigins"], `${path}.CorsRules.0`, issues);
  if (JSON.stringify(rule.AllowedHeaders) !== JSON.stringify(["*"])) issue(issues, `${path}.CorsRules.0.AllowedHeaders`, "The generated rule requires the wildcard header");
  if (JSON.stringify(rule.AllowedMethods) !== JSON.stringify(["GET", "HEAD"])) issue(issues, `${path}.CorsRules.0.AllowedMethods`, "The generated rule requires GET then HEAD");
  if (!Array.isArray(rule.AllowedOrigins) || rule.AllowedOrigins.length !== 1 || typeof rule.AllowedOrigins[0] !== "string" || !/^https:\/\/[a-z0-9-]+\.console\.aws\.amazon\.com\/amplify$/.test(rule.AllowedOrigins[0])) issue(issues, `${path}.CorsRules.0.AllowedOrigins`, "The generated origin must be the regional AWS console Amplify URL");
}

const S3_NOTIFICATION_EVENT = /^(?:s3:)?(?:(?:ObjectCreated|ObjectRemoved):(?:\*|Put|Post|Copy|CompleteMultipartUpload|Delete|DeleteMarkerCreated)|ObjectRestore:(?:\*|Post|Completed|Delete)|ObjectTagging:(?:\*|Put|Delete)|ObjectAcl:Put|ObjectAnnotation:(?:\*|Put|Delete)|LifecycleExpiration:(?:\*|Delete|DeleteMarkerCreated|DeleteMarkerDeleted)|LifecycleTransition)$/;

function validateNotification(value: unknown, issues: ProviderValidationIssue[]): void {
  const path = "Properties.NotificationConfiguration";
  if (!isRecord(value)) return;
  exactKeys(value, ["LambdaConfigurations"], path, issues);
  if (!Array.isArray(value.LambdaConfigurations) || !value.LambdaConfigurations.length || value.LambdaConfigurations.length > 100) {
    issue(issues, `${path}.LambdaConfigurations`, "One to 100 Lambda configurations are required");
    return;
  }
  for (const [index, item] of value.LambdaConfigurations.entries()) {
    const itemPath = `${path}.LambdaConfigurations.${index}`;
    if (!isRecord(item)) {
      issue(issues, itemPath, "Each Lambda configuration must be an object");
      continue;
    }
    exactKeys(item, ["Event", "Function"], itemPath, issues);
    if (typeof item.Event !== "string" || !S3_NOTIFICATION_EVENT.test(item.Event)) {
      issue(issues, `${itemPath}.Event`, "Event must be a supported S3 notification event name");
    }
    if (typeof item.Function !== "string" || !item.Function) {
      issue(issues, `${itemPath}.Function`, "Function must be a Lambda function ARN");
    }
  }
}

function validateBucketProperties(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, S3_BUCKET_SCHEMA);
  if (!isRecord(properties)) return issues;
  if (properties.BucketName !== undefined && (typeof properties.BucketName !== "string" || !validS3BucketName(properties.BucketName))) {
    issue(issues, "Properties.BucketName", "BucketName must satisfy the S3 general-purpose bucket naming rules");
  }
  if (properties.BucketEncryption !== undefined) validateEncryption(properties.BucketEncryption, issues);
  if (properties.VersioningConfiguration !== undefined) validateVersioning(properties.VersioningConfiguration, issues);
  if (properties.OwnershipControls !== undefined) validateOwnershipControls(properties.OwnershipControls, issues);
  if (properties.PublicAccessBlockConfiguration !== undefined) validatePublicAccessBlock(properties.PublicAccessBlockConfiguration, issues);
  if (properties.Tags !== undefined) validateTags(properties.Tags, issues);
  if (properties.WebsiteConfiguration !== undefined) validateWebsite(properties.WebsiteConfiguration, issues);
  if (properties.CorsConfiguration !== undefined) validateCors(properties.CorsConfiguration, issues);
  if (properties.NotificationConfiguration !== undefined) validateNotification(properties.NotificationConfiguration, issues);
  return issues;
}

function publicAccessBlock(value: unknown): S3PublicAccessBlockModel | undefined {
  if (!isRecord(value)) return undefined;
  const model = {
    BlockPublicAcls: Boolean(value.BlockPublicAcls),
    IgnorePublicAcls: Boolean(value.IgnorePublicAcls),
    BlockPublicPolicy: Boolean(value.BlockPublicPolicy),
    RestrictPublicBuckets: Boolean(value.RestrictPublicBuckets),
  };
  return model;
}

function ownershipControls(value: unknown): S3OwnershipControlsModel | undefined {
  if (!isRecord(value)) return undefined;
  return { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] };
}

function canonicalTags(value: unknown): S3BucketModel["Tags"] {
  return (Array.isArray(value) ? value : [])
    .map(item => ({ Key: String((item as Record<string, unknown>).Key), Value: String((item as Record<string, unknown>).Value) }))
    .sort((left, right) => left.Key.localeCompare(right.Key));
}

function canonicalWebsite(value: unknown): S3WebsiteConfigurationModel | undefined {
  if (!isRecord(value)) return undefined;
  return {
    IndexDocument: String(value.IndexDocument),
    ...(value.ErrorDocument !== undefined ? { ErrorDocument: String(value.ErrorDocument) } : {}),
  };
}

function canonicalCors(value: unknown): S3CorsConfigurationModel | undefined {
  if (!isRecord(value) || !Array.isArray(value.CorsRules) || !isRecord(value.CorsRules[0])) return undefined;
  return { CorsRules: [{ AllowedHeaders: ["*"], AllowedMethods: ["GET", "HEAD"], AllowedOrigins: [String((value.CorsRules[0] as Record<string, unknown>).AllowedOrigins instanceof Array ? ((value.CorsRules[0] as Record<string, unknown>).AllowedOrigins as unknown[])[0] : "")] }] };
}

function canonicalNotification(value: unknown): S3NotificationConfigurationModel | undefined {
  if (!isRecord(value) || !Array.isArray(value.LambdaConfigurations)) return undefined;
  return {
    LambdaConfigurations: value.LambdaConfigurations.map(item => {
      const event = String((item as Record<string, unknown>).Event);
      return {
        Event: event.startsWith("s3:") ? event : `s3:${event}`,
        Function: String((item as Record<string, unknown>).Function),
      };
    }),
  };
}

function canonicalBucket(properties: Record<string, unknown>, context: ProviderContext): S3BucketModel {
  const versioning = isRecord(properties.VersioningConfiguration)
    ? { Status: String(properties.VersioningConfiguration.Status) as "Enabled" | "Suspended" }
    : undefined;
  const pab = publicAccessBlock(properties.PublicAccessBlockConfiguration);
  const ownership = ownershipControls(properties.OwnershipControls);
  const website = canonicalWebsite(properties.WebsiteConfiguration);
  const cors = canonicalCors(properties.CorsConfiguration);
  const notification = canonicalNotification(properties.NotificationConfiguration);
  return {
    BucketName: String(properties.BucketName ?? generatedS3BucketName(context)),
    BucketEncryption: AES256_ENCRYPTION,
    ...(versioning ? { VersioningConfiguration: versioning } : {}),
    ...(ownership ? { OwnershipControls: ownership } : {}),
    ...(pab ? { PublicAccessBlockConfiguration: pab } : {}),
    Tags: canonicalTags(properties.Tags),
    ...(website ? { WebsiteConfiguration: website } : {}),
    ...(cors ? { CorsConfiguration: cors } : {}),
    ...(notification ? { NotificationConfiguration: notification } : {}),
  };
}

function notificationState(model: S3BucketModel): NonNullable<S3BucketState["notificationConfiguration"]> {
  return {
    lambda: (model.NotificationConfiguration?.LambdaConfigurations ?? []).map((item, index) => ({
      id: `cloudformation-${index + 1}`,
      arn: item.Function,
      events: [item.Event.startsWith("s3:") ? item.Event : `s3:${item.Event}`],
    })),
    queue: [],
    eventBridge: false,
  };
}

function inputFor(model: S3BucketModel, context: ProviderContext): S3BucketConfigurationInput {
  return {
    name: model.BucketName,
    versioning: model.VersioningConfiguration?.Status === "Enabled"
      ? "enabled"
      : model.VersioningConfiguration?.Status === "Suspended" ? "suspended" : "unversioned",
    encryption: "AES256",
    ...(model.OwnershipControls ? { objectOwnership: "BucketOwnerEnforced" as const } : {}),
    tags: {
      ...Object.fromEntries(model.Tags.map(tag => [tag.Key, tag.Value])),
      [S3_CLOUDFORMATION_OWNER_TAG]: s3OwnerValue(context),
    },
    ...(model.PublicAccessBlockConfiguration ? {
      publicAccessBlock: {
        blockPublicAcls: model.PublicAccessBlockConfiguration.BlockPublicAcls,
        ignorePublicAcls: model.PublicAccessBlockConfiguration.IgnorePublicAcls,
        blockPublicPolicy: model.PublicAccessBlockConfiguration.BlockPublicPolicy,
        restrictPublicBuckets: model.PublicAccessBlockConfiguration.RestrictPublicBuckets,
      },
    } : {}),
    ...(model.WebsiteConfiguration ? {
      website: {
        indexDocument: model.WebsiteConfiguration.IndexDocument,
        ...(model.WebsiteConfiguration.ErrorDocument ? { errorDocument: model.WebsiteConfiguration.ErrorDocument } : {}),
      },
    } : {}),
    ...(model.CorsConfiguration ? { cors: [{ allowedHeaders: ["*"], allowedMethods: ["GET", "HEAD"], allowedOrigins: [model.CorsConfiguration.CorsRules[0].AllowedOrigins[0]] }] } : {}),
  };
}

function tagsFromState(state: S3BucketState): Record<string, string> {
  const value = (state as S3BucketState & { tags?: Record<string, string> }).tags;
  return value && isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)])) : {};
}

function modelFromState(state: S3BucketState): S3BucketModel {
  const extended = state as S3BucketState & {
    publicAccessBlock?: { blockPublicAcls?: boolean; ignorePublicAcls?: boolean; blockPublicPolicy?: boolean; restrictPublicBuckets?: boolean };
    website?: { indexDocument: string; errorDocument?: string };
  };
  const pab = extended.publicAccessBlock && publicAccessBlock({
    BlockPublicAcls: extended.publicAccessBlock.blockPublicAcls,
    IgnorePublicAcls: extended.publicAccessBlock.ignorePublicAcls,
    BlockPublicPolicy: extended.publicAccessBlock.blockPublicPolicy,
    RestrictPublicBuckets: extended.publicAccessBlock.restrictPublicBuckets,
  });
  const publicAccessBlockConfigured = state.cloudFormationConfiguration?.publicAccessBlock
    ?? Boolean(pab && Object.values(pab).some(Boolean));
  if (state.cloudFormationConfiguration?.ownershipControls && state.objectOwnership !== "BucketOwnerEnforced") {
    throw new AwsError("InvalidBucketState", `Bucket ${state.name} has ownership controls outside the supported BucketOwnerEnforced profile`, 409);
  }
  const tags = tagsFromState(state);
  delete tags[S3_CLOUDFORMATION_OWNER_TAG];
  const lambdaConfigurations = (state.notificationConfiguration?.lambda ?? []).flatMap(item => item.events.map(event => ({
    Event: event,
    Function: item.arn,
  })));
  return {
    BucketName: state.name,
    BucketEncryption: AES256_ENCRYPTION,
    ...(state.versioning === "enabled" ? { VersioningConfiguration: { Status: "Enabled" as const } }
      : state.versioning === "suspended" ? { VersioningConfiguration: { Status: "Suspended" as const } } : {}),
    ...(state.cloudFormationConfiguration?.ownershipControls ? { OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" as const }] } } : {}),
    ...(publicAccessBlockConfigured && pab ? { PublicAccessBlockConfiguration: pab } : {}),
    Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })).sort((left, right) => left.Key.localeCompare(right.Key)),
    ...(extended.website ? { WebsiteConfiguration: { IndexDocument: extended.website.indexDocument, ...(extended.website.errorDocument ? { ErrorDocument: extended.website.errorDocument } : {}) } } : {}),
    ...(extended.corsConfiguration ? { CorsConfiguration: { CorsRules: extended.corsConfiguration.map(rule => ({ AllowedHeaders: rule.allowedHeaders, AllowedMethods: rule.allowedMethods, AllowedOrigins: rule.allowedOrigins })) } } : {}),
    ...(lambdaConfigurations.length ? { NotificationConfiguration: { LambdaConfigurations: lambdaConfigurations } } : {}),
  };
}

function success(s3: S3Service, state: S3BucketState): ProviderSuccess<S3BucketModel> {
  const model = modelFromState(state);
  return {
    status: "SUCCESS",
    physicalId: state.name,
    model: {
      physicalId: state.name,
      properties: model,
      attributes: {
        Arn: state.arn,
        RegionalDomainName: `${state.name}.s3.${state.region}.amazonaws.com`,
        ...(model.WebsiteConfiguration ? { WebsiteURL: s3.websiteUrl(state.name) } : {}),
      },
    },
  };
}

function failed(error: unknown): ProviderUpdateResult<S3BucketModel> {
  const aws = error instanceof AwsError
    ? error
    : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}

function notFound(error: unknown): boolean {
  return error instanceof AwsError && error.code === "NoSuchBucket";
}

export function createS3BucketProvider(s3: S3Service): ProductionResourceProvider<S3BucketModel> {
  const owned = (state: S3BucketState, context: ProviderContext): boolean => isS3ResourceOwner(tagsFromState(state), context);
  const ownershipFailure = (name: string) => ({
    status: "FAILED" as const,
    errorCode: "OwnershipConflict",
    message: `Bucket ${name} is not owned by this stack resource`,
  });

  return {
    typeName: S3_BUCKET_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: S3_BUCKET_SCHEMA,

    validate(properties: unknown): readonly ProviderValidationIssue[] {
      return validateBucketProperties(properties);
    },

    canonicalize(properties: unknown, context: ProviderContext): S3BucketModel {
      if (!isRecord(properties)) throw new TypeError(`${S3_BUCKET_TYPE} Properties must be an object`);
      const issues = validateBucketProperties(properties);
      if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return canonicalBucket(properties, context);
    },

    plan(previous: S3BucketModel | undefined, desired: S3BucketModel): ProviderPlan<S3BucketModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const fields = ["BucketName", "BucketEncryption", "VersioningConfiguration", "OwnershipControls", "PublicAccessBlockConfiguration", "Tags", "WebsiteConfiguration", "CorsConfiguration", "NotificationConfiguration"] as const;
      const changed = fields.filter(field => !same(previous[field], desired[field]));
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      if (changed.includes("BucketName")) {
        return { action: "REPLACE", desired, changedProperties: changed, replacementProperties: ["BucketName"], replacementOrder: "CREATE_BEFORE_DELETE" };
      }
      return { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
    },

    async create(desired: S3BucketModel, context: ProviderContext) {
      try {
        const existing = await s3.readBucketInternal(desired.BucketName);
        if (existing) {
          if (!owned(existing, context)) {
            return { status: "FAILED", errorCode: "AlreadyExists", message: `Bucket ${desired.BucketName} already exists and is not owned by this stack resource` };
          }
          // Replay the create contract itself. Besides refusing to adopt a
          // drifted same-name bucket, this lets the backing service repair an
          // interrupted state-first creation whose empty index was not yet
          // durably written.
          const created = await s3.createBucketInternal(inputFor(desired, context));
          return success(s3, desired.NotificationConfiguration
            ? await s3.putBucketNotificationInternal(desired.BucketName, notificationState(desired))
            : created);
        }
        const created = await s3.createBucketInternal(inputFor(desired, context));
        return success(s3, desired.NotificationConfiguration
          ? await s3.putBucketNotificationInternal(desired.BucketName, notificationState(desired))
          : created);
      } catch (error) {
        return failed(error);
      }
    },

    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<S3BucketModel>> {
      try {
        const state = await s3.readBucketInternal(physicalId);
        if (!state) return { status: "NOT_FOUND", physicalId };
        if (!owned(state, context)) return ownershipFailure(physicalId);
        return success(s3, state);
      } catch (error) {
        return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderReadResult<S3BucketModel>;
      }
    },

    async update(physicalId: string, previous: S3BucketModel, desired: S3BucketModel, context: ProviderContext): Promise<ProviderUpdateResult<S3BucketModel>> {
      if (physicalId !== desired.BucketName) {
        return { status: "FAILED", errorCode: "RequiresReplacement", message: "BucketName changes require replacement" };
      }
      try {
        const state = await s3.readBucketInternal(physicalId);
        if (!state) return { status: "FAILED", errorCode: "NoSuchBucket", message: `Bucket ${physicalId} no longer exists` };
        if (!owned(state, context)) return ownershipFailure(physicalId);
        const { name: _name, ...configuration } = inputFor(desired, context);
        const updated = await s3.updateBucketInternal(physicalId, configuration);
        return success(s3, desired.NotificationConfiguration || previous.NotificationConfiguration
          ? await s3.putBucketNotificationInternal(physicalId, notificationState(desired))
          : updated);
      } catch (error) {
        return failed(error);
      }
    },

    async delete(physicalId: string, _previous: S3BucketModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const state = await s3.readBucketInternal(physicalId);
        if (!state) return { status: "NOT_FOUND", physicalId };
        if (!owned(state, context)) return ownershipFailure(physicalId);
        await s3.deleteBucketInternal(physicalId);
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderDeleteResult;
      }
    },

    ref(model: ProviderReadModel<S3BucketModel>): unknown {
      return model.physicalId;
    },

    getAtt(model: ProviderReadModel<S3BucketModel>, attribute: string): unknown {
      if (attribute === "Arn") return model.attributes.Arn;
      if (attribute === "RegionalDomainName") return model.attributes.RegionalDomainName;
      if (attribute === "WebsiteURL" && model.attributes.WebsiteURL) return model.attributes.WebsiteURL;
      throw new ProviderReferenceError(S3_BUCKET_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}
