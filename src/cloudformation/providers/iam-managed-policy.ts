import type { IamService } from "../../iam.js";
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
  OWNERSHIP_OPERATION_TAG,
  allLocalManagedPolicies,
  allPolicyVersions,
  canonicalPolicy,
  canonicalStrings,
  decodePolicy,
  generatedIamName,
  isIncompleteOperation,
  isMissing,
  isOwned,
  isoDate,
  issue,
  ownershipTags,
  providerFailure,
  same,
  validateDocument,
  validateName,
  validatePath,
  validateStringList,
  values,
} from "./iam-common.js";

export const IAM_MANAGED_POLICY_TYPE = "AWS::IAM::ManagedPolicy";

export interface IamManagedPolicyModel {
  readonly Description: string;
  readonly ManagedPolicyName: string;
  readonly Path: string;
  readonly PolicyDocument: PolicyDocument;
  readonly Roles: readonly string[];
}

export const IAM_MANAGED_POLICY_SCHEMA: ProviderSchema = Object.freeze({
  typeName: IAM_MANAGED_POLICY_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Description: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT", description: "IAM managed-policy descriptions are immutable." }),
    ManagedPolicyName: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    Path: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    PolicyDocument: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
    Roles: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE", description: "Direct role attachments only; Users and Groups are unsupported." }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "The managed policy ARN." }),
  attributes: Object.freeze({
    AttachmentCount: Object.freeze({ valueType: "number" }),
    CreateDate: Object.freeze({ valueType: "string" }),
    DefaultVersionId: Object.freeze({ valueType: "string" }),
    IsAttachable: Object.freeze({ valueType: "boolean" }),
    PermissionsBoundaryUsageCount: Object.freeze({ valueType: "number" }),
    PolicyArn: Object.freeze({ valueType: "string" }),
    PolicyId: Object.freeze({ valueType: "string" }),
    UpdateDate: Object.freeze({ valueType: "string" }),
  }),
  replacement: Object.freeze({ defaultOrder: "DELETE_BEFORE_CREATE", deleteBeforeCreateReason: "An immutable description replacement reuses the same account-global policy ARN." }),
  retention: Object.freeze({ deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const), updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const), snapshotSupported: false }),
  tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});

const PROPERTY_NAMES = Object.keys(IAM_MANAGED_POLICY_SCHEMA.properties).sort();

function validateManagedPolicy(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, IAM_MANAGED_POLICY_SCHEMA);
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return issues;
  const input = properties as Record<string, unknown>;
  if (typeof input.Description === "string" && input.Description.length > 1_000) issues.push(issue("InvalidProperty", "Properties.Description", "Properties.Description supports at most 1000 characters"));
  if (input.ManagedPolicyName !== undefined && typeof input.ManagedPolicyName === "string") validateName(input.ManagedPolicyName, "Properties.ManagedPolicyName", 128, issues);
  if (input.Path !== undefined && typeof input.Path === "string") validatePath(input.Path, "Properties.Path", issues);
  if (input.PolicyDocument && typeof input.PolicyDocument === "object" && !Array.isArray(input.PolicyDocument)) validateDocument(input.PolicyDocument, "Properties.PolicyDocument", issues);
  if (Array.isArray(input.Roles)) validateStringList(input.Roles, "Properties.Roles", 20, issues);
  return issues;
}

function canonicalizeManagedPolicy(properties: unknown, context: ProviderContext): IamManagedPolicyModel {
  const issues = validateManagedPolicy(properties);
  if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
  const input = properties as Record<string, unknown>;
  return Object.freeze({
    Description: String(input.Description ?? ""),
    ManagedPolicyName: String(input.ManagedPolicyName ?? generatedIamName(context, 128)),
    Path: String(input.Path ?? "/"),
    PolicyDocument: canonicalPolicy(input.PolicyDocument),
    Roles: Object.freeze(canonicalStrings(input.Roles)),
  });
}

function policyArn(model: Pick<IamManagedPolicyModel, "ManagedPolicyName" | "Path">, context: ProviderContext): string {
  return `arn:${context.partition}:iam::${context.accountId}:policy${model.Path}${model.ManagedPolicyName}`.replace("policy//", "policy/");
}

async function preflightRoles(iam: IamService, roles: readonly string[]): Promise<void> {
  for (const role of roles) await iam.GetRole({ RoleName: role });
}

async function defaultDocument(iam: IamService, arn: string, versionId: string): Promise<PolicyDocument> {
  return decodePolicy((await iam.GetPolicyVersion({ PolicyArn: arn, VersionId: versionId })).PolicyVersion.Document);
}

async function readManagedPolicy(iam: IamService, arn: string, context: ProviderContext): Promise<{ model: ProviderReadModel<IamManagedPolicyModel>; rawTags: unknown }> {
  const policy = (await iam.GetPolicy({ PolicyArn: arn })).Policy;
  const tags = (await iam.ListPolicyTags({ PolicyArn: arn })).Tags;
  if (!isOwned(tags, context)) throw new AwsError("OwnershipConflict", `IAM managed policy ${arn} is not owned by ${context.stackId}/${context.logicalId}`, 409);
  const entities = await iam.ListEntitiesForPolicy({ PolicyArn: arn });
  const properties: IamManagedPolicyModel = {
    Description: String(policy.Description ?? ""),
    ManagedPolicyName: String(policy.PolicyName),
    Path: String(policy.Path),
    PolicyDocument: await defaultDocument(iam, arn, String(policy.DefaultVersionId)),
    Roles: values<any>(entities.PolicyRoles).map(role => String(role.RoleName)).sort((left, right) => left.localeCompare(right)),
  };
  const attributes = {
    AttachmentCount: Number(policy.AttachmentCount),
    CreateDate: isoDate(policy.CreateDate),
    DefaultVersionId: String(policy.DefaultVersionId),
    IsAttachable: Boolean(policy.IsAttachable),
    PermissionsBoundaryUsageCount: Number(policy.PermissionsBoundaryUsageCount),
    PolicyArn: String(policy.Arn),
    PolicyId: String(policy.PolicyId),
    UpdateDate: isoDate(policy.UpdateDate),
  };
  return { model: { physicalId: arn, properties, attributes }, rawTags: tags };
}

async function successFor(iam: IamService, arn: string, desired: IamManagedPolicyModel, context: ProviderContext): Promise<ProviderSuccess<IamManagedPolicyModel>> {
  const read = await readManagedPolicy(iam, arn, context);
  return { status: "SUCCESS", physicalId: arn, model: { ...read.model, properties: desired } };
}

async function reconcileDocument(iam: IamService, arn: string, current: PolicyDocument, desired: PolicyDocument): Promise<void> {
  if (!same(current, desired)) await iam.CreatePolicyVersion({ PolicyArn: arn, PolicyDocument: desired, SetAsDefault: true });
  for (const version of await allPolicyVersions(iam, arn)) if (!version.IsDefaultVersion) await iam.DeletePolicyVersion({ PolicyArn: arn, VersionId: version.VersionId });
}

async function reconcileAttachments(iam: IamService, arn: string, previous: readonly string[], desired: readonly string[]): Promise<void> {
  await preflightRoles(iam, desired);
  const entities = await iam.ListEntitiesForPolicy({ PolicyArn: arn });
  const attached = new Set(values<any>(entities.PolicyRoles).map(role => String(role.RoleName)));
  for (const role of desired) if (!attached.has(role)) await iam.AttachRolePolicy({ RoleName: role, PolicyArn: arn });
  for (const role of previous) if (!desired.includes(role) && attached.has(role)) await iam.DetachRolePolicy({ RoleName: role, PolicyArn: arn });
}

export function createIamManagedPolicyProvider(iam: IamService): ProductionResourceProvider<IamManagedPolicyModel> {
  return {
    typeName: IAM_MANAGED_POLICY_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: IAM_MANAGED_POLICY_SCHEMA,
    validate(properties) { return validateManagedPolicy(properties); },
    canonicalize(properties, context) { return canonicalizeManagedPolicy(properties, context); },
    plan(previous, desired): ProviderPlan<IamManagedPolicyModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: PROPERTY_NAMES, replacementProperties: [] };
      const changed = PROPERTY_NAMES.filter(name => !same((previous as any)[name], (desired as any)[name]));
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      const replacement = changed.filter(name => ["Description", "ManagedPolicyName", "Path"].includes(name));
      if (!replacement.length) return { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
      const sameArn = previous.ManagedPolicyName === desired.ManagedPolicyName && previous.Path === desired.Path;
      return { action: "REPLACE", desired, changedProperties: changed, replacementProperties: replacement, replacementOrder: sameArn ? "DELETE_BEFORE_CREATE" : "CREATE_BEFORE_DELETE", reason: sameArn ? "Managed policy immutable description changed while retaining its ARN" : "Managed policy name or path changed" };
    },
    async create(desired, context) {
      const arn = policyArn(desired, context);
      try {
        await preflightRoles(iam, desired.Roles);
        const caseCollision = (await allLocalManagedPolicies(iam)).find(policy => String(policy.Arn).toLowerCase() === arn.toLowerCase() && String(policy.Arn) !== arn);
        if (caseCollision) return { status: "FAILED", errorCode: "EntityAlreadyExists", message: `IAM managed policy ${String(caseCollision.Arn)} already occupies case-insensitive identity ${arn}` };
        try {
          const existing = await readManagedPolicy(iam, arn, context);
          if (isIncompleteOperation(existing.rawTags, context)) {
            if (existing.model.properties.Description !== desired.Description || existing.model.properties.ManagedPolicyName !== desired.ManagedPolicyName || existing.model.properties.Path !== desired.Path || !same(existing.model.properties.PolicyDocument, desired.PolicyDocument)) throw new AwsError("ResourceConflict", `Incomplete IAM managed policy ${arn} has conflicting immutable properties or document`, 409);
            const unexpected = existing.model.properties.Roles.filter(role => !desired.Roles.includes(role));
            if (unexpected.length) throw new AwsError("ResourceConflict", `Incomplete IAM managed policy ${arn} has unexpected role attachments`, 409);
            await reconcileAttachments(iam, arn, existing.model.properties.Roles, desired.Roles);
            await iam.UntagPolicy({ PolicyArn: arn, TagKeys: [OWNERSHIP_OPERATION_TAG] });
            return successFor(iam, arn, desired, context);
          }
          if (same(existing.model.properties, desired)) return successFor(iam, arn, desired, context);
          return { status: "FAILED", errorCode: "EntityAlreadyExists", message: `IAM managed policy ${arn} already exists for this stack resource with different properties` };
        } catch (error) {
          if (!isMissing(error)) {
            if (error instanceof AwsError && error.code === "OwnershipConflict") return { status: "FAILED", errorCode: "EntityAlreadyExists", message: `IAM managed policy ${arn} already exists and is not owned by this stack resource` };
            throw error;
          }
        }
        await iam.CreatePolicy({ PolicyName: desired.ManagedPolicyName, Path: desired.Path, Description: desired.Description, PolicyDocument: desired.PolicyDocument, Tags: ownershipTags(context, true) });
        try {
          for (const role of desired.Roles) await iam.AttachRolePolicy({ RoleName: role, PolicyArn: arn });
          await iam.UntagPolicy({ PolicyArn: arn, TagKeys: [OWNERSHIP_OPERATION_TAG] });
        } catch (error) {
          try { for (const role of desired.Roles) await iam.DetachRolePolicy({ RoleName: role, PolicyArn: arn }); } catch {}
          try { await iam.DeletePolicy({ PolicyArn: arn }); } catch {}
          throw error;
        }
        return successFor(iam, arn, desired, context);
      } catch (error) { return providerFailure(error); }
    },
    async read(physicalId, context): Promise<ProviderReadResult<IamManagedPolicyModel>> {
      try { const result = await readManagedPolicy(iam, physicalId, context); return { status: "SUCCESS", physicalId, model: result.model }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<IamManagedPolicyModel>> {
      try {
        if (physicalId !== policyArn(desired, context) || previous.Description !== desired.Description || previous.ManagedPolicyName !== desired.ManagedPolicyName || previous.Path !== desired.Path) throw new AwsError("RequiresReplacement", "Managed policy name, path, and description changes require replacement", 409);
        const current = await readManagedPolicy(iam, physicalId, context);
        if (!same(current.model.properties.PolicyDocument, previous.PolicyDocument) && !same(current.model.properties.PolicyDocument, desired.PolicyDocument)) throw new AwsError("ResourceConflict", `Managed policy ${physicalId} document changed outside CloudFormation`, 409);
        await preflightRoles(iam, desired.Roles);
        await reconcileDocument(iam, physicalId, current.model.properties.PolicyDocument, desired.PolicyDocument);
        await reconcileAttachments(iam, physicalId, previous.Roles, desired.Roles);
        return successFor(iam, physicalId, desired, context);
      } catch (error) { return providerFailure(error); }
    },
    async delete(physicalId, previous, context): Promise<ProviderDeleteResult> {
      try {
        const current = await readManagedPolicy(iam, physicalId, context);
        if (!same(current.model.properties.PolicyDocument, previous.PolicyDocument)) throw new AwsError("ResourceConflict", `Managed policy ${physicalId} document changed outside CloudFormation`, 409);
        const attached = new Set(current.model.properties.Roles);
        for (const role of previous.Roles) if (attached.has(role)) await iam.DetachRolePolicy({ RoleName: role, PolicyArn: physicalId });
        await iam.DeletePolicy({ PolicyArn: physicalId });
        return { status: "SUCCESS", physicalId };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    ref(model: ProviderReadModel<IamManagedPolicyModel>) { return model.physicalId; },
    getAtt(model: ProviderReadModel<IamManagedPolicyModel>, attribute: string) {
      if (!Object.hasOwn(IAM_MANAGED_POLICY_SCHEMA.attributes, attribute)) throw new ProviderReferenceError(IAM_MANAGED_POLICY_TYPE, `Fn::GetAtt ${attribute}`);
      return model.attributes[attribute];
    },
  };
}
