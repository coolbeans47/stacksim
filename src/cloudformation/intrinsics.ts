/** A private sentinel used while recursively removing AWS::NoValue entries. */
export const AWS_NO_VALUE = Symbol("AWS::NoValue");

const SUPPORTED_INTRINSICS = new Set([
  "Ref",
  "Condition",
  "Fn::GetAtt",
  "Fn::Sub",
  "Fn::Join",
  "Fn::Select",
  "Fn::Split",
  "Fn::FindInMap",
  "Fn::If",
  "Fn::Equals",
  "Fn::Contains",
  "Fn::Not",
  "Fn::And",
  "Fn::Or",
  "Fn::Base64",
  "Fn::ImportValue",
]);

export interface IntrinsicEvaluationContext {
  /** Resolved template parameter values, including defaults. */
  parameters?: Readonly<Record<string, unknown>>;
  /** AWS::AccountId, AWS::Region, AWS::StackId, and other pseudo-parameters. */
  pseudoParameters?: Readonly<Record<string, unknown>>;
  /** Ref values for resources that have stabilized. */
  resourceRefs?: Readonly<Record<string, unknown>>;
  /** GetAtt values for resources that have stabilized. */
  resourceAttributes?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  mappings?: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>>;
  /** Already evaluated named template conditions. */
  conditions?: Readonly<Record<string, boolean>>;
  /** Active CloudFormation exports in this account and Region, keyed by export name. */
  imports?: Readonly<Record<string, unknown>>;
  /**
   * All resource logical IDs in the processed template. This is used by
   * collectIntrinsicReferences before resources have Ref values.
   */
  resourceLogicalIds?: Iterable<string>;
}

export interface GetAttReference {
  logicalId: string;
  attribute: string;
}

export interface IntrinsicReferences {
  /** Every non-NoValue name used by Ref or an implicit Fn::Sub Ref. */
  refs: string[];
  getAtts: GetAttReference[];
  resourceDependencies: string[];
  parameterReferences: string[];
  pseudoParameterReferences: string[];
  conditionReferences: string[];
  /** Names that cannot be classified without a matching parameter/resource. */
  unknownReferences: string[];
}

export class IntrinsicEvaluationError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} at ${path}`);
    this.name = "IntrinsicEvaluationError";
  }
}

type JsonObject = Record<string, unknown>;
type IntrinsicEntry = readonly [string, unknown];

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$:-]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function fail(message: string, path: string): never {
  throw new IntrinsicEvaluationError(message, path);
}

function intrinsicEntry(value: JsonObject, path: string): IntrinsicEntry | undefined {
  const keys = Object.keys(value);
  const intrinsicKeys = keys.filter(key => key === "Ref" || key === "Condition" || key.startsWith("Fn::"));
  if (!intrinsicKeys.length) return undefined;
  // `Condition` is also a normal field on resources, outputs, IAM policy
  // statements, and several service models.  Only the single-key
  // `{ Condition: "Name" }` form is the condition intrinsic.  In contrast,
  // `Ref` and `Fn::*` are reserved intrinsic keys and siblings are invalid.
  if (keys.length !== 1 && intrinsicKeys.length === 1 && intrinsicKeys[0] === "Condition") return undefined;
  if (keys.length !== 1) fail(`Intrinsic ${intrinsicKeys[0]} cannot have sibling keys`, path);
  const key = intrinsicKeys[0];
  if (!SUPPORTED_INTRINSICS.has(key)) fail(`Unsupported intrinsic ${key}`, path);
  return [key, value[key]];
}

function exactArray(value: unknown, length: number, name: string, path: string): unknown[] {
  if (!Array.isArray(value) || value.length !== length) fail(`${name} requires an array containing exactly ${length} values`, path);
  return value;
}

function stringValue(value: unknown, description: string, path: string): string {
  if (value === AWS_NO_VALUE) fail(`${description} resolved to AWS::NoValue`, path);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  fail(`${description} must resolve to a string, number, or boolean`, path);
}

function booleanValue(value: unknown, description: string, path: string): boolean {
  if (typeof value !== "boolean") fail(`${description} must resolve to a boolean`, path);
  return value;
}

function comparableValue(value: unknown, description: string, path: string): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  fail(`${description} must resolve to a scalar value`, path);
}

function getCondition(name: unknown, context: IntrinsicEvaluationContext, path: string): boolean {
  if (typeof name !== "string" || !name) fail("Condition name must be a non-empty string", path);
  if (!hasOwn(context.conditions ?? {}, name)) fail(`Unknown condition ${name}`, path);
  const result = context.conditions![name];
  if (typeof result !== "boolean") fail(`Condition ${name} has not resolved to a boolean`, path);
  return result;
}

function resolveRef(name: unknown, context: IntrinsicEvaluationContext, path: string): unknown {
  if (typeof name !== "string" || !name) fail("Ref requires a non-empty string name", path);
  if (name === "AWS::NoValue") return AWS_NO_VALUE;
  if (hasOwn(context.parameters ?? {}, name)) return context.parameters![name];
  if (hasOwn(context.pseudoParameters ?? {}, name)) return context.pseudoParameters![name];
  if (hasOwn(context.resourceRefs ?? {}, name)) return context.resourceRefs![name];
  fail(`Ref refers to unknown parameter, pseudo-parameter, or resource ${name}`, path);
}

function parseGetAtt(value: unknown, path: string): GetAttReference {
  if (typeof value === "string") {
    const separator = value.indexOf(".");
    if (separator <= 0 || separator === value.length - 1) fail("Fn::GetAtt string form must be LogicalId.Attribute", path);
    return { logicalId: value.slice(0, separator), attribute: value.slice(separator + 1) };
  }
  const values = exactArray(value, 2, "Fn::GetAtt", path);
  if (typeof values[0] !== "string" || !values[0] || typeof values[1] !== "string" || !values[1]) {
    fail("Fn::GetAtt list form requires non-empty logical ID and attribute strings", path);
  }
  return { logicalId: values[0], attribute: values[1] };
}

function resolveGetAtt(value: unknown, context: IntrinsicEvaluationContext, path: string): unknown {
  const { logicalId, attribute } = parseGetAtt(value, path);
  const attributes = context.resourceAttributes?.[logicalId];
  if (!attributes) fail(`Fn::GetAtt refers to unknown or unstabilized resource ${logicalId}`, path);
  if (!hasOwn(attributes, attribute)) fail(`Resource ${logicalId} does not expose attribute ${attribute}`, path);
  if (attributes.__stackSimCustomResourceNoEcho === true && attribute !== "__stackSimCustomResourceNoEcho") return "****";
  return attributes[attribute];
}

interface ParsedSub {
  template: string;
  variables: JsonObject;
}

function parseSub(value: unknown, path: string): ParsedSub {
  if (typeof value === "string") return { template: value, variables: {} };
  const values = exactArray(value, 2, "Fn::Sub", path);
  if (typeof values[0] !== "string") fail("Fn::Sub template must be a string", path);
  if (!isObject(values[1])) fail("Fn::Sub variable map must be an object", path);
  return { template: values[0], variables: values[1] };
}

function subPlaceholders(template: string, path: string): Array<{ raw: string; name: string; escaped: boolean }> {
  const found: Array<{ raw: string; name: string; escaped: boolean }> = [];
  const expression = /\$\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(template))) {
    if (!match[1]) fail("Fn::Sub contains an empty variable expression", path);
    const escaped = match[1].startsWith("!");
    const name = escaped ? match[1].slice(1) : match[1];
    if (!name) fail("Fn::Sub contains an empty escaped variable expression", path);
    found.push({ raw: match[0], name, escaped });
  }
  const stripped = template.replace(expression, "");
  if (stripped.includes("${")) fail("Fn::Sub contains an unterminated variable expression", path);
  return found;
}

function evaluateSub(value: unknown, context: IntrinsicEvaluationContext, path: string): string {
  const { template, variables } = parseSub(value, path);
  const evaluatedVariables: JsonObject = {};
  for (const [name, variable] of Object.entries(variables)) {
    if (!name) fail("Fn::Sub variable names must not be empty", path);
    evaluatedVariables[name] = evaluate(variable, context, childPath(path, name));
  }
  const placeholders = subPlaceholders(template, path);
  let index = 0;
  return template.replace(/\$\{([^}]*)\}/g, () => {
    const placeholder = placeholders[index++];
    let replacement: string;
    if (placeholder.escaped) replacement = `\${${placeholder.name}}`;
    else if (hasOwn(evaluatedVariables, placeholder.name)) replacement = stringValue(evaluatedVariables[placeholder.name], `Fn::Sub variable ${placeholder.name}`, path);
    else {
      const separator = placeholder.name.indexOf(".");
      const resolved = separator > 0
        ? resolveGetAtt([placeholder.name.slice(0, separator), placeholder.name.slice(separator + 1)], context, path)
        : resolveRef(placeholder.name, context, path);
      replacement = stringValue(resolved, `Fn::Sub variable ${placeholder.name}`, path);
    }
    return replacement;
  });
}

function evaluateIntrinsic(entry: IntrinsicEntry, context: IntrinsicEvaluationContext, path: string): unknown {
  const [name, argument] = entry;
  if (name === "Ref") return resolveRef(argument, context, path);
  if (name === "Condition") return getCondition(argument, context, path);
  if (name === "Fn::GetAtt") return resolveGetAtt(argument, context, path);
  if (name === "Fn::Sub") return evaluateSub(argument, context, path);
  if (name === "Fn::Join") {
    const [delimiter, source] = exactArray(argument, 2, name, path);
    if (typeof delimiter !== "string") fail("Fn::Join delimiter must be a string", path);
    const values = evaluate(source, context, `${path}[1]`);
    if (!Array.isArray(values)) fail("Fn::Join second value must resolve to a list", path);
    return values.map((item, index) => stringValue(item, `Fn::Join item ${index}`, path)).join(delimiter);
  }
  if (name === "Fn::Select") {
    const [rawIndex, source] = exactArray(argument, 2, name, path);
    const evaluatedIndex = evaluate(rawIndex, context, `${path}[0]`);
    const index = typeof evaluatedIndex === "number" ? evaluatedIndex : typeof evaluatedIndex === "string" && /^\d+$/.test(evaluatedIndex) ? Number(evaluatedIndex) : Number.NaN;
    if (!Number.isSafeInteger(index) || index < 0) fail("Fn::Select index must resolve to a non-negative integer", path);
    const values = evaluate(source, context, `${path}[1]`);
    if (!Array.isArray(values)) fail("Fn::Select second value must resolve to a list", path);
    if (index >= values.length) fail(`Fn::Select index ${index} is outside a list of length ${values.length}`, path);
    return values[index];
  }
  if (name === "Fn::Split") {
    const [rawDelimiter, rawSource] = exactArray(argument, 2, name, path);
    const delimiter = stringValue(evaluate(rawDelimiter, context, `${path}[0]`), "Fn::Split delimiter", path);
    const source = stringValue(evaluate(rawSource, context, `${path}[1]`), "Fn::Split source", path);
    return source.split(delimiter);
  }
  if (name === "Fn::FindInMap") {
    const [rawMap, rawTop, rawSecond] = exactArray(argument, 3, name, path);
    const mapName = stringValue(evaluate(rawMap, context, `${path}[0]`), "Fn::FindInMap map name", path);
    const topKey = stringValue(evaluate(rawTop, context, `${path}[1]`), "Fn::FindInMap top-level key", path);
    const secondKey = stringValue(evaluate(rawSecond, context, `${path}[2]`), "Fn::FindInMap second-level key", path);
    const mapping = context.mappings?.[mapName];
    if (!mapping) fail(`Fn::FindInMap refers to unknown mapping ${mapName}`, path);
    const row = mapping[topKey];
    if (!row) fail(`Fn::FindInMap mapping ${mapName} has no top-level key ${topKey}`, path);
    if (!hasOwn(row, secondKey)) fail(`Fn::FindInMap mapping ${mapName}.${topKey} has no second-level key ${secondKey}`, path);
    return evaluate(row[secondKey], context, path);
  }
  if (name === "Fn::If") {
    const [condition, whenTrue, whenFalse] = exactArray(argument, 3, name, path);
    return evaluate(getCondition(condition, context, path) ? whenTrue : whenFalse, context, path);
  }
  if (name === "Fn::Equals") {
    const [left, right] = exactArray(argument, 2, name, path);
    return Object.is(
      comparableValue(evaluate(left, context, `${path}[0]`), "Fn::Equals left operand", path),
      comparableValue(evaluate(right, context, `${path}[1]`), "Fn::Equals right operand", path),
    );
  }
  if (name === "Fn::Contains") {
    const [rawValues, rawSearch] = exactArray(argument, 2, name, path);
    const values = evaluate(rawValues, context, `${path}[0]`);
    if (!Array.isArray(values)) fail("Fn::Contains first value must resolve to a list", path);
    const search = comparableValue(evaluate(rawSearch, context, `${path}[1]`), "Fn::Contains search value", path);
    return values.some((candidate, index) => Object.is(comparableValue(candidate, `Fn::Contains list item ${index}`, path), search));
  }
  if (name === "Fn::Not") {
    const [operand] = exactArray(argument, 1, name, path);
    return !booleanValue(evaluate(operand, context, `${path}[0]`), "Fn::Not operand", path);
  }
  if (name === "Fn::And" || name === "Fn::Or") {
    if (!Array.isArray(argument) || argument.length < 2 || argument.length > 10) fail(`${name} requires between 2 and 10 condition operands`, path);
    const values = argument.map((operand, index) => booleanValue(evaluate(operand, context, `${path}[${index}]`), `${name} operand ${index}`, path));
    return name === "Fn::And" ? values.every(Boolean) : values.some(Boolean);
  }
  if (name === "Fn::Base64") {
    const value = stringValue(evaluate(argument, context, path), "Fn::Base64 value", path);
    return Buffer.from(value, "utf8").toString("base64");
  }
  if (name === "Fn::ImportValue") {
    const importName = stringValue(evaluate(argument, context, path), "Fn::ImportValue name", path);
    if (!hasOwn(context.imports ?? {}, importName)) fail(`No export named ${importName} found`, path);
    return context.imports![importName];
  }
  return fail(`Unsupported intrinsic ${name}`, path);
}

function evaluate(value: unknown, context: IntrinsicEvaluationContext, path: string): unknown {
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const item = evaluate(value[index], context, `${path}[${index}]`);
      if (item !== AWS_NO_VALUE) result.push(item);
    }
    return result;
  }
  if (!isObject(value)) return value;
  const intrinsic = intrinsicEntry(value, path);
  if (intrinsic) return evaluateIntrinsic(intrinsic, context, path);
  const result: JsonObject = {};
  for (const [key, source] of Object.entries(value)) {
    const item = evaluate(source, context, childPath(path, key));
    if (item !== AWS_NO_VALUE) result[key] = item;
  }
  return result;
}

/** Recursively resolves the supported CloudFormation intrinsic subset. */
export function evaluateIntrinsicValue(value: unknown, context: IntrinsicEvaluationContext, path = "$" ): unknown {
  return evaluate(value, context, path);
}

function validateIntrinsicShape(name: string, argument: unknown, path: string): void {
  if (name === "Ref" || name === "Condition") {
    if (typeof argument !== "string" || !argument) fail(`${name} requires a non-empty string name`, path);
  } else if (name === "Fn::GetAtt") parseGetAtt(argument, path);
  else if (name === "Fn::Sub") { const parsed = parseSub(argument, path); subPlaceholders(parsed.template, path); }
  else if (name === "Fn::Join") { const values = exactArray(argument, 2, name, path); if (typeof values[0] !== "string") fail("Fn::Join delimiter must be a string", path); }
  else if (name === "Fn::Select" || name === "Fn::Split" || name === "Fn::Equals" || name === "Fn::Contains") exactArray(argument, 2, name, path);
  else if (name === "Fn::FindInMap") exactArray(argument, 3, name, path);
  else if (name === "Fn::If") { const values = exactArray(argument, 3, name, path); if (typeof values[0] !== "string" || !values[0]) fail("Fn::If condition name must be a non-empty string", path); }
  else if (name === "Fn::Not") exactArray(argument, 1, name, path);
  else if ((name === "Fn::And" || name === "Fn::Or") && (!Array.isArray(argument) || argument.length < 2 || argument.length > 10)) fail(`${name} requires between 2 and 10 condition operands`, path);
}

/**
 * Collects implicit references from all branches without evaluating them.
 * Supplying parameter names and all resource logical IDs allows Ref values to
 * be classified precisely before any resource has stabilized.
 */
export function collectIntrinsicReferences(value: unknown, context: IntrinsicEvaluationContext = {}): IntrinsicReferences {
  const refs = new Set<string>();
  const getAtts = new Map<string, GetAttReference>();
  const resources = new Set<string>();
  const parameters = new Set<string>();
  const pseudos = new Set<string>();
  const conditions = new Set<string>();
  const unknown = new Set<string>();
  const resourceNames = new Set<string>([
    ...Object.keys(context.resourceRefs ?? {}),
    ...(context.resourceLogicalIds ?? []),
  ]);
  const parameterNames = new Set(Object.keys(context.parameters ?? {}));

  const addRef = (name: string): void => {
    if (name === "AWS::NoValue") return;
    refs.add(name);
    if (name.startsWith("AWS::")) pseudos.add(name);
    else if (parameterNames.has(name)) parameters.add(name);
    else if (resourceNames.has(name)) resources.add(name);
    else unknown.add(name);
  };
  const addGetAtt = (reference: GetAttReference): void => {
    resources.add(reference.logicalId);
    getAtts.set(`${reference.logicalId}\0${reference.attribute}`, reference);
  };

  const walk = (source: unknown, path: string): void => {
    if (Array.isArray(source)) { source.forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
    if (!isObject(source)) return;
    const intrinsic = intrinsicEntry(source, path);
    if (!intrinsic) { for (const [key, item] of Object.entries(source)) walk(item, childPath(path, key)); return; }
    const [name, argument] = intrinsic;
    validateIntrinsicShape(name, argument, path);
    if (name === "Ref") { addRef(argument as string); return; }
    if (name === "Condition") { conditions.add(argument as string); return; }
    if (name === "Fn::GetAtt") { addGetAtt(parseGetAtt(argument, path)); return; }
    if (name === "Fn::Sub") {
      const parsed = parseSub(argument, path);
      const overridden = new Set(Object.keys(parsed.variables));
      for (const [key, item] of Object.entries(parsed.variables)) walk(item, childPath(path, key));
      for (const placeholder of subPlaceholders(parsed.template, path)) {
        if (placeholder.escaped || overridden.has(placeholder.name)) continue;
        const separator = placeholder.name.indexOf(".");
        if (separator > 0) addGetAtt({ logicalId: placeholder.name.slice(0, separator), attribute: placeholder.name.slice(separator + 1) });
        else addRef(placeholder.name);
      }
      return;
    }
    if (name === "Fn::If") {
      const args = argument as unknown[];
      if (typeof args[0] !== "string" || !args[0]) fail("Fn::If condition name must be a non-empty string", path);
      conditions.add(args[0]); walk(args[1], `${path}[1]`); walk(args[2], `${path}[2]`); return;
    }
    if (name === "Fn::FindInMap") { (argument as unknown[]).forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
    if (name === "Fn::Join" || name === "Fn::Select" || name === "Fn::Split" || name === "Fn::Equals" || name === "Fn::Contains" || name === "Fn::Not" || name === "Fn::And" || name === "Fn::Or") {
      (argument as unknown[]).forEach((item, index) => walk(item, `${path}[${index}]`)); return;
    }
    if (name === "Fn::Base64" || name === "Fn::ImportValue") walk(argument, path);
  };

  walk(value, "$");
  return {
    refs: [...refs].sort(),
    getAtts: [...getAtts.values()].sort((left, right) => left.logicalId.localeCompare(right.logicalId) || left.attribute.localeCompare(right.attribute)),
    resourceDependencies: [...resources].sort(),
    parameterReferences: [...parameters].sort(),
    pseudoParameterReferences: [...pseudos].sort(),
    conditionReferences: [...conditions].sort(),
    unknownReferences: [...unknown].sort(),
  };
}

/** Resolve the names referenced by Fn::ImportValue without evaluating unrelated resource values. */
export function collectImportValueNames(value: unknown, context: IntrinsicEvaluationContext): string[] {
  const names = new Set<string>();
  const walk = (source: unknown, path: string): void => {
    if (Array.isArray(source)) { source.forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
    if (!isObject(source)) return;
    const entry = intrinsicEntry(source, path);
    if (entry?.[0] === "Fn::ImportValue") {
      const name = stringValue(evaluate(entry[1], context, path), "Fn::ImportValue name", path);
      if (!hasOwn(context.imports ?? {}, name)) fail(`No export named ${name} found`, path);
      names.add(name);
      return;
    }
    if (entry) {
      const [, argument] = entry;
      if (Array.isArray(argument)) argument.forEach((item, index) => walk(item, `${path}[${index}]`));
      else if (isObject(argument)) for (const [key, item] of Object.entries(argument)) walk(item, childPath(path, key));
      return;
    }
    for (const [key, item] of Object.entries(source)) walk(item, childPath(path, key));
  };
  walk(value, "$");
  return [...names].sort();
}
