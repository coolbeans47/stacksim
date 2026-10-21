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

/** Build a CloudFormation resource, omitting undefined properties and empty Properties. */
export function cfnResource(type: string, properties: JsonObject, attributes: JsonObject = {}): JsonObject {
  const defined = Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined && value !== null));
  return { Type: type, ...(Object.keys(defined).length ? { Properties: defined } : {}), ...attributes };
}

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
