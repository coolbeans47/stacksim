import { providerValidationPathSegments } from "./contract.js";
import { createHash } from "node:crypto";
import {
  ProviderReferenceError,
  type ProductionResourceProvider,
  type ProviderContext,
  type ProviderDeleteResult,
  type ProviderInProgress,
  type ProviderPlan,
  type ProviderReadModel,
  type ProviderReadResult,
  type ProviderSchema,
  type ProviderSuccess,
  type ProviderUpdateResult,
  type ProviderValidationIssue,
  validateDeclaredProperties,
} from "./contract.js";

export const CLOUDFORMATION_NESTED_STACK_TYPE = "AWS::CloudFormation::Stack";

export interface NestedStackTag {
  readonly Key: string;
  readonly Value: string;
}

export interface NestedStackModel {
  readonly TemplateURL: string;
  readonly Parameters?: Readonly<Record<string, string>>;
  readonly TimeoutInMinutes?: number;
  readonly NotificationARNs?: readonly string[];
  readonly Tags?: readonly NestedStackTag[];
}

export interface NestedStackSnapshot {
  readonly stackId: string;
  readonly status: string;
  readonly outputs: Readonly<Record<string, string>>;
  readonly properties: NestedStackModel;
}

export interface NestedStackAdapter {
  create(desired: NestedStackModel, context: ProviderContext): Promise<NestedStackSnapshot | ProviderInProgress | { status: "FAILED"; errorCode: string; message: string; physicalId?: string }>;
  read(stackId: string, context: ProviderContext): Promise<NestedStackSnapshot | undefined>;
  update(stackId: string, previous: NestedStackModel, desired: NestedStackModel, context: ProviderContext): Promise<NestedStackSnapshot | ProviderInProgress | { status: "FAILED"; errorCode: string; message: string }>;
  delete(stackId: string, previous: NestedStackModel, context: ProviderContext): Promise<"DELETED" | ProviderInProgress | { status: "FAILED"; errorCode: string; message: string }>;
}

export const CLOUDFORMATION_NESTED_STACK_SCHEMA: ProviderSchema = Object.freeze({
  typeName: CLOUDFORMATION_NESTED_STACK_TYPE,
  unknownProperties: "REJECT",
  properties: Object.freeze({
    TemplateURL: Object.freeze({ valueType: "string", required: true, updateBehavior: "MUTABLE" }),
    Parameters: Object.freeze({ valueType: "object", updateBehavior: "MUTABLE" }),
    TimeoutInMinutes: Object.freeze({ valueType: "number", updateBehavior: "NOT_SUPPORTED" }),
    NotificationARNs: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
    Tags: Object.freeze({ valueType: "array", updateBehavior: "MUTABLE" }),
  }),
  ref: Object.freeze({ supported: true, valueType: "string", description: "Nested child stack ID" }),
  // Output attributes are validated by the engine as the bounded dynamic
  // Outputs.<LogicalId> family. They are materialized in every read model.
  attributes: Object.freeze({}),
  replacement: Object.freeze({ defaultOrder: "CREATE_BEFORE_DELETE" }),
  retention: Object.freeze({
    deletionPolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    updateReplacePolicies: Object.freeze(["Delete", "Retain", "RetainExceptOnCreate"] as const),
    snapshotSupported: false,
  }),
  tags: Object.freeze({ behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true }),
});

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function issue(issues: ProviderValidationIssue[], path: string, message: string): void {
  issues.push({ code: "InvalidProperty", path, pathSegments: providerValidationPathSegments(path), message });
}

function validateNestedStack(properties: unknown): ProviderValidationIssue[] {
  const issues = validateDeclaredProperties(properties ?? {}, CLOUDFORMATION_NESTED_STACK_SCHEMA);
  if (!record(properties)) return issues;
  if (typeof properties.TemplateURL === "string" && (properties.TemplateURL.length < 1 || properties.TemplateURL.length > 1024)) {
    issue(issues, "Properties.TemplateURL", "TemplateURL must contain 1-1024 characters");
  }
  if (properties.Parameters !== undefined && record(properties.Parameters)) {
    for (const [name, value] of Object.entries(properties.Parameters)) {
      if (!/^[A-Za-z0-9]+$/.test(name)) issue(issues, `Properties.Parameters.${name}`, "Parameter names must contain only alphanumeric characters");
      if (typeof value !== "string") issue(issues, `Properties.Parameters.${name}`, "Nested stack parameter values must resolve to strings");
    }
  }
  if (properties.TimeoutInMinutes !== undefined && (!Number.isInteger(properties.TimeoutInMinutes) || Number(properties.TimeoutInMinutes) < 1)) {
    issue(issues, "Properties.TimeoutInMinutes", "TimeoutInMinutes must be an integer of at least 1");
  }
  if (properties.NotificationARNs !== undefined && Array.isArray(properties.NotificationARNs)) {
    if (properties.NotificationARNs.length > 5) issue(issues, "Properties.NotificationARNs", "NotificationARNs supports at most five topics");
    const arns = properties.NotificationARNs.map(String);
    if (new Set(arns).size !== arns.length) issue(issues, "Properties.NotificationARNs", "NotificationARNs cannot contain duplicates");
    arns.forEach((arn, index) => {
      if (!/^arn:[a-z0-9-]+:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_.-]+$/.test(arn)) issue(issues, `Properties.NotificationARNs.${index}`, "NotificationARNs entries must be SNS topic ARNs");
    });
  }
  if (properties.Tags !== undefined && Array.isArray(properties.Tags)) {
    if (properties.Tags.length > 50) issue(issues, "Properties.Tags", "Tags supports at most 50 entries");
    const keys = new Set<string>();
    properties.Tags.forEach((tag, index) => {
      if (!record(tag) || Object.keys(tag).some(key => key !== "Key" && key !== "Value") || typeof tag.Key !== "string" || typeof tag.Value !== "string") {
        issue(issues, `Properties.Tags.${index}`, "Each tag must contain string Key and Value fields only");
        return;
      }
      if (!tag.Key || tag.Key.length > 128 || String(tag.Value).length > 256) issue(issues, `Properties.Tags.${index}`, "Tag keys must contain 1-128 characters and values at most 256 characters");
      if (tag.Key.startsWith("aws:")) issue(issues, `Properties.Tags.${index}.Key`, "Reserved aws: tag keys cannot be supplied");
      if (keys.has(tag.Key)) issue(issues, `Properties.Tags.${index}.Key`, `Duplicate tag key ${tag.Key}`);
      keys.add(tag.Key);
    });
  }
  return issues;
}

function stable<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stable) as T;
  if (record(value)) return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)])) as T;
  return value;
}

function canonicalModel(properties: Record<string, unknown>): NestedStackModel {
  const parameters = properties.Parameters === undefined ? undefined : Object.freeze(stable(structuredClone(properties.Parameters as Record<string, string>)));
  const notifications = properties.NotificationARNs === undefined ? undefined : Object.freeze((properties.NotificationARNs as unknown[]).map(String));
  const tags = properties.Tags === undefined ? undefined : Object.freeze((properties.Tags as Array<Record<string, unknown>>).map(tag => ({ Key: String(tag.Key), Value: String(tag.Value) })).sort((left, right) => left.Key.localeCompare(right.Key)));
  return Object.freeze({
    TemplateURL: String(properties.TemplateURL),
    ...(parameters ? { Parameters: parameters } : {}),
    ...(properties.TimeoutInMinutes === undefined ? {} : { TimeoutInMinutes: Number(properties.TimeoutInMinutes) }),
    ...(notifications ? { NotificationARNs: notifications } : {}),
    ...(tags ? { Tags: tags } : {}),
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function success(snapshot: NestedStackSnapshot): ProviderSuccess<NestedStackModel> {
  return {
    status: "SUCCESS",
    physicalId: snapshot.stackId,
    model: {
      physicalId: snapshot.stackId,
      properties: snapshot.properties,
      attributes: Object.fromEntries(Object.entries(snapshot.outputs).map(([name, value]) => [`Outputs.${name}`, value])),
    },
  };
}

export function createNestedStackProvider(adapter: NestedStackAdapter): ProductionResourceProvider<NestedStackModel> {
  return {
    typeName: CLOUDFORMATION_NESTED_STACK_TYPE,
    providerVersion: 1,
    visibility: "production",
    schema: CLOUDFORMATION_NESTED_STACK_SCHEMA,

    validate(properties: unknown): readonly ProviderValidationIssue[] {
      return validateNestedStack(properties);
    },

    canonicalize(properties: unknown): NestedStackModel {
      if (!record(properties)) throw new TypeError(`${CLOUDFORMATION_NESTED_STACK_TYPE} Properties must be an object`);
      const issues = validateNestedStack(properties);
      if (issues.length) throw new TypeError(issues.map(item => `${item.path}: ${item.message}`).join("; "));
      return canonicalModel(properties);
    },

    plan(previous: NestedStackModel | undefined, desired: NestedStackModel): ProviderPlan<NestedStackModel> {
      if (!previous) return { action: "CREATE", desired, changedProperties: Object.keys(desired).sort(), replacementProperties: [] };
      const names = [...new Set([...Object.keys(previous), ...Object.keys(desired)])].sort();
      const changed = names.filter(name => digest((previous as any)[name]) !== digest((desired as any)[name]));
      if (!changed.length) return { action: "NO_OP", desired, changedProperties: [], replacementProperties: [] };
      if (changed.includes("TimeoutInMinutes")) throw new TypeError("Properties.TimeoutInMinutes is create-only and cannot be updated");
      return { action: "UPDATE", desired, changedProperties: changed, replacementProperties: [] };
    },

    async create(desired: NestedStackModel, context: ProviderContext) {
      const result = await adapter.create(desired, context);
      return "stackId" in result ? success(result) : result;
    },

    async read(stackId: string, context: ProviderContext): Promise<ProviderReadResult<NestedStackModel>> {
      const snapshot = await adapter.read(stackId, context);
      return snapshot ? success(snapshot) : { status: "NOT_FOUND", physicalId: stackId, message: "Nested child stack no longer exists" };
    },

    async update(stackId: string, previous: NestedStackModel, desired: NestedStackModel, context: ProviderContext): Promise<ProviderUpdateResult<NestedStackModel>> {
      const result = await adapter.update(stackId, previous, desired, context);
      return "stackId" in result ? success(result) : result;
    },

    async delete(stackId: string, previous: NestedStackModel, context: ProviderContext): Promise<ProviderDeleteResult> {
      const result = await adapter.delete(stackId, previous, context);
      return result === "DELETED" ? { status: "SUCCESS", physicalId: stackId } : result;
    },

    ref(model: ProviderReadModel<NestedStackModel>): unknown {
      return model.physicalId;
    },

    getAtt(model: ProviderReadModel<NestedStackModel>, attribute: string): unknown {
      if (!attribute.startsWith("Outputs.") || !Object.hasOwn(model.attributes, attribute)) {
        throw new ProviderReferenceError(CLOUDFORMATION_NESTED_STACK_TYPE, `Fn::GetAtt ${attribute}`);
      }
      return model.attributes[attribute];
    },
  };
}
