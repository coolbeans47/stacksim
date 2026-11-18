import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as Osis from '@aws-sdk/client-osis';
import * as Iam from '@aws-sdk/client-iam';
import * as Ddb from '@aws-sdk/client-dynamodb';
import * as Cfn from '@aws-sdk/client-cloudformation';
import * as S3 from '@aws-sdk/client-s3';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { StackSim } from '../src/server.js';
import { TestClock } from '../src/core/clock.js';
import { parseIngestionConfig, renderIngestionFormat } from '../src/opensearch/ingestion/config.js';
import { dynamoEvents, pollDynamoSource, type DynamoSourceState } from '../src/opensearch/ingestion/dynamodb-source.js';
import { IngestionBuffer } from '../src/opensearch/ingestion/buffer.js';
import { AwsError } from '../src/errors.js';

const region = 'eu-west-1', account = '000000000000', credentials = { accessKeyId: 'admin', secretAccessKey: 'password' }, role = `arn:aws:iam::${account}:role/StreamRole`, tableArn = `arn:aws:dynamodb:${region}:${account}:table/products`;
const policy = (Statement: any[]) => JSON.stringify({ Version: '2012-10-17', Statement });
function configuration(host = 'https://127.0.0.1:48000') { return { version: '2', stream: { source: { dynamodb: { aws: { region, sts_role_arn: role }, acknowledgments: true, tables: [{ table_arn: tableArn, stream: { start_position: 'TRIM_HORIZON' } }] } }, sink: [{ opensearch: { hosts: [host], aws: { region, sts_role_arn: role }, index: 'products', document_id: '${getMetadata("primary_key")}', action: '${getMetadata("opensearch_action")}', document_version: '${getMetadata("document_version")}', document_version_type: 'external' } }] } }; }
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 500; i++) { if (await check()) return; await delay(10); } assert.fail('DynamoDB ingestion did not reach expected state'); }
const cursor = { streamArn: `${tableArn}/stream/current`, shardId: 'shard', nextSequence: '1', keys: ['id'] };
const record = (sequence: number, eventName = 'INSERT', attributes: any = {}) => ({ eventName, dynamodb: { SequenceNumber: String(sequence), ApproximateCreationDateTime: 100, Keys: { id: { S: 'one' } }, ...(eventName === 'REMOVE' ? {} : { NewImage: { id: { S: 'one' }, text: { S: 'private-stream-content' }, ...attributes } }) } });

test('DynamoDB source validates metadata, image conversion, ordering and precision before admitting a batch', () => {
  const config = parseIngestionConfig(JSON.stringify(configuration())); assert.equal(config.dynamodb!.table, 'products');
  const events = dynamoEvents([record(1, 'INSERT', { map: { M: { flag: { BOOL: true }, nil: { NULL: true }, list: { L: [{ N: '2.5' }] } } }, tags: { SS: ['a', 'b'] }, binary: { B: 'YQ==' } }), record(2, 'REMOVE')], cursor, 'products');
  assert.deepEqual(events[0].source.map, { flag: true, nil: null, list: [2.5] }); assert.equal(events[1].metadata.opensearch_action, 'delete'); assert.equal(renderIngestionFormat(config.sink.documentId!, {}, events[0].metadata), 'one');
  for (const records of [[record(2), record(1)], [record(1, 'INSERT', { number: { N: '123456789012345678901' } })], [record(1, 'INSERT', { number: { N: '1e-999' } })], [{ ...record(1), dynamodb: { ...record(1).dynamodb, Keys: { id: { S: 'a|b' } } } }]]) assert.throws(() => dynamoEvents(records, cursor, 'products'));
  for (const mutate of [(c: any) => c.stream.source.dynamodb.tables[0].export = {}, (c: any) => c.stream.source.dynamodb.acknowledgments = false, (c: any) => c.stream.sink[0].opensearch.action = 'index', (c: any) => c.stream.sink[0].opensearch.index = '${/field}', (c: any) => c.stream.sink[0].opensearch.aws.serverless = true]) { const value = configuration(); mutate(value); assert.throws(() => parseIngestionConfig(JSON.stringify(value))); }
});

test('DynamoDB checkpoints and metadata share encrypted admission, advance after every acknowledgment, and fence trimmed cursors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-ddb-checkpoint-')), file = join(root, 'generation', 'buffer.enc'), key = join(root, 'secret.key'); let buffer = new IngestionBuffer(file, key), now = 1, reads = 0;
  const config = parseIngestionConfig(JSON.stringify(configuration())), pipeline = { config, sourceRunId: 'run' } as any;
  const port = { validate() {}, async open() { return cursor; }, async read() { reads++; return { records: [record(1), record(2, 'REMOVE')], closed: false }; } };
  const poll = () => pollDynamoSource(pipeline, buffer, port, async () => ({} as any), () => now, () => true);
  try {
    await poll(); const rows = buffer.due(now, 10); assert.equal(rows.length, 2); assert.equal(buffer.stream()!.cursor!.nextSequence, '1');
    buffer.delivered(rows[0].id, false, now); await poll(); assert.equal(reads, 1); buffer.close(); buffer = new IngestionBuffer(file, key);
    assert.equal(buffer.stream()!.pending!.remaining, 1); assert.equal(buffer.due(now, 10)[0].metadata!.opensearch_action, 'delete'); buffer.delivered(rows[1].id, true, now); assert.equal(buffer.stream()!.cursor!.nextSequence, '3'); assert.equal(buffer.stream()!.deadLettered, 1);
    port.read = async () => { throw new AwsError('TrimmedDataAccessException', 'internal private path', 400); }; now++; await poll(); assert.equal(buffer.stream()!.status, 'BLOCKED'); assert.match(buffer.stream()!.failure!, /retention/); assert.doesNotMatch(buffer.stream()!.failure!, /private path/);
    const walk = async (dir: string): Promise<void> => { for (const entry of await readdir(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else assert.equal((await readFile(path)).includes(Buffer.from('private-stream-content')), false); } }; await walk(join(root, 'generation'));
    // A failed encrypted commit cannot advance the position or leave half a batch.
    const reset = { ...buffer.stream()!, status: 'READING' as const }; buffer.saveStream(reset); const before = buffer.stream(); (buffer as any).storage.commit = () => { throw new Error('injected'); };
    assert.throws(() => buffer.acceptStream(dynamoEvents([record(3)], { ...cursor, nextSequence: '3' }, 'products'), config, now, reset, 'new', false)); buffer.close(); buffer = new IngestionBuffer(file, key); assert.deepEqual(buffer.stream(), before); assert.equal(buffer.stats().buffered, 0);
  } finally { buffer.close(); await rm(root, { recursive: true, force: true }); }
});

test('Official DynamoDB CDC indexes modifications and deletes, checks source/sink permissions, and resumes across stop and process restart', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-ddb-ingestion-')), clock = new TestClock(Date.now()), options = { port: 0, invokePort: 0, dataDir: root, region, clock, authMode: 'enforce' as const, cdkBootstrap: false };
  let sim = new StackSim(options), osis: Osis.OSISClient | undefined, iam: Iam.IAMClient | undefined, ddb: Ddb.DynamoDBClient | undefined, search: Client | undefined;
  const connect = () => { const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; osis = new Osis.OSISClient(sdk); iam = new Iam.IAMClient(sdk); ddb = new Ddb.DynamoDBClient(sdk); };
  const source = () => (sim.opensearch.ingestion as any).buffers.get(sim.opensearch.ingestion.pipeline(region, 'ddb-source').generation).stream() as DynamoSourceState | undefined;
  const tick = () => clock.advance(1000);
  try {
    await sim.start(); connect(); await sim.opensearch.execute('CreateDomain', { DomainName: 'stream-search' }, region); await until(() => sim.opensearch.domain(region, 'stream-search').state === 'active'); const domain = sim.opensearch.domain(region, 'stream-search'), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath!);
    const client = () => new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: 'es', getCredentials: async () => credentials }) }); search = client();
    await ddb!.send(new Ddb.CreateTableCommand({ TableName: 'products', BillingMode: 'PAY_PER_REQUEST', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }], StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' } }));
    await until(async () => { tick(); return (await ddb!.send(new Ddb.DescribeTableCommand({ TableName: 'products' }))).Table!.TableStatus === 'ACTIVE'; });
    const put = (id: string, text: string) => ddb!.send(new Ddb.PutItemCommand({ TableName: 'products', Item: { id: { S: id }, title: { S: text }, price: { N: '2.5' } } }));
    await put('one', 'before pipeline');
    await iam!.send(new Iam.CreateRoleCommand({ RoleName: 'StreamRole', AssumeRolePolicyDocument: policy([{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'osis-pipelines.amazonaws.com' } }]) }));
    const body = JSON.stringify(configuration(`https://127.0.0.1:${domain.gatewayPort}`)); await osis!.send(new Osis.CreatePipelineCommand({ PipelineName: 'ddb-source', MinUnits: 1, MaxUnits: 2, PipelineConfigurationBody: body })); await until(() => sim.opensearch.ingestion.pipeline(region, 'ddb-source').status === 'ACTIVE'); tick(); await until(() => source()?.status === 'RETRYING'); assert.equal(source()!.accepted, 0);
    const grants = [{ Effect: 'Allow', Action: 'dynamodb:DescribeTable', Resource: tableArn }, { Effect: 'Allow', Action: ['dynamodb:DescribeStream', 'dynamodb:GetShardIterator', 'dynamodb:GetRecords'], Resource: `${tableArn}/stream/*` }, { Effect: 'Allow', Action: 'es:DescribeDomain', Resource: domain.arn }, { Effect: 'Allow', Action: ['es:ESHttpPut', 'es:ESHttpDelete'], Resource: `${domain.arn}/products/*` }];
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: 'StreamRole', PolicyName: 'source', PolicyDocument: policy(grants) }));
    await until(() => { tick(); return source()?.delivered === 1; }); assert.equal((await search.get({ index: 'products', id: 'one' })).body._version, 1);
    const streamArn = source()!.cursor!.streamArn;
    await ddb!.send(new Ddb.PutResourcePolicyCommand({ ResourceArn: streamArn, Policy: policy([{ Effect: 'Deny', Principal: '*', Action: 'dynamodb:GetRecords', Resource: streamArn }]) }));
    await put('one', 'updated'); await ddb!.send(new Ddb.DeleteItemCommand({ TableName: 'products', Key: { id: { S: 'one' } } })); await put('two', 'retained'); tick(); await until(() => source()?.status === 'RETRYING'); assert.equal(source()!.accepted, 1);
    clock.advance(15000); await ddb!.send(new Ddb.DeleteResourcePolicyCommand({ ResourceArn: streamArn }));
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: 'StreamRole', PolicyName: 'deny', PolicyDocument: policy([{ Effect: 'Deny', Action: ['es:ESHttpPut', 'es:ESHttpDelete'], Resource: `${domain.arn}/*` }]) }));
    await until(() => { tick(); return source()?.accepted === 4; }); assert.equal(source()!.cursor!.nextSequence, '2');
    await search.close(); search = undefined; osis!.destroy(); iam!.destroy(); ddb!.destroy(); await sim.stop(); sim = new StackSim(options); await sim.start(); connect(); search = client();
    await iam!.send(new Iam.DeleteRolePolicyCommand({ RoleName: 'StreamRole', PolicyName: 'deny' })); await until(() => { tick(); return source()?.delivered === 4; }); await search.indices.refresh({ index: 'products' }); assert.equal((await search.count({ index: 'products' })).body.count, 1); await assert.rejects(search.get({ index: 'products', id: 'one' })); assert.equal((await search.get({ index: 'products', id: 'two' })).body._version, 4);
    await assert.rejects(search.index({ index: 'products', id: 'one', version: 2, version_type: 'external', body: { title: 'stale' } }), (error: any) => error.statusCode === 409);
    const run = sim.opensearch.ingestion.pipeline(region, 'ddb-source').sourceRunId; await osis!.send(new Osis.StopPipelineCommand({ PipelineName: 'ddb-source' })); await until(() => sim.opensearch.ingestion.pipeline(region, 'ddb-source').status === 'STOPPED'); await put('three', 'while stopped'); await osis!.send(new Osis.StartPipelineCommand({ PipelineName: 'ddb-source' })); await until(() => sim.opensearch.ingestion.pipeline(region, 'ddb-source').status === 'ACTIVE'); await until(() => { tick(); return source()?.delivered === 5; }); assert.equal(sim.opensearch.ingestion.pipeline(region, 'ddb-source').sourceRunId, run);
    assert.deepEqual((await osis!.send(new Osis.GetPipelineCommand({ PipelineName: 'ddb-source' }))).Pipeline!.IngestEndpointUrls, []);
    const changed = configuration(`https://127.0.0.1:${domain.gatewayPort}`); changed.stream.source.dynamodb.tables[0].stream.start_position = 'LATEST'; await assert.rejects(osis!.send(new Osis.UpdatePipelineCommand({ PipelineName: 'ddb-source', PipelineConfigurationBody: JSON.stringify(changed) })), /immutable/);
    // Existing checkpoint is never silently reset when retention expires.
    await osis!.send(new Osis.StopPipelineCommand({ PipelineName: 'ddb-source' })); await until(() => sim.opensearch.ingestion.pipeline(region, 'ddb-source').status === 'STOPPED'); await put('expired', 'must not skip'); clock.advance(25 * 60 * 60 * 1000); osis!.config.systemClockOffset = clock.now() - Date.now(); await osis!.send(new Osis.StartPipelineCommand({ PipelineName: 'ddb-source' })); await until(() => sim.opensearch.ingestion.pipeline(region, 'ddb-source').status === 'ACTIVE'); tick(); await until(() => source()?.status === 'BLOCKED'); assert.match(source()!.failure!, /retention/);
  } finally { await search?.close(); osis?.destroy(); iam?.destroy(); ddb?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test('CloudFormation owns the DynamoDB producer chain and preserves stream position on capacity updates', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-ddb-cfn-')), sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'enforce' });
  let cfn: Cfn.CloudFormationClient | undefined, ddb: Ddb.DynamoDBClient | undefined, s3: S3.S3Client | undefined, search: Client | undefined;
  const template = (units = 1) => {
    const config = configuration('https://${Endpoint}'); config.stream.source.dynamodb.tables[0].stream.start_position = 'LATEST'; (config.stream.sink[0].opensearch as any).dlq = { s3: { bucket: 'stream-failures', region, sts_role_arn: role } };
    const PipelineConfigurationBody = { 'Fn::Sub': [JSON.stringify(config).replaceAll(role, '${Role}').replaceAll('${getMetadata', '${!getMetadata'), { Endpoint: { 'Fn::GetAtt': ['Domain', 'DomainEndpoint'] }, Role: { 'Fn::GetAtt': ['Role', 'Arn'] } }] };
    return JSON.stringify({ Resources: {
      Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'stream-failures' } },
      Table: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'products', BillingMode: 'PAY_PER_REQUEST', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }], StreamSpecification: { StreamViewType: 'NEW_IMAGE' } } },
      Domain: { Type: 'AWS::OpenSearchService::Domain', Properties: { DomainName: 'cfn-source-domain' } },
      Role: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'osis-pipelines.amazonaws.com' } }] }, Policies: [{ PolicyName: 'stream', PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:PutObject', Resource: 'arn:aws:s3:::stream-failures/*' }, { Effect: 'Allow', Action: 'dynamodb:DescribeTable', Resource: { 'Fn::GetAtt': ['Table', 'Arn'] } }, { Effect: 'Allow', Action: ['dynamodb:DescribeStream', 'dynamodb:GetShardIterator', 'dynamodb:GetRecords'], Resource: { 'Fn::GetAtt': ['Table', 'StreamArn'] } }, { Effect: 'Allow', Action: 'es:DescribeDomain', Resource: { 'Fn::GetAtt': ['Domain', 'Arn'] } }, { Effect: 'Allow', Action: ['es:ESHttpPut', 'es:ESHttpDelete'], Resource: { 'Fn::Sub': '${Domain.Arn}/products/*' } }] } }] } },
      Pipeline: { Type: 'AWS::OSIS::Pipeline', DependsOn: ['Table', 'Bucket'], Properties: { PipelineName: 'cfn-ddb-source', MinUnits: 1, MaxUnits: units, PipelineConfigurationBody } },
    }, Outputs: { Name: { Value: { Ref: 'Pipeline' } }, Endpoints: { Value: { 'Fn::Join': [',', { 'Fn::GetAtt': ['Pipeline', 'IngestEndpointUrls'] }] } } } });
  };
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; cfn = new Cfn.CloudFormationClient(sdk); ddb = new Ddb.DynamoDBClient(sdk); s3 = new S3.S3Client({ ...sdk, forcePathStyle: true });
    const id = (await cfn.send(new Cfn.CreateStackCommand({ StackName: 'source-stack', TemplateBody: template(), Capabilities: ['CAPABILITY_NAMED_IAM'] }))).StackId!; let state: Cfn.Stack | undefined;
    const wait = (expected: string) => until(async () => { state = (await cfn!.send(new Cfn.DescribeStacksCommand({ StackName: id }))).Stacks![0]; assert.ok(!state.StackStatus?.includes('FAILED') && state.StackStatus !== 'ROLLBACK_COMPLETE', JSON.stringify(state)); return state.StackStatus === expected; });
    await wait('CREATE_COMPLETE'); assert.equal(state!.Outputs!.find(item => item.OutputKey === 'Endpoints')!.OutputValue, '');
    const pipeline = sim.opensearch.ingestion.pipeline(region, 'cfn-ddb-source'), buffer = (sim.opensearch.ingestion as any).buffers.get(pipeline.generation); await until(() => buffer.stream()?.status === 'READING');
    await ddb.send(new Ddb.PutItemCommand({ TableName: 'products', Item: { id: { S: 'one' }, title: { S: 'Stack stream source' } } })); await until(() => buffer.stream()?.delivered === 1);
    const domain = sim.opensearch.domain(region, 'cfn-source-domain'); search = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath!) }, ...AwsSigv4Signer({ region, service: 'es', getCredentials: async () => credentials }) }); assert.equal((await search.get({ index: 'products', id: 'one' })).body._source.title, 'Stack stream source');
    const run = pipeline.sourceRunId; await cfn.send(new Cfn.UpdateStackCommand({ StackName: id, TemplateBody: template(2), Capabilities: ['CAPABILITY_NAMED_IAM'] })); await wait('UPDATE_COMPLETE'); assert.equal(pipeline.sourceRunId, run); assert.equal(buffer.stream().accepted, 1); assert.equal((await search.get({ index: 'products', id: 'one' })).body._version, 1);
    await ddb.send(new Ddb.DeleteItemCommand({ TableName: 'products', Key: { id: { S: 'one' } } })); await until(() => buffer.stream()?.delivered === 2); await assert.rejects(search.get({ index: 'products', id: 'one' }));
    await search.indices.putMapping({ index: 'products', body: { properties: { price: { type: 'integer' } } } });
    await ddb.send(new Ddb.PutItemCommand({ TableName: 'products', Item: { id: { S: 'bad' }, price: { S: 'not a number' } } })); await until(() => buffer.stream()?.deadLettered === 1); assert.equal(buffer.stream().cursor.nextSequence, '4');
    const failureKey = (await s3.send(new S3.ListObjectsV2Command({ Bucket: 'stream-failures' }))).Contents![0].Key!; const failure = JSON.parse(await (await s3.send(new S3.GetObjectCommand({ Bucket: 'stream-failures', Key: failureKey }))).Body!.transformToString()); assert.equal(failure.metadata.opensearch_action, 'index'); assert.equal(failure.metadata.document_version, 3); assert.equal(failure.metadata.primary_key, 'bad'); assert.equal(failure.event.price, 'not a number');
    await s3.send(new S3.DeleteObjectCommand({ Bucket: 'stream-failures', Key: failureKey }));
    await search.close(); search = undefined; await cfn.send(new Cfn.DeleteStackCommand({ StackName: id })); await wait('DELETE_COMPLETE'); assert.equal(Object.keys(sim.opensearch.ingestion.state(region).pipelines).length, 0); assert.equal(sim.opensearch.domains(region).length, 0);
  } finally { await search?.close(); cfn?.destroy(); ddb?.destroy(); s3?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
