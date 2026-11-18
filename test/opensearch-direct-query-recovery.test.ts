import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { StackSim } from '../src/server.js';
import { TestClock } from '../src/core/clock.js';

for (const boundary of ['query-commit', 'delete-intent', 'delete-cleanup']) test(`Direct query recovers after forced termination at ${boundary}`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'stacksim-direct-crash-')), extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js', child = fork(new URL(`./fixtures/opensearch-direct-query-crash.${extension}`, import.meta.url), [root, boundary], { execArgv: extension === 'ts' ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = '', sim: StackSim | undefined; child.stderr?.on('data', data => { errors += data; }); const exited = once(child, 'exit');
  try {
    const [signal] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(errors); }), delay(15000, undefined, { ref: false }).then(() => { throw new Error(`Timed out: ${errors}`); })]); assert.equal(signal.boundary, boundary); child.kill('SIGKILL'); await exited;
    const region = 'eu-west-1', clock = new TestClock(signal.now); sim = new StackSim({ dataDir: root, region, clock, port: 0, invokePort: 0, cdkBootstrap: false, authMode: 'off' }); await sim.start();
    assert.ok(sim.store.regionState(region).logs['/crash/direct']); assert.equal(sim.opensearch.serverless.state(region).collections[signal.collectionId].status, 'ACTIVE');
    const job = sim.store.regionState(region).logQueryJobs[signal.queryId]; assert.equal(job.sourceOwner?.generation, signal.generation);
    if (boundary === 'query-commit') {
      assert.equal(sim.opensearch.directQueries.source(region, 'crash_logs').generation, signal.generation);
      for (let i = 0; i < 500 && ['Scheduled', 'Running'].includes(job.status); i++) { clock.advance(25); await delay(2); }
      assert.equal(job.status, 'Complete'); assert.deepEqual(job.results, [[{ field: 'value', value: '42' }]]); assert.equal(Object.keys(sim.store.regionState(region).logQueryJobs).length, 1);
    } else { assert.equal(Object.keys(sim.opensearch.directQueries.state(region).records).length, 0); assert.equal(job.status, 'Cancelled'); }
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } await sim?.stop(); await rm(root, { recursive: true, force: true }); }
});
