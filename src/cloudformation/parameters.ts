import type { CloudFormationParameter, CloudFormationTemplate } from "./template.js";
import { evaluateIntrinsicValue, IntrinsicEvaluationError } from "./intrinsics.js";

export interface ParameterInput {
  parameterKey: string;
  parameterValue?: string;
  usePreviousValue?: boolean;
  resolvedValue?: string;
}

export interface ResolvedParameter {
  parameterKey: string;
  parameterValue: string;
  resolvedValue?: string;
  noEcho: boolean;
  value: unknown;
}

export interface ResolvedParameters {
  values: Record<string, unknown>;
  entries: ResolvedParameter[];
  noEchoNames: string[];
}

export interface ParameterResolutionOptions {
  previous?: Readonly<Record<string, string>>;
  resolveSsmParameter?: (name: string, type: string) => string;
}

export class ParameterValidationError extends Error {
  readonly code = "ValidationError" as const;
  constructor(message: string, readonly path = "$.Parameters") { super(`${message} at ${path}`); this.name = "ParameterValidationError"; }
}

function fail(message: string, path?: string): never { throw new ParameterValidationError(message, path); }

function scalar(value: unknown, name: string): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return fail(`Default for parameter ${name} must be a scalar value`, `$.Parameters.${name}.Default`);
}

function normalizedValue(name: string, declaration: CloudFormationParameter, supplied: string, resolveSsmParameter?: ParameterResolutionOptions["resolveSsmParameter"]): { value: unknown; resolvedValue?: string } {
  const type = declaration.Type;
  if (type.startsWith("AWS::SSM::Parameter::Value<")) {
    if (type !== "AWS::SSM::Parameter::Value<String>") fail(`Unsupported supplied parameter type ${type}; only AWS::SSM::Parameter::Value<String> is supported`, `$.Parameters.${name}.Type`);
    if (!resolveSsmParameter) fail(`Parameter ${name} requires the CFN-04 bootstrap SSM parameter resolver`, `$.Parameters.${name}.Type`);
    const resolvedValue = resolveSsmParameter(supplied, type); return { value: resolvedValue, resolvedValue };
  }
  if (type === "String") return { value: supplied };
  if (type === "Number") {
    const numeric = Number(supplied); if (!Number.isFinite(numeric)) fail(`Parameter ${name} must be a number`, `$.Parameters.${name}`); return { value: supplied };
  }
  if (type === "CommaDelimitedList") return { value: supplied.split(",").map(value => value.trim()) };
  if (type === "List<Number>") {
    const values = supplied.split(",").map(value => value.trim()); if (values.some(value => !Number.isFinite(Number(value)))) fail(`Parameter ${name} must be a comma-delimited list of numbers`, `$.Parameters.${name}`); return { value: values };
  }
  if (/^List<AWS::[^>]+>$/.test(type) || /^AWS::[^:]+::[^:]+::/.test(type)) fail(`Parameter type ${type} requires an AWS-specific resolver assigned to a later CloudFormation phase`, `$.Parameters.${name}.Type`);
  fail(`Unsupported parameter type ${type}`, `$.Parameters.${name}.Type`);
}

function enforceConstraints(name: string, declaration: CloudFormationParameter, supplied: string, value: unknown): void {
  const path = `$.Parameters.${name}`;
  const values = Array.isArray(value) ? value.map(String) : [supplied];
  if (declaration.AllowedValues && !values.every(candidate => declaration.AllowedValues!.some(allowed => String(allowed) === candidate))) fail(declaration.ConstraintDescription ?? `Parameter ${name} must be one of the allowed values`, path);
  if (declaration.AllowedPattern !== undefined) {
    let pattern: RegExp; try { pattern = new RegExp(`^(?:${declaration.AllowedPattern})$`); } catch { fail(`Parameter ${name} has an invalid AllowedPattern`, `$.Parameters.${name}.AllowedPattern`); }
    if (!values.every(candidate => pattern.test(candidate))) fail(declaration.ConstraintDescription ?? `Parameter ${name} must match the allowed pattern`, path);
  }
  if (declaration.MinLength !== undefined && values.some(candidate => [...candidate].length < declaration.MinLength!)) fail(declaration.ConstraintDescription ?? `Parameter ${name} is shorter than MinLength`, path);
  if (declaration.MaxLength !== undefined && values.some(candidate => [...candidate].length > declaration.MaxLength!)) fail(declaration.ConstraintDescription ?? `Parameter ${name} is longer than MaxLength`, path);
  if (declaration.MinValue !== undefined && values.some(candidate => Number(candidate) < declaration.MinValue!)) fail(declaration.ConstraintDescription ?? `Parameter ${name} is below MinValue`, path);
  if (declaration.MaxValue !== undefined && values.some(candidate => Number(candidate) > declaration.MaxValue!)) fail(declaration.ConstraintDescription ?? `Parameter ${name} exceeds MaxValue`, path);
}

export function resolveTemplateParameters(declarations: Readonly<Record<string, CloudFormationParameter>> = {}, suppliedInputs: readonly ParameterInput[] = [], options: ParameterResolutionOptions = {}): ResolvedParameters {
  if (Object.keys(declarations).length > 200) fail("A template can declare at most 200 parameters");
  const supplied = new Map<string, ParameterInput>();
  for (const input of suppliedInputs) {
    if (!Object.hasOwn(declarations, input.parameterKey)) fail(`Parameters contains unknown key ${input.parameterKey}`);
    if (supplied.has(input.parameterKey)) fail(`Parameters contains duplicate key ${input.parameterKey}`);
    supplied.set(input.parameterKey, input);
  }
  const entries: ResolvedParameter[] = [];
  for (const name of Object.keys(declarations).sort()) {
    const declaration = declarations[name]; const input = supplied.get(name); let parameterValue: string;
    if (input?.usePreviousValue) {
      const previous = options.previous?.[name]; if (previous === undefined) fail(`Parameter ${name} cannot use a previous value for this operation`, `$.Parameters.${name}`); parameterValue = previous;
    } else if (input?.parameterValue !== undefined) parameterValue = input.parameterValue;
    else if (declaration.Default !== undefined) parameterValue = scalar(declaration.Default, name);
    else fail(`Parameters must have values for ${name}`, `$.Parameters.${name}`);
    const normalized = normalizedValue(name, declaration, parameterValue, options.resolveSsmParameter); enforceConstraints(name, declaration, parameterValue, normalized.value);
    entries.push({ parameterKey: name, parameterValue, resolvedValue: normalized.resolvedValue, noEcho: declaration.NoEcho === true, value: normalized.value });
  }
  return { values: Object.fromEntries(entries.map(entry => [entry.parameterKey, entry.value])), entries, noEchoNames: entries.filter(entry => entry.noEcho).map(entry => entry.parameterKey) };
}

export function publicParameterEntries(parameters: ResolvedParameters): Array<{ parameterKey: string; parameterValue: string; resolvedValue?: string }> {
  return parameters.entries.map(entry => ({ parameterKey: entry.parameterKey, parameterValue: entry.noEcho ? "****" : entry.parameterValue, ...(entry.resolvedValue === undefined ? {} : { resolvedValue: entry.noEcho ? "****" : entry.resolvedValue }) }));
}

export function cloudFormationPseudoParameters(accountId: string, region: string, stackId: string, stackName: string, partition = "aws"): Record<string, unknown> {
  return { "AWS::AccountId": accountId, "AWS::Region": region, "AWS::StackId": stackId, "AWS::StackName": stackName, "AWS::Partition": partition, "AWS::URLSuffix": "amazonaws.com", "AWS::NotificationARNs": [] };
}

export function evaluateTemplateConditions(template: CloudFormationTemplate, parameters: Readonly<Record<string, unknown>>, pseudoParameters: Readonly<Record<string, unknown>>, imports: Readonly<Record<string, unknown>> = {}): Record<string, boolean> {
  const pending = new Map(Object.entries(template.Conditions ?? {}).sort(([left], [right]) => left.localeCompare(right))); const resolved: Record<string, boolean> = {};
  while (pending.size) {
    let progressed = false;
    for (const [name, expression] of pending) {
      try {
        const value = evaluateIntrinsicValue(expression, { parameters, pseudoParameters, mappings: template.Mappings, conditions: resolved, imports }, `$.Conditions.${name}`);
        if (typeof value !== "boolean") fail(`Condition ${name} must evaluate to a boolean`, `$.Conditions.${name}`);
        resolved[name] = value; pending.delete(name); progressed = true;
      } catch (error) {
        if (error instanceof IntrinsicEvaluationError && /Unknown condition/.test(error.message)) continue;
        throw error;
      }
    }
    if (!progressed) fail(`Conditions contain an unresolved or circular reference: ${[...pending.keys()].join(", ")}`, "$.Conditions");
  }
  return resolved;
}

export function validateTemplateRules(template: CloudFormationTemplate, parameters: Readonly<Record<string, unknown>>, pseudoParameters: Readonly<Record<string, unknown>>, conditions: Readonly<Record<string, boolean>>, imports: Readonly<Record<string, unknown>> = {}): void {
  for (const [name, rule] of Object.entries(template.Rules ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    const context = { parameters, pseudoParameters, mappings: template.Mappings, conditions, imports };
    if (rule.RuleCondition !== undefined && evaluateIntrinsicValue(rule.RuleCondition, context, `$.Rules.${name}.RuleCondition`) !== true) continue;
    rule.Assertions.forEach((assertion, index) => {
      if (evaluateIntrinsicValue(assertion.Assert, context, `$.Rules.${name}.Assertions[${index}].Assert`) !== true) fail(assertion.AssertDescription ?? `Rule ${name} assertion failed`, `$.Rules.${name}.Assertions[${index}]`);
    });
  }
}

export function conditionallyProcessedTemplate(template: CloudFormationTemplate, conditions: Readonly<Record<string, boolean>>): CloudFormationTemplate {
  const omitted = Symbol("conditionally omitted");
  const prune = (value: unknown, path: string): unknown | typeof omitted => {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      value.forEach((item, index) => {
        const selected = prune(item, `${path}[${index}]`);
        if (selected !== omitted) result.push(selected);
      });
      return result;
    }
    if (value === null || typeof value !== "object") return value;

    const source = value as Record<string, unknown>;
    const keys = Object.keys(source);
    if (keys.length === 1 && keys[0] === "Ref" && source.Ref === "AWS::NoValue") return omitted;
    if (keys.length === 1 && keys[0] === "Fn::If") {
      const expression = source["Fn::If"];
      if (!Array.isArray(expression) || expression.length !== 3 || typeof expression[0] !== "string" || !expression[0]) {
        throw new IntrinsicEvaluationError("Fn::If requires a condition name and true/false values", path);
      }
      const conditionName = expression[0];
      if (!Object.prototype.hasOwnProperty.call(conditions, conditionName)) throw new IntrinsicEvaluationError(`Unknown condition ${conditionName}`, path);
      return prune(conditions[conditionName] ? expression[1] : expression[2], path);
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      const selected = prune(item, `${path}.${key}`);
      if (selected !== omitted) result[key] = selected;
    }
    return result;
  };
  const included = (condition: string | undefined): boolean => condition === undefined || conditions[condition] === true;
  const resources = Object.fromEntries(Object.entries(template.Resources)
    .filter(([, resource]) => included(resource.Condition))
    .map(([name, resource]) => [name, prune(resource, `$.Resources.${name}`)])) as CloudFormationTemplate["Resources"];
  const outputs = template.Outputs === undefined ? undefined : Object.fromEntries(Object.entries(template.Outputs)
    .filter(([, output]) => included(output.Condition))
    .map(([name, output]) => [name, prune(output, `$.Outputs.${name}`)])) as NonNullable<CloudFormationTemplate["Outputs"]>;
  return { ...structuredClone(template), Resources: resources, ...(outputs === undefined ? {} : { Outputs: outputs }) };
}
