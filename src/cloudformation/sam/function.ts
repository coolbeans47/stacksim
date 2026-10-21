import { parseS3Uri, translateApiEvent } from "./api.js";
import { canonicalJson, cfnResource, clone, eventError, getAtt, isIntrinsicIf, isObject, logicalIdFromIntrinsic, logicalIdHash, passthroughAttributes, primaryAttributes, ref, resourceError, SamCause, tagList, validateProperties, type JsonObject, type PropertySpec } from "./common.js";
import { addReference, type SamContext } from "./context.js";
import { translateEventInvokeConfig } from "./event-invoke-config.js";
import { eventTarget, truthy, type EventTarget } from "./events/common.js";
import { readLogsEvent, translateLogsEvent } from "./events/logs.js";
import { readPullEvent, translatePullEvent } from "./events/pull.js";
import { RULE_EVENT_TYPES, readRuleEvent, translateRuleEvent } from "./events/rules.js";
import { linkedBucketId, readS3Event, translateS3Event } from "./events/s3.js";
import { readSnsEvent, translateSnsEvent } from "./events/sns.js";
import { translateFunctionUrl } from "./function-url.js";
import { translateHttpApiEvent } from "./http-api.js";
import { resolveParameterRefs } from "./parameters.js";
import { LAMBDA_ASSUME_ROLE_POLICY, awsManagedPolicyArn, constructRole } from "./policies.js";

const SAM_TAG = "lambda:createdBy";
const RESERVED_TAGS = [SAM_TAG, "serverlessrepo:applicationId", "serverlessrepo:semanticVersion"];
const DLQ_ACTIONS: Readonly<Record<string, string>> = { SQS: "sqs:SendMessage", SNS: "sns:Publish" };

/** SAM's tag list for Lambda functions and their roles: the SAM tag first, then the template's tags. */
function functionTags(logicalId: string, tags: unknown): Array<{ Key: unknown; Value: unknown }> {
  const values = isObject(tags) ? tags : {};
  for (const reserved of RESERVED_TAGS) {
    if (Object.hasOwn(values, reserved)) throw resourceError(logicalId, `${reserved} is a reserved Tag key name and cannot be set on your resource. Please change the tag key in the input.`);
  }
  return [{ Key: SAM_TAG, Value: "SAM" }, ...tagList(values)];
}

/** construct_s3_location_object: a Lambda `Code` or `Content` location from `CodeUri` or `ContentUri`. */
export function codeLocation(logicalId: string, value: unknown, property: string): JsonObject {
  let pointer: JsonObject;
  if (isObject(value)) {
    if (!value.Bucket || !value.Key) throw resourceError(logicalId, `'${property}' requires Bucket and Key properties to be specified.`);
    // SAM maps StorageMode to S3ObjectStorageMode, which StackSim's Lambda does not model.
    if (Object.hasOwn(value, "StorageMode")) throw resourceError(logicalId, `'StorageMode' in '${property}' is not supported by StackSim.`);
    pointer = value;
  } else if (typeof value === "string") {
    const dynamicReference = /\{\{resolve:(ssm|ssm-secure|secretsmanager):[a-zA-Z0-9_.\-/]+(:\d+)?\}\}/.exec(value);
    if (dynamicReference && dynamicReference[0].includes("/")) throw resourceError(logicalId, `Unsupported dynamic reference detected in '${property}'. Please consider using alternative 'FunctionCode' object format.`);
    const parsed = parseS3Uri(value);
    if (!parsed) throw resourceError(logicalId, `'${property}' is not a valid S3 Uri of the form 's3://bucket/key' with optional versionId query parameter.`);
    pointer = parsed;
  } else throw resourceError(logicalId, `'${property}' must be of type dict or string.`);
  return { S3Bucket: pointer.Bucket, S3Key: pointer.Key, ...(pointer.Version !== undefined ? { S3ObjectVersion: pointer.Version } : {}) };
}

/** SamFunction.property_types for the SAM-04 properties, in SAM's order. */
const PUBLISHING_PROPERTIES: Readonly<Record<string, PropertySpec>> = {
  Layers: { type: "list-of-string-or-map", generic: true },
  AutoPublishAlias: { type: "string", generic: true },
  AutoPublishCodeSha256: { type: "string", generic: true },
  AutoPublishAliasAllProperties: { type: "boolean", intrinsics: false },
  VersionDeletionPolicy: { type: { enum: ["Delete", "Retain"] } },
};

/** SAM's alias name rule: letters, digits, hyphens, and underscores, and not only digits. */
const ALIAS_NAME = /^(?![0-9]+$)[a-zA-Z0-9\-_]+$/;

interface PublishedAlias {
  readonly name: string;
  readonly aliasLogicalId: string;
  readonly versionLogicalId: string;
  readonly resources: Record<string, JsonObject>;
}

/** The properties of a Lambda function as SAM's resource dict holds them: undefined and null omitted. */
const definedProperties = (properties: JsonObject): JsonObject => Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined && value !== null));

/**
 * AutoPublishAlias: a retained `<F>Version<hash>` and the `<F>Alias<name>`
 * that points at it. The version hash covers the resolved code, Environment,
 * and MemorySize, or every function property (plus layers that set
 * PublishLambdaVersion) with AutoPublishAliasAllProperties, or the first ten
 * characters of AutoPublishCodeSha256.
 */
function publishAlias(context: SamContext, logicalId: string, resource: JsonObject, properties: JsonObject, fn: JsonObject): PublishedAlias {
  const name = resolveParameterRefs(clone(properties.AutoPublishAlias), context.parameters);
  if (typeof name !== "string") throw resourceError(logicalId, "'AutoPublishAlias' must be a string or a Ref to a template parameter");
  let codeSha256: string | undefined;
  if (truthy(properties.AutoPublishCodeSha256)) {
    const resolved = resolveParameterRefs(clone(properties.AutoPublishCodeSha256), context.parameters);
    if (typeof resolved !== "string") throw resourceError(logicalId, "AutoPublishCodeSha256 must be a string");
    codeSha256 = resolved;
    // SAM appends the hash to the description so that a code-only change still changes the function.
    const description = resolveParameterRefs(clone(properties.Description), context.parameters);
    if (!truthy(description) || typeof description === "string") fn.Description = truthy(description) ? `${description as string} ${codeSha256}` : codeSha256;
    else fn.Description = { "Fn::Join": [" ", [description, codeSha256]] };
  }
  // SAM resolves parameter references in the code location in place, so the function sees them resolved too.
  fn.Code = resolveParameterRefs(fn.Code, context.parameters);
  let hashInput: JsonObject;
  if (truthy(properties.AutoPublishAliasAllProperties)) {
    hashInput = definedProperties(fn);
    for (const layer of Array.isArray(fn.Layers) ? fn.Layers : []) {
      const layerId = logicalIdFromIntrinsic(layer);
      const layerResource = layerId ? context.resources[layerId] : undefined;
      const layerProperties = isObject(layerResource) && isObject(layerResource.Properties) ? layerResource.Properties : {};
      if (layerId && truthy(layerProperties.PublishLambdaVersion)) hashInput[layerId] = layerProperties;
    }
  } else {
    hashInput = isObject(fn.Code) ? { ...fn.Code } : {};
    if (isObject(fn.Environment)) Object.assign(hashInput, fn.Environment);
    if (truthy(fn.MemorySize)) hashInput.MemorySize = fn.MemorySize;
  }
  const suffix = codeSha256 ? codeSha256.slice(0, 10) : truthy(hashInput) ? logicalIdHash(canonicalJson(hashInput)) : "";
  const versionLogicalId = `${logicalId}Version${suffix}`;
  const passthrough = passthroughAttributes(resource);
  const versionAttributes: JsonObject = { ...passthrough };
  if (!Object.hasOwn(versionAttributes, "DeletionPolicy")) versionAttributes.DeletionPolicy = properties.VersionDeletionPolicy ?? "Retain";

  if (!name) throw resourceError(logicalId, "Alias name is required to create an alias");
  if (!ALIAS_NAME.test(name)) throw resourceError(logicalId, `AutoPublishAlias name ('${name}') must contain only alphanumeric characters, hyphens, or underscores matching (?!^[0-9]+$)([a-zA-Z0-9-_]+) pattern.`);
  const aliasLogicalId = `${logicalId}Alias${name.replaceAll("-", "D").replaceAll("_", "U")}`;
  return {
    name,
    aliasLogicalId,
    versionLogicalId,
    resources: {
      [versionLogicalId]: cfnResource("AWS::Lambda::Version", { Description: properties.VersionDescription, FunctionName: ref(logicalId) }, versionAttributes),
      [aliasLogicalId]: cfnResource("AWS::Lambda::Alias", {
        Name: name,
        FunctionName: ref(logicalId),
        FunctionVersion: getAtt(versionLogicalId, "Version"),
        ProvisionedConcurrencyConfig: properties.ProvisionedConcurrencyConfig,
      }, passthrough),
    },
  };
}

/** AWS::Serverless::Function (PackageType Zip) → Lambda function, generated role, and event resources. */
export function translateFunction(context: SamContext, logicalId: string, resource: JsonObject): Record<string, JsonObject> {
  const properties = isObject(resource.Properties) ? resource.Properties : {};
  const passthrough = passthroughAttributes(resource);
  validateProperties(logicalId, properties, PUBLISHING_PROPERTIES);
  // SAM validates events and links S3 buckets (resources_to_link) before it translates the function.
  const events = isObject(properties.Events) ? readEvents(context, logicalId, properties.Events) : undefined;
  if (properties.VersionDeletionPolicy !== undefined && properties.VersionDeletionPolicy !== null && (properties.AutoPublishAlias === undefined || properties.AutoPublishAlias === null)) {
    throw resourceError(logicalId, "'VersionDeletionPolicy' requires 'AutoPublishAlias'.");
  }

  const dlq = properties.DeadLetterQueue;
  if (dlq !== undefined && dlq !== null) {
    if (!isObject(dlq)) throw resourceError(logicalId, "Property 'DeadLetterQueue' should be a map.");
    if (!dlq.Type || !dlq.TargetArn) throw resourceError(logicalId, "'DeadLetterQueue' requires Type and TargetArn properties to be specified.");
    if (typeof dlq.Type !== "string") throw resourceError(logicalId, "Property 'DeadLetterQueue.Type' should be a string.");
    if (!Object.hasOwn(DLQ_ACTIONS, dlq.Type)) throw resourceError(logicalId, "'DeadLetterQueue' requires Type of ['SQS', 'SNS']");
  }
  const packageType = properties.PackageType ?? "Zip";
  if (packageType !== "Zip") throw resourceError(logicalId, packageType === "Image" ? "PackageType 'Image' is not supported by StackSim." : "PackageType needs to be `Zip` or `Image`");

  const inline = properties.InlineCode;
  const codeUri = properties.CodeUri;
  let code: JsonObject;
  if (inline !== undefined && inline !== null) code = { ZipFile: inline };
  else if (codeUri !== undefined && codeUri !== null) code = codeLocation(logicalId, codeUri, "CodeUri");
  else throw resourceError(logicalId, "Only one of 'InlineCode' or 'CodeUri' can be set.");
  if (!properties.Runtime || !properties.Handler) throw resourceError(logicalId, "Runtime and Handler needs to be present when PackageType is of type `Zip`");

  const tracing = properties.Tracing;
  const tracingEnabled = Boolean(tracing) && resolveParameterRefs(tracing, context.parameters) !== "Disabled";
  const fn: JsonObject = {
    FunctionName: properties.FunctionName || undefined,
    Handler: properties.Handler,
    Runtime: properties.Runtime,
    Description: properties.Description,
    MemorySize: properties.MemorySize,
    Timeout: properties.Timeout,
    Role: properties.Role,
    Environment: properties.Environment,
    Code: code,
    ReservedConcurrentExecutions: properties.ReservedConcurrentExecutions,
    Tags: functionTags(logicalId, properties.Tags),
    Architectures: properties.Architectures,
    EphemeralStorage: properties.EphemeralStorage,
    TracingConfig: tracingEnabled ? { Mode: tracing } : undefined,
    DeadLetterConfig: isObject(dlq) ? { TargetArn: dlq.TargetArn } : undefined,
    CodeSigningConfigArn: properties.CodeSigningConfigArn,
    LoggingConfig: properties.LoggingConfig,
    Layers: properties.Layers,
  };
  const output: Record<string, JsonObject> = {};
  if (truthy(properties.ProvisionedConcurrencyConfig) && !truthy(properties.AutoPublishAlias)) throw resourceError(logicalId, "To set ProvisionedConcurrencyConfig AutoPublishALias must be defined on the function");
  const published = truthy(properties.AutoPublishAlias) ? publishAlias(context, logicalId, resource, properties, fn) : undefined;
  // With an alias, URLs, permissions, event invoke configs, and event sources all target the alias.
  const urlTarget = ref(published ? published.aliasLogicalId : logicalId);
  const urlResources = truthy(properties.FunctionUrlConfig) ? translateFunctionUrl(logicalId, resource, properties.FunctionUrlConfig, urlTarget) : {};
  const eventInvoke = truthy(properties.EventInvokeConfig) ? translateEventInvokeConfig(context, logicalId, resource, properties.EventInvokeConfig, published && { name: published.name, logicalId: published.aliasLogicalId }) : { resources: {}, policies: [] };

  const roleLogicalId = `${logicalId}Role`;
  let role: JsonObject | undefined;
  if (fn.Role === undefined || fn.Role === null) {
    const managed: unknown[] = [awsManagedPolicyArn("AWSLambdaBasicExecutionRole", context.partition)];
    // SAM keeps the older X-Ray policy name in the aws partition.
    if (tracingEnabled) managed.push(awsManagedPolicyArn(context.partition === "aws" ? "AWSXrayWriteOnlyAccess" : "AWSXRayDaemonWriteAccess", context.partition));
    const documents: unknown[] = isObject(dlq) ? [{ PolicyName: "DeadLetterQueuePolicy", PolicyDocument: { Version: "2012-10-17", Statement: [{ Action: DLQ_ACTIONS[dlq.Type as string], Resource: dlq.TargetArn, Effect: "Allow" }] } }] : [];
    documents.push(...eventInvoke.policies);
    role = constructRole({
      logicalId,
      roleLogicalId,
      attributes: passthrough,
      partition: context.partition,
      assumeRolePolicyDocument: properties.AssumeRolePolicyDocument ?? LAMBDA_ASSUME_ROLE_POLICY(),
      managedPolicyArns: managed,
      policyDocuments: documents,
      policies: properties.Policies,
      rolePath: properties.RolePath,
      permissionsBoundary: properties.PermissionsBoundary,
      tags: functionTags(logicalId, properties.Tags),
    });
    fn.Role = getAtt(roleLogicalId, "Arn");
  } else if (isIntrinsicIf(fn.Role)) {
    throw resourceError(logicalId, "A 'Role' property that uses Fn::If is not supported by StackSim.");
  }
  // SAM's order: the function, its version and alias, its URL, event invoke resources, the role, then event resources.
  output[logicalId] = cfnResource("AWS::Lambda::Function", fn, primaryAttributes(resource));
  Object.assign(output, published?.resources ?? {}, urlResources, eventInvoke.resources);
  if (role) output[roleLogicalId] = role;

  const buckets = events ? translateEvents(context, eventTarget(logicalId, resource, role, context.partition, published?.aliasLogicalId), events, output) : [];

  const propagate = properties.PropagateTags === true && isObject(properties.Tags) && Object.keys(properties.Tags).length > 0;
  if (propagate) {
    for (const generated of Object.values(output)) {
      if (TAGGABLE_TYPES.has(generated.Type as string)) (generated.Properties as JsonObject).Tags = tagList(properties.Tags);
    }
  }
  // SAM writes each referenced bucket back with the last function's tag propagation.
  for (const bucketId of buckets) {
    if (propagate) context.bucketTags.set(bucketId, tagList(properties.Tags));
    else context.bucketTags.delete(bucketId);
  }
  // Referable properties resolve to the last generated resource of their type.
  if (published) {
    addReference(context, logicalId, "Alias", published.aliasLogicalId);
    addReference(context, logicalId, "Version", published.versionLogicalId);
  }
  for (const generatedId of Object.keys(output)) {
    const type = output[generatedId].Type;
    if (type === "AWS::SNS::Topic") addReference(context, logicalId, "DestinationTopic", generatedId);
    if (type === "AWS::SQS::Queue") addReference(context, logicalId, "DestinationQueue", generatedId);
  }
  return output;
}

/** Generated resource types whose SAM models have Tags, which PropagateTags replaces. */
const TAGGABLE_TYPES = new Set(["AWS::Lambda::Function", "AWS::IAM::Role", "AWS::SQS::Queue", "AWS::SNS::Topic"]);

/** SAM-03 event types and how SAM's Resource.from_dict validates their properties. */
const EVENT_READERS: Readonly<Record<string, (eventLogicalId: string, eventType: string, event: JsonObject) => JsonObject>> = {
  SQS: readPullEvent,
  DynamoDB: readPullEvent,
  SNS: (id, _type, event) => readSnsEvent(id, event),
  S3: (id, _type, event) => readS3Event(id, event),
  Schedule: readRuleEvent,
  CloudWatchEvent: readRuleEvent,
  EventBridgeRule: readRuleEvent,
  CloudWatchLogs: (id, _type, event) => readLogsEvent(id, event),
};

/** Run a step for one event; an event cause becomes a cause of the function. */
function inEvent<T>(logicalId: string, step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (error instanceof SamCause && !error.message.startsWith("Resource with id [") && !error.message.startsWith("Structure of the SAM template")) throw resourceError(logicalId, error.message);
    throw error;
  }
}

interface ReadEvent { readonly properties: JsonObject; readonly bucketId?: string }
interface ReadEvents { readonly events: JsonObject; readonly read: ReadonlyMap<string, ReadEvent> }

/** Validate every SAM-03 event in template order and link S3 buckets, as SAM's resources_to_link does. */
function readEvents(context: SamContext, logicalId: string, events: JsonObject): ReadEvents {
  const read = new Map<string, ReadEvent>();
  for (const [eventId, event] of Object.entries(events)) {
    if (!isObject(event) || typeof event.Type !== "string" || !Object.hasOwn(EVENT_READERS, event.Type)) continue;
    inEvent(logicalId, () => {
      const properties = EVENT_READERS[event.Type as string](`${logicalId}${eventId}`, event.Type as string, event);
      read.set(eventId, { properties, ...(event.Type === "S3" ? { bucketId: linkedBucketId(context, eventId, properties) } : {}) });
    });
  }
  return { events, read };
}

/**
 * Translate a function's events into `output`, sorted by Path or ID as SAM
 * does; the first invalid event stops the function. Returns the S3 buckets
 * the events edited.
 */
function translateEvents(context: SamContext, target: EventTarget, { events, read }: ReadEvents, output: Record<string, JsonObject>): string[] {
  const logicalId = target.functionLogicalId;
  const sorted = Object.entries(events).sort(([leftId, left], [rightId, right]) => {
    const key = (id: string, event: unknown) => {
      const path = isObject(event) && isObject(event.Properties) ? event.Properties.Path : undefined;
      return typeof path === "string" ? path : id;
    };
    const leftKey = key(leftId, left);
    const rightKey = key(rightId, right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const buckets: string[] = [];
  for (const [eventId, event] of sorted) {
    inEvent(logicalId, () => {
      if (!isObject(event)) throw eventError(eventId, "Resource dict has missing or invalid value for key Type. Event Type is: None.");
      const type = event.Type;
      const entry = read.get(eventId);
      if (type === "Api") Object.assign(output, translateApiEvent(context, target, eventId, event));
      else if (type === "HttpApi") Object.assign(output, translateHttpApiEvent(context, target, eventId, event));
      else if (entry && (type === "SQS" || type === "DynamoDB")) Object.assign(output, translatePullEvent(target, eventId, type, entry.properties));
      else if (entry && type === "SNS") Object.assign(output, translateSnsEvent(context, target, eventId, entry.properties));
      else if (entry && type === "S3") { Object.assign(output, translateS3Event(context, target, eventId, entry.properties, entry.bucketId!)); buckets.push(entry.bucketId!); }
      else if (entry && RULE_EVENT_TYPES.includes(type as string)) Object.assign(output, translateRuleEvent(target, eventId, type as string, entry.properties));
      else if (entry && type === "CloudWatchLogs") Object.assign(output, translateLogsEvent(target, eventId, entry.properties));
      else throw eventError(eventId, `Resource dict has missing or invalid value for key Type. Event Type is: ${String(type)}.`);
    });
  }
  return buckets;
}
