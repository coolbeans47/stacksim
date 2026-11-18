import { AwsError } from "../../errors.js";
import type { OpenSearchServerlessService } from "../../opensearch/serverless.js";
import type { ServerlessCollection, ServerlessGroup } from "../../opensearch/serverless-model.js";
import { parseRetentionPolicy } from "../../opensearch/serverless-retention.js";
import { groupLimits } from "../../opensearch/serverless-capacity.js";
import { parseServerlessPolicy } from "../../opensearch/serverless-policies.js";
import { validateInput } from "../../opensearch/protocol.js";
import { createOpenSearchServerlessIndexProviders } from "./opensearchserverless-index.js";
import { ProviderReferenceError, validateDeclaredProperties, type ProductionResourceProvider, type ProviderContext, type ProviderSchema, type ProviderReadResult } from "./contract.js";

type Model = Record<string, any>;
const owner = (context: ProviderContext) => `${context.stackId}/${context.logicalId}`;
const failure = (error: unknown) => ({ status: "FAILED" as const, errorCode: error instanceof AwsError ? error.code : "InternalFailure", message: error instanceof Error ? error.message : String(error) });
const progress = (physicalId: string) => ({ status: "IN_PROGRESS" as const, callbackAfterMs: 100, checkpoint: { schemaVersion: 1 as const, physicalId, callbackContext: {} } });
const retention = { deletionPolicies: ["Delete", "Retain", "RetainExceptOnCreate"] as const, updateReplacePolicies: ["Delete", "Retain"] as const, snapshotSupported: false };
function plan(previous: Model | undefined, desired: Model, immutable: string[]) {
  const changedProperties = previous ? Object.keys(desired).filter(key => JSON.stringify(previous[key]) !== JSON.stringify(desired[key])) : Object.keys(desired);
  const replacementProperties = previous ? changedProperties.filter(key => immutable.includes(key)) : [];
  return { action: !previous ? "CREATE" as const : replacementProperties.length ? "REPLACE" as const : changedProperties.length ? "UPDATE" as const : "NO_OP" as const, desired, changedProperties, replacementProperties };
}
function systemTags(context: ProviderContext) { return [{ key: "aws:cloudformation:stack-id", value: context.stackId }, { key: "aws:cloudformation:stack-name", value: context.stackId.split(":stack/")[1]?.split("/")[0] ?? context.stackId }, { key: "aws:cloudformation:logical-id", value: context.logicalId }]; }

export function createOpenSearchServerlessProviders(service: OpenSearchServerlessService, region: string): ProductionResourceProvider<Model>[] {
  return [collectionProvider(service, region), policyProvider(service, region, "AccessPolicy"), policyProvider(service, region, "SecurityPolicy"), policyProvider(service, region, "LifecyclePolicy"), groupProvider(service, region), ...createOpenSearchServerlessIndexProviders(service, region)];
}

function collectionProvider(service: OpenSearchServerlessService, region: string): ProductionResourceProvider<Model> {
  const typeName = "AWS::OpenSearchServerless::Collection";
  const schema: ProviderSchema = { typeName, unknownProperties: "REJECT", properties: {
    Name: { valueType: "string", required: true, updateBehavior: "REPLACEMENT" }, Type: { valueType: "string", updateBehavior: "REPLACEMENT" }, StandbyReplicas: { valueType: "string", updateBehavior: "REPLACEMENT" }, CollectionGroupName: { valueType: "string", updateBehavior: "REPLACEMENT" }, DeletionProtection: { valueType: "string", updateBehavior: "MUTABLE" }, EncryptionConfig: { valueType: "object", updateBehavior: "REPLACEMENT" }, Description: { valueType: "string", updateBehavior: "MUTABLE" }, Tags: { valueType: "array", updateBehavior: "MUTABLE" },
  }, ref: { supported: true, valueType: "string" }, attributes: { Id: { valueType: "string" }, Arn: { valueType: "string" }, CollectionEndpoint: { valueType: "string" } }, replacement: { defaultOrder: "CREATE_BEFORE_DELETE" }, retention, tags: { behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true } };
  const input = (model: Model) => ({ name: model.Name, type: model.Type ?? "TIMESERIES", description: model.Description ?? "", ...(model.StandbyReplicas ? { standbyReplicas: model.StandbyReplicas } : {}), deletionProtection: model.DeletionProtection ?? "DISABLED", ...(model.CollectionGroupName ? { collectionGroupName: model.CollectionGroupName } : {}), ...(model.EncryptionConfig ? { encryptionConfig: { aWSOwnedKey: model.EncryptionConfig.AWSOwnedKey, ...(model.EncryptionConfig.KmsKeyArn ? { kmsKeyArn: model.EncryptionConfig.KmsKeyArn } : {}) } } : {}), tags: (model.Tags ?? []).map((tag: any) => ({ key: tag.Key, value: tag.Value })) });
  const properties = (collection: ServerlessCollection): Model => ({ Name: collection.name, Type: collection.type, StandbyReplicas: collection.standbyReplicas, DeletionProtection: collection.deletionProtection, ...(collection.collectionGroupName ? { CollectionGroupName: collection.collectionGroupName } : {}), ...(collection.encryptionConfig ? { EncryptionConfig: { AWSOwnedKey: true } } : {}), Description: collection.description, Tags: Object.entries(collection.tags).filter(([key]) => !key.startsWith("aws:")).map(([Key, Value]) => ({ Key, Value })).sort((a, b) => a.Key.localeCompare(b.Key)) });
  const owned = (id: string, context: ProviderContext) => { const collection = service.collection(region, id, context.accountId); if (collection.owner !== owner(context)) throw new AwsError("OwnershipConflict", "Collection belongs to a different owner", 409); return collection; };
  const result = (collection: ServerlessCollection): ProviderReadResult<Model> => {
    if (collection.status === "FAILED") return { status: "FAILED", errorCode: "NotStabilized", message: collection.failureMessage ?? "Collection failed" };
    if (collection.status !== "ACTIVE") return progress(collection.id);
    return { status: "SUCCESS", physicalId: collection.id, model: { physicalId: collection.id, properties: properties(collection), attributes: { Id: collection.id, Arn: collection.arn, CollectionEndpoint: `https://127.0.0.1:${collection.gatewayPort}` } } };
  };
  return {
    typeName, providerVersion: 1, visibility: "production", schema,
    validate(value) {
      const issues = [...validateDeclaredProperties(value, schema)];
      if (!issues.length) try { const request = input(value as Model); validateInput({ family: "opensearchserverless", operation: "CreateCollection", input: request, status: 200 }); if ((value as Model).EncryptionConfig && Object.keys((value as Model).EncryptionConfig).some(key => !["AWSOwnedKey", "KmsKeyArn"].includes(key))) throw new Error("Unknown EncryptionConfig property"); if (request.encryptionConfig && (request.encryptionConfig.aWSOwnedKey !== true || request.encryptionConfig.kmsKeyArn !== undefined)) throw new Error("Only AWSOwnedKey encryption is implemented"); } catch (error) { issues.push({ code: "InvalidProperty", path: "Properties", pathSegments: ["Properties"], message: (error as Error).message }); }
      return issues;
    },
    canonicalize(value) { const model = value as Model; return { Name: model.Name, Type: model.Type ?? "TIMESERIES", ...(model.StandbyReplicas ? { StandbyReplicas: model.StandbyReplicas } : model.CollectionGroupName ? {} : { StandbyReplicas: "ENABLED" }), DeletionProtection: model.DeletionProtection ?? "DISABLED", ...(model.CollectionGroupName ? { CollectionGroupName: model.CollectionGroupName } : {}), ...(model.EncryptionConfig ? { EncryptionConfig: model.EncryptionConfig } : {}), Description: model.Description ?? "", Tags: [...(model.Tags ?? [])].sort((a, b) => a.Key.localeCompare(b.Key)) }; },
    plan(previous, desired) { return plan(previous, desired, ["Name", "Type", "StandbyReplicas", "CollectionGroupName", "EncryptionConfig"]); },
    async create(desired, context) {
      try {
        const existing = Object.values(service.state(region, context.accountId).collections).find(collection => collection.name === desired.Name);
        if (existing) return result(owned(existing.id, context)) as any;
        const request = input(desired); request.tags.push(...systemTags(context));
        const created = await service.execute("CreateCollection", { ...request, clientToken: context.idempotencyKey }, region, context.accountId, context.principal.identity, owner(context));
        return progress(created.createCollectionDetail.id);
      } catch (error) { return failure(error); }
    },
    async read(id, context) { try { const value = owned(id, context); service.authorizeOperation("BatchGetCollection", { ids: [id] }, region, context.principal.identity, true); service.authorizeOperation("ListTagsForResource", { resourceArn: value.arn }, region, context.principal.identity, true); return result(value); } catch (error) { if (error instanceof AwsError && error.code === "ResourceNotFoundException") return { status: "NOT_FOUND", physicalId: id }; return failure(error); } },
    async update(id, previous, desired, context) {
      try {
        const collection = owned(id, context); if (["Name", "Type", "StandbyReplicas", "CollectionGroupName", "EncryptionConfig"].some(key => JSON.stringify(previous[key]) !== JSON.stringify(desired[key]))) throw new AwsError("RequiresReplacement", "Collection identity/type/standby changes require replacement");
        if (collection.status !== "ACTIVE") return result(collection) as any;
        await service.execute("UpdateCollection", { id, description: desired.Description, deletionProtection: desired.DeletionProtection }, region, context.accountId, context.principal.identity);
        const tags = input(desired).tags;
        const removed = Object.keys(collection.tags).filter(key => !key.startsWith("aws:") && !tags.some((tag: any) => tag.key === key));
        if (tags.length) await service.execute("TagResource", { resourceArn: collection.arn, tags }, region, context.accountId, context.principal.identity, owner(context));
        if (removed.length) await service.execute("UntagResource", { resourceArn: collection.arn, tagKeys: removed }, region, context.accountId, context.principal.identity, owner(context));
        return result(owned(id, context)) as any;
      } catch (error) { return failure(error); }
    },
    async delete(id, _previous, context) {
      try { const collection = owned(id, context); if (collection.status === "CREATING") return progress(id); if (collection.status !== "DELETING") await service.execute("DeleteCollection", { id }, region, context.accountId, context.principal.identity); return progress(id); }
      catch (error) { if (error instanceof AwsError && error.code === "ResourceNotFoundException") return { status: "SUCCESS", physicalId: id }; return failure(error); }
    },
    async retain(id, _previous, context) { const collection = owned(id, context), previous = collection.owner; delete collection.owner; try { await service.store.save(); } catch (error) { collection.owner = previous; throw error; } },
    ref(read) { return read.physicalId; },
    getAtt(read, attribute) { if (Object.hasOwn(read.attributes, attribute)) return read.attributes[attribute]; throw new ProviderReferenceError(typeName, `Fn::GetAtt ${attribute}`); },
  };
}

function policyProvider(service: OpenSearchServerlessService, region: string, kind: "AccessPolicy" | "SecurityPolicy" | "LifecyclePolicy"): ProductionResourceProvider<Model> {
  const typeName = `AWS::OpenSearchServerless::${kind}`;
  const schema: ProviderSchema = { typeName, unknownProperties: "REJECT", properties: {
    Name: { valueType: "string", required: true, updateBehavior: "REPLACEMENT" }, Type: { valueType: "string", required: true, updateBehavior: "REPLACEMENT" }, Policy: { valueType: "string", required: true, updateBehavior: "MUTABLE" }, Description: { valueType: "string", updateBehavior: "MUTABLE" },
  }, ref: { supported: true, valueType: "string" }, attributes: {}, replacement: { defaultOrder: "CREATE_BEFORE_DELETE" }, retention, tags: { behavior: "NONE", propagatesCloudFormationTags: false } };
  const input = (model: Model) => ({ name: model.Name, type: model.Type, policy: model.Policy, description: model.Description ?? "" });
  const owned = (id: string, context: ProviderContext) => {
    const state = service.state(region, context.accountId), policy = Object.values(state.policies).find(policy => `${policy.type}/${policy.name}` === id && (kind === "AccessPolicy" ? policy.type === "data" : kind === "LifecyclePolicy" ? policy.type === "retention" : ["network", "encryption"].includes(policy.type)) && state.policyOwners?.[`${policy.type}:${policy.name}`] === owner(context));
    if (!policy) { if (Object.values(state.policies).some(policy => `${policy.type}/${policy.name}` === id && (kind === "AccessPolicy" ? policy.type === "data" : kind === "LifecyclePolicy" ? policy.type === "retention" : ["network", "encryption"].includes(policy.type)))) throw new AwsError("OwnershipConflict", "Policy belongs to another owner", 409); throw new AwsError("ResourceNotFoundException", "Policy not found", 400); }
    return policy;
  };
  const result = (policy: ReturnType<typeof owned>) => ({ status: "SUCCESS" as const, physicalId: `${policy.type}/${policy.name}`, model: { physicalId: `${policy.type}/${policy.name}`, properties: { Name: policy.name, Type: policy.type, Policy: JSON.stringify(policy.policy), Description: policy.description ?? "" }, attributes: {} } });
  return {
    typeName, providerVersion: 1, visibility: "production", schema,
    validate(value) { const issues = [...validateDeclaredProperties(value, schema)]; if (!issues.length) try { const request = input(value as Model); validateInput({ family: "opensearchserverless", operation: `Create${kind}`, input: request, status: 200 }); if (kind === "LifecyclePolicy") parseRetentionPolicy(request.policy); else parseServerlessPolicy(request.type, request.policy); } catch (error) { issues.push({ code: "InvalidProperty", path: "Properties", pathSegments: ["Properties"], message: (error as Error).message }); } return issues; },
    canonicalize(value) { const model = value as Model; return { Name: model.Name, Type: model.Type, Policy: JSON.stringify(JSON.parse(model.Policy)), Description: model.Description ?? "" }; },
    plan(previous, desired) { return plan(previous, desired, ["Name", "Type"]); },
    async create(desired, context) { try { const state = service.state(region, context.accountId); if (state.policies[`${desired.Type}:${desired.Name}`]) return result(owned(`${desired.Type}/${desired.Name}`, context)); await service.execute(`Create${kind}`, { ...input(desired), clientToken: context.idempotencyKey }, region, context.accountId, context.principal.identity, owner(context)); return result(owned(`${desired.Type}/${desired.Name}`, context)); } catch (error) { return failure(error); } },
    async read(id, context) { try { const policy = owned(id, context); service.authorizeOperation(kind === "LifecyclePolicy" ? "BatchGetLifecyclePolicy" : `Get${kind}`, kind === "LifecyclePolicy" ? { identifiers: [{ type: policy.type, name: policy.name }] } : { type: policy.type, name: policy.name }, region, context.principal.identity, true); return result(policy); } catch (error) { if (error instanceof AwsError && error.code === "ResourceNotFoundException") return { status: "NOT_FOUND", physicalId: id }; return failure(error); } },
    async update(id, _previous, desired, context) { try { const policy = owned(id, context); if (desired.Name !== policy.name || desired.Type !== policy.type) throw new AwsError("RequiresReplacement", "Policy name/type changes require replacement"); await service.execute(`Update${kind}`, { ...input(desired), policyVersion: policy.policyVersion }, region, context.accountId, context.principal.identity); return result(owned(id, context)); } catch (error) { return failure(error); } },
    async delete(id, _previous, context) { try { const policy = owned(id, context); await service.execute(`Delete${kind}`, { name: policy.name, type: policy.type }, region, context.accountId, context.principal.identity); return { status: "SUCCESS", physicalId: id }; } catch (error) { if (error instanceof AwsError && error.code === "ResourceNotFoundException") return { status: "SUCCESS", physicalId: id }; return failure(error); } },
    async retain(id, _previous, context) { const policy = owned(id, context), owners = service.state(region, context.accountId).policyOwners!, key = `${policy.type}:${policy.name}`, previous = owners[key]; delete owners[key]; try { await service.store.save(); } catch (error) { owners[key] = previous; throw error; } },
    ref(read) { return read.properties.Name; },
    getAtt(_read, attribute) { throw new ProviderReferenceError(typeName, `Fn::GetAtt ${attribute}`); },
  };
}

function groupProvider(service: OpenSearchServerlessService, region: string): ProductionResourceProvider<Model> {
  const typeName = "AWS::OpenSearchServerless::CollectionGroup", immutable = ["Name", "Generation", "StandbyReplicas"];
  const schema: ProviderSchema = { typeName, unknownProperties: "REJECT", properties: {
    Name: { valueType: "string", required: true, updateBehavior: "REPLACEMENT" }, Generation: { valueType: "string", updateBehavior: "REPLACEMENT" }, StandbyReplicas: { valueType: "string", required: true, updateBehavior: "REPLACEMENT" }, Description: { valueType: "string", updateBehavior: "MUTABLE" }, CapacityLimits: { valueType: "object", updateBehavior: "MUTABLE" }, Tags: { valueType: "array", updateBehavior: "MUTABLE" },
  }, ref: { supported: true, valueType: "string" }, attributes: { Id: { valueType: "string" }, Arn: { valueType: "string" } }, replacement: { defaultOrder: "CREATE_BEFORE_DELETE" }, retention, tags: { behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true } };
  const lower = (limits: Model) => Object.fromEntries(Object.entries(limits).map(([key, value]) => [key[0].toLowerCase() + key.slice(1), value]));
  const upper = (limits: object) => Object.fromEntries(Object.entries(limits).map(([key, value]) => [key[0].toUpperCase() + key.slice(1), value]));
  const input = (model: Model) => ({ name: model.Name, generation: model.Generation ?? "CLASSIC", standbyReplicas: model.StandbyReplicas, description: model.Description ?? "", capacityLimits: lower(model.CapacityLimits ?? {}), tags: (model.Tags ?? []).map((tag: any) => ({ key: tag.Key, value: tag.Value })) });
  const owned = (id: string, context: ProviderContext) => {
    const groups = service.state(region, context.accountId).groups ?? {}, group = Object.hasOwn(groups, id) ? groups[id] : undefined;
    if (!group) throw new AwsError("ResourceNotFoundException", "Collection group not found", 400);
    if (group.owner !== owner(context)) throw new AwsError("OwnershipConflict", "Collection group belongs to another owner", 409);
    return group;
  };
  const result = (group: ServerlessGroup) => ({ status: "SUCCESS" as const, physicalId: group.id, model: { physicalId: group.id, properties: { Name: group.name, Generation: group.generation, StandbyReplicas: group.standbyReplicas, Description: group.description, CapacityLimits: upper(group.capacityLimits), Tags: Object.entries(group.tags).filter(([key]) => !key.startsWith("aws:")).map(([Key, Value]) => ({ Key, Value })).sort((a, b) => a.Key.localeCompare(b.Key)) }, attributes: { Id: group.id, Arn: group.arn } } });
  return {
    typeName, providerVersion: 1, visibility: "production", schema,
    validate(value) {
      const issues = [...validateDeclaredProperties(value, schema)];
      if (!issues.length) try { const request = input(value as Model); validateInput({ family: "opensearchserverless", operation: "CreateCollectionGroup", input: request, status: 200 }); groupLimits(request.generation, request.capacityLimits); }
      catch (error) { issues.push({ code: "InvalidProperty", path: "Properties", pathSegments: ["Properties"], message: (error as Error).message }); }
      return issues;
    },
    canonicalize(value) { const model = value as Model; return { Name: model.Name, Generation: model.Generation ?? "CLASSIC", StandbyReplicas: model.StandbyReplicas, Description: model.Description ?? "", CapacityLimits: upper(groupLimits(model.Generation ?? "CLASSIC", lower(model.CapacityLimits ?? {}))), Tags: [...(model.Tags ?? [])].sort((a, b) => a.Key.localeCompare(b.Key)) }; },
    plan(previous, desired) { return plan(previous, desired, immutable); },
    async create(desired, context) {
      try {
        const existing = Object.values(service.state(region, context.accountId).groups ?? {}).find(group => group.name === desired.Name);
        if (existing) return result(owned(existing.id, context));
        const request = input(desired); request.tags.push(...systemTags(context));
        const response = await service.execute("CreateCollectionGroup", { ...request, clientToken: context.idempotencyKey }, region, context.accountId, context.principal.identity, owner(context));
        return result(owned(response.createCollectionGroupDetail.id, context));
      } catch (error) { return failure(error); }
    },
    async read(id, context) {
      try { const group = owned(id, context); service.authorizeOperation("BatchGetCollectionGroup", { ids: [id] }, region, context.principal.identity, true); service.authorizeOperation("ListTagsForResource", { resourceArn: group.arn }, region, context.principal.identity, true); return result(group); }
      catch (error) { if (error instanceof AwsError && error.code === "ResourceNotFoundException") return { status: "NOT_FOUND", physicalId: id }; return failure(error); }
    },
    async update(id, previous, desired, context) {
      try {
        const group = owned(id, context);
        if (immutable.some(key => previous[key] !== desired[key])) throw new AwsError("RequiresReplacement", "Group name/generation/standby changes require replacement");
        const request = input(desired);
        await service.execute("UpdateCollectionGroup", { id, description: request.description, capacityLimits: request.capacityLimits }, region, context.accountId, context.principal.identity);
        const removed = Object.keys(group.tags).filter(key => !key.startsWith("aws:") && !request.tags.some((tag: any) => tag.key === key));
        if (request.tags.length) await service.execute("TagResource", { resourceArn: group.arn, tags: request.tags }, region, context.accountId, context.principal.identity, owner(context));
        if (removed.length) await service.execute("UntagResource", { resourceArn: group.arn, tagKeys: removed }, region, context.accountId, context.principal.identity, owner(context));
        return result(owned(id, context));
      } catch (error) { return failure(error); }
    },
    async delete(id, _previous, context) { try { owned(id, context); await service.execute("DeleteCollectionGroup", { id }, region, context.accountId, context.principal.identity); return { status: "SUCCESS", physicalId: id }; } catch (error) { if (error instanceof AwsError && error.code === "ResourceNotFoundException") return { status: "SUCCESS", physicalId: id }; return failure(error); } },
    async retain(id, _previous, context) { const group = owned(id, context), previous = group.owner; delete group.owner; try { await service.store.save(); } catch (error) { group.owner = previous; throw error; } },
    ref(read) { return read.physicalId; },
    getAtt(read, attribute) { if (Object.hasOwn(read.attributes, attribute)) return read.attributes[attribute]; throw new ProviderReferenceError(typeName, `Fn::GetAtt ${attribute}`); },
  };
}
