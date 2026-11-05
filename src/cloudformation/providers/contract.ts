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
  /**
   * An object-valued property whose CloudFormation type is Json: a string
   * holding a JSON object is accepted and parsed before provider validation.
   */
  readonly acceptsJsonString?: boolean;
  /**
   * Primitive members of an object-valued property. A numeric string or
   * "true"/"false" supplied for one of them is coerced like a top-level value.
   */
  readonly members?: Readonly<Record<string, "number" | "boolean">>;
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
  /**
   * Real CloudFormation properties this provider deliberately refuses, with the
   * reason and the local alternative shown instead of the generic refusal.
   */
  readonly unsupportedProperties?: Readonly<Record<string, string>>;
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
  /** Authoritative path components. Display paths are retained only for compatibility. */
  readonly pathSegments: readonly string[];
  readonly message: string;
}

/**
 * Convert a producer-owned legacy display path into structured components.
 * New validators should pass their naturally available components directly;
 * this helper exists for the compilation-wide migration of older validators.
 */
export function providerValidationPathSegments(path: string): readonly string[] {
  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  if (segments[0] !== "Properties") throw new TypeError(`Provider validation paths must be rooted at Properties: ${path}`);
  return Object.freeze(segments);
}

export function providerValidationIssue(
  code: ProviderValidationIssue["code"],
  legacyPath: string,
  pathSegments: readonly string[],
  message: string,
): ProviderValidationIssue {
  if (!pathSegments.length || pathSegments[0] !== "Properties" || pathSegments.some(segment => typeof segment !== "string" || !segment.length)) {
    throw new TypeError("Provider validation pathSegments must be nonempty and rooted at Properties");
  }
  return Object.freeze({ code, path: legacyPath, pathSegments: Object.freeze([...pathSegments]), message });
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
  /** Authoritative resource generation retained by the executor, when supported. */
  readonly resourceGeneration?: string;
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

const NUMERIC_STRING = /^-?\d+(?:\.\d+)?$/;

/**
 * CloudFormation resolves parameters and quoted template values to strings and
 * converts them to the property's declared primitive type. Only a numeric
 * string becomes a number and only "true"/"false" become booleans; any other
 * value is returned unchanged so validation still rejects it.
 */
function coercePrimitive(value: unknown, type: ProviderPropertyValueType): unknown {
  if (typeof value !== "string") return value;
  if (type === "number" && NUMERIC_STRING.test(value)) return Number(value);
  if (type === "boolean" && (value === "true" || value === "false")) return value === "true";
  return value;
}

function parseJsonObjectString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : value;
  } catch { return value; }
}

function coerceDeclaredValue(value: unknown, declaration: ProviderPropertyDeclaration): unknown {
  if (declaration.valueType === "number" || declaration.valueType === "boolean") return coercePrimitive(value, declaration.valueType);
  if (declaration.valueType !== "object") return value;
  const object = declaration.acceptsJsonString ? parseJsonObjectString(value) : value;
  if (!declaration.members || !isRecord(object)) return object;
  let coerced: Record<string, unknown> | undefined;
  for (const [member, type] of Object.entries(declaration.members)) {
    if (!Object.hasOwn(object, member)) continue;
    const next = coercePrimitive(object[member], type);
    if (next !== object[member]) (coerced ??= { ...object })[member] = next;
  }
  return coerced ?? object;
}

/**
 * Convert string-typed numbers and booleans in resolved properties to the
 * primitive type the provider schema declares. The executor applies this once
 * to evaluated template properties, so providers always receive real numbers
 * and booleans. The input is never mutated; it is returned as-is when nothing
 * needs converting.
 */
export function coerceDeclaredProperties<T>(properties: T, schema: ProviderSchema): T {
  if (!isRecord(properties)) return properties;
  let coerced: Record<string, unknown> | undefined;
  for (const [name, value] of Object.entries(properties)) {
    const declaration = schema.properties[name];
    if (!declaration) continue;
    const next = coerceDeclaredValue(value, declaration);
    if (next !== value) (coerced ??= { ...properties })[name] = next;
  }
  return (coerced ?? properties) as T;
}

function matchesValueType(value: unknown, declaration: ProviderPropertyDeclaration): boolean {
  const candidate = coerceDeclaredValue(value, declaration);
  switch (declaration.valueType) {
    case "any": return true;
    case "array": return Array.isArray(candidate);
    case "object": return isRecord(candidate);
    default: return typeof candidate === declaration.valueType;
  }
}

/** Shared shallow validation for the provider's declared top-level boundary. */
export function validateDeclaredProperties(properties: unknown, schema: ProviderSchema): ProviderValidationIssue[] {
  if (!isRecord(properties)) {
    return [providerValidationIssue("InvalidType", "Properties", ["Properties"], `${schema.typeName} Properties must be an object`)];
  }

  const issues: ProviderValidationIssue[] = [];
  for (const name of Object.keys(properties).sort()) {
    const declaration = schema.properties[name];
    if (!declaration && schema.unknownProperties === "REJECT") {
      issues.push(providerValidationIssue("UnsupportedProperty", `Properties.${name}`, ["Properties", name], `${schema.typeName} does not support property ${name}${schema.unsupportedProperties?.[name] ? `: ${schema.unsupportedProperties[name]}` : ""}`));
      continue;
    }
    if (declaration && !matchesValueType(properties[name], declaration)) {
      issues.push(providerValidationIssue("InvalidType", `Properties.${name}`, ["Properties", name], `${schema.typeName} property ${name} must be ${declaration.valueType}`));
    }
  }

  for (const [name, declaration] of Object.entries(schema.properties).sort(([left], [right]) => left.localeCompare(right))) {
    if (declaration.required && !Object.prototype.hasOwnProperty.call(properties, name)) {
      issues.push(providerValidationIssue("MissingRequiredProperty", `Properties.${name}`, ["Properties", name], `${schema.typeName} requires property ${name}`));
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
