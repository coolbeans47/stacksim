import { AwsError } from "../../errors.js";
import type { OpenSearchServerlessService } from "../../opensearch/serverless.js";
import { indexSettings, validateMappings } from "../../opensearch/mappings.js";
import { keys, record, SearchError } from "../../opensearch/query.js";
import { ProviderReferenceError, validateDeclaredProperties, type ProductionResourceProvider, type ProviderContext, type ProviderSchema } from "./contract.js";

type Model = Record<string, any>;
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stringify = (value: any) => JSON.stringify(canonical(value));
const owner = (context: ProviderContext) => `${context.stackId}/${context.logicalId}`;
const failure = (error: unknown) => ({ status: "FAILED" as const, errorCode: error instanceof AwsError ? error.code : error instanceof SearchError ? error.type === "ownership_conflict" ? "OwnershipConflict" : "InvalidRequest" : "InternalFailure", message: error instanceof Error ? error.message : String(error) });
const missing = (error: unknown) => error instanceof SearchError && error.type === "index_not_found_exception" || error instanceof AwsError && error.code === "ResourceNotFoundException";
const progress = (physicalId: string) => ({ status: "IN_PROGRESS" as const, callbackAfterMs: 100, checkpoint: { schemaVersion: 1 as const, physicalId, callbackContext: {} } });

function mapping(properties: Model, reverse = false): Model {
  const names: Record<string, string> = { Type: "type", Analyzer: "analyzer", DataType: "data_type", Dimension: "dimension", Index: "index", SpaceType: "space_type", Properties: "properties" };
  const translation = reverse ? Object.fromEntries(Object.entries(names).map(([a, b]) => [b, a])) : names;
  return Object.fromEntries(Object.entries(record(properties, "Mapping properties")).map(([field, definition]) => {
    record(definition, "Property mapping"); if (!reverse) keys(definition, Object.keys(translation), "Property mapping");
    if (!reverse && (!/^[A-Za-z0-9_.-]{1,64}$/.test(field) || !["text", "knn_vector", "keyword", "integer"].includes(definition.Type))) throw new AwsError("ValidationException", "Index mapping fields require a registry-supported name and Type");
    return [field, Object.fromEntries(Object.entries(definition).filter(([key]) => Object.hasOwn(translation, key)).map(([key, value]) => [translation[key], key === (reverse ? "properties" : "Properties") ? mapping(value as Model, reverse) : value]))];
  }));
}
function endpointSchema(model: Model): Model {
  const mappings = record(model.Mappings ?? {}, "Mappings"), settings = record(model.Settings ?? {}, "Settings");
  keys(mappings, ["Properties"], "Mappings"); keys(settings, ["Index"], "Settings");
  const index = record(settings.Index ?? {}, "Settings.Index"); keys(index, ["Knn"], "Settings.Index");
  const result = { mappings: { properties: mapping(mappings.Properties ?? {}) }, settings: { index: { knn: index.Knn ?? false } } };
  validateMappings(result.mappings); indexSettings(result.settings); return result;
}
function managementSchema(value: unknown): Model {
  const schema = typeof value === "string" ? JSON.parse(value) : value ?? {};
  keys(record(schema, "IndexSchema"), ["mappings", "settings", "aliases"], "IndexSchema");
  const settings = indexSettings(schema.settings); delete settings.refresh_interval;
  validateMappings(schema.mappings ?? {});
  if (Object.keys(schema.aliases ?? {}).length) throw new AwsError("ValidationException", "Collection index aliases are not implemented");
  return { mappings: schema.mappings ?? {}, settings: { index: settings } };
}

/** The frozen registry identifies CollectionIndex by Id|IndexName, in that order. */
export function createOpenSearchServerlessIndexProviders(service: OpenSearchServerlessService, region: string): ProductionResourceProvider<Model>[] {
  return [true, false].map(endpointBased => {
    const typeName = `AWS::OpenSearchServerless::${endpointBased ? "Index" : "CollectionIndex"}`;
    const identity = endpointBased ? "CollectionEndpoint" : "Id";
    const schema: ProviderSchema = { typeName, unknownProperties: "REJECT", properties: {
      [identity]: { valueType: "string", required: true, updateBehavior: "REPLACEMENT" }, IndexName: { valueType: "string", required: true, updateBehavior: "REPLACEMENT" },
      ...(endpointBased ? { Mappings: { valueType: "object" as const, updateBehavior: "MUTABLE" as const }, Settings: { valueType: "object" as const, updateBehavior: "MUTABLE" as const } } : { IndexSchema: { valueType: "string" as const, updateBehavior: "MUTABLE" as const } }),
    }, ref: { supported: true, valueType: "string" }, attributes: endpointBased ? { Uuid: { valueType: "string" } } : {}, replacement: { defaultOrder: "CREATE_BEFORE_DELETE" }, retention: { deletionPolicies: ["Delete", "Retain", "RetainExceptOnCreate"], updateReplacePolicies: ["Delete", "Retain"], snapshotSupported: false }, tags: { behavior: "NONE", propagatesCloudFormationTags: false } };
    const collection = (model: Model, context: ProviderContext) => endpointBased ? service.collectionForEndpoint(region, context.accountId, model.CollectionEndpoint) : service.collection(region, model.Id, context.accountId);
    const id = (model: Model) => endpointBased ? `${model.IndexName}|${model.CollectionEndpoint}` : `${model.Id}|${model.IndexName}`;
    const fromId = (physicalId: string): Model => { const parts = physicalId.split("|"); if (parts.length !== 2) throw new AwsError("ValidationException", "Invalid index resource identifier"); return endpointBased ? { IndexName: parts[0], CollectionEndpoint: parts[1] } : { Id: parts[0], IndexName: parts[1] }; };
    const body = (model: Model) => endpointBased ? endpointSchema(model) : managementSchema(model.IndexSchema);
    const read = async (physicalId: string, context: ProviderContext) => {
      const model = fromId(physicalId), resource = collection(model, context);
      if (resource.status === "CREATING") return progress(physicalId);
      const result = await service.ownedIndex("read", resource, model.IndexName, owner(context), context.principal.identity, undefined, endpointBased);
      const properties = endpointBased ? { ...model, Mappings: { Properties: mapping(result.schema.mappings.properties ?? {}, true) }, Settings: { Index: { Knn: result.schema.settings.index.knn === "true" } } } : { ...model, IndexSchema: stringify(managementSchema(result.schema)) };
      return { status: "SUCCESS" as const, physicalId, model: { physicalId, properties, attributes: endpointBased ? { Uuid: result.uuid } : {} } };
    };
    return {
      typeName, providerVersion: 1, visibility: "production", schema,
      validate(value) {
        const issues = [...validateDeclaredProperties(value, schema)];
        if (!issues.length) try { const model = value as Model; if (!/^(?![_-])[a-z][a-z0-9_-]{0,254}$/.test(model.IndexName)) throw new Error("Invalid IndexName"); if (!endpointBased && !/^[a-z0-9]{3,40}$/.test(model.Id)) throw new Error("Invalid collection Id"); if (endpointBased && !/^https:\/\/127\.0\.0\.1:\d+$/.test(model.CollectionEndpoint)) throw new Error("CollectionEndpoint must be a discovered local collection HTTPS endpoint"); if (!endpointBased && model.IndexSchema && (model.IndexSchema.length > 2480 || !/^[\u0009\u000A\u000D\u0020-\u007E\u00A1-\u00FF]+$/.test(model.IndexSchema))) throw new Error("IndexSchema exceeds the registry string constraints"); body(model); } catch (error) { issues.push({ code: "InvalidProperty", path: "Properties", pathSegments: ["Properties"], message: (error as Error).message }); }
        return issues;
      },
      canonicalize(value) { const model = value as Model; const schema = body(model); return endpointBased ? { CollectionEndpoint: model.CollectionEndpoint, IndexName: model.IndexName, Mappings: { Properties: mapping(schema.mappings.properties, true) }, Settings: { Index: { Knn: schema.settings.index.knn } } } : { Id: model.Id, IndexName: model.IndexName, IndexSchema: stringify(schema) }; },
      plan(previous, desired) { const changedProperties = previous ? Object.keys(desired).filter(key => stringify(previous[key]) !== stringify(desired[key])) : Object.keys(desired); const replacementProperties = previous ? changedProperties.filter(key => [identity, "IndexName"].includes(key)) : []; return { action: !previous ? "CREATE" : replacementProperties.length ? "REPLACE" : changedProperties.length ? "UPDATE" : "NO_OP", desired, changedProperties, replacementProperties }; },
      async create(desired, context) { try { const target = collection(desired, context), physicalId = id(desired); if (target.status === "CREATING") return progress(physicalId); await service.ownedIndex("create", target, desired.IndexName, owner(context), context.principal.identity, body(desired), endpointBased); return await read(physicalId, context); } catch (error) { return failure(error); } },
      async read(physicalId, context) { try { return await read(physicalId, context); } catch (error) { if (missing(error)) return { status: "NOT_FOUND", physicalId }; return failure(error); } },
      async update(physicalId, _previous, desired, context) { try { if (physicalId !== id(desired)) throw new AwsError("RequiresReplacement", "Index identity changes require replacement"); const target = collection(desired, context); await service.ownedIndex("update", target, desired.IndexName, owner(context), context.principal.identity, body(desired), endpointBased); return await read(physicalId, context); } catch (error) { return failure(error); } },
      async delete(physicalId, _previous, context) { try { const model = fromId(physicalId); await service.ownedIndex("delete", collection(model, context), model.IndexName, owner(context), context.principal.identity, undefined, endpointBased); return { status: "SUCCESS", physicalId }; } catch (error) { if (missing(error)) return { status: "SUCCESS", physicalId }; return failure(error); } },
      async retain(physicalId, _previous, context) { const model = fromId(physicalId); await service.ownedIndex("retain", collection(model, context), model.IndexName, owner(context), context.principal.identity, undefined, endpointBased); },
      ref(read) { return read.physicalId; },
      getAtt(read, attribute) { if (Object.hasOwn(read.attributes, attribute)) return read.attributes[attribute]; throw new ProviderReferenceError(typeName, `Fn::GetAtt ${attribute}`); },
    } satisfies ProductionResourceProvider<Model>;
  });
}
