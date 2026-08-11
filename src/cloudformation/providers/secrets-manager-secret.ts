import { createHash } from "node:crypto";
import { AwsError } from "../../errors.js";
import type { SecretsManagerService } from "../../secrets-manager.js";
import type { SecretState } from "../../types.js";
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

export const SECRETS_MANAGER_SECRET_TYPE = "AWS::SecretsManager::Secret";
export const SECRETS_MANAGER_SECRET_AUTHORIZATION_MATRIX: Readonly<Record<ProviderOperation, readonly string[]>> = Object.freeze({
  CREATE: Object.freeze(["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:TagResource", "secretsmanager:GetRandomPassword"]),
  READ: Object.freeze(["secretsmanager:DescribeSecret"]),
  UPDATE: Object.freeze(["secretsmanager:DescribeSecret", "secretsmanager:UpdateSecret", "secretsmanager:TagResource", "secretsmanager:UntagResource", "secretsmanager:GetRandomPassword"]),
  DELETE: Object.freeze(["secretsmanager:DescribeSecret", "secretsmanager:DeleteSecret"]),
});

type Tag = { readonly Key: string; readonly Value: string };
export interface SecretsManagerSecretModel {
  readonly Name: string;
  readonly Description?: string;
  readonly GenerateSecretString?: Readonly<Record<string, unknown>>;
  readonly SecretString?: string;
  readonly Tags: readonly Tag[];
}

export const SECRETS_MANAGER_SECRET_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SECRETS_MANAGER_SECRET_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    Description: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE" }),
    GenerateSecretString: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE", sensitive: true }),
    KmsKeyId: Object.freeze({ valueType: "string", updateBehavior: "NOT_SUPPORTED" }),
    Name: Object.freeze({ valueType: "string", updateBehavior: "REPLACEMENT" }),
    ReplicaRegions: Object.freeze({ valueType: "array", updateBehavior: "NOT_SUPPORTED" }),
    SecretString: Object.freeze({ valueType: "string", updateBehavior: "MUTABLE", sensitive: true }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    Type: Object.freeze({ valueType: "string", updateBehavior: "NOT_SUPPORTED" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Secret ARN" }),
  attributes: Object.freeze({ Id: Object.freeze({ valueType: "string", description: "Secret ARN" }) }),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: Object.freeze({
    deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    snapshotSupported: false,
  }),
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stable<T>(value: T): T { if (Array.isArray(value)) return value.map(stable) as T; if (record(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) as T; return value; }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }
function owner(context: ProviderContext): string { return `${context.stackId}/${context.logicalId}`; }
function token(context: ProviderContext): string { return createHash("sha256").update(context.resourceOperationId).digest("hex"); }
function stackName(context: ProviderContext): string { return context.stackId.match(/:stack\/([^/]+)\//)?.[1] ?? "stack"; }
function generatedName(context: ProviderContext): string {
  const suffix = createHash("sha256").update(`${context.stackId}\0${context.logicalId}`).digest("hex").slice(0, 12);
  const prefix = `${stackName(context)}-${context.logicalId}`.replace(/[^A-Za-z0-9/_+=.@-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "secret";
  return `${prefix.slice(0, 512 - suffix.length - 1)}-${suffix}`;
}
function tags(value: unknown): readonly Tag[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("Tags must be an array");
  return value.map(item => {
    if (!record(item) || typeof item.Key !== "string" || typeof item.Value !== "string") throw new TypeError("Each tag requires string Key and Value");
    return { Key: item.Key, Value: item.Value };
  }).sort((a, b) => a.Key.localeCompare(b.Key));
}
function issue(issues: ProviderValidationIssue[], path: string, message: string): void { issues.push({ code: "InvalidProperty", path, message }); }
function failed(error: unknown): ProviderUpdateResult<SecretsManagerSecretModel> {
  const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500);
  return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 };
}
function success(state: SecretState, properties: SecretsManagerSecretModel) {
  return { status: "SUCCESS" as const, physicalId: state.arn, model: { physicalId: state.arn, properties, attributes: { Id: state.arn } } };
}
function safeModel(state: SecretState): SecretsManagerSecretModel {
  return stable({
    Name: state.name,
    ...(state.description === undefined ? {} : { Description: state.description }),
    ...(state.cloudFormationGeneration ? { GenerateSecretString: state.cloudFormationGeneration } : {}),
    Tags: Object.entries(state.tags).map(([Key, Value]) => ({ Key, Value })).sort((a, b) => a.Key.localeCompare(b.Key)),
  });
}

export function createSecretsManagerSecretProvider(service: SecretsManagerService): ProductionResourceProvider<SecretsManagerSecretModel> {
  return {
    typeName: SECRETS_MANAGER_SECRET_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: SECRETS_MANAGER_SECRET_SCHEMA,
    validate(properties: unknown): readonly ProviderValidationIssue[] {
      const issues = [...validateDeclaredProperties(properties ?? {}, SECRETS_MANAGER_SECRET_SCHEMA)];
      if (!record(properties)) return issues;
      if (properties.KmsKeyId !== undefined) issue(issues, "Properties.KmsKeyId", "Customer KMS keys are not supported in PSS-04");
      if (properties.ReplicaRegions !== undefined) issue(issues, "Properties.ReplicaRegions", "Secret replicas require PSS-07");
      if (properties.Type !== undefined) issue(issues, "Properties.Type", "Managed external secrets are not supported");
      if (properties.SecretString !== undefined && properties.GenerateSecretString !== undefined) issue(issues, "Properties", "SecretString and GenerateSecretString are mutually exclusive");
      if (typeof properties.Description === "string" && properties.Description.length > 2048) issue(issues, "Properties.Description", "Description cannot exceed 2048 characters");
      if (record(properties.GenerateSecretString)) {
        const allowed = new Set(["ExcludeCharacters", "ExcludeLowercase", "ExcludeNumbers", "ExcludePunctuation", "ExcludeUppercase", "GenerateStringKey", "IncludeSpace", "PasswordLength", "RequireEachIncludedType", "SecretStringTemplate"]);
        for (const key of Object.keys(properties.GenerateSecretString)) if (!allowed.has(key)) issue(issues, `Properties.GenerateSecretString.${key}`, "Unsupported GenerateSecretString property");
        const generation = properties.GenerateSecretString;
        const booleans = ["ExcludeLowercase", "ExcludeNumbers", "ExcludePunctuation", "ExcludeUppercase", "IncludeSpace", "RequireEachIncludedType"];
        for (const key of booleans) if (generation[key] !== undefined && typeof generation[key] !== "boolean") issue(issues, `Properties.GenerateSecretString.${key}`, `${key} must be boolean`);
        if (generation.PasswordLength !== undefined && (!Number.isInteger(generation.PasswordLength) || Number(generation.PasswordLength) < 4 || Number(generation.PasswordLength) > 4096)) issue(issues, "Properties.GenerateSecretString.PasswordLength", "PasswordLength must be an integer from 4 through 4096");
        if ((generation.GenerateStringKey === undefined) !== (generation.SecretStringTemplate === undefined)) issue(issues, "Properties.GenerateSecretString", "GenerateStringKey and SecretStringTemplate must be specified together");
        if (typeof generation.SecretStringTemplate === "string") try { const parsed = JSON.parse(generation.SecretStringTemplate); if (!record(parsed)) throw new Error(); } catch { issue(issues, "Properties.GenerateSecretString.SecretStringTemplate", "SecretStringTemplate must be a JSON object string"); }
      }
      try {
        const normalized = tags(properties.Tags);
        if (normalized.length > 50 || new Set(normalized.map(tag => tag.Key)).size !== normalized.length || normalized.some(tag => !tag.Key || tag.Key.length > 128 || tag.Value.length > 256 || tag.Key.toLowerCase().startsWith("aws:"))) issue(issues, "Properties.Tags", "Tags exceed the Secrets Manager limits or contain reserved/duplicate keys");
      } catch (error) { issue(issues, "Properties.Tags", error instanceof Error ? error.message : String(error)); }
      return issues;
    },
    canonicalize(properties: unknown, context): SecretsManagerSecretModel {
      if (!record(properties)) throw new TypeError("AWS::SecretsManager::Secret Properties must be an object");
      const issues = this.validate(properties, context); if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return stable({
        Name: properties.Name === undefined ? generatedName(context) : String(properties.Name),
        ...(properties.Description === undefined ? {} : { Description: String(properties.Description) }),
        ...(properties.GenerateSecretString === undefined ? {} : { GenerateSecretString: stable(structuredClone(properties.GenerateSecretString as Record<string, unknown>)) }),
        ...(properties.SecretString === undefined ? {} : { SecretString: String(properties.SecretString) }),
        Tags: tags(properties.Tags),
      });
    },
    plan(previous, desired): ProviderPlan<SecretsManagerSecretModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const changed = [...new Set([...Object.keys(previous), ...Object.keys(desired)])].filter(key => !same((previous as any)[key], (desired as any)[key])).sort();
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      if (changed.includes("Name")) return { action: "REPLACE", desired, changedProperties: changed, replacementProperties: ["Name"], replacementOrder: "CREATE_BEFORE_DELETE" };
      return { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
    },
    async create(desired, context) {
      try {
        const state = await service.CreateSecretCloudFormation(desired, owner(context), token(context));
        return success(state, desired);
      } catch (error) { return failed(error); }
    },
    async read(physicalId, context): Promise<ProviderReadResult<SecretsManagerSecretModel>> {
      try {
        const state = service.readSecretCloudFormation(physicalId);
        if (!state) return { status: "NOT_FOUND", physicalId };
        if (state.cloudFormationOwner !== owner(context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Secret ${physicalId} is not owned by this stack resource` };
        return success(state, safeModel(state));
      } catch (error) { return failed(error) as ProviderReadResult<SecretsManagerSecretModel>; }
    },
    async update(physicalId, previous, desired, context) {
      if (physicalId !== service.resolveArn(desired.Name)) return { status: "FAILED", errorCode: "RequiresReplacement", message: "Name changes require replacement" };
      try {
        const writeValue = !same(previous.SecretString, desired.SecretString) || !same(previous.GenerateSecretString, desired.GenerateSecretString);
        const state = await service.UpdateSecretCloudFormation({ ...desired, SecretId: physicalId }, owner(context), token(context), writeValue);
        return success(state, desired);
      } catch (error) { return failed(error); }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try { await service.DeleteSecretCloudFormation(physicalId, owner(context)); return { status: "SUCCESS", physicalId }; }
      catch (error) { return failed(error) as ProviderDeleteResult; }
    },
    ref(read: ProviderReadModel<SecretsManagerSecretModel>): unknown { return read.physicalId; },
    getAtt(read, attribute): unknown {
      if (attribute === "Id") return read.physicalId;
      throw new ProviderReferenceError(SECRETS_MANAGER_SECRET_TYPE, `Fn::GetAtt ${attribute}`);
    },
  };
}
