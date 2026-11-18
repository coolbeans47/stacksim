import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as Iam from '@aws-sdk/client-iam';
import * as Ddb from '@aws-sdk/client-dynamodb';
import { StackSim } from '../../src/server.js';

for (const width of [1440, 390]) test(`DynamoDB stream blueprint, live changes and checkpoint resume at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), 'stacksim-ddb-source-ui-')), region = 'eu-west-1', sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: 'enforce', cdkBootstrap: false }), clients: Array<{ destroy(): void }> = [], errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: 'admin', secretAccessKey: 'password' }, maxAttempts: 1 }, iam = new Iam.IAMClient(sdk), ddb = new Ddb.DynamoDBClient(sdk); clients.push(iam, ddb);
    await sim.opensearch.execute('CreateDomain', { DomainName: 'browser-source-sink' }, region); for (let i = 0; i < 200 && sim.opensearch.domain(region, 'browser-source-sink').state !== 'active'; i++) await delay(10); const domain = sim.opensearch.domain(region, 'browser-source-sink');
    const role = (await iam.send(new Iam.CreateRoleCommand({ RoleName: 'BrowserScan', AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'osis-pipelines.amazonaws.com' } }] }) }))).Role!;
    const tableArn = 'arn:aws:dynamodb:eu-west-1:000000000000:table/browser-products';
    await ddb.send(new Ddb.CreateTableCommand({ TableName: 'browser-products', BillingMode: 'PAY_PER_REQUEST', KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }], StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' } }));
    while ((await ddb.send(new Ddb.DescribeTableCommand({ TableName: 'browser-products' }))).Table!.TableStatus !== 'ACTIVE') await delay(10);
    const base = `http://127.0.0.1:${sim.port}/_stacksim/console`; await page.setViewportSize({ width, height: 900 }); await page.goto(`${base}#/opensearch/ingestion/pipelines/create`); await page.locator('[name="accessKeyId"]').fill('admin'); await page.locator('[name="secretAccessKey"]').fill('password'); await page.locator('#console-sign-in').getByRole('button', { name: 'Sign in', exact: true }).click(); const onboarding = page.getByRole('dialog', { name: 'Secure the default IAM access key' }); await onboarding.getByRole('radio', { name: /Keep default credentials/ }).check(); await onboarding.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(onboarding).not.toBeVisible();
    await page.getByRole('button', { name: 'Use DynamoDB stream blueprint', exact: true }).click(); await expect(page.getByLabel('Pipeline YAML or JSON', { exact: true })).toHaveValue(/acknowledgments: true/);
    await page.getByLabel('Pipeline name', { exact: true }).fill('browser-stream');
    const config = JSON.stringify({ version: '2', stream: { source: { dynamodb: { aws: { region, sts_role_arn: role.Arn }, acknowledgments: true, tables: [{ table_arn: tableArn, stream: { start_position: 'LATEST' } }] } }, sink: [{ opensearch: { hosts: [`https://127.0.0.1:${domain.gatewayPort}`], aws: { region, sts_role_arn: role.Arn }, index: 'imported', document_id: '${getMetadata("primary_key")}', action: '${getMetadata("opensearch_action")}', document_version: '${getMetadata("document_version")}', document_version_type: 'external' } }] } });
    await page.getByLabel('Pipeline YAML or JSON', { exact: true }).fill(config); await page.getByRole('button', { name: 'Validate configuration', exact: true }).click(); await expect(page.locator('#osis-validation')).toContainText('Configuration is valid'); await page.getByRole('button', { name: 'Create pipeline', exact: true }).click(); await expect(page.getByRole('heading', { name: 'browser-stream', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Stop pipeline', exact: true })).toBeEnabled(); await expect(page.locator('#osis-send')).toHaveCount(0);
    await expect.poll(async () => { await page.getByRole('button', { name: 'Refresh', exact: true }).click(); return await page.locator('#osis-source-status').textContent(); }).toContain('RETRYING'); await expect(page.locator('#osis-source-status')).toContainText('access was denied');
    await iam.send(new Iam.PutRolePolicyCommand({ RoleName: role.RoleName!, PolicyName: 'scan', PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'dynamodb:DescribeTable', Resource: tableArn }, { Effect: 'Allow', Action: ['dynamodb:DescribeStream', 'dynamodb:GetShardIterator', 'dynamodb:GetRecords'], Resource: `${tableArn}/stream/*` }, { Effect: 'Allow', Action: 'es:DescribeDomain', Resource: domain.arn }, { Effect: 'Allow', Action: ['es:ESHttpPut', 'es:ESHttpDelete'], Resource: `${domain.arn}/imported/*` }] }) }));
    await expect.poll(async () => { await page.getByRole('button', { name: 'Refresh', exact: true }).click(); return await page.locator('#osis-source-status').textContent(); }).toContain('READING');
    await ddb.send(new Ddb.PutItemCommand({ TableName: 'browser-products', Item: { id: { S: 'one' }, title: { S: 'Browser stream document' } } }));
    await expect.poll(async () => { await page.getByRole('button', { name: 'Refresh', exact: true }).click(); return await page.locator('#osis-source-status').textContent(); }).toContain('"delivered": 1');
    await page.getByRole('heading', { name: 'DynamoDB stream source', exact: true }).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`dynamodb-stream-${width}.png`) });
    await page.getByRole('button', { name: 'Stop pipeline', exact: true }).click(); await expect(page.getByRole('button', { name: 'Start pipeline', exact: true })).toBeEnabled();
    await ddb.send(new Ddb.DeleteItemCommand({ TableName: 'browser-products', Key: { id: { S: 'one' } } }));
    await page.getByRole('button', { name: 'Start pipeline', exact: true }).click(); await expect(page.getByRole('button', { name: 'Stop pipeline', exact: true })).toBeEnabled();
    await expect.poll(async () => { await page.getByRole('button', { name: 'Refresh', exact: true }).click(); return await page.locator('#osis-source-status').textContent(); }).toContain('"delivered": 2');
    const engine = (sim.opensearch as any).engine(domain); await engine.request('POST', '/imported/_refresh', Buffer.alloc(0), 'test'); expect((await engine.request('GET', '/imported/_count', Buffer.alloc(0), 'test')).body.count).toBe(0); expect(errors).toEqual([]);
  } finally { await page.context().close(); clients.forEach(client => client.destroy()); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
