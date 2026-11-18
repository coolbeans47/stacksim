import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import * as Osis from '@aws-sdk/client-osis';
import * as Iam from '@aws-sdk/client-iam';
import * as S3 from '@aws-sdk/client-s3';
import * as Cfn from '@aws-sdk/client-cloudformation';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { parseIngestionConfig } from '../src/opensearch/ingestion/config.js';
import { parseS3Events, pollS3Source, type S3ScanState } from '../src/opensearch/ingestion/s3-source.js';
import { IngestionBuffer } from '../src/opensearch/ingestion/buffer.js';
import { StackSim } from '../src/server.js';
import { TestClock } from '../src/core/clock.js';
import { AwsError } from '../src/errors.js';

const region = 'eu-west-1', account = '000000000000', credentials = { accessKeyId: 'admin', secretAccessKey: 'password' }, role = `arn:aws:iam::${account}:role/ScanRole`;
function configuration(host = 'https://127.0.0.1:48000', extra: any = {}) { return { version: '2', scan: { source: { s3: { aws: { region, sts_role_arn: role }, acknowledgments: true, codec: { ndjson: {} }, compression: 'gzip', scan: { buckets: [{ bucket: { name: 'scan-source', filter: { include_prefix: ['events/'], exclude_suffix: ['.skip'] } } }] }, ...extra } }, processor: [{ add_entries: { entries: [{ key: 'source', value: 's3' }] } }], sink: [{ opensearch: { hosts: [host], aws: { region, sts_role_arn: role }, index: 'imported', document_id: '${/id}' } }] } }; }
const policy = (Statement: any[]) => JSON.stringify({ Version: '2012-10-17', Statement });
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 500; i++) { if (await check()) return; await delay(10); } assert.fail('S3 ingestion did not reach expected state'); }

test('S3 scan compiler and decoder enforce the executable source contract before admission', () => {
  const config = parseIngestionConfig(JSON.stringify(configuration())); assert.equal(config.s3!.bucket, 'scan-source'); assert.equal(config.s3!.prefix, 'events/');
  assert.deepEqual(parseS3Events(gzipSync(Buffer.from('{"id":"one"}\r\n\n{"id":"two"}\n')), config.s3!), [{ id: 'one' }, { id: 'two' }]);
  for (const extra of [{ acknowledgments: false }, { delete_s3_objects_on_read: true }, { codec: { csv: {} } }, { sqs: {} }, { compression: 'auto' }, { aws: { region: 'us-east-1' } }, { scan: { buckets: [], scheduling: {} } }, { scan: { buckets: configuration().scan.source.s3.scan.buckets, start_time: '2026-02-30T00:00:00Z' } }]) assert.throws(() => parseIngestionConfig(JSON.stringify(configuration(undefined, extra))));
  const ranged = parseIngestionConfig(JSON.stringify(configuration(undefined, { scan: { buckets: configuration().scan.source.s3.scan.buckets, range: 'PT15M' } }))); assert.equal(ranged.s3!.rangeMs, 900000);
  for (const text of ['{}\nnot json', '[]', 'null', Array.from({ length: 1001 }, () => '{}').join('\n')]) assert.throws(() => parseS3Events(gzipSync(Buffer.from(text)), config.s3!));
  assert.throws(() => parseS3Events(gzipSync(Buffer.from([0xff])), config.s3!));
  assert.throws(() => parseS3Events(gzipSync(Buffer.alloc(10 * 1024 * 1024 + 1)), config.s3!));
});

test('Encrypted source checkpoints commit with events, retain partial delivery, and recover failed admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-source-buffer-')), file = join(root, 'generation', 'buffer.enc'), key = join(root, 'keys', 'source.key'), config = parseIngestionConfig(JSON.stringify(configuration()));
  let buffer = new IngestionBuffer(file, key);
  const scan: S3ScanState = { runId: 'run', startedAt: 1, updatedAt: 1, status: 'READING', cursor: 0, accepted: 0, delivered: 0, deadLettered: 0, objects: [{ key: 'events/private-object', etag: 'etag', size: 1, lastModified: 1 }] };
  try {
    // Existing HTTP snapshots use this same table schema; introducing source
    // checkpoints does not require replacing or discarding acknowledged rows.
    buffer.accept([{ id: 'http' }], config, 1); buffer.close(); buffer = new IngestionBuffer(file, key); buffer.delivered(buffer.due(1, 1)[0].id);
    buffer.saveScan(scan); buffer.acceptScan([{ id: 'one', secret: 'source-sensitive-text' }, { id: 'two' }], config, 2, structuredClone(scan), 'object');
    assert.equal(buffer.stats().buffered, 2); buffer.delivered('object-0', false, 3); assert.equal(buffer.scan()!.cursor, 0); buffer.close(); buffer = new IngestionBuffer(file, key); assert.equal(buffer.scan()!.pending!.remaining, 1); assert.equal(buffer.due(10, 10).length, 1);
    buffer.delivered('object-1', true, 4); assert.equal(buffer.scan()!.status, 'COMPLETED_WITH_FAILURES'); assert.equal(buffer.scan()!.cursor, 1); assert.equal(buffer.stats().buffered, 0);
    const next = { ...scan, runId: 'next' }; buffer.saveScan(next);
    (buffer as any).storage.commit = () => { throw new Error('injected publication failure'); };
    assert.throws(() => buffer.acceptScan([{ id: 'unacknowledged' }], config, 5, structuredClone(next), 'failed')); buffer.close(); buffer = new IngestionBuffer(file, key); assert.equal(buffer.stats().buffered, 0); assert.equal(buffer.scan()!.accepted, 0);
    const check = async (directory: string): Promise<void> => { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await check(path); else { const bytes = await readFile(path); assert.equal(bytes.includes(Buffer.from('source-sensitive-text')), false); assert.equal(bytes.includes(Buffer.from('events/private-object')), false); } } }; await check(join(root, 'generation'));
  } finally { buffer.close(); await rm(root, { recursive: true, force: true }); }
});

test('S3 source honors frozen listings, filters, interrupted reads and retryable access failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-source-poll-')), buffer = new IngestionBuffer(join(root, 'generation', 'buffer.enc'), join(root, 'source.key'));
  let now = 10000, active = true, denied = true, reads = 0, lists = 0;
  const config = parseIngestionConfig(JSON.stringify(configuration(undefined, { scan: { buckets: configuration().scan.source.s3.scan.buckets, range: 'PT1S' } }))), pipeline = { config, sourceRunId: 'run' } as any;
  const objects = [{ key: 'events/old', etag: 'old', size: 10, lastModified: 1 }, { key: 'events/new', etag: 'new', size: 10, lastModified: 9999 }, { key: 'events/ignore.skip', etag: 'skip', size: 10, lastModified: 9999 }];
  const port = { validate() {}, async list() { lists++; if (denied) throw new AwsError('AccessDeniedException', 'private policy data', 403); return objects; }, async read() { reads++; return gzipSync(Buffer.from('{"id":"one"}')); } };
  const poll = () => pollS3Source(pipeline, buffer, port, async () => ({} as any), () => now, () => active);
  try {
    await poll(); assert.equal(buffer.scan()!.status, 'RETRYING'); assert.doesNotMatch(buffer.scan()!.failure!, /private policy/); denied = false; now += 1000; await poll(); assert.equal(buffer.scan()!.objects!.length, 1); assert.equal(buffer.scan()!.objects![0].key, 'events/new'); assert.equal(buffer.scan()!.pending!.remaining, 1);
    await poll(); assert.equal(reads, 1); assert.equal(lists, 2); buffer.delivered(buffer.due(now, 1)[0].id, false, now); await poll(); assert.equal(reads, 1); assert.equal(buffer.scan()!.status, 'COMPLETED');
    objects[1].lastModified = now - 1; pipeline.sourceRunId = 'new'; port.read = async () => { active = false; return gzipSync(Buffer.from('{"id":"interrupted"}')); }; await poll(); assert.equal(buffer.stats().buffered, 0); assert.equal(buffer.scan()!.status, 'READING');
    active = true; port.read = async () => { throw new AwsError('ConflictException', 'object changed', 409); }; await poll(); assert.equal(buffer.scan()!.status, 'BLOCKED'); assert.equal(buffer.stats().buffered, 0);
  } finally { buffer.close(); await rm(root, { recursive: true, force: true }); }
});

test('Official OSIS S3 sources read authorized versioned objects, resume buffered work, and expose failures', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-osis-s3-')), clock = new TestClock(Date.now()), options = { port: 0, invokePort: 0, dataDir: root, region, clock, authMode: 'enforce' as const, cdkBootstrap: false };
  let sim = new StackSim(options), osis: Osis.OSISClient, iam: Iam.IAMClient, s3: S3.S3Client, search: Client | undefined;
  const connect = () => { const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; osis = new Osis.OSISClient(sdk); iam = new Iam.IAMClient(sdk); s3 = new S3.S3Client({ ...sdk, forcePathStyle: true }); };
  const scan = () => (sim.opensearch.ingestion as any).buffers.get(sim.opensearch.ingestion.pipeline(region, 's3-source').generation).scan() as S3ScanState | undefined;
  const tick = () => clock.advance(1000);
  try {
    await sim.start(); connect(); await sim.opensearch.execute('CreateDomain', { DomainName: 'source-search' }, region); await until(() => sim.opensearch.domain(region, 'source-search').state === 'active'); const domain = sim.opensearch.domain(region, 'source-search'), ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath!);
    const client = () => new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: 'es', getCredentials: async () => credentials }) }); search = client();
    await iam!.send(new Iam.CreateRoleCommand({ RoleName: 'ScanRole', AssumeRolePolicyDocument: policy([{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'osis-pipelines.amazonaws.com' }, Condition: { ArnEquals: { 'aws:SourceArn': `arn:aws:osis:${region}:${account}:pipeline/s3-source` } } }]) }));
    await s3!.send(new S3.CreateBucketCommand({ Bucket: 'scan-source', CreateBucketConfiguration: { LocationConstraint: region } })); await s3!.send(new S3.PutBucketVersioningCommand({ Bucket: 'scan-source', VersioningConfiguration: { Status: 'Enabled' } }));
    const input = { PipelineName: 's3-source', MinUnits: 1, MaxUnits: 2, PipelineConfigurationBody: JSON.stringify(configuration(`https://127.0.0.1:${domain.gatewayPort}`)) };
    assert.equal((await osis!.send(new Osis.ValidatePipelineCommand({ PipelineConfigurationBody: input.PipelineConfigurationBody }))).isValid, true);
    await s3!.send(new S3.PutObjectCommand({ Bucket: 'scan-source', Key: 'events/a.gz', Body: gzipSync(Buffer.from(Array.from({ length: 15 }, (_, id) => JSON.stringify({ id: String(id), message: 'from encrypted source buffer' })).join('\n'))) }));
    await s3!.send(new S3.PutObjectCommand({ Bucket: 'scan-source', Key: 'events/b.skip', Body: 'ignored invalid bytes' })); await s3!.send(new S3.PutObjectCommand({ Bucket: 'scan-source', Key: 'other/ignored', Body: 'ignored invalid bytes' }));
    await osis!.send(new Osis.CreatePipelineCommand(input)); await until(() => sim.opensearch.ingestion.pipeline(region, 's3-source').status === 'ACTIVE'); await until(() => { tick(); return scan()?.status === 'RETRYING'; }); assert.equal(scan()!.accepted, 0);
    const grants = [{ Effect: 'Allow', Action: 's3:ListBucket', Resource: 'arn:aws:s3:::scan-source', Condition: { StringEquals: { 's3:prefix': 'events/' } } }, { Effect: 'Allow', Action: 's3:GetObjectVersion', Resource: 'arn:aws:s3:::scan-source/events/*' }, { Effect: 'Allow', Action: 'es:DescribeDomain', Resource: domain.arn }, { Effect: 'Allow', Action: 'es:ESHttpPut', Resource: `${domain.arn}/imported/*` }];
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: 'ScanRole', PolicyName: 'source', PolicyDocument: policy(grants) }));
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: 'ScanRole', PolicyName: 'deny', PolicyDocument: policy([{ Effect: 'Deny', Action: 'es:ESHttpPut', Resource: `${domain.arn}/*` }]) }));
    tick(); await until(() => scan()?.accepted === 15); assert.equal(scan()!.cursor, 0); assert.equal((await osis!.send(new Osis.GetPipelineCommand({ PipelineName: 's3-source' }))).Pipeline!.IngestEndpointUrls?.length, 0);
    await search.close(); search = undefined; osis!.destroy(); iam!.destroy(); s3!.destroy(); await sim.stop(); sim = new StackSim(options); await sim.start(); connect(); search = client();
    await iam!.send(new Iam.DeleteRolePolicyCommand({ RoleName: 'ScanRole', PolicyName: 'deny' })); await until(() => { tick(); return scan()?.status === 'COMPLETED'; }); assert.equal(scan()!.accepted, 15); assert.equal(scan()!.cursor, 1); await search.indices.refresh({ index: 'imported' }); assert.equal((await search.count({ index: 'imported' })).body.count, 15); assert.equal((await search.get({ index: 'imported', id: '0' })).body._source.source, 's3');
    // Explicit bucket denies are rechecked on the next scan; a process restart
    // above resumed the old scan without replaying already acknowledged rows.
    await s3!.send(new S3.PutBucketPolicyCommand({ Bucket: 'scan-source', Policy: policy([{ Effect: 'Deny', Principal: '*', Action: 's3:GetObjectVersion', Resource: 'arn:aws:s3:::scan-source/*' }]) }));
    await osis!.send(new Osis.StopPipelineCommand({ PipelineName: 's3-source' })); await until(() => sim.opensearch.ingestion.pipeline(region, 's3-source').status === 'STOPPED'); await osis!.send(new Osis.StartPipelineCommand({ PipelineName: 's3-source' })); await until(() => sim.opensearch.ingestion.pipeline(region, 's3-source').status === 'ACTIVE'); await until(() => { tick(); return scan()?.status === 'RETRYING'; }); assert.equal(scan()!.accepted, 0);
    await s3!.send(new S3.DeleteBucketPolicyCommand({ Bucket: 'scan-source' })); await until(() => { tick(); return scan()?.status === 'COMPLETED'; }); await search.indices.refresh({ index: 'imported' }); assert.equal((await search.count({ index: 'imported' })).body.count, 15, 'document_id makes explicit reruns upserts');
    await s3!.send(new S3.PutObjectCommand({ Bucket: 'scan-source', Key: 'events/bad.gz', Body: gzipSync(Buffer.from('{}\nmalformed')) })); await osis!.send(new Osis.StopPipelineCommand({ PipelineName: 's3-source' })); await until(() => sim.opensearch.ingestion.pipeline(region, 's3-source').status === 'STOPPED'); await osis!.send(new Osis.StartPipelineCommand({ PipelineName: 's3-source' })); await until(() => sim.opensearch.ingestion.pipeline(region, 's3-source').status === 'ACTIVE'); await until(() => { tick(); return scan()?.status === 'BLOCKED'; }); assert.equal(scan()!.accepted, 15, 'Malformed object is rejected before any of its events are admitted');
    await osis!.send(new Osis.DeletePipelineCommand({ PipelineName: 's3-source' })); await until(() => !sim.opensearch.ingestion.state(region).pipelines['s3-source']); assert.equal((await search.get({ index: 'imported', id: '0' })).body._source.message, 'from encrypted source buffer');
  } finally { await search?.close(); osis!?.destroy(); iam!?.destroy(); s3!?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test('CloudFormation owns S3 scan configuration, exposes no HTTP intake and updates the real source', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-source-cfn-')), sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: 'enforce', cdkBootstrap: false });
  let cfn: Cfn.CloudFormationClient | undefined, s3: S3.S3Client | undefined, search: Client | undefined;
  const template = (prefix = 'events/', units = 1) => {
    const config = configuration('https://${Endpoint}', { aws: { region, sts_role_arn: '${Role}' }, compression: 'none', scan: { buckets: [{ bucket: { name: 'cfn-source', filter: { include_prefix: [prefix] } } }] } });
    const PipelineConfigurationBody = { 'Fn::Sub': [JSON.stringify(config).replaceAll(role, '${Role}').replaceAll('${/id}', '${!/id}'), { Endpoint: { 'Fn::GetAtt': ['Domain', 'DomainEndpoint'] }, Role: { 'Fn::GetAtt': ['Role', 'Arn'] } }] };
    return JSON.stringify({ Resources: {
      Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'cfn-source' } },
      Domain: { Type: 'AWS::OpenSearchService::Domain', Properties: { DomainName: 'cfn-source-domain' } },
      Role: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'osis-pipelines.amazonaws.com' } }] }, Policies: [{ PolicyName: 'scan', PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:ListBucket', Resource: 'arn:aws:s3:::cfn-source' }, { Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::cfn-source/*' }, { Effect: 'Allow', Action: 'es:DescribeDomain', Resource: { 'Fn::GetAtt': ['Domain', 'Arn'] } }, { Effect: 'Allow', Action: 'es:ESHttpPut', Resource: { 'Fn::Sub': '${Domain.Arn}/imported/*' } }] } }] } },
      Pipeline: { Type: 'AWS::OSIS::Pipeline', DependsOn: ['Bucket'], Properties: { PipelineName: 'cfn-s3-source', MinUnits: 1, MaxUnits: units, PipelineConfigurationBody } },
    }, Outputs: { Name: { Value: { Ref: 'Pipeline' } }, Endpoints: { Value: { 'Fn::Join': [',', { 'Fn::GetAtt': ['Pipeline', 'IngestEndpointUrls'] }] } } } });
  };
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; cfn = new Cfn.CloudFormationClient(sdk); s3 = new S3.S3Client({ ...sdk, forcePathStyle: true });
    const id = (await cfn.send(new Cfn.CreateStackCommand({ StackName: 'source-stack', TemplateBody: template(), Capabilities: ['CAPABILITY_NAMED_IAM'] }))).StackId!; let state: Cfn.Stack | undefined;
    const wait = (expected: string) => until(async () => { state = (await cfn!.send(new Cfn.DescribeStacksCommand({ StackName: id }))).Stacks![0]; assert.ok(!state.StackStatus?.includes('FAILED') && state.StackStatus !== 'ROLLBACK_COMPLETE', JSON.stringify(state)); return state.StackStatus === expected; });
    await wait('CREATE_COMPLETE'); assert.equal(state!.Outputs!.find(item => item.OutputKey === 'Endpoints')!.OutputValue, '');
    const pipeline = sim.opensearch.ingestion.pipeline(region, 'cfn-s3-source'), buffer = (sim.opensearch.ingestion as any).buffers.get(pipeline.generation); await until(() => buffer.scan()?.status === 'COMPLETED'); const initialRun = pipeline.sourceRunId;
    await s3.send(new S3.PutObjectCommand({ Bucket: 'cfn-source', Key: 'events/new/one', Body: '{"id":"one","title":"Stack source"}\n' }));
    await cfn.send(new Cfn.UpdateStackCommand({ StackName: id, TemplateBody: template('events/new/'), Capabilities: ['CAPABILITY_NAMED_IAM'] })); await wait('UPDATE_COMPLETE'); assert.notEqual(pipeline.sourceRunId, initialRun); await until(() => buffer.scan()?.status === 'COMPLETED' && buffer.scan()?.accepted === 1);
    const domain = sim.opensearch.domain(region, 'cfn-source-domain'); search = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath!) }, ...AwsSigv4Signer({ region, service: 'es', getCredentials: async () => credentials }) }); assert.equal((await search.get({ index: 'imported', id: 'one' })).body._source.title, 'Stack source');
    const run = pipeline.sourceRunId; await cfn.send(new Cfn.UpdateStackCommand({ StackName: id, TemplateBody: template('events/new/', 2), Capabilities: ['CAPABILITY_NAMED_IAM'] })); await wait('UPDATE_COMPLETE'); assert.equal(pipeline.sourceRunId, run); assert.equal((await search.get({ index: 'imported', id: 'one' })).body._version, 1);
    await search.close(); search = undefined; await s3.send(new S3.DeleteObjectCommand({ Bucket: 'cfn-source', Key: 'events/new/one' })); await cfn.send(new Cfn.DeleteStackCommand({ StackName: id })); await wait('DELETE_COMPLETE'); assert.equal(Object.keys(sim.opensearch.ingestion.state(region).pipelines).length, 0); assert.equal(sim.opensearch.domains(region).length, 0);
  } finally { await search?.close(); cfn?.destroy(); s3?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
