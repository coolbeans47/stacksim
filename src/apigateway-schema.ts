import { createHash } from "node:crypto";
import type { ApiModelState } from "./types.js";

export type JsonSchema = Record<string, any>;

export const DRAFT4 = "http://json-schema.org/draft-04/schema#";
export const DRAFT4_PROFILE_VERSION = 1;

const ALLOWED_KEYWORDS = new Set([
  "$schema", "title", "description", "default", "example",
  "$ref", "definitions",
  "type", "enum", "properties", "required", "items", "additionalItems", "additionalProperties",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties",
  "pattern", "patternProperties", "dependencies",
  "allOf", "anyOf", "oneOf", "not",
  "multipleOf", "uniqueItems", "format",
]);

const SUPPORTED_FORMATS = new Set(["date-time", "email", "hostname", "ipv4", "ipv6", "uri", "uuid"]);

const compiledCatalogCache = new Map<string, Map<string, JsonSchema>>();

export function defaultApiModels(): Record<string, ApiModelState> {
  return {
    Empty: {
      id: "model-empty",
      name: "Empty",
      description: "Default empty model",
      contentType: "application/json",
      schema: JSON.stringify({ $schema: DRAFT4, title: "Empty Schema", type: "object" }),
    },
    Error: {
      id: "model-error",
      name: "Error",
      description: "Default error model",
      contentType: "application/json",
      schema: JSON.stringify({ $schema: DRAFT4, title: "Error Schema", type: "object", properties: { message: { type: "string" } } }),
    },
  };
}

function object(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pointer(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let value: any = root;
  for (const part of ref.slice(2).split("/").map(value => value.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    value = value?.[part];
  }
  return object(value) ? value : undefined;
}

function referencedModel(ref: string): string | undefined {
  const match = ref.match(/\/models\/([^/#?]+)$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesFormat(value: string, format: string): boolean {
  switch (format) {
    case "date-time":
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value);
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case "hostname":
      return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(value);
    case "ipv4":
      return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split(".").every(part => Number(part) >= 0 && Number(part) <= 255);
    case "ipv6":
      return /^[0-9a-fA-F:]+$/.test(value) && value.includes(":");
    case "uri":
      try { new URL(value); return true; } catch { return false; }
    case "uuid":
      return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(value);
    default:
      return true;
  }
}

function childSchemas(schema: JsonSchema): JsonSchema[] {
  const children: JsonSchema[] = [];
  if (object(schema.properties)) children.push(...Object.values(schema.properties).filter(object));
  if (object(schema.additionalProperties)) children.push(schema.additionalProperties);
  if (object(schema.patternProperties)) children.push(...Object.values(schema.patternProperties).filter(object));
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) children.push(...schema.items.filter(object));
    else if (object(schema.items)) children.push(schema.items);
  }
  if (object(schema.additionalItems)) children.push(schema.additionalItems);
  if (object(schema.definitions)) children.push(...Object.values(schema.definitions).filter(object));
  if (object(schema.dependencies)) {
    for (const dep of Object.values(schema.dependencies)) {
      if (object(dep)) children.push(dep);
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[key])) children.push(...schema[key].filter(object));
  }
  if (object(schema.not)) children.push(schema.not);
  return children;
}

export function parseModelSchema(schema: string): JsonSchema {
  if (typeof schema !== "string") throw new Error("Model schema must be a JSON string");
  if (Buffer.byteLength(schema, "utf8") > 409_600) throw new Error("Model schema exceeds the 400 KB limit");
  let parsed: unknown;
  try { parsed = JSON.parse(schema); } catch { throw new Error("Model schema must be valid JSON"); }
  if (!object(parsed)) throw new Error("Model schema must be a JSON object");
  return parsed;
}

function assertAllowedKeywords(schema: JsonSchema, path: string): void {
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      throw new Error(`Unsupported Draft 4 keyword ${key} at ${path}`);
    }
  }
}

function inspectSchema(schema: JsonSchema, root: JsonSchema, path: string, visit: (ref: string, path: string) => void, localStack: Set<JsonSchema>): void {
  if (localStack.has(schema)) throw new Error(`Recursive schema at ${path}`);
  assertAllowedKeywords(schema, path);
  const next = new Set(localStack).add(schema);
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string") throw new Error(`$ref at ${path} must be a string`);
    if (schema.$ref.startsWith("#/")) {
      const target = pointer(root, schema.$ref);
      if (!target) throw new Error(`Unresolved $ref ${schema.$ref} at ${path}`);
      inspectSchema(target, root, `${path}->$ref`, visit, next);
    } else visit(schema.$ref, path);
  }
  const type = schema.type;
  if (type !== undefined) {
    const values = Array.isArray(type) ? type : [type];
    if (!values.length || values.some(value => !["null", "boolean", "object", "array", "number", "integer", "string"].includes(value))) {
      throw new Error(`Invalid type at ${path}`);
    }
  }
  if (schema.properties !== undefined && !object(schema.properties)) throw new Error(`properties at ${path} must be an object`);
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    if (!object(child)) throw new Error(`Property schema ${path}.${name} must be an object`);
    inspectSchema(child, root, `${path}.${name}`, visit, next);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((name: unknown) => typeof name !== "string"))) {
    throw new Error(`required at ${path} must be a string array`);
  }
  if (schema.items !== undefined) {
    const items = Array.isArray(schema.items) ? schema.items : [schema.items];
    if (items.some((child: unknown) => !object(child))) throw new Error(`items at ${path} must contain schemas`);
    items.forEach((child: JsonSchema, index: number) => inspectSchema(child, root, `${path}[${index}]`, visit, next));
  }
  if (schema.additionalItems !== undefined && typeof schema.additionalItems !== "boolean" && !object(schema.additionalItems)) {
    throw new Error(`additionalItems at ${path} must be a boolean or schema`);
  }
  if (object(schema.additionalItems)) inspectSchema(schema.additionalItems, root, `${path}.additionalItems`, visit, next);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean" && !object(schema.additionalProperties)) {
    throw new Error(`additionalProperties at ${path} must be a boolean or schema`);
  }
  if (object(schema.additionalProperties)) inspectSchema(schema.additionalProperties, root, `${path}.*`, visit, next);
  if (schema.patternProperties !== undefined) {
    if (!object(schema.patternProperties)) throw new Error(`patternProperties at ${path} must be an object`);
    for (const [pattern, child] of Object.entries(schema.patternProperties)) {
      try { new RegExp(pattern); } catch { throw new Error(`patternProperties key ${pattern} at ${path} is not a valid regular expression`); }
      if (!object(child)) throw new Error(`patternProperties value at ${path}.${pattern} must be a schema`);
      inspectSchema(child, root, `${path}.patternProperties.${pattern}`, visit, next);
    }
  }
  if (schema.dependencies !== undefined) {
    if (!object(schema.dependencies)) throw new Error(`dependencies at ${path} must be an object`);
    for (const [name, dep] of Object.entries(schema.dependencies)) {
      if (Array.isArray(dep)) {
        if (dep.some(item => typeof item !== "string")) throw new Error(`dependencies.${name} at ${path} must be a string array or schema`);
      } else if (!object(dep)) throw new Error(`dependencies.${name} at ${path} must be a string array or schema`);
      else inspectSchema(dep, root, `${path}.dependencies.${name}`, visit, next);
    }
  }
  if (schema.definitions !== undefined && !object(schema.definitions)) throw new Error(`definitions at ${path} must be an object`);
  for (const [name, child] of Object.entries(schema.definitions ?? {})) {
    if (!object(child)) throw new Error(`Definition ${name} must be a schema`);
    inspectSchema(child, root, `${path}.definitions.${name}`, visit, next);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new Error(`enum at ${path} must be a non-empty array`);
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
    if (schema[key] !== undefined && (key.startsWith("exclusive") ? typeof schema[key] !== "boolean" : typeof schema[key] !== "number")) {
      throw new Error(`${key} at ${path} has an invalid value`);
    }
  }
  if (schema.multipleOf !== undefined && (typeof schema.multipleOf !== "number" || schema.multipleOf <= 0)) {
    throw new Error(`multipleOf at ${path} must be a positive number`);
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]) {
    if (schema[key] !== undefined && (!Number.isInteger(schema[key]) || schema[key] < 0)) {
      throw new Error(`${key} at ${path} must be a non-negative integer`);
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") throw new Error(`pattern at ${path} must be a string`);
    try { new RegExp(schema.pattern); } catch { throw new Error(`pattern at ${path} is not a valid regular expression`); }
  }
  if (schema.format !== undefined) {
    if (typeof schema.format !== "string" || !SUPPORTED_FORMATS.has(schema.format)) {
      throw new Error(`format at ${path} must be one of ${[...SUPPORTED_FORMATS].sort().join(", ")}`);
    }
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") throw new Error(`uniqueItems at ${path} must be a boolean`);
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key]) || !schema[key].length || schema[key].some((child: unknown) => !object(child))) {
        throw new Error(`${key} at ${path} must be a non-empty schema array`);
      }
      schema[key].forEach((child: JsonSchema, index: number) => inspectSchema(child, root, `${path}.${key}[${index}]`, visit, next));
    }
  }
  if (schema.not !== undefined && !object(schema.not)) throw new Error(`not at ${path} must be a schema`);
  if (object(schema.not)) inspectSchema(schema.not, root, `${path}.not`, visit, next);
}

export function validateModelCatalog(models: Record<string, ApiModelState>): void {
  const parsed = Object.fromEntries(Object.entries(models).map(([name, model]) => [name, parseModelSchema(model.schema)]));
  const graph = new Map<string, Set<string>>();
  for (const [name, schema] of Object.entries(parsed)) {
    const refs = new Set<string>();
    inspectSchema(schema, schema, "$", ref => {
      const target = referencedModel(ref);
      if (!target || !models[target]) throw new Error(`Unresolved API model $ref ${ref}`);
      refs.add(target);
    }, new Set());
    graph.set(name, refs);
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const walk = (name: string, trail: string[]): void => {
    if (active.has(name)) throw new Error(`Recursive/cyclic model reference: ${[...trail, name].join(" -> ")}`);
    if (visited.has(name)) return;
    active.add(name);
    for (const target of graph.get(name) ?? []) walk(target, [...trail, name]);
    active.delete(name);
    visited.add(name);
  };
  for (const name of graph.keys()) walk(name, []);
}

function compileModelCatalog(models: Record<string, ApiModelState>): Map<string, JsonSchema> {
  const digest = createHash("sha256").update(JSON.stringify(Object.entries(models).map(([name, model]) => [name, model.schema]).sort())).digest("hex");
  const cached = compiledCatalogCache.get(digest);
  if (cached) return cached;
  const roots = new Map<string, JsonSchema>();
  for (const [name, model] of Object.entries(models)) roots.set(name, parseModelSchema(model.schema));
  compiledCatalogCache.set(digest, roots);
  return roots;
}

export function draft4CompatibilityProfile(): { version: number; draft: string; keywords: string[]; formats: string[] } {
  return { version: DRAFT4_PROFILE_VERSION, draft: DRAFT4, keywords: [...ALLOWED_KEYWORDS].sort(), formats: [...SUPPORTED_FORMATS].sort() };
}

function validateCandidate(
  candidate: unknown,
  schema: JsonSchema,
  root: JsonSchema,
  path: string,
  failures: string[],
  catalogRoots: Map<string, JsonSchema>,
): void {
  if (schema.$ref) {
    if (schema.$ref.startsWith("#/")) {
      const target = pointer(root, schema.$ref);
      if (target) validateCandidate(candidate, target, root, path, failures, catalogRoots);
      else failures.push(`${path}: unresolved reference ${schema.$ref}`);
    } else {
      const targetName = referencedModel(schema.$ref);
      const targetRoot = targetName ? catalogRoots.get(targetName) : undefined;
      if (targetRoot) validateCandidate(candidate, targetRoot, targetRoot, path, failures, catalogRoots);
      else failures.push(`${path}: unresolved reference ${schema.$ref}`);
    }
    return;
  }

  if (schema.not !== undefined) {
    const nested: string[] = [];
    validateCandidate(candidate, schema.not, root, path, nested, catalogRoots);
    if (!nested.length) failures.push(`${path}: must not satisfy the not schema`);
  }

  if (schema.oneOf !== undefined) {
    let matches = 0;
    for (const subschema of schema.oneOf as JsonSchema[]) {
      const nested: string[] = [];
      validateCandidate(candidate, subschema, root, path, nested, catalogRoots);
      if (!nested.length) matches++;
    }
    if (matches !== 1) failures.push(`${path}: must match exactly one oneOf schema`);
  }

  if (schema.anyOf !== undefined) {
    const matched = (schema.anyOf as JsonSchema[]).some((subschema: JsonSchema) => {
      const nested: string[] = [];
      validateCandidate(candidate, subschema, root, path, nested, catalogRoots);
      return nested.length === 0;
    });
    if (!matched) failures.push(`${path}: must match at least one anyOf schema`);
  }

  if (schema.allOf !== undefined) {
    for (const subschema of schema.allOf as JsonSchema[]) validateCandidate(candidate, subschema, root, path, failures, catalogRoots);
  }

  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const matches = (type: string): boolean => type === "null" ? candidate === null
    : type === "array" ? Array.isArray(candidate)
      : type === "object" ? object(candidate)
        : type === "integer" ? typeof candidate === "number" && Number.isInteger(candidate)
          : typeof candidate === type;
  if (types.length && !types.some(matches)) {
    failures.push(`${path}: expected ${types.join(" or ")}`);
    return;
  }

  if (schema.enum && !schema.enum.some((item: unknown) => equal(item, candidate))) failures.push(`${path}: value is not in enum`);

  if (typeof candidate === "number" && schema.multipleOf !== undefined) {
    const quotient = candidate / schema.multipleOf;
    if (Math.abs(quotient - Math.round(quotient)) > 1e-9) failures.push(`${path}: must be a multiple of ${schema.multipleOf}`);
  }

  if (object(candidate)) {
    for (const name of schema.required ?? []) if (!(name in candidate)) failures.push(`${path}.${name}: is required`);
    if (schema.minProperties !== undefined && Object.keys(candidate).length < schema.minProperties) {
      failures.push(`${path}: must have at least ${schema.minProperties} properties`);
    }
    if (schema.maxProperties !== undefined && Object.keys(candidate).length > schema.maxProperties) {
      failures.push(`${path}: must have at most ${schema.maxProperties} properties`);
    }
    const declared = new Set(Object.keys(schema.properties ?? {}));
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (name in candidate) validateCandidate(candidate[name], child as JsonSchema, root, `${path}.${name}`, failures, catalogRoots);
    }
    if (schema.patternProperties) {
      for (const [name, value] of Object.entries(candidate)) {
        if (declared.has(name)) continue;
        for (const [pattern, child] of Object.entries(schema.patternProperties)) {
          if (new RegExp(pattern).test(name)) validateCandidate(value, child as JsonSchema, root, `${path}.${name}`, failures, catalogRoots);
        }
      }
    }
    for (const [name, child] of Object.entries(candidate)) {
      if (declared.has(name)) continue;
      if (schema.patternProperties && Object.keys(schema.patternProperties).some(pattern => new RegExp(pattern).test(name))) continue;
      if (!(name in (schema.properties ?? {}))) {
        if (schema.additionalProperties === false) failures.push(`${path}.${name}: additional property is not allowed`);
        else if (object(schema.additionalProperties)) validateCandidate(child, schema.additionalProperties, root, `${path}.${name}`, failures, catalogRoots);
      }
    }
    if (schema.dependencies) {
      for (const [name, dep] of Object.entries(schema.dependencies)) {
        if (!(name in candidate)) continue;
        if (Array.isArray(dep)) {
          for (const requiredName of dep) if (!(requiredName in candidate)) failures.push(`${path}.${requiredName}: is required when ${name} is present`);
        } else if (object(dep)) validateCandidate(candidate, dep, root, path, failures, catalogRoots);
      }
    }
  }

  if (Array.isArray(candidate)) {
    if (schema.minItems !== undefined && candidate.length < schema.minItems) failures.push(`${path}: must contain at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && candidate.length > schema.maxItems) failures.push(`${path}: must contain at most ${schema.maxItems} items`);
    if (schema.uniqueItems) {
      for (let index = 0; index < candidate.length; index++) {
        for (let later = index + 1; later < candidate.length; later++) {
          if (equal(candidate[index], candidate[later])) failures.push(`${path}: items must be unique`);
        }
      }
    }
    if (Array.isArray(schema.items)) {
      candidate.forEach((item, index) => {
        if (index < schema.items.length) validateCandidate(item, schema.items[index], root, `${path}[${index}]`, failures, catalogRoots);
        else if (schema.additionalItems === false) failures.push(`${path}[${index}]: additional item is not allowed`);
        else if (object(schema.additionalItems)) validateCandidate(item, schema.additionalItems, root, `${path}[${index}]`, failures, catalogRoots);
      });
    } else if (object(schema.items)) {
      candidate.forEach((item, index) => validateCandidate(item, schema.items, root, `${path}[${index}]`, failures, catalogRoots));
    }
  }

  if (typeof candidate === "number") {
    if (schema.minimum !== undefined && (schema.exclusiveMinimum ? candidate <= schema.minimum : candidate < schema.minimum)) {
      failures.push(`${path}: must be ${schema.exclusiveMinimum ? ">" : ">="} ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && (schema.exclusiveMaximum ? candidate >= schema.maximum : candidate > schema.maximum)) {
      failures.push(`${path}: must be ${schema.exclusiveMaximum ? "<" : "<="} ${schema.maximum}`);
    }
  }

  if (typeof candidate === "string") {
    if (schema.minLength !== undefined && candidate.length < schema.minLength) failures.push(`${path}: must have at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && candidate.length > schema.maxLength) failures.push(`${path}: must have at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(candidate)) failures.push(`${path}: must match ${schema.pattern}`);
    if (schema.format !== undefined && !matchesFormat(candidate, schema.format)) failures.push(`${path}: must match format ${schema.format}`);
  }
}

export function validateJsonModel(value: unknown, modelName: string, models: Record<string, ApiModelState>): string[] {
  const catalogRoots = compileModelCatalog(models);
  const failures: string[] = [];
  const root = catalogRoots.get(modelName);
  if (!root) return [`$: model ${modelName} does not exist`];
  validateCandidate(value, root, root, "$", failures, catalogRoots);
  return failures;
}

export function modelTemplate(modelName: string, models: Record<string, ApiModelState>): unknown {
  const roots = compileModelCatalog(models);
  const sample = (schema: JsonSchema, root: JsonSchema): unknown => {
    if (schema.example !== undefined) return structuredClone(schema.example);
    if (schema.default !== undefined) return structuredClone(schema.default);
    if (schema.enum?.length) return structuredClone(schema.enum[0]);
    if (schema.$ref?.startsWith("#/")) {
      const target = pointer(root, schema.$ref);
      return target ? sample(target, root) : null;
    }
    if (schema.$ref) {
      const target = referencedModel(schema.$ref);
      const resolved = target && roots.get(target);
      return resolved ? sample(resolved, resolved) : null;
    }
    if (schema.allOf?.length) return sample(schema.allOf[0], root);
    if (schema.anyOf?.length) return sample(schema.anyOf[0], root);
    if (schema.oneOf?.length) return sample(schema.oneOf[0], root);
    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    if (type === "object" || schema.properties) {
      return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, child]) => [name, sample(child as JsonSchema, root)]));
    }
    if (type === "array") {
      if (Array.isArray(schema.items)) return schema.items.map((child: JsonSchema) => sample(child, root));
      return object(schema.items) ? [sample(schema.items, root)] : [];
    }
    if (type === "string") return schema.format === "uuid" ? "00000000-0000-4000-8000-000000000000" : "string";
    if (type === "integer" || type === "number") return schema.minimum ?? 0;
    if (type === "boolean") return true;
    return null;
  };
  const root = roots.get(modelName);
  if (!root) throw new Error(`Model ${modelName} does not exist`);
  return sample(root, root);
}
