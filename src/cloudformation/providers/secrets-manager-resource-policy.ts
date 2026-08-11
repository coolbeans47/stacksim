import { AwsError } from "../../errors.js";
import type { SecretsManagerService } from "../../secrets-manager.js";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderOperation,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";

export const SECRETS_MANAGER_RESOURCE_POLICY_TYPE = "AWS::SecretsManager::ResourcePolicy";
export const SECRETS_MANAGER_RESOURCE_POLICY_AUTHORIZATION_MATRIX: Readonly<Record<ProviderOperation, readonly string[]>> = Object.freeze({
  CREATE: Object.freeze(["secretsmanager:GetResourcePolicy", "secretsmanager:PutResourcePolicy"]),
  READ: Object.freeze(["secretsmanager:GetResourcePolicy"]),
  UPDATE: Object.freeze(["secretsmanager:GetResourcePolicy", "secretsmanager:PutResourcePolicy"]),
  DELETE: Object.freeze(["secretsmanager:GetResourcePolicy", "secretsmanager:DeleteResourcePolicy"]),
});

export interface SecretsManagerResourcePolicyModel {
  readonly SecretId: string;
  readonly ResourcePolicy: Readonly<Record<string, unknown>>;
  readonly BlockPublicPolicy: boolean;
}

export const SECRETS_MANAGER_RESOURCE_POLICY_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SECRETS_MANAGER_RESOURCE_POLICY_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    BlockPublicPolicy: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
    ResourcePolicy: Object.freeze({ valueType: "object", required: true, updateBehavior: "MUTABLE" }),
    SecretId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Configured secret ARN" }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "DELETE_BEFORE_CREATE", deleteBeforeCreateReason: "A secret can have only one attached resource policy" }),
  retention: Object.freeze({
    deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    snapshotSupported: false,
  }),
  tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stable<T>(value: T): T { if (Array.isArray(value)) return value.map(stable) as T; if (record(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) as T; return value; }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }
function owner(context: ProviderContext): string { return `${context.stackId}/${context.logicalId}`; }
function failed(error: unknown): ProviderUpdateResult<SecretsManagerResourcePolicyModel> {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}

export function createSecretsManagerResourcePolicyProvider(service: SecretsManagerService): ProductionResourceProvider<SecretsManagerResourcePolicyModel> {
  const success = (arn: string, model: SecretsManagerResourcePolicyModel) => ({ status: "SUCCESS" as const, physicalId: arn, model: { physicalId: arn, properties: { ...model, SecretId: arn }, attributes: {} } });
  return {
    typeName: SECRETS_MANAGER_RESOURCE_POLICY_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: SECRETS_MANAGER_RESOURCE_POLICY_SCHEMA,
    validate(properties: unknown): readonly ProviderValidationIssue[] {
      const issues = [...validateDeclaredProperties(properties ?? {}, SECRETS_MANAGER_RESOURCE_POLICY_SCHEMA)];
      if (!record(properties)) return issues;
      if (typeof properties.SecretId === "string" && (properties.SecretId.length < 1 || properties.SecretId.length > 2048)) issues.push({ code: "InvalidProperty", path: "Properties.SecretId", message: "SecretId must contain 1-2048 characters" });
      return issues;
    },
    canonicalize(properties: unknown, context): SecretsManagerResourcePolicyModel {
      if (!record(properties)) throw new TypeError("AWS::SecretsManager::ResourcePolicy Properties must be an object");
      const issues = this.validate(properties, context); if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return stable({ SecretId: String(properties.SecretId), ResourcePolicy: structuredClone(properties.ResourcePolicy as Record<string, unknown>), BlockPublicPolicy: properties.BlockPublicPolicy === true });
    },
    plan(previous, desired): ProviderPlan<SecretsManagerResourcePolicyModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const changed = (Object.keys(desired) as Array<keyof SecretsManagerResourcePolicyModel>).filter(key => !same(previous[key], desired[key])).map(String).sort();
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      if (changed.includes("SecretId")) return { action: "REPLACE", desired, changedProperties: changed, replacementProperties: ["SecretId"], replacementOrder: "DELETE_BEFORE_CREATE" };
      return { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
    },
    async create(desired, context) {
      try {
        const state = await service.PutResourcePolicyCloudFormation({ SecretId: desired.SecretId, ResourcePolicy: JSON.stringify(desired.ResourcePolicy), BlockPublicPolicy: desired.BlockPublicPolicy }, owner(context), context.principal.identity);
        return success(state.arn, desired);
      } catch (error) { return failed(error); }
    },
    async read(physicalId, context): Promise<ProviderReadResult<SecretsManagerResourcePolicyModel>> {
      try {
        const state = service.readSecretCloudFormation(physicalId);
        if (!state || !state.resourcePolicy) return { status: "NOT_FOUND", physicalId };
        if (state.resourcePolicy.cloudFormationOwner !== owner(context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Resource policy on ${physicalId} is not owned by this stack resource` };
        return success(state.arn, { SecretId: state.arn, ResourcePolicy: stable(structuredClone(state.resourcePolicy.normalized as unknown as Record<string, unknown>)), BlockPublicPolicy: true });
      } catch (error) { return failed(error) as ProviderReadResult<SecretsManagerResourcePolicyModel>; }
    },
    async update(physicalId, _previous, desired, context) {
      if (service.resolveArn(desired.SecretId) !== physicalId) return { status: "FAILED", errorCode: "RequiresReplacement", message: "SecretId changes require replacement" };
      try {
        const state = await service.PutResourcePolicyCloudFormation({ SecretId: physicalId, ResourcePolicy: JSON.stringify(desired.ResourcePolicy), BlockPublicPolicy: desired.BlockPublicPolicy }, owner(context), context.principal.identity);
        return success(state.arn, desired);
      } catch (error) { return failed(error); }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try { await service.DeleteResourcePolicyCloudFormation(physicalId, owner(context)); return { status: "SUCCESS", physicalId }; }
      catch (error) { return failed(error) as ProviderDeleteResult; }
    },
    ref(read: ProviderReadModel<SecretsManagerResourcePolicyModel>): unknown { return read.physicalId; },
    getAtt(_read, attribute): unknown { throw new ProviderReferenceError(SECRETS_MANAGER_RESOURCE_POLICY_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}
