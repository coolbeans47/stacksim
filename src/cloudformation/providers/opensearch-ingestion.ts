import { AwsError } from "../../errors.js";
import type { OpenSearchIngestionService } from "../../opensearch/ingestion/service.js";
import type { PipelineRecord } from "../../opensearch/ingestion/model.js";
import { validateInput } from "../../opensearch/protocol.js";
import { ProviderReferenceError, validateDeclaredProperties, type ProductionResourceProvider, type ProviderContext, type ProviderSchema, type ProviderReadResult } from "./contract.js";

const TYPE = "AWS::OSIS::Pipeline";
type Model = Record<string, any>;
const owner = (context: ProviderContext) => `${context.stackId}/${context.logicalId}`;
const progress = (physicalId: string, operation: string) => ({ status: "IN_PROGRESS" as const, callbackAfterMs: 100, checkpoint: { schemaVersion: 1 as const, physicalId, callbackContext: { operation } } });
const failure = (error: unknown) => ({ status: "FAILED" as const, errorCode: error instanceof AwsError ? error.code : "InternalFailure", message: error instanceof Error ? error.message : String(error) });
const schema: ProviderSchema = {
  typeName: TYPE, unknownProperties: "REJECT", properties: {
    PipelineName: { valueType: "string", required: true, updateBehavior: "REPLACEMENT" },
    PipelineConfigurationBody: { valueType: "string", required: true, updateBehavior: "MUTABLE" },
    MinUnits: { valueType: "number", required: true, updateBehavior: "MUTABLE" }, MaxUnits: { valueType: "number", required: true, updateBehavior: "MUTABLE" },
    PipelineRoleArn: { valueType: "string", updateBehavior: "MUTABLE" }, BufferOptions: { valueType: "object", updateBehavior: "MUTABLE" },
    Tags: { valueType: "array", updateBehavior: "MUTABLE" }, LogPublishingOptions: { valueType: "object", updateBehavior: "MUTABLE" },
  }, ref: { supported: true, valueType: "string" }, attributes: { PipelineArn: { valueType: "string" }, IngestEndpointUrls: { valueType: "array" } },
  replacement: { defaultOrder: "CREATE_BEFORE_DELETE" }, retention: { deletionPolicies: ["Delete", "Retain", "RetainExceptOnCreate"], updateReplacePolicies: ["Delete", "Retain", "RetainExceptOnCreate"], snapshotSupported: false }, tags: { behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true },
};
function properties(pipeline: PipelineRecord): Model {
  return { PipelineName: pipeline.name, PipelineConfigurationBody: pipeline.configurationBody, MinUnits: pipeline.minUnits, MaxUnits: pipeline.maxUnits, PipelineRoleArn: pipeline.config.sink.roleArn, BufferOptions: { PersistentBufferEnabled: true }, LogPublishingOptions: structuredClone(pipeline.logPublishingOptions ?? { IsLoggingEnabled: false }), Tags: Object.entries(pipeline.tags).filter(([key]) => !key.toLowerCase().startsWith("aws:")).map(([Key, Value]) => ({ Key, Value })).sort((a, b) => a.Key.localeCompare(b.Key)) };
}
function result(pipeline: PipelineRecord): ProviderReadResult<Model> {
  if (pipeline.status.endsWith("FAILED")) return { status: "FAILED", physicalId: pipeline.arn, errorCode: "NotStabilized", message: pipeline.failure ?? "Pipeline failed" };
  if (!["ACTIVE", "STOPPED"].includes(pipeline.status)) return progress(pipeline.arn, "read");
  return { status: "SUCCESS", physicalId: pipeline.arn, model: { physicalId: pipeline.arn, properties: properties(pipeline), attributes: { PipelineArn: pipeline.arn, IngestEndpointUrls: pipeline.status === "ACTIVE" && !pipeline.config.s3 && !pipeline.config.dynamodb ? [`127.0.0.1:${pipeline.gatewayPort}`] : [] } } };
}
export function createOpenSearchIngestionProvider(service: OpenSearchIngestionService, region: string): ProductionResourceProvider<Model> {
  const owned = (id: string, context: ProviderContext) => {
    const pipeline = Object.values(service.state(region, context.accountId).pipelines).find(pipeline => pipeline.arn === id);
    if (!pipeline) throw new AwsError("ResourceNotFoundException", "Pipeline not found", 404);
    if (pipeline.owner !== owner(context)) throw new AwsError("OwnershipConflict", "Pipeline belongs to another resource generation", 409);
    service.authorizeOperation("GetPipeline", { PipelineName: pipeline.name }, region, context.principal.identity);
    return pipeline;
  };
  const call = (operation: string, input: Model, context: ProviderContext) => service.execute(operation, input, region, context.accountId, context.principal.identity, owner(context));
  return {
    typeName: TYPE, providerVersion: 1, visibility: "production", schema,
    validate(value) {
      const issues = [...validateDeclaredProperties(value, schema)];
      if (!issues.length) try { validateInput({ family: "osis", operation: "CreatePipeline", input: value as Model, status: 200 }); service.validateConfiguration(value); } catch (error) { issues.push({ code: "InvalidProperty", path: "Properties", pathSegments: ["Properties"], message: (error as Error).message }); }
      return issues;
    },
    canonicalize(value) { const desired = value as Model, config = service.validateConfiguration(desired); return { ...desired, LogPublishingOptions: config.logPublishingOptions, BufferOptions: { PersistentBufferEnabled: true }, PipelineRoleArn: config.config.sink.roleArn, Tags: [...(desired.Tags ?? [])].sort((a, b) => a.Key.localeCompare(b.Key)) }; },
    plan(previous, desired) {
      const changedProperties = previous ? Object.keys(desired).filter(key => JSON.stringify(previous[key]) !== JSON.stringify(desired[key])) : Object.keys(desired), replacementProperties = previous && previous.PipelineName !== desired.PipelineName ? ["PipelineName"] : [];
      return { action: !previous ? "CREATE" : replacementProperties.length ? "REPLACE" : changedProperties.length ? "UPDATE" : "NO_OP", desired, changedProperties, replacementProperties };
    },
    async create(desired, context) {
      try {
        const existing = Object.values(service.state(region, context.accountId).pipelines).find(pipeline => pipeline.name === desired.PipelineName);
        if (existing) return result(owned(existing.arn, context)) as any;
        const Tags = [...desired.Tags, { Key: "aws:cloudformation:stack-id", Value: context.stackId }, { Key: "aws:cloudformation:stack-name", Value: context.stackId.split(":stack/")[1]?.split("/")[0] ?? context.stackId }, { Key: "aws:cloudformation:logical-id", Value: context.logicalId }];
        const response = await call("CreatePipeline", { ...desired, Tags }, context); return progress(response.Pipeline.PipelineArn, "create");
      } catch (error) { return failure(error); }
    },
    async read(id, context) { try { return result(owned(id, context)); } catch (error) { return error instanceof AwsError && error.code === "ResourceNotFoundException" ? { status: "NOT_FOUND", physicalId: id } : failure(error); } },
    async update(id, previous, desired, context) {
      try {
        const pipeline = owned(id, context);
        if (pipeline.name !== desired.PipelineName) throw new AwsError("RequiresReplacement", "Pipeline name changes require replacement");
        if (context.callbackContext?.operation === "update") { const current = result(pipeline); return current.status === "IN_PROGRESS" ? progress(id, "update") : current as any; }
        const removed = Object.keys(pipeline.tags).filter(key => !key.toLowerCase().startsWith("aws:") && !desired.Tags.some((tag: any) => tag.Key === key));
        if (desired.Tags.length) await call("TagResource", { Arn: id, Tags: desired.Tags }, context);
        if (removed.length) await call("UntagResource", { Arn: id, TagKeys: removed }, context);
        const { Tags, ...input } = desired;
        if (Object.keys(input).some(key => JSON.stringify(previous[key]) !== JSON.stringify(input[key]))) { await call("UpdatePipeline", input, context); return progress(id, "update"); }
        return result(pipeline) as any;
      } catch (error) { return failure(error); }
    },
    async delete(id, _previous, context) {
      try { const pipeline = owned(id, context); if (["CREATING", "UPDATING", "STARTING", "STOPPING"].includes(pipeline.status)) return progress(id, "delete"); if (pipeline.status !== "DELETING") await call("DeletePipeline", { PipelineName: pipeline.name }, context); return progress(id, "delete"); }
      catch (error) { return error instanceof AwsError && error.code === "ResourceNotFoundException" ? { status: "SUCCESS", physicalId: id } : failure(error); }
    },
    async retain(id, _previous, context) { const pipeline = owned(id, context), previous = pipeline.owner; delete pipeline.owner; try { await service.store.save(); } catch (error) { pipeline.owner = previous; throw error; } },
    ref(read) { return read.properties.PipelineName; },
    getAtt(read, attribute) { if (Object.hasOwn(read.attributes, attribute)) return read.attributes[attribute]; throw new ProviderReferenceError(TYPE, `Fn::GetAtt ${attribute}`); },
  };
}
