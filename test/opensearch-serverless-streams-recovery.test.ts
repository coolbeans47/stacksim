import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { StackSim } from '../src/server.js';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';
for (const boundary of ['before-sink', 'after-sink', 'after-queue-delete']) test(`Serverless stream recovers encrypted work after forced termination ${boundary}`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-aoss-stream-crash-')), extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js', child = fork(new URL(`./fixtures/opensearch-serverless-streams-crash.${extension}`, import.meta.url), [root, boundary], { execArgv: extension === 'ts' ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', data => { errors += data; }); const exited = once(child, 'exit'); let sim: StackSim | undefined, client: Client | undefined;
  try {
    const [signal] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`Source child exited: ${errors}`); }), delay(15000, undefined, { ref: false }).then(() => { throw new Error(`Timed out: ${errors}`); })]); assert.equal(signal.boundary, boundary); child.kill('SIGKILL'); await exited;
    const region = 'eu-west-1'; sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'enforce' }); await sim.start(); const collection = sim.opensearch.serverless.collection(region, signal.collectionId), job = () => Object.values(sim!.opensearch.serverless.streams.streams(region, sim!.store.accountId))[0];
    assert.equal(collection.status, 'ACTIVE', `Restart failed to activate endpoint ${collection.gatewayPort}: ${collection.failureMessage}`);
    for (let i = 0; i < 400 && job().state !== 'INGESTION_COMPLETE'; i++) await delay(10);
    assert.equal(job().state, 'INGESTION_COMPLETE', JSON.stringify({ status: job().status, state: job().state, statistics: job().statistics, activeAlerts: job().activeAlerts, failureReasons: job().failureReasons }));
    assert.equal(job().status, 'ACTIVE'); assert.deepEqual(job().statistics.s3, { objectsDiscovered: 1, objectsIngested: 1, objectsFailed: 0 });
    client = new Client({ node: `https://127.0.0.1:${collection.gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath!) }, ...AwsSigv4Signer({ region, service: 'aoss', getCredentials: async () => ({ accessKeyId: 'admin', secretAccessKey: 'password' }) }) }); const doc = (await client.get({ index: 'records', id: signal.documentId })).body; assert.equal(doc._source.title, 'first'); assert.equal(doc._version, boundary === 'after-sink' ? 2 : 1); const engine = (sim.opensearch.serverless as any).engine(collection); assert.equal(engine.exportSnapshot({ indices: 'records' }).indexes[0].documents.length, 2);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } await client?.close(); await sim?.stop(); await rm(root, { recursive: true, force: true }); }
});
