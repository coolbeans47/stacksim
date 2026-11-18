import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import * as Lambda from '@aws-sdk/client-lambda';
import * as Iam from '@aws-sdk/client-iam';
import * as Logs from '@aws-sdk/client-cloudwatch-logs';
import { StackSim } from '../../src/server.js';
import { createZip } from '../../src/core/zip-create.js';

for (const width of [1440, 390]) test(`Logs subscription feeds the actual OpenSearch console at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), 'stacksim-search-producer-ui-')), region = 'eu-west-1', sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: 'enforce', cdkBootstrap: false }), clients: Array<{ destroy(): void }> = [], errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: 'admin', secretAccessKey: 'password' }, maxAttempts: 1 }, lambda = new Lambda.LambdaClient(sdk), iam = new Iam.IAMClient(sdk), logs = new Logs.CloudWatchLogsClient(sdk); clients.push(lambda, iam, logs);
    await sim.opensearch.execute('CreateDomain', { DomainName: 'browser-producers' }, region); for (let i = 0; i < 200 && sim.opensearch.domain(region, 'browser-producers').state !== 'active'; i++) await delay(10); const domain = sim.opensearch.domain(region, 'browser-producers');
    const role = (await iam.send(new Iam.CreateRoleCommand({ RoleName: 'BrowserLogsToSearch', AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' } }] }) }))).Role!;
    await iam.send(new Iam.PutRolePolicyCommand({ RoleName: role.RoleName!, PolicyName: 'search', PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'es:DescribeDomain', Resource: domain.arn }, { Effect: 'Allow', Action: 'es:ESHttpPut', Resource: `${domain.arn}/logs-*/*` }] }) }));
    const bundle = await build({ entryPoints: [fileURLToPath(new URL('../../examples/opensearch-producers/handler.cjs', import.meta.url))], bundle: true, platform: 'node', target: 'node22', format: 'cjs', write: false });
    const fn = (await lambda.send(new Lambda.CreateFunctionCommand({ FunctionName: 'browser-logs-to-search', Runtime: 'nodejs22.x', Role: role.Arn!, Handler: 'index.logs', Timeout: 15, Code: { ZipFile: createZip([{ name: 'index.js', content: Buffer.from(bundle.outputFiles[0].contents) }]) }, Environment: { Variables: { SEARCH_DOMAIN: domain.name, SEARCH_CA_PEM: await readFile(sim.opensearch.diagnostics(region).caCertificatePath!, 'utf8') } } }))).FunctionArn!;
    const group = '/browser/search'; await logs.send(new Logs.CreateLogGroupCommand({ logGroupName: group })); await logs.send(new Logs.CreateLogStreamCommand({ logGroupName: group, logStreamName: 'first' }));
    const base = `http://127.0.0.1:${sim.port}/_stacksim/console`; await page.setViewportSize({ width, height: 900 }); await page.goto(`${base}#/cloudwatch/log-groups/${encodeURIComponent(group)}/subscription-filters`);
    await page.locator('[name="accessKeyId"]').fill('admin'); await page.locator('[name="secretAccessKey"]').fill('password'); await page.locator('#console-sign-in').getByRole('button', { name: 'Sign in', exact: true }).click(); const onboarding = page.getByRole('dialog', { name: 'Secure the default IAM access key' }); await onboarding.getByRole('radio', { name: /Keep default credentials/ }).check(); await onboarding.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(onboarding).not.toBeVisible();
    await page.getByRole('button', { name: 'Create subscription filter', exact: true }).first().click(); const dialog = page.getByRole('dialog'); await dialog.getByLabel('Filter name', { exact: true }).fill('search'); await dialog.getByLabel('Lambda function', { exact: true }).fill(fn); await dialog.getByRole('button', { name: 'Start streaming', exact: true }).click(); await expect(page.locator('#toast-region')).toContainText(/permission|authorized|allow/i); await expect(dialog).toBeVisible();
    await lambda.send(new Lambda.AddPermissionCommand({ FunctionName: fn, StatementId: 'logs', Action: 'lambda:InvokeFunction', Principal: `logs.${region}.amazonaws.com`, SourceAccount: sim.store.accountId, SourceArn: `arn:aws:logs:${region}:${sim.store.accountId}:log-group:${group}:*` }));
    await dialog.getByRole('button', { name: 'Start streaming', exact: true }).click(); await expect(dialog).not.toBeVisible(); await expect(page.getByRole('link', { name: 'browser-logs-to-search', exact: true })).toBeVisible(); await page.screenshot({ path: test.info().outputPath(`subscription-${width}.png`) });
    await logs.send(new Logs.PutLogEventsCommand({ logGroupName: group, logStreamName: 'first', logEvents: [{ timestamp: Date.now(), message: 'Browser log arrived in search' }] }));
    await expect.poll(async () => { try { const engine = (sim.opensearch as any).engine(domain); await engine.request('POST', '/logs-*/_refresh', Buffer.alloc(0), 'test'); return (await engine.request('POST', '/logs-*/_count', Buffer.from('{}'), 'test')).body.count; } catch { return 0; } }).toBe(1);
    await page.goto(`${base}#/opensearch/domains/${domain.name}/local-query`); await page.getByLabel('HTTP method').selectOption('POST'); await page.getByLabel('Request path').fill('/logs-*/_search'); await page.getByLabel('Request body (JSON or NDJSON)').fill('{"query":{"match":{"message":"Browser"}}}'); await page.getByRole('button', { name: 'Run request', exact: true }).click(); await expect(page.locator('#os-query-response')).toContainText('Browser log arrived in search'); await expect(page.locator('#os-query-response')).toContainText('/browser/search');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.locator('#os-query-response').scrollIntoViewIfNeeded(); await page.screenshot({ path: test.info().outputPath(`logs-search-${width}.png`) }); expect(errors).toEqual([]);
  } finally { await page.context().close(); clients.forEach(client => client.destroy()); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
