import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { SignatureV4 } from '@smithy/signature-v4';
import { createHash, createHmac } from 'node:crypto';
import * as Os from '@aws-sdk/client-opensearch';
import * as Iam from '@aws-sdk/client-iam';
import * as Aoss from '@aws-sdk/client-opensearchserverless';
import { StackSim } from '../src/server.js';
import { TestClock } from '../src/core/clock.js';

class Sha256 {
  private hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  constructor(private readonly secret?: any) { this.hash = secret ? createHmac('sha256', secret) : createHash('sha256'); }
  update(data: any) { this.hash.update(data); }
  async digest() { return this.hash.digest(); }
  reset() { this.hash = this.secret ? createHmac('sha256', this.secret) : createHash('sha256'); }
}

const region = 'eu-west-1', credentials = { accessKeyId: 'admin', secretAccessKey: 'password' }, adminConfig = [{ key: 'opensearchDashboards.dashboardAdmin.users', value: '*' }];
const policy = (Statement: any[]) => JSON.stringify({ Version: '2012-10-17', Statement });
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 400; i++) { if (await check()) return; await delay(10); } assert.fail('Application did not reach expected state'); }
async function signed(endpoint: string, path: string, method: string, input?: any, options: { ca?: Buffer; credentials?: typeof credentials; service?: string } = {}) {
  const url = new URL(path, endpoint), body = input === undefined ? undefined : Buffer.from(JSON.stringify(input));
  const request = await new SignatureV4({ credentials: options.credentials ?? credentials, region, service: options.service ?? 'opensearch', sha256: Sha256 }).sign({ hostname: url.hostname, port: Number(url.port), protocol: url.protocol, path: url.pathname, method, headers: { host: url.host, ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}) }, body });
  return new Promise<{ status: number; body: any; headers: any }>((resolve, reject) => { const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers: request.headers, ca: options.ca }, res => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const value = Buffer.concat(chunks).toString(); let body: any; try { body = value ? JSON.parse(value) : {}; } catch { body = value; } resolve({ status: res.statusCode!, body, headers: res.headers }); }); }); req.on('error', reject); req.end(body); });
}

test('Application SDK lifecycle, shared workspaces, live source authorization, TLS signing, encrypted restart and deletion', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-applications-')), options = { dataDir: root, region, port: 0, invokePort: 0, authMode: 'enforce' as const, cdkBootstrap: false };
  let sim = new StackSim(options), os: Os.OpenSearchClient, iam: Iam.IAMClient;
  const connect = () => { const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; os = new Os.OpenSearchClient(config); iam = new Iam.IAMClient(config); };
  try {
    await sim.start(); connect();
    await os!.send(new Os.CreateDomainCommand({ DomainName: 'app-source' })); await until(() => sim.opensearch.domain(region, 'app-source').state === 'active');
    const domain = sim.opensearch.domain(region, 'app-source'), source = domain.arn;
    const created = await os!.send(new Os.CreateApplicationCommand({ name: 'catalog-app', appConfigs: adminConfig as any, clientToken: 'create-once', tagList: [{ Key: 'team', Value: 'catalog' }] }));
    const id = created.id!, arn = created.arn!; assert.match(arn, /:opensearch:eu-west-1:000000000000:application\/[a-f0-9]{24}$/); assert.ok(created.createdAt instanceof Date);
    assert.equal((await os!.send(new Os.CreateApplicationCommand({ name: 'catalog-app', appConfigs: adminConfig as any, clientToken: 'create-once', tagList: [{ Key: 'team', Value: 'catalog' }] }))).id, id);
    await assert.rejects(os!.send(new Os.CreateApplicationCommand({ name: 'changed-app', clientToken: 'create-once' })), /reused/);
    await until(() => sim.opensearch.applications.application(region, id).status === 'ACTIVE');
    const attached = await os!.send(new Os.AttachDataSourceCommand({ id, dataSourceArn: source, workspaceConfiguration: { name: 'Catalog', workspaceType: 'SEARCH' } as any, clientToken: 'attach-once' })); assert.equal(attached.status, 'ATTACHED');
    assert.equal((await os!.send(new Os.AttachDataSourceCommand({ id, dataSourceArn: source }))).attachmentId, attached.attachmentId);
    await assert.rejects(os!.send(new Os.AttachDataSourceCommand({ id, dataSourceArn: source, workspaceId: 'different', clientToken: 'attach-once' })), /reused/);
    assert.equal((await os!.send(new Os.DescribeDataSourceAttachmentCommand({ id, dataSourceArn: source }))).status, 'ATTACHED');
    assert.equal((await os!.send(new Os.ListDataSourceAttachmentsCommand({ id }))).attachments!.length, 1);
    const app = await os!.send(new Os.GetApplicationCommand({ id })), endpoint = app.endpoint!, ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath!);
    const call = (path: string, method = 'GET', body?: any, who = credentials, service = 'opensearch') => signed(endpoint, path, method, body, { ca, credentials: who, service });
    assert.equal((await call('/')).status, 302); assert.equal((await call('/')).headers.location, '/app/workspace_initial'); assert.equal((await call('/', 'GET', undefined, credentials, 'es')).status, 403);
    const context = (await call('/_stacksim/application/context')).body; assert.equal(context.administrator, true); const workspace = context.workspaces[0].id;
    const query = (method: string, path: string, body?: any, who = credentials) => call('/_stacksim/application/query', 'POST', { workspaceId: workspace, dataSourceArn: source, method, path, body }, who);
    assert.equal((await query('PUT', '/products/_doc/one?refresh=true', { title: 'Application product' })).status, 201);
    assert.equal((await query('GET', '/products/_search')).body.hits.hits[0]._source.title, 'Application product');
    const view = await query('PUT', '/_stacksim/workspace', { type: 'data-view', title: 'encrypted-app-view', pattern: 'products' }); assert.equal(view.status, 200);
    await os!.send(new Os.PutDefaultApplicationSettingCommand({ applicationArn: arn, setAsDefault: true })); assert.equal((await os!.send(new Os.GetDefaultApplicationSettingCommand({}))).applicationArn, arn);
    await os!.send(new Os.AddTagsCommand({ ARN: arn, TagList: [{ Key: 'phase', Value: 'applications' }] })); await os!.send(new Os.RemoveTagsCommand({ ARN: arn, TagKeys: ['team'] })); assert.deepEqual((await os!.send(new Os.ListTagsCommand({ ARN: arn }))).TagList, [{ Key: 'phase', Value: 'applications' }]);
    await iam!.send(new Iam.CreateUserCommand({ UserName: 'ApplicationReader' })); const key = (await iam!.send(new Iam.CreateAccessKeyCommand({ UserName: 'ApplicationReader' }))).AccessKey!, reader = { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! };
    const grant = async (statements: any[]) => iam!.send(new Iam.PutUserPolicyCommand({ UserName: 'ApplicationReader', PolicyName: 'app', PolicyDocument: policy(statements) }));
    await grant([{ Effect: 'Allow', Action: 'opensearch:ApplicationAccessAll', Resource: arn }]); assert.equal((await query('GET', '/products/_search', undefined, reader)).status, 403);
    assert.equal((await query('GET', '/_stacksim/workspace', undefined, reader)).body.objects[0].title, 'encrypted-app-view', 'Shared saved objects do not grant source data access');
    await grant([{ Effect: 'Allow', Action: 'opensearch:ApplicationAccessAll', Resource: arn }, { Effect: 'Allow', Action: 'es:ESHttpGet', Resource: `${source}/products/*` }]);
    assert.equal((await query('GET', '/products/_search', undefined, reader)).status, 200); assert.equal((await query('DELETE', '/products/_doc/one', undefined, reader)).status, 403);
    await os!.send(new Os.UpdateApplicationCommand({ id, appConfigs: [] })); await until(() => sim.opensearch.applications.application(region, id).status === 'ACTIVE');
    assert.equal((await query('PUT', '/_stacksim/workspace', { type: 'data-view', title: 'forbidden', pattern: '*' }, reader)).status, 403);
    await os!.send(new Os.UpdateApplicationCommand({ id, appConfigs: adminConfig as any })); await until(() => sim.opensearch.applications.application(region, id).status === 'ACTIVE');
    const saved = sim.store.save.bind(sim.store); sim.store.save = async () => { throw new Error('injected catalog failure'); };
    try { await assert.rejects(sim.opensearch.applications.execute('DetachDataSource', { id, dataSourceArn: source }, region), /injected/); await assert.rejects(sim.opensearch.applications.execute('PutDefaultApplicationSetting', { applicationArn: arn, setAsDefault: false }, region), /injected/); assert.equal(sim.opensearch.applications.state(region).defaultArn, arn); } finally { sim.store.save = saved; }
    await os!.send(new Os.PutDefaultApplicationSettingCommand({ applicationArn: arn, setAsDefault: false })); sim.store.save = async () => { throw new Error('injected default-setting failure'); };
    try { await assert.rejects(sim.opensearch.applications.execute('PutDefaultApplicationSetting', { applicationArn: arn, setAsDefault: true }, region), /injected/); assert.equal(sim.opensearch.applications.state(region).defaultArn, undefined); } finally { sim.store.save = saved; }
    await os!.send(new Os.PutDefaultApplicationSettingCommand({ applicationArn: arn, setAsDefault: true }));
    assert.equal((await query('GET', '/products/_search')).status, 200);
    os!.destroy(); iam!.destroy(); await sim.stop(); sim = new StackSim(options); await sim.start(); connect();
    assert.equal((await query('GET', '/_stacksim/workspace')).body.objects[0].id, view.body.object.id); assert.equal((await query('GET', '/products/_search')).body.hits.hits.length, 1);
    const walk = async (directory: string): Promise<void> => { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = join(directory, entry.name); if (entry.isDirectory()) await walk(file); else assert.equal((await readFile(file)).includes(Buffer.from('encrypted-app-view')), false); } }; await walk(join(root, 'data', 'opensearch-applications'));
    await os!.send(new Os.DetachDataSourceCommand({ id, dataSourceArn: source })); assert.equal((await query('GET', '/products/_search')).status, 403);
    await os!.send(new Os.AttachDataSourceCommand({ id, dataSourceArn: source, workspaceId: workspace })); assert.equal((await query('GET', '/products/_search')).status, 200);
    await os!.send(new Os.DeleteApplicationCommand({ id })); await until(() => !sim.opensearch.applications.state(region).records[id]); assert.equal((await os!.send(new Os.GetDefaultApplicationSettingCommand({}))).applicationArn, undefined);
    assert.equal(sim.opensearch.domain(region, 'app-source').state, 'active'); await assert.rejects(call('/'));
    const replacement = await os!.send(new Os.CreateApplicationCommand({ name: 'catalog-app' })); await until(() => sim.opensearch.applications.application(region, replacement.id!).status === 'ACTIVE'); assert.notEqual((await os!.send(new Os.GetApplicationCommand({ id: replacement.id }))).endpoint, endpoint);
    await assert.rejects(os!.send(new Os.CreateApplicationCommand({ name: 'identity-app', iamIdentityCenterOptions: { enabled: true } })), /Identity Center/);
    await assert.rejects(os!.send(new Os.CreateApplicationCommand({ name: 'bad-source', dataSources: [{ dataSourceArn: source.replace(region, 'us-east-1') }] })), /same-account/);
  } finally { os!?.destroy(); iam!?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test('Application collection service network is isolated from public ingress and retains IAM/data-policy enforcement', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-app-collection-')), sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'enforce' });
  let os: Os.OpenSearchClient, aoss: Aoss.OpenSearchServerlessClient;
  try {
    await sim.start(); const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; os = new Os.OpenSearchClient(config); aoss = new Aoss.OpenSearchServerlessClient(config);
    await aoss.send(new Aoss.CreateSecurityPolicyCommand({ name: 'app-encryption', type: 'encryption', policy: JSON.stringify({ Rules: [{ ResourceType: 'collection', Resource: ['collection/app-data'] }], AWSOwnedKey: true }) }));
    await aoss.send(new Aoss.CreateSecurityPolicyCommand({ name: 'app-network', type: 'network', policy: JSON.stringify([{ Rules: [{ ResourceType: 'collection', Resource: ['collection/app-data'] }], AllowFromPublic: false, SourceServices: ['application.opensearchservice.amazonaws.com'] }]) }));
    const collectionId = (await aoss.send(new Aoss.CreateCollectionCommand({ name: 'app-data', type: 'SEARCH', standbyReplicas: 'DISABLED' }))).createCollectionDetail!.id!; await until(() => sim.opensearch.serverless.collection(region, collectionId).status === 'ACTIVE'); const collection = sim.opensearch.serverless.collection(region, collectionId);
    const id = (await os.send(new Os.CreateApplicationCommand({ name: 'collection-app', dataSources: [{ dataSourceArn: collection.arn }], appConfigs: adminConfig as any }))).id!; await until(() => sim.opensearch.applications.application(region, id).status === 'ACTIVE');
    await assert.rejects(os.send(new Os.AttachDataSourceCommand({ id, dataSourceArn: collection.arn })), /managed domain/);
    const ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath!), endpoint = (await os.send(new Os.GetApplicationCommand({ id }))).endpoint!;
    const workspace = await signed(endpoint, '/_stacksim/application/workspaces', 'POST', { name: 'Collection search', workspaceType: 'SEARCH', dataSourceArns: [collection.arn] }, { ca }); assert.equal(workspace.status, 201);
    const query = (method: string, path: string, body?: any) => signed(endpoint, '/_stacksim/application/query', 'POST', { workspaceId: workspace.body.id, dataSourceArn: collection.arn, method, path, body }, { ca });
    assert.equal((await query('PUT', '/products/_doc/one', { title: 'private collection' })).status, 403);
    const admin = Object.values(sim.store.ensureAccount().iam.users)[0];
    await aoss.send(new Aoss.CreateAccessPolicyCommand({ name: 'app-data', type: 'data', policy: JSON.stringify([{ Rules: [{ ResourceType: 'index', Resource: ['index/app-data/*'], Permission: ['aoss:*'] }], Principal: [admin.arn] }]) }));
    assert.equal((await query('PUT', '/products/_doc/one', { title: 'private collection' })).status, 201);
    assert.equal((await query('GET', '/products/_doc/one')).body._source.title, 'private collection');
    const publicRequest = await signed(`https://127.0.0.1:${collection.gatewayPort}`, '/products/_doc/one', 'GET', undefined, { ca, service: 'aoss' }); assert.equal(publicRequest.status, 403);
    await aoss.send(new Aoss.DeleteAccessPolicyCommand({ name: 'app-data', type: 'data' })); assert.equal((await query('GET', '/products/_doc/one')).status, 403);
    await aoss.send(new Aoss.DeleteCollectionCommand({ id: collectionId })); await until(() => !sim.opensearch.serverless.state(region).collections[collectionId]); assert.equal((await query('GET', '/products/_doc/one')).status, 400);
  } finally { os!?.destroy(); aoss!?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test('Application scopes control authorization, rejects stale generations and preserves domain document/field security', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-app-security-')), options = { dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'enforce' as const }; let sim = new StackSim(options), os: Os.OpenSearchClient, iam: Iam.IAMClient, limited: Os.OpenSearchClient;
  try {
    await sim.start(); const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; os = new Os.OpenSearchClient(config); iam = new Iam.IAMClient(config); const adminArn = Object.values(sim.store.ensureAccount().iam.users)[0].arn;
    await os.send(new Os.CreateDomainCommand({ DomainName: 'secured-source', EncryptionAtRestOptions: { Enabled: true }, NodeToNodeEncryptionOptions: { Enabled: true }, DomainEndpointOptions: { EnforceHTTPS: true }, AdvancedSecurityOptions: { Enabled: true, MasterUserOptions: { MasterUserARN: adminArn } } })); await until(() => sim.opensearch.domain(region, 'secured-source').state === 'active'); const source = sim.opensearch.domain(region, 'secured-source').arn;
    const app = await os.send(new Os.CreateApplicationCommand({ name: 'security-app', appConfigs: adminConfig as any, tagList: [{ Key: 'team', Value: 'search' }] })); await until(() => sim.opensearch.applications.application(region, app.id!).status === 'ACTIVE');
    await os.send(new Os.AttachDataSourceCommand({ id: app.id, dataSourceArn: source, workspaceConfiguration: { name: 'Secured', workspaceType: 'SEARCH' } as any }));
    const record = sim.opensearch.applications.application(region, app.id!), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath!), endpoint = `https://127.0.0.1:${record.gatewayPort}`;
    const query = (method: string, path: string, body?: any, caller = credentials) => signed(endpoint, '/_stacksim/application/query', 'POST', { workspaceId: record.workspaces[0].id, dataSourceArn: source, method, path, body }, { ca, credentials: caller });
    assert.equal((await query('PUT', '/products/_doc/one?refresh=true', { tenant: 'one', title: 'visible', secret: 'hidden' })).status, 201); await query('PUT', '/products/_doc/two?refresh=true', { tenant: 'two', title: 'other' });
    const user = (await iam.send(new Iam.CreateUserCommand({ UserName: 'AppScoped' }))).User!; const key = (await iam.send(new Iam.CreateAccessKeyCommand({ UserName: 'AppScoped' }))).AccessKey!, reader = { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! };
    await iam.send(new Iam.PutUserPolicyCommand({ UserName: 'AppScoped', PolicyName: 'scope', PolicyDocument: policy([{ Effect: 'Allow', Action: ['es:GetApplication', 'es:AddTags', 'opensearch:ApplicationAccessAll'], Resource: app.arn, Condition: { StringEquals: { 'aws:ResourceTag/team': 'search' } } }, { Effect: 'Allow', Action: 'es:ESHttp*', Resource: `${source}/*` }]) }));
    limited = new Os.OpenSearchClient({ ...config, credentials: reader }); assert.equal((await limited.send(new Os.GetApplicationCommand({ id: app.id }))).id, app.id); await assert.rejects(limited.send(new Os.DeleteApplicationCommand({ id: app.id })), /not authorized/);
    assert.equal((await query('GET', '/products/_search', undefined, reader)).status, 403);
    assert.equal((await query('PUT', '/_plugins/_security/api/roles/tenant', { index_permissions: [{ index_patterns: ['products'], allowed_actions: ['read'], dls: '{"term":{"tenant.keyword":"one"}}', fls: ['title'] }] })).status, 200);
    assert.equal((await query('PUT', '/_plugins/_security/api/rolesmapping/tenant', { users: [user.Arn] })).status, 200);
    const filtered = await query('GET', '/products/_search', undefined, reader); assert.equal(filtered.status, 200); assert.deepEqual(filtered.body.hits.hits.map((hit: any) => hit._source), [{ title: 'visible' }]);
    await query('DELETE', '/_plugins/_security/api/rolesmapping/tenant'); assert.equal((await query('GET', '/products/_search', undefined, reader)).status, 403);
    await os.send(new Os.AddTagsCommand({ ARN: app.arn, TagList: [{ Key: 'team', Value: 'elsewhere' }] })); await assert.rejects(limited.send(new Os.GetApplicationCommand({ id: app.id })), /not authorized/); assert.equal((await query('GET', '/_stacksim/workspace', undefined, reader)).status, 403);
    const second = await os.send(new Os.CreateApplicationCommand({ name: 'second-app' })); await until(() => sim.opensearch.applications.application(region, second.id!).status === 'ACTIVE');
    const page = await os.send(new Os.ListApplicationsCommand({ maxResults: 1 })); assert.ok(page.nextToken); assert.equal((await os.send(new Os.ListApplicationsCommand({ maxResults: 1, nextToken: page.nextToken }))).ApplicationSummaries!.length, 1); await assert.rejects(os.send(new Os.ListApplicationsCommand({ nextToken: page.nextToken + '.' })), /pagination/);
    await os.send(new Os.UpdateApplicationCommand({ id: second.id, appConfigs: adminConfig as any })); await until(() => sim.opensearch.applications.application(region, second.id!).status === 'ACTIVE'); await assert.rejects(os.send(new Os.ListApplicationsCommand({ nextToken: page.nextToken })), /pagination/);
    await os.send(new Os.DeleteDomainCommand({ DomainName: 'secured-source' })); await until(() => !sim.opensearch.domains(region).length); await os.send(new Os.CreateDomainCommand({ DomainName: 'secured-source' })); await until(() => sim.opensearch.domain(region, 'secured-source').state === 'active'); assert.equal((await query('GET', '/products/_search')).status, 409);
    await os.send(new Os.UpdateApplicationCommand({ id: app.id, dataSources: [{ dataSourceArn: source }] })); await until(() => sim.opensearch.applications.application(region, app.id!).status === 'ACTIVE'); assert.equal((await os.send(new Os.ListDataSourceAttachmentsCommand({ id: app.id }))).attachments!.length, 0); assert.equal((await query('GET', '/_stacksim/workspace')).body.objects.length, 0, 'Replacement source does not inherit shared saved objects from its predecessor');
    os.destroy(); iam.destroy(); limited.destroy(); await sim.stop(); await rm(join(root, 'secrets', 'opensearch-applications', `${record.generation}.key`)); sim = new StackSim(options); await sim.start(); assert.equal(sim.opensearch.applications.application(region, app.id!).status, 'FAILED');
  } finally { os!?.destroy(); iam!?.destroy(); limited!?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test('Pending domain attachment creates usable workspace links only after source activation and fails after source loss', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-app-pending-')), clock = new TestClock(Date.now()), sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'enforce', clock }); let os: Os.OpenSearchClient; let release = () => {}, releaseSecond = () => {};
  try {
    await sim.start(); os = new Os.OpenSearchClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 });
    const service = sim.opensearch as any, activate = service.activate.bind(service), gate = new Promise<void>(resolve => { release = resolve; }); service.activate = async (domain: any) => { await gate; await activate(domain); };
    await os.send(new Os.CreateDomainCommand({ DomainName: 'pending-source' })); const source = sim.opensearch.domain(region, 'pending-source').arn;
    const app = await os.send(new Os.CreateApplicationCommand({ name: 'pending-app', appConfigs: adminConfig as any })); await until(() => sim.opensearch.applications.application(region, app.id!).status === 'ACTIVE');
    const attached = await os.send(new Os.AttachDataSourceCommand({ id: app.id, dataSourceArn: source, workspaceConfiguration: { name: 'Pending workspace', workspaceType: 'SEARCH' } as any })); assert.equal(attached.status, 'PENDING'); assert.deepEqual(sim.opensearch.applications.application(region, app.id!).workspaces[0].sources, []);
    release(); await until(() => sim.opensearch.domain(region, 'pending-source').state === 'active'); await until(() => { clock.advance(1000); return sim.opensearch.applications.application(region, app.id!).attachments[0].status === 'ATTACHED'; }); assert.deepEqual(sim.opensearch.applications.application(region, app.id!).workspaces[0].sources, [source]);
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; }); service.activate = async (domain: any) => { await secondGate; await activate(domain); };
    await os.send(new Os.CreateDomainCommand({ DomainName: 'removed-pending' })); const second = sim.opensearch.domain(region, 'removed-pending'); await os.send(new Os.AttachDataSourceCommand({ id: app.id, dataSourceArn: second.arn }));
    releaseSecond(); await until(() => sim.opensearch.domain(region, 'removed-pending').state === 'active');
    // Keep the polling clock still while the newly active source is deleted.
    await os.send(new Os.DeleteDomainCommand({ DomainName: 'removed-pending' })); await until(() => { clock.advance(1000); return sim.opensearch.applications.application(region, app.id!).attachments.find(item => item.dataSourceArn === second.arn)!.status === 'FAILED'; });
  } finally { release(); releaseSecond(); os!?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
