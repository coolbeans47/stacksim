import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as Osis from '@aws-sdk/client-osis';
import * as Iam from '@aws-sdk/client-iam';
import * as Ddb from '@aws-sdk/client-dynamodb';
import * as S3 from '@aws-sdk/client-s3';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { StackSim } from '../src/server.js';
import { TestClock } from '../src/core/clock.js';
import { parseIngestionConfig, renderIngestionFormat } from '../src/opensearch/ingestion/config.js';
import { dynamoEvents, pollDynamoSource, type DynamoSourceState } from '../src/opensearch/ingestion/dynamodb-source.js';
import { IngestionBuffer } from '../src/opensearch/ingestion/buffer.js';
import { readDynamoExport } from '../src/opensearch/ingestion/dynamodb-export.js';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { AwsError } from '../src/errors.js';

const region = 'eu-west-1', account = '000000000000', credentials = { accessKeyId: 'admin', secretAccessKey: 'password' }, role = `arn:aws:iam::${account}:role/StreamRole`, tableArn = `arn:aws:dynamodb:${region}:${account}:table/products`;
const policy = (Statement: any[]) => JSON.stringify({ Version: '2012-10-17', Statement });
function configuration(host = 'https://127.0.0.1:48000') { return { version: '2', stream: { source: { dynamodb: { aws: { region, sts_role_arn: role }, acknowledgments: true, tables: [{ table_arn: tableArn, stream: { start_position: 'LATEST' }, export: { s3_bucket: 'export-source', s3_prefix: 'initial/' } }] } }, sink: [{ opensearch: { hosts: [host], aws: { region, sts_role_arn: role }, index: 'products', document_id: '${getMetadata("primary_key")}', action: '${getMetadata("opensearch_action")}', document_version: '${getMetadata("document_version")}', document_version_type: 'external' } }] } }; }
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 500; i++) { if (await check()) return; await delay(10); } assert.fail('DynamoDB ingestion did not reach expected state'); }

test('DynamoDB export reader verifies manifests, checksums and typed data and rejects changed export pages', async () => {
  const prefix = 'initial/AWSDynamoDB/job/', description = { ExportStatus: 'COMPLETED', ExportFormat: 'DYNAMODB_JSON', ExportType: 'FULL_EXPORT', ExportArn: `${tableArn}/export/job`, TableArn: tableArn, TableId: 'table-id', S3Bucket: 'export-source', ItemCount: 1, ExportManifest: `${prefix}manifest-summary.json` };
  const compressed = gzipSync(Buffer.from('{"Item":{"id":{"S":"one"},"price":{"N":"1.5"}}}\n'));
  const files = Buffer.from(JSON.stringify({ itemCount: 1, md5Checksum: createHash('md5').update(compressed).digest('base64'), dataFileS3Key: `${prefix}data/data.json.gz` }) + '\n');
  const summary = Buffer.from(JSON.stringify({ exportArn: description.ExportArn, tableArn, tableId: description.TableId, s3Bucket: description.S3Bucket, itemCount: 1, outputFormat: 'DYNAMODB_JSON', manifestFilesS3Key: `${prefix}manifest-files.json` }));
  const objects = new Map([[description.ExportManifest, summary], [`${prefix}manifest-summary.checksum`, Buffer.from(createHash('md5').update(summary).digest('hex'))], [`${prefix}manifest-files.json`, files], [`${prefix}manifest-files.checksum`, Buffer.from(createHash('md5').update(files).digest('hex'))], [`${prefix}data/data.json.gz`, compressed]]);
  const read = async (key: string) => objects.get(key)!;
  const parsed = await readDynamoExport(description, read); assert.equal(parsed.total, 1); assert.equal(parsed.items[0].price.N, '1.5');
  objects.set(`${prefix}data/data.json.gz`, gzipSync(Buffer.from('bad'))); await assert.rejects(readDynamoExport(description, read), /checksum/); objects.set(`${prefix}data/data.json.gz`, compressed);
  await assert.rejects(readDynamoExport({ ...description, TableId: 'different' }, read), /summary/);
  await assert.rejects(readDynamoExport({ ...description, ItemCount: 1001 }, read), /1000/);
  const root = await mkdtemp(join(tmpdir(), 'stacksim-export-checkpoint-')), buffer = new IngestionBuffer(join(root, 'events.enc'), join(root, 'key'));
  try {
    const config = parseIngestionConfig(JSON.stringify(configuration())), pipeline: any = { config, sourceRunId: 'run' }, cursor = { streamArn: `${tableArn}/stream/current`, shardId: 'shard', nextSequence: '1', keys: ['id'] };
    const state: DynamoSourceState = { runId: 'run', startedAt: 0, updatedAt: 0, status: 'EXPORTING', cursor, export: { token: 'token', time: 0, version: 0, arn: description.ExportArn, offset: 0, digest: '0'.repeat(64) }, accepted: 0, delivered: 0, deadLettered: 0 }; buffer.saveStream(state);
    await pollDynamoSource(pipeline, buffer, { validate() {}, open: async () => cursor, read: async () => { throw new Error('CDC must wait'); }, startExport: async () => description.ExportArn, readExport: async () => parsed }, async () => ({}) as any, () => 1, () => true);
    assert.equal(buffer.stream()!.status, 'BLOCKED'); assert.equal(buffer.stream()!.accepted, 0);
    const valid = configuration(); assert.equal(parseIngestionConfig(JSON.stringify(valid)).dynamodb!.export!.bucket, 'export-source'); valid.stream.source.dynamodb.tables[0].stream.start_position = 'TRIM_HORIZON'; assert.throws(() => parseIngestionConfig(JSON.stringify(valid)), /LATEST/);
  } finally { buffer.close(); await rm(root, { recursive: true, force: true }); }
});

test('DynamoDB initial export uses actual S3 artifacts and resumes before CDC with concurrent updates/deletes and version-zero snapshots', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-ddb-export-source-')), clock = new TestClock(Date.now()), options = { port: 0, invokePort: 0, dataDir: root, region, clock, authMode: 'enforce' as const, cdkBootstrap: false };
  let sim = new StackSim(options), osis: Osis.OSISClient | undefined, iam: Iam.IAMClient | undefined, ddb: Ddb.DynamoDBClient | undefined, s3: S3.S3Client | undefined, search: Client | undefined;
  const connect = () => { const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; osis = new Osis.OSISClient(sdk); iam = new Iam.IAMClient(sdk); ddb = new Ddb.DynamoDBClient(sdk); s3 = new S3.S3Client({ ...sdk, forcePathStyle: true }); };
  const disconnect = () => { osis?.destroy(); iam?.destroy(); ddb?.destroy(); s3?.destroy(); };
  const source = () => (sim.opensearch.ingestion as any).buffers.get(sim.opensearch.ingestion.pipeline(region, 'ddb-source').generation).stream() as DynamoSourceState | undefined, tick = () => clock.advance(1000);
  const put = (id: string, title: string) => ddb!.send(new Ddb.PutItemCommand({ TableName: 'products', Item: { id: { S: id }, title: { S: title } } }));
  try {
    await sim.start(); connect(); await sim.opensearch.execute('CreateDomain', { DomainName: 'stream-search' }, region); await until(() => sim.opensearch.domain(region, 'stream-search').state === 'active'); const domain = sim.opensearch.domain(region, 'stream-search'), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath!);
    const client = () => new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: 'es', getCredentials: async () => credentials }) }); search = client();
    await ddb!.send(new Ddb.CreateTableCommand({ TableName: 'products', BillingMode: 'PAY_PER_REQUEST', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }] }));
    await until(async () => { tick(); return (await ddb!.send(new Ddb.DescribeTableCommand({ TableName: 'products' }))).Table!.TableStatus === 'ACTIVE'; });
    for (let start = 0; start < 120; start += 20) await ddb!.send(new Ddb.BatchWriteItemCommand({ RequestItems: { products: Array.from({ length: 20 }, (_, offset) => ({ PutRequest: { Item: { id: { S: String(start + offset) }, title: { S: 'original snapshot' } } } })) } }));
    await ddb!.send(new Ddb.UpdateContinuousBackupsCommand({ TableName: 'products', PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }));
    await ddb!.send(new Ddb.UpdateTableCommand({ TableName: 'products', StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' } })); await until(async () => { tick(); return (await ddb!.send(new Ddb.DescribeTableCommand({ TableName: 'products' }))).Table!.TableStatus === 'ACTIVE'; });
    await s3!.send(new S3.CreateBucketCommand({ Bucket: 'export-source', CreateBucketConfiguration: { LocationConstraint: region } }));
    await s3!.send(new S3.PutBucketPolicyCommand({ Bucket: 'export-source', Policy: policy([{ Effect: 'Allow', Principal: { Service: 'dynamodb.amazonaws.com' }, Action: ['s3:PutObject'], Resource: 'arn:aws:s3:::export-source/initial/*', Condition: { ArnEquals: { 'aws:SourceArn': tableArn }, StringEquals: { 'aws:SourceAccount': account } } }]) }));
    await iam!.send(new Iam.CreateRoleCommand({ RoleName: 'StreamRole', AssumeRolePolicyDocument: policy([{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'osis-pipelines.amazonaws.com' } }]) }));
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: 'StreamRole', PolicyName: 'source', PolicyDocument: policy([{ Effect: 'Allow', Action: ['dynamodb:DescribeTable', 'dynamodb:DescribeContinuousBackups', 'dynamodb:ExportTableToPointInTime'], Resource: tableArn }, { Effect: 'Allow', Action: 'dynamodb:DescribeExport', Resource: `${tableArn}/export/*` }, { Effect: 'Allow', Action: ['dynamodb:DescribeStream', 'dynamodb:GetShardIterator', 'dynamodb:GetRecords'], Resource: `${tableArn}/stream/*` }, { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: 'arn:aws:s3:::export-source/initial/*' }, { Effect: 'Allow', Action: 'es:DescribeDomain', Resource: domain.arn }, { Effect: 'Allow', Action: ['es:ESHttpPut', 'es:ESHttpDelete'], Resource: `${domain.arn}/products/*` }]) }));
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: 'StreamRole', PolicyName: 'pause', PolicyDocument: policy([{ Effect: 'Deny', Action: ['s3:GetObject', 's3:PutObject', 'es:ESHttpPut'], Resource: '*' }]) }));
    const port = (sim.opensearch.ingestion as any).ports.dynamoSource, startExport = port.startExport.bind(port); let concurrent = false;
    port.startExport = async (...args: any[]) => { const arn = await startExport(...args); if (!concurrent) { concurrent = true; await put('0', 'changed during export'); await ddb!.send(new Ddb.DeleteItemCommand({ TableName: 'products', Key: { id: { S: '1' } } })); await put('new', 'inserted during export'); } return arn; };
    await osis!.send(new Osis.CreatePipelineCommand({ PipelineName: 'ddb-source', MinUnits: 1, MaxUnits: 2, PipelineConfigurationBody: JSON.stringify(configuration(`https://127.0.0.1:${domain.gatewayPort}`)) }));
    await until(() => { tick(); return source()?.status === 'RETRYING' && Boolean(source()?.cursor) && !source()?.export?.arn; }); assert.equal(Object.keys(sim.store.regionState(region).dynamodbExports).length, 0, 'Role destination denial prevents export publication');
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: 'StreamRole', PolicyName: 'pause', PolicyDocument: policy([{ Effect: 'Deny', Action: ['s3:GetObject', 'es:ESHttpPut'], Resource: '*' }]) }));
    await until(() => { tick(); return source()?.status === 'RETRYING' && Boolean(source()?.export?.arn); }); assert.equal(source()!.accepted, 0); assert.equal(source()!.export!.version, 0);
    const arn = source()!.export!.arn!; assert.equal((await ddb!.send(new Ddb.DescribeExportCommand({ ExportArn: arn }))).ExportDescription!.ExportStatus, 'COMPLETED');
    const objects = (await s3!.send(new S3.ListObjectsV2Command({ Bucket: 'export-source', Prefix: 'initial/' }))).Contents!; assert.equal(objects.length, 5); assert.ok(objects.some(object => object.Key!.endsWith('data.json.gz')));
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: 'StreamRole', PolicyName: 'pause', PolicyDocument: policy([{ Effect: 'Deny', Action: 'es:ESHttpPut', Resource: '*' }]) }));
    await until(() => { tick(); return source()?.accepted === 100; }); assert.equal(source()!.export!.offset, 0); assert.equal(BigInt(source()!.cursor!.nextSequence), 1n);
    await search.close(); search = undefined; disconnect(); await sim.stop(); sim = new StackSim(options); await sim.start(); connect(); search = client();
    await iam!.send(new Iam.DeleteRolePolicyCommand({ RoleName: 'StreamRole', PolicyName: 'pause' }));
    await until(() => { tick(); return source()?.delivered === 123; }); assert.equal(source()!.export!.completed, true); assert.equal(source()!.export!.offset, 120); assert.equal(source()!.export!.arn, arn); assert.equal(Object.keys(sim.store.regionState(region).dynamodbExports).length, 1);
    await search.indices.refresh({ index: 'products' }); assert.equal((await search.count({ index: 'products' })).body.count, 120);
    const first = (await search.get({ index: 'products', id: '0' })).body; assert.equal(first._source.title, 'changed during export'); assert.equal(first._version, 1); assert.equal((await search.get({ index: 'products', id: '2' })).body._version, 0); assert.equal((await search.get({ index: 'products', id: 'new' })).body._version, 3); await assert.rejects(search.get({ index: 'products', id: '1' }));
    await assert.rejects(search.index({ index: 'products', id: '1', version: 0, version_type: 'external', body: { title: 'stale export' } }), (error: any) => error.statusCode === 409);
    await osis!.send(new Osis.StopPipelineCommand({ PipelineName: 'ddb-source' })); await until(() => sim.opensearch.ingestion.pipeline(region, 'ddb-source').status === 'STOPPED'); await put('after', 'while stopped'); await osis!.send(new Osis.StartPipelineCommand({ PipelineName: 'ddb-source' })); await until(() => { tick(); return source()?.delivered === 124; }); assert.equal(Object.keys(sim.store.regionState(region).dynamodbExports).length, 1);
  } finally { await search?.close(); disconnect(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
