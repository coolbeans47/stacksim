import { collectDynamicReferences } from "./dynamic-references.js";

export type CloudFormationTemplateErrorKind =
  | "InvalidJson"
  | "InvalidTemplate"
  | "UnsupportedTemplateSection"
  | "UnsupportedTransform"
  | "UnsupportedMacro"
  | "UnsupportedNestedStack"
  | "UnsupportedWaitCondition"
  | "UnsupportedDynamicReference"
  | "UnsupportedCreationPolicy"
  | "UnsupportedUpdatePolicy";

/**
 * A pure template error which the CloudFormation HTTP facade can translate to
 * the service's public `ValidationError` response.
 */
export class TemplateValidationError extends Error {
  readonly code = "ValidationError" as const;

  constructor(
    public readonly kind: CloudFormationTemplateErrorKind,
    message: string,
    public readonly path = "$",
  ) {
    super(`${message} at ${path}`);
    this.name = "TemplateValidationError";
  }
}

// Keep the longer name available to callers that prefer service-qualified
// exports. Both names refer to the same error class.
export { TemplateValidationError as CloudFormationTemplateValidationError };

export interface CloudFormationParameter {
  Type: string;
  Default?: unknown;
  NoEcho?: boolean;
  AllowedValues?: unknown[];
  AllowedPattern?: string;
  MaxLength?: number;
  MinLength?: number;
  MaxValue?: number;
  MinValue?: number;
  ConstraintDescription?: string;
  Description?: string;
}

export interface CloudFormationRuleAssertion {
  Assert: unknown;
  AssertDescription?: string;
}

export interface CloudFormationRule {
  RuleCondition?: unknown;
  Assertions: CloudFormationRuleAssertion[];
}

export type CloudFormationRetentionPolicy = "Delete" | "Retain" | "RetainExceptOnCreate" | "Snapshot";

export interface CloudFormationResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | string[];
  Metadata?: Record<string, unknown>;
  Condition?: string;
  DeletionPolicy?: CloudFormationRetentionPolicy;
  UpdateReplacePolicy?: CloudFormationRetentionPolicy;
}

export interface CloudFormationOutput {
  Description?: string;
  Value: unknown;
  Export?: { Name: unknown };
  Condition?: string;
}

/** A structurally validated, JSON-backed CloudFormation template. */
export interface CloudFormationTemplate {
  AWSTemplateFormatVersion?: string;
  Description?: string;
  Metadata?: Record<string, unknown>;
  Parameters?: Record<string, CloudFormationParameter>;
  Rules?: Record<string, CloudFormationRule>;
  Mappings?: Record<string, Record<string, Record<string, unknown>>>;
  Conditions?: Record<string, unknown>;
  Resources: Record<string, CloudFormationResource>;
  Outputs?: Record<string, CloudFormationOutput>;
}

const TOP_LEVEL_SECTIONS = new Set([
  "AWSTemplateFormatVersion",
  "Description",
  "Metadata",
  "Parameters",
  "Rules",
  "Mappings",
  "Conditions",
  "Transform",
  "Resources",
  "Outputs",
]);

const PARAMETER_FIELDS = new Set([
  "Type",
  "Default",
  "NoEcho",
  "AllowedValues",
  "AllowedPattern",
  "MaxLength",
  "MinLength",
  "MaxValue",
  "MinValue",
  "ConstraintDescription",
  "Description",
]);

const RESOURCE_FIELDS = new Set([
  "Type",
  "Properties",
  "DependsOn",
  "Metadata",
  "Condition",
  "CreationPolicy",
  "UpdatePolicy",
  "DeletionPolicy",
  "UpdateReplacePolicy",
]);

const OUTPUT_FIELDS = new Set(["Description", "Value", "Export", "Condition"]);
const RULE_FIELDS = new Set(["RuleCondition", "Assertions"]);
const ASSERTION_FIELDS = new Set(["Assert", "AssertDescription"]);
const RETENTION_POLICIES = new Set<CloudFormationRetentionPolicy>(["Delete", "Retain", "RetainExceptOnCreate", "Snapshot"]);
const LOGICAL_ID = /^[A-Za-z0-9]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.startsWith("Fn::")
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function fail(kind: CloudFormationTemplateErrorKind, path: string, message: string): never {
  throw new TemplateValidationError(kind, message, path);
}

function expectObject(value: unknown, path: string, description: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail("InvalidTemplate", path, `${description} must be a JSON object`);
  return value;
}

function expectString(value: unknown, path: string, description: string): string {
  if (typeof value !== "string" || value.length === 0) fail("InvalidTemplate", path, `${description} must be a non-empty string`);
  return value;
}

function validateLogicalId(value: string, path: string, description: string): void {
  if (!LOGICAL_ID.test(value)) fail("InvalidTemplate", path, `${description} must contain only alphanumeric characters`);
}

function rejectUnknownFields(value: Record<string, unknown>, supported: ReadonlySet<string>, path: string, description: string): void {
  const unknown = Object.keys(value).filter(field => !supported.has(field)).sort()[0];
  if (unknown !== undefined) fail("InvalidTemplate", childPath(path, unknown), `${description} contains unsupported field ${JSON.stringify(unknown)}`);
}

function assertJsonValue(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("InvalidTemplate", path, "template numbers must be finite JSON numbers");
    return;
  }
  if (typeof value !== "object") fail("InvalidTemplate", path, "template values must be valid JSON values");
  if (ancestors.has(value)) fail("InvalidTemplate", path, "template values must not contain cycles");
  if (!Array.isArray(value) && !isPlainObject(value)) fail("InvalidTemplate", path, "template values must be JSON objects, arrays, or primitives");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, ancestors));
    } else {
      for (const [key, item] of Object.entries(value)) assertJsonValue(item, childPath(path, key), ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => cloneJson(item)) as T;
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)])) as T;
  return value;
}

function validateParameter(name: string, value: unknown): CloudFormationParameter {
  const path = childPath("$.Parameters", name);
  validateLogicalId(name, path, "parameter logical ID");
  const declaration = expectObject(value, path, "parameter declaration");
  rejectUnknownFields(declaration, PARAMETER_FIELDS, path, "parameter declaration");
  expectString(declaration.Type, `${path}.Type`, "parameter Type");

  if (declaration.NoEcho !== undefined && typeof declaration.NoEcho !== "boolean") fail("InvalidTemplate", `${path}.NoEcho`, "parameter NoEcho must be a boolean");
  if (declaration.AllowedValues !== undefined && !Array.isArray(declaration.AllowedValues)) fail("InvalidTemplate", `${path}.AllowedValues`, "parameter AllowedValues must be an array");
  if (declaration.AllowedPattern !== undefined && typeof declaration.AllowedPattern !== "string") fail("InvalidTemplate", `${path}.AllowedPattern`, "parameter AllowedPattern must be a string");
  for (const field of ["MaxLength", "MinLength", "MaxValue", "MinValue"] as const) {
    if (declaration[field] !== undefined && typeof declaration[field] !== "number") fail("InvalidTemplate", `${path}.${field}`, `parameter ${field} must be a number`);
  }
  for (const field of ["ConstraintDescription", "Description"] as const) {
    if (declaration[field] !== undefined && typeof declaration[field] !== "string") fail("InvalidTemplate", `${path}.${field}`, `parameter ${field} must be a string`);
  }
  return declaration as unknown as CloudFormationParameter;
}

function validateMappings(value: unknown): Record<string, Record<string, Record<string, unknown>>> {
  const mappings = expectObject(value, "$.Mappings", "Mappings section");
  for (const [mappingName, rawMapping] of Object.entries(mappings)) {
    const path = childPath("$.Mappings", mappingName);
    validateLogicalId(mappingName, path, "mapping name");
    const mapping = expectObject(rawMapping, path, "mapping");
    for (const [topLevelKey, rawValues] of Object.entries(mapping)) {
      expectObject(rawValues, childPath(path, topLevelKey), "mapping entry");
    }
  }
  return mappings as Record<string, Record<string, Record<string, unknown>>>;
}

function validateRule(name: string, value: unknown): CloudFormationRule {
  const path = childPath("$.Rules", name);
  validateLogicalId(name, path, "rule logical ID");
  const rule = expectObject(value, path, "rule declaration");
  rejectUnknownFields(rule, RULE_FIELDS, path, "rule declaration");
  if (!Array.isArray(rule.Assertions) || rule.Assertions.length === 0) fail("InvalidTemplate", `${path}.Assertions`, "rule Assertions must be a non-empty array");
  rule.Assertions.forEach((rawAssertion, index) => {
    const assertionPath = `${path}.Assertions[${index}]`;
    const assertion = expectObject(rawAssertion, assertionPath, "rule assertion");
    rejectUnknownFields(assertion, ASSERTION_FIELDS, assertionPath, "rule assertion");
    if (!("Assert" in assertion)) fail("InvalidTemplate", `${assertionPath}.Assert`, "rule assertion requires Assert");
    if (assertion.AssertDescription !== undefined && typeof assertion.AssertDescription !== "string") fail("InvalidTemplate", `${assertionPath}.AssertDescription`, "AssertDescription must be a string");
  });
  return rule as unknown as CloudFormationRule;
}

function validateResource(logicalId: string, value: unknown): CloudFormationResource {
  const path = childPath("$.Resources", logicalId);
  validateLogicalId(logicalId, path, "resource logical ID");
  const resource = expectObject(value, path, "resource declaration");
  rejectUnknownFields(resource, RESOURCE_FIELDS, path, "resource declaration");
  const type = expectString(resource.Type, `${path}.Type`, "resource Type");

  if (resource.CreationPolicy !== undefined) fail("UnsupportedCreationPolicy", `${path}.CreationPolicy`, "CreationPolicy is not supported in CFN-02");
  if (resource.UpdatePolicy !== undefined) fail("UnsupportedUpdatePolicy", `${path}.UpdatePolicy`, "UpdatePolicy is not supported in CFN-02");
  if (type === "AWS::CloudFormation::WaitCondition" || type === "AWS::CloudFormation::WaitConditionHandle") fail("UnsupportedWaitCondition", `${path}.Type`, "wait conditions are not supported in CFN-02");
  if (type === "AWS::CloudFormation::Macro") fail("UnsupportedMacro", `${path}.Type`, "CloudFormation macros are not supported in CFN-02");

  if (resource.Properties !== undefined) expectObject(resource.Properties, `${path}.Properties`, "resource Properties");
  if (resource.Metadata !== undefined) expectObject(resource.Metadata, `${path}.Metadata`, "resource Metadata");
  if (resource.Condition !== undefined) expectString(resource.Condition, `${path}.Condition`, "resource Condition");
  if (resource.DependsOn !== undefined) {
    const dependencies = typeof resource.DependsOn === "string" ? [resource.DependsOn] : resource.DependsOn;
    if (!Array.isArray(dependencies)) fail("InvalidTemplate", `${path}.DependsOn`, "DependsOn must be a logical ID or an array of logical IDs");
    dependencies.forEach((dependency, index) => {
      if (typeof dependency !== "string" || dependency.length === 0) fail("InvalidTemplate", `${path}.DependsOn[${index}]`, "DependsOn entries must be non-empty logical IDs");
      validateLogicalId(dependency, `${path}.DependsOn[${index}]`, "DependsOn logical ID");
    });
  }
  for (const field of ["DeletionPolicy", "UpdateReplacePolicy"] as const) {
    const policy = resource[field];
    if (policy !== undefined && (typeof policy !== "string" || !RETENTION_POLICIES.has(policy as CloudFormationRetentionPolicy))) {
      fail("InvalidTemplate", `${path}.${field}`, `${field} must be Delete, Retain, RetainExceptOnCreate, or Snapshot`);
    }
  }
  return resource as unknown as CloudFormationResource;
}

function validateOutput(logicalId: string, value: unknown): CloudFormationOutput {
  const path = childPath("$.Outputs", logicalId);
  validateLogicalId(logicalId, path, "output logical ID");
  const output = expectObject(value, path, "output declaration");
  rejectUnknownFields(output, OUTPUT_FIELDS, path, "output declaration");
  if (!("Value" in output)) fail("InvalidTemplate", `${path}.Value`, "output declaration requires Value");
  if (output.Description !== undefined && typeof output.Description !== "string") fail("InvalidTemplate", `${path}.Description`, "output Description must be a string");
  if (output.Condition !== undefined) expectString(output.Condition, `${path}.Condition`, "output Condition");
  if (output.Export !== undefined) {
    const exportValue = expectObject(output.Export, `${path}.Export`, "output Export");
    rejectUnknownFields(exportValue, new Set(["Name"]), `${path}.Export`, "output Export");
    if (!("Name" in exportValue)) fail("InvalidTemplate", `${path}.Export.Name`, "output Export requires Name");
  }
  return output as unknown as CloudFormationOutput;
}

function rejectUnsupportedValues(value: unknown, path: string): void {
  if (typeof value === "string") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectUnsupportedValues(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  if (Object.prototype.hasOwnProperty.call(value, "Fn::Transform")) fail("UnsupportedMacro", childPath(path, "Fn::Transform"), "Fn::Transform macros are not supported in CFN-02");
  for (const [key, item] of Object.entries(value)) rejectUnsupportedValues(item, childPath(path, key));
}

function validateConditionUses(template: CloudFormationTemplate): void {
  const conditions = new Set(Object.keys(template.Conditions ?? {}));
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (resource.Condition !== undefined && !conditions.has(resource.Condition)) fail("InvalidTemplate", `${childPath("$.Resources", logicalId)}.Condition`, `resource references missing condition ${JSON.stringify(resource.Condition)}`);
  }
  for (const [logicalId, output] of Object.entries(template.Outputs ?? {})) {
    if (output.Condition !== undefined && !conditions.has(output.Condition)) fail("InvalidTemplate", `${childPath("$.Outputs", logicalId)}.Condition`, `output references missing condition ${JSON.stringify(output.Condition)}`);
  }
}

/**
 * Parse a JSON TemplateBody (or validate an already parsed JSON value).
 * YAML ingestion is intentionally outside the CFN-02 contract.
 */
export function parseCloudFormationTemplate(templateBody: string | unknown): CloudFormationTemplate {
  let parsed: unknown = templateBody;
  if (typeof templateBody === "string") {
    try {
      parsed = JSON.parse(templateBody);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail("InvalidJson", "$", `template body must be valid JSON; YAML is not supported in CFN-02 (${detail})`);
    }
  }

  assertJsonValue(parsed, "$", new Set());
  const root = expectObject(parsed, "$", "template");

  if (Object.prototype.hasOwnProperty.call(root, "Transform")) fail("UnsupportedTransform", "$.Transform", "template transforms are not supported in CFN-02");
  if (Object.prototype.hasOwnProperty.call(root, "Macros")) fail("UnsupportedMacro", "$.Macros", "template macros are not supported in CFN-02");
  const unsupportedSection = Object.keys(root).filter(section => !TOP_LEVEL_SECTIONS.has(section)).sort()[0];
  if (unsupportedSection !== undefined) fail("UnsupportedTemplateSection", childPath("$", unsupportedSection), `unsupported template section ${JSON.stringify(unsupportedSection)}`);

  if (root.AWSTemplateFormatVersion !== undefined) {
    if (root.AWSTemplateFormatVersion !== "2010-09-09") fail("InvalidTemplate", "$.AWSTemplateFormatVersion", "AWSTemplateFormatVersion must be 2010-09-09");
  }
  if (root.Description !== undefined && typeof root.Description !== "string") fail("InvalidTemplate", "$.Description", "template Description must be a string");
  if (root.Metadata !== undefined) expectObject(root.Metadata, "$.Metadata", "template Metadata");
  if (!Object.prototype.hasOwnProperty.call(root, "Resources")) fail("InvalidTemplate", "$.Resources", "template requires a Resources section");

  const resourcesObject = expectObject(root.Resources, "$.Resources", "Resources section");
  const resources = Object.fromEntries(Object.entries(resourcesObject).map(([logicalId, resource]) => [logicalId, validateResource(logicalId, resource)]));

  let parameters: Record<string, CloudFormationParameter> | undefined;
  if (root.Parameters !== undefined) {
    const section = expectObject(root.Parameters, "$.Parameters", "Parameters section");
    parameters = Object.fromEntries(Object.entries(section).map(([name, value]) => [name, validateParameter(name, value)]));
  }

  let mappings: Record<string, Record<string, Record<string, unknown>>> | undefined;
  if (root.Mappings !== undefined) mappings = validateMappings(root.Mappings);

  let conditions: Record<string, unknown> | undefined;
  if (root.Conditions !== undefined) {
    const section = expectObject(root.Conditions, "$.Conditions", "Conditions section");
    for (const name of Object.keys(section)) validateLogicalId(name, childPath("$.Conditions", name), "condition logical ID");
    conditions = section;
  }

  let rules: Record<string, CloudFormationRule> | undefined;
  if (root.Rules !== undefined) {
    const section = expectObject(root.Rules, "$.Rules", "Rules section");
    rules = Object.fromEntries(Object.entries(section).map(([name, value]) => [name, validateRule(name, value)]));
  }

  let outputs: Record<string, CloudFormationOutput> | undefined;
  if (root.Outputs !== undefined) {
    const section = expectObject(root.Outputs, "$.Outputs", "Outputs section");
    outputs = Object.fromEntries(Object.entries(section).map(([logicalId, value]) => [logicalId, validateOutput(logicalId, value)]));
  }

  const template: CloudFormationTemplate = cloneJson({
    ...(root.AWSTemplateFormatVersion === undefined ? {} : { AWSTemplateFormatVersion: root.AWSTemplateFormatVersion }),
    ...(root.Description === undefined ? {} : { Description: root.Description }),
    ...(root.Metadata === undefined ? {} : { Metadata: root.Metadata as Record<string, unknown> }),
    ...(parameters === undefined ? {} : { Parameters: parameters }),
    ...(rules === undefined ? {} : { Rules: rules }),
    ...(mappings === undefined ? {} : { Mappings: mappings }),
    ...(conditions === undefined ? {} : { Conditions: conditions }),
    Resources: resources,
    ...(outputs === undefined ? {} : { Outputs: outputs }),
  });

  const dynamicReferences = collectDynamicReferences(template);
  if (dynamicReferences.length > 60) fail("InvalidTemplate", "$", "a template can contain at most 60 dynamic references");
  for (const reference of dynamicReferences) {
    if (reference.path.includes(".Metadata")) fail("UnsupportedDynamicReference", reference.path, "dynamic references are not supported in metadata");
    if (reference.path.startsWith("$.Outputs.")) fail("UnsupportedDynamicReference", reference.path, "dynamic references are not supported in outputs");
    if (!reference.path.includes(".Properties")) fail("UnsupportedDynamicReference", reference.path, "dynamic references are supported only in resource properties");
  }

  rejectUnsupportedValues(template, "$");
  validateConditionUses(template);
  return template;
}

export const parseTemplate = parseCloudFormationTemplate;

/** Validate an object while preserving the familiar validator naming. */
export function validateCloudFormationTemplate(template: unknown): CloudFormationTemplate {
  return parseCloudFormationTemplate(template);
}

export const validateTemplate = validateCloudFormationTemplate;
