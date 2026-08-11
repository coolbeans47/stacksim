import type { CloudFormationTemplate } from "./template.js";

export const CLOUDFORMATION_PSEUDO_PARAMETERS = new Set([
  "AWS::AccountId",
  "AWS::NotificationARNs",
  "AWS::NoValue",
  "AWS::Partition",
  "AWS::Region",
  "AWS::StackId",
  "AWS::StackName",
  "AWS::URLSuffix",
]);

export type DependencyGraphErrorKind =
  | "InvalidDependencyExpression"
  | "MissingReference"
  | "MissingCondition"
  | "CircularDependency";

export class DependencyGraphError extends Error {
  readonly code = "ValidationError" as const;

  constructor(
    public readonly kind: DependencyGraphErrorKind,
    message: string,
    public readonly path: string,
    public readonly details: {
      sourceLogicalId?: string;
      targetLogicalId?: string;
      cycle?: string[];
    } = {},
  ) {
    super(`${message} at ${path}`);
    this.name = "DependencyGraphError";
  }
}

export { DependencyGraphError as CloudFormationDependencyGraphError };

export type DependencyReferenceKind = "DependsOn" | "Ref" | "Fn::GetAtt" | "Fn::Sub";

export interface DependencyReference {
  /** Undefined for a reference in an output, condition, or rule. */
  sourceLogicalId?: string;
  targetLogicalId: string;
  kind: DependencyReferenceKind;
  path: string;
}

/** Serializable graph state suitable for operation snapshots and journals. */
export interface ResourceDependencyGraph {
  /** Resource -> resources which must stabilize first. */
  dependencies: Record<string, string[]>;
  /** Resource -> resources which directly depend on it. */
  dependents: Record<string, string[]>;
  /** Dependencies-first, lexically stable topological order. */
  order: string[];
  /** All explicit and implicit resource-reference sites. */
  references: DependencyReference[];
}

interface ReferenceScanContext {
  resourceIds: ReadonlySet<string>;
  parameterIds: ReadonlySet<string>;
  conditionIds: ReadonlySet<string>;
  references: DependencyReference[];
  missing: DependencyGraphError[];
  sourceLogicalId?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.startsWith("Fn::") ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function invalid(path: string, message: string, sourceLogicalId?: string): never {
  throw new DependencyGraphError("InvalidDependencyExpression", message, path, { sourceLogicalId });
}

function addMissing(
  context: ReferenceScanContext,
  kind: "MissingReference" | "MissingCondition",
  target: string,
  path: string,
  message: string,
): void {
  context.missing.push(new DependencyGraphError(kind, message, path, {
    ...(context.sourceLogicalId === undefined ? {} : { sourceLogicalId: context.sourceLogicalId }),
    targetLogicalId: target,
  }));
}

function addResourceReference(
  context: ReferenceScanContext,
  target: string,
  kind: DependencyReferenceKind,
  path: string,
  resourceRequired = false,
): void {
  if (context.resourceIds.has(target)) {
    context.references.push({
      ...(context.sourceLogicalId === undefined ? {} : { sourceLogicalId: context.sourceLogicalId }),
      targetLogicalId: target,
      kind,
      path,
    });
    return;
  }
  if (!resourceRequired && (context.parameterIds.has(target) || CLOUDFORMATION_PSEUDO_PARAMETERS.has(target))) return;
  addMissing(
    context,
    "MissingReference",
    target,
    path,
    resourceRequired
      ? `reference targets missing resource ${JSON.stringify(target)}`
      : `reference targets missing resource or parameter ${JSON.stringify(target)}`,
  );
}

function parseGetAttTarget(value: unknown, path: string, sourceLogicalId?: string): string {
  if (typeof value === "string") {
    const separator = value.indexOf(".");
    if (separator <= 0 || separator === value.length - 1) invalid(path, "Fn::GetAtt must contain Resource.Attribute", sourceLogicalId);
    return value.slice(0, separator);
  }
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || value[0].length === 0 || typeof value[1] !== "string" || value[1].length === 0) {
    invalid(path, "Fn::GetAtt must be Resource.Attribute or a two-string array", sourceLogicalId);
  }
  return value[0];
}

function scanSub(value: unknown, path: string, context: ReferenceScanContext): void {
  let template: string;
  let replacements: Record<string, unknown> = {};
  let replacementPath = `${path}[1]`;
  if (typeof value === "string") {
    template = value;
  } else {
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || !isObject(value[1])) {
      invalid(path, "Fn::Sub must be a string or [string, variable-map]", context.sourceLogicalId);
    }
    template = value[0];
    replacements = value[1];
  }

  for (const [name, replacement] of Object.entries(replacements).sort(([left], [right]) => compareStrings(left, right))) {
    if (name.length === 0) invalid(replacementPath, "Fn::Sub variable names must not be empty", context.sourceLogicalId);
    scanReferences(replacement, childPath(replacementPath, name), context);
  }

  const mapped = new Set(Object.keys(replacements));
  const variables = template.matchAll(/\$\{([^}]*)}/g);
  for (const match of variables) {
    const variable = match[1];
    if (variable.length === 0) invalid(path, "Fn::Sub contains an empty variable", context.sourceLogicalId);
    if (variable.startsWith("!")) continue;
    if (mapped.has(variable)) continue;
    const separator = variable.indexOf(".");
    if (separator === -1) addResourceReference(context, variable, "Fn::Sub", path);
    else {
      const target = variable.slice(0, separator);
      const attribute = variable.slice(separator + 1);
      if (target.length === 0 || attribute.length === 0) invalid(path, `Fn::Sub contains invalid attribute variable ${JSON.stringify(variable)}`, context.sourceLogicalId);
      addResourceReference(context, target, "Fn::Sub", path, true);
    }
  }
}

function validateConditionReference(condition: unknown, path: string, context: ReferenceScanContext): void {
  if (typeof condition !== "string" || condition.length === 0) invalid(path, "condition reference must be a non-empty condition logical ID", context.sourceLogicalId);
  if (!context.conditionIds.has(condition)) addMissing(context, "MissingCondition", condition, path, `reference targets missing condition ${JSON.stringify(condition)}`);
}

function scanReferences(value: unknown, path: string, context: ReferenceScanContext): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanReferences(item, `${path}[${index}]`, context));
    return;
  }
  if (!isObject(value)) return;

  const handled = new Set<string>();
  if (Object.prototype.hasOwnProperty.call(value, "Ref")) {
    handled.add("Ref");
    const reference = value.Ref;
    if (typeof reference !== "string" || reference.length === 0) invalid(childPath(path, "Ref"), "Ref must contain a non-empty logical ID", context.sourceLogicalId);
    addResourceReference(context, reference, "Ref", childPath(path, "Ref"));
  }
  if (Object.prototype.hasOwnProperty.call(value, "Fn::GetAtt")) {
    handled.add("Fn::GetAtt");
    const intrinsicPath = childPath(path, "Fn::GetAtt");
    addResourceReference(context, parseGetAttTarget(value["Fn::GetAtt"], intrinsicPath, context.sourceLogicalId), "Fn::GetAtt", intrinsicPath, true);
  }
  if (Object.prototype.hasOwnProperty.call(value, "Fn::Sub")) {
    handled.add("Fn::Sub");
    const intrinsicPath = childPath(path, "Fn::Sub");
    scanSub(value["Fn::Sub"], intrinsicPath, context);
  }
  if (Object.prototype.hasOwnProperty.call(value, "Fn::If")) {
    const expression = value["Fn::If"];
    if (Array.isArray(expression) && expression.length > 0) validateConditionReference(expression[0], `${childPath(path, "Fn::If")}[0]`, context);
  }

  for (const [key, item] of Object.entries(value).sort(([left], [right]) => compareStrings(left, right))) {
    if (!handled.has(key)) scanReferences(item, childPath(path, key), context);
  }
}

function sortedRecord(values: ReadonlyMap<string, ReadonlySet<string>>, ids: readonly string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const id of ids) result[id] = [...(values.get(id) ?? [])].sort();
  return result;
}

function dependencyMapFromRecord(dependencies: Readonly<Record<string, readonly string[]>>): Map<string, Set<string>> {
  const ids = Object.keys(dependencies).sort();
  const idSet = new Set(ids);
  const result = new Map<string, Set<string>>();
  for (const id of ids) {
    const values = dependencies[id];
    const dependencyPath = `${childPath("$.Resources", id)}.DependsOn`;
    if (!Array.isArray(values)) invalid(dependencyPath, "dependency list must be an array", id);
    const set = new Set<string>();
    for (const target of values) {
      if (typeof target !== "string" || !idSet.has(target)) {
        throw new DependencyGraphError("MissingReference", `dependency targets missing resource ${JSON.stringify(target)}`, dependencyPath, {
          sourceLogicalId: id,
          ...(typeof target === "string" ? { targetLogicalId: target } : {}),
        });
      }
      set.add(target);
    }
    result.set(id, set);
  }
  return result;
}

function findCycle(dependencies: ReadonlyMap<string, ReadonlySet<string>>, ids: readonly string[]): string[] | undefined {
  const state = new Map<string, "visiting" | "complete">();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of [...(dependencies.get(id) ?? [])].sort()) {
      if (state.get(dependency) === "visiting") {
        const start = stack.indexOf(dependency);
        return [...stack.slice(start), dependency];
      }
      if (state.get(dependency) !== "complete") {
        const nested = visit(dependency);
        if (nested !== undefined) return nested;
      }
    }
    stack.pop();
    state.set(id, "complete");
    return undefined;
  };

  for (const id of ids) {
    if (state.has(id)) continue;
    const cycle = visit(id);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

function sortDependencyMap(dependencies: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const ids = [...dependencies.keys()].sort();
  const cycle = findCycle(dependencies, ids);
  if (cycle !== undefined) {
    throw new DependencyGraphError("CircularDependency", `circular resource dependency: ${cycle.join(" -> ")}`, "$.Resources", { cycle });
  }

  const remaining = new Map(ids.map(id => [id, dependencies.get(id)?.size ?? 0]));
  const dependents = new Map(ids.map(id => [id, new Set<string>()]));
  for (const [id, required] of dependencies) {
    for (const dependency of required) dependents.get(dependency)?.add(id);
  }

  const ready = ids.filter(id => remaining.get(id) === 0);
  const result: string[] = [];
  while (ready.length > 0) {
    ready.sort();
    const id = ready.shift()!;
    result.push(id);
    for (const dependent of [...(dependents.get(id) ?? [])].sort()) {
      const count = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, count);
      if (count === 0) ready.push(dependent);
    }
  }
  return result;
}

/** Topologically sort an already discovered dependency record. */
export function topologicallySortResources(dependencies: Readonly<Record<string, readonly string[]>>): string[] {
  return sortDependencyMap(dependencyMapFromRecord(dependencies));
}

/** Alias with an explicit CloudFormation-oriented name for planner integration. */
export const deterministicTopologicalOrder = topologicallySortResources;

/**
 * Discover DependsOn and recursively nested Ref/GetAtt/Sub edges, validate all
 * reference targets, detect cycles, and return stable serializable graph data.
 */
export function buildResourceDependencyGraph(template: CloudFormationTemplate): ResourceDependencyGraph {
  const resourceIds = Object.keys(template.Resources).sort();
  const resourceIdSet = new Set(resourceIds);
  const parameterIds = new Set(Object.keys(template.Parameters ?? {}));
  const conditionIds = new Set(Object.keys(template.Conditions ?? {}));
  const references: DependencyReference[] = [];
  const missing: DependencyGraphError[] = [];

  const baseContext = {
    resourceIds: resourceIdSet,
    parameterIds,
    conditionIds,
    references,
    missing,
  };

  for (const logicalId of resourceIds) {
    const resource = template.Resources[logicalId];
    const resourcePath = childPath("$.Resources", logicalId);
    const context: ReferenceScanContext = { ...baseContext, sourceLogicalId: logicalId };
    const explicit = resource.DependsOn === undefined ? [] : typeof resource.DependsOn === "string" ? [resource.DependsOn] : resource.DependsOn;
    explicit.forEach((dependency, index) => {
      const path = typeof resource.DependsOn === "string"
        ? `${resourcePath}.DependsOn`
        : `${resourcePath}.DependsOn[${index}]`;
      addResourceReference(context, dependency, "DependsOn", path, true);
    });
    if (resource.Properties !== undefined) scanReferences(resource.Properties, `${resourcePath}.Properties`, context);
    if (resource.Metadata !== undefined) scanReferences(resource.Metadata, `${resourcePath}.Metadata`, context);
  }

  const nonResourceContext: ReferenceScanContext = { ...baseContext };
  for (const [conditionId, expression] of Object.entries(template.Conditions ?? {}).sort(([left], [right]) => compareStrings(left, right))) {
    scanReferences(expression, childPath("$.Conditions", conditionId), nonResourceContext);
  }
  for (const [ruleId, rule] of Object.entries(template.Rules ?? {}).sort(([left], [right]) => compareStrings(left, right))) {
    const rulePath = childPath("$.Rules", ruleId);
    if (rule.RuleCondition !== undefined) scanReferences(rule.RuleCondition, `${rulePath}.RuleCondition`, nonResourceContext);
    rule.Assertions.forEach((assertion, index) => scanReferences(assertion.Assert, `${rulePath}.Assertions[${index}].Assert`, nonResourceContext));
  }
  for (const [outputId, output] of Object.entries(template.Outputs ?? {}).sort(([left], [right]) => compareStrings(left, right))) {
    const outputPath = childPath("$.Outputs", outputId);
    scanReferences(output.Value, `${outputPath}.Value`, nonResourceContext);
    if (output.Export !== undefined) scanReferences(output.Export.Name, `${outputPath}.Export.Name`, nonResourceContext);
  }

  if (missing.length > 0) {
    missing.sort((left, right) => compareStrings(left.path, right.path) || compareStrings(left.details.targetLogicalId ?? "", right.details.targetLogicalId ?? ""));
    throw missing[0];
  }

  references.sort((left, right) =>
    compareStrings(left.sourceLogicalId ?? "", right.sourceLogicalId ?? "")
    || compareStrings(left.targetLogicalId, right.targetLogicalId)
    || compareStrings(left.path, right.path)
    || compareStrings(left.kind, right.kind));

  const dependencies = new Map<string, Set<string>>(resourceIds.map(id => [id, new Set<string>()]));
  for (const reference of references) {
    if (reference.sourceLogicalId !== undefined) dependencies.get(reference.sourceLogicalId)!.add(reference.targetLogicalId);
  }
  const order = sortDependencyMap(dependencies);
  const dependents = new Map<string, Set<string>>(resourceIds.map(id => [id, new Set<string>()]));
  for (const [id, required] of dependencies) {
    for (const dependency of required) dependents.get(dependency)!.add(id);
  }

  return {
    dependencies: sortedRecord(dependencies, resourceIds),
    dependents: sortedRecord(dependents, resourceIds),
    order,
    references,
  };
}

export const buildDependencyGraph = buildResourceDependencyGraph;
