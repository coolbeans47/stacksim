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
  allRolePolicyNames,
  allRoles,
  canonicalPolicy,
  canonicalStrings,
  decodePolicy,
  isMissing,
  providerFailure,
  same,
  validateDocument,
  validateName,
  validateStringList,
} from "./iam-common.js";

export const IAM_POLICY_TYPE = "AWS::IAM::Policy";

export interface IamPolicyModel {
  readonly PolicyDocument: PolicyDocument;
  readonly PolicyName: string;
  readonly Roles: readonly string[];
}

export const IAM_POLICY_SCHEMA: ProviderSchema = Object.freeze({
  typeName: IAM_POLICY_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    PolicyDocument: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
    PolicyName: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE", description: "Changing the inline policy name is applied as put-new then delete-old." }),
    Roles: Object.freeze({ valueType: "array", required: true, updateBehavior: "MUTABLE", description: "At least one directly backed IAM role is required; Users and Groups are unsupported." }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "The inline policy name." }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: Object.freeze({ deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const), updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const), snapshotSupported: false }),
  tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});

const PROPERTY_NAMES = Object.keys(IAM_POLICY_SCHEMA.properties).sort();

function validatePolicyProperties(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties, IAM_POLICY_SCHEMA);
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return issues;
  const input = properties as Record<string, unknown>;
  if (input.PolicyName !== undefined && typeof input.PolicyName === "string") validateName(input.PolicyName, "Properties.PolicyName", 128, issues);
  if (input.PolicyDocument && typeof input.PolicyDocument === "object" && !Array.isArray(input.PolicyDocument)) validateDocument(input.PolicyDocument, "Properties.PolicyDocument", issues);
  if (Array.isArray(input.Roles)) validateStringList(input.Roles, "Properties.Roles", 10, issues, true);
  return issues;
}

function canonicalizePolicy(properties: unknown): IamPolicyModel {
  const issues = validatePolicyProperties(properties);
  if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
  const input = properties as Record<string, unknown>;
  return Object.freeze({ PolicyDocument: canonicalPolicy(input.PolicyDocument), PolicyName: String(input.PolicyName), Roles: Object.freeze(canonicalStrings(input.Roles)) });
}

async function preflightRoles(iam: IamService, roles: readonly string[]): Promise<void> {
  for (const role of roles) await iam.GetRole({ RoleName: role });
}

async function getInline(iam: IamService, roleName: string, policyName: string): Promise<PolicyDocument | undefined> {
  try { return decodePolicy((await iam.GetRolePolicy({ RoleName: roleName, PolicyName: policyName })).PolicyDocument); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

async function readPolicy(iam: IamService, policyName: string): Promise<ProviderReadModel<IamPolicyModel> | undefined> {
  const attached: Array<{ roleName: string; document: PolicyDocument }> = [];
  for (const role of await allRoles(iam)) {
    const roleName = String(role.RoleName);
    if (!(await allRolePolicyNames(iam, roleName)).includes(policyName)) continue;
    const document = await getInline(iam, roleName, policyName);
    if (document) attached.push({ roleName, document });
  }
  if (!attached.length) return undefined;
  const document = attached[0].document;
  for (const candidate of attached.slice(1)) if (!same(candidate.document, document)) throw new AwsError("ResourceConflict", `Inline policy ${policyName} has different documents on roles ${attached[0].roleName} and ${candidate.roleName}`, 409);
  const properties: IamPolicyModel = { PolicyName: policyName, PolicyDocument: document, Roles: attached.map(item => item.roleName).sort((left, right) => left.localeCompare(right)) };
  return { physicalId: policyName, properties, attributes: {} };
}

function success(model: IamPolicyModel): ProviderSuccess<IamPolicyModel> {
  return { status: "SUCCESS", physicalId: model.PolicyName, model: { physicalId: model.PolicyName, properties: model, attributes: {} } };
}

interface InlineSnapshot { readonly roleName: string; readonly policyName: string; readonly document?: PolicyDocument }

async function capture(iam: IamService, pairs: Array<{ roleName: string; policyName: string }>): Promise<InlineSnapshot[]> {
  const unique = new Map(pairs.map(pair => [`${pair.roleName}\0${pair.policyName}`, pair]));
  const snapshots: InlineSnapshot[] = [];
  for (const pair of unique.values()) snapshots.push({ ...pair, document: await getInline(iam, pair.roleName, pair.policyName) });
  return snapshots;
}

async function restore(iam: IamService, snapshots: InlineSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    try {
      if (snapshot.document) await iam.PutRolePolicy({ RoleName: snapshot.roleName, PolicyName: snapshot.policyName, PolicyDocument: snapshot.document });
      else if (await getInline(iam, snapshot.roleName, snapshot.policyName)) await iam.DeleteRolePolicy({ RoleName: snapshot.roleName, PolicyName: snapshot.policyName });
    } catch { /* A later stable CloudFormation rollback reports any remaining conflict. */ }
  }
}

async function applyUpdate(iam: IamService, previous: IamPolicyModel, desired: IamPolicyModel): Promise<void> {
  await preflightRoles(iam, desired.Roles);
  for (const roleName of previous.Roles) {
    const current = await getInline(iam, roleName, previous.PolicyName);
    const retainedIdentity = previous.PolicyName === desired.PolicyName && desired.Roles.includes(roleName);
    if (current && !same(current, previous.PolicyDocument) && (!retainedIdentity || !same(current, desired.PolicyDocument))) throw new AwsError("ResourceConflict", `Inline policy ${previous.PolicyName} on role ${roleName} changed outside CloudFormation`, 409);
  }
  for (const roleName of desired.Roles) {
    const current = await getInline(iam, roleName, desired.PolicyName);
    const isPreviousIdentity = previous.PolicyName === desired.PolicyName && previous.Roles.includes(roleName);
    if (current && isPreviousIdentity && !same(current, previous.PolicyDocument) && !same(current, desired.PolicyDocument)) throw new AwsError("ResourceConflict", `Inline policy ${desired.PolicyName} on role ${roleName} changed outside CloudFormation`, 409);
    if (current && !isPreviousIdentity && !same(current, desired.PolicyDocument)) throw new AwsError("EntityAlreadyExists", `Role ${roleName} already has conflicting inline policy ${desired.PolicyName}`, 409);
  }
  const snapshots = await capture(iam, [
    ...previous.Roles.map(roleName => ({ roleName, policyName: previous.PolicyName })),
    ...desired.Roles.map(roleName => ({ roleName, policyName: desired.PolicyName })),
  ]);
  try {
    for (const roleName of desired.Roles) await iam.PutRolePolicy({ RoleName: roleName, PolicyName: desired.PolicyName, PolicyDocument: desired.PolicyDocument });
    for (const roleName of previous.Roles) {
      const retained = previous.PolicyName === desired.PolicyName && desired.Roles.includes(roleName);
      if (!retained && await getInline(iam, roleName, previous.PolicyName)) await iam.DeleteRolePolicy({ RoleName: roleName, PolicyName: previous.PolicyName });
    }
  } catch (error) { await restore(iam, snapshots); throw error; }
}

export function createIamPolicyProvider(iam: IamService): ProductionResourceProvider<IamPolicyModel> {
  return {
    typeName: IAM_POLICY_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: IAM_POLICY_SCHEMA,
    validate(properties) { return validatePolicyProperties(properties); },
    canonicalize(properties) { return canonicalizePolicy(properties); },
    plan(previous, desired): ProviderPlan<IamPolicyModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: PROPERTY_NAMES, replacementProperties: [] };
      const changed = PROPERTY_NAMES.filter(name => !same((previous as any)[name], (desired as any)[name]));
      return changed.length ? { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] } : { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
    },
    async create(desired) {
      try {
        await preflightRoles(iam, desired.Roles);
        const additions: string[] = [];
        for (const roleName of desired.Roles) {
          const current = await getInline(iam, roleName, desired.PolicyName);
          if (current && !same(current, desired.PolicyDocument)) return { status: "FAILED", errorCode: "EntityAlreadyExists", message: `Role ${roleName} already has conflicting inline policy ${desired.PolicyName}` };
          if (!current) additions.push(roleName);
        }
        try { for (const roleName of additions) await iam.PutRolePolicy({ RoleName: roleName, PolicyName: desired.PolicyName, PolicyDocument: desired.PolicyDocument }); }
        catch (error) { for (const roleName of additions) { try { if (await getInline(iam, roleName, desired.PolicyName)) await iam.DeleteRolePolicy({ RoleName: roleName, PolicyName: desired.PolicyName }); } catch {} } throw error; }
        return success(desired);
      } catch (error) { return providerFailure(error); }
    },
    async read(physicalId): Promise<ProviderReadResult<IamPolicyModel>> {
      try { const model = await readPolicy(iam, physicalId); return model ? { status: "SUCCESS", physicalId, model } : { status: "NOT_FOUND", physicalId }; }
      catch (error) { return providerFailure(error); }
    },
    async update(_physicalId, previous, desired): Promise<ProviderUpdateResult<IamPolicyModel>> {
      try { await applyUpdate(iam, previous, desired); return success(desired); }
      catch (error) { return providerFailure(error); }
    },
    async delete(physicalId, previous): Promise<ProviderDeleteResult> {
      try {
        for (const roleName of previous.Roles) {
          const current = await getInline(iam, roleName, physicalId);
          if (current && !same(current, previous.PolicyDocument)) throw new AwsError("ResourceConflict", `Inline policy ${physicalId} on role ${roleName} changed outside CloudFormation`, 409);
        }
        let found = false;
        for (const roleName of previous.Roles) if (await getInline(iam, roleName, physicalId)) { found = true; await iam.DeleteRolePolicy({ RoleName: roleName, PolicyName: physicalId }); }
        return found ? { status: "SUCCESS", physicalId } : { status: "NOT_FOUND", physicalId };
      } catch (error) { return isMissing(error) ? { status: "NOT_FOUND", physicalId } : providerFailure(error); }
    },
    ref(model: ProviderReadModel<IamPolicyModel>) { return model.physicalId; },
    getAtt(_model: ProviderReadModel<IamPolicyModel>, attribute: string): never { throw new ProviderReferenceError(IAM_POLICY_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}
