import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as Aoss from '@aws-sdk/client-opensearchserverless';
import * as Iam from '@aws-sdk/client-iam';
import * as Sqs from '@aws-sdk/client-sqs';
import * as S3 from '@aws-sdk/client-s3';
import { StackSim } from '../../src/server.js';

for (const width of [1440, 390]) test(`Serverless continuous stream creation, alerts, progress and deletion at ${width}px`, async ({ page }) => {
  test.setTimeout(60000);
  const root = await mkdtemp(join(tmpdir(), 'stacksim-aoss-stream-ui-')), region = 'eu-west-1', sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, authMode: 'enforce', cdkBootstrap: false }), clients: Array<{ destroy(): void }> = [], errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await sim.start(); const sdk = { endpoint: `http://127.0.0.1:${sim.port}`, region, credentials: { accessKeyId: 'admin', secretAccessKey: 'password' }, maxAttempts: 1 }, aoss = new Aoss.OpenSearchServerlessClient(sdk), s3 = new S3.S3Client({ ...sdk, forcePathStyle: true }); const iam = new Iam.IAMClient(sdk), sqs = new Sqs.SQSClient(sdk); clients.push(aoss, s3, iam, sqs);
    const trust = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'aoss.amazonaws.com' }, Action: 'sts:AssumeRole' }] };
    const role = (await iam.send(new Iam.CreateRoleCommand({ RoleName: 'BrowserStream', AssumeRolePolicyDocument: JSON.stringify({ ...trust, Statement: [{ ...trust.Statement[0], Principal: { Service: 'osis-pipelines.amazonaws.com' } }] }) }))).Role!.Arn!;
    await iam.send(new Iam.PutRolePolicyCommand({ RoleName: 'BrowserStream', PolicyName: 'stream', PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['aoss:APIAccessAll', 's3:GetObject', 's3:ListBucket', 'sqs:*'], Resource: '*' }] }) }));
    await aoss.send(new Aoss.CreateCollectionGroupCommand({ name: 'browser-group', generation: 'NEXTGEN', standbyReplicas: 'DISABLED' }));
    await aoss.send(new Aoss.CreateSecurityPolicyCommand({ name: 'browser-network', type: 'network', policy: JSON.stringify([{ Rules: [{ ResourceType: 'collection', Resource: ['collection/browser-jobs'] }], AllowFromPublic: true }]) }));
    const principal = Object.values(sim.store.ensureAccount().iam.users)[0].arn;
    await aoss.send(new Aoss.CreateAccessPolicyCommand({ name: 'browser-data', type: 'data', policy: JSON.stringify([{ Rules: [{ ResourceType: 'index', Resource: ['index/browser-jobs/*'], Permission: ['aoss:*'] }], Principal: [principal, role] }]) }));
    const id = (await aoss.send(new Aoss.CreateCollectionCommand({ name: 'browser-jobs', type: 'SEARCH', collectionGroupName: 'browser-group', encryptionConfig: { aWSOwnedKey: true } }))).createCollectionDetail!.id!; while (sim.opensearch.serverless.collection(region, id).status !== 'ACTIVE') await delay(10);
    await s3.send(new S3.CreateBucketCommand({ Bucket: 'browser-job-source', CreateBucketConfiguration: { LocationConstraint: region } })); await s3.send(new S3.PutObjectCommand({ Bucket: 'browser-job-source', Key: 'initial.json', Body: '{"title":"Initial stream record"}' }));
    const queueUrl = (await sqs.send(new Sqs.CreateQueueCommand({ QueueName: 'browser-stream' }))).QueueUrl!, queueArn = `arn:aws:sqs:${region}:${sim.store.accountId}:browser-stream`;
    await sqs.send(new Sqs.SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: { Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 's3.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: queueArn, Condition: { ArnEquals: { 'aws:SourceArn': 'arn:aws:s3:::browser-job-source' } } }] }) } }));
    await s3.send(new S3.PutBucketNotificationConfigurationCommand({ Bucket: 'browser-job-source', NotificationConfiguration: { QueueConfigurations: [{ QueueArn: queueArn, Events: ['s3:ObjectCreated:*'] }] } }));
    const base = `http://127.0.0.1:${sim.port}/_stacksim/console`; await page.setViewportSize({ width, height: 900 }); await page.goto(`${base}#/opensearch/serverless/collections/${id}`); await page.locator('[name="accessKeyId"]').fill('admin'); await page.locator('[name="secretAccessKey"]').fill('password'); await page.locator('#console-sign-in').getByRole('button', { name: 'Sign in', exact: true }).click(); const onboarding = page.getByRole('dialog', { name: 'Secure the default IAM access key' }); await onboarding.getByRole('radio', { name: /Keep default credentials/ }).check(); await onboarding.getByRole('button', { name: 'Continue', exact: true }).click(); await expect(onboarding).not.toBeVisible(); await page.getByRole('link', { name: 'Ingestion streams', exact: true }).click();
    await page.getByRole('link', { name: 'Create ingestion stream', exact: true }).click();
    await page.getByLabel('Stream name', { exact: true }).fill('browser-stream');
    await page.getByLabel('SQS queue ARN', { exact: true }).fill(queueArn); await page.getByLabel('Ingestion role ARN', { exact: true }).fill(role);
    await page.getByLabel('Target index', { exact: true }).fill('stream-records'); await page.getByLabel('Source bucket 1', { exact: true }).fill('browser-job-source'); await page.getByLabel('Scan existing objects in bucket 1', { exact: true }).check();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`serverless-stream-create-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Create stream', exact: true }).click(); await expect(page.getByRole('heading', { name: 'browser-stream', exact: true })).toBeVisible();
    await expect.poll(async () => { await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await page.locator('#aoss-stream-status').waitFor({ state: 'visible' }); return (await page.locator('.card-body .alert.warning').allTextContents()).join(' '); }).toContain('SOURCE_ACCESS_DENIED');
    await iam.send(new Iam.UpdateAssumeRolePolicyCommand({ RoleName: 'BrowserStream', PolicyDocument: JSON.stringify(trust) }));
    await expect.poll(async () => { await page.getByRole('button', { name: 'Refresh', exact: true }).click(); return page.locator('#aoss-stream-status').textContent(); }, { timeout: 15000 }).toContain('INGESTION_COMPLETE');
    await expect(page.getByText('1 objects discovered · 1 ingested · 0 failed', { exact: true })).toBeVisible();
    await s3.send(new S3.PutObjectCommand({ Bucket: 'browser-job-source', Key: 'new.json', Body: '{"title":"Continuous stream record"}' }));
    await expect.poll(async () => { await page.getByRole('button', { name: 'Refresh', exact: true }).click(); return page.locator('.card-body').textContent(); }, { timeout: 15000 }).toContain('2 objects discovered · 2 ingested · 0 failed');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: test.info().outputPath(`serverless-stream-${width}.png`) });
    await page.getByRole('button', { name: 'Delete stream', exact: true }).click(); await page.getByRole('dialog').getByRole('textbox').fill('browser-stream'); await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(async () => { await page.getByRole('button', { name: 'Refresh', exact: true }).click(); return page.locator('#aoss-stream-status').textContent(); }).toContain('DELETED');
    await expect(page.getByRole('button', { name: 'Delete stream', exact: true })).toBeDisabled(); await page.getByRole('link', { name: 'All streams', exact: true }).click(); await expect(page.getByText('No ingestion streams', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.context().close(); clients.forEach(client => client.destroy()); await sim.stop(); await rm(root, { recursive: true, force: true }); }
});
