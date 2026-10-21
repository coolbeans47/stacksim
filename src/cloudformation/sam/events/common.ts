import { permissionLogicalId } from "../api.js";
import { cfnResource, isObject, passthroughAttributes, ref, resourceError, type JsonObject } from "../common.js";

/** The function and generated role an event source attaches to. */
export interface EventTarget {
  readonly functionLogicalId: string;
  readonly fn: JsonObject;
  /** SAM's generated execution role, or undefined when the function names its own Role. */
  readonly role: JsonObject | undefined;
  readonly partition: string;
  /**
   * The resource events connect to: the function, or its AutoPublishAlias
   * alias. SAM's `get_runtime_attr("name")` (falling back to "arn" for an
   * alias) and `get_runtime_attr("arn")` of that resource.
   */
  readonly invokeLogicalId: string;
  readonly functionName: JsonObject;
  readonly functionArn: JsonObject;
}

/** The event target for a function, or for the alias SAM connects events to when AutoPublishAlias is set. */
export function eventTarget(functionLogicalId: string, fn: JsonObject, role: JsonObject | undefined, partition: string, aliasLogicalId?: string): EventTarget {
  return aliasLogicalId
    ? { functionLogicalId, fn, role, partition, invokeLogicalId: aliasLogicalId, functionName: ref(aliasLogicalId), functionArn: ref(aliasLogicalId) }
    : { functionLogicalId, fn, role, partition, invokeLogicalId: functionLogicalId, functionName: ref(functionLogicalId), functionArn: { "Fn::GetAtt": [functionLogicalId, "Arn"] } };
}

/** PushEventSource._construct_permission: `<F><Event>Permission` letting a service invoke the function. */
export function eventPermission(target: EventTarget, eventLogicalId: string, principal: string, source: { SourceArn?: unknown; SourceAccount?: unknown }): [string, JsonObject] {
  return [permissionLogicalId(eventLogicalId, ""), cfnResource("AWS::Lambda::Permission", {
    Action: "lambda:InvokeFunction",
    FunctionName: target.functionName,
    Principal: principal,
    SourceArn: source.SourceArn,
    SourceAccount: source.SourceAccount,
  }, passthroughAttributes(target.fn))];
}

/** How SAM validates one event property (samtranslator.model.types). */
export type EventPropertyType =
  | "string" | "map" | "boolean" | "integer" | "list"
  /** PassThroughProperty: any value, read only to pass it on. */
  | "passthrough"
  /** S3 Events: one_of(IS_STR, list_of(IS_STR)), without intrinsics. */
  | "string-or-string-list"
  /** S3 Filter: dict_of(IS_STR, IS_STR). */
  | "string-map"
  /** SNS SqsSubscription: one_of(IS_BOOL, IS_DICT). */
  | "boolean-or-map";

export interface EventPropertySpec {
  readonly type: EventPropertyType;
  readonly required?: boolean;
  /** False for SAM's `Property`, which type-checks intrinsics too. */
  readonly intrinsics?: boolean;
}

export type EventSpec = Readonly<Record<string, EventPropertySpec>>;

/** Python truthiness, which SAM's `if self.X:` checks use. */
export function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

const isString = (value: unknown): boolean => typeof value === "string";
const isInteger = (value: unknown): boolean => typeof value === "boolean" || Number.isInteger(value);

function valid(type: EventPropertyType, value: unknown): boolean {
  switch (type) {
    case "string": return isString(value);
    case "map": return isObject(value);
    case "boolean": return typeof value === "boolean";
    // Python's bool is an int, so IS_INT accepts booleans.
    case "integer": return isInteger(value);
    case "list": return Array.isArray(value);
    case "passthrough": return true;
    case "string-or-string-list": return isString(value) || (Array.isArray(value) && value.every(isString));
    case "string-map": return isObject(value) && Object.values(value).every(isString);
    case "boolean-or-map": return typeof value === "boolean" || isObject(value);
  }
}

/** InvalidResourcePropertyTypeException names a type only for IS_DICT and IS_STR. */
function typeMessage(type: EventPropertyType, property: string): string {
  if (type === "map") return `Property '${property}' should be a map.`;
  if (type === "string") return `Property '${property}' should be a string.`;
  return `Type of property '${property}' is invalid.`;
}

/**
 * SAM's Resource.from_dict for an event source: every property must be one
 * the event type defines, required ones must be present, and values must have
 * the right type. A single-key map is taken to be an intrinsic and skips the
 * type check, except for properties that do not support intrinsics. Errors
 * name the event's generated logical ID (`<Function><Event>`), as SAM's do.
 */
export function readEventProperties(eventLogicalId: string, eventType: string, event: JsonObject, spec: EventSpec): JsonObject {
  const properties = event.Properties === undefined || event.Properties === null ? {} : event.Properties;
  if (!isObject(properties)) throw resourceError(eventLogicalId, "Properties of a resource must be an object.");
  for (const name of Object.keys(properties)) {
    if (!Object.hasOwn(spec, name)) throw resourceError(eventLogicalId, `property ${name} not defined for resource of type ${eventType}`);
  }
  for (const [name, property] of Object.entries(spec)) {
    const value = properties[name];
    const intrinsics = property.intrinsics !== false && property.type !== "passthrough" && property.type !== "string-or-string-list";
    if (intrinsics && isObject(value) && Object.keys(value).length === 1) continue;
    if (value === undefined || value === null) {
      if (property.required) throw resourceError(eventLogicalId, `Missing required property '${name}'.`);
    } else if (!valid(property.type, value)) {
      throw resourceError(eventLogicalId, typeMessage(property.type, name));
    }
  }
  return properties;
}

/** Copy the defined values of `names` from `source`, in order. */
export function pick(source: JsonObject, names: readonly string[]): JsonObject {
  return Object.fromEntries(names.filter(name => source[name] !== undefined && source[name] !== null).map(name => [name, source[name]]));
}
