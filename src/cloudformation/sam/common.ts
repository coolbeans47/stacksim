import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

/** A single-key object whose key is Ref, Condition, or Fn::*. */
export function isIntrinsic(value: unknown): value is JsonObject {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === "Ref" || keys[0] === "Condition" || keys[0].startsWith("Fn::"));
}

export function isIntrinsicIf(value: unknown): value is { "Fn::If": unknown[] } {
  return isIntrinsic(value) && Array.isArray(value["Fn::If"]);
}

export function isNoValue(value: unknown): boolean {
  return isObject(value) && value.Ref === "AWS::NoValue" && Object.keys(value).length === 1;
}

export const ref = (logicalId: string): JsonObject => ({ Ref: logicalId });
export const getAtt = (logicalId: string, attribute: string): JsonObject => ({ "Fn::GetAtt": [logicalId, attribute] });
export const fnSub = (template: string, variables?: JsonObject): JsonObject => ({ "Fn::Sub": variables === undefined ? template : [template, variables] });

/** The logical ID in a Ref or a two-part Fn::GetAtt (SAM's get_logical_id_from_intrinsic). */
export function logicalIdFromIntrinsic(value: unknown): string | undefined {
  if (!isIntrinsic(value)) return undefined;
  if (typeof value.Ref === "string") return value.Ref;
  const attribute = value["Fn::GetAtt"];
  if (Array.isArray(attribute) && attribute.length === 2 && typeof attribute[0] === "string") return attribute[0];
  if (typeof attribute === "string" && attribute.split(".").length === 2) return attribute.split(".")[0];
  return undefined;
}

/** SAM's make_shorthand: `${X}` for `Ref X` and `${X.Arn}` for `Fn::GetAtt [X, Arn]`, for use inside Fn::Sub. */
export function shorthand(value: JsonObject): string {
  if (typeof value.Ref === "string") return `\${${value.Ref}}`;
  const attribute = value["Fn::GetAtt"];
  if (Array.isArray(attribute)) return `\${${attribute.join(".")}}`;
  throw new TypeError("shorthand expects a Ref or Fn::GetAtt");
}

/** SAM's tag list: dictionary order, null values become empty strings. */
export function tagList(tags: unknown): Array<{ Key: unknown; Value: unknown }> {
  if (!isObject(tags)) return [];
  return Object.entries(tags).map(([Key, Value]) => ({ Key, Value: Value ?? "" }));
}

/**
 * Canonical JSON as Python's json.dumps(sort_keys=True, separators=(",", ":"))
 * writes it with ensure_ascii, which SAM uses for hash inputs.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null).replace(/[\u0080-￿]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${canonicalJson(key)}:${canonicalJson((value as JsonObject)[key])}`).join(",")}}`;
}

/**
 * Python's json.dumps(value, sort_keys=True, indent=indent, separators=(",", ": "))
 * with ensure_ascii, which SAM uses to render state machine definitions.
 */
export function pythonIndentedJson(value: unknown, indent = 4, depth = 0): string {
  if (value === null || typeof value !== "object") return canonicalJson(value);
  const inner = " ".repeat(indent * (depth + 1));
  const outer = " ".repeat(indent * depth);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map(item => `${inner}${pythonIndentedJson(item, indent, depth + 1)}`).join(",\n")}\n${outer}]`;
  }
  const keys = Object.keys(value).sort();
  if (!keys.length) return "{}";
  return `{\n${keys.map(key => `${inner}${canonicalJson(key)}: ${pythonIndentedJson((value as JsonObject)[key], indent, depth + 1)}`).join(",\n")}\n${outer}}`;
}

export function sha1Hex(data: string): string {
  return createHash("sha1").update(data, "utf8").digest("hex");
}

/**
 * SAM's LogicalIdGenerator: a string is hashed as-is, anything else as
 * canonical JSON. An empty input yields no suffix.
 */
export function logicalIdHash(data: unknown, length = 10): string {
  const text = typeof data === "string" ? data : data ? canonicalJson(data) : "";
  return text ? sha1Hex(text).slice(0, length) : "";
}

export function generatedLogicalId(prefix: string, data: unknown): string {
  return `${prefix}${logicalIdHash(data)}`;
}

/** Resource attributes SAM copies from a SAM resource to every resource it generates. */
export const PASSTHROUGH_ATTRIBUTES = ["Condition", "DeletionPolicy", "UpdateReplacePolicy"] as const;

export function passthroughAttributes(resource: JsonObject): JsonObject {
  const attributes: JsonObject = {};
  for (const name of PASSTHROUGH_ATTRIBUTES) if (resource[name] !== undefined) attributes[name] = resource[name];
  return attributes;
}

/** The attributes SAM keeps on the main resource it translates a SAM resource into. */
export function primaryAttributes(resource: JsonObject): JsonObject {
  const attributes: JsonObject = {};
  for (const name of ["DependsOn", "Condition", "DeletionPolicy", "UpdateReplacePolicy", "UpdatePolicy", "Metadata"]) if (resource[name] !== undefined) attributes[name] = resource[name];
  return attributes;
}

/**
 * Build a CloudFormation resource, omitting undefined properties. Empty
 * Properties are omitted unless `keepEmpty`, which matches SAM's output for
 * resources such as generated queues and topics.
 */
export function cfnResource(type: string, properties: JsonObject, attributes: JsonObject = {}, keepEmpty = false): JsonObject {
  const defined = Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined && value !== null));
  return { Type: type, ...(keepEmpty || Object.keys(defined).length ? { Properties: defined } : {}), ...attributes };
}

/** SAM's make_conditional: `Fn::If [condition, value, AWS::NoValue]`. */
export const makeConditional = (condition: unknown, whenTrue: unknown, whenFalse: unknown = { Ref: "AWS::NoValue" }): JsonObject => ({ "Fn::If": [condition, whenTrue, whenFalse] });

// --- Errors in SAM's InvalidDocumentException format ---------------------------------

/** One cause in a SAM transform failure; its message is already in SAM's shape. */
export class SamCause extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamCause";
  }
}

export const resourceError = (logicalId: string, message: string) => new SamCause(`Resource with id [${logicalId}] is invalid. ${message}`);
export const eventError = (eventId: string, message: string) => new SamCause(`Event with id [${eventId}] is invalid. ${message}`);
export const templateError = (message: string) => new SamCause(`Structure of the SAM template is invalid. ${message}`);
export const globalsError = (message: string) => new SamCause(`'Globals' section is invalid. ${message}`);

/** Raised to abort with a complete list of causes, as SAM's InvalidDocumentException does. */
export class SamDocumentError extends Error {
  constructor(public readonly causes: SamCause[]) {
    super(causes.map(cause => cause.message).join(" "));
    this.name = "SamDocumentError";
  }
}

/**
 * An InvalidDocumentException raised while SAM translates a resource. SAM's
 * translator does not catch it per resource, so it ends the transform with
 * only its own causes.
 */
export class SamInvalidDocument extends SamDocumentError {}

/** Python's repr() of a JSON value, as SAM's messages print lists and maps. */
export function pythonRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(", ")}]`;
  if (isObject(value)) return `{${Object.entries(value).map(([key, item]) => `${pythonRepr(key)}: ${pythonRepr(item)}`).join(", ")}}`;
  return String(value);
}

/** Python's str() of a JSON value, as SAM's f-strings print it. */
export const pythonStr = (value: unknown): string => typeof value === "string" ? value : pythonRepr(value);

export function invalidProperty(logicalId: string, property: string, message: string): SamCause {
  return resourceError(logicalId, `Property '${property}' ${message}`);
}

/** Run a step; a SAM cause becomes a resource error unless it already names one. */
export function attempt<T>(causes: SamCause[], logicalId: string, step: () => T): T | undefined {
  try {
    return step();
  } catch (error) {
    if (error instanceof SamDocumentError) { causes.push(...error.causes); return undefined; }
    if (error instanceof SamCause) {
      causes.push(error.message.startsWith("Resource with id [") || error.message.startsWith("Structure of the SAM template") ? error : resourceError(logicalId, error.message));
      return undefined;
    }
    throw error;
  }
}

/** Type checks with SAM's messages for resource properties. */
export function expectString(value: unknown, logicalId: string, property: string): string {
  if (typeof value !== "string") throw resourceError(logicalId, `Property '${property}' should be a string.`);
  return value;
}

export function expectMap(value: unknown, logicalId: string, property: string): JsonObject {
  if (!isObject(value)) throw resourceError(logicalId, `Property '${property}' should be a map.`);
  return value;
}

/** How SAM's resource models type-check one property (samtranslator.model.types). */
export type PropertyCheck = "string" | "map" | "boolean" | "integer" | "list" | "string-or-map" | "boolean-or-map" | "list-of-string-or-map" | "string-or-list-of-string-or-map" | { readonly enum: readonly string[] };

export interface PropertySpec {
  readonly type: PropertyCheck;
  readonly required?: boolean;
  /** False for SAM's `Property` (no intrinsic support); a single-key map otherwise skips the check. */
  readonly intrinsics?: boolean;
  /**
   * The validator is not exactly IS_STR or IS_DICT (for example one_of(IS_STR)),
   * so SAM's message names no type.
   */
  readonly generic?: boolean;
}

function checkValue(type: PropertyCheck, value: unknown): boolean {
  if (typeof type === "object") return typeof value === "string" && type.enum.includes(value);
  switch (type) {
    case "string": return typeof value === "string";
    case "map": return isObject(value);
    case "boolean": return typeof value === "boolean";
    // Python's bool is an int.
    case "integer": return typeof value === "boolean" || Number.isInteger(value);
    case "list": return Array.isArray(value);
    case "string-or-map": return typeof value === "string" || isObject(value);
    case "boolean-or-map": return typeof value === "boolean" || isObject(value);
    case "list-of-string-or-map": return Array.isArray(value) && value.every(item => typeof item === "string" || isObject(item));
    case "string-or-list-of-string-or-map": return typeof value === "string" || checkValue("list-of-string-or-map", value);
  }
}

function typeDescription(type: PropertyCheck): string | undefined {
  if (typeof type === "object") {
    const values = type.enum.map(value => `'${value}'`);
    return `one of the strings: ${values.length > 1 ? `${values.slice(0, -1).join(", ")} or ${values.at(-1)}` : values[0]}`;
  }
  return type === "map" ? "map" : type === "string" ? "string" : undefined;
}

/**
 * SAM's Resource.validate_properties: required properties are present and
 * values have the right type. Any single-key map counts as an intrinsic and
 * skips the check unless the property does not support intrinsics.
 */
export function validateProperties(logicalId: string, properties: JsonObject, spec: Readonly<Record<string, PropertySpec>>): void {
  for (const [name, property] of Object.entries(spec)) {
    const value = properties[name];
    if (property.intrinsics !== false && isObject(value) && Object.keys(value).length === 1) continue;
    if (value === undefined || value === null) {
      if (property.required) throw resourceError(logicalId, `Missing required property '${name}'.`);
    } else if (!checkValue(property.type, value)) {
      const description = property.generic ? undefined : typeDescription(property.type);
      throw resourceError(logicalId, description ? `Property '${name}' should be a ${description}.` : `Type of property '${name}' is invalid.`);
    }
  }
}
