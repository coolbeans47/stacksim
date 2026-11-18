import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as Os from '@aws-sdk/client-opensearch';
import * as Legacy from '@aws-sdk/client-elasticsearch-service';
import * as Iam from '@aws-sdk/client-iam';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { StackSim } from '../src/server.js';
const region = 'eu-west-1', account = '000000000000', credentials = { accessKeyId: 'admin', secretAccessKey: 'password' };
const policy = (Statement: any[]) => JSON.stringify({ Version: '2012-10-17', Statement });
const arn = (name: string) => `arn:aws:es:${region}:${account}:domain/${name}`;
async function until(check: () => boolean) { for (let i = 0; i < 300; i++) { if (check()) return; await delay(10); } assert.fail('Domain did not become ready'); }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-connections-')), options = { dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'enforce' as const }, sim = new StackSim(options); await sim.start();
  const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }, os = new Os.OpenSearchClient(config), iam = new Iam.IAMClient(config), legacy = new Legacy.ElasticsearchServiceClient(config), clients: Client[] = [], ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath);
  const create = async (name: string) => { await os.send(new Os.CreateDomainCommand({ DomainName: name, EncryptionAtRestOptions: { Enabled: true }, NodeToNodeEncryptionOptions: { Enabled: true }, AdvancedSecurityOptions: { Enabled: true, MasterUserOptions: { MasterUserARN: `arn:aws:iam::${account}:user/admin` } }, AccessPolicies: policy([{ Effect: 'Allow', Principal: '*', Action: 'es:ESCrossClusterGet', Resource: arn(name) }]) })); await until(() => sim.opensearch.domain(region, name).state === 'active'); return client(name); };
  const client = (name: string, who = credentials, server = sim) => { const value = new Client({ node: `https://127.0.0.1:${server.opensearch.domain(region, name, account).gatewayPort}`, ssl: { ca }, maxRetries: 0, ...AwsSigv4Signer({ region, service: 'es', getCredentials: async () => who }) }); clients.push(value); return value as any; };
  const source = await create('cc-source'), remote = await create('cc-remote');
  const connection = { LocalDomainInfo: { AWSDomainInformation: { DomainName: 'cc-source' } }, RemoteDomainInfo: { AWSDomainInformation: { DomainName: 'cc-remote' } }, ConnectionAlias: 'remote' };
  const connect = async (skipUnavailable = false) => { const value = await os.send(new Os.CreateOutboundConnectionCommand({ ...connection, ConnectionProperties: { CrossClusterSearch: { SkipUnavailable: skipUnavailable ? 'ENABLED' : 'DISABLED' } } })); await os.send(new Os.AcceptInboundConnectionCommand({ ConnectionId: value.ConnectionId })); return value.ConnectionId!; };
  const close = async (server = sim) => { os.destroy(); iam.destroy(); legacy.destroy(); await Promise.all(clients.map(client => client.close())); await server.stop(); await rm(root, { recursive: true, force: true }); };
  return { sim, root, options, config, os, iam, legacy, source, remote, create, client, connection, connect, close };
}

test('Connections execute combined global queries and aggregations, survive restart, and revoke reads on deletion', { timeout: 60000 }, async () => {
  const h = await setup(); let sim = h.sim;
  try {
    for (const client of [h.source, h.remote]) await client.indices.create({ index: 'orders', body: { settings: { knn: true }, mappings: { properties: { price: { type: 'integer' }, category: { type: 'keyword' }, vector: { type: 'knn_vector', dimension: 2 } } } } });
    for (const [client, values] of [[h.source, [3, 9]], [h.remote, [5, 11]]] as const) for (const price of values) await client.index({ index: 'orders', id: String(price), body: { price, category: 'all', vector: [price, 0] }, refresh: true });
    const pending = await h.os.send(new Os.CreateOutboundConnectionCommand(h.connection)); assert.equal(pending.ConnectionStatus?.StatusCode, 'PENDING_ACCEPTANCE');
    await assert.rejects(h.source.search({ index: 'remote:orders' }), (error: any) => error.statusCode === 404);
    await assert.rejects(h.os.send(new Os.DeleteDomainCommand({ DomainName: 'cc-source' })), /Delete inbound and outbound/);
    assert.equal((await h.os.send(new Os.AcceptInboundConnectionCommand({ ConnectionId: pending.ConnectionId }))).Connection?.ConnectionStatus?.StatusCode, 'ACTIVE');
    const result = (await h.source.search({ index: 'orders,remote:orders', body: { size: 2, from: 1, sort: [{ price: 'desc' }], aggs: { total: { sum: { field: 'price' } }, groups: { terms: { field: 'category' } } } } })).body;
    assert.equal(result.hits.total.value, 4); assert.deepEqual(result.hits.hits.map((hit: any) => [hit._index, hit._source.price]), [['orders', 9], ['remote:orders', 5]]); assert.equal(result.aggregations.total.value, 28); assert.equal(result.aggregations.groups.buckets[0].doc_count, 4); assert.deepEqual(result._clusters, { total: 2, successful: 2, skipped: 0 });
    const vector = (await h.source.search({ index: 'orders,remote:orders', body: { query: { knn: { vector: { vector: [10, 0], k: 2 } } } } })).body; assert.deepEqual(vector.hits.hits.map((hit: any) => hit._source.price).sort((a: number, b: number) => a - b), [9, 11]);
    await assert.rejects(h.source.index({ index: 'remote:orders', id: 'bad', body: { price: 999 } }), (error: any) => error.statusCode === 400);
    await assert.rejects(h.source.search({ index: 'remote:orders', scroll: '1m' }), /PIT, scroll/);
    await sim.stop(); sim = new StackSim(h.options); await sim.start(); const source = h.client('cc-source', credentials, sim), os = new Os.OpenSearchClient({ ...h.config, endpoint: `http://127.0.0.1:${sim.port}` });
    try { assert.equal((await source.search({ index: 'remote:orders' })).body.hits.total.value, 2); await os.send(new Os.DeleteInboundConnectionCommand({ ConnectionId: pending.ConnectionId })); await assert.rejects(source.search({ index: 'remote:orders' }), (error: any) => error.statusCode === 404); assert.equal((await os.send(new Os.DescribeOutboundConnectionsCommand({}))).Connections![0].ConnectionStatus?.StatusCode, 'DELETED'); assert.equal((await h.client('cc-remote', credentials, sim).search({ index: 'orders' })).body.hits.total.value, 2); } finally { os.destroy(); }
  } finally { await h.close(sim); }
});

test('Cross-cluster authorization requires destination policy, current FGAC shard/search grants and DLS/FLS before aggregation', { timeout: 60000 }, async () => {
  const h = await setup();
  try {
    await h.connect(true); await h.remote.indices.create({ index: 'orders', body: { mappings: { properties: { tenant: { type: 'keyword' }, price: { type: 'integer' }, secret: { type: 'keyword' } } } } });
    for (const [tenant, price] of [['a', 7], ['b', 90]]) await h.remote.index({ index: 'orders', id: String(tenant), body: { tenant, price, secret: 'hidden' }, refresh: true });
    await h.iam.send(new Iam.CreateUserCommand({ UserName: 'cc-reader' })); const key = (await h.iam.send(new Iam.CreateAccessKeyCommand({ UserName: 'cc-reader' }))).AccessKey!, who = { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! }, reader = h.client('cc-source', who);
    await h.iam.send(new Iam.PutUserPolicyCommand({ UserName: 'cc-reader', PolicyName: 'source', PolicyDocument: policy([{ Effect: 'Allow', Action: ['es:ESHttpGet', 'es:ESHttpPost'], Resource: `${arn('cc-source')}/*` }, { Effect: 'Allow', Action: 'es:ESCrossClusterGet', Resource: arn('cc-remote') }]) }));
    const putRole = (shards: boolean) => h.remote.transport.request({ method: 'PUT', path: '/_plugins/_security/api/roles/cc-reader', body: { index_permissions: [{ index_patterns: ['orders'], allowed_actions: ['read', ...(shards ? ['indices:admin/shards/search_shards'] : [])], dls: JSON.stringify({ term: { tenant: 'a' } }), fls: ['tenant', 'price'] }] } });
    await putRole(false); await h.remote.transport.request({ method: 'PUT', path: '/_plugins/_security/api/rolesmapping/cc-reader', body: { users: [`arn:aws:iam::${account}:user/cc-reader`] } });
    await assert.rejects(reader.search({ index: 'remote:orders' }), /search_shards/); await putRole(true);
    const result = (await reader.search({ index: 'remote:orders', body: { aggs: { total: { sum: { field: 'price' } }, secrets: { terms: { field: 'secret' } } } } })).body;
    assert.equal(result.hits.total.value, 1); assert.equal(result.aggregations.total.value, 7); assert.deepEqual(result.aggregations.secrets.buckets, []); assert.deepEqual(result.hits.hits[0]._source, { tenant: 'a', price: 7 });
    await assert.rejects(reader.search({ index: 'orders,remote:orders' }), (error: any) => error.statusCode === 403);
    await h.remote.transport.request({ method: 'DELETE', path: '/_plugins/_security/api/rolesmapping/cc-reader' }); await assert.rejects(reader.search({ index: 'remote:orders' }), (error: any) => error.statusCode === 403);
    await h.os.send(new Os.UpdateDomainConfigCommand({ DomainName: 'cc-remote', AccessPolicies: policy([{ Effect: 'Allow', Principal: '*', Action: 'es:ESCrossClusterGet', Resource: `${arn('cc-remote')}/*` }]) }));
    await assert.rejects(h.source.search({ index: 'remote:orders' }), /Destination policy/);
    const domain = h.sim.opensearch.domain(region, 'cc-remote'); domain.config.AccessPolicies = policy([{ Effect: 'Allow', Principal: '*', Action: 'es:ESCrossClusterGet', Resource: domain.arn }]);
    (h.sim.opensearch as any).storageTransitions.add(domain.generation);
    try { const skipped = (await h.source.search({ index: 'remote:orders' })).body; assert.deepEqual(skipped._clusters, { total: 1, successful: 0, skipped: 1 }); assert.equal(skipped.hits.total.value, 0); }
    finally { (h.sim.opensearch as any).storageTransitions.delete(domain.generation); }
  } finally { await h.close(); }
});

test('Connection validation, HMAC pagination, publication rollback, rejection and legacy views share one durable record', { timeout: 60000 }, async () => {
  const h = await setup();
  try {
    await assert.rejects(h.os.send(new Os.CreateOutboundConnectionCommand({ ...h.connection, ConnectionMode: 'VPC_ENDPOINT' })), /DIRECT/);
    await assert.rejects(h.os.send(new Os.CreateOutboundConnectionCommand({ ...h.connection, RemoteDomainInfo: h.connection.LocalDomainInfo })), /distinct/);
    await h.os.send(new Os.CreateDomainCommand({ DomainName: 'cc-unsecured' })); await until(() => h.sim.opensearch.domain(region, 'cc-unsecured').state === 'active');
    await assert.rejects(h.os.send(new Os.CreateOutboundConnectionCommand({ ...h.connection, RemoteDomainInfo: { AWSDomainInformation: { DomainName: 'cc-unsecured' } } })), /fine-grained/);
    const connection = await h.legacy.send(new Legacy.CreateOutboundCrossClusterSearchConnectionCommand({ SourceDomainInfo: { DomainName: 'cc-source' }, DestinationDomainInfo: { DomainName: 'cc-remote' }, ConnectionAlias: 'remote' })); const id = connection.CrossClusterSearchConnectionId!; assert.equal(connection.SourceDomainInfo?.DomainName, 'cc-source'); assert.equal(connection.DestinationDomainInfo?.DomainName, 'cc-remote');
    assert.equal((await h.legacy.send(new Legacy.DescribeInboundCrossClusterSearchConnectionsCommand({ Filters: [{ Name: 'source-domain-info.domain-name', Values: ['cc-source'] }] }))).CrossClusterSearchConnections![0].CrossClusterSearchConnectionId, id);
    const save = h.sim.store.save.bind(h.sim.store); h.sim.store.save = async () => { throw new Error('injected commit failure'); };
    try { await assert.rejects(h.sim.opensearch.connections.execute('AcceptInboundConnection', { ConnectionId: id }, region, account), /commit failure/); } finally { h.sim.store.save = save; }
    assert.equal((await h.os.send(new Os.DescribeOutboundConnectionsCommand({}))).Connections![0].ConnectionStatus?.StatusCode, 'PENDING_ACCEPTANCE');
    await h.legacy.send(new Legacy.RejectInboundCrossClusterSearchConnectionCommand({ CrossClusterSearchConnectionId: id }));
    await assert.rejects(h.legacy.send(new Legacy.AcceptInboundCrossClusterSearchConnectionCommand({ CrossClusterSearchConnectionId: id })), /pending/);
    const id2 = (await h.os.send(new Os.CreateOutboundConnectionCommand(h.connection))).ConnectionId!;
    await h.legacy.send(new Legacy.AcceptInboundCrossClusterSearchConnectionCommand({ CrossClusterSearchConnectionId: id2 }));
    h.sim.store.save = async () => { throw new Error('injected deletion failure'); }; try { await assert.rejects(h.sim.opensearch.connections.execute('DeleteOutboundConnection', { ConnectionId: id2 }, region, account), /deletion failure/); } finally { h.sim.store.save = save; }
    assert.equal(h.sim.opensearch.connections.resolve(h.sim.opensearch.domain(region, 'cc-source'), 'remote').connection.status, 'ACTIVE');
    const first = await h.os.send(new Os.DescribeOutboundConnectionsCommand({ MaxResults: 1 })); assert.ok(first.NextToken); const second = await h.os.send(new Os.DescribeOutboundConnectionsCommand({ MaxResults: 1, NextToken: first.NextToken })); assert.equal(second.Connections?.length, 1); assert.notEqual(second.Connections![0].ConnectionId, first.Connections![0].ConnectionId);
    await assert.rejects(h.os.send(new Os.DescribeInboundConnectionsCommand({ MaxResults: 1, NextToken: first.NextToken })), { name: 'InvalidPaginationTokenException' });
    await assert.rejects(h.os.send(new Os.DescribeOutboundConnectionsCommand({ MaxResults: 1, NextToken: first.NextToken + '.extra' })), { name: 'InvalidPaginationTokenException' });
    await h.legacy.send(new Legacy.DeleteOutboundCrossClusterSearchConnectionCommand({ CrossClusterSearchConnectionId: id2 })); await assert.rejects(h.os.send(new Os.DescribeOutboundConnectionsCommand({ MaxResults: 1, NextToken: first.NextToken })), { name: 'InvalidPaginationTokenException' });
    await h.legacy.send(new Legacy.DeleteInboundCrossClusterSearchConnectionCommand({ CrossClusterSearchConnectionId: id }));
    assert.ok((await h.legacy.send(new Legacy.DescribeOutboundCrossClusterSearchConnectionsCommand({}))).CrossClusterSearchConnections!.every(item => item.ConnectionStatus?.StatusCode === 'DELETED'));
    await h.os.send(new Os.DeleteDomainCommand({ DomainName: 'cc-source' }));
  } finally { await h.close(); }
});

test('Cross-account and cross-Region connections require destination-owner approval and forward the current caller identity', { timeout: 60000 }, async () => {
  const h = await setup(), otherAccount = '111122223333', otherRegion = 'us-east-1', otherCredentials = { accessKeyId: 'destination-admin', secretAccessKey: 'destination-password' }; let sim = h.sim; const clients: Array<{ destroy(): void }> = []; let remote: Client | undefined;
  try {
    await sim.stop(); sim = new StackSim({ ...h.options, accountId: otherAccount, defaultAccessKeyId: otherCredentials.accessKeyId, defaultSecretAccessKey: otherCredentials.secretAccessKey }); await sim.start();
    for (const domain of sim.opensearch.domains(region, account)) assert.equal(domain.state, 'active', `Restart failed to activate ${domain.name} on port ${domain.gatewayPort}: ${domain.failure}`);
    const endpoint = `http://127.0.0.1:${sim.port}`, sourceControl = new Os.OpenSearchClient({ ...h.config, endpoint }), remoteControl = new Os.OpenSearchClient({ ...h.config, endpoint, region: otherRegion, credentials: otherCredentials }); clients.push(sourceControl, remoteControl);
    const remoteArn = `arn:aws:es:${otherRegion}:${otherAccount}:domain/cc-destination`;
    await remoteControl.send(new Os.CreateDomainCommand({ DomainName: 'cc-destination', EncryptionAtRestOptions: { Enabled: true }, NodeToNodeEncryptionOptions: { Enabled: true }, AdvancedSecurityOptions: { Enabled: true, MasterUserOptions: { MasterUserARN: `arn:aws:iam::${otherAccount}:user/admin` } }, AccessPolicies: policy([{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${account}:user/admin` }, Action: 'es:ESCrossClusterGet', Resource: remoteArn }]) }));
    await until(() => sim.opensearch.domain(otherRegion, 'cc-destination', otherAccount).state === 'active');
    remote = new Client({ node: `https://127.0.0.1:${sim.opensearch.domain(otherRegion, 'cc-destination', otherAccount).gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath) }, maxRetries: 0, ...AwsSigv4Signer({ region: otherRegion, service: 'es', getCredentials: async () => otherCredentials }) });
    await remote.index({ index: 'orders', id: '1', body: { price: 12 }, refresh: true });
    const created = await sourceControl.send(new Os.CreateOutboundConnectionCommand({ ...h.connection, RemoteDomainInfo: { AWSDomainInformation: { DomainName: 'cc-destination', OwnerId: otherAccount, Region: otherRegion } } }));
    assert.equal((await sourceControl.send(new Os.DescribeInboundConnectionsCommand({}))).Connections?.length, 0); assert.equal((await remoteControl.send(new Os.DescribeOutboundConnectionsCommand({}))).Connections?.length, 0);
    await assert.rejects(sourceControl.send(new Os.AcceptInboundConnectionCommand({ ConnectionId: created.ConnectionId })), { name: 'ResourceNotFoundException' });
    await remoteControl.send(new Os.AcceptInboundConnectionCommand({ ConnectionId: created.ConnectionId }));
    const source = h.client('cc-source', credentials, sim); await assert.rejects(source.search({ index: 'remote:orders' }), (error: any) => error.statusCode === 403);
    await remote.transport.request({ method: 'PUT', path: '/_plugins/_security/api/roles/remote-reader', body: { index_permissions: [{ index_patterns: ['orders'], allowed_actions: ['read', 'indices:admin/shards/search_shards'] }] } });
    await remote.transport.request({ method: 'PUT', path: '/_plugins/_security/api/rolesmapping/remote-reader', body: { users: [`arn:aws:iam::${account}:user/admin`] } });
    assert.equal((await source.search({ index: 'remote:orders' })).body.hits.hits[0]._source.price, 12);
    await assert.rejects(remoteControl.send(new Os.DeleteOutboundConnectionCommand({ ConnectionId: created.ConnectionId })), { name: 'ResourceNotFoundException' });
    await remoteControl.send(new Os.DeleteInboundConnectionCommand({ ConnectionId: created.ConnectionId })); await assert.rejects(source.search({ index: 'remote:orders' }), (error: any) => error.statusCode === 404);
  } finally { clients.forEach(client => client.destroy()); await remote?.close(); await h.close(sim); }
});
