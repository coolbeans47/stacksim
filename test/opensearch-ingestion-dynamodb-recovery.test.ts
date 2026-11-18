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

for (const boundary of ['before-sink', 'after-sink']) test(`DynamoDB source resumes its encrypted checkpoint after forced termination ${boundary}`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-ddb-source-crash-')), extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js', child = fork(new URL(`./fixtures/opensearch-ingestion-dynamodb-crash.${extension}`, import.meta.url), [root, boundary], { execArgv: extension === 'ts' ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', data => { errors += data; }); const exited = once(child, 'exit'); let sim: StackSim | undefined, client: Client | undefined;
  try {
    const [signal] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`Source child exited: ${errors}`); }), delay(15000, undefined, { ref: false }).then(() => { throw new Error(`Timed out: ${errors}`); })]); assert.equal(signal.boundary, boundary); child.kill('SIGKILL'); await exited;
    const region = 'eu-west-1'; sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'enforce' }); await sim.start(); const domain = sim.opensearch.domain(region, 'ddb-recovery'), pipeline = sim.opensearch.ingestion.pipeline(region, 'source-recovery'), buffer = (sim.opensearch.ingestion as any).buffers.get(pipeline.generation);
    for (let i = 0; i < 400 && buffer.stream()?.delivered !== 3; i++) await delay(10); assert.equal(buffer.stream().delivered, 3); assert.equal(buffer.stream().accepted, 3); assert.equal(buffer.stream().cursor.nextSequence, '4'); assert.equal(buffer.stats().buffered, 0);
    client = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath!) }, ...AwsSigv4Signer({ region, service: 'es', getCredentials: async () => ({ accessKeyId: 'admin', secretAccessKey: 'password' }) }) }); await client.indices.refresh({ index: 'records' }); assert.equal((await client.count({ index: 'records' })).body.count, 1); await assert.rejects(client.get({ index: 'records', id: signal.id })); assert.equal((await client.get({ index: 'records', id: 'two' })).body._version, 3);
    await assert.rejects(client.index({ index: 'records', id: signal.id, version: 1, version_type: 'external', body: { title: 'stale resurrection' } }), (error: any) => error.statusCode === 409);

  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } await client?.close(); await sim?.stop(); await rm(root, { recursive: true, force: true }); }
});
