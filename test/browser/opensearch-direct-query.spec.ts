import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as Os from '@aws-sdk/client-opensearch';
import * as Aoss from '@aws-sdk/client-opensearchserverless';
import * as Iam from '@aws-sdk/client-iam';
import * as Logs from '@aws-sdk/client-cloudwatch-logs';
import { StackSim } from '../../src/server.js';

for (const width of [1440, 390]) test(`CloudWatch direct-query connection lifecycle and SQL/PPL at ${width}px`, async ({ page }) => {
  test.setTimeout(60000); const root = await mkdtemp(join(tmpdir(), 'stacksim-dq-ui-')), region = 'eu-west-1', sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'enforce' });
  const clients: any[] = [], errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await sim.start(); const config = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: 'admin', secretAccessKey: 'password' }, maxAttempts: 1 }, os = new Os.OpenSearchClient(config), aoss = new Aoss.OpenSearchServerlessClient(config), iam = new Iam.IAMClient(config), logs = new Logs.CloudWatchLogsClient(config); clients.push(os, aoss, iam, logs);
    await aoss.send(new Aoss.CreateSecurityPolicyCommand({ name: 'direct-encryption', type: 'encryption', policy: JSON.stringify({ Rules: [{ ResourceType: 'collection', Resource: ['collection/direct-results'] }], AWSOwnedKey: true }) }));
    const collection = (await aoss.send(new Aoss.CreateCollectionCommand({ name: 'direct-results', type: 'SEARCH' }))).createCollectionDetail!; for (let i = 0; i < 300 && sim.opensearch.serverless.state(region).collections[collection.id!].status !== 'ACTIVE'; i++) await delay(10);
    const role = (await iam.send(new Iam.CreateRoleCommand({ RoleName: 'BrowserDirectLogs', AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'directquery.opensearchservice.amazonaws.com' }, Action: 'sts:AssumeRole' }] }) }))).Role!;
    await iam.send(new Iam.PutRolePolicyCommand({ RoleName: role.RoleName, PolicyName: 'logs', PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'logs:StartQuery', Resource: 'arn:aws:logs:eu-west-1:000000000000:log-group:/browser/direct:*' }] }) }));
    await logs.send(new Logs.CreateLogGroupCommand({ logGroupName: '/browser/direct' })); await logs.send(new Logs.CreateLogStreamCommand({ logGroupName: '/browser/direct', logStreamName: 'events' })); await logs.send(new Logs.PutLogEventsCommand({ logGroupName: '/browser/direct', logStreamName: 'events', logEvents: [{ timestamp: Date.now(), message: '{"duration":19}' }, { timestamp: Date.now(), message: '{"duration":5}' }] }));
    await page.setViewportSize({ width, height: 900 }); await page.goto(`http://127.0.0.1:${sim.port}/_stacksim/console#/opensearch/direct-query`); await page.locator('[name="accessKeyId"]').fill('admin'); await page.locator('[name="secretAccessKey"]').fill('password'); await page.locator('#console-sign-in').getByRole('button', { name: 'Sign in', exact: true }).click();
    const onboarding = page.getByRole('dialog', { name: 'Secure the default IAM access key' }); await onboarding.getByRole('radio', { name: /Keep default credentials/ }).check(); await onboarding.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(onboarding).not.toBeVisible();
    await page.getByRole('link', { name: 'Connect data source', exact: true }).click(); await page.getByLabel('Data source name', { exact: true }).fill('browser_logs'); await page.getByLabel('Source role ARN', { exact: true }).fill(role.Arn!); await page.getByLabel('Source role ARN', { exact: true }).press('Escape'); await page.getByRole('checkbox', { name: 'direct-results', exact: true }).check(); await page.getByRole('button', { name: 'Connect data source', exact: true }).click(); await expect(page.getByRole('heading', { name: 'browser_logs', exact: true })).toBeVisible();
    const editor = page.getByLabel('Query', { exact: true }), run = page.getByRole('button', { name: 'Run direct query', exact: true });
    await editor.fill('SELECT SUM(duration) AS total FROM `/browser/direct`'); await run.click(); await expect(page.locator('#os-dq-status')).toContainText('Complete'); await expect(page.getByRole('table', { name: 'Direct query results' })).toContainText('24');
    await page.getByLabel('Query language', { exact: true }).selectOption('PPL'); await editor.fill('source = `/browser/direct` | where duration > 10 | fields duration'); await run.click(); await expect(page.locator('#os-dq-status')).toContainText('Complete'); await expect(page.getByRole('table', { name: 'Direct query results' })).toContainText('19');
    await editor.fill('source = `/private/logs` | head 1'); await run.click(); await expect(page.locator('[role="alert"]')).toContainText('log group does not exist');
    await page.getByLabel('Description', { exact: true }).fill('Updated from the browser'); await page.getByRole('button', { name: 'Save connection', exact: true }).click(); await expect(page.locator('#toast-region')).toContainText('Connection updated'); await expect(page.getByLabel('Description', { exact: true })).toHaveValue('Updated from the browser');
    await page.getByLabel('Tags (JSON key/value object)', { exact: true }).fill('{"team":"search"}'); await page.getByRole('button', { name: 'Save tags', exact: true }).click(); await expect(page.getByLabel('Tags (JSON key/value object)', { exact: true })).toHaveValue(/search/); await expect(page.locator('#toast-region')).toContainText('Tags updated');
    expect((await os.send(new Os.GetDirectQueryDataSourceCommand({ DataSourceName: 'browser_logs' }))).Description).toBe('Updated from the browser');
    await page.getByRole('heading', { name: 'browser_logs', exact: true }).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`direct-query-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Delete data source', exact: true }).click(); const dialog = page.getByRole('dialog'); await dialog.getByRole('textbox').fill('browser_logs'); await dialog.getByRole('button', { name: /Delete|Confirm/ }).last().click(); await expect(page.getByRole('heading', { name: 'No connected data sources' })).toBeVisible();
    expect(sim.store.regionState(region).logs['/browser/direct']).toBeTruthy(); expect(errors).toEqual([]);
  } finally { clients.forEach(client => client.destroy()); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
