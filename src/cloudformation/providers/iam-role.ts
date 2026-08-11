import type { IamService } from "../../iam.js";
import type { PolicyDocument } from "../../types.js";
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
  allAttachedPolicyArns,
  allRolePolicyNames,
  allRoles,
  canonicalInlinePolicies,
  canonicalPolicy,
  canonicalStrings,
  canonicalTags,
  decodePolicy,
  decodeTrust,
  generatedIamName,
  isIncompleteOperation,
  isMissing,
  isOwned,
  issue,
  ownershipTags,
  providerFailure,
  same,
  tagMap,
  userTags,
  validateDocument,
  validateInlinePolicies,
  validateName,
  validatePath,
  validateTags,
  values,
  type IamInlinePolicyModel,
  type IamTagModel,
} from "./iam-common.js";
import { AwsError } from "../../errors.js";

export const IAM_ROLE_TYPE = "AWS::IAM::Role";

export interface IamRoleModel {
  readonly AssumeRolePolicyDocument: PolicyDocument;
  readonly Description: string;
  readonly ManagedPolicyArns: readonly string[];
  readonly MaxSessionDuration: number;
  readonly Path: string;
  readonly Policies: readonly IamInlinePolicyModel[];
  readonly RoleName: string;
  readonly Tags: readonly IamTagModel[];
}

export const IAM_ROLE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: IAM_ROLE_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    AssumeRolePolicyDocument: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE", description: "IAM trust policy backed by UpdateAssumeRolePolicy." }),
    Description: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    ManagedPolicyArns: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE", description: "Existing local managed policies attached through IAM." }),
    MaxSessionDuration: Object.freeze({ valueType: "number", updateBehavior: "MUTABLE" }),
    Path: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    Policies: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE", description: "Up to ten role inline policies." }),
    RoleName: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "The IAM role name." }),
  attributes: Object.freeze({ Arn: Object.freeze({ valueType: "string" }), RoleId: Object.freeze({ valueType: "string" }) }),
  replacement: Object.freeze({ defaultOrder: "DELETE_BEFORE_CREATE", deleteBeforeCreateReason: "IAM role names are account-global; a path-only replacement cannot create the same name twice." }),
  retention: Object.freeze({ deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const), updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const), snapshotSupported: false }),
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

const PROPERTY_NAMES = Object.keys(IAM_ROLE_SCHEMA.properties).sort();

function validateRole(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, IAM_ROLE_SCHEMA);
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return issues;
  const input = properties as Record<string, unknown>;
  if (input.AssumeRolePolicyDocument && typeof input.AssumeRolePolicyDocument === "object" && !Array.isArray(input.AssumeRolePolicyDocument)) validateDocument(input.AssumeRolePolicyDocument, "Properties.AssumeRolePolicyDocument", issues, "trust");
  if (typeof input.Description === "string" && input.Description.length > 1_000) issues.push(issue("InvalidProperty", "Properties.Description", "Properties.Description supports at most 1000 characters"));
  if (input.RoleName !== undefined && typeof input.RoleName === "string") validateName(input.RoleName, "Properties.RoleName", 64, issues);
  if (input.Path !== undefined && typeof input.Path === "string") validatePath(input.Path, "Properties.Path", issues);
  if (typeof input.MaxSessionDuration === "number" && (!Number.isInteger(input.MaxSessionDuration) || input.MaxSessionDuration < 3600 || input.MaxSessionDuration > 43_200)) issues.push(issue("InvalidProperty", "Properties.MaxSessionDuration", "Properties.MaxSessionDuration must be an integer between 3600 and 43200"));
  if (Array.isArray(input.ManagedPolicyArns)) {
    if (input.ManagedPolicyArns.length > 10) issues.push(issue("InvalidProperty", "Properties.ManagedPolicyArns", "Properties.ManagedPolicyArns supports at most 10 policies"));
    const seen = new Set<string>();
    input.ManagedPolicyArns.forEach((arn, index) => {
      if (typeof arn !== "string" || !/^arn:[a-z0-9-]+:iam::(?:\d{12}|aws):policy\/.+$/i.test(arn)) issues.push(issue("InvalidProperty", `Properties.ManagedPolicyArns[${index}]`, "Managed policy ARN is invalid"));
      else if (seen.has(arn)) issues.push(issue("InvalidProperty", `Properties.ManagedPolicyArns[${index}]`, `Duplicate managed policy ARN ${arn}`));
      else seen.add(arn);
    });
  }
  if (Array.isArray(input.Policies)) validateInlinePolicies(input.Policies, "Properties.Policies", issues);
  if (Array.isArray(input.Tags)) validateTags(input.Tags, "Properties.Tags", 47, issues);
  return issues;
}

function canonicalizeRole(properties: unknown, context: ProviderContext): IamRoleModel {
  const issues = validateRole(properties);
  if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
  const input = properties as Record<string, unknown>;
  return Object.freeze({
    AssumeRolePolicyDocument: canonicalPolicy(input.AssumeRolePolicyDocument, "trust"),
    Description: String(input.Description ?? ""),
    ManagedPolicyArns: Object.freeze(canonicalStrings(input.ManagedPolicyArns)),
    MaxSessionDuration: Number(input.MaxSessionDuration ?? 3600),
    Path: String(input.Path ?? "/"),
    Policies: Object.freeze(canonicalInlinePolicies(input.Policies)),
    RoleName: String(input.RoleName ?? generatedIamName(context, 64)),
    Tags: Object.freeze(canonicalTags(input.Tags)),
  });
}

async function preflightManagedPolicies(iam: IamService, arns: readonly string[]): Promise<void> {
  for (const arn of arns) await iam.GetPolicy({ PolicyArn: arn });
}

async function readRole(iam: IamService, roleName: string, context: ProviderContext): Promise<{ model: ProviderReadModel<IamRoleModel>; rawTags: unknown }> {
  const response = await iam.GetRole({ RoleName: roleName }); const role = response.Role;
  if (!isOwned(role.Tags, context)) throw new AwsError("OwnershipConflict", `IAM role ${roleName} is not owned by ${context.stackId}/${context.logicalId}`, 409);
  const inline: IamInlinePolicyModel[] = [];
  for (const policyName of await allRolePolicyNames(iam, roleName)) {
    const policy = await iam.GetRolePolicy({ RoleName: roleName, PolicyName: policyName });
    inline.push({ PolicyName: policyName, PolicyDocument: decodePolicy(policy.PolicyDocument) });
  }
  const properties: IamRoleModel = {
    AssumeRolePolicyDocument: decodeTrust(role.AssumeRolePolicyDocument),
    Description: String(role.Description ?? ""),
    ManagedPolicyArns: await allAttachedPolicyArns(iam, roleName),
    MaxSessionDuration: Number(role.MaxSessionDuration),
    Path: String(role.Path),
    Policies: inline.sort((left, right) => left.PolicyName.localeCompare(right.PolicyName)),
    RoleName: String(role.RoleName),
    Tags: userTags(role.Tags),
  };
  return { model: { physicalId: roleName, properties, attributes: { Arn: String(role.Arn), RoleId: String(role.RoleId) } }, rawTags: role.Tags };
}

async function successFor(iam: IamService, roleName: string, desired: IamRoleModel): Promise<ProviderSuccess<IamRoleModel>> {
  const role = (await iam.GetRole({ RoleName: roleName })).Role;
  return { status: "SUCCESS", physicalId: roleName, model: { physicalId: roleName, properties: desired, attributes: { Arn: String(role.Arn), RoleId: String(role.RoleId) } } };
}

function policyMap(policies: readonly IamInlinePolicyModel[]): Map<string, PolicyDocument> {
  return new Map(policies.map(policy => [policy.PolicyName, policy.PolicyDocument]));
}

async function updateRole(iam: IamService, roleName: string, previous: IamRoleModel, desired: IamRoleModel, context: ProviderContext): Promise<void> {
  const current = await readRole(iam, roleName, context);
  if (desired.RoleName !== roleName || desired.Path !== previous.Path || desired.RoleName !== previous.RoleName) throw new AwsError("RequiresReplacement", "RoleName and Path changes require replacement", 409);
  await preflightManagedPolicies(iam, desired.ManagedPolicyArns);
  const currentInline = policyMap(current.model.properties.Policies);
  const beforePolicies = policyMap(previous.Policies); const afterPolicies = policyMap(desired.Policies);
  for (const [name, document] of currentInline) {
    const before = beforePolicies.get(name); const after = afterPolicies.get(name);
    if (before && !same(document, before) && (!after || !same(document, after))) throw new AwsError("ResourceConflict", `Inline policy ${name} on role ${roleName} changed outside CloudFormation`, 409);
    if (!before && after && !same(document, after)) throw new AwsError("EntityAlreadyExists", `Role ${roleName} already has inline policy ${name} outside this role resource`, 409);
  }

  const currentAttached = new Set(current.model.properties.ManagedPolicyArns);
  for (const arn of desired.ManagedPolicyArns) if (!currentAttached.has(arn)) await iam.AttachRolePolicy({ RoleName: roleName, PolicyArn: arn });
  for (const arn of previous.ManagedPolicyArns) if (!desired.ManagedPolicyArns.includes(arn) && currentAttached.has(arn)) await iam.DetachRolePolicy({ RoleName: roleName, PolicyArn: arn });

  for (const [name, document] of afterPolicies) if (!same(currentInline.get(name), document)) await iam.PutRolePolicy({ RoleName: roleName, PolicyName: name, PolicyDocument: document });
  for (const name of beforePolicies.keys()) if (!afterPolicies.has(name) && currentInline.has(name)) await iam.DeleteRolePolicy({ RoleName: roleName, PolicyName: name });

  if (!same(previous.AssumeRolePolicyDocument, desired.AssumeRolePolicyDocument)) await iam.UpdateAssumeRolePolicy({ RoleName: roleName, PolicyDocument: desired.AssumeRolePolicyDocument });
  if (previous.Description !== desired.Description || previous.MaxSessionDuration !== desired.MaxSessionDuration) await iam.UpdateRole({ RoleName: roleName, Description: desired.Description, MaxSessionDuration: desired.MaxSessionDuration });

  const beforeTags = new Map(previous.Tags.map(tag => [tag.Key, tag.Value])); const afterTags = new Map(desired.Tags.map(tag => [tag.Key, tag.Value]));
  const removed = [...beforeTags.keys()].filter(key => !afterTags.has(key));
  if (removed.length) await iam.UntagRole({ RoleName: roleName, TagKeys: removed });
  await iam.TagRole({ RoleName: roleName, Tags: [...desired.Tags, ...ownershipTags(context)] });
}

async function reconcileIncompleteRole(iam: IamService, desired: IamRoleModel, context: ProviderContext): Promise<void> {
  const current = await readRole(iam, desired.RoleName, context);
  const properties = current.model.properties;
  const unexpectedManaged = properties.ManagedPolicyArns.filter(arn => !desired.ManagedPolicyArns.includes(arn));
  const desiredInlineNames = new Set(desired.Policies.map(policy => policy.PolicyName));
  const unexpectedInline = properties.Policies.filter(policy => !desiredInlineNames.has(policy.PolicyName));
  if (unexpectedManaged.length || unexpectedInline.length) throw new AwsError("ResourceConflict", `Incomplete IAM role ${desired.RoleName} contains policies outside the accepted create operation`, 409);
  await preflightManagedPolicies(iam, desired.ManagedPolicyArns);
  for (const arn of desired.ManagedPolicyArns) if (!properties.ManagedPolicyArns.includes(arn)) await iam.AttachRolePolicy({ RoleName: desired.RoleName, PolicyArn: arn });
  for (const policy of desired.Policies) {
    const existing = properties.Policies.find(candidate => candidate.PolicyName === policy.PolicyName);
    if (existing && !same(existing.PolicyDocument, policy.PolicyDocument)) throw new AwsError("ResourceConflict", `Incomplete IAM role ${desired.RoleName} has a conflicting inline policy ${policy.PolicyName}`, 409);
    if (!existing) await iam.PutRolePolicy({ RoleName: desired.RoleName, PolicyName: policy.PolicyName, PolicyDocument: policy.PolicyDocument });
  }
  await iam.UpdateAssumeRolePolicy({ RoleName: desired.RoleName, PolicyDocument: desired.AssumeRolePolicyDocument });
  await iam.UpdateRole({ RoleName: desired.RoleName, Description: desired.Description, MaxSessionDuration: desired.MaxSessionDuration });
  const currentUserTags = userTags(current.rawTags); const desiredKeys = new Set(desired.Tags.map(tag => tag.Key)); const removed = currentUserTags.filter(tag => !desiredKeys.has(tag.Key)).map(tag => tag.Key);
  if (removed.length) await iam.UntagRole({ RoleName: desired.RoleName, TagKeys: removed });
  await iam.TagRole({ RoleName: desired.RoleName, Tags: [...desired.Tags, ...ownershipTags(context)] });
  await iam.UntagRole({ RoleName: desired.RoleName, TagKeys: [OWNERSHIP_OPERATION_TAG] });
}

export function createIamRoleProvider(iam: IamService): ProductionResourceProvider<IamRoleModel> {
  return {
    typeName: IAM_ROLE_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: IAM_ROLE_SCHEMA,
    validate(properties) { return validateRole(properties); },
    canonicalize(properties, context) { return canonicalizeRole(properties, context); },
    plan(previous, desired): ProviderPlan<IamRoleModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: PROPERTY_NAMES.filter(name => Object.hasOwn(desired, name)), replacementProperties: [] };
      const changed = PROPERTY_NAMES.filter(name => !same((previous as any)[name], (desired as any)[name]));
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      const replacement = changed.filter(name => name === "RoleName" || name === "Path");
      if (!replacement.length) return { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
      const sameName = previous.RoleName === desired.RoleName;
      return { action: "REPLACE", desired, changedProperties: changed, replacementProperties: replacement, replacementOrder: sameName ? "DELETE_BEFORE_CREATE" : "CREATE_BEFORE_DELETE", reason: sameName ? "IAM role path replacement reuses an account-global role name" : "IAM role name or path changed" };
    },
    async create(desired, context) {
      try {
        await preflightManagedPolicies(iam, desired.ManagedPolicyArns);
        const caseCollision = (await allRoles(iam)).find(role => String(role.RoleName).toLowerCase() === desired.RoleName.toLowerCase() && String(role.RoleName) !== desired.RoleName);
        if (caseCollision) return { status: "FAILED", errorCode: "EntityAlreadyExists", message: `IAM role ${String(caseCollision.RoleName)} already occupies case-insensitive name ${desired.RoleName}` };
        try {
          const existing = await readRole(iam, desired.RoleName, context);
          if (isIncompleteOperation(existing.rawTags, context)) {
            await reconcileIncompleteRole(iam, desired, context);
            return successFor(iam, desired.RoleName, desired);
          }
          if (same(existing.model.properties, desired)) return successFor(iam, desired.RoleName, desired);
          return { status: "FAILED", errorCode: "EntityAlreadyExists", message: `IAM role ${desired.RoleName} already exists for this stack resource with different properties` };
        } catch (error) {
          if (!isMissing(error)) {
            if (error instanceof AwsError && error.code === "OwnershipConflict") return { status: "FAILED", errorCode: "EntityAlreadyExists", message: `IAM role ${desired.RoleName} already exists and is not owned by this stack resource` };
            throw error;
          }
        }
        await iam.CreateRole({ RoleName: desired.RoleName, Path: desired.Path, Description: desired.Description, MaxSessionDuration: desired.MaxSessionDuration, AssumeRolePolicyDocument: desired.AssumeRolePolicyDocument, Tags: [...desired.Tags, ...ownershipTags(context, true)] });
        try {
          for (const arn of desired.ManagedPolicyArns) await iam.AttachRolePolicy({ RoleName: desired.RoleName, PolicyArn: arn });
          for (const policy of desired.Policies) await iam.PutRolePolicy({ RoleName: desired.RoleName, PolicyName: policy.PolicyName, PolicyDocument: policy.PolicyDocument });
          await iam.UntagRole({ RoleName: desired.RoleName, TagKeys: [OWNERSHIP_OPERATION_TAG] });
        } catch (error) {
          // Best-effort cleanup leaves the operation marker in place whenever
          // the complete rollback cannot finish, allowing the stable retry to reconcile.
          try { for (const policy of desired.Policies) await iam.DeleteRolePolicy({ RoleName: desired.RoleName, PolicyName: policy.PolicyName }); } catch {}
          try { for (const arn of desired.ManagedPolicyArns) await iam.DetachRolePolicy({ RoleName: desired.RoleName, PolicyArn: arn }); } catch {}
          try { await iam.DeleteRole({ RoleName: desired.RoleName }); } catch {}
          throw error;
        }
        return successFor(iam, desired.RoleName, desired);
      } catch (error) { return providerFailure(error); }
    },
    async read(physicalId, context): Promise<ProviderReadResult<IamRoleModel>> {
      try { const result = await readRole(iam, physicalId, context); return { status: "SUCCESS", physicalId, model: result.model }; }
      catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    async update(physicalId, previous, desired, context): Promise<ProviderUpdateResult<IamRoleModel>> {
      try { await updateRole(iam, physicalId, previous, desired, context); return successFor(iam, physicalId, desired); }
      catch (error) { return providerFailure(error); }
    },
    async delete(physicalId, previous, context): Promise<ProviderDeleteResult> {
      try {
        const current = await readRole(iam, physicalId, context);
        const currentInline = policyMap(current.model.properties.Policies);
        for (const policy of previous.Policies) {
          const document = currentInline.get(policy.PolicyName);
          if (document && !same(document, policy.PolicyDocument)) throw new AwsError("ResourceConflict", `Inline policy ${policy.PolicyName} on role ${physicalId} changed outside CloudFormation`, 409);
        }
        for (const policy of previous.Policies) if (currentInline.has(policy.PolicyName)) await iam.DeleteRolePolicy({ RoleName: physicalId, PolicyName: policy.PolicyName });
        const attached = new Set(current.model.properties.ManagedPolicyArns);
        for (const arn of previous.ManagedPolicyArns) if (attached.has(arn)) await iam.DetachRolePolicy({ RoleName: physicalId, PolicyArn: arn });
        await iam.DeleteRole({ RoleName: physicalId });
        return { status: "SUCCESS", physicalId };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    ref(model: ProviderReadModel<IamRoleModel>) { return model.physicalId; },
    getAtt(model: ProviderReadModel<IamRoleModel>, attribute: string) {
      if (!Object.hasOwn(IAM_ROLE_SCHEMA.attributes, attribute)) throw new ProviderReferenceError(IAM_ROLE_TYPE, `Fn::GetAtt ${attribute}`);
      return model.attributes[attribute];
    },
  };
}
