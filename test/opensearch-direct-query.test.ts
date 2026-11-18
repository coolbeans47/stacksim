import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SignatureV4 } from '@smithy/signature-v4';
import * as Os from '@aws-sdk/client-opensearch';
import * as Aoss from '@aws-sdk/client-opensearchserverless';
import * as Iam from '@aws-sdk/client-iam';
import * as Logs from '@aws-sdk/client-cloudwatch-logs';
import { StackSim } from '../src/server.js';
import { TestClock } from '../src/core/clock.js';

const region = 'eu-west-1', account = '000000000000', credentials = { accessKeyId: 'admin', secretAccessKey: 'password' }, group = '/direct/orders';
class Sha256 { private hash: any; constructor(secret?: any) { this.hash = secret ? createHmac('sha256', secret) : createHash('sha256'); } update(value: any) { this.hash.update(value); } async digest() { return this.hash.digest(); } }
const policy = (Statement: any[]) => JSON.stringify({ Version: '2012-10-17', Statement });
async function local(sim: StackSim, name: string, action: string, input: any, who = credentials) {
  const body = JSON.stringify(input), path = `/_stacksim/api/opensearch/direct-query/${name}/${action}`, host = `127.0.0.1:${sim.port}`;
  const signed = await new SignatureV4({ credentials: who, region, service: 'es', sha256: Sha256 }).sign({ hostname: '127.0.0.1', port: sim.port, protocol: 'http:', path, method: 'POST', headers: { host, 'content-type': 'application/json' }, body });
  return new Promise<{ status: number; body: any }>((resolve, reject) => { const req = request(`http://${host}${path}`, { method: 'POST', headers: signed.headers }, res => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') })); }); req.on('error', reject); req.end(body); });
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-direct-query-')), clock = new TestClock(Date.now()), options = { dataDir: root, region, clock, port: 0, invokePort: 0, authMode: 'enforce' as const, cdkBootstrap: false }, sim = new StackSim(options); await sim.start();
  const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }, os = new Os.OpenSearchClient(config), aoss = new Aoss.OpenSearchServerlessClient(config), iam = new Iam.IAMClient(config), logs = new Logs.CloudWatchLogsClient(config);
  await aoss.send(new Aoss.CreateSecurityPolicyCommand({ name: 'direct-encryption', type: 'encryption', policy: JSON.stringify({ Rules: [{ ResourceType: 'collection', Resource: ['collection/direct-results'] }], AWSOwnedKey: true }) }));
  const collection = (await aoss.send(new Aoss.CreateCollectionCommand({ name: 'direct-results', type: 'SEARCH' }))).createCollectionDetail!;
  for (let i = 0; i < 500 && sim.opensearch.serverless.state(region).collections[collection.id!]?.status !== 'ACTIVE'; i++) { clock.advance(25); await delay(2); }
  assert.equal(sim.opensearch.serverless.state(region).collections[collection.id!].status, 'ACTIVE');
  const trust = policy([{ Effect: 'Allow', Principal: { Service: 'directquery.opensearchservice.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'aws:SourceAccount': account }, ArnLike: { 'aws:SourceArn': `arn:aws:opensearch:${region}:${account}:datasource/*` } } }]);
  const role = (await iam.send(new Iam.CreateRoleCommand({ RoleName: 'DirectQueryLogs', AssumeRolePolicyDocument: trust }))).Role!;
  const grant = () => iam.send(new Iam.PutRolePolicyCommand({ RoleName: 'DirectQueryLogs', PolicyName: 'logs', PolicyDocument: policy([{ Effect: 'Allow', Action: 'logs:StartQuery', Resource: `arn:aws:logs:${region}:${account}:log-group:${group}:*`, Condition: { StringEquals: { 'aws:ResourceAccount': account, 'aws:ResourceTag/team': 'orders' } } }]) })); await grant();
  await logs.send(new Logs.CreateLogGroupCommand({ logGroupName: group, tags: { team: 'orders' } })); await logs.send(new Logs.CreateLogStreamCommand({ logGroupName: group, logStreamName: 'events' }));
  await logs.send(new Logs.PutLogEventsCommand({ logGroupName: group, logStreamName: 'events', logEvents: [{ timestamp: clock.now(), message: '{"duration":7}' }, { timestamp: clock.now(), message: '{"duration":9}' }] }));
  const source = { DataSourceName: 'orders_logs', DataSourceType: { CloudWatchLog: { RoleArn: role.Arn! } }, OpenSearchArns: [collection.arn!] }, query = { queryLanguage: 'SQL', queryString: `SELECT SUM(duration) AS total FROM \`${group}\``, startTime: Math.floor(clock.now() / 1000), endTime: Math.floor(clock.now() / 1000) };
  const finish = async (queryId: string, server = sim, name = source.DataSourceName, who = credentials) => { for (let i = 0; i < 400; i++) { clock.advance(25); await delay(2); const result = await local(server, name, 'get', { queryId }, who); assert.equal(result.status, 200, JSON.stringify(result.body)); if (!['Scheduled', 'Running'].includes(result.body.status)) return result.body; } assert.fail('Direct query did not finish'); };
  const close = async (server = sim) => { os.destroy(); aoss.destroy(); iam.destroy(); logs.destroy(); await server.stop(); await rm(root, { recursive: true, force: true }); };
  return { root, clock, sim, config, options, os, aoss, iam, logs, source, collection, query, trust, grant, finish, close };
}

test('Direct query SDK configuration, tags, actual Logs jobs, restart and deletion preserve source resources', { timeout: 60000 }, async () => {
  const h = await setup(); let sim = h.sim, os = h.os;
  try {
    const created = await os.send(new Os.AddDirectQueryDataSourceCommand({ ...h.source, Description: 'Order logs', TagList: [{ Key: 'team', Value: 'orders' }] })); assert.equal(created.DataSourceArn, `arn:aws:opensearch:${region}:${account}:datasource/orders_logs`);
    assert.deepEqual((await os.send(new Os.GetDirectQueryDataSourceCommand({ DataSourceName: h.source.DataSourceName }))).DataSourceType, h.source.DataSourceType);
    await os.send(new Os.AddTagsCommand({ ARN: created.DataSourceArn!, TagList: [{ Key: 'phase', Value: 'direct' }] })); await os.send(new Os.RemoveTagsCommand({ ARN: created.DataSourceArn!, TagKeys: ['team'] })); assert.deepEqual((await os.send(new Os.ListTagsCommand({ ARN: created.DataSourceArn! }))).TagList, [{ Key: 'phase', Value: 'direct' }]);
    const started = await local(sim, 'orders_logs', 'start', h.query); assert.equal(started.status, 200, JSON.stringify(started.body)); const queryId = started.body.queryId;
    assert.equal(sim.store.regionState(region).logQueryJobs[queryId].sourceOwner?.arn, created.DataSourceArn);
    await sim.stop(); sim = new StackSim(h.options); await sim.start(); os = new Os.OpenSearchClient({ ...h.config, endpoint: `http://127.0.0.1:${sim.port}` });
    const result = await h.finish(queryId, sim); assert.equal(result.status, 'Complete'); assert.deepEqual(result.results, [[{ field: 'total', value: '16' }]]);
    await os.send(new Os.UpdateDirectQueryDataSourceCommand({ ...h.source, Description: 'Updated' })); assert.equal((await os.send(new Os.ListDirectQueryDataSourcesCommand({}))).DirectQueryDataSources![0].Description, 'Updated');
    const pending = await local(sim, 'orders_logs', 'start', h.query); assert.equal(pending.status, 200);
    await os.send(new Os.DeleteDirectQueryDataSourceCommand({ DataSourceName: 'orders_logs' })); assert.equal(sim.store.regionState(region).logQueryJobs[pending.body.queryId].status, 'Cancelled');
    assert.equal((await local(sim, 'orders_logs', 'get', { queryId })).status, 404); assert.ok(sim.store.regionState(region).logs[group]); assert.equal(sim.opensearch.serverless.state(region).collections[h.collection.id!].status, 'ACTIVE');
    await os.send(new Os.AddDirectQueryDataSourceCommand(h.source)); assert.equal((await local(sim, 'orders_logs', 'get', { queryId })).status, 404, 'Replacement names cannot read prior-generation queries');
  } finally { os.destroy(); await h.close(sim); }
});

test('Direct queries independently enforce caller policy, creator ownership, role trust and current source permissions', { timeout: 60000 }, async () => {
  const h = await setup();
  try {
    const arn = (await h.os.send(new Os.AddDirectQueryDataSourceCommand(h.source))).DataSourceArn!;
    await h.iam.send(new Iam.CreateUserCommand({ UserName: 'DirectReader' })); const key = (await h.iam.send(new Iam.CreateAccessKeyCommand({ UserName: 'DirectReader' }))).AccessKey!, reader = { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! };
    await h.iam.send(new Iam.PutUserPolicyCommand({ UserName: 'DirectReader', PolicyName: 'query', PolicyDocument: policy([{ Effect: 'Allow', Action: ['opensearch:StartDirectQuery', 'opensearch:GetDirectQuery', 'opensearch:GetDirectQueryResult', 'opensearch:CancelDirectQuery'], Resource: arn }]) }));
    assert.equal((await local(h.sim, 'orders_logs', 'start', h.query, reader)).status, 403, 'IAM query permissions alone do not bypass creator ownership');
    const access = policy([{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${account}:user/DirectReader` }, Action: 'opensearch:*DirectQuery*', Resource: arn }]);
    await h.os.send(new Os.UpdateDirectQueryDataSourceCommand({ ...h.source, DataSourceAccessPolicy: access }));
    const start = await local(h.sim, 'orders_logs', 'start', h.query, reader); assert.equal(start.status, 200, JSON.stringify(start.body)); assert.equal((await h.finish(start.body.queryId, h.sim, 'orders_logs', reader)).status, 'Complete');
    assert.equal((await local(h.sim, 'orders_logs', 'get', { queryId: start.body.queryId })).status, 403, 'The explicit policy also governs the creator');
    const queued = await local(h.sim, 'orders_logs', 'start', h.query, reader); assert.equal(queued.status, 200);
    await h.iam.send(new Iam.DeleteRolePolicyCommand({ RoleName: 'DirectQueryLogs', PolicyName: 'logs' })); assert.equal((await local(h.sim, 'orders_logs', 'get', { queryId: start.body.queryId }, reader)).status, 403);
    for (let i = 0; i < 100 && h.sim.store.regionState(region).logQueryJobs[queued.body.queryId].status !== 'Failed'; i++) { h.clock.advance(25); await delay(2); }
    assert.equal(h.sim.store.regionState(region).logQueryJobs[queued.body.queryId].status, 'Failed'); assert.equal(h.sim.store.regionState(region).logQueryJobs[queued.body.queryId].statistics.recordsScanned, 0, 'Queued jobs recheck role permissions before reading log events');
    await h.grant();
    await h.iam.send(new Iam.UpdateAssumeRolePolicyCommand({ RoleName: 'DirectQueryLogs', PolicyDocument: policy([{ Effect: 'Deny', Principal: { Service: 'directquery.opensearchservice.amazonaws.com' }, Action: 'sts:AssumeRole' }]) })); assert.equal((await local(h.sim, 'orders_logs', 'start', h.query, reader)).status, 403);
    await h.os.send(new Os.DeleteDirectQueryDataSourceCommand({ DataSourceName: 'orders_logs' })); assert.ok(h.sim.store.regionState(region).logs[group], 'Cleanup works after role trust is revoked');
  } finally { await h.close(); }
});

test('Direct query admission is bounded and cannot adopt unrelated Logs query IDs', { timeout: 60000 }, async () => {
  const h = await setup();
  try {
    await h.os.send(new Os.AddDirectQueryDataSourceCommand(h.source));
    const ordinary = await h.logs.send(new Logs.StartQueryCommand({ ...h.query, queryLanguage: 'SQL' }));
    assert.equal((await local(h.sim, 'orders_logs', 'get', { queryId: ordinary.queryId })).status, 404);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) { const result = await local(h.sim, 'orders_logs', 'start', h.query); assert.equal(result.status, 200, JSON.stringify(result.body)); ids.push(result.body.queryId); }
    const limited = await local(h.sim, 'orders_logs', 'start', h.query); assert.equal(limited.status, 400); assert.match(JSON.stringify(limited.body), /30 concurrent/);
    await h.os.send(new Os.DeleteDirectQueryDataSourceCommand({ DataSourceName: 'orders_logs' }));
    for (const id of ids) assert.equal(h.sim.store.regionState(region).logQueryJobs[id].status, 'Cancelled');
    assert.equal(h.sim.store.regionState(region).logQueryJobs[ordinary.queryId!].status, 'Scheduled', 'Deletion cancels only jobs owned by this generation');
  } finally { await h.close(); }
});

test('Direct query validates dependencies, PassRole, pagination, publication rollback and source loss', { timeout: 60000 }, async () => {
  const h = await setup();
  try {
    await assert.rejects(h.os.send(new Os.AddDirectQueryDataSourceCommand({ ...h.source, DataSourceType: { SecurityLake: { RoleArn: h.source.DataSourceType.CloudWatchLog.RoleArn } } })), /CloudWatchLog/);
    await assert.rejects(h.os.send(new Os.AddDirectQueryDataSourceCommand({ ...h.source, OpenSearchArns: [] })), /associated collections/);
    await assert.rejects(h.os.send(new Os.AddDirectQueryDataSourceCommand({ ...h.source, DataSourceAccessPolicy: policy([{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::999999999999:root' }, Action: 'opensearch:*', Resource: '*' }]) })), /same-account/);
    await h.iam.send(new Iam.CreateUserCommand({ UserName: 'DirectCreator' })); const key = (await h.iam.send(new Iam.CreateAccessKeyCommand({ UserName: 'DirectCreator' }))).AccessKey!;
    await h.iam.send(new Iam.PutUserPolicyCommand({ UserName: 'DirectCreator', PolicyName: 'create', PolicyDocument: policy([{ Effect: 'Allow', Action: ['es:AddDirectQueryDataSource', 'aoss:BatchGetCollection'], Resource: '*' }]) }));
    const restricted = new Os.OpenSearchClient({ ...h.config, credentials: { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! } });
    try { await assert.rejects(restricted.send(new Os.AddDirectQueryDataSourceCommand(h.source)), /PassRole/); } finally { restricted.destroy(); }
    for (let i = 0; i < 11; i++) await h.os.send(new Os.AddDirectQueryDataSourceCommand({ ...h.source, DataSourceName: `source_${String(i).padStart(2, '0')}` }));
    const page = await h.os.send(new Os.ListDirectQueryDataSourcesCommand({})); assert.equal(page.DirectQueryDataSources!.length, 10); assert.ok(page.NextToken); assert.equal((await h.os.send(new Os.ListDirectQueryDataSourcesCommand({ NextToken: page.NextToken }))).DirectQueryDataSources!.length, 1);
    await h.os.send(new Os.UpdateDirectQueryDataSourceCommand({ ...h.source, DataSourceName: 'source_00', Description: 'changed' })); await assert.rejects(h.os.send(new Os.ListDirectQueryDataSourcesCommand({ NextToken: page.NextToken })), /stale/);
    await h.os.send(new Os.AddDirectQueryDataSourceCommand(h.source)); const before = structuredClone(h.sim.opensearch.directQueries.state(region).records.orders_logs), save = h.sim.store.save.bind(h.sim.store);
    h.sim.store.save = async () => { throw new Error('injected direct catalog failure'); };
    try { await assert.rejects(h.sim.opensearch.directQueries.execute('UpdateDirectQueryDataSource', { ...h.source, Description: 'not committed' }, region), /injected/); assert.deepEqual(h.sim.opensearch.directQueries.state(region).records.orders_logs, before); } finally { h.sim.store.save = save; }
    const ownSave = h.sim.store.save.bind(h.sim.store); h.sim.store.save = async () => { throw new Error('injected query publication failure'); };
    const count = Object.keys(h.sim.store.regionState(region).logQueryJobs).length;
    try { await assert.rejects(h.sim.logs.StartQuery(h.query), /injected/); assert.equal(Object.keys(h.sim.store.regionState(region).logQueryJobs).length, count); } finally { h.sim.store.save = ownSave; }
    await h.aoss.send(new Aoss.DeleteCollectionCommand({ id: h.collection.id! })); assert.equal((await local(h.sim, 'orders_logs', 'start', h.query)).status, 400);
  } finally { await h.close(); }
});
