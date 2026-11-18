import * as Aoss from '@aws-sdk/client-opensearchserverless';
import * as Iam from '@aws-sdk/client-iam';
import { setTimeout as delay } from 'node:timers/promises';
import { StackSim } from '../../src/server.js';
import { TestClock } from '../../src/core/clock.js';

const [root, boundary] = process.argv.slice(2), region = 'eu-west-1', clock = new TestClock(Date.now()), sim = new StackSim({ dataDir: root, region, clock, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'off' }); await sim.start();
const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: 'admin', secretAccessKey: 'password' }, maxAttempts: 1 }, aoss = new Aoss.OpenSearchServerlessClient(config), iam = new Iam.IAMClient(config);
await aoss.send(new Aoss.CreateSecurityPolicyCommand({ name: 'crash-direct', type: 'encryption', policy: JSON.stringify({ Rules: [{ ResourceType: 'collection', Resource: ['collection/crash-direct'] }], AWSOwnedKey: true }) }));
const collection = (await aoss.send(new Aoss.CreateCollectionCommand({ name: 'crash-direct', type: 'SEARCH' }))).createCollectionDetail!;
while (sim.opensearch.serverless.state(region).collections[collection.id!].status !== 'ACTIVE') { clock.advance(25); await delay(2); }
const role = (await iam.send(new Iam.CreateRoleCommand({ RoleName: 'DirectCrashRole', AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'directquery.opensearchservice.amazonaws.com' }, Action: 'sts:AssumeRole' }] }) }))).Role!;
await iam.send(new Iam.PutRolePolicyCommand({ RoleName: role.RoleName, PolicyName: 'logs', PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'logs:StartQuery', Resource: '*' }] }) }));
await sim.logs.CreateLogGroup({ logGroupName: '/crash/direct' }); await sim.logs.CreateLogStream({ logGroupName: '/crash/direct', logStreamName: 'events' }); await sim.logs.PutLogEvents({ logGroupName: '/crash/direct', logStreamName: 'events', logEvents: [{ timestamp: clock.now(), message: '{"value":42}' }] });
await sim.opensearch.directQueries.execute('AddDirectQueryDataSource', { DataSourceName: 'crash_logs', DataSourceType: { CloudWatchLog: { RoleArn: role.Arn } }, OpenSearchArns: [collection.arn] }, region);
const source = sim.opensearch.directQueries.source(region, 'crash_logs'), save = sim.store.save.bind(sim.store); let armed = boundary === 'query-commit';
const park = async () => { const job = Object.values(sim.store.regionState(region).logQueryJobs)[0]; process.send?.({ boundary, queryId: job.queryId, generation: source.generation, collectionId: collection.id, now: clock.now() }); setInterval(() => {}, 1000); await new Promise(() => {}); };
sim.store.save = async () => {
  const current = sim.opensearch.directQueries.state(region).records.crash_logs, job = Object.values(sim.store.regionState(region).logQueryJobs)[0];
  if (armed && boundary === 'delete-cleanup' && !current) await park();
  await save();
  if (armed && (boundary === 'query-commit' && job?.sourceOwner || boundary === 'delete-intent' && current?.deleting)) await park();
};
await sim.opensearch.directQueries.local(region, sim.store.accountId, 'crash_logs', 'start', { queryLanguage: 'SQL', queryString: 'SELECT value FROM `/crash/direct`', startTime: Math.floor(clock.now() / 1000), endTime: Math.floor(clock.now() / 1000) }, { principalType: 'anonymous', principalArn: '*', principalId: 'anonymous', accessKeyId: '', accountId: sim.store.accountId }, true);
armed = true; await sim.opensearch.directQueries.execute('DeleteDirectQueryDataSource', { DataSourceName: 'crash_logs' }, region);
