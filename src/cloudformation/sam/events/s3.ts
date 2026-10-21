import { canonicalJson, eventError, getAtt, isObject, makeConditional, ref, resourceError, type JsonObject } from "../common.js";
import type { SamContext } from "../context.js";
import { eventPermission, readEventProperties, type EventSpec, type EventTarget } from "./common.js";

const S3_SPEC: EventSpec = {
  Bucket: { type: "string", required: true },
  Events: { type: "string-or-string-list", required: true },
  Filter: { type: "string-map" },
};

/** The properties SAM's S3Bucket model knows; it re-reads the referenced bucket with them. */
const BUCKET_PROPERTIES = new Set([
  "AccessControl", "AccelerateConfiguration", "AnalyticsConfigurations", "BucketEncryption", "BucketName", "CorsConfiguration",
  "IntelligentTieringConfigurations", "InventoryConfigurations", "LifecycleConfiguration", "LoggingConfiguration", "MetricsConfigurations",
  "NotificationConfiguration", "ObjectLockConfiguration", "ObjectLockEnabled", "OwnershipControls", "PublicAccessBlockConfiguration",
  "ReplicationConfiguration", "Tags", "VersioningConfiguration", "WebsiteConfiguration",
]);
/** Resource attributes SAM's Resource model keeps when it writes the bucket back. */
const BUCKET_ATTRIBUTES = ["DeletionPolicy", "UpdatePolicy", "Condition", "UpdateReplacePolicy", "Metadata"];

export const readS3Event = (eventLogicalId: string, event: JsonObject): JsonObject => readEventProperties(eventLogicalId, "S3", event, S3_SPEC);

/** S3.resources_to_link: the bucket must be a Ref to a resource in the same template. */
export function linkedBucketId(context: SamContext, eventId: string, properties: JsonObject): string {
  const bucket = properties.Bucket;
  if (isObject(bucket) && Object.hasOwn(bucket, "Ref")) {
    const bucketId = bucket.Ref;
    if (typeof bucketId !== "string") throw eventError(eventId, "'Ref' value in S3 events is not a valid string.");
    if (Object.hasOwn(context.resources, bucketId)) return bucketId;
  }
  throw eventError(eventId, "S3 events must reference an S3 bucket in the same template.");
}

/** Validate and normalize the bucket as SAM's S3Bucket.from_dict(...).to_dict() does. */
function rebuildBucket(bucketId: string, bucket: JsonObject): JsonObject {
  if (bucket.Type !== "AWS::S3::Bucket") throw resourceError(bucketId, `Resource has incorrect Type; expected 'AWS::S3::Bucket', got '${String(bucket.Type)}'`);
  const properties = bucket.Properties as JsonObject;
  for (const name of Object.keys(properties)) if (!BUCKET_PROPERTIES.has(name)) throw resourceError(bucketId, `property ${name} not defined for resource of type AWS::S3::Bucket`);
  const rebuilt: JsonObject = { Type: bucket.Type };
  if (bucket.DependsOn !== undefined && bucket.DependsOn !== null && !(Array.isArray(bucket.DependsOn) && bucket.DependsOn.length === 0)) rebuilt.DependsOn = bucket.DependsOn;
  for (const attribute of BUCKET_ATTRIBUTES) if (bucket[attribute] !== undefined) rebuilt[attribute] = bucket[attribute];
  rebuilt.Properties = Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined && value !== null));
  return rebuilt;
}

/**
 * S3 event: `<F><Event>Permission`, plus a Lambda notification and a
 * dependency on the permission added to the referenced bucket, which SAM
 * rewrites in place. A function Condition makes the notification conditional
 * and replaces the DependsOn with SAM's conditional-dependency tag.
 */
export function translateS3Event(context: SamContext, target: EventTarget, eventId: string, properties: JsonObject, bucketId: string): Record<string, JsonObject> {
  const logicalId = `${target.functionLogicalId}${eventId}`;
  const [permissionId, permission] = eventPermission(target, logicalId, "s3.amazonaws.com", { SourceAccount: ref("AWS::AccountId") });
  const bucket = context.resources[bucketId];
  const condition = target.fn.Condition;

  if (condition !== undefined) {
    const bucketProperties = (bucket.Properties ??= {}) as JsonObject;
    const tags = (bucketProperties.Tags ??= []);
    if (!Array.isArray(tags)) throw resourceError(bucketId, "Property 'Tags' should be a list.");
    bucketProperties.Tags = [...tags, { Key: `sam:ConditionalDependsOn:${permissionId}`, Value: makeConditional(condition, ref(permissionId), "no dependency") }];
  } else {
    // A DependsOn key with no value is invalid, as in SAM (`bucket.get("DependsOn", [])` returns None).
    let dependsOn = Object.hasOwn(bucket, "DependsOn") ? bucket.DependsOn : [];
    if (typeof dependsOn === "string") dependsOn = [dependsOn];
    if (!Array.isArray(dependsOn) || dependsOn.some(item => item === null || isObject(item) || Array.isArray(item))) throw resourceError(logicalId, "Invalid type for field 'DependsOn'. Expected a string or list of strings.");
    bucket.DependsOn = [...new Set([...dependsOn, permissionId])];
  }

  const eventTypes = Array.isArray(properties.Events) ? properties.Events : [properties.Events];
  const mappings = eventTypes.map(eventType => {
    const mapping: JsonObject = { Function: target.functionArn, ...(properties.Filter !== undefined && properties.Filter !== null ? { Filter: structuredClone(properties.Filter) } : {}), Event: eventType };
    return condition !== undefined ? makeConditional(condition, mapping) : mapping;
  });
  const bucketProperties = bucket.Properties ?? {};
  if (!isObject(bucketProperties)) throw resourceError(bucketId, "Properties should be a map.");
  bucket.Properties = bucketProperties;
  const notification = (bucketProperties.NotificationConfiguration ??= {});
  if (!isObject(notification)) throw resourceError(bucketId, "Property 'NotificationConfiguration' should be a map.");
  const lambda = (notification.LambdaConfigurations ??= []);
  if (!Array.isArray(lambda)) throw resourceError(bucketId, "Invalid type for LambdaConfigurations. Must be a list.");
  for (const mapping of mappings) if (!lambda.some(existing => canonicalJson(existing) === canonicalJson(mapping))) lambda.push(mapping);
  context.resources[bucketId] = rebuildBucket(bucketId, bucket);
  return { [permissionId]: permission };
}
