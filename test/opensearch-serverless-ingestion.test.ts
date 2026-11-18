import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import * as Aoss from '@aws-sdk/client-opensearchserverless';
import * as S3 from '@aws-sdk/client-s3';
import * as Iam from '@aws-sdk/client-iam';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { StackSim } from '../src/server.js';
import { TestClock } from '../src/core/clock.js';
import { ServerlessIngestionStore } from '../src/opensearch/serverless-ingestion-store.js';
import { parseServerlessObject } from '../src/opensearch/serverless-ingestion.js';

const region = 'eu-west-1', credentials = { accessKeyId: 'admin', secretAccessKey: 'password' };
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 500; i++) { if (await check()) return; await delay(10); } assert.fail('Serverless ingestion did not reach the expected state'); }

test('Serverless object parsing and encrypted work checkpoints recover partial acknowledgment and reject invalid admission', async () => {
  assert.deepEqual(parseServerlessObject(gzipSync(Buffer.from('[{"a":1},{"a":2}]')), 'data.json.gz'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseServerlessObject(Buffer.from('{"a":1}\n{"a":2}\n'), 'data.ndjson'), [{ a: 1 }, { a: 2 }]);
  for (const [body, key] of [['[]', 'data.pdf'], ['{}\nbad', 'data.ndjson'], ['[null]', 'data.json']]) assert.throws(() => parseServerlessObject(Buffer.from(body), key));
  assert.throws(() => parseServerlessObject(Buffer.from([0xff]), 'data.json'));
  const root = await mkdtemp(join(tmpdir(), 'stacksim-aoss-job-store-')), file = join(root, 'work', 'work.enc'), key = join(root, 'secret.key'); let work = new ServerlessIngestionStore(file, key);
  try {
    work.listing([{ key: 'private-key.json', etag: 'etag', size: 12, lastModified: 1 }]); work.admit([{ secret: 'protected-object-payload' }, { value: 2 }]); work.acknowledge(0, false); work.close(); work = new ServerlessIngestionStore(file, key); assert.equal(work.next()!.position, 1); assert.equal(work.progress().cursor, 0); work.acknowledge(1, true); work.finishObject(); assert.equal(work.progress().cursor, 1); assert.equal(work.progress().objectsFailed, 1);
    const previous = work.progress(); (work as any).storage.commit = () => { throw new Error('injected publication failure'); }; assert.throws(() => work.admit([{ secret: 'unacknowledged' }])); work.close(); work = new ServerlessIngestionStore(file, key); assert.deepEqual(work.progress(), previous); assert.equal(work.admitted(), false);
    const walk = async (dir: string): Promise<void> => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else { const data = await readFile(path); for (const value of ['protected-object-payload', 'private-key.json']) assert.equal(data.includes(Buffer.from(value)), false); } } }; await walk(join(root, 'work'));
  } finally { work.close(); await rm(root, { recursive: true, force: true }); }
});

test('Official Serverless S3 jobs deliver real records and failures, cancel durably, resume and enforce live identity policies', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-aoss-jobs-')), clock = new TestClock(Date.now()), options = { dataDir: root, region, port: 0, invokePort: 0, clock, cdkBootstrap: false, authMode: 'enforce' as const };
  let sim = new StackSim(options), aoss: Aoss.OpenSearchServerlessClient | undefined, s3: S3.S3Client | undefined, iam: Iam.IAMClient | undefined, search: Client | undefined;
  const connect = () => { const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; aoss = new Aoss.OpenSearchServerlessClient(config); s3 = new S3.S3Client({ ...config, forcePathStyle: true }); iam = new Iam.IAMClient(config); };
  const tick = () => clock.advance(1000);
  try {
    await sim.start(); connect();
    await aoss!.send(new Aoss.CreateCollectionGroupCommand({ name: 'ingestion-group', generation: 'NEXTGEN', standbyReplicas: 'DISABLED' }));
    await aoss!.send(new Aoss.CreateSecurityPolicyCommand({ name: 'ingestion-network', type: 'network', policy: JSON.stringify([{ Rules: [{ ResourceType: 'collection', Resource: ['collection/ingestion'] }], AllowFromPublic: true }]) }));
    const adminArn = Object.values(sim.store.state.accounts[sim.store.accountId].iam.users).find(user => user.userName === 'stacksim-admin')?.arn ?? Object.values(sim.store.state.accounts[sim.store.accountId].iam.users)[0].arn;
    await aoss!.send(new Aoss.CreateAccessPolicyCommand({ name: 'ingestion-data', type: 'data', policy: JSON.stringify([{ Rules: [{ ResourceType: 'index', Resource: ['index/ingestion/*'], Permission: ['aoss:*'] }], Principal: [adminArn] }]) }));
    const id = (await aoss!.send(new Aoss.CreateCollectionCommand({ name: 'ingestion', type: 'SEARCH', collectionGroupName: 'ingestion-group', encryptionConfig: { aWSOwnedKey: true } }))).createCollectionDetail!.id!;
    await until(() => sim.opensearch.serverless.collection(region, id).status === 'ACTIVE'); const endpoint = `https://127.0.0.1:${sim.opensearch.serverless.collection(region, id).gatewayPort}`, ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath!);
    const client = () => new Client({ node: endpoint, ssl: { ca }, ...AwsSigv4Signer({ region, service: 'aoss', getCredentials: async () => credentials }) }); search = client();
    await s3!.send(new S3.CreateBucketCommand({ Bucket: 'job-source', CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3!.send(new S3.PutObjectCommand({ Bucket: 'job-source', Key: 'small/a.json', Body: '[{"price":1,"title":"first"},{"price":2,"title":"second"}]' })); await s3!.send(new S3.PutObjectCommand({ Bucket: 'job-source', Key: 'small/b.ndjson', Body: '{"price":"bad"}\n' })); await s3!.send(new S3.PutObjectCommand({ Bucket: 'job-source', Key: 'small/c.pdf', Body: 'unsupported' }));
    await search.indices.create({ index: 'records', body: { mappings: { properties: { price: { type: 'integer' }, title: { type: 'text' } } } } });
    const input = { collectionId: id, ingestionJobName: 'initial', indexName: 'records', source: { s3: { bucket: 'arn:aws:s3:::job-source', keyPrefix: 'small/' } }, tags: [{ key: 'app', value: 'test' }], clientToken: 'initial-once' };
    const created = (await aoss!.send(new Aoss.CreateIngestionJobCommand(input))).ingestionJobDetail!; assert.equal(created.status, 'CREATING'); assert.ok(created.createdAt instanceof Date); const jobId = created.ingestionJobId!;
    assert.equal((await aoss!.send(new Aoss.CreateIngestionJobCommand(input))).ingestionJobDetail!.ingestionJobId, jobId); await assert.rejects(aoss!.send(new Aoss.CreateIngestionJobCommand({ ...input, indexName: 'different' })), /reused/);
    const job = () => sim.opensearch.serverless.ingestion.jobs(region, sim.store.accountId)[jobId]; await until(() => { tick(); return job().status === 'COMPLETED'; }); assert.deepEqual(job().statistics.s3, { objectsDiscovered: 3, objectsIngested: 1, objectsFailed: 2 });
    clock.advance(10000); assert.equal((await search.count({ index: 'records' })).body.count, 2); assert.equal((await search.count({ index: 'records-ingestion-failures' })).body.count, 2);
    await aoss!.send(new Aoss.TagResourceCommand({ resourceArn: created.arn!, tags: [{ key: 'stage', value: 'done' }] })); assert.equal((await aoss!.send(new Aoss.ListTagsForResourceCommand({ resourceArn: created.arn! }))).tags!.length, 2);
    await s3!.send(new S3.PutObjectCommand({ Bucket: 'job-source', Key: 'large/data.json', Body: JSON.stringify(Array.from({ length: 55 }, (_, i) => ({ n: i, secret: 'encrypted-job-source' }))) }));
    const pending = (await aoss!.send(new Aoss.CreateIngestionJobCommand({ ...input, ingestionJobName: 'restart', indexName: 'resumed', source: { s3: { bucket: 'job-source', keyPrefix: 'large/' } }, clientToken: 'restart' }))).ingestionJobDetail!; const pendingId = pending.ingestionJobId!;
    tick(); await until(() => sim.opensearch.serverless.ingestion.jobs(region, sim.store.accountId)[pendingId].state === 'INGESTION_IN_PROGRESS' && (sim.opensearch.serverless.ingestion as any).workers.size === 0);
    await search.close(); search = undefined; aoss!.destroy(); s3!.destroy(); iam!.destroy();
    await sim.stop(); sim = new StackSim(options); await sim.start(); connect(); search = client();
    const resumedCollection = sim.opensearch.serverless.state(region).collections[id];
    assert.equal(resumedCollection.status, 'ACTIVE', `Restart failed to activate endpoint ${resumedCollection.gatewayPort}: ${resumedCollection.failureMessage}`);
    await until(() => { tick(); return sim.opensearch.serverless.ingestion.jobs(region, sim.store.accountId)[pendingId].status === 'COMPLETED'; });
    clock.advance(10000); assert.equal((await search.count({ index: 'resumed' })).body.count, 55);
    const cancelled = (await aoss!.send(new Aoss.CreateIngestionJobCommand({ ...input, ingestionJobName: 'cancelled', indexName: 'cancelled', source: { s3: { bucket: 'job-source', keyPrefix: 'large/' } }, clientToken: 'cancelled' }))).ingestionJobDetail!;
    await aoss!.send(new Aoss.CancelIngestionJobCommand({ collectionId: id, ingestionJobId: cancelled.ingestionJobId! })); await until(() => { tick(); return sim.opensearch.serverless.ingestion.jobs(region, sim.store.accountId)[cancelled.ingestionJobId!].status === 'CANCELLED'; }); assert.equal((await aoss!.send(new Aoss.GetIngestionJobCommand({ collectionId: id, ingestionJobId: cancelled.ingestionJobId! }))).ingestionJobDetail!.state, 'STOPPED');
    const list = await aoss!.send(new Aoss.ListIngestionJobsCommand({ collectionId: id, maxResults: 1 })); assert.ok(list.nextToken); assert.equal((await aoss!.send(new Aoss.ListIngestionJobsCommand({ collectionId: id, maxResults: 1, nextToken: list.nextToken }))).ingestionJobSummaries!.length, 1);
    await iam!.send(new Iam.PutUserPolicyCommand({ UserName: Object.values(sim.store.ensureAccount().iam.users).find(user => user.arn === adminArn)!.userName, PolicyName: 'source-deny', PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: 's3:GetObject', Resource: 'arn:aws:s3:::job-source/*' }] }) }));
    const denied = (await aoss!.send(new Aoss.CreateIngestionJobCommand({ ...input, ingestionJobName: 'denied', indexName: 'denied', clientToken: 'denied' }))).ingestionJobDetail!; await until(() => { tick(); return sim.opensearch.serverless.ingestion.jobs(region, sim.store.accountId)[denied.ingestionJobId!].status === 'FAILED'; }); assert.equal((await aoss!.send(new Aoss.GetIngestionJobCommand({ collectionId: id, ingestionJobId: denied.ingestionJobId! }))).ingestionJobDetail!.failureReasons![0].code, 'SOURCE_ACCESS_DENIED');
    const user = (await iam!.send(new Iam.CreateUserCommand({ UserName: 'JobCaller' }))).User!;
    const key = (await iam!.send(new Iam.CreateAccessKeyCommand({ UserName: 'JobCaller' }))).AccessKey!;
    await iam!.send(new Iam.PutUserPolicyCommand({ UserName: 'JobCaller', PolicyName: 'jobs', PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['aoss:*', 's3:ListBucket', 's3:GetObject'], Resource: '*' }] }) }));
    const data = (await aoss!.send(new Aoss.GetAccessPolicyCommand({ name: 'ingestion-data', type: 'data' }))).accessPolicyDetail!;
    await aoss!.send(new Aoss.UpdateAccessPolicyCommand({ name: 'ingestion-data', type: 'data', policyVersion: data.policyVersion!, policy: JSON.stringify([{ Rules: [{ ResourceType: 'index', Resource: ['index/ingestion/*'], Permission: ['aoss:*'] }], Principal: [adminArn, user.Arn] }]) }));
    const caller = new Aoss.OpenSearchServerlessClient({ endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: key.AccessKeyId!, secretAccessKey: key.SecretAccessKey! }, maxAttempts: 1 });
    try {
      const identityJob = (await caller.send(new Aoss.CreateIngestionJobCommand({ collectionId: id, ingestionJobName: 'revoked-key', indexName: 'revoked-key', source: { s3: { bucket: 'job-source', keyPrefix: 'large/' } } }))).ingestionJobDetail!;
      tick(); await until(() => sim.opensearch.serverless.ingestion.jobs(region, sim.store.accountId)[identityJob.ingestionJobId!].state === 'INGESTION_IN_PROGRESS' && (sim.opensearch.serverless.ingestion as any).workers.size === 0);
      await iam!.send(new Iam.UpdateAccessKeyCommand({ UserName: 'JobCaller', AccessKeyId: key.AccessKeyId!, Status: 'Inactive' }));
      await until(() => { tick(); return sim.opensearch.serverless.ingestion.jobs(region, sim.store.accountId)[identityJob.ingestionJobId!].status === 'FAILED'; });
      clock.advance(10000); assert.equal((await search.count({ index: 'revoked-key' })).body.count, 20, 'Previously admitted records cannot bypass a revoked execution identity');
    } finally { caller.destroy(); }
    await search.close(); search = undefined; await aoss!.send(new Aoss.DeleteCollectionCommand({ id })); await until(() => !sim.opensearch.serverless.state(region).collections[id]); assert.equal(Object.keys(sim.opensearch.serverless.ingestion.jobs(region, sim.store.accountId)).length, 0);
  } finally { await search?.close(); aoss?.destroy(); s3?.destroy(); iam?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
