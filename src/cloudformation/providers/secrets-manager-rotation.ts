import { providerValidationPathSegments } from "./contract.js";
import { createHash } from "node:crypto";
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

export const SECRETS_MANAGER_ROTATION_SCHEDULE_TYPE = "AWS::SecretsManager::RotationSchedule";
export const SECRETS_MANAGER_SECRET_TARGET_ATTACHMENT_TYPE = "AWS::SecretsManager::SecretTargetAttachment";
export const SECRETS_MANAGER_ROTATION_SCHEDULE_AUTHORIZATION_MATRIX: Readonly<Record<ProviderOperation, readonly string[]>> = Object.freeze({
  CREATE: Object.freeze(["secretsmanager:DescribeSecret", "secretsmanager:RotateSecret"]),
  READ: Object.freeze(["secretsmanager:DescribeSecret"]),
  UPDATE: Object.freeze(["secretsmanager:DescribeSecret", "secretsmanager:RotateSecret"]),
  DELETE: Object.freeze(["secretsmanager:CancelRotateSecret", "secretsmanager:DescribeSecret"]),
});
export const SECRETS_MANAGER_SECRET_TARGET_ATTACHMENT_AUTHORIZATION_MATRIX: Readonly<Record<ProviderOperation, readonly string[]>> = Object.freeze({
  CREATE: Object.freeze(["rds:DescribeDBInstances", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]),
  READ: Object.freeze(["secretsmanager:DescribeSecret"]),
  UPDATE: Object.freeze(["rds:DescribeDBInstances", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]),
  DELETE: Object.freeze(["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]),
});

export interface SecretsManagerRotationScheduleModel {
  readonly SecretId: string;
  readonly RotationLambdaARN: string;
  readonly RotationRules: Readonly<Record<string, unknown>>;
  readonly RotateImmediatelyOnUpdate: boolean;
}

export interface SecretsManagerSecretTargetAttachmentModel {
  readonly SecretId: string;
  readonly TargetId: string;
  readonly TargetType: "AWS::RDS::DBInstance";
}

const retention = Object.freeze({
  deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
  snapshotSupported: false,
});

export const SECRETS_MANAGER_ROTATION_SCHEDULE_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SECRETS_MANAGER_ROTATION_SCHEDULE_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    SecretId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    RotationLambdaARN: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    RotationRules: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    RotateImmediatelyOnUpdate: Object.freeze({ valueType: "boolean", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Configured secret ARN" }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "DELETE_BEFORE_CREATE", deleteBeforeCreateReason: "A secret can have only one rotation schedule" }),
  retention,
  tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});

export const SECRETS_MANAGER_SECRET_TARGET_ATTACHMENT_SCHEMA: ProviderSchema = Object.freeze({
  typeName: SECRETS_MANAGER_SECRET_TARGET_ATTACHMENT_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    SecretId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    TargetId: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
    TargetType: Object.freeze({ valueType: "string", required: true, updateBehavior: "REPLACEMENT" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Attached secret ARN" }),
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "DELETE_BEFORE_CREATE", deleteBeforeCreateReason: "A secret can have only one bounded target attachment" }),
  retention,
  tags: Object.freeze({ behavior: "NONE", propagatesCloudFormationTags: false }),
});

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function stable<T>(value: T): T { if (Array.isArray(value)) return value.map(stable) as T; if (record(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) as T; return value; }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }
function owner(context: ProviderContext): string { return `${context.stackId}/${context.logicalId}`; }
function clientToken(context: ProviderContext): string { return createHash("sha256").update(context.idempotencyKey).digest("hex"); }
function changed<Model extends object>(previous: Model, desired: Model): string[] { return [...new Set([...Object.keys(previous), ...Object.keys(desired)])].filter(key => !same((previous as any)[key], (desired as any)[key])).sort(); }
function failure<Model>(error: unknown): ProviderUpdateResult<Model> { const aws = error instanceof AwsError ? error : new AwsError("InternalFailure", error instanceof Error ? error.message : String(error), 500); return { status: "FAILED", errorCode: aws.code, message: aws.message, retryable: aws.status >= 500 }; }
function issue(issues: ProviderValidationIssue[], path: string, message: string): void { issues.push({ code: "InvalidProperty", path, pathSegments: providerValidationPathSegments(path), message }); }

export function createSecretsManagerRotationScheduleProvider(service: SecretsManagerService): ProductionResourceProvider<SecretsManagerRotationScheduleModel> {
  const success = (arn: string, model: SecretsManagerRotationScheduleModel) => ({ status: "SUCCESS" as const, physicalId: arn, model: { physicalId: arn, properties: { ...model, SecretId: arn }, attributes: {} } });
  return {
    typeName: SECRETS_MANAGER_ROTATION_SCHEDULE_TYPE, providerVersion: 1, visibility: "production", schema: SECRETS_MANAGER_ROTATION_SCHEDULE_SCHEMA,
    validate(properties: unknown): readonly ProviderValidationIssue[] {
      const issues = [...validateDeclaredProperties(properties ?? {}, SECRETS_MANAGER_ROTATION_SCHEDULE_SCHEMA)];
      if (!record(properties)) return issues;
      if (properties.RotationRules !== undefined && !record(properties.RotationRules)) issue(issues, "Properties.RotationRules", "RotationRules must be an object");
      if (record(properties.RotationRules)) for (const key of Object.keys(properties.RotationRules)) if (!["AutomaticallyAfterDays", "Duration", "ScheduleExpression"].includes(key)) issue(issues, `Properties.RotationRules.${key}`, "Unsupported rotation-rule field");
      return issues;
    },
    canonicalize(properties: unknown, context): SecretsManagerRotationScheduleModel { if (!record(properties)) throw new TypeError("RotationSchedule Properties must be an object"); const issues = this.validate(properties, context); if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; ")); return stable({ SecretId: String(properties.SecretId), RotationLambdaARN: String(properties.RotationLambdaARN), RotationRules: structuredClone(record(properties.RotationRules) ? properties.RotationRules : {}), RotateImmediatelyOnUpdate: properties.RotateImmediatelyOnUpdate !== false }); },
    plan(previous, desired): ProviderPlan<SecretsManagerRotationScheduleModel> { if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] }; const differences = changed(previous, desired); if (!differences.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] }; return differences.includes("SecretId") ? { action: "REPLACE", desired, changedProperties: differences, replacementProperties: ["SecretId"], replacementOrder: "DELETE_BEFORE_CREATE" } : { action: "UPDATE", desired, changedProperties: differences, replacementProperties: [] }; },
    async create(desired, context) { try { const output = await service.RotateSecretCloudFormation({ SecretId: desired.SecretId, RotationLambdaARN: desired.RotationLambdaARN, RotationRules: desired.RotationRules, RotateImmediately: true, RotateImmediatelyOnUpdate: desired.RotateImmediatelyOnUpdate, ClientRequestToken: clientToken(context) }, owner(context)); return success(String(output.ARN), desired); } catch (error) { return failure(error); } },
    async read(physicalId, context): Promise<ProviderReadResult<SecretsManagerRotationScheduleModel>> { try { const secret = service.readSecretCloudFormation(physicalId); if (!secret?.rotation?.enabled) return { status: "NOT_FOUND", physicalId }; if (secret.rotation.cloudFormationOwner !== owner(context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Rotation on ${physicalId} isn't owned by this stack resource` }; const rules = secret.rotation.rules; return success(secret.arn, { SecretId: secret.arn, RotationLambdaARN: secret.rotation.lambdaArn, RotationRules: { ...(rules.automaticallyAfterDays === undefined ? {} : { AutomaticallyAfterDays: rules.automaticallyAfterDays }), Duration: rules.duration, ScheduleExpression: rules.scheduleExpression }, RotateImmediatelyOnUpdate: secret.rotation.cloudFormationRotateImmediatelyOnUpdate !== false }); } catch (error) { return failure(error) as ProviderReadResult<SecretsManagerRotationScheduleModel>; } },
    async update(physicalId, _previous, desired, context) { if (service.resolveArn(desired.SecretId) !== physicalId) return { status: "FAILED", errorCode: "RequiresReplacement", message: "SecretId changes require replacement" }; try { await service.RotateSecretCloudFormation({ SecretId: physicalId, RotationLambdaARN: desired.RotationLambdaARN, RotationRules: desired.RotationRules, RotateImmediately: desired.RotateImmediatelyOnUpdate, RotateImmediatelyOnUpdate: desired.RotateImmediatelyOnUpdate, ClientRequestToken: clientToken(context) }, owner(context)); return success(physicalId, desired); } catch (error) { return failure(error); } },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> { try { const secret = service.readSecretCloudFormation(physicalId); if (!secret?.rotation) return { status: "NOT_FOUND", physicalId }; await service.CancelRotateSecretCloudFormation(physicalId, owner(context)); return { status: "SUCCESS", physicalId }; } catch (error) { return failure(error) as ProviderDeleteResult; } },
    ref(model: ProviderReadModel<SecretsManagerRotationScheduleModel>): unknown { return model.physicalId; },
    getAtt(_model, attribute): unknown { throw new ProviderReferenceError(SECRETS_MANAGER_ROTATION_SCHEDULE_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}

export function createSecretsManagerSecretTargetAttachmentProvider(service: SecretsManagerService): ProductionResourceProvider<SecretsManagerSecretTargetAttachmentModel> {
  const success = (arn: string, model: SecretsManagerSecretTargetAttachmentModel) => ({ status: "SUCCESS" as const, physicalId: arn, model: { physicalId: arn, properties: { ...model, SecretId: arn }, attributes: {} } });
  return {
    typeName: SECRETS_MANAGER_SECRET_TARGET_ATTACHMENT_TYPE, providerVersion: 1, visibility: "production", schema: SECRETS_MANAGER_SECRET_TARGET_ATTACHMENT_SCHEMA,
    validate(properties: unknown): readonly ProviderValidationIssue[] { const issues = [...validateDeclaredProperties(properties ?? {}, SECRETS_MANAGER_SECRET_TARGET_ATTACHMENT_SCHEMA)]; if (record(properties) && properties.TargetType !== "AWS::RDS::DBInstance") issue(issues, "Properties.TargetType", "Only AWS::RDS::DBInstance is supported"); return issues; },
    canonicalize(properties: unknown, context): SecretsManagerSecretTargetAttachmentModel { if (!record(properties)) throw new TypeError("SecretTargetAttachment Properties must be an object"); const issues = this.validate(properties, context); if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; ")); return stable({ SecretId: String(properties.SecretId), TargetId: String(properties.TargetId), TargetType: "AWS::RDS::DBInstance" as const }); },
    plan(previous, desired): ProviderPlan<SecretsManagerSecretTargetAttachmentModel> { if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] }; const differences = changed(previous, desired); return differences.length ? { action: "REPLACE", desired, changedProperties: differences, replacementProperties: differences, replacementOrder: "DELETE_BEFORE_CREATE" } : { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] }; },
    async create(desired, context) { try { const output = await service.AttachSecretTargetCloudFormation(desired, owner(context)); return success(String(output.ARN), desired); } catch (error) { return failure(error); } },
    async read(physicalId, context): Promise<ProviderReadResult<SecretsManagerSecretTargetAttachmentModel>> { try { const secret = service.readSecretCloudFormation(physicalId); const attachment = secret?.targetAttachment; if (!secret || !attachment) return { status: "NOT_FOUND", physicalId }; if (attachment.cloudFormationOwner !== owner(context)) return { status: "FAILED", errorCode: "OwnershipConflict", message: `Target attachment on ${physicalId} isn't owned by this stack resource` }; return success(secret.arn, { SecretId: secret.arn, TargetId: attachment.targetId, TargetType: attachment.targetType }); } catch (error) { return failure(error) as ProviderReadResult<SecretsManagerSecretTargetAttachmentModel>; } },
    async update(_physicalId, _previous, _desired) { return { status: "FAILED", errorCode: "RequiresReplacement", message: "SecretTargetAttachment changes require replacement" }; },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> { try { const secret = service.readSecretCloudFormation(physicalId); if (!secret?.targetAttachment) return { status: "NOT_FOUND", physicalId }; await service.DetachSecretTargetCloudFormation(physicalId, owner(context)); return { status: "SUCCESS", physicalId }; } catch (error) { return failure(error) as ProviderDeleteResult; } },
    ref(model: ProviderReadModel<SecretsManagerSecretTargetAttachmentModel>): unknown { return model.physicalId; },
    getAtt(_model, attribute): unknown { throw new ProviderReferenceError(SECRETS_MANAGER_SECRET_TARGET_ATTACHMENT_TYPE, `Fn::GetAtt ${attribute}`); },
  };
}
