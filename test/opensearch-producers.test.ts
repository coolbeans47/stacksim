import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import * as Lambda from '@aws-sdk/client-lambda';
import * as Iam from '@aws-sdk/client-iam';
import * as Logs from '@aws-sdk/client-cloudwatch-logs';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
import { StackSim } from '../src/server.js';
import { createZip } from '../src/core/zip-create.js';
import { TestClock } from '../src/core/clock.js';
import { App, Stack } from 'aws-cdk-lib';
import * as Cfn from '@aws-sdk/client-cloudformation';
import * as S3 from '@aws-sdk/client-s3';
import * as Sqs from '@aws-sdk/client-sqs';
import { createProducers } from '../examples/opensearch-producers/stack.js';

const region = 'eu-west-1', credentials = { accessKeyId: 'admin', secretAccessKey: 'password' };
const source = join(process.cwd(), 'examples/opensearch-producers/handler.cjs');
async function until(read: () => boolean | Promise<boolean>) { for (let i = 0; i < 600; i++) { if (await read()) return; await delay(20); } assert.fail('Producer did not reach expected state'); }
async function code() { const bundle = await build({ entryPoints: [source], bundle: true, platform: 'node', target: 'node22', format: 'cjs', write: false }); return createZip([{ name: 'index.js', content: Buffer.from(bundle.outputFiles[0].contents) }]); }
const policy = (statements: any[]) => JSON.stringify({ Version: '2012-10-17', Statement: statements });

test('Lambda signs actual discovered OpenSearch requests with its role; IAM, FGAC, TLS and restart apply', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-search-lambda-')), options = { port: 0, invokePort: 0, dataDir: root, region, authMode: 'enforce' as const, cdkBootstrap: false };
  let sim = new StackSim(options), lambda: Lambda.LambdaClient, iam: Iam.IAMClient, search: Client | undefined;
  const connect = () => { const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; lambda = new Lambda.LambdaClient(sdk); iam = new Iam.IAMClient(sdk); };
  try {
    await sim.start(); connect();
    await sim.opensearch.execute('CreateDomain', { DomainName: 'lambda-search', EncryptionAtRestOptions: { Enabled: true }, NodeToNodeEncryptionOptions: { Enabled: true }, AdvancedSecurityOptions: { Enabled: true, MasterUserOptions: { MasterUserARN: 'arn:aws:iam::000000000000:user/admin' } } }, region);
    await until(() => sim.opensearch.domain(region, 'lambda-search').state === 'active'); const domain = sim.opensearch.domain(region, 'lambda-search');
    const ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath!, 'utf8');
    search = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: 'es', getCredentials: async () => credentials }) });
    const role = (await iam!.send(new Iam.CreateRoleCommand({ RoleName: 'SearchFunction', AssumeRolePolicyDocument: policy([{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' } }]) }))).Role!;
    const grant = [{ Effect: 'Allow', Action: 'es:DescribeDomain', Resource: domain.arn }, { Effect: 'Allow', Action: ['es:ESHttpGet', 'es:ESHttpPost', 'es:ESHttpPut', 'es:ESHttpDelete'], Resource: `${domain.arn}/products/*` }];
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: role.RoleName!, PolicyName: 'search', PolicyDocument: policy(grant) }));
    await lambda!.send(new Lambda.CreateFunctionCommand({ FunctionName: 'search-product', Runtime: 'nodejs22.x', Role: role.Arn!, Handler: 'index.product', Timeout: 15, Code: { ZipFile: await code() }, Environment: { Variables: { SEARCH_DOMAIN: domain.name, SEARCH_CA_PEM: ca } } }));
    const invoke = async (event: any) => { const result = await lambda!.send(new Lambda.InvokeCommand({ FunctionName: 'search-product', Payload: Buffer.from(JSON.stringify(event)) })); return { error: result.FunctionError, body: JSON.parse(Buffer.from(result.Payload!).toString()) }; };
    assert.ok((await invoke({ operation: 'put', id: 'one', document: { title: 'Red shoes', secret: 'private' } })).error, 'IAM does not bypass FGAC');
    await search.transport.request({ method: 'PUT', path: '/_plugins/_security/api/roles/product', body: { cluster_permissions: [], index_permissions: [{ index_patterns: ['products'], allowed_actions: ['crud', 'create_index'] }] } });
    await search.transport.request({ method: 'PUT', path: '/_plugins/_security/api/rolesmapping/product', body: { backend_roles: [role.Arn] } });
    const written = await invoke({ operation: 'put', id: 'one', document: { title: 'Red shoes', secret: 'private' } }); assert.equal(written.error, undefined, JSON.stringify(written.body)); assert.equal(written.body.result, 'created');
    assert.equal((await invoke({ operation: 'search', text: 'shoes' })).body.hits.total.value, 1);
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: role.RoleName!, PolicyName: 'deny', PolicyDocument: policy([{ Effect: 'Deny', Action: 'es:ESHttpPut', Resource: `${domain.arn}/*` }]) }));
    assert.ok((await invoke({ operation: 'put', id: 'one', document: { title: 'Denied' } })).error); assert.equal((await search.get({ index: 'products', id: 'one' })).body._version, 1);
    await iam!.send(new Iam.DeleteRolePolicyCommand({ RoleName: role.RoleName!, PolicyName: 'deny' }));
    await search.transport.request({ method: 'PUT', path: '/_plugins/_security/api/roles/product', body: { cluster_permissions: [], index_permissions: [{ index_patterns: ['products'], allowed_actions: ['read'], fls: ['~secret'] }] } });
    assert.deepEqual((await invoke({ operation: 'get', id: 'one' })).body._source, { title: 'Red shoes' });
    await lambda!.send(new Lambda.UpdateFunctionConfigurationCommand({ FunctionName: 'search-product', Environment: { Variables: { SEARCH_DOMAIN: domain.name } } }));
    const tls = await invoke({ operation: 'get', id: 'one' }); assert.ok(tls.error); assert.match(JSON.stringify(tls.body), /certificate|issuer|self.signed/i);
    await lambda!.send(new Lambda.UpdateFunctionConfigurationCommand({ FunctionName: 'search-product', Environment: { Variables: { SEARCH_DOMAIN: domain.name, SEARCH_CA_PEM: ca } } }));
    await search.close(); search = undefined; lambda!.destroy(); iam!.destroy(); await sim.stop(); sim = new StackSim(options); await sim.start(); connect();
    assert.deepEqual((await invoke({ operation: 'get', id: 'one' })).body._source, { title: 'Red shoes' });
    await sim.opensearch.execute('DeleteDomain', { DomainName: domain.name }, region); assert.ok((await invoke({ operation: 'get', id: 'one' })).error);
  } finally { await search?.close(); lambda!?.destroy(); iam!?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test('The producer CDK stack deploys real companions and sends failed bulk items to its SQS DLQ', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-search-producers-cfn-')), sim = new StackSim({ port: 0, invokePort: 0, dataDir: join(root, 'state'), region, authMode: 'enforce', cdkBootstrap: true });
  const clients: Array<{ destroy(): void }> = []; let search: Client | undefined;
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 };
    const cfn = new Cfn.CloudFormationClient(sdk), s3 = new S3.S3Client({ ...sdk, forcePathStyle: true }), lambda = new Lambda.LambdaClient(sdk), logs = new Logs.CloudWatchLogsClient(sdk), sqs = new Sqs.SQSClient(sdk); clients.push(cfn, s3, lambda, logs, sqs);
    const ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath!, 'utf8'), bundle = join(root, 'bundle'); await mkdir(bundle);
    const built = await build({ entryPoints: [source], bundle: true, platform: 'node', target: 'node22', format: 'cjs', write: false }); const bytes = Buffer.from(built.outputFiles[0].contents); await writeFile(join(bundle, 'index.js'), bytes);
    const app = new App({ outdir: join(root, 'cdk.out') }), stack = new Stack(app, 'SearchProducers', { env: { account: sim.store.accountId, region } }); createProducers(stack, bundle, ca);
    const assembly = app.synth(), template = assembly.getStackArtifact(stack.artifactId).template, manifest = JSON.parse(await readFile(join(assembly.directory, 'SearchProducers.assets.json'), 'utf8'));
    for (const asset of Object.values<any>(manifest.files)) if (asset.source.packaging === 'zip') for (const destination of Object.values<any>(asset.destinations)) await s3.send(new S3.PutObjectCommand({ Bucket: destination.bucketName, Key: destination.objectKey, Body: createZip([{ name: 'index.js', content: bytes }]) }));
    const stackId = (await cfn.send(new Cfn.CreateStackCommand({ StackName: 'search-producers', TemplateBody: JSON.stringify(template), Capabilities: ['CAPABILITY_NAMED_IAM'] }))).StackId!;
    let state: Cfn.Stack | undefined;
    const wait = async (expected: string) => until(async () => { state = (await cfn.send(new Cfn.DescribeStacksCommand({ StackName: stackId }))).Stacks![0]; assert.ok(!state.StackStatus?.endsWith('FAILED') && state.StackStatus !== 'ROLLBACK_COMPLETE', JSON.stringify(state)); return state.StackStatus === expected; });
    await wait('CREATE_COMPLETE'); const outputs = Object.fromEntries(state!.Outputs!.map(item => [item.OutputKey!, item.OutputValue!]));
    search = new Client({ node: `https://${outputs.Endpoint}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: 'es', getCredentials: async () => credentials }) });
    const put = await lambda.send(new Lambda.InvokeCommand({ FunctionName: outputs.ProductFunction, Payload: Buffer.from('{"operation":"put","id":"stack","document":{"title":"CDK product"}}') })); assert.equal(put.FunctionError, undefined, Buffer.from(put.Payload!).toString()); assert.equal((await search.get({ index: 'products', id: 'stack' })).body._source.title, 'CDK product');
    const index = `logs-${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}`;
    await search.indices.create({ index, body: { mappings: { properties: { message: { type: 'integer' } } } } });
    await lambda.send(new Lambda.PutFunctionEventInvokeConfigCommand({ FunctionName: outputs.LogsFunction, MaximumRetryAttempts: 0 }));
    await logs.send(new Logs.CreateLogStreamCommand({ logGroupName: outputs.SourceLogGroup, logStreamName: 'source' }));
    await logs.send(new Logs.PutLogEventsCommand({ logGroupName: outputs.SourceLogGroup, logStreamName: 'source', logEvents: [{ timestamp: Date.now(), message: 'This text fails the integer mapping' }] }));
    let messages: Sqs.Message[] | undefined;
    await until(async () => { messages = (await sqs.send(new Sqs.ReceiveMessageCommand({ QueueUrl: outputs.FailedLogBatches, MessageAttributeNames: ['All'] }))).Messages; return Boolean(messages?.length); });
    assert.match(messages![0].MessageAttributes!.ErrorMessage.StringValue!, /Search bulk failed.*status 400/); const payload = JSON.parse(messages![0].Body!); const envelope = JSON.parse((await import('node:zlib')).gunzipSync(Buffer.from(payload.awslogs.data, 'base64')).toString()); assert.equal(envelope.logEvents[0].message, 'This text fails the integer mapping');
    await search.close(); search = undefined; await cfn.send(new Cfn.DeleteStackCommand({ StackName: 'search-producers' })); await wait('DELETE_COMPLETE'); assert.equal(sim.opensearch.domains(region).length, 0);
    assert.equal((await lambda.send(new Lambda.ListFunctionsCommand({}))).Functions?.length, 0);
    await assert.rejects(logs.send(new Logs.DescribeSubscriptionFiltersCommand({ logGroupName: outputs.SourceLogGroup })), { name: 'ResourceNotFoundException' });
  } finally { await search?.close(); clients.forEach(client => client.destroy()); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});

test('CloudWatch Logs invokes the packaged transformer, indexes real events, and retries denied delivery across restart', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-search-logs-')), clock = new TestClock(Date.now()), options = { port: 0, invokePort: 0, dataDir: root, region, authMode: 'enforce' as const, cdkBootstrap: false, clock };
  let sim = new StackSim(options), lambda: Lambda.LambdaClient, iam: Iam.IAMClient, logs: Logs.CloudWatchLogsClient, search: Client | undefined;
  const connect = () => { const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials, maxAttempts: 1 }; lambda = new Lambda.LambdaClient(sdk); iam = new Iam.IAMClient(sdk); logs = new Logs.CloudWatchLogsClient(sdk); };
  try {
    await sim.start(); connect(); await sim.opensearch.execute('CreateDomain', { DomainName: 'logs-search' }, region); await until(() => sim.opensearch.domain(region, 'logs-search').state === 'active'); const domain = sim.opensearch.domain(region, 'logs-search');
    const ca = await readFile(sim.opensearch.diagnostics(region).caCertificatePath!, 'utf8');
    const client = () => new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca }, ...AwsSigv4Signer({ region, service: 'es', getCredentials: async () => credentials }) }); search = client();
    const role = (await iam!.send(new Iam.CreateRoleCommand({ RoleName: 'LogSearch', AssumeRolePolicyDocument: policy([{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' } }]) }))).Role!;
    const grant = [{ Effect: 'Allow', Action: 'es:DescribeDomain', Resource: domain.arn }, { Effect: 'Allow', Action: 'es:ESHttpPut', Resource: `${domain.arn}/logs-*/*` }];
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: role.RoleName!, PolicyName: 'search', PolicyDocument: policy(grant) }));
    const fn = (await lambda!.send(new Lambda.CreateFunctionCommand({ FunctionName: 'logs-to-search', Runtime: 'nodejs22.x', Role: role.Arn!, Handler: 'index.logs', Timeout: 15, Code: { ZipFile: await code() }, Environment: { Variables: { SEARCH_DOMAIN: domain.name, SEARCH_CA_PEM: ca } } }))).FunctionArn!;
    await logs!.send(new Logs.CreateLogGroupCommand({ logGroupName: '/app/search-events' })); await logs!.send(new Logs.CreateLogStreamCommand({ logGroupName: '/app/search-events', logStreamName: 'first' }));
    const subscription = { logGroupName: '/app/search-events', filterName: 'search', filterPattern: '', destinationArn: fn };
    await assert.rejects(logs!.send(new Logs.PutSubscriptionFilterCommand(subscription)));
    await lambda!.send(new Lambda.AddPermissionCommand({ FunctionName: fn, StatementId: 'logs', Action: 'lambda:InvokeFunction', Principal: `logs.${region}.amazonaws.com`, SourceArn: `arn:aws:logs:${region}:000000000000:log-group:/app/search-events:*`, SourceAccount: '000000000000' }));
    await logs!.send(new Logs.PutSubscriptionFilterCommand(subscription));
    const write = (message: string) => logs!.send(new Logs.PutLogEventsCommand({ logGroupName: '/app/search-events', logStreamName: 'first', logEvents: [{ timestamp: clock.now(), message }] }));
    await write('first delivery'); clock.advance(1);
    const index = `logs-${new Date(clock.now()).toISOString().slice(0, 10).replace(/-/g, '.')}`;
    const count = async () => { try { await search!.indices.refresh({ index }); return (await search!.count({ index })).body.count; } catch { return 0; } };
    await until(async () => { clock.advance(1); const failed = Object.values(sim.store.regionState(region).lambdaAsyncInvocations).find(event => event.lastError); if (failed) assert.fail(failed.lastError); return await count() === 1; });
    let hit = (await search.search({ index })).body.hits.hits[0]; assert.equal(hit._source.message, 'first delivery'); assert.equal(hit._source.log_group, '/app/search-events');
    const replay = { awslogs: { data: gzipSync(Buffer.from(JSON.stringify({ messageType: 'DATA_MESSAGE', owner: '000000000000', logGroup: '/app/search-events', logStream: 'first', logEvents: [{ id: hit._source.event_id, timestamp: Date.parse(hit._source['@timestamp']), message: 'first delivery' }] }))).toString('base64') } };
    const duplicate = await lambda!.send(new Lambda.InvokeCommand({ FunctionName: fn, Payload: Buffer.from(JSON.stringify(replay)) })); assert.equal(duplicate.FunctionError, undefined, Buffer.from(duplicate.Payload!).toString()); assert.equal(await count(), 1, 'Retry uses the same document id');
    const control = await lambda!.send(new Lambda.InvokeCommand({ FunctionName: fn, Payload: Buffer.from(JSON.stringify({ awslogs: { data: gzipSync(Buffer.from('{"messageType":"CONTROL_MESSAGE"}')).toString('base64') } })) })); assert.equal(control.FunctionError, undefined);
    await iam!.send(new Iam.PutRolePolicyCommand({ RoleName: role.RoleName!, PolicyName: 'deny', PolicyDocument: policy([{ Effect: 'Deny', Action: 'es:ESHttpPut', Resource: `${domain.arn}/*` }]) }));
    await write('recovered delivery'); clock.advance(1); await until(() => { clock.advance(1); return Object.values(sim.store.regionState(region).lambdaAsyncInvocations).some(event => event.functionName === 'logs-to-search' && event.attempts === 1 && event.status === 'QUEUED'); }); assert.equal(await count(), 1);
    await search.close(); search = undefined; lambda!.destroy(); iam!.destroy(); logs!.destroy(); await sim.stop(); sim = new StackSim(options); await sim.start(); connect(); search = client();
    await iam!.send(new Iam.DeleteRolePolicyCommand({ RoleName: role.RoleName!, PolicyName: 'deny' })); clock.advance(61000);
    await until(async () => { clock.advance(1); return await count() === 2; });
    assert.equal((await search.count({ index, body: { query: { match: { message: 'recovered' } } } })).body.count, 1);
    await logs!.send(new Logs.DeleteSubscriptionFilterCommand({ logGroupName: subscription.logGroupName, filterName: subscription.filterName }));
    await lambda!.send(new Lambda.DeleteFunctionCommand({ FunctionName: fn }));
  } finally { await search?.close(); lambda!?.destroy(); iam!?.destroy(); logs!?.destroy(); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
