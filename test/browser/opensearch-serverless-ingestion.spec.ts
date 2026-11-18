import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as Aoss from '@aws-sdk/client-opensearchserverless';
import * as S3 from '@aws-sdk/client-s3';
import { StackSim } from '../../src/server.js';

for (const width of [1440, 390]) test(`Serverless S3 job creation, failures and cancellation at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), 'stacksim-aoss-job-ui-')), region = 'eu-west-1', sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: 'enforce', cdkBootstrap: false }), clients: Array<{ destroy(): void }> = [], errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: 'admin', secretAccessKey: 'password' }, maxAttempts: 1 }, aoss = new Aoss.OpenSearchServerlessClient(sdk), s3 = new S3.S3Client({ ...sdk, forcePathStyle: true }); clients.push(aoss, s3);
    await aoss.send(new Aoss.CreateCollectionGroupCommand({ name: 'browser-group', generation: 'NEXTGEN', standbyReplicas: 'DISABLED' }));
    await aoss.send(new Aoss.CreateSecurityPolicyCommand({ name: 'browser-network', type: 'network', policy: JSON.stringify([{ Rules: [{ ResourceType: 'collection', Resource: ['collection/browser-jobs'] }], AllowFromPublic: true }]) }));
    const principal = Object.values(sim.store.ensureAccount().iam.users)[0].arn;
    await aoss.send(new Aoss.CreateAccessPolicyCommand({ name: 'browser-data', type: 'data', policy: JSON.stringify([{ Rules: [{ ResourceType: 'index', Resource: ['index/browser-jobs/*'], Permission: ['aoss:*'] }], Principal: [principal] }]) }));
    const id = (await aoss.send(new Aoss.CreateCollectionCommand({ name: 'browser-jobs', type: 'SEARCH', collectionGroupName: 'browser-group', encryptionConfig: { aWSOwnedKey: true } }))).createCollectionDetail!.id!; while (sim.opensearch.serverless.collection(region, id).status !== 'ACTIVE') await delay(10);
    await s3.send(new S3.CreateBucketCommand({ Bucket: 'browser-job-source', CreateBucketConfiguration: { LocationConstraint: region } })); await s3.send(new S3.PutObjectCommand({ Bucket: 'browser-job-source', Key: 'small/a.json', Body: '{"title":"Browser job document"}' })); await s3.send(new S3.PutObjectCommand({ Bucket: 'browser-job-source', Key: 'small/b.pdf', Body: 'unsupported' })); await s3.send(new S3.PutObjectCommand({ Bucket: 'browser-job-source', Key: 'large/data.json', Body: JSON.stringify(Array.from({ length: 500 }, (_, n) => ({ n }))) }));
    const base = `http://127.0.0.1:${sim.port}/_stacksim/console`; await page.setViewportSize({ width, height: 900 }); await page.goto(`${base}#/opensearch/serverless/collections/${id}`); await page.locator('[name="accessKeyId"]').fill('admin'); await page.locator('[name="secretAccessKey"]').fill('password'); await page.locator('#console-sign-in').getByRole('button', { name: 'Sign in', exact: true }).click(); const onboarding = page.getByRole('dialog', { name: 'Secure the default IAM access key' }); await onboarding.getByRole('radio', { name: /Keep default credentials/ }).check(); await onboarding.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(onboarding).not.toBeVisible(); await page.getByRole('link', { name: 'Ingestion jobs', exact: true }).click();
    const create = async (name: string, prefix: string) => { await page.getByRole('link', { name: 'Create ingestion job', exact: true }).click(); await page.getByLabel('Job name', { exact: true }).fill(name); await page.getByLabel('S3 bucket name or ARN', { exact: true }).fill('browser-job-source'); await page.getByLabel('S3 key prefix', { exact: true }).fill(prefix); await page.getByLabel('Target index', { exact: true }).fill(name); await page.getByRole('button', { name: 'Create job', exact: true }).click(); await expect(page.getByRole('heading', { name, exact: true })).toBeVisible(); };
    await create('browser-import', 'small/'); await expect.poll(async () => { await page.getByRole('button', { name: 'Refresh', exact: true }).click(); return page.locator('#aoss-job-status').textContent(); }).toContain('COMPLETED'); await expect(page.getByText('2 objects discovered · 1 ingested · 1 failed', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Cancel job', exact: true })).toBeDisabled(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`serverless-job-${width}.png`) });
    await page.getByRole('link', { name: 'All jobs', exact: true }).click(); await create('cancel-import', 'large/'); await page.getByRole('button', { name: 'Cancel job', exact: true }).click(); await expect.poll(async () => { await page.getByRole('button', { name: 'Refresh', exact: true }).click(); return page.locator('#aoss-job-status').textContent(); }).toContain('CANCELLED');
    expect(errors).toEqual([]);
  } finally { await page.context().close(); clients.forEach(client => client.destroy()); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
