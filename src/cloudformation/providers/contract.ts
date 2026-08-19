import type { PrincipalContext } from "../../auth/sigv4.js";

/** Values which may be persisted in an operation checkpoint. */
export type ProviderJsonValue =
  | null
  | boolean
  | number
  | string
  | ProviderJsonValue[]
  | { [key: string]: ProviderJsonValue };

export type ProviderJsonObject = { [key: string]: ProviderJsonValue };

export type ProviderOperation = "CREATE" | "READ" | "UPDATE" | "DELETE";
export type ProviderVisibility = "production" | "test-only";

export type ProviderPropertyValueType = "any" | "string" | "number" | "boolean" | "object" | "array";

/**
 * How a change to a supported, resolved CloudFormation property is applied.
 * CONDITIONAL_REPLACEMENT requires the provider's pure plan method to decide.
 */
export type ProviderPropertyUpdateBehavior =
  | "MUTABLE"
  | "REPLACEMENT"
  | "CONDITIONAL_REPLACEMENT"
  | "NOT_SUPPORTED";

export interface ProviderPropertyDeclaration {
  readonly valueType: ProviderPropertyValueType;
  readonly required?: boolean;
  readonly updateBehavior: ProviderPropertyUpdateBehavior;
  readonly sensitive?: boolean;
  readonly description?: string;
}

export interface ProviderRefDeclaration {
  readonly supported: boolean;
  readonly valueType?: ProviderPropertyValueType;
  readonly description?: string;
}

export interface ProviderAttributeDeclaration {
  readonly valueType: ProviderPropertyValueType;
  readonly description?: string;
  readonly sensitive?: boolean;
}

export type ProviderReplacementOrder = "CREATE_BEFORE_DELETE" | "DELETE_BEFORE_CREATE";

export interface ProviderReplacementDeclaration {
  /** Normal replacement ordering for this resource type. */
  readonly defaultOrder: ProviderReplacementOrder;
  /** Why delete-before-create is required, when that is the default. */
  readonly deleteBeforeCreateReason?: string;
}

export type ProviderRetentionPolicy = "Delete" | "Retain" | "RetainExceptOnCreate" | "Snapshot";

export interface ProviderRetentionDeclaration {
  /** Policies accepted for DeletionPolicy. */
  readonly deletionPolicies: readonly ProviderRetentionPolicy[];
  /** Policies accepted for UpdateReplacePolicy. */
  readonly updateReplacePolicies: readonly ProviderRetentionPolicy[];
  /** True only when delete can create a real snapshot through a backing service. */
  readonly snapshotSupported: boolean;
}

export type ProviderTagBehavior = "NONE" | "RESOURCE_PROPERTY" | "STACK_AND_RESOURCE";

export interface ProviderTagDeclaration {
  readonly behavior: ProviderTagBehavior;
  readonly propertyName?: string;
  readonly propagatesCloudFormationTags: boolean;
}

/**
 * A checked-in declaration of the bounded local resource schema. Properties
 * not listed here are never accepted implicitly.
 */
export interface ProviderSchema {
  readonly typeName: string;
  /** General Lambda custom resources are the sole production exception. */
  readonly unknownProperties: "REJECT" | "ALLOW";
  readonly properties: Readonly<Record<string, ProviderPropertyDeclaration>>;
  readonly ref: ProviderRefDeclaration;
  readonly attributes: Readonly<Record<string, ProviderAttributeDeclaration>>;
  /** Custom-resource response Data keys are determined by provider code. */
  readonly additionalAttributes?: boolean;
  readonly replacement: ProviderReplacementDeclaration;
  readonly retention: ProviderRetentionDeclaration;
  readonly tags: ProviderTagDeclaration;
}

export interface ProviderValidationIssue {
  readonly code: "InvalidType" | "MissingRequiredProperty" | "UnsupportedProperty" | "InvalidProperty";
  /** A path rooted at Properties, for example Properties.FunctionName. */
  readonly path: string;
  readonly message: string;
}

export interface ProviderPrincipalContext {
  /** The signed caller or assumed CloudFormation execution-role session. */
  readonly identity: Readonly<PrincipalContext>;
  readonly serviceRoleArn?: string;
}

/** Stable context reconstructed identically for every retry after restart. */
export interface ProviderContext {
  readonly accountId: string;
  readonly region: string;
  readonly partition: string;
  readonly stackId: string;
  readonly logicalId: string;
  readonly operationId: string;
  readonly resourceOperationId: string;
  readonly clientRequestToken?: string;
  readonly idempotencyKey: string;
  /** Effective retention policy for DELETE when the executor requests service-backed snapshot semantics. */
  readonly retentionPolicy?: ProviderRetentionPolicy;
  readonly deadlineAt: number;
  /** Provider-owned opaque JSON restored from an IN_PROGRESS result. */
  readonly callbackContext?: Readonly<ProviderJsonObject>;
  readonly principal: ProviderPrincipalContext;
}

export interface ProviderReadModel<Model = unknown> {
  readonly physicalId: string;
  readonly properties: Model;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface ProviderSuccess<Model = unknown> {
  readonly status: "SUCCESS";
  readonly physicalId: string;
  readonly model: ProviderReadModel<Model>;
}

export interface ProviderDeleteSuccess {
  readonly status: "SUCCESS";
  /** Useful for journaling; deletion success does not establish ownership. */
  readonly physicalId?: string;
}

/** Provider-owned portion of an executor checkpoint. It must remain JSON-safe. */
export interface ProviderCallbackCheckpoint {
  readonly schemaVersion: 1;
  readonly callbackContext: ProviderJsonObject;
  readonly physicalId?: string;
}

export interface ProviderInProgress {
  readonly status: "IN_PROGRESS";
  readonly callbackAfterMs: number;
  readonly checkpoint: ProviderCallbackCheckpoint;
  readonly message?: string;
}

export interface ProviderNotFound {
  readonly status: "NOT_FOUND";
  readonly physicalId?: string;
  readonly message?: string;
}

export interface ProviderFailed {
  readonly status: "FAILED";
  readonly errorCode: string;
  readonly message: string;
  /** A partially created resource that the executor must compensate on rollback. */
  readonly physicalId?: string;
  /** Retry is still bounded by deadlineAt and the executor's retry policy. */
  readonly retryable?: boolean;
}

export type ProviderCreateResult<Model = unknown> = ProviderSuccess<Model> | ProviderInProgress | ProviderFailed;
export type ProviderReadResult<Model = unknown> = ProviderSuccess<Model> | ProviderInProgress | ProviderNotFound | ProviderFailed;
export type ProviderUpdateResult<Model = unknown> = ProviderSuccess<Model> | ProviderInProgress | ProviderFailed;
export type ProviderDeleteResult = ProviderDeleteSuccess | ProviderInProgress | ProviderNotFound | ProviderFailed;
export type ProviderProgress<Model = unknown> = ProviderReadResult<Model> | ProviderDeleteSuccess;

/** Complete durable executor checkpoint for one provider callback/poll. */
export interface ProviderOperationCheckpoint {
  readonly schemaVersion: 1;
  readonly typeName: string;
  readonly providerVersion: number;
  readonly operation: ProviderOperation;
  readonly stackId: string;
  readonly logicalId: string;
  readonly operationId: string;
  readonly resourceOperationId: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly deadlineAt: number;
  readonly resumeAfter: number;
  readonly provider: ProviderCallbackCheckpoint;
}

export type ProviderPlanAction = "CREATE" | "NO_OP" | "UPDATE" | "REPLACE";

export interface ProviderPlan<Model = unknown> {
  readonly action: ProviderPlanAction;
  readonly desired: Model;
  readonly changedProperties: readonly string[];
  readonly replacementProperties: readonly string[];
  readonly replacementOrder?: ProviderReplacementOrder;
  readonly reason?: string;
}

export interface CloudFormationResourceProvider<Model = unknown> {
  readonly typeName: string;
  readonly providerVersion: number;
  readonly visibility: ProviderVisibility;
  readonly schema: ProviderSchema;

  /** Validate already-resolved properties without calling a backing service. */
  validate(properties: unknown, context: ProviderContext): readonly ProviderValidationIssue[];
  /** Produce the stable property representation used for digesting/planning. */
  canonicalize(properties: unknown, context: ProviderContext): Model;
  /** Pure dry plan. It must not call or mutate a backing service. */
  plan(previous: Model | undefined, desired: Model, context: ProviderContext): ProviderPlan<Model>;

  create(desired: Model, context: ProviderContext): Promise<ProviderCreateResult<Model>>;
  read(physicalId: string, context: ProviderContext): Promise<ProviderReadResult<Model>>;
  update(physicalId: string, previous: Model, desired: Model, context: ProviderContext): Promise<ProviderUpdateResult<Model>>;
  /** Release provider-local ownership metadata when CloudFormation retains the physical resource. */
  retain?(physicalId: string, previous: Model, context: ProviderContext): Promise<void>;
  delete(physicalId: string, previous: Model, context: ProviderContext): Promise<ProviderDeleteResult>;

  ref(model: ProviderReadModel<Model>): unknown;
  getAtt(model: ProviderReadModel<Model>, attribute: string): unknown;
}

export type ProductionResourceProvider<Model = unknown> = CloudFormationResourceProvider<Model> & {
  readonly visibility: "production";
};

export type TestOnlyResourceProvider<Model = unknown> = CloudFormationResourceProvider<Model> & {
  readonly visibility: "test-only";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matchesValueType(value: unknown, type: ProviderPropertyValueType): boolean {
  switch (type) {
    case "any": return true;
    case "array": return Array.isArray(value);
    case "object": return isRecord(value);
    default: return typeof value === type;
  }
}

/** Shared shallow validation for the provider's declared top-level boundary. */
export function validateDeclaredProperties(properties: unknown, schema: ProviderSchema): ProviderValidationIssue[] {
  if (!isRecord(properties)) {
    return [{ code: "InvalidType", path: "Properties", message: `${schema.typeName} Properties must be an object` }];
  }

  const issues: ProviderValidationIssue[] = [];
  for (const name of Object.keys(properties).sort()) {
    const declaration = schema.properties[name];
    if (!declaration && schema.unknownProperties === "REJECT") {
      issues.push({
        code: "UnsupportedProperty",
        path: `Properties.${name}`,
        message: `${schema.typeName} does not support property ${name}`,
      });
      continue;
    }
    if (declaration && !matchesValueType(properties[name], declaration.valueType)) {
      issues.push({
        code: "InvalidType",
        path: `Properties.${name}`,
        message: `${schema.typeName} property ${name} must be ${declaration.valueType}`,
      });
    }
  }

  for (const [name, declaration] of Object.entries(schema.properties).sort(([left], [right]) => left.localeCompare(right))) {
    if (declaration.required && !Object.prototype.hasOwnProperty.call(properties, name)) {
      issues.push({
        code: "MissingRequiredProperty",
        path: `Properties.${name}`,
        message: `${schema.typeName} requires property ${name}`,
      });
    }
  }
  return issues;
}

export class ProviderReferenceError extends Error {
  readonly code = "ValidationError" as const;

  constructor(typeName: string, reference: string) {
    super(`${typeName} does not support ${reference}`);
    this.name = "ProviderReferenceError";
  }
}
