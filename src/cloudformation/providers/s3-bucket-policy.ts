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

function validatePublicReadPolicy(bucket: unknown, value: unknown, issues: ProviderValidationIssue[]): void {
  const path = "Properties.PolicyDocument";
  if (!isRecord(value)) return;
  exactKeys(value, ["Version", "Statement"], path, issues);
  if (value.Version !== "2012-10-17") issue(issues, `${path}.Version`, "Only IAM policy language version 2012-10-17 is supported");
  if (!Array.isArray(value.Statement) || ![1, 2].includes(value.Statement.length)) {
    issue(issues, `${path}.Statement`, "Exactly one supported access statement, or the frozen TLS-deny plus auto-delete pair, is required");
    return;
  }
  const statements = value.Statement;
  const secureTransport = statements.length === 2 ? statements[0] : undefined;
  if (secureTransport !== undefined) {
    const statementPath = `${path}.Statement.0`;
    if (!isRecord(secureTransport)) issue(issues, statementPath, "The TLS-only statement must be an object");
    else {
      exactKeys(secureTransport, ["Action", "Condition", "Effect", "Principal", "Resource"], statementPath, issues);
      if (secureTransport.Action !== "s3:*") issue(issues, `${statementPath}.Action`, "The frozen TLS-only statement requires s3:*");
      if (secureTransport.Effect !== "Deny") issue(issues, `${statementPath}.Effect`, "The frozen TLS-only statement must deny insecure transport");
      if (JSON.stringify(secureTransport.Principal) !== JSON.stringify({ AWS: "*" })) issue(issues, `${statementPath}.Principal`, "The frozen TLS-only statement requires the public AWS principal");
      if (JSON.stringify(secureTransport.Condition) !== JSON.stringify({ Bool: { "aws:SecureTransport": "false" } })) issue(issues, `${statementPath}.Condition`, "The frozen TLS-only statement requires aws:SecureTransport=false");
      const bucketArn = typeof bucket === "string" ? `arn:aws:s3:::${bucket}` : undefined;
      if (JSON.stringify(secureTransport.Resource) !== JSON.stringify([bucketArn, `${bucketArn}/*`])) issue(issues, `${statementPath}.Resource`, "The TLS-only Resource must be the selected bucket ARN and object ARN");
    }
  }
  const statementIndex = statements.length - 1;
  const statementPath = `${path}.Statement.${statementIndex}`;
  const statement = statements[statementIndex];
  if (!isRecord(statement)) {
    issue(issues, statementPath, "The public-read statement must be an object");
    return;
  }
  exactKeys(statement, ["Action", "Effect", "Principal", "Resource"], statementPath, issues);
  if (statement.Effect !== "Allow") issue(issues, `${statementPath}.Effect`, "Only an Allow statement is supported");
  const autoDeleteActions = ["s3:PutBucketPolicy", "s3:GetBucket*", "s3:List*", "s3:DeleteObject*"];
  const autoDelete = JSON.stringify(statement.Action) === JSON.stringify(autoDeleteActions);
  if (statement.Action !== "s3:GetObject" && !autoDelete) issue(issues, `${statementPath}.Action`, "Only the public-read action or exact generated auto-delete action set is supported");
  if (!isRecord(statement.Principal)) {
    issue(issues, `${statementPath}.Principal`, "Principal must be the exact public AWS principal object");
  } else {
    exactKeys(statement.Principal, ["AWS"], `${statementPath}.Principal`, issues);
    if (autoDelete) {
      if (typeof statement.Principal.AWS !== "string" || !/^arn:aws:iam::\d{12}:role\/(?:[A-Za-z0-9+=,.@_-]*CustomS3AutoDelete[A-Za-z0-9+=,.@_-]*|amplify-stacksimamplifygen2datafixture-[A-Za-z0-9-]+-[a-f0-9]{12})$/.test(statement.Principal.AWS)) issue(issues, `${statementPath}.Principal.AWS`, "The auto-delete policy principal must be the generated provider role ARN");
    } else if (statement.Principal.AWS !== "*") issue(issues, `${statementPath}.Principal.AWS`, "Only the public AWS principal '*' is supported");
  }
  const bucketArn = typeof bucket === "string" ? `arn:aws:s3:::${bucket}` : undefined;
  const wantedResource = autoDelete ? [bucketArn, `${bucketArn}/*`] : `${bucketArn}/*`;
  if (JSON.stringify(statement.Resource) !== JSON.stringify(wantedResource)) {
    issue(issues, `${statementPath}.Resource`, autoDelete ? "Auto-delete Resource must be the selected bucket ARN and object ARN" : "Resource must be the selected bucket's complete object ARN (<bucket-arn>/*)");
  }
  if (secureTransport !== undefined && !autoDelete) issue(issues, `${statementPath}.Action`, "The TLS-only pair is admitted only with the exact generated auto-delete grant");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 20 * 1024) {
    issue(issues, path, "PolicyDocument must not exceed 20 KiB");
  }
}

function validatePolicyProperties(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, S3_BUCKET_POLICY_SCHEMA);
  if (!isRecord(properties)) return issues;
  if (typeof properties.Bucket !== "string" || !properties.Bucket) issue(issues, "Properties.Bucket", "Bucket must be a nonempty resolved bucket name");
  if (properties.PolicyDocument !== undefined) validatePublicReadPolicy(properties.Bucket, properties.PolicyDocument, issues);
  return issues;
}

function canonicalPolicy(properties: Record<string, unknown>): S3BucketPolicyModel {
  return {
    Bucket: String(properties.Bucket),
    PolicyDocument: stable(structuredClone(properties.PolicyDocument as unknown as PolicyDocument)),
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

function generatedAutoDeleteCleanupPolicy(previous: PolicyDocument, bucket: string): PolicyDocument {
  const document = structuredClone(previous) as PolicyDocument & { Statement: unknown | unknown[] };
  const statements = Array.isArray(document.Statement) ? document.Statement : [document.Statement];
  statements.push({ Principal: "*", Effect: "Deny", Action: ["s3:PutObject"], Resource: [`arn:aws:s3:::${bucket}/*`] });
  document.Statement = statements as any;
  return document;
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

  const modelFromService = (bucket: string, document: unknown): S3BucketPolicyModel | undefined => {
    const properties = { Bucket: bucket, PolicyDocument: document };
    return validatePolicyProperties(properties).length ? undefined : canonicalPolicy(properties);
  };

  return {
    typeName: S3_BUCKET_POLICY_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: S3_BUCKET_POLICY_SCHEMA,

    validate(properties: unknown): readonly ProviderValidationIssue[] {
      return validatePolicyProperties(properties);
    },

    canonicalize(properties: unknown): S3BucketPolicyModel {
      if (!isRecord(properties)) throw new TypeError(`${S3_BUCKET_POLICY_TYPE} Properties must be an object`);
      const issues = validatePolicyProperties(properties);
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
          if (!same(existing, desired.PolicyDocument)) {
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
        const model = modelFromService(physicalId, document);
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
        if (!same(current, _previous.PolicyDocument) && !same(current, desired.PolicyDocument)) {
          return { status: "FAILED", errorCode: "ResourceConflict", message: `Bucket policy for ${physicalId} changed outside CloudFormation` };
        }
        if (same(current, desired.PolicyDocument)) return success(desired);
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
        if (!same(current, _previous.PolicyDocument) && !same(current, generatedAutoDeleteCleanupPolicy(_previous.PolicyDocument, physicalId))) {
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
