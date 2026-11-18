import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as Aoss from '@aws-sdk/client-opensearchserverless';
import * as S3 from '@aws-sdk/client-s3';
import * as Sqs from '@aws-sdk/client-sqs';
import * as Iam from '@aws-sdk/client-iam';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { StackSim } from '../src/server.js';
import { TestClock } from '../src/core/clock.js';
import { parseServerlessNotification } from '../src/opensearch/serverless-streams.js';
import { ServerlessIngestionStore } from '../src/opensearch/serverless-ingestion-store.js';

const region = 'eu-west-1', credentials = { accessKeyId: 'admin', secretAccessKey: 'password' };
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 700; i++) { if (await check()) return; await delay(10); } assert.fail('Serverless stream did not reach the expected state'); }

test('S3 stream notifications and encrypted message checkpoints reject malformed records and preserve completion across reopening', async () => {
  const source = { region, accountId: '123456789012', source: { s3: { sqsArn: `arn:aws:sqs:${region}:123456789012:queue`, buckets: [{ bucket: 'stream-source' }] } } };
  const event = { Records: [{ eventSource: 'aws:s3', awsRegion: region, eventName: 'ObjectCreated:Put', s3: { bucket: { name: 'stream-source', arn: 'arn:aws:s3:::stream-source' }, object: { key: 'folder/a+b%2B.json', size: 2, eTag: 'a'.repeat(32) } } }] };
  const objects = parseServerlessNotification(JSON.stringify(event), source); assert.equal(objects[0].key, 'folder/a b+.json');
  assert.deepEqual(parseServerlessNotification('{"Service":"Amazon S3","Event":"s3:TestEvent"}', source), []);
  for (const change of [{ eventName: 'ObjectRemoved:Delete' }, { awsRegion: 'us-east-1' }, { eventSource: 'aws:sns' }]) assert.throws(() => parseServerlessNotification(JSON.stringify({ Records: [{ ...event.Records[0], ...change }] }), source));
  assert.throws(() => parseServerlessNotification('{"Records":[]}', source));
  assert.throws(() => parseServerlessNotification(JSON.stringify(event), { ...source, source: { s3: { sqsArn: source.source.s3.sqsArn, buckets: [{ bucket: 'different' }] } } }));
  const root = await mkdtemp(join(tmpdir(), 'stacksim-stream-store-')), file = join(root, 'data', 'work.enc'), key = join(root, 'secret.key'); let work = new ServerlessIngestionStore(file, key);
  try {
    work.streamBatch([], undefined); work.streamBatch(objects, { id: 'message', receipt: 'private-receipt' }); work.admit([{ secret: 'private-record' }, { value: 2 }]); work.acknowledge(0, false);
    assert.throws(() => work.completeStreamMessage()); work.close(); work = new ServerlessIngestionStore(file, key);
    assert.equal(work.next()!.position, 1); work.acknowledge(1, true); work.finishObject(); work.completeStreamMessage(); work.close(); work = new ServerlessIngestionStore(file, key);
    assert.deepEqual(work.progress().stream!.completed, ['message']); assert.equal(work.progress().stream!.message!.receipt, 'private-receipt'); work.clearStreamMessage(); work.streamBatch(objects, { id: 'next', receipt: 'next-receipt' }); assert.equal(work.progress().objectsFailed, 1); assert.equal(work.progress().stream!.discovered, 2);
    assert.equal((await readFile(file)).includes(Buffer.from('private-record')), false);
  } finally { work.close(); await rm(root, { recursive: true, force: true }); }
});

test('Official continuous streams backfill and consume real S3 notifications with durable acknowledgment, live trust and queue/data authorization', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-aoss-streams-')), clock = new TestClock(Date.now()), options = { dataDir: root, region, port: 0, invokePort: 0, clock, cdkBootstrap: false, authMode: 'enforce' as const };
  let sim = new StackSim(options), aoss: Aoss.OpenSearchServerlessClient, s3: S3.S3Client, sqs: Sqs.SQSClient, iam: Iam.IAMClient, search: Client | undefined;
  const connect = () => { const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; aoss = new Aoss.OpenSearchServerlessClient(config); s3 = new S3.S3Client({ ...config, forcePathStyle: true }); sqs = new Sqs.SQSClient(config); iam = new Iam.IAMClient(config); };
  const disconnect = () => { aoss?.destroy(); s3?.destroy(); sqs?.destroy(); iam?.destroy(); };
  const tick = () => clock.advance(1000);
  try {
    await sim.start(); connect(); const account = sim.store.accountId;
    await aoss!.send(new Aoss.CreateCollectionGroupCommand({ name: 'streams-group', generation: 'NEXTGEN', standbyReplicas: 'DISABLED' }));
    await aoss!.send(new Aoss.CreateSecurityPolicyCommand({ name: 'streams-network', type: 'network', policy: JSON.stringify([{ Rules: [{ ResourceType: 'collection', Resource: ['collection/streams'] }], AllowFromPublic: true }]) }));
    const id = (await aoss!.send(new Aoss.CreateCollectionCommand({ name: 'streams', type: 'SEARCH', collectionGroupName: 'streams-group', encryptionConfig: { aWSOwnedKey: true } }))).createCollectionDetail!.id!;
    await until(() => sim.opensearch.serverless.collection(region, id).status === 'ACTIVE');
    const trust = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'aoss.amazonaws.com' }, Action: 'sts:AssumeRole', Condition: { StringLike: { 'aws:SourceArn': `arn:aws:aoss:${region}:${account}:collection/${id}/ingestion-stream/*` }, StringEquals: { 'aws:SourceAccount': account } } }] };
    const role = (await iam!.send(new Iam.CreateRoleCommand({ RoleName: 'ContinuousIngestion', AssumeRolePolicyDocument: JSON.stringify(trust) }))).Role!.Arn!;
    const rolePolicy = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['aoss:APIAccessAll', 's3:GetObject', 's3:ListBucket', 'sqs:GetQueueUrl', 'sqs:GetQueueAttributes', 'sqs:ReceiveMessage', 'sqs:DeleteMessage'], Resource: '*' }] };
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: 'ContinuousIngestion', PolicyName: 'stream', PolicyDocument: JSON.stringify(rolePolicy) }));
    const admin = Object.values(sim.store.ensureAccount().iam.users)[0];
    await aoss!.send(new Aoss.CreateAccessPolicyCommand({ name: 'streams-data', type: 'data', policy: JSON.stringify([{ Rules: [{ ResourceType: 'index', Resource: ['index/streams/*'], Permission: ['aoss:*'] }], Principal: [admin.arn, role] }]) }));
    const endpoint = `https://127.0.0.1:${sim.opensearch.serverless.collection(region, id).gatewayPort}`, ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath!);
    const client = () => new Client({ node: endpoint, ssl: { ca }, ...AwsSigv4Signer({ region, service: 'aoss', getCredentials: async () => credentials }) }); search = client();
    await s3!.send(new S3.CreateBucketCommand({ Bucket: 'stream-source', CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3!.send(new S3.PutObjectCommand({ Bucket: 'stream-source', Key: 'initial.json', Body: '{"title":"initial"}' }));
    let queueUrl = (await sqs!.send(new Sqs.CreateQueueCommand({ QueueName: 'stream-events' }))).QueueUrl!;
    const queueArn = `arn:aws:sqs:${region}:${account}:stream-events`, queuePolicy = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 's3.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: queueArn, Condition: { ArnEquals: { 'aws:SourceArn': 'arn:aws:s3:::stream-source' } } }] };
    await sqs!.send(new Sqs.SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: { Policy: JSON.stringify(queuePolicy) } }));
    await s3!.send(new S3.PutBucketNotificationConfigurationCommand({ Bucket: 'stream-source', NotificationConfiguration: { QueueConfigurations: [{ Id: 'stream', QueueArn: queueArn, Events: ['s3:ObjectCreated:*'] }] } }));
    const input = { collectionId: id, ingestionStreamName: 'continuous', indexName: 'documents', roleArn: role, source: { s3: { sqsArn: queueArn, buckets: [{ bucket: 'stream-source', initialScan: 'ENABLED' as const }] } }, clientToken: 'stream-once', tags: [{ key: 'purpose', value: 'test' }] };
    await iam!.send(new Iam.PutUserPolicyCommand({ UserName: admin.userName, PolicyName: 'deny-pass', PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: 'iam:PassRole', Resource: role }] }) }));
    await assert.rejects(aoss!.send(new Aoss.CreateIngestionStreamCommand(input)), /pass the ingestion role/); await iam!.send(new Iam.DeleteUserPolicyCommand({ UserName: admin.userName, PolicyName: 'deny-pass' }));
    const created = (await aoss!.send(new Aoss.CreateIngestionStreamCommand(input))).ingestionStreamDetail!, streamId = created.ingestionStreamId!;
    assert.equal(created.status, 'CREATING'); assert.ok(created.createdAt instanceof Date);
    assert.equal((await aoss!.send(new Aoss.CreateIngestionStreamCommand(input))).ingestionStreamDetail!.ingestionStreamId, streamId);
    await assert.rejects(aoss!.send(new Aoss.CreateIngestionStreamCommand({ ...input, indexName: 'other' })), /reused/);
    await assert.rejects(aoss!.send(new Aoss.CreateIngestionStreamCommand({ ...input, ingestionStreamName: 'duplicate', indexName: 'other', clientToken: 'other' })), /already has an active/);
    const stream = () => sim.opensearch.serverless.streams.streams(region, account)[streamId];
    await until(() => { tick(); return stream().statistics.s3.objectsIngested === 1 && stream().state === 'INGESTION_COMPLETE'; }); clock.advance(10000); assert.equal((await search.count({ index: 'documents' })).body.count, 1);
    assert.equal((await aoss!.send(new Aoss.ListIngestionStreamsCommand({ collectionId: id }))).ingestionStreamSummaries!.length, 1);
    await aoss!.send(new Aoss.TagResourceCommand({ resourceArn: created.arn!, tags: [{ key: 'mode', value: 'continuous' }] })); assert.equal((await aoss!.send(new Aoss.ListTagsForResourceCommand({ resourceArn: created.arn! }))).tags!.length, 2);
    // Stop after a real notification has admitted its records and acknowledged the first twenty.
    await s3!.send(new S3.PutObjectCommand({ Bucket: 'stream-source', Key: 'folder/a b+.json', Body: JSON.stringify(Array.from({ length: 55 }, (_, n) => ({ n, secret: 'encrypted-stream-data' }))) }));
    await until(() => { if ((sim.opensearch.serverless.streams as any).workers.size === 0 && stream().state === 'INGESTION_IN_PROGRESS') return true; tick(); return false; });
    const checkpointPath = (sim.opensearch.serverless.streams as any).location(stream()), checkpoint = new ServerlessIngestionStore(checkpointPath.file, checkpointPath.key); const receipt = checkpoint.progress().stream!.message!.receipt; checkpoint.close();
    await sqs!.send(new Sqs.ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt, VisibilityTimeout: 0 }));
    await search.close(); search = undefined; disconnect(); await sim.stop(); sim = new StackSim(options); await sim.start(); connect(); search = client(); queueUrl = (await sqs!.send(new Sqs.GetQueueUrlCommand({ QueueName: 'stream-events' }))).QueueUrl!;
    await until(() => { tick(); return stream().statistics.s3.objectsIngested === 2 && stream().state === 'INGESTION_COMPLETE'; }); clock.advance(10000); assert.equal((await search.count({ index: 'documents' })).body.count, 56);
    const queueEmpty = async () => { const attributes = (await sqs!.send(new Sqs.GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }))).Attributes!; return Number(attributes.ApproximateNumberOfMessages ?? 0) + Number(attributes.ApproximateNumberOfMessagesNotVisible ?? 0) === 0; };
    await until(async () => { tick(); return queueEmpty(); });
    // Cached service credentials must not bypass a changed trust policy.
    await iam!.send(new Iam.UpdateAssumeRolePolicyCommand({ RoleName: 'ContinuousIngestion', PolicyDocument: JSON.stringify({ ...trust, Statement: [{ ...trust.Statement[0], Principal: { Service: 'osis-pipelines.amazonaws.com' } }] }) }));
    await until(() => { tick(); return stream().activeAlerts?.[0]?.code === 'SOURCE_ACCESS_DENIED'; });
    await iam!.send(new Iam.UpdateAssumeRolePolicyCommand({ RoleName: 'ContinuousIngestion', PolicyDocument: JSON.stringify(trust) }));
    await until(() => { tick(); return !stream().activeAlerts?.length; });
    await sqs!.send(new Sqs.SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: { Policy: JSON.stringify({ ...queuePolicy, Statement: [...queuePolicy.Statement, { Effect: 'Deny', Principal: '*', Action: 'sqs:ReceiveMessage', Resource: queueArn }] }) } }));
    await until(() => { tick(); return stream().activeAlerts?.[0]?.code === 'SOURCE_ACCESS_DENIED'; });
    await sqs!.send(new Sqs.SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: { Policy: JSON.stringify(queuePolicy) } }));
    await until(() => { tick(); return !stream().activeAlerts?.length; });
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: 'ContinuousIngestion', PolicyName: 'deny-index', PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: 'aoss:APIAccessAll', Resource: '*' }] }) }));
    await s3!.send(new S3.PutObjectCommand({ Bucket: 'stream-source', Key: 'denied.json', Body: '{"title":"after-policy-repair"}' }));
    await until(() => { tick(); return stream().activeAlerts?.[0]?.code === 'DESTINATION_ACCESS_DENIED'; });
    assert.equal(await queueEmpty(), false, 'Denied writes must not acknowledge the queue message');
    await iam!.send(new Iam.DeleteRolePolicyCommand({ RoleName: 'ContinuousIngestion', PolicyName: 'deny-index' }));
    await until(() => { tick(); return stream().statistics.s3.objectsIngested === 3 && stream().state === 'INGESTION_COMPLETE'; });
    await s3!.send(new S3.PutObjectCommand({ Bucket: 'stream-source', Key: 'bad.pdf', Body: 'unsupported' }));
    await until(() => { tick(); return stream().statistics.s3.objectsFailed === 1 && stream().state === 'INGESTION_COMPLETE'; }); clock.advance(10000); assert.equal((await search.count({ index: 'documents-ingestion-failures' })).body.count, 1);
    await sqs!.send(new Sqs.SendMessageCommand({ QueueUrl: queueUrl, MessageBody: '{"secret":"never-copy-raw-notifications"}' }));
    await until(() => { tick(); return stream().statistics.s3.objectsFailed === 2 && stream().state === 'INGESTION_COMPLETE'; }); clock.advance(10000); const failures = (await search.search({ index: 'documents-ingestion-failures' })).body; assert.equal(JSON.stringify(failures).includes('never-copy-raw-notifications'), false);
    const sessions = Object.values(sim.store.ensureAccount().iam.sessions).filter(session => session.roleArn === role); assert.ok(sessions.length <= 3, 'Polling reuses service credentials with fresh trust checks');
    assert.equal((await aoss!.send(new Aoss.GetIngestionStreamCommand({ collectionId: id, ingestionStreamId: streamId }))).ingestionStreamDetail!.status, 'ACTIVE');
    await aoss!.send(new Aoss.DeleteIngestionStreamCommand({ collectionId: id, ingestionStreamId: streamId })); await until(() => { tick(); return stream().status === 'DELETED'; });
    assert.equal((await aoss!.send(new Aoss.ListIngestionStreamsCommand({ collectionId: id }))).ingestionStreamSummaries!.length, 0);
    assert.equal((await search.count({ index: 'documents' })).body.count, 57); await sqs!.send(new Sqs.GetQueueAttributesCommand({ QueueUrl: queueUrl })); await s3!.send(new S3.HeadBucketCommand({ Bucket: 'stream-source' }));
    const others: string[] = [];
    for (let n = 0; n < 5; n++) {
      await sqs!.send(new Sqs.CreateQueueCommand({ QueueName: `idle-stream-${n}` }));
      const created = (await aoss!.send(new Aoss.CreateIngestionStreamCommand({ collectionId: id, ingestionStreamName: `idle-stream-${n}`, indexName: `idle-records-${n}`, roleArn: role, source: { s3: { sqsArn: `arn:aws:sqs:${region}:${account}:idle-stream-${n}` } } }))).ingestionStreamDetail!; others.push(created.ingestionStreamId!);
    }
    const page = await aoss!.send(new Aoss.ListIngestionStreamsCommand({ collectionId: id, maxResults: 2 })); assert.ok(page.nextToken);
    await until(() => { tick(); return others.every(id => sim.opensearch.serverless.streams.streams(region, account)[id].state === 'INGESTION_COMPLETE'); });
    const next = await aoss!.send(new Aoss.ListIngestionStreamsCommand({ collectionId: id, maxResults: 2, nextToken: page.nextToken })); assert.equal(next.ingestionStreamSummaries!.length, 2, 'Progress changes do not invalidate stream pagination');
    await assert.rejects(aoss!.send(new Aoss.ListIngestionStreamsCommand({ collectionId: id, nextToken: `${page.nextToken}.extra` })), /pagination/);
    await search.close(); search = undefined; await aoss!.send(new Aoss.DeleteCollectionCommand({ id })); await until(() => !sim.opensearch.serverless.state(region).collections[id]); assert.equal(Object.keys(sim.opensearch.serverless.streams.streams(region, account)).length, 0);
  } finally { await search?.close(); disconnect(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
