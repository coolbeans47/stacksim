import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { StateStore } from '../state.js';
import type { Clock } from '../core/clock.js';
import type { PrincipalContext } from '../auth/sigv4.js';
import { AwsError } from '../errors.js';
import { PaginationTokens } from '../core/pagination.js';
import { EmbeddedSearchEngine } from './engine.js';
import { SearchError } from './query.js';
import { tags } from './validation.js';
import { readOpenSearchBody, validateInput } from './protocol.js';

export const APPLICATION_ACTIONS = new Set(['CreateApplication', 'GetApplication', 'UpdateApplication', 'DeleteApplication', 'ListApplications', 'AttachDataSource', 'DetachDataSource', 'DescribeDataSourceAttachment', 'ListDataSourceAttachments', 'GetDefaultApplicationSetting', 'PutDefaultApplicationSetting']);
export interface ApplicationSource { dataSourceArn: string; dataSourceDescription?: string; generation: string; kind: 'domain' | 'collection' }
interface Workspace { id: string; name: string; workspaceType: 'SEARCH'; sources: string[] }
interface Attachment { attachmentId: string; dataSourceArn: string; generation: string; status: 'PENDING' | 'ATTACHED' | 'FAILED'; workspaceId?: string; createdAt: number }
export interface ApplicationRecord {
  id: string; name: string; arn: string; generation: string; region: string; accountId: string; gatewayPort: number;
  status: 'CREATING' | 'UPDATING' | 'DELETING' | 'ACTIVE' | 'FAILED'; createdAt: number; updatedAt: number; storageReady?: boolean; failure?: string;
  sources: ApplicationSource[]; appConfigs: Array<{ key: string; value: string }>; tags: Record<string, string>;
  workspaces: Workspace[]; attachments: Attachment[]; owner?: string;
}
export interface ApplicationCatalog {
  records: Record<string, ApplicationRecord>; retiredPorts: number[]; cursorKey: string; defaultArn?: string;
  tokens: Record<string, { fingerprint: string; expires: number; response: any }>;
}
export interface ApplicationHost {
  authorize(principal: PrincipalContext, action: string, resource: string, region: string, secure: boolean, extra?: Record<string, any>): void;
  identity(req: IncomingMessage, url: URL, region: string): Promise<PrincipalContext>;
  source(arn: string, region: string, account: string, principal?: PrincipalContext): { generation: string; kind: 'domain' | 'collection'; active: boolean; failed: boolean };
  query(source: ApplicationSource, app: ApplicationRecord, principal: PrincipalContext, secure: boolean, input: any): Promise<{ status: number; body?: any; contentType?: string }>;
}
const invalid = (message: string): never => { throw new AwsError('ValidationException', message, 400); };
const missing = (): never => { throw new AwsError('ResourceNotFoundException', 'Application or attachment does not exist', 409); };
const conflict = (message: string): never => { throw new AwsError('ConflictException', message, 409); };
const hash = (value: any) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value: any): any { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value; }
const sourceView = ({ dataSourceArn, dataSourceDescription }: ApplicationSource) => ({ dataSourceArn, ...(dataSourceDescription === undefined ? {} : { dataSourceDescription }) });
const TAG_ACTIONS = new Set(['AddTags', 'RemoveTags', 'ListTags']);

/** Owns application state and saved objects. Source queries always run as the caller. */
export class SearchApplications {
  private tls?: { certificate: string; privateKey: string };
  private closing = true;
  private timer?: ReturnType<Clock['setTimeout']>;
  private readonly gateways = new Map<string, Server>();
  private readonly engines = new Map<string, EmbeddedSearchEngine>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly requests = new Map<string, number>();
  constructor(readonly store: StateStore, private readonly clock: Clock, private readonly host: ApplicationHost) {}
  configureTls(tls: { certificate: string; privateKey: string }): void { this.tls = tls; }
  state(region: string, account = this.store.accountId): ApplicationCatalog { return this.store.regionState(region, account).opensearch.applications ??= { records: {}, retiredPorts: [], cursorKey: randomUUID(), tokens: {} }; }
  private all(): ApplicationRecord[] { return Object.values(this.store.state.accounts).flatMap(account => Object.values(account.regions).flatMap(region => Object.values(region.opensearch?.applications?.records ?? {}))); }
  application(region: string, id: string, account = this.store.accountId): ApplicationRecord { return Object.values(this.state(region, account).records).find(app => app.id === id || app.name === id || app.arn === id) ?? missing(); }
  handles(operation: string, input: any): boolean { return APPLICATION_ACTIONS.has(operation) || TAG_ACTIONS.has(operation) && /^arn:[^:]+:opensearch:[^:]+:\d{12}:application\//.test(input.ARN ?? ''); }
  private context(app?: ApplicationRecord) { return Object.fromEntries(Object.entries(app?.tags ?? {}).map(([key, value]) => [`aws:ResourceTag/${key}`, value])); }
  authorizeOperation(operation: string, input: any, region: string, principal: PrincipalContext, secure = true): void {
    const account = principal.accountId || this.store.accountId, state = this.state(region, account);
    const app = Object.values(state.records).find(app => [input.id, input.ARN, input.applicationArn].some(id => id && [app.id, app.name, app.arn].includes(id)));
    const partition = region.startsWith('cn-') ? 'aws-cn' : region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
    const resource = operation === 'CreateApplication' ? `arn:${partition}:opensearch:${region}:${account}:application/*` : app?.arn ?? input.ARN ?? input.applicationArn ?? (input.id ? `arn:${partition}:opensearch:${region}:${account}:application/${input.id}` : '*');
    const list = input.tagList ?? input.TagList ?? [], extra = { ...this.context(app), 'aws:TagKeys': input.TagKeys ?? list.map((tag: any) => tag.Key), ...Object.fromEntries(list.map((tag: any) => [`aws:RequestTag/${tag.Key}`, tag.Value])) };
    this.host.authorize(principal, `es:${operation}`, resource, region, secure, extra);
    if (operation === 'CreateApplication' && list.length) this.host.authorize(principal, 'es:AddTags', resource, region, secure, extra);
  }
  private configuration(input: any, region: string, account: string, principal?: PrincipalContext): { sources?: ApplicationSource[]; appConfigs?: ApplicationRecord['appConfigs'] } {
    if (input.kmsKeyArn !== undefined) invalid('Application customer KMS encryption is not implemented; local application keys encrypt saved objects');
    const identity = input.iamIdentityCenterOptions;
    if (identity && (identity.enabled !== false || Object.keys(identity).some(key => key !== 'enabled'))) invalid('Application IAM Identity Center integration is not implemented; use IAM authentication');
    let sources: ApplicationSource[] | undefined, appConfigs: ApplicationRecord['appConfigs'] | undefined;
    if (input.dataSources !== undefined) {
      if (!Array.isArray(input.dataSources) || input.dataSources.length > 20) invalid('Applications support at most 20 associated sources');
      const seen = new Set<string>();
      sources = input.dataSources.map((source: any) => {
        if (source.iamRoleForDataSourceArn !== undefined) invalid('Cross-account source roles are not implemented');
        if (seen.has(source.dataSourceArn)) invalid('Duplicate data source'); seen.add(source.dataSourceArn);
        const resolved = this.host.source(source.dataSourceArn, region, account, principal);
        if (resolved.failed) invalid('The source is deleting or failed');
        return { ...sourceView(source), generation: resolved.generation, kind: resolved.kind };
      });
    }
    if (input.appConfigs !== undefined) {
      const seen = new Set<string>();
      appConfigs = input.appConfigs.map((config: any) => {
        if (seen.has(config.key)) invalid('Duplicate application configuration key'); seen.add(config.key);
        if (config.key === 'opensearchDashboards.dashboardAdmin.groups') { if (config.value !== '') invalid('Group administrators require an identity provider'); }
        else if (config.key !== 'opensearchDashboards.dashboardAdmin.users' || config.value !== '*' && !/^arn:(aws|aws-cn|aws-us-gov):iam::\d{12}:role\/[\w+=,.@\/-]+$/.test(config.value)) invalid('Dashboard administrators must be * or one IAM role ARN');
        return { key: config.key, value: config.value };
      });
    }
    return { sources, appConfigs };
  }
  view(app: ApplicationRecord, operation = 'GetApplication'): any {
    const summary = { id: app.id, name: app.name, arn: app.arn, endpoint: `https://127.0.0.1:${app.gatewayPort}`, status: app.status, createdAt: app.createdAt / 1000, lastUpdatedAt: app.updatedAt / 1000 };
    if (operation === 'ListApplications') return summary;
    const { endpoint, status, lastUpdatedAt, ...base } = summary;
    return { ...base, dataSources: app.sources.map(sourceView), iamIdentityCenterOptions: { enabled: false }, appConfigs: structuredClone(app.appConfigs), ...(operation === 'UpdateApplication' ? {} : { tagList: Object.entries(app.tags).map(([Key, Value]) => ({ Key, Value })) }), ...(operation !== 'CreateApplication' ? { lastUpdatedAt } : {}), ...(operation === 'GetApplication' ? { endpoint, status } : {}) };
  }
  private page<T>(state: ApplicationCatalog, rows: T[], input: any, scope: string): { items: T[]; nextToken?: string } {
    const size = input.maxResults ?? 100; if (!Number.isInteger(size) || size < 1 || size > 100) invalid('maxResults must be 1–100');
    const fingerprint = hash(rows), tokens = new PaginationTokens(state.cursorKey); let offset = 0;
    if (input.nextToken) { try { if (input.nextToken.split('.').length !== 2) throw new Error(); const value = tokens.decode<any>(scope, input.nextToken); if (value.fingerprint !== fingerprint || value.expires <= this.clock.now() || !Number.isInteger(value.offset) || value.offset < 1 || value.offset >= rows.length) throw new Error(); offset = value.offset; } catch { invalid('Invalid, expired or stale pagination token'); } }
    return { items: rows.slice(offset, offset + size), ...(offset + size < rows.length ? { nextToken: tokens.encode(scope, { fingerprint, offset: offset + size, expires: this.clock.now() + 600000 }) } : {}) };
  }
  async execute(operation: string, input: any, region: string, account = this.store.accountId, principal?: PrincipalContext, owner?: string, secure = true): Promise<any> {
    if (!this.handles(operation, input)) invalid('Unknown application operation');
    validateInput({ family: 'opensearch', operation, input, status: 200 });
    if (principal) this.authorizeOperation(operation, input, region, principal, secure);
    return this.store.withMutationLock('opensearch:applications', async () => {
      const state = this.state(region, account), before = structuredClone(state), now = this.clock.now(); let reserved: ApplicationRecord | undefined, schedule: ApplicationRecord | undefined;
      try {
        const tokenKey = input.clientToken ? hash([operation, input.id, input.clientToken]) : undefined, { clientToken, ...payload } = input, fingerprint = hash(canonical(payload));
        if (tokenKey && state.tokens[tokenKey]?.expires > now) { if (state.tokens[tokenKey].fingerprint !== fingerprint) invalid('Client token was reused with different parameters'); return structuredClone(state.tokens[tokenKey].response); }
        let response: any;
        if (operation === 'ListApplications') { const page = this.page(state, Object.values(state.records).filter(app => !input.statuses?.length || input.statuses.includes(app.status)).sort((a, b) => a.id.localeCompare(b.id)).map(app => this.view(app, operation)), input, `${account}:${region}:applications`); return { ApplicationSummaries: page.items, ...(page.nextToken ? { nextToken: page.nextToken } : {}) }; }
        if (operation === 'GetDefaultApplicationSetting') return state.defaultArn ? { applicationArn: state.defaultArn } : {};
        if (operation === 'PutDefaultApplicationSetting') { const app = this.application(region, input.applicationArn, account); if (app.status !== 'ACTIVE') conflict('Default application must be active'); if (input.setAsDefault) state.defaultArn = app.arn; else if (state.defaultArn === app.arn) delete state.defaultArn; response = state.defaultArn ? { applicationArn: state.defaultArn } : {}; }
        else if (operation === 'CreateApplication') {
          if (this.closing || !this.tls) throw new AwsError('InternalException', 'Application endpoints are unavailable', 503);
          if (Object.values(state.records).some(app => app.name === input.name)) conflict('Application name already exists');
          if (this.all().length >= 20) throw new AwsError('LimitExceededException', 'The installation limit of 20 applications was reached', 409);
          const config = this.configuration(input, region, account, principal), id = randomBytes(12).toString('hex'), partition = region.startsWith('cn-') ? 'aws-cn' : region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
          const app: ApplicationRecord = { id, name: input.name, arn: `arn:${partition}:opensearch:${region}:${account}:application/${id}`, generation: randomUUID(), region, accountId: account, gatewayPort: 0, status: 'CREATING', createdAt: now, updatedAt: now, sources: config.sources ?? [], appConfigs: config.appConfigs ?? [], tags: tags(input.tagList ?? [], {}, Boolean(owner)), workspaces: [], attachments: [], ...(owner ? { owner } : {}) };
          await this.reserve(app); reserved = app; state.records[id] = app; schedule = app; response = this.view(app, operation);
        } else if (operation !== 'PutDefaultApplicationSetting') {
          const app = this.application(region, input.id ?? input.ARN, account);
          if (operation === 'GetApplication') return this.view(app);
          if (operation === 'ListTags') return { TagList: Object.entries(app.tags).map(([Key, Value]) => ({ Key, Value })) };
          if (operation === 'ListDataSourceAttachments') { const page = this.page(state, app.attachments.map(({ attachmentId, dataSourceArn, status }) => ({ attachmentId, dataSourceArn, status })), input, `${app.arn}:attachments`); return { attachments: page.items, ...(page.nextToken ? { nextToken: page.nextToken } : {}) }; }
          const attachment = app.attachments.find(item => item.dataSourceArn === input.dataSourceArn);
          if (operation === 'DescribeDataSourceAttachment') { if (!attachment) missing(); return this.attachmentView(app, attachment!); }
          if (operation === 'DeleteApplication') { app.status = 'DELETING'; if (state.defaultArn === app.arn) delete state.defaultArn; schedule = app; response = {}; }
          else {
            if (!['ACTIVE', 'CREATING'].includes(app.status) || app.status === 'CREATING' && operation !== 'AttachDataSource') conflict('Application is not ready for modification');
            if (operation === 'UpdateApplication') {
              const config = this.configuration(input, region, account, principal);
              if (config.sources) { app.sources = config.sources; app.attachments = app.attachments.filter(item => app.sources.some(source => source.dataSourceArn === item.dataSourceArn && source.generation === item.generation)); for (const workspace of app.workspaces) workspace.sources = workspace.sources.filter(arn => app.sources.some(source => source.dataSourceArn === arn)); }
              if (config.appConfigs) app.appConfigs = config.appConfigs;
              app.status = 'UPDATING'; schedule = app; response = this.view(app, operation);
            } else if (operation === 'AddTags') { app.tags = tags(input.TagList, app.tags, Boolean(owner)); response = {}; }
            else if (operation === 'RemoveTags') { for (const key of input.TagKeys) { if (key.toLowerCase().startsWith('aws:')) invalid('Reserved tags cannot be removed'); delete app.tags[key]; } response = {}; }
            else if (operation === 'AttachDataSource') {
              if (input.workspaceId !== undefined && input.workspaceConfiguration !== undefined) invalid('workspaceId and workspaceConfiguration are mutually exclusive');
              if (attachment && attachment.status !== 'FAILED') response = this.attachmentView(app, attachment);
              else {
              const source = this.host.source(input.dataSourceArn, region, account, principal); if (source.kind !== 'domain') invalid('AttachDataSource requires a managed domain; associate collections with UpdateApplication');
              if (source.failed) invalid('The source is deleting or failed');
              if (!app.sources.some(item => item.dataSourceArn === input.dataSourceArn)) { if (app.sources.length >= 20) invalid('Application source limit reached'); app.sources.push({ dataSourceArn: input.dataSourceArn, generation: source.generation, kind: source.kind }); }
              else app.sources.find(item => item.dataSourceArn === input.dataSourceArn)!.generation = source.generation;
              let workspace: Workspace | undefined;
              if (input.workspaceId) { workspace = app.workspaces.find(item => item.id === input.workspaceId); if (!workspace) invalid('Workspace does not exist'); }
              if (input.workspaceConfiguration) workspace = this.newWorkspace(app, input.workspaceConfiguration);
              if (attachment) app.attachments.splice(app.attachments.indexOf(attachment), 1);
              const item: Attachment = { attachmentId: randomUUID(), dataSourceArn: input.dataSourceArn, generation: source.generation, status: app.status === 'ACTIVE' && source.active ? 'ATTACHED' : 'PENDING', createdAt: now, ...(workspace ? { workspaceId: workspace.id } : {}) };
              if (workspace && item.status === 'ATTACHED' && !workspace.sources.includes(item.dataSourceArn)) workspace.sources.push(item.dataSourceArn);
              app.attachments.push(item); response = this.attachmentView(app, item);
              }
            } else if (operation === 'DetachDataSource') {
              if (!attachment) missing(); app.attachments = app.attachments.filter(item => item !== attachment); app.sources = app.sources.filter(item => item.dataSourceArn !== input.dataSourceArn);
              for (const workspace of app.workspaces) workspace.sources = workspace.sources.filter(arn => arn !== input.dataSourceArn);
              response = { id: app.id, arn: app.arn, dataSourceArn: input.dataSourceArn };
            } else invalid('Unknown application operation');
          }
          app.updatedAt = now;
        }
        for (const [key, value] of Object.entries(state.tokens)) if (value.expires <= now) delete state.tokens[key];
        if (tokenKey) { if (Object.keys(state.tokens).length >= 1000) invalid('Application idempotency capacity reached'); state.tokens[tokenKey] = { fingerprint, expires: now + 86400000, response: structuredClone(response) }; }
        await this.store.save(); if (schedule) this.enqueue(schedule); return response;
      } catch (error) { for (const key of Object.keys(state)) if (!Object.hasOwn(before, key)) delete (state as any)[key]; Object.assign(state, before); if (reserved) await this.closeGateway(reserved); throw error; }
    });
  }
  private attachmentView(app: ApplicationRecord, item: Attachment) { return { id: app.id, arn: app.arn, attachmentId: item.attachmentId, dataSourceArn: item.dataSourceArn, status: item.status }; }
  private newWorkspace(app: ApplicationRecord, input: any): Workspace {
    if (input.workspaceType !== 'SEARCH' || typeof input.name !== 'string' || !/^[A-Za-z0-9()[\]_ -]{1,40}$/.test(input.name)) invalid('Workspace requires a name of 1–40 letters, digits, spaces, ()[]_- and workspaceType SEARCH');
    if (app.workspaces.length >= 20) invalid('Application workspace limit of 20 reached');
    if (app.workspaces.some(item => item.name === input.name)) conflict('Workspace name already exists');
    const workspace: Workspace = { id: randomUUID(), name: input.name, workspaceType: 'SEARCH', sources: [] }; app.workspaces.push(workspace); return workspace;
  }
  private admin(app: ApplicationRecord, principal: PrincipalContext): boolean {
    const admin = app.appConfigs.find(config => config.key === 'opensearchDashboards.dashboardAdmin.users')?.value;
    return admin === '*' || admin !== undefined && admin === principal.roleArn;
  }
  private access(app: ApplicationRecord, principal: PrincipalContext, secure: boolean): void {
    if (this.closing || app.status !== 'ACTIVE' || !this.engines.has(app.generation)) throw new AwsError('InternalException', 'Application endpoint is not ready', 503);
    if (principal.accountId && principal.accountId !== app.accountId) throw new AwsError('AccessDeniedException', 'Assume a role in the application account before opening its workspace', 403);
    this.host.authorize(principal, 'opensearch:ApplicationAccessAll', app.arn, app.region, secure, this.context(app));
  }
  async local(region: string, account: string, id: string, principal: PrincipalContext, secure: boolean, action: string, input: any): Promise<{ status: number; body?: any }> {
    const app = this.application(region, id, account); this.access(app, principal, secure);
    if (action === 'context') return { status: 200, body: { ...this.view(app), workspaces: structuredClone(app.workspaces), administrator: this.admin(app, principal), default: this.state(region, account).defaultArn === app.arn } };
    if (action === 'workspaces') {
      if (!this.admin(app, principal)) throw new AwsError('AccessDeniedException', 'Dashboard administrator permission is required to create workspaces', 403);
      return this.store.withMutationLock('opensearch:applications', async () => {
        const current = this.application(region, id, account); this.access(current, principal, secure); if (!this.admin(current, principal)) throw new AwsError('AccessDeniedException', 'Dashboard administrator permission changed', 403);
        if (!Array.isArray(input.dataSourceArns) || !input.dataSourceArns.length || input.dataSourceArns.length > 20 || new Set(input.dataSourceArns).size !== input.dataSourceArns.length) invalid('Select 1–20 distinct associated sources');
        for (const arn of input.dataSourceArns) { const source = current.sources.find(item => item.dataSourceArn === arn); if (!source) invalid('Source is not associated with this application'); const actual = this.host.source(arn, region, account); if (actual.generation !== source!.generation || !actual.active) conflict('Source is unavailable or was replaced'); }
        const before = structuredClone(current); try { const workspace = this.newWorkspace(current, input); workspace.sources = [...input.dataSourceArns]; current.updatedAt = this.clock.now(); await this.store.save(); return { status: 201, body: structuredClone(workspace) }; } catch (error) { Object.assign(current, before); throw error; }
      });
    }
    if (action !== 'query') invalid('Unknown application data operation');
    const workspace = app.workspaces.find(item => item.id === input.workspaceId), source = app.sources.find(item => item.dataSourceArn === input.dataSourceArn);
    if (!workspace || !source || !workspace.sources.includes(source.dataSourceArn)) throw new AwsError('AccessDeniedException', 'The source is not attached to this workspace', 403);
    const actual = this.host.source(source.dataSourceArn, region, account); if (actual.generation !== source.generation || !actual.active) conflict('Source is unavailable or was replaced');
    if (typeof input.path !== 'string' || !input.path.startsWith('/') || /[\\]|%2f|%5c|%00|%25|\/\.|\/\//i.test(input.path.split('?')[0]) || !['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(input.method)) invalid('Invalid query method or path');
    const body = Buffer.from(typeof input.body === 'string' ? input.body : input.body === undefined ? '' : JSON.stringify(input.body)); if (body.length > 10 * 1024 * 1024) invalid('Query exceeds 10 MiB');
    const count = this.requests.get(app.generation) ?? 0; if (count >= 16) throw new AwsError('LimitExceededException', 'Application concurrent query limit reached', 429);
    this.requests.set(app.generation, count + 1);
    try {
      let result;
      if (input.path === '/_stacksim/workspace' || input.path.startsWith('/_stacksim/workspace/')) {
        if (!['GET', 'HEAD'].includes(input.method) && !this.admin(app, principal)) throw new AwsError('AccessDeniedException', 'Dashboard administrator permission is required to modify saved objects', 403);
        result = await this.engines.get(app.generation)!.request(input.method, input.path, body, `${workspace.id}:${source.generation}`);
      } else {
        if (input.path.startsWith('/_stacksim')) invalid('Only the application saved-object endpoint is available under /_stacksim');
        result = await this.host.query(source, app, principal, secure, input);
      }
      if (Buffer.byteLength(JSON.stringify(result.body) ?? '') > 32 * 1024 * 1024) throw new AwsError('LimitExceededException', 'Application response exceeds 32 MiB', 413);
      return result;
    } finally { const active = (this.requests.get(app.generation) ?? 1) - 1; if (active) this.requests.set(app.generation, active); else this.requests.delete(app.generation); }
  }
  private location(app: ApplicationRecord) { if (!/^[a-f0-9-]{36}$/.test(app.generation)) throw new Error('Invalid application storage identity'); const directory = join(this.store.root, 'data', 'opensearch-applications', app.generation); return { directory, file: join(directory, 'workspace.enc'), key: join(this.store.root, 'secrets', 'opensearch-applications', `${app.generation}.key`) }; }
  async start(): Promise<void> { this.closing = false; for (const app of this.all()) this.enqueue(app); await Promise.all(this.jobs.values()); this.schedule(); }
  async stop(): Promise<void> { this.closing = true; if (this.timer !== undefined) this.clock.clearTimeout(this.timer); this.timer = undefined; await Promise.all(this.jobs.values()); for (const app of this.all()) await this.closeGateway(app); while (this.requests.size) await delay(5); for (const engine of this.engines.values()) engine.close(); this.engines.clear(); }
  private schedule(): void {
    if (this.closing || this.timer !== undefined) return;
    this.timer = this.clock.setTimeout(() => { this.timer = undefined; for (const app of this.all()) if (app.attachments.some(item => item.status === 'PENDING') && app.status === 'ACTIVE') this.enqueue(app); this.schedule(); }, 1000); (this.timer as any)?.unref?.();
  }
  private enqueue(app: ApplicationRecord): void {
    if (this.jobs.has(app.generation)) return;
    let completed = false;
    const work = delay(25).then(async () => {
      const original = this.state(app.region, app.accountId).records[app.id]; if (!original) return;
      // Closing a listener must not hold the catalog lock: a request already
      // admitted by that listener may still be waiting to acquire the lock.
      if (original.status === 'DELETING') { await this.destroy(original); completed = true; return; }
      await this.store.withMutationLock('opensearch:applications', async () => {
      const current = this.state(app.region, app.accountId).records[app.id]; if (!current) return;
      if (current.status === 'DELETING') return;
      const path = this.location(current);
      if (!this.engines.has(current.generation)) { if (current.storageReady) { await access(path.file); await access(path.key); } this.engines.set(current.generation, new EmbeddedSearchEngine(path.file, () => this.clock.now(), { keyFile: path.key }, { externalWorkspaceSources: true })); }
      if (!this.gateways.has(current.generation)) await this.bind(current, current.gatewayPort);
      current.storageReady = true; current.status = 'ACTIVE'; delete current.failure;
      for (const attachment of current.attachments.filter(item => item.status === 'PENDING')) {
        try { const source = this.host.source(attachment.dataSourceArn, current.region, current.accountId); if (source.generation !== attachment.generation || source.failed || this.clock.now() - attachment.createdAt > 86400000) attachment.status = 'FAILED'; else if (source.active) { attachment.status = 'ATTACHED'; const workspace = current.workspaces.find(item => item.id === attachment.workspaceId); if (workspace && !workspace.sources.includes(attachment.dataSourceArn)) workspace.sources.push(attachment.dataSourceArn); } } catch { attachment.status = 'FAILED'; }
      }
      current.updatedAt = this.clock.now(); await this.store.save();
      }); completed = true;
    }).catch(async () => { await this.store.withMutationLock('opensearch:applications', async () => { const current = this.state(app.region, app.accountId).records[app.id]; if (!current) return; if (current.status !== 'DELETING') current.status = 'FAILED'; current.failure = 'Application storage or endpoint publication failed; repair storage or port availability and restart'; await this.store.save().catch(() => undefined); }); }).finally(() => { this.jobs.delete(app.generation); const current = this.state(app.region, app.accountId).records[app.id]; if (completed && !this.closing && current && ['CREATING', 'UPDATING', 'DELETING'].includes(current.status)) this.enqueue(current); });
    this.jobs.set(app.generation, work);
  }
  private async bind(app: ApplicationRecord, port: number): Promise<void> {
    if (!this.tls) throw new Error('Application TLS is unavailable');
    const server = createServer({ key: this.tls.privateKey, cert: this.tls.certificate, minVersion: 'TLSv1.2', maxHeaderSize: 32768, requestTimeout: 30000, headersTimeout: 10000 }, (req, res) => { void this.gateway(app, req, res); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); }); server.on('error', () => undefined); this.gateways.set(app.generation, server); app.gatewayPort = port;
  }
  private async reserve(app: ApplicationRecord): Promise<void> {
    const used = new Set(this.all().map(item => item.gatewayPort)), retired = new Set(Object.values(this.store.state.accounts).flatMap(account => Object.values(account.regions).flatMap(region => region.opensearch?.applications?.retiredPorts ?? [])));
    // Avoid concentrating independent installations on the same restart ports.
    const offset = createHash('sha256').update(this.store.root).digest().readUInt32BE(0) % 5000;
    for (let attempt = 0; attempt < 5000; attempt++) {
      const port = 35000 + (offset + attempt) % 5000;
      if (used.has(port) || retired.has(port)) continue;
      try { await this.bind(app, port); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
    }
    throw new AwsError('LimitExceededException', 'No free application endpoint port', 409);
  }
  private async closeGateway(app: ApplicationRecord): Promise<void> { const server = this.gateways.get(app.generation); if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); }); this.gateways.delete(app.generation); }
  private async destroy(app: ApplicationRecord): Promise<void> {
    await this.closeGateway(app); while (this.requests.get(app.generation)) await delay(5); this.engines.get(app.generation)?.close(); this.engines.delete(app.generation);
    await this.store.withMutationLock('opensearch:applications', async () => {
    const path = this.location(app); await rm(path.directory, { recursive: true, force: true }); await rm(path.key, { force: true });
    const state = this.state(app.region, app.accountId); if (!state.retiredPorts.includes(app.gatewayPort)) state.retiredPorts.push(app.gatewayPort); delete state.records[app.id];
    try { await this.store.save(); } catch (error) { state.records[app.id] = app; throw error; }
    });
  }
  private async gateway(original: ApplicationRecord, req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('x-amzn-requestid', randomUUID()); res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-content-type-options', 'nosniff');
    try {
      const app = this.application(original.region, original.id, original.accountId);
      if (![`127.0.0.1:${app.gatewayPort}`, `localhost:${app.gatewayPort}`].includes(String(req.headers.host))) throw new AwsError('AccessDeniedException', 'Host does not match this application', 403);
      if (req.headers['x-stacksim-region'] && req.headers['x-stacksim-region'] !== app.region) invalid('Region header contradicts the application Region');
      const url = new URL(req.url!, `https://${req.headers.host}`);
      const assets: Record<string, [string, string]> = { '/app/workspace_initial': ['opensearch-application.html', 'text/html'], '/application.js': ['opensearch-application-entry.js', 'text/javascript'], '/opensearch-workspace.js': ['services/opensearch-workspace.js', 'text/javascript'], '/application-workspace.js': ['services/opensearch-application-workspace.js', 'text/javascript'], '/sigv4.js': ['sigv4.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
      if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
        const [file, type] = assets[url.pathname]; const body = (await readFile(join(process.cwd(), 'web', file), 'utf8')).replaceAll('{{REGION}}', app.region.replace(/[&<>"']/g, ''));
        res.setHeader('content-type', `${type}; charset=utf-8`); res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"); res.end(body); return;
      }
      const principal = await this.host.identity(req, url, app.region); this.access(app, principal, true);
      if (req.method === 'GET' && url.pathname === '/') { res.statusCode = 302; res.setHeader('location', '/app/workspace_initial'); res.end(); return; }
      const action = /^\/_stacksim\/application\/(context|workspaces|query)$/.exec(url.pathname)?.[1];
      if (!action || (action === 'context' ? req.method !== 'GET' : req.method !== 'POST')) invalid('Unknown application endpoint');
      const raw = await readOpenSearchBody(req); let input: any; try { input = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { invalid('Invalid JSON'); }
      const result = await this.local(app.region, app.accountId, app.id, principal, true, action!, input); res.statusCode = result.status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result.body));
    } catch (error) { res.statusCode = error instanceof AwsError || error instanceof SearchError ? error.status : 500; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ message: error instanceof AwsError || error instanceof SearchError ? error.message : 'Application request failed' })); }
  }
}
