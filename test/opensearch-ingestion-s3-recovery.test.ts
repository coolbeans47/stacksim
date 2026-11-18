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

for (const boundary of ['before-sink', 'after-sink']) test(`S3 source resumes its encrypted checkpoint after forced termination ${boundary}`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-s3-source-crash-')), extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js', child = fork(new URL(`./fixtures/opensearch-ingestion-s3-crash.${extension}`, import.meta.url), [root, boundary], { execArgv: extension === 'ts' ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr?.on('data', data => { errors += data; }); const exited = once(child, 'exit'); let sim: StackSim | undefined, client: Client | undefined;
  try {
    const [signal] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(`Source child exited: ${errors}`); }), delay(15000, undefined, { ref: false }).then(() => { throw new Error(`Timed out: ${errors}`); })]); assert.equal(signal.boundary, boundary); child.kill('SIGKILL'); await exited;
    const region = 'eu-west-1'; sim = new StackSim({ dataDir: root, region, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'enforce' }); await sim.start(); const domain = sim.opensearch.domain(region, 's3-recovery'), pipeline = sim.opensearch.ingestion.pipeline(region, 'source-recovery'), buffer = (sim.opensearch.ingestion as any).buffers.get(pipeline.generation);
    for (let i = 0; i < 400 && buffer.scan()?.status !== 'COMPLETED'; i++) await delay(10); assert.equal(buffer.scan().status, 'COMPLETED'); assert.equal(buffer.scan().accepted, 2); assert.equal(buffer.scan().cursor, 1); assert.equal(buffer.stats().buffered, 0);
    client = new Client({ node: `https://127.0.0.1:${domain.gatewayPort}`, ssl: { ca: await readFile(sim.opensearch.diagnostics(region).caCertificatePath!) }, ...AwsSigv4Signer({ region, service: 'es', getCredentials: async () => ({ accessKeyId: 'admin', secretAccessKey: 'password' }) }) }); await client.indices.refresh({ index: 'records' }); assert.equal((await client.count({ index: 'records' })).body.count, 2); const document = (await client.get({ index: 'records', id: signal.id })).body; assert.equal(document._source.title, 'crash source'); assert.equal(document._version, boundary === 'after-sink' ? 2 : 1, 'Commit/checkpoint gap is explicitly at least once');
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } await client?.close(); await sim?.stop(); await rm(root, { recursive: true, force: true }); }
});
