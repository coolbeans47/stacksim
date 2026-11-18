import { setTimeout as delay } from 'node:timers/promises';
import * as Iam from '@aws-sdk/client-iam';
import * as Ddb from '@aws-sdk/client-dynamodb';
import * as S3 from '@aws-sdk/client-s3';
import * as Osis from '@aws-sdk/client-osis';
import { StackSim } from '../../src/server.js';

const [root, boundary] = process.argv.slice(2), region = 'eu-west-1', sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'enforce' });
await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: 'admin', secretAccessKey: 'password' }, maxAttempts: 1 }, iam = new Iam.IAMClient(sdk), ddb = new Ddb.DynamoDBClient(sdk), osis = new Osis.OSISClient(sdk), s3 = new S3.S3Client({ ...sdk, forcePathStyle: true });
await sim.opensearch.execute('CreateDomain', { DomainName: 'ddb-recovery', EncryptionAtRestOptions: { Enabled: true } }, region); const domain = sim.opensearch.domain(region, 'ddb-recovery'); while (domain.state !== 'active') await delay(10);
const role = (await iam.send(new Iam.CreateRoleCommand({ RoleName: 'SourceRecovery', AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'osis-pipelines.amazonaws.com' } }] }) }))).Role!;
const tableArn = 'arn:aws:dynamodb:eu-west-1:000000000000:table/source-recovery';
await iam.send(new Iam.PutRolePolicyCommand({ RoleName: role.RoleName!, PolicyName: 'source', PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['dynamodb:DescribeTable', 'dynamodb:DescribeContinuousBackups', 'dynamodb:ExportTableToPointInTime'], Resource: tableArn }, { Effect: 'Allow', Action: ['dynamodb:DescribeStream', 'dynamodb:GetShardIterator', 'dynamodb:GetRecords'], Resource: `${tableArn}/stream/*` }, { Effect: 'Allow', Action: 'dynamodb:DescribeExport', Resource: `${tableArn}/export/*` }, { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject'], Resource: 'arn:aws:s3:::export-recovery/*' }, { Effect: 'Allow', Action: 'es:DescribeDomain', Resource: domain.arn }, { Effect: 'Allow', Action: ['es:ESHttpPut', 'es:ESHttpDelete'], Resource: `${domain.arn}/records/*` }] }) }));
await ddb.send(new Ddb.CreateTableCommand({ TableName: 'source-recovery', BillingMode: 'PAY_PER_REQUEST', AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' } }));
while ((await ddb.send(new Ddb.DescribeTableCommand({ TableName: 'source-recovery' }))).Table!.TableStatus !== 'ACTIVE') await delay(10);
await ddb.send(new Ddb.PutItemCommand({ TableName: 'source-recovery', Item: { id: { S: 'one' }, title: { S: 'crash source' } } }));
await ddb.send(new Ddb.UpdateContinuousBackupsCommand({ TableName: 'source-recovery', PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } }));
await s3.send(new S3.CreateBucketCommand({ Bucket: 'export-recovery', CreateBucketConfiguration: { LocationConstraint: region } }));
await s3.send(new S3.PutBucketPolicyCommand({ Bucket: 'export-recovery', Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'dynamodb.amazonaws.com' }, Action: 's3:PutObject', Resource: 'arn:aws:s3:::export-recovery/*', Condition: { ArnEquals: { 'aws:SourceArn': tableArn } } }] }) }));
const ports = (sim.opensearch.ingestion as any).ports, deliver = ports.deliver.bind(ports), start = ports.dynamoSource.startExport.bind(ports.dynamoSource);
ports.dynamoSource.startExport = async (...args: any[]) => {
  const arn = await start(...args);
  if (boundary === 'after-export-intent') { process.send?.({ boundary, arn }); await new Promise(() => {}); }
  return arn;
};
ports.deliver = async (...args: any[]) => {
  if (boundary === 'after-export-intent') return deliver(...args);
  if (boundary === 'after-sink') await deliver(...args);
  process.send?.({ boundary }); await new Promise(() => {});
};
await osis.send(new Osis.CreatePipelineCommand({ PipelineName: 'source-recovery', MinUnits: 1, MaxUnits: 1, PipelineConfigurationBody: JSON.stringify({ version: '2', source: { source: { dynamodb: { aws: { region, sts_role_arn: role.Arn }, acknowledgments: true, tables: [{ table_arn: tableArn, stream: { start_position: 'LATEST' }, export: { s3_bucket: 'export-recovery', s3_prefix: 'initial/' } }] } }, sink: [{ opensearch: { hosts: [`https://127.0.0.1:${domain.gatewayPort}`], aws: { region, sts_role_arn: role.Arn }, index: 'records', document_id: '${getMetadata("primary_key")}', action: '${getMetadata("opensearch_action")}', document_version: '${getMetadata("document_version")}', document_version_type: 'external' } }] } }) }));
setInterval(() => {}, 1000);
