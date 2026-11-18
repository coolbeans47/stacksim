import { setTimeout as delay } from 'node:timers/promises';
import * as Iam from '@aws-sdk/client-iam';
import * as S3 from '@aws-sdk/client-s3';
import * as Osis from '@aws-sdk/client-osis';
import { StackSim } from '../../src/server.js';

const [root, boundary] = process.argv.slice(2), region = 'eu-west-1', sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'enforce' });
await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: 'admin', secretAccessKey: 'password' }, maxAttempts: 1 }, iam = new Iam.IAMClient(sdk), s3 = new S3.S3Client({ ...sdk, forcePathStyle: true }), osis = new Osis.OSISClient(sdk);
await sim.opensearch.execute('CreateDomain', { DomainName: 's3-recovery', EncryptionAtRestOptions: { Enabled: true } }, region); const domain = sim.opensearch.domain(region, 's3-recovery'); while (domain.state !== 'active') await delay(10);
const role = (await iam.send(new Iam.CreateRoleCommand({ RoleName: 'SourceRecovery', AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'osis-pipelines.amazonaws.com' } }] }) }))).Role!;
await iam.send(new Iam.PutRolePolicyCommand({ RoleName: role.RoleName!, PolicyName: 'source', PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:ListBucket', Resource: 'arn:aws:s3:::source-recovery' }, { Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::source-recovery/*' }, { Effect: 'Allow', Action: 'es:DescribeDomain', Resource: domain.arn }, { Effect: 'Allow', Action: 'es:ESHttpPut', Resource: `${domain.arn}/records/*` }] }) }));
await s3.send(new S3.CreateBucketCommand({ Bucket: 'source-recovery', CreateBucketConfiguration: { LocationConstraint: region } })); await s3.send(new S3.PutObjectCommand({ Bucket: 'source-recovery', Key: 'events.ndjson', Body: '{"id":"one","title":"crash source"}\n{"id":"two","title":"crash source"}\n' }));
const ports = (sim.opensearch.ingestion as any).ports, deliver = ports.deliver.bind(ports);
ports.deliver = async (...args: any[]) => {
  if (boundary === 'after-sink') await deliver(...args);
  process.send?.({ boundary, id: args[4] }); await new Promise(() => {});
};
await osis.send(new Osis.CreatePipelineCommand({ PipelineName: 'source-recovery', MinUnits: 1, MaxUnits: 1, PipelineConfigurationBody: JSON.stringify({ version: '2', source: { source: { s3: { aws: { region, sts_role_arn: role.Arn }, acknowledgments: true, codec: { ndjson: {} }, scan: { buckets: [{ bucket: { name: 'source-recovery' } }] } } }, sink: [{ opensearch: { hosts: [`https://127.0.0.1:${domain.gatewayPort}`], aws: { region, sts_role_arn: role.Arn }, index: 'records', document_id: '${/id}' } }] } }) }));
setInterval(() => {}, 1000);
