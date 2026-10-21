import { parseS3Uri, translateApiEvent } from "./api.js";
import { cfnResource, eventError, getAtt, isIntrinsicIf, isObject, passthroughAttributes, primaryAttributes, resourceError, SamCause, tagList, type JsonObject } from "./common.js";
import type { SamContext } from "./context.js";
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

function codeLocation(logicalId: string, value: unknown, property: string): JsonObject {
  let pointer: JsonObject;
  if (isObject(value)) {
    if (!value.Bucket || !value.Key) throw resourceError(logicalId, `'${property}' requires Bucket and Key properties to be specified.`);
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

/** AWS::Serverless::Function (PackageType Zip) → Lambda function, generated role, and event resources. */
export function translateFunction(context: SamContext, logicalId: string, resource: JsonObject): Record<string, JsonObject> {
  const properties = isObject(resource.Properties) ? resource.Properties : {};
  const passthrough = passthroughAttributes(resource);

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
  };
  const output: Record<string, JsonObject> = {};

  const roleLogicalId = `${logicalId}Role`;
  if (fn.Role === undefined || fn.Role === null) {
    const managed: unknown[] = [awsManagedPolicyArn("AWSLambdaBasicExecutionRole", context.partition)];
    // SAM keeps the older X-Ray policy name in the aws partition.
    if (tracingEnabled) managed.push(awsManagedPolicyArn(context.partition === "aws" ? "AWSXrayWriteOnlyAccess" : "AWSXRayDaemonWriteAccess", context.partition));
    const documents: unknown[] = isObject(dlq) ? [{ PolicyName: "DeadLetterQueuePolicy", PolicyDocument: { Version: "2012-10-17", Statement: [{ Action: DLQ_ACTIONS[dlq.Type as string], Resource: dlq.TargetArn, Effect: "Allow" }] } }] : [];
    output[roleLogicalId] = constructRole({
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
  output[logicalId] = cfnResource("AWS::Lambda::Function", fn, primaryAttributes(resource));

  if (isObject(properties.Events)) {
    const events = Object.entries(properties.Events).sort(([leftId, left], [rightId, right]) => {
      const key = (id: string, event: unknown) => {
        const path = isObject(event) && isObject(event.Properties) ? event.Properties.Path : undefined;
        return typeof path === "string" ? path : id;
      };
      const leftKey = key(leftId, left);
      const rightKey = key(rightId, right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    // SAM stops at the first invalid event of a function.
    for (const [eventId, event] of events) {
      try {
        if (!isObject(event)) throw eventError(eventId, "Resource dict has missing or invalid value for key Type. Event Type is: None.");
        if (event.Type === "Api") Object.assign(output, translateApiEvent(context, resource, logicalId, eventId, event));
        else if (event.Type === "HttpApi") Object.assign(output, translateHttpApiEvent(context, resource, logicalId, eventId, event));
        else throw eventError(eventId, `Resource dict has missing or invalid value for key Type. Event Type is: ${String(event.Type)}.`);
      } catch (error) {
        if (error instanceof SamCause && !error.message.startsWith("Resource with id [") && !error.message.startsWith("Structure of the SAM template")) throw resourceError(logicalId, error.message);
        throw error;
      }
    }
  }

  if (properties.PropagateTags === true && isObject(properties.Tags) && Object.keys(properties.Tags).length) {
    for (const generated of Object.values(output)) {
      if (generated.Type === "AWS::Lambda::Function" || generated.Type === "AWS::IAM::Role") (generated.Properties as JsonObject).Tags = tagList(properties.Tags);
    }
  }
  return output;
}
