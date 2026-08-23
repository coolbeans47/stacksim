import type { S3Service } from "../../s3.js";
import type { PolicyDocument } from "../../types.js";
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
  isRecord,
  isS3StackOwner,
  issue,
  same,
  stable,
} from "./s3-common.js";

export const S3_BUCKET_POLICY_TYPE = "AWS::S3::BucketPolicy";

export interface S3BucketPolicyModel {
  readonly Bucket: string;
  readonly PolicyDocument: PolicyDocument;
}

export const S3_BUCKET_POLICY_SCHEMA: ProviderSchema = Object.freeze({
  typeName: S3_BUCKET_POLICY_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Bucket: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    PolicyDocument: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Bucket name associated with this policy" }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: Object.freeze({
    deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    snapshotSupported: false,
  }),
  tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});

type PolicyRole = "public-read" | "tls-deny" | "auto-delete" | "cloudfront-oac" | "cleanup-deny";

const AUTO_DELETE_ACTIONS = ["s3:DeleteObject*", "s3:GetBucket*", "s3:List*", "s3:PutBucketPolicy"] as const;

function stringSet(value: unknown): string[] | undefined {
  const items = typeof value === "string" ? [value] : Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
  return items && new Set(items).size === items.length ? [...items].sort() : undefined;
}

function exactSet(value: unknown, wanted: readonly string[]): boolean {
  const actual = stringSet(value);
  return actual !== undefined && same(actual, [...wanted].sort());
}

function autoDeleteRoleArn(value: unknown, context?: ProviderContext): boolean {
  if (typeof value !== "string") return false;
  const match = value.match(/^arn:([a-z0-9-]+):iam::(\d{12}):role\/(?:[A-Za-z0-9+=,.@_-]*CustomS3AutoDelete[A-Za-z0-9+=,.@_-]*|amplify-stacksimamplifygen2datafixture-[A-Za-z0-9-]+-[a-f0-9]{12})$/);
  return Boolean(match && (!context || match[1] === context.partition && match[2] === context.accountId));
}

function likelyRole(statement: Record<string, unknown>): PolicyRole {
  if (isRecord(statement.Principal) && statement.Principal.Service !== undefined) return "cloudfront-oac";
  if (statement.Effect === "Deny" && statement.Condition !== undefined) return "tls-deny";
  if (statement.Effect === "Deny") return "cleanup-deny";
  if (isRecord(statement.Principal) && typeof statement.Principal.AWS === "string" && statement.Principal.AWS !== "*") return "auto-delete";
  return "public-read";
}

function validateStatement(
  role: PolicyRole,
  statement: Record<string, unknown>,
  statementPath: string,
  bucket: string,
  context: ProviderContext | undefined,
  issues: ProviderValidationIssue[],
): void {
  exactKeys(statement, role === "tls-deny" || role === "cloudfront-oac" ? ["Action", "Condition", "Effect", "Principal", "Resource"] : ["Action", "Effect", "Principal", "Resource"], statementPath, issues);
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const objectArn = `${bucketArn}/*`;
  if (role === "tls-deny") {
    if (!exactSet(statement.Action, ["s3:*"])) issue(issues, `${statementPath}.Action`, "The TLS-only statement requires only s3:*");
    if (statement.Effect !== "Deny") issue(issues, `${statementPath}.Effect`, "The TLS-only statement must deny insecure transport");
    if (!same(statement.Principal, { AWS: "*" })) issue(issues, `${statementPath}.Principal`, "The TLS-only statement requires the public AWS principal");
    if (!same(statement.Condition, { Bool: { "aws:SecureTransport": "false" } })) issue(issues, `${statementPath}.Condition`, "The TLS-only statement requires only aws:SecureTransport=false");
    if (!exactSet(statement.Resource, [bucketArn, objectArn])) issue(issues, `${statementPath}.Resource`, "The TLS-only statement requires exactly the selected bucket and object ARNs");
    return;
  }
  if (role === "auto-delete") {
    if (!exactSet(statement.Action, AUTO_DELETE_ACTIONS)) issue(issues, `${statementPath}.Action`, "The auto-delete statement requires the exact generated action set");
    if (statement.Effect !== "Allow") issue(issues, `${statementPath}.Effect`, "The auto-delete statement must allow its generated role");
    if (!isRecord(statement.Principal) || !autoDeleteRoleArn(statement.Principal.AWS, context) || Object.keys(statement.Principal).some(key => key !== "AWS")) issue(issues, `${statementPath}.Principal`, "The auto-delete principal must be the same-account generated provider role ARN");
    if (!exactSet(statement.Resource, [bucketArn, objectArn])) issue(issues, `${statementPath}.Resource`, "The auto-delete statement requires exactly the selected bucket and object ARNs");
    return;
  }
  if (role === "cloudfront-oac") {
    if (!exactSet(statement.Action, ["s3:GetObject"])) issue(issues, `${statementPath}.Action`, "The CloudFront OAC statement requires only s3:GetObject");
    if (statement.Effect !== "Allow") issue(issues, `${statementPath}.Effect`, "The CloudFront OAC statement must allow object reads");
    if (!same(statement.Principal, { Service: "cloudfront.amazonaws.com" })) issue(issues, `${statementPath}.Principal`, "The CloudFront OAC statement requires only the cloudfront.amazonaws.com service principal");
    if (!exactSet(statement.Resource, [objectArn])) issue(issues, `${statementPath}.Resource`, "The CloudFront OAC statement requires only the selected bucket object ARN");
    const sourceArn = isRecord(statement.Condition) && isRecord(statement.Condition.StringEquals)
      ? statement.Condition.StringEquals["AWS:SourceArn"]
      : undefined;
    const partition = context?.partition ?? "aws";
    const account = context?.accountId ?? "\\d{12}";
    const expression = new RegExp(`^arn:${partition}:cloudfront::${account}:distribution\\/[A-Z0-9]+$`);
    if (!same(statement.Condition, { StringEquals: { "AWS:SourceArn": sourceArn } }) || typeof sourceArn !== "string" || !expression.test(sourceArn)) {
      issue(issues, `${statementPath}.Condition`, "The CloudFront OAC statement requires only a matching same-account distribution AWS:SourceArn");
    }
    return;
  }
  if (role === "cleanup-deny") {
    if (!exactSet(statement.Action, ["s3:PutObject"])) issue(issues, `${statementPath}.Action`, "The auto-delete cleanup statement requires only s3:PutObject");
    if (statement.Effect !== "Deny") issue(issues, `${statementPath}.Effect`, "The auto-delete cleanup statement must deny writes");
    if (statement.Principal !== "*") issue(issues, `${statementPath}.Principal`, "The auto-delete cleanup statement requires the exact public principal");
    if (!exactSet(statement.Resource, [objectArn])) issue(issues, `${statementPath}.Resource`, "The auto-delete cleanup statement requires only the selected bucket object ARN");
    return;
  }
  if (!exactSet(statement.Action, ["s3:GetObject"])) issue(issues, `${statementPath}.Action`, "The public-read statement requires only s3:GetObject");
  if (statement.Effect !== "Allow") issue(issues, `${statementPath}.Effect`, "The public-read statement must allow object reads");
  if (!same(statement.Principal, { AWS: "*" })) issue(issues, `${statementPath}.Principal`, "The public-read statement requires the public AWS principal");
  if (!exactSet(statement.Resource, [objectArn])) issue(issues, `${statementPath}.Resource`, "The public-read statement requires only the selected bucket object ARN");
}

function validateSupportedPolicy(bucket: unknown, value: unknown, context: ProviderContext | undefined, issues: ProviderValidationIssue[], allowCleanup = false): void {
  const path = "Properties.PolicyDocument";
  if (!isRecord(value)) return;
  exactKeys(value, ["Version", "Statement"], path, issues);
  if (value.Version !== "2012-10-17") issue(issues, `${path}.Version`, "Only IAM policy language version 2012-10-17 is supported");
  if (!Array.isArray(value.Statement) || ![1, 2, 3, ...(allowCleanup ? [4] : [])].includes(value.Statement.length)) {
    issue(issues, `${path}.Statement`, allowCleanup ? "Only the exact supported steady-state profiles or generated four-statement cleanup profile are allowed" : "Only the exact public-read, TLS/auto-delete, or TLS/auto-delete/CloudFront OAC profiles are allowed");
    return;
  }
  if (typeof bucket !== "string" || !bucket) return;
  const roles: PolicyRole[] = [];
  for (const [index, statement] of value.Statement.entries()) {
    const statementPath = `${path}.Statement.${index}`;
    if (!isRecord(statement)) {
      issue(issues, statementPath, "Each policy statement must be an object");
      continue;
    }
    const role = likelyRole(statement);
    roles.push(role);
    validateStatement(role, statement, statementPath, bucket, context, issues);
  }
  const roleSet = [...roles].sort();
  const profile = same(roleSet, ["public-read"])
    || same(roleSet, ["auto-delete"])
    || same(roleSet, ["auto-delete", "tls-deny"])
    || same(roleSet, ["auto-delete", "cloudfront-oac", "tls-deny"])
    || allowCleanup && same(roleSet, ["auto-delete", "cleanup-deny"])
    || allowCleanup && same(roleSet, ["auto-delete", "cleanup-deny", "tls-deny"])
    || allowCleanup && same(roleSet, ["auto-delete", "cleanup-deny", "cloudfront-oac", "tls-deny"]);
  if (!profile || new Set(roles).size !== roles.length) issue(issues, `${path}.Statement`, "The policy statements do not form one exact supported generated profile");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 20 * 1024) {
    issue(issues, path, "PolicyDocument must not exceed 20 KiB");
  }
}

function validatePolicyProperties(properties: unknown, context?: ProviderContext, allowCleanup = false): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, S3_BUCKET_POLICY_SCHEMA);
  if (!isRecord(properties)) return issues;
  if (typeof properties.Bucket !== "string" || !properties.Bucket) issue(issues, "Properties.Bucket", "Bucket must be a nonempty resolved bucket name");
  if (properties.PolicyDocument !== undefined) validateSupportedPolicy(properties.Bucket, properties.PolicyDocument, context, issues, allowCleanup);
  return issues;
}

function canonicalPolicy(properties: Record<string, unknown>): S3BucketPolicyModel {
  const policy = structuredClone(properties.PolicyDocument as unknown as PolicyDocument) as PolicyDocument & { Statement: unknown[] };
  policy.Statement = policy.Statement.map(raw => {
    const statement = stable(raw as Record<string, unknown>);
    if (Array.isArray(statement.Action)) statement.Action = [...statement.Action].sort();
    if (Array.isArray(statement.Resource)) statement.Resource = [...statement.Resource].sort();
    return statement;
  }).sort((left, right) => {
    const order: Record<PolicyRole, number> = { "tls-deny": 0, "auto-delete": 1, "cloudfront-oac": 2, "public-read": 3, "cleanup-deny": 4 };
    return order[likelyRole(left)] - order[likelyRole(right)];
  }) as any;
  return {
    Bucket: String(properties.Bucket),
    PolicyDocument: stable(policy),
  };
}

function success(model: S3BucketPolicyModel): ProviderSuccess<S3BucketPolicyModel> {
  return {
    status: "SUCCESS",
    physicalId: model.Bucket,
    model: { physicalId: model.Bucket, properties: model, attributes: {} },
  };
}

function failed(error: unknown): ProviderUpdateResult<S3BucketPolicyModel> {
  const aws = error instanceof AwsError
    ? error
    : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}

function notFound(error: unknown): boolean {
  return error instanceof AwsError && (error.code === "NoSuchBucket" || error.code === "NoSuchBucketPolicy");
}

export function createS3BucketPolicyProvider(s3: S3Service): ProductionResourceProvider<S3BucketPolicyModel> {
  const requireOwnedBucket = async (name: string, context: ProviderContext) => {
    const bucket = await s3.readBucketInternal(name);
    if (!bucket) return { failure: { status: "FAILED" as const, errorCode: "NoSuchBucket", message: `Bucket ${name} does not exist` } };
    const tags = (bucket as typeof bucket & { tags?: Record<string, string> }).tags ?? {};
    if (!isS3StackOwner(tags, context)) {
      return { failure: { status: "FAILED" as const, errorCode: "OwnershipConflict", message: `Bucket ${name} is not owned by this stack` } };
    }
    return { bucket };
  };

  const modelFromService = (bucket: string, document: unknown, context: ProviderContext, allowCleanup = false): S3BucketPolicyModel | undefined => {
    const properties = { Bucket: bucket, PolicyDocument: document };
    return validatePolicyProperties(properties, context, allowCleanup).length ? undefined : canonicalPolicy(properties);
  };

  return {
    typeName: S3_BUCKET_POLICY_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: S3_BUCKET_POLICY_SCHEMA,

    validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[] {
      return validatePolicyProperties(properties, context);
    },

    canonicalize(properties: unknown, context: ProviderContext): S3BucketPolicyModel {
      if (!isRecord(properties)) throw new TypeError(`${S3_BUCKET_POLICY_TYPE} Properties must be an object`);
      const issues = validatePolicyProperties(properties, context);
      if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return canonicalPolicy(properties);
    },

    plan(previous: S3BucketPolicyModel | undefined, desired: S3BucketPolicyModel): ProviderPlan<S3BucketPolicyModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: ["Bucket", "PolicyDocument"], replacementProperties: [] };
      const changed = (["Bucket", "PolicyDocument"] as const).filter(field => !same(previous[field], desired[field]));
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      if (changed.includes("Bucket")) {
        return { action: "REPLACE", desired, changedProperties: changed, replacementProperties: ["Bucket"], replacementOrder: "CREATE_BEFORE_DELETE" };
      }
      return { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
    },

    async create(desired: S3BucketPolicyModel, context: ProviderContext) {
      try {
        const ownership = await requireOwnedBucket(desired.Bucket, context);
        if (ownership.failure) return ownership.failure;
        const existing = await s3.readBucketPolicyInternal(desired.Bucket);
        if (existing !== undefined) {
          const current = modelFromService(desired.Bucket, existing, context);
          if (!current || !same(current.PolicyDocument, desired.PolicyDocument)) {
            return { status: "FAILED", errorCode: "AlreadyExists", message: `Bucket ${desired.Bucket} already has a different bucket policy` };
          }
          return success(desired);
        }
        await s3.putBucketPolicyInternal(desired.Bucket, desired.PolicyDocument);
        return success(desired);
      } catch (error) {
        return failed(error);
      }
    },

    async read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<S3BucketPolicyModel>> {
      try {
        const ownership = await requireOwnedBucket(physicalId, context);
        if (ownership.failure) return ownership.failure.errorCode === "NoSuchBucket" ? { status: "NOT_FOUND", physicalId } : ownership.failure;
        const document = await s3.readBucketPolicyInternal(physicalId);
        if (document === undefined) return { status: "NOT_FOUND", physicalId };
        const model = modelFromService(physicalId, document, context);
        if (!model) return { status: "FAILED", errorCode: "InvalidBucketPolicyState", message: `Bucket ${physicalId} has a policy outside the supported public-read contract` };
        return success(model);
      } catch (error) {
        return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderReadResult<S3BucketPolicyModel>;
      }
    },

    async update(physicalId: string, _previous: S3BucketPolicyModel, desired: S3BucketPolicyModel, context: ProviderContext): Promise<ProviderUpdateResult<S3BucketPolicyModel>> {
      if (physicalId !== desired.Bucket) {
        return { status: "FAILED", errorCode: "RequiresReplacement", message: "Bucket changes require replacement" };
      }
      try {
        const ownership = await requireOwnedBucket(physicalId, context);
        if (ownership.failure) return ownership.failure;
        const current = await s3.readBucketPolicyInternal(physicalId);
        if (current === undefined) {
          return { status: "FAILED", errorCode: "NoSuchBucketPolicy", message: `Bucket policy for ${physicalId} no longer exists` };
        }
        const currentModel = modelFromService(physicalId, current, context);
        if (!currentModel || !same(currentModel.PolicyDocument, _previous.PolicyDocument) && !same(currentModel.PolicyDocument, desired.PolicyDocument)) {
          return { status: "FAILED", errorCode: "ResourceConflict", message: `Bucket policy for ${physicalId} changed outside CloudFormation` };
        }
        if (same(currentModel.PolicyDocument, desired.PolicyDocument)) return success(desired);
        await s3.putBucketPolicyInternal(physicalId, desired.PolicyDocument);
        return success(desired);
      } catch (error) {
        return failed(error);
      }
    },

    async delete(physicalId: string, _previous: S3BucketPolicyModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      try {
        const ownership = await requireOwnedBucket(physicalId, context);
        if (ownership.failure) return ownership.failure.errorCode === "NoSuchBucket" ? { status: "NOT_FOUND", physicalId } : ownership.failure;
        const current = await s3.readBucketPolicyInternal(physicalId);
        if (current === undefined) return { status: "NOT_FOUND", physicalId };
        const currentModel = modelFromService(physicalId, current, context, true);
        const currentStatements = currentModel && Array.isArray(currentModel.PolicyDocument.Statement)
          ? currentModel.PolicyDocument.Statement.filter(statement => !isRecord(statement) || likelyRole(statement) !== "cleanup-deny")
          : undefined;
        const withoutCleanup = currentModel && currentStatements
          ? canonicalPolicy({ Bucket: physicalId, PolicyDocument: { ...currentModel.PolicyDocument, Statement: currentStatements } }).PolicyDocument
          : undefined;
        if (!withoutCleanup || !same(withoutCleanup, _previous.PolicyDocument)) {
          return { status: "FAILED", errorCode: "ResourceConflict", message: `Bucket policy for ${physicalId} changed outside CloudFormation` };
        }
        await s3.deleteBucketPolicyInternal(physicalId);
        return { status: "SUCCESS", physicalId };
      } catch (error) {
        return notFound(error) ? { status: "NOT_FOUND", physicalId } : failed(error) as ProviderDeleteResult;
      }
    },

    ref(model: ProviderReadModel<S3BucketPolicyModel>): unknown {
      return model.physicalId;
    },

    getAtt(_model: ProviderReadModel<S3BucketPolicyModel>, attribute: string): never {
      throw new ProviderReferenceError(S3_BUCKET_POLICY_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}
