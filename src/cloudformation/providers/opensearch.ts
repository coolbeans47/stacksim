import { createHash } from "node:crypto";
import { AwsError } from "../../errors.js";
import type { OpenSearchService } from "../../opensearch.js";
import { domainConfiguration, tags, ENGINE_VERSION } from "../../opensearch/validation.js";
import { domainArn, type DomainRecord } from "../../opensearch/model.js";
import { ProviderReferenceError, validateDeclaredProperties, type ProductionResourceProvider, type ProviderContext, type ProviderSchema, type ProviderValidationIssue, type ProviderReadResult, type ProviderDeleteResult } from "./contract.js";

const TYPE = "AWS::OpenSearchService::Domain";
const fields = ["EngineVersion", "ClusterConfig", "EBSOptions", "AccessPolicies", "AdvancedOptions", "DomainEndpointOptions", "AdvancedSecurityOptions", "EncryptionAtRestOptions", "NodeToNodeEncryptionOptions", "AutoTuneOptions", "LogPublishingOptions", "CognitoOptions", "IPAddressType"];
const schema: ProviderSchema = {
  typeName: TYPE, unknownProperties: "REJECT",
  properties: { DomainName: { valueType: "string", updateBehavior: "REPLACEMENT" }, Tags: { valueType: "array", updateBehavior: "MUTABLE" }, ...Object.fromEntries(fields.map(field => [field, { valueType: ["EngineVersion", "IPAddressType"].includes(field) ? "string" as const : "object" as const, updateBehavior: "MUTABLE" as const, ...(field === "AdvancedSecurityOptions" ? { sensitive: true } : {}) }])) },
  ref: { supported: true, valueType: "string" }, attributes: { Arn: { valueType: "string" }, DomainArn: { valueType: "string" }, DomainEndpoint: { valueType: "string" } },
  replacement: { defaultOrder: "CREATE_BEFORE_DELETE" },
  retention: { deletionPolicies: ["Delete", "Retain", "RetainExceptOnCreate"], updateReplacePolicies: ["Delete", "Retain", "RetainExceptOnCreate"], snapshotSupported: false },
  tags: { behavior: "STACK_AND_RESOURCE", propertyName: "Tags", propagatesCloudFormationTags: true },
};
type Model = Record<string, any>;
const owner = (context: ProviderContext) => `${context.stackId}/${context.logicalId}`;
function name(context: ProviderContext): string { return `os-${createHash("sha256").update(`${context.stackId}/${context.logicalId}`).digest("hex").slice(0, 24)}`; }
function apiInput(properties: Model, context: ProviderContext): Model {
  const { Tags, AccessPolicies, ...rest } = properties;
  if (Tags !== undefined && !Array.isArray(Tags)) throw new AwsError("ValidationException", "Tags must be an array");
  const systemTags = [{ Key: "aws:cloudformation:stack-id", Value: context.stackId }, { Key: "aws:cloudformation:stack-name", Value: context.stackId.split(":stack/")[1]?.split("/")[0] ?? context.stackId }, { Key: "aws:cloudformation:logical-id", Value: context.logicalId }];
  return { ...rest, DomainName: properties.DomainName ?? name(context), ...(AccessPolicies === undefined ? {} : { AccessPolicies: JSON.stringify(AccessPolicies) }), TagList: [...(Tags ?? []), ...systemTags] };
}
function model(domain: DomainRecord): Model {
  const config = structuredClone(domain.config); if (config.AccessPolicies) config.AccessPolicies = JSON.parse(config.AccessPolicies); else delete config.AccessPolicies;
  return { DomainName: domain.name, ...config, Tags: Object.entries(domain.tags).filter(([key]) => !key.toLowerCase().startsWith("aws:")).map(([Key, Value]) => ({ Key, Value })).sort((a, b) => a.Key.localeCompare(b.Key)) };
}
function failure(error: unknown) { return { status: "FAILED" as const, errorCode: error instanceof AwsError ? error.code : "InternalFailure", message: error instanceof Error ? error.message : String(error) }; }
const progress = (physicalId: string, operation: string) => ({ status: "IN_PROGRESS" as const, callbackAfterMs: 100, checkpoint: { schemaVersion: 1 as const, physicalId, callbackContext: { operation } } });
function result(domain: DomainRecord): ProviderReadResult<Model> {
  if (domain.state === "failed") return { status: "FAILED", physicalId: domain.name, errorCode: "NotStabilized", message: domain.failure ?? "Domain failed to start" };
  if (domain.state !== "active" || domain.changes?.some(change => change.state === "PENDING" || change.state === "PROCESSING")) return progress(domain.name, "read");
  return { status: "SUCCESS", physicalId: domain.name, model: { physicalId: domain.name, properties: model(domain), attributes: { Arn: domain.arn, DomainArn: domain.arn, DomainEndpoint: `127.0.0.1:${domain.gatewayPort}` } } };
}

export function createOpenSearchDomainProvider(service: OpenSearchService, region: string): ProductionResourceProvider<Model> {
  const owned = (physicalId: string, context: ProviderContext) => { const domain = service.domain(region, physicalId); if (domain.owner !== owner(context)) throw new AwsError("OwnershipConflict", "The domain belongs to a different owner", 409); return domain; };
  return {
    typeName: TYPE, providerVersion: 1, visibility: "production", schema,
    validate(properties, context) {
      const issues: ProviderValidationIssue[] = [...validateDeclaredProperties(properties, schema)];
      if (!issues.length) try { const input = apiInput(properties as Model, context); domainConfiguration(input); tags(input.TagList, {}, true); } catch (error) { issues.push({ code: "InvalidProperty", path: "Properties", pathSegments: ["Properties"], message: (error as Error).message }); }
      return issues;
    },
    canonicalize(properties, context) {
      const input = apiInput(properties as Model, context); const config = domainConfiguration(input);
      // Keep write-only inputs in the transient desired model. The domain
      // service protects their verifier; CloudFormation persists the original
      // template reference, never a resolved secure dynamic-reference value.
      if (input.AdvancedSecurityOptions?.MasterUserOptions) config.AdvancedSecurityOptions.MasterUserOptions = structuredClone(input.AdvancedSecurityOptions.MasterUserOptions);
      if (config.AccessPolicies) config.AccessPolicies = JSON.parse(config.AccessPolicies); else delete config.AccessPolicies;
      return { DomainName: input.DomainName, ...config, Tags: Object.entries(tags(input.TagList, {}, true)).filter(([key]) => !key.toLowerCase().startsWith("aws:")).map(([Key, Value]) => ({ Key, Value })).sort((a, b) => a.Key.localeCompare(b.Key)) };
    },
    plan(previous, desired) {
      const changedProperties = previous ? Object.keys(desired).filter(key => JSON.stringify(previous[key]) !== JSON.stringify(desired[key])) : Object.keys(desired);
      const replacementProperties = previous && previous.DomainName !== desired.DomainName ? ["DomainName"] : [];
      return { action: !previous ? "CREATE" : replacementProperties.length ? "REPLACE" : changedProperties.length ? "UPDATE" : "NO_OP", desired, changedProperties, replacementProperties };
    },
    async create(desired, context) {
      try {
        const existing = service.domains(region).find(domain => domain.name === desired.DomainName);
        if (existing) { owned(existing.name, context); return result(existing) as any; }
        await service.execute("CreateDomain", apiInput(desired, context), region, owner(context));
        return progress(desired.DomainName, "create");
      } catch (error) { return failure(error); }
    },
    async read(physicalId, context) {
      try { return result(owned(physicalId, context)); } catch (error) { if (error instanceof AwsError && error.code === "ResourceNotFoundException") return { status: "NOT_FOUND", physicalId }; return failure(error); }
    },
    async update(physicalId, previous, desired, context) {
      try {
        const domain = owned(physicalId, context); if (desired.DomainName !== physicalId) throw new AwsError("RequiresReplacement", "Domain name changes require replacement");
        if (context.callbackContext?.changeId) {
          const change = domain.changes?.find(change => change.id === context.callbackContext!.changeId);
          if (!change || change.state === "FAILED" || change.state === "CANCELLED") throw new AwsError("NotStabilized", change?.failure ?? "The configuration change did not complete");
          if (change.state !== "COMPLETED") return { ...progress(physicalId, "update"), checkpoint: { schemaVersion: 1 as const, physicalId, callbackContext: { operation: "update", changeId: change.id } } };
          return result(domain) as any;
        }
        const input = apiInput(desired, context); const nextTags = input.TagList; delete input.TagList;
        for (const key of Object.keys(input)) if (key !== "DomainName" && JSON.stringify(previous[key]) === JSON.stringify(desired[key])) delete input[key];
        const updated = await service.execute("UpdateDomainConfig", input, region);
        const removed = (previous.Tags ?? []).filter((tag: any) => !nextTags.some((next: any) => next.Key === tag.Key)).map((tag: any) => tag.Key);
        if (nextTags.length) await service.execute("AddTags", { ARN: domainArn(region, context.accountId, physicalId), TagList: nextTags }, region, owner(context));
        if (removed.length) await service.execute("RemoveTags", { ARN: domainArn(region, context.accountId, physicalId), TagKeys: removed }, region, owner(context));
        const changeId = updated.DomainConfig?.ChangeProgressDetails?.ChangeId;
        if (changeId) return { ...progress(physicalId, "update"), checkpoint: { schemaVersion: 1 as const, physicalId, callbackContext: { operation: "update", changeId } } };
        return result(owned(physicalId, context)) as any;
      } catch (error) { return failure(error); }
    },
    async delete(physicalId, _previous, context): Promise<ProviderDeleteResult> {
      try { const domain = owned(physicalId, context); if (domain.state === "creating") return progress(physicalId, "delete"); if (domain.state !== "deleting") await service.execute("DeleteDomain", { DomainName: physicalId }, region); return progress(physicalId, "delete"); }
      catch (error) { if (error instanceof AwsError && error.code === "ResourceNotFoundException") return { status: "SUCCESS", physicalId }; return failure(error); }
    },
    async retain(physicalId, _previous, context) { const domain = owned(physicalId, context); const previous = domain.owner; delete domain.owner; try { await service.store.save(); } catch (error) { domain.owner = previous; throw error; } },
    ref(read) { return read.physicalId; },
    getAtt(read, attribute) { if (Object.hasOwn(read.attributes, attribute)) return read.attributes[attribute]; throw new ProviderReferenceError(TYPE, `Fn::GetAtt ${attribute}`); },
  };
}

/** Legacy resource names translate at the contract boundary; lifecycle and ownership are shared. */
export function createElasticsearchDomainProvider(service: OpenSearchService, region: string): ProductionResourceProvider<Model> {
  const base = createOpenSearchDomainProvider(service, region);
  const typeName = "AWS::Elasticsearch::Domain";
  const modern = (properties: Model): Model => {
    const { ElasticsearchVersion, ElasticsearchClusterConfig, ...rest } = properties;
    return { ...rest, ...(ElasticsearchVersion === undefined ? {} : { EngineVersion: ElasticsearchVersion }), ...(ElasticsearchClusterConfig === undefined ? {} : { ClusterConfig: ElasticsearchClusterConfig }) };
  };
  const legacyKey = (key: string) => key === "EngineVersion" ? "ElasticsearchVersion" : key === "ClusterConfig" ? "ElasticsearchClusterConfig" : key;
  const legacy = (properties: Model): Model => Object.fromEntries(Object.entries(properties).filter(([key]) => key !== "IPAddressType").map(([key, value]) => [legacyKey(key), value]));
  const schema: ProviderSchema = { ...base.schema, typeName, properties: legacy(base.schema.properties as Model) };
  const mapped = <T extends { status: string; model?: any }>(result: T): T => result.model ? { ...result, model: { ...result.model, properties: legacy(result.model.properties) } } : result;
  return {
    ...base, typeName, schema,
    validate(properties, context) {
      const issues = validateDeclaredProperties(properties, schema);
      if (issues.length) return issues;
      if ((properties as Model).ElasticsearchVersion !== ENGINE_VERSION) return [{ code: "InvalidProperty", path: "Properties.ElasticsearchVersion", pathSegments: ["Properties", "ElasticsearchVersion"], message: `Legacy domains require explicit ElasticsearchVersion ${ENGINE_VERSION}; Elasticsearch engines are unavailable` }];
      return base.validate(modern(properties as Model), context);
    },
    canonicalize(properties, context) { return legacy(base.canonicalize(modern(properties as Model), context)); },
    plan(previous, desired, context) { const plan = base.plan(previous && modern(previous), modern(desired), context); return { ...plan, desired, changedProperties: plan.changedProperties.map(legacyKey), replacementProperties: plan.replacementProperties.map(legacyKey) }; },
    async create(desired, context) { return mapped(await base.create(modern(desired), context)); },
    async read(physicalId, context) { return mapped(await base.read(physicalId, context)); },
    async update(physicalId, previous, desired, context) { return mapped(await base.update(physicalId, modern(previous), modern(desired), context)); },
    async delete(physicalId, previous, context) { return base.delete(physicalId, modern(previous), context); },
    async retain(physicalId, previous, context) { await base.retain?.(physicalId, modern(previous), context); },
  };
}
