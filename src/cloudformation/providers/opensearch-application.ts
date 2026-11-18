import { AwsError } from '../../errors.js';
import type { SearchApplications, ApplicationRecord } from '../../opensearch/applications.js';
import { validateInput } from '../../opensearch/protocol.js';
import { ProviderReferenceError, validateDeclaredProperties, type ProductionResourceProvider, type ProviderContext, type ProviderSchema, type ProviderReadResult } from './contract.js';

const TYPE = 'AWS::OpenSearchService::Application';
type Model = Record<string, any>;
const owner = (context: ProviderContext) => `${context.stackId}/${context.logicalId}`;
const progress = (physicalId: string, operation: string) => ({ status: 'IN_PROGRESS' as const, callbackAfterMs: 100, checkpoint: { schemaVersion: 1 as const, physicalId, callbackContext: { operation } } });
const failure = (error: unknown) => ({ status: 'FAILED' as const, errorCode: error instanceof AwsError ? error.code : 'InternalFailure', message: error instanceof Error ? error.message : String(error) });
const schema: ProviderSchema = {
  typeName: TYPE, unknownProperties: 'REJECT', properties: {
    Name: { valueType: 'string', required: true, updateBehavior: 'REPLACEMENT' }, KmsKeyArn: { valueType: 'string', updateBehavior: 'REPLACEMENT' },
    AppConfigs: { valueType: 'array', updateBehavior: 'MUTABLE' }, DataSources: { valueType: 'array', updateBehavior: 'MUTABLE' }, IamIdentityCenterOptions: { valueType: 'object', updateBehavior: 'MUTABLE' }, Tags: { valueType: 'array', updateBehavior: 'MUTABLE' },
  }, ref: { supported: true, valueType: 'string' }, attributes: { Arn: { valueType: 'string' }, Id: { valueType: 'string' }, Endpoint: { valueType: 'string' } },
  replacement: { defaultOrder: 'CREATE_BEFORE_DELETE' }, retention: { deletionPolicies: ['Delete', 'Retain', 'RetainExceptOnCreate'], updateReplacePolicies: ['Delete', 'Retain', 'RetainExceptOnCreate'], snapshotSupported: false }, tags: { behavior: 'STACK_AND_RESOURCE', propertyName: 'Tags', propagatesCloudFormationTags: true },
};
function lower(value: any): any { return Array.isArray(value) ? value.map(lower) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key[0].toLowerCase() + key.slice(1), lower(child)])) : value; }
function input(model: Model): Model { const { Tags, ...rest } = model; return { ...lower(rest), tagList: Tags ?? [] }; }
function properties(app: ApplicationRecord): Model {
  return { Name: app.name, AppConfigs: app.appConfigs.map(config => ({ Key: config.key, Value: config.value })).sort((a, b) => a.Key.localeCompare(b.Key)), DataSources: app.sources.map(source => ({ DataSourceArn: source.dataSourceArn, ...(source.dataSourceDescription === undefined ? {} : { DataSourceDescription: source.dataSourceDescription }) })).sort((a, b) => a.DataSourceArn.localeCompare(b.DataSourceArn)), IamIdentityCenterOptions: { Enabled: false }, Tags: Object.entries(app.tags).filter(([key]) => !key.toLowerCase().startsWith('aws:')).map(([Key, Value]) => ({ Key, Value })).sort((a, b) => a.Key.localeCompare(b.Key)) };
}
function result(app: ApplicationRecord): ProviderReadResult<Model> {
  if (app.status === 'FAILED') return { status: 'FAILED', physicalId: app.arn, errorCode: 'NotStabilized', message: app.failure ?? 'Application failed' };
  if (app.status !== 'ACTIVE') return progress(app.arn, 'read');
  return { status: 'SUCCESS', physicalId: app.arn, model: { physicalId: app.arn, properties: properties(app), attributes: { Arn: app.arn, Id: app.id, Endpoint: `https://127.0.0.1:${app.gatewayPort}` } } };
}
export function createOpenSearchApplicationProvider(service: SearchApplications, region: string): ProductionResourceProvider<Model> {
  const owned = (id: string, context: ProviderContext) => { service.authorizeOperation('GetApplication', { id }, region, context.principal.identity); const app = service.application(region, id, context.accountId); if (app.owner !== owner(context)) throw new AwsError('OwnershipConflict', 'Application belongs to another resource generation', 409); return app; };
  const call = (operation: string, input: Model, context: ProviderContext) => service.execute(operation, input, region, context.accountId, context.principal.identity, owner(context));
  return {
    typeName: TYPE, providerVersion: 1, visibility: 'production', schema,
    validate(value) { const issues = [...validateDeclaredProperties(value, schema)]; if (!issues.length) try { validateInput({ family: 'opensearch', operation: 'CreateApplication', input: input(value as Model), status: 200 }); } catch (error) { issues.push({ code: 'InvalidProperty', path: 'Properties', pathSegments: ['Properties'], message: (error as Error).message }); } return issues; },
    canonicalize(value) { const model = value as Model; return { ...model, AppConfigs: [...(model.AppConfigs ?? [])].sort((a, b) => a.Key.localeCompare(b.Key)), DataSources: [...(model.DataSources ?? [])].sort((a, b) => a.DataSourceArn.localeCompare(b.DataSourceArn)), IamIdentityCenterOptions: model.IamIdentityCenterOptions ?? { Enabled: false }, Tags: [...(model.Tags ?? [])].sort((a, b) => a.Key.localeCompare(b.Key)) }; },
    plan(previous, desired) { const changedProperties = previous ? Object.keys(desired).filter(key => JSON.stringify(previous[key]) !== JSON.stringify(desired[key])) : Object.keys(desired), replacementProperties = previous ? ['Name', 'KmsKeyArn'].filter(key => previous[key] !== desired[key]) : []; return { action: !previous ? 'CREATE' : replacementProperties.length ? 'REPLACE' : changedProperties.length ? 'UPDATE' : 'NO_OP', desired, changedProperties, replacementProperties }; },
    async create(desired, context) {
      try { const existing = Object.values(service.state(region, context.accountId).records).find(app => app.name === desired.Name); if (existing) return result(owned(existing.arn, context)) as any;
        const tagList = [...desired.Tags, { Key: 'aws:cloudformation:stack-id', Value: context.stackId }, { Key: 'aws:cloudformation:stack-name', Value: context.stackId.split(':stack/')[1]?.split('/')[0] ?? context.stackId }, { Key: 'aws:cloudformation:logical-id', Value: context.logicalId }];
        const response = await call('CreateApplication', { ...input(desired), tagList }, context); return progress(response.arn, 'create');
      } catch (error) { return failure(error); }
    },
    async read(id, context) { try { return result(owned(id, context)); } catch (error) { return error instanceof AwsError && error.code === 'ResourceNotFoundException' ? { status: 'NOT_FOUND', physicalId: id } : failure(error); } },
    async update(id, previous, desired, context) {
      try { const app = owned(id, context); if (app.name !== desired.Name) throw new AwsError('RequiresReplacement', 'Application name changes require replacement');
        if (context.callbackContext?.operation === 'update') { const current = result(app); return current.status === 'IN_PROGRESS' ? progress(id, 'update') : current as any; }
        const removed = Object.keys(app.tags).filter(key => !key.toLowerCase().startsWith('aws:') && !desired.Tags.some((tag: any) => tag.Key === key)); if (desired.Tags.length) await call('AddTags', { ARN: id, TagList: desired.Tags }, context); if (removed.length) await call('RemoveTags', { ARN: id, TagKeys: removed }, context);
        if (['AppConfigs', 'DataSources', 'IamIdentityCenterOptions'].some(key => JSON.stringify(previous[key]) !== JSON.stringify(desired[key]))) { const { name, tagList, kmsKeyArn, ...update } = input(desired); await call('UpdateApplication', { id: app.id, ...update }, context); return progress(id, 'update'); }
        return result(app) as any;
      } catch (error) { return failure(error); }
    },
    async delete(id, _previous, context) { try { const app = owned(id, context); if (['CREATING', 'UPDATING'].includes(app.status)) return progress(id, 'delete'); if (app.status !== 'DELETING') await call('DeleteApplication', { id: app.id }, context); return progress(id, 'delete'); } catch (error) { return error instanceof AwsError && error.code === 'ResourceNotFoundException' ? { status: 'SUCCESS', physicalId: id } : failure(error); } },
    async retain(id, _previous, context) { const app = owned(id, context), previous = app.owner; delete app.owner; try { await service.store.save(); } catch (error) { app.owner = previous; throw error; } },
    ref(read) { return read.properties.Name; },
    getAtt(read, attribute) { if (Object.hasOwn(read.attributes, attribute)) return read.attributes[attribute]; throw new ProviderReferenceError(TYPE, `Fn::GetAtt ${attribute}`); },
  };
}
