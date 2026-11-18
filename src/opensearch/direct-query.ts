import { createHash, randomUUID } from 'node:crypto';
import type { StateStore } from '../state.js';
import type { Clock } from '../core/clock.js';
import type { PrincipalContext } from '../auth/sigv4.js';
import { AwsError } from '../errors.js';
import { PaginationTokens } from '../core/pagination.js';
import { evaluateResourcePolicy } from '../iam/evaluator.js';
import { policyDocumentValidationError } from '../iam/policy-validation.js';
import { validateInput } from './protocol.js';
import { tags } from './validation.js';

export const DIRECT_QUERY_ACTIONS = new Set(['AddDirectQueryDataSource', 'GetDirectQueryDataSource', 'UpdateDirectQueryDataSource', 'DeleteDirectQueryDataSource', 'ListDirectQueryDataSources']);
export interface DirectQuerySource {
  name: string; arn: string; accountId: string; region: string; generation: string; roleArn: string;
  description?: string; accessPolicy?: string; collections: Array<{ arn: string; generation: string }>;
  ownerArn?: string; ownerId?: string; tags: Record<string, string>; deleting?: boolean; revision: number;
}
export interface DirectQueryCatalog { records: Record<string, DirectQuerySource>; cursorKey: string }
export interface DirectQueryHost {
  authorize(principal: PrincipalContext, action: string, resource: string, region: string, secure: boolean, extra?: Record<string, any>): void;
  collection(arn: string, region: string, account: string, principal?: PrincipalContext): string;
}
export type DirectQueryLogPort = (source: DirectQuerySource, operation: 'validate' | 'start' | 'get' | 'cancel' | 'cleanup' | 'guard', input?: any) => Promise<any>;
const invalid = (message: string): never => { throw new AwsError('ValidationException', message, 400); };
const missing = (): never => { throw new AwsError('ResourceNotFoundException', 'Direct query data source does not exist', 404); };
const denied = (message: string): never => { throw new AwsError('AccessDeniedException', message, 403); };
const hash = (value: any) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ownerId = (principal: PrincipalContext) => principal.roleArn ? principal.principalId.split(':')[0] : principal.principalId;

/** Data-source configuration delegates execution to the real Logs query owner. */
export class SearchDirectQueries {
  private logs?: DirectQueryLogPort;
  constructor(private readonly store: StateStore, private readonly clock: Clock, private readonly host: DirectQueryHost, private readonly authMode: string) {}
  configure(logs: DirectQueryLogPort): void { this.logs = logs; }
  state(region: string, account = this.store.accountId): DirectQueryCatalog { return this.store.regionState(region, account).opensearch.directQueries ??= { records: {}, cursorKey: randomUUID() }; }
  handles(operation: string, input: any): boolean { return DIRECT_QUERY_ACTIONS.has(operation) || ['AddTags', 'RemoveTags', 'ListTags'].includes(operation) && /^arn:[^:]+:opensearch:[^:]+:\d{12}:datasource\//.test(input.ARN ?? ''); }
  source(region: string, name: string, account = this.store.accountId, allowDeleting = false): DirectQuerySource {
    const source = Object.values(this.state(region, account).records).find(source => source.name === name || source.arn === name);
    return source && (allowDeleting || !source.deleting) ? source : missing();
  }
  private async call(source: DirectQuerySource, operation: Parameters<DirectQueryLogPort>[1], input?: any): Promise<any> { if (!this.logs) throw new AwsError('InternalException', 'CloudWatch Logs integration is unavailable', 503); return this.logs(source, operation, input); }
  private context(source?: DirectQuerySource) { return Object.fromEntries(Object.entries(source?.tags ?? {}).map(([key, value]) => [`aws:ResourceTag/${key}`, value])); }
  private view(source: DirectQuerySource, list = false): any {
    return { DataSourceName: source.name, DataSourceArn: source.arn, DataSourceType: { CloudWatchLog: { RoleArn: source.roleArn } }, OpenSearchArns: source.collections.map(item => item.arn), ...(source.description === undefined ? {} : { Description: source.description }), ...(list ? { TagList: Object.entries(source.tags).map(([Key, Value]) => ({ Key, Value })) } : source.accessPolicy === undefined ? {} : { DataSourceAccessPolicy: source.accessPolicy }) };
  }
  private policy(value: unknown, account: string): string | undefined {
    if (value === '') return undefined;
    if (typeof value !== 'string' || Buffer.byteLength(value) > 102400) invalid('DataSourceAccessPolicy requires an IAM JSON document of at most 100 KiB');
    let policy: any; try { policy = JSON.parse(value as string); } catch { invalid('DataSourceAccessPolicy must contain valid JSON'); }
    const error = policyDocumentValidationError(policy, 'resource'); if (error) invalid(error);
    for (const statement of Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement]) {
      if (statement.NotPrincipal) invalid('Direct query policies do not support NotPrincipal');
      const principal = statement.Principal;
      if (principal !== '*') {
        if (!principal || typeof principal !== 'object' || Object.keys(principal).some(key => key !== 'AWS')) invalid('Direct query policies require AWS principals');
        for (const arn of Array.isArray(principal.AWS) ? principal.AWS : [principal.AWS]) if (arn !== '*' && arn !== account && !(typeof arn === 'string' && new RegExp(`^arn:(aws|aws-cn|aws-us-gov):iam::${account}:(root|user/.+|role/.+)$`).test(arn))) invalid('Direct query supports same-account IAM principals only');
      }
    }
    return JSON.stringify(policy);
  }
  private async configuration(input: any, previous: DirectQuerySource | undefined, region: string, account: string, principal?: PrincipalContext): Promise<Pick<DirectQuerySource, 'roleArn' | 'collections' | 'description' | 'accessPolicy'>> {
    if (!input.DataSourceType?.CloudWatchLog || Object.keys(input.DataSourceType).length !== 1) invalid('Only CloudWatchLog direct queries have an embedded execution owner; SecurityLake and Prometheus are unavailable');
    const roleArn = input.DataSourceType.CloudWatchLog.RoleArn;
    if (typeof roleArn !== 'string' || !new RegExp(`^arn:(aws|aws-cn|aws-us-gov):iam::${account}:role/[\\w+=,.@/-]+$`).test(roleArn)) invalid('The data source role must belong to this account');
    const arns = input.OpenSearchArns ?? previous?.collections.map(item => item.arn);
    if (!Array.isArray(arns) || !arns.length || arns.length > 20 || new Set(arns).size !== arns.length) invalid('CloudWatchLog direct queries require 1–20 distinct associated collections');
    const collections = arns.map((arn: string) => ({ arn, generation: this.host.collection(arn, region, account, principal) }));
    return { roleArn, collections, description: input.Description ?? previous?.description, accessPolicy: input.DataSourceAccessPolicy === undefined ? previous?.accessPolicy : this.policy(input.DataSourceAccessPolicy, account) };
  }
  async execute(operation: string, input: any, region: string, account = this.store.accountId, principal?: PrincipalContext, secure = true): Promise<any> {
    validateInput({ family: 'opensearch', operation, input, status: 200 });
    return this.store.withMutationLock('opensearch:direct-query', async () => {
      const state = this.state(region, account), name = input.DataSourceName;
      const current = Object.values(state.records).find(source => source.name === name || source.arn === input.ARN);
      const partition = region.startsWith('cn-') ? 'aws-cn' : region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
      const resource = current?.arn ?? input.ARN ?? (name ? `arn:${partition}:opensearch:${region}:${account}:datasource/${name}` : '*');
      const extra = { ...this.context(current), 'aws:TagKeys': input.TagKeys ?? (input.TagList ?? []).map((tag: any) => tag.Key), ...Object.fromEntries((input.TagList ?? []).map((tag: any) => [`aws:RequestTag/${tag.Key}`, tag.Value])) };
      if (principal) this.host.authorize(principal, `es:${operation}`, resource, region, secure, extra);
      if (operation === 'ListDirectQueryDataSources') {
        const rows = Object.values(state.records).filter(source => !source.deleting).sort((a, b) => a.name.localeCompare(b.name)).map(source => this.view(source, true)), fingerprint = hash(rows), tokens = new PaginationTokens(state.cursorKey); let offset = 0;
        if (input.NextToken) { try { if (input.NextToken.split('.').length !== 2) throw new Error(); const token = tokens.decode<any>(`${account}:${region}:direct-query`, input.NextToken); if (token.fingerprint !== fingerprint || token.expires <= this.clock.now() || !Number.isInteger(token.offset) || token.offset < 1 || token.offset >= rows.length) throw new Error(); offset = token.offset; } catch { invalid('Invalid, expired or stale pagination token'); } }
        return { DirectQueryDataSources: rows.slice(offset, offset + 10), ...(offset + 10 < rows.length ? { NextToken: tokens.encode(`${account}:${region}:direct-query`, { fingerprint, offset: offset + 10, expires: this.clock.now() + 600000 }) } : {}) };
      }
      if (operation === 'GetDirectQueryDataSource') return this.view(this.source(region, name, account));
      if (operation === 'ListTags') return { TagList: Object.entries(this.source(region, input.ARN, account).tags).map(([Key, Value]) => ({ Key, Value })) };
      if (operation === 'DeleteDirectQueryDataSource') {
        const source = this.source(region, name, account, true), wasDeleting = source.deleting; source.deleting = true;
        try { await this.store.save(); } catch (error) { source.deleting = wasDeleting; throw error; }
        await this.call(source, 'cleanup'); delete state.records[source.name];
        try { await this.store.save(); } catch (error) { state.records[source.name] = source; throw error; }
        return {};
      }
      const before = structuredClone(state);
      try {
        if (operation === 'AddDirectQueryDataSource') {
          if (current) invalid('Data source name already exists');
          if (Object.keys(state.records).length >= 20) throw new AwsError('LimitExceededException', 'At most 20 direct query data sources are supported per account and Region', 409);
          const configuration = await this.configuration(input, undefined, region, account, principal);
          if (principal) { this.host.authorize(principal, 'iam:PassRole', configuration.roleArn, region, secure, { 'iam:PassedToService': 'directquery.opensearchservice.amazonaws.com', 'iam:AssociatedResourceArn': resource }); if (input.TagList?.length) this.host.authorize(principal, 'es:AddTags', resource, region, secure, extra); }
          const source: DirectQuerySource = { name, arn: resource, generation: randomUUID(), region, accountId: account, ...configuration, ownerArn: principal?.roleArn ?? principal?.principalArn, ownerId: principal ? ownerId(principal) : undefined, tags: tags(input.TagList ?? []), revision: 1 };
          await this.call(source, 'validate'); state.records[name] = source;
        } else {
          const source = this.source(region, name ?? input.ARN, account);
          if (operation === 'UpdateDirectQueryDataSource') {
            const configuration = await this.configuration(input, source, region, account, principal);
            if (principal) this.host.authorize(principal, 'iam:PassRole', configuration.roleArn, region, secure, { 'iam:PassedToService': 'directquery.opensearchservice.amazonaws.com', 'iam:AssociatedResourceArn': source.arn });
            await this.call({ ...source, ...configuration }, 'validate'); Object.assign(source, configuration); source.revision++;
          } else if (operation === 'AddTags') source.tags = tags(input.TagList, source.tags);
          else if (operation === 'RemoveTags') for (const key of input.TagKeys) { if (String(key).toLowerCase().startsWith('aws:')) invalid('Reserved tags cannot be removed'); delete source.tags[key]; }
          else invalid('Unknown direct query operation');
        }
        await this.store.save(); return operation.endsWith('Tags') ? {} : { DataSourceArn: resource };
      } catch (error) { state.records = before.records; state.cursorKey = before.cursorKey; throw error; }
    });
  }
  async resume(): Promise<void> {
    for (const account of Object.values(this.store.state.accounts)) for (const regional of Object.values(account.regions)) for (const source of Object.values(regional.opensearch?.directQueries?.records ?? {})) if (source.deleting) {
      try { await this.execute('DeleteDirectQueryDataSource', { DataSourceName: source.name }, source.region, source.accountId); } catch { /* The durable delete can be retried after its dependency recovers. */ }
    }
  }
  async guard(region: string, account: string, arn: string, generation: string, input: any): Promise<void> {
    const source = this.source(region, arn, account); if (source.generation !== generation) denied('The direct query source was replaced');
    for (const collection of source.collections) if (this.host.collection(collection.arn, region, account) !== collection.generation) denied('An associated collection was replaced');
    await this.call(source, 'guard', input);
  }
  async local(region: string, account: string, name: string, action: string, input: any, principal: PrincipalContext, secure: boolean, sourceIp?: string): Promise<any> {
    return this.store.withMutationLock('opensearch:direct-query', async () => {
      const source = this.source(region, name, account);
      if (!['start', 'get', 'cancel'].includes(action)) invalid('Unknown direct query action');
      const actions = action === 'start' ? ['StartDirectQuery'] : action === 'get' ? ['GetDirectQuery', 'GetDirectQueryResult'] : ['CancelDirectQuery'];
      if (this.authMode === 'enforce') {
        if (principal.accountId !== account) denied('Direct query supports same-account principals only');
        for (const action of actions) {
          const context = { ...this.context(source), 'aws:PrincipalArn': principal.roleArn ?? principal.principalArn, 'aws:PrincipalAccount': account, 'aws:RequestedRegion': region, 'aws:SecureTransport': secure, 'aws:CurrentTime': new Date(this.clock.now()).toISOString(), 'aws:SourceIp': sourceIp };
          this.host.authorize(principal, `opensearch:${action}`, source.arn, region, secure, context);
          if (source.accessPolicy) { if (evaluateResourcePolicy(JSON.parse(source.accessPolicy), principal, `opensearch:${action}`, source.arn, context).decision !== 'allowed') denied('The data source policy does not allow this query action'); }
          else if ((principal.roleArn ?? principal.principalArn) !== source.ownerArn || ownerId(principal) !== source.ownerId) denied('A data source without an access policy can be queried only by its creator');
        }
      }
      for (const collection of source.collections) if (this.host.collection(collection.arn, region, account) !== collection.generation) denied('An associated collection was replaced');
      return this.call(source, action as 'start' | 'get' | 'cancel', input);
    });
  }
}
